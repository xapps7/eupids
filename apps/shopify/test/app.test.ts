// Integration tests against a real Postgres and the in-memory Shopify fake.
// Maps to the PRD acceptance tests noted on each case.
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { FakeShopify, seedDemo } from "../app/lib/fake-shopify.server";
import { onInstalled } from "../app/lib/install.server";
import { onBulkFinish, startScan } from "../app/lib/scan.server";
import { dashboardSummary, reevaluateShop } from "../app/lib/evaluate.server";
import { publishCodes, applyChanges } from "../app/lib/writes.server";
import { syncEuShipping, euVariantIds, euFilter } from "../app/lib/eu-shipping.server";
import { ingest } from "../app/lib/scan.server";
import { productSheet } from "../app/lib/ship.server";
import { enqueue, runJob, claimJobs, requeueStale } from "../app/lib/jobs.server";
import { exportIssuesCsv, previewImport, itemsFromPreview, failuresCsv, readinessReportCsv, customsFileCsv } from "../app/lib/csv.server";
import * as supplier from "../app/lib/supplier.server";
import { firstDelivery, guardProduct, onUninstalled, redactShop } from "../app/lib/webhooks.server";
import { detectCandidates } from "../app/lib/metafields.server";
import { withRetry } from "../app/lib/gql.server";
import { gateFix } from "../app/lib/plans";
import { parseCsv, toCsv } from "@pidready/rules";

const db = new PrismaClient();
let f: FakeShopify;
const DOMAIN = "indigo-loom.myshopify.com";

async function wipe() {
  await db.$executeRawUnsafe(
    `TRUNCATE "EuProfileVariant","AuditLog","Job","SupplierSubmission","SupplierRequestItem","SupplierRequest","Issue","VariantSnapshot","Scan","Settings","Shop","WebhookEvent","Session" CASCADE`,
  );
}

/** Install and complete the first scan (bulk finish arrives immediately in the fake). */
async function install(domain = DOMAIN, fake = f) {
  const shop = await onInstalled(db, domain, fake.gql);
  const scan = await db.scan.findFirstOrThrow({ where: { shopId: shop.id }, orderBy: { startedAt: "desc" } });
  await onBulkFinish(db, fake.gql, shop.id, scan.bulkOpId!);
  return db.shop.findUniqueOrThrow({ where: { id: shop.id } });
}

before(async () => {
  await db.$connect();
});
beforeEach(async () => {
  await wipe();
  f = new FakeShopify();
});
after(async () => {
  await db.$disconnect();
});

test("AT-02: install creates definitions, scans, and counts match an independent evaluation", async () => {
  seedDemo(f, 120);
  const shop = await install();
  assert.equal(f.definitions.length, 2);
  assert.deepEqual(f.definitions.map((d) => `${d.namespace}.${d.key}`).sort(), ["customs.manufacturer_product_id", "customs.no_standard_identifier"]);
  const scan = await db.scan.findFirstOrThrow({ where: { shopId: shop.id } });
  assert.equal(scan.status, "complete");
  assert.equal(scan.variantsTotal, 122);
  assert.equal(scan.variantsInScope, 120); // gift card + draft out of scope
  assert.equal(shop.sellsToEu, true);
});

test("AT-03: dashboard numbers equal the issues table", async () => {
  seedDemo(f, 80);
  const shop = await install();
  const s = await dashboardSummary(db, shop.id);
  const open = await db.issue.findMany({ where: { shopId: shop.id, status: "open" } });
  const errVariants = new Set(open.filter((i) => i.severity === "error").map((i) => i.variantId));
  assert.equal(s.inScope - s.ready, errVariants.size);
  const nspidMissing = new Set(open.filter((i) => i.ruleCode === "R-NSPID-01").map((i) => i.variantId)).size;
  assert.equal(s.nspid.missing, nspidMissing);
  assert.equal(s.mpid.ok + s.mpid.invalid + s.mpid.missing, s.inScope);
});

test("UC-01 A2: a shop with nothing in scope completes with zero", async () => {
  f.add({ productId: "gid://shopify/Product/1", isGiftCard: true });
  const shop = await install();
  const s = await dashboardSummary(db, shop.id);
  assert.equal(s.inScope, 0);
  assert.equal(s.score, null);
});

test("UC-01 A1: a failed bulk start retries once, then fails", async () => {
  seedDemo(f, 5);
  f.failNextBulk = 5;
  const shop = await onInstalled(db, DOMAIN, f.gql);
  await new Promise((r) => setTimeout(r, 400)); // SCAN_RETRY_MS=50 in the test script
  const scan = await db.scan.findFirstOrThrow({ where: { shopId: shop.id } });
  assert.equal(scan.status, "failed");
  assert.equal(f.countOps("RunScan"), 2);
});

test("AT-05: inline save writes to Shopify and resolves the issue", async () => {
  const v = f.add({ productId: "gid://shopify/Product/1", sku: "A-1", barcode: null, hsCode: "630221", countryOfOrigin: "IN" });
  const shop = await install();
  assert.ok(await db.issue.findFirst({ where: { shopId: shop.id, variantId: v.id, ruleCode: "R-NSPID-01", status: "open" } }));
  const t0 = Date.now();
  const [o] = await applyChanges(db, f.gql, { shopId: shop.id, actor: "user:1" }, [
    { variantId: v.id, changes: { nspid: "MFR-9", barcode: "5 901234 123457" } },
  ]);
  assert.equal(o!.status, "saved");
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(f.variants.get(v.id)!.metafields["customs.manufacturer_product_id"]!.value, "MFR-9");
  assert.equal(f.variants.get(v.id)!.barcode, "5901234123457", "E-02: normalized on save");
  const open = await db.issue.findMany({ where: { shopId: shop.id, variantId: v.id, status: "open" } });
  assert.deepEqual(open.map((i) => i.ruleCode), []);
  const audit = await db.auditLog.findMany({ where: { shopId: shop.id, variantId: v.id } });
  assert.equal(audit.length, 2);
  assert.ok(audit.some((a) => a.field === "barcode" && a.oldValue === null && a.newValue === "5901234123457"));
});

test("AT-06: edit in Shopify after the scan → conflict, no overwrite", async () => {
  const v = f.add({ productId: "gid://shopify/Product/1", sku: "A-1" });
  const shop = await install();
  const snap = await db.variantSnapshot.findFirstOrThrow({ where: { shopId: shop.id, variantId: v.id } });
  f.touch(v.id, { sku: "CHANGED-IN-ADMIN" });
  const [o] = await applyChanges(db, f.gql, { shopId: shop.id, actor: "user:1" }, [
    { variantId: v.id, changes: { sku: "MINE" }, expectedUpdatedAt: snap.updatedAt },
  ]);
  assert.equal(o!.status, "conflict");
  assert.equal(f.variants.get(v.id)!.sku, "CHANGED-IN-ADMIN");
  const fresh = await db.variantSnapshot.findFirstOrThrow({ where: { shopId: shop.id, variantId: v.id } });
  assert.equal(fresh.sku, "CHANGED-IN-ADMIN", "snapshot refreshed so reload shows the new value");
});

test("UC-04 A2: Shopify user error is reported and other fields still save", async () => {
  const v = f.add({ productId: "gid://shopify/Product/1", sku: "A-1" });
  const shop = await install();
  const [o] = await applyChanges(db, f.gql, { shopId: shop.id, actor: "u" }, [{ variantId: v.id, changes: { sku: "REJECT-ME", nspid: "M-1" } }]);
  assert.equal(o!.errors.sku, "SKU rejected by Shopify");
  assert.deepEqual(o!.written, ["nspid"]);
});

test("AT-07: bulk 'no barcode' on 500 variants, batches of 25, one audit entry", async () => {
  for (let i = 0; i < 500; i++) f.add({ productId: `gid://shopify/Product/${i}`, sku: `S-${i}`, metafields: { "customs.manufacturer_product_id": { type: "single_line_text_field", value: `M-${i}` } } });
  const shop = await install();
  const ids = (await db.issue.findMany({ where: { shopId: shop.id, ruleCode: "R-SPID-01", status: "open" } })).map((i) => i.variantId);
  assert.equal(ids.length, 500);
  const job = await enqueue(db, shop.id, "no_barcode_bulk", { variantIds: ids }, "user:1", ids.length);
  const t0 = Date.now();
  await runJob(db, f.gql, job.id);
  assert.ok(Date.now() - t0 < 60_000);
  const done = await db.job.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(done.status, "complete");
  assert.equal(done.done, 500);
  assert.equal(f.countOps("SetMetafields"), 20);
  const audit = await db.auditLog.findMany({ where: { shopId: shop.id, action: "no_barcode_bulk_done" } });
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.count, 500);
  assert.equal(await db.issue.count({ where: { shopId: shop.id, ruleCode: "R-SPID-01", status: "open" } }), 0);
});

test("AT-08: CSV round-trip — 300 changed rows, 20 invalid", async () => {
  for (let i = 0; i < 300; i++) f.add({ productId: `gid://shopify/Product/${i}`, sku: `S-${i}`, barcode: null });
  const shop = await install();
  const csv = await exportIssuesCsv(db, shop.id);
  const rows = parseCsv(csv);
  const h = rows[0]!;
  const col = (c: string) => h.indexOf(c);
  const body = rows.slice(1).map((r, i) => {
    const out = [...r];
    out[col("ns_pid")] = `MFR-${i}`;
    out[col("barcode")] = i < 20 ? "12345" : "";
    out[col("no_standard_identifier")] = i < 20 ? "false" : "true";
    return out;
  });
  const t0 = Date.now();
  const preview = await previewImport(db, shop.id, toCsv([h, ...body]));
  assert.ok(Date.now() - t0 < 10_000);
  assert.equal(preview.toChange.length, 280);
  assert.equal(preview.withErrors.length, 20);
  const items = itemsFromPreview(preview, "skip_rows");
  assert.equal(items.length, 280);
  const job = await enqueue(db, shop.id, "csv_apply", { items }, "user:1", items.length);
  await runJob(db, f.gql, job.id);
  const done = await db.job.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(done.done, 280);
  assert.equal(done.failed, 0);
  const fcsv = parseCsv(failuresCsv(preview, done.failures as any));
  assert.equal(fcsv.length - 1, 20);
  // Only changed fields were written: SKU untouched; the manufacturer code also became an NS_PID barcode.
  const vs = [...f.variants.values()];
  assert.ok(vs.every((v, i) => v.sku === `S-${i}`));
  assert.equal(vs.filter((v) => v.barcodeType === "NS_PID" && v.barcode?.startsWith("MFR-")).length, 280);
});

test("UC-06 A1: unknown variant ids are listed and skipped", async () => {
  f.add({ productId: "gid://shopify/Product/1", sku: "A" });
  const shop = await install();
  const p = await previewImport(db, shop.id, "variant_id,ns_pid\ngid://shopify/ProductVariant/999,X\n");
  assert.equal(p.unknown.length, 1);
});

test("AT-09: supplier link shows only its items; expired shows nothing; 21st submit refused", async () => {
  const a = f.add({ productId: "gid://shopify/Product/1", vendor: "Panipat", sku: "P-1", productTitle: "Towel" });
  f.add({ productId: "gid://shopify/Product/2", vendor: "Other", sku: "O-1" });
  const shop = await install();
  const items = await supplier.defaultItemsForVendor(db, shop.id, "Panipat");
  const { request, token } = await supplier.createRequest(db, { shopId: shop.id, supplierName: "Panipat Weaves", createdBy: "user:1", items });
  const req = await supplier.requestByToken(db, token);
  assert.ok(req);
  const pub = await supplier.publicItems(db, req!);
  assert.equal(pub.length, 1);
  assert.equal(pub[0]!.sku, "P-1");
  assert.equal(pub[0]!.productTitle, "Towel");
  assert.equal(await supplier.requestByToken(db, token.slice(0, -1) + (token.endsWith("A") ? "B" : "A")), null);
  const req2 = await db.supplierRequest.findUniqueOrThrow({ where: { id: request.id } });
  assert.notEqual(req2.tokenHash, token, "token is stored hashed");

  for (let i = 0; i < 20; i++) {
    const r = await supplier.submit(db, req!, [{ ref: 1, nspid: `M-${i}`, barcode: "", noBarcode: true }]);
    assert.equal(r.ok, true);
  }
  const r21 = await supplier.submit(db, req!, [{ ref: 1, nspid: "M-21", barcode: "", noBarcode: true }]);
  assert.equal(r21.ok, false);

  await db.supplierRequest.update({ where: { id: request.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal(await supplier.requestByToken(db, token), null);
});

test("AT-10: supplier submission is not written until approved; approval writes and logs", async () => {
  const a = f.add({ productId: "gid://shopify/Product/1", vendor: "Panipat", sku: "P-1" });
  const shop = await install();
  const items = await supplier.defaultItemsForVendor(db, shop.id, "Panipat");
  const { request, token } = await supplier.createRequest(db, { shopId: shop.id, supplierName: "Panipat", createdBy: "user:1", items });
  const req = (await supplier.requestByToken(db, token))!;
  const bad = await supplier.submit(db, req, [{ ref: 1, nspid: "PW-77", barcode: "5901234123458", noBarcode: false }]);
  assert.equal(bad.ok && bad.errors.length, 1, "invalid barcode refused");
  await supplier.submit(db, req, [{ ref: 1, nspid: "PW-77", barcode: "5901234123457", noBarcode: false }]);
  assert.equal(f.variants.get(a.id)!.metafields["customs.manufacturer_product_id"], undefined);
  assert.equal(f.countOps("SetMetafields"), 0);
  const review = await supplier.reviewRows(db, shop.id, request.id);
  assert.equal(review!.rows.length, 1);
  assert.equal(review!.rows[0]!.valid, true);
  const job = await supplier.approve(db, shop.id, request.id, [review!.rows[0]!.submission.id], "user:1");
  await runJob(db, f.gql, job!.id);
  assert.equal(f.variants.get(a.id)!.metafields["customs.manufacturer_product_id"]!.value, "PW-77");
  assert.equal(f.variants.get(a.id)!.barcode, "5901234123457");
  const sub = await db.supplierSubmission.findFirstOrThrow({ where: { requestId: request.id } });
  assert.equal(sub.reviewStatus, "approved");
  assert.ok(await db.auditLog.findFirst({ where: { shopId: shop.id, action: "supplier_approve" } }));
  assert.ok(await db.auditLog.findFirst({ where: { shopId: shop.id, action: "supplier_apply", field: "nspid" } }));
});

test("E-11: submission for a deleted variant cannot be approved", async () => {
  const a = f.add({ productId: "gid://shopify/Product/1", vendor: "Panipat", sku: "P-1" });
  const shop = await install();
  const items = await supplier.defaultItemsForVendor(db, shop.id, "Panipat");
  const { request, token } = await supplier.createRequest(db, { shopId: shop.id, supplierName: "P", createdBy: "u", items });
  await supplier.submit(db, (await supplier.requestByToken(db, token))!, [{ ref: 1, nspid: "X-1", barcode: "", noBarcode: true }]);
  f.variants.delete(a.id);
  await guardProduct(db, f.gql, shop.id, "gid://shopify/Product/1");
  const review = await supplier.reviewRows(db, shop.id, request.id);
  assert.equal(review!.rows[0]!.exists, false);
  assert.equal(await supplier.approve(db, shop.id, request.id, [review!.rows[0]!.submission.id], "u"), null);
});

test("AT-11: settings change re-evaluates with zero Shopify calls", async () => {
  f.add({ productId: "gid://shopify/Product/1", vendor: "Own", sku: "O-1", metafields: { "customs.manufacturer_product_id": { type: "single_line_text_field", value: "O-1" } } });
  const shop = await install();
  assert.ok(await db.issue.findFirst({ where: { shopId: shop.id, ruleCode: "R-NSPID-02", status: "open" } }));
  const before = f.calls.length;
  await db.settings.update({ where: { shopId: shop.id }, data: { ownBrandVendors: ["Own"], hsAsError: true } });
  await reevaluateShop(db, shop.id, { source: "settings" });
  assert.equal(f.calls.length, before);
  assert.ok(await db.issue.findFirst({ where: { shopId: shop.id, ruleCode: "R-NSPID-03", status: "open" } }));
  assert.ok(await db.issue.findFirst({ where: { shopId: shop.id, ruleCode: "R-NSPID-02", status: "resolved" } }));
  assert.equal((await db.issue.findFirstOrThrow({ where: { shopId: shop.id, ruleCode: "R-HS-01" } })).severity, "error");
});

test("AT-12: existing specs.mpn metafield is detected, mapped, and read by the rescan", async () => {
  const v = f.add({ productId: "gid://shopify/Product/1", sku: "A", metafields: { "specs.mpn": { type: "single_line_text_field", value: "MPN-123" } } });
  const shop = await install();
  const c = await detectCandidates(f.gql);
  assert.deepEqual(c.map((x) => `${x.namespace}.${x.key}`), ["specs.mpn"]);
  assert.deepEqual(c[0]!.samples, ["MPN-123"]);
  await db.settings.update({ where: { shopId: shop.id }, data: { nspidNamespace: "specs", nspidKey: "mpn" } });
  const { scanId } = await startScan(db, f.gql, shop.id);
  const scan = await db.scan.findUniqueOrThrow({ where: { id: scanId } });
  await onBulkFinish(db, f.gql, shop.id, scan.bulkOpId!);
  const snap = await db.variantSnapshot.findFirstOrThrow({ where: { shopId: shop.id, variantId: v.id } });
  assert.equal(snap.nspid, "MPN-123");
  assert.equal(f.variants.get(v.id)!.metafields["specs.mpn"]!.value, "MPN-123", "nothing copied or deleted");
});

test("E-09: default key with another type forces mapping before any write", async () => {
  f.definitions.push({ id: "d1", name: "Old", namespace: "customs", key: "manufacturer_product_id", type: { name: "number_integer" } });
  const v = f.add({ productId: "gid://shopify/Product/1", sku: "A" });
  const shop = await install();
  const s = await db.settings.findUniqueOrThrow({ where: { shopId: shop.id } });
  assert.equal(s.mappingRequired, true);
  const [o] = await applyChanges(db, f.gql, { shopId: shop.id, actor: "u" }, [{ variantId: v.id, changes: { nspid: "X" } }]);
  assert.equal(o!.status, "error");
  assert.equal(f.countOps("SetMetafields"), 0);
});

test("AT-13: new product via guard appears in issues; duplicate webhook is ignored", async () => {
  f.add({ productId: "gid://shopify/Product/1", sku: "A" });
  const shop = await install();
  const nv = f.add({ productId: "gid://shopify/Product/2", sku: "NEW-1" });
  assert.equal(await firstDelivery(db, "wh-1", DOMAIN, "products/create"), true);
  await guardProduct(db, f.gql, shop.id, "gid://shopify/Product/2");
  assert.equal(await firstDelivery(db, "wh-1", DOMAIN, "products/create"), false);
  const issues = await db.issue.findMany({ where: { shopId: shop.id, variantId: nv.id, ruleCode: "R-NSPID-01" } });
  assert.equal(issues.length, 1);
});

test("UC-12: a ready product that regresses raises the guard banner", async () => {
  const v = f.add({
    productId: "gid://shopify/Product/1", sku: "A", barcode: "5901234123457", hsCode: "630221", countryOfOrigin: "IN",
    metafields: { "customs.manufacturer_product_id": { type: "single_line_text_field", value: "M" } },
  });
  const shop = await install();
  assert.equal((await db.variantSnapshot.findFirstOrThrow({ where: { variantId: v.id } })).ready, true);
  f.touch(v.id, { barcode: null });
  await guardProduct(db, f.gql, shop.id, "gid://shopify/Product/1");
  assert.equal((await db.shop.findUniqueOrThrow({ where: { id: shop.id } })).guardAlert, true);
});

test("E-05: guard paginates a product with 2,100 variants", async () => {
  for (let i = 0; i < 2100; i++) f.add({ productId: "gid://shopify/Product/77", sku: `BIG-${i}` });
  const shop = await install();
  await guardProduct(db, f.gql, shop.id, "gid://shopify/Product/77");
  assert.equal(await db.variantSnapshot.count({ where: { shopId: shop.id, productId: "gid://shopify/Product/77" } }), 2100);
  assert.equal(f.countOps("ProductVariants"), 21);
});

test("AT-14: readiness report has one row per in-scope variant, with Y081", async () => {
  seedDemo(f, 40);
  const v = f.add({ productId: "gid://shopify/Product/555", sku: "Y", metafields: { "customs.no_standard_identifier": { type: "boolean", value: "true" } } });
  const shop = await install();
  const csv = parseCsv(await readinessReportCsv(db, shop.id));
  assert.match(csv[0]![0]!, /Not legal advice/);
  const rows = csv.slice(2);
  assert.equal(rows.length, 41);
  const y = rows.find((r) => r[0] === v.id)!;
  assert.equal(y[6], "Y081");
});

test("AT-15: double-click rescan starts one bulk operation", async () => {
  seedDemo(f, 10);
  const shop = await install();
  const before = f.countOps("RunScan");
  const [a, b] = await Promise.all([startScan(db, f.gql, shop.id), startScan(db, f.gql, shop.id)]);
  assert.equal(f.countOps("RunScan") - before, 1);
  assert.equal([a.started, b.started].filter(Boolean).length, 1);
});

test("AT-16 (logic): free plan can view but fixing is gated; over-cap keeps fixed variants fixable", () => {
  assert.equal(gateFix("free", 100).ok, false);
  assert.equal(gateFix("starter", 900).ok, true);
  assert.equal(gateFix("starter", 1500).ok, false);
  assert.equal(gateFix("starter", 1500, { variantAlreadyFixed: true }).ok, true);
});

test("AT-17: shop/redact removes every row; shop A cannot see shop B", async () => {
  seedDemo(f, 20);
  const a = await install("a.myshopify.com");
  const f2 = new FakeShopify();
  seedDemo(f2, 15);
  const b = await install("b.myshopify.com", f2);
  const aIssues = await db.issue.findMany({ where: { shopId: a.id } });
  assert.ok(aIssues.every((i) => i.shopId === a.id));
  assert.equal((await dashboardSummary(db, b.id)).inScope, 15);
  const items = await supplier.itemsFromIssues(db, a.id, (await db.variantSnapshot.findMany({ where: { shopId: b.id } })).map((s) => s.variantId));
  assert.equal(items.length, 0, "shop A cannot pull shop B variants into a request");

  await onUninstalled(db, null, "a.myshopify.com");
  await redactShop(db, "a.myshopify.com");
  for (const t of ["auditLog", "job", "issue", "variantSnapshot", "supplierRequest", "scan", "settings"] as const) {
    assert.equal(await (db as any)[t].count({ where: { shopId: a.id } }), 0, t);
  }
  assert.equal(await db.shop.count({ where: { id: a.id } }), 0);
  assert.ok((await db.variantSnapshot.count({ where: { shopId: b.id } })) > 0);
});

test("E-12: uninstall stops queued jobs and revokes supplier links", async () => {
  f.add({ productId: "gid://shopify/Product/1", vendor: "V", sku: "A" });
  const shop = await install();
  const items = await supplier.defaultItemsForVendor(db, shop.id, "V");
  const { token } = await supplier.createRequest(db, { shopId: shop.id, supplierName: "V", createdBy: "u", items });
  const job = await enqueue(db, shop.id, "no_barcode_bulk", { variantIds: [] }, "u", 0);
  await onUninstalled(db, f.gql, DOMAIN);
  assert.equal(await supplier.requestByToken(db, token), null);
  assert.equal((await db.job.findUniqueOrThrow({ where: { id: job.id } })).status, "failed");
});

test("FR-08: jobs are claimed at most 2 per shop, and stale running jobs resume", async () => {
  f.add({ productId: "gid://shopify/Product/1", sku: "A" });
  const shop = await install();
  for (let i = 0; i < 4; i++) await enqueue(db, shop.id, "no_barcode_bulk", { variantIds: [] }, "u", 0);
  const claimed = await claimJobs(db);
  assert.equal(claimed.length, 2);
  await db.job.updateMany({ where: { status: "running" }, data: { updatedAt: new Date(Date.now() - 600_000) } });
  await db.$executeRawUnsafe(`UPDATE "Job" SET "updatedAt" = now() - interval '10 minutes' WHERE status = 'running'`);
  const r = await requeueStale(db);
  assert.equal(r.count, 2);
});

test("NFR: THROTTLED responses are retried with backoff", async () => {
  f.add({ productId: "gid://shopify/Product/1", sku: "A" });
  f.throttleNext = 2;
  const gql = withRetry(async (q, v) => {
    try {
      return { body: { data: await f.gql(q, v) } };
    } catch (e: any) {
      return { body: e.body };
    }
  });
  const data = await gql<any>(`query ShopInfo { shop { name } }`);
  assert.equal(data.shop.name, "Indigo Loom");
});

// ---- EU focus, multi-barcode, send-to-provider -------------------------------------------

const EAN = "8901234567890"; // valid EAN-13

test("EU: shipping profiles decide which items can reach the EU; summary narrows to them", async () => {
  const a = f.add({ productId: "gid://shopify/Product/1", sku: "A-1", barcode: EAN });
  const b = f.add({ productId: "gid://shopify/Product/2", sku: "B-1" });
  const c = f.add({ productId: "gid://shopify/Product/3", sku: "C-1" });
  f.profiles.push({ id: "gid://shopify/DeliveryProfile/2", name: "India only", default: false, countries: ["IN"], variantIds: [b.id] });
  f.profiles.push({ id: "gid://shopify/DeliveryProfile/3", name: "Worldwide", default: false, countries: [], restOfWorld: true, variantIds: [c.id] });
  const shop = await install();
  const r = await syncEuShipping(db, f.gql, shop.id);
  assert.ok(r.ok);
  assert.ok(r.countries.includes("DE") && r.countries.includes("PL")); // rest of world covers every EU country
  const ids = await euVariantIds(db, shop.id);
  assert.deepEqual([...ids!].sort(), [a.id, c.id].sort());
  const row = await db.shop.findUniqueOrThrow({ where: { id: shop.id }, include: { settings: true } });
  const filter = await euFilter(db, row);
  assert.equal(filter.on, true);
  assert.equal((await dashboardSummary(db, shop.id, filter.ids)).inScope, 2);
  assert.equal((await dashboardSummary(db, shop.id)).inScope, 3);
  const sheet = await productSheet(db, shop.id, filter.ids);
  assert.deepEqual(sheet.map((x) => x.sku).sort(), ["A-1", "C-1"]);
  assert.equal(sheet.find((x) => x.sku === "A-1")!.fedex, ""); // no manufacturer code yet → no FedEx text
});

test("EU: default profile without EU countries and no custom profiles → nothing ships to the EU", async () => {
  f.profiles[0]!.countries = ["US", "CA"];
  f.add({ productId: "gid://shopify/Product/1", sku: "A-1" });
  const shop = await install();
  await syncEuShipping(db, f.gql, shop.id);
  const row = await db.shop.findUniqueOrThrow({ where: { id: shop.id }, include: { settings: true } });
  assert.equal(row.sellsToEu, false);
  const filter = await euFilter(db, row);
  assert.equal(filter.euCount, 0);
  assert.equal(filter.on, false); // nothing to narrow to: show everything
});

test("EU: no shipping access → status no_access, nothing else breaks", async () => {
  f.add({ productId: "gid://shopify/Product/1", sku: "A-1" });
  f.denyShipping = true;
  const shop = await install();
  const r = await syncEuShipping(db, f.gql, shop.id);
  assert.equal(r.ok, false);
  const row = await db.shop.findUniqueOrThrow({ where: { id: shop.id } });
  assert.equal(row.euSyncStatus, "no_access");
  assert.equal(await euVariantIds(db, shop.id), null);
});

test("Scan finish queues one EU shipping check; the job completes", async () => {
  f.add({ productId: "gid://shopify/Product/1", sku: "A-1" });
  const shop = await install();
  const jobs = await db.job.findMany({ where: { shopId: shop.id, type: "eu_sync" } });
  assert.equal(jobs.length, 1);
  await runJob(db, f.gql, jobs[0]!.id);
  assert.equal((await db.job.findUniqueOrThrow({ where: { id: jobs[0]!.id } })).status, "complete");
  assert.equal((await db.shop.findUniqueOrThrow({ where: { id: shop.id } })).euSyncStatus, "ok");
});

test("Barcodes: bulk child lines are read; NS_PID barcode is the manufacturer code; ASIN ignored", async () => {
  const shop = await install(); // empty catalogue; creates shop + scan
  const scan = await db.scan.create({ data: { shopId: shop.id, status: "running", startedAt: new Date() } });
  const v = (id: number, extra: object = {}) => ({
    id: `gid://shopify/ProductVariant/${id}`, sku: `S-${id}`, barcode: null, updatedAt: new Date().toISOString(), title: "Default Title",
    product: { id: `gid://shopify/Product/${id}`, title: `P${id}`, vendor: "V", productType: "", status: "ACTIVE", isGiftCard: false },
    inventoryItem: { id: `gid://shopify/InventoryItem/${id}`, requiresShipping: true, harmonizedSystemCode: "630221", countryCodeOfOrigin: "IN" },
    nspid: null, noStd: null, ...extra,
  });
  const lines = [
    v(1, { barcode: EAN }),
    { value: EAN, type: "EAN", __parentId: "gid://shopify/ProductVariant/1" },
    { value: "TX-88213", type: "NS_PID", __parentId: "gid://shopify/ProductVariant/1" },
    v(2, { barcode: "B08N5WRWNW" }),
    { value: "B08N5WRWNW", type: "ASIN", __parentId: "gid://shopify/ProductVariant/2" },
    { value: EAN.slice(0, 12) + "3", type: null, __parentId: "gid://shopify/ProductVariant/2" },
  ].map((x) => JSON.stringify(x)).join("\n");
  await ingest(db, shop.id, scan.id, `data:application/jsonl;base64,${Buffer.from(lines).toString("base64")}`);
  const s1 = await db.variantSnapshot.findUniqueOrThrow({ where: { shopId_variantId: { shopId: shop.id, variantId: "gid://shopify/ProductVariant/1" } } });
  assert.deepEqual(s1.barcodes, [EAN]);
  assert.equal(s1.nspid, "TX-88213");
  assert.equal(s1.nspidInBarcodes, true);
  const s2 = await db.variantSnapshot.findUniqueOrThrow({ where: { shopId_variantId: { shopId: shop.id, variantId: "gid://shopify/ProductVariant/2" } } });
  assert.deepEqual(s2.barcodes, [EAN.slice(0, 12) + "3"]); // ASIN skipped, the numeric one kept
  const issues = await db.issue.findMany({ where: { shopId: shop.id, variantId: s2.variantId, status: "open" } });
  assert.ok(issues.some((i) => i.ruleCode === "R-SPID-03")); // wrong check digit still reported
});

test("Barcodes: saving writes the manufacturer code as an NS_PID barcode after the standard one; other barcodes kept", async () => {
  const v = f.add({ productId: "gid://shopify/Product/1", sku: "A-1", barcode: "1234", extraBarcodes: [{ value: "INTERNAL-7", type: null }] });
  const shop = await install();
  const [o] = await applyChanges(db, f.gql, { shopId: shop.id, actor: "t" }, [{ variantId: v.id, changes: { barcode: EAN, nspid: "MFR-1" } }]);
  assert.equal(o!.status, "saved");
  const fv = f.variants.get(v.id)!;
  assert.equal(fv.barcode, EAN);
  assert.equal(fv.barcodeType, "GTIN");
  assert.deepEqual(fv.extraBarcodes, [{ value: "MFR-1", type: "NS_PID" }, { value: "INTERNAL-7", type: null }]);
  assert.equal(fv.metafields["customs.manufacturer_product_id"]!.value, "MFR-1");
  let snap = await db.variantSnapshot.findUniqueOrThrow({ where: { shopId_variantId: { shopId: shop.id, variantId: v.id } } });
  assert.equal(snap.nspid, "MFR-1");
  assert.equal(snap.nspidInBarcodes, true);
  assert.deepEqual(snap.barcodes, [EAN]); // NS_PID and the internal code are not barcodes for customs
  // Changing the code replaces the NS_PID barcode; no duplicates.
  await applyChanges(db, f.gql, { shopId: shop.id, actor: "t" }, [{ variantId: v.id, changes: { nspid: "MFR-2" } }]);
  assert.deepEqual(f.variants.get(v.id)!.extraBarcodes, [{ value: "MFR-2", type: "NS_PID" }, { value: "INTERNAL-7", type: null }]);
  snap = await db.variantSnapshot.findUniqueOrThrow({ where: { shopId_variantId: { shopId: shop.id, variantId: v.id } } });
  assert.equal(snap.nspid, "MFR-2");
});

test("Publish: codes stored only in the metafield get an NS_PID barcode; untyped copies are retyped; FlavorCloud fields", async () => {
  const meta = (v: string) => ({ "customs.manufacturer_product_id": { type: "single_line_text_field", value: v } });
  const a = f.add({ productId: "gid://shopify/Product/1", sku: "A-1", barcode: EAN, metafields: meta("M-A") });
  const b = f.add({ productId: "gid://shopify/Product/2", sku: "B-1", barcode: EAN.slice(0, 12) + "3", extraBarcodes: [{ value: "M-B", type: null }], metafields: meta("M-B") });
  const c = f.add({ productId: "gid://shopify/Product/3", sku: "C-1", metafields: { ...meta("M-C"), "customs.no_standard_identifier": { type: "boolean", value: "true" } } });
  const shop = await install();
  const out = await publishCodes(db, f.gql, { shopId: shop.id, actor: "t" }, [a.id, b.id, c.id], { flavorcloud: true });
  assert.deepEqual(out.map((o) => o.status), ["saved", "saved", "saved"]);
  assert.deepEqual(f.variants.get(a.id)!.extraBarcodes, [{ value: "M-A", type: "NS_PID" }]);
  assert.deepEqual(f.variants.get(b.id)!.extraBarcodes, [{ value: "M-B", type: "NS_PID" }]);
  assert.equal(f.variants.get(c.id)!.barcode, "M-C"); // no standard barcode: NS_PID becomes the only one
  assert.equal(f.variants.get(c.id)!.barcodeType, "NS_PID");
  assert.equal(f.variants.get(a.id)!.metafields["flavorcloud.ns_manufacturer_pid"]!.value, "M-A");
  assert.equal(f.variants.get(a.id)!.metafields["flavorcloud.std_manufacturer_pid_type"]!.value, "EAN13");
  assert.equal(f.variants.get(c.id)!.metafields["flavorcloud.std_manufacturer_pid_type"]!.value, "NONE");
  const snapC = await db.variantSnapshot.findUniqueOrThrow({ where: { shopId_variantId: { shopId: shop.id, variantId: c.id } } });
  assert.deepEqual(snapC.barcodes, []);
  const issues = await db.issue.findMany({ where: { shopId: shop.id, variantId: c.id, status: "open" } });
  assert.ok(!issues.some((i) => i.ruleCode.startsWith("R-SPID"))); // still "no barcode", not a bad barcode
  const again = await publishCodes(db, f.gql, { shopId: shop.id, actor: "t" }, [a.id, b.id, c.id]);
  assert.deepEqual(again.map((o) => o.status), ["unchanged", "unchanged", "unchanged"]);
});

test("Customs file: one row per in-scope item with the three codes and Y081", async () => {
  f.add({ productId: "gid://shopify/Product/1", sku: "A-1", barcode: EAN, metafields: { "customs.manufacturer_product_id": { type: "single_line_text_field", value: "M-1" } } });
  f.add({ productId: "gid://shopify/Product/2", sku: "B-1", metafields: { "customs.no_standard_identifier": { type: "boolean", value: "true" } } });
  const shop = await install();
  const zon = parseCsv(await customsFileCsv(db, shop.id, { format: "zonos" }));
  assert.equal(zon[0]!.length, 25);
  assert.equal(zon[0]![23], "GTIN");
  assert.equal(zon[0]![24], "Manufacturer product ID");
  const za = zon.find((r) => r[0] === "A-1")!;
  assert.equal(za[23], EAN);
  assert.equal(za[24], "M-1");
  assert.deepEqual(parseCsv(await customsFileCsv(db, shop.id, { format: "veeqo" }))[0], ["sku_code", "upc_code", "upc_code_type", "model_number"]);
  const ups = parseCsv(await customsFileCsv(db, shop.id, { format: "ups" }));
  assert.equal(ups.find((r) => r[0] === "B-1")![4], "No");
  const std = parseCsv(await customsFileCsv(db, shop.id, { format: "standard" }));
  assert.equal(std.find((r) => r[2] === "A-1")![8], `M-PIDA-1 NS-PIDM-1 S-PID${EAN}`);
  assert.equal(std.find((r) => r[2] === "B-1")![8], ""); // no manufacturer code
  const rows = parseCsv(await customsFileCsv(db, shop.id, { format: "shipping_app" }));
  assert.deepEqual(rows[0]!.slice(3, 7), ["m_pid", "ns_pid", "s_pid", "s_pid_exception"]);
  const a = rows.find((r) => r[0] === "A-1")!;
  assert.deepEqual(a.slice(3, 7), ["A-1", "M-1", EAN, ""]);
  const b = rows.find((r) => r[0] === "B-1")!;
  assert.equal(b[6], "Y081");
});
