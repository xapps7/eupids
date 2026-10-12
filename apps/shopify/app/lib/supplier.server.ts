// UC-07 / UC-08 / UC-09 / FR-10: supplier requests through a token link.
// The token is 32 random bytes; only its SHA-256 is stored. Nothing a supplier sends
// is written to Shopify until the merchant approves it.
import type { PrismaClient, SupplierRequest } from "@prisma/client";
import { isValidGtin, normalizeBarcode, parseCsv, toCsv } from "@pidready/rules";
import { newSupplierToken, safeEqualHex, sha256 } from "./crypto.server";
import { enqueue } from "./jobs.server";

export const EXPIRY_DAYS = 30;
export const SUBMITS_PER_HOUR = 20;
const NSPID_CODES = ["R-NSPID-01", "R-NSPID-04"];
const SPID_CODES = ["R-SPID-01", "R-SPID-02", "R-SPID-03", "R-SPID-04", "R-SPID-05"];

export async function defaultItemsForVendor(db: PrismaClient, shopId: string, vendor: string) {
  const snaps = await db.variantSnapshot.findMany({ where: { shopId, vendor, inScope: true }, select: { variantId: true } });
  return itemsFromIssues(db, shopId, snaps.map((s) => s.variantId));
}

export async function itemsFromIssues(db: PrismaClient, shopId: string, variantIds: string[]) {
  const issues = await db.issue.findMany({
    where: { shopId, status: "open", variantId: { in: variantIds }, ruleCode: { in: [...NSPID_CODES, ...SPID_CODES] } },
    select: { variantId: true, ruleCode: true },
  });
  const map = new Map<string, { variantId: string; needsNspid: boolean; needsBarcode: boolean }>();
  for (const i of issues) {
    const it = map.get(i.variantId) ?? { variantId: i.variantId, needsNspid: false, needsBarcode: false };
    if (NSPID_CODES.includes(i.ruleCode)) it.needsNspid = true;
    if (SPID_CODES.includes(i.ruleCode)) it.needsBarcode = true;
    map.set(i.variantId, it);
  }
  return [...map.values()];
}

export async function createRequest(
  db: PrismaClient,
  args: { shopId: string; supplierName: string; supplierEmail?: string | null; createdBy: string; items: { variantId: string; needsNspid: boolean; needsBarcode: boolean }[] },
) {
  if (!args.items.length) throw new Error("No items need codes from this supplier.");
  const token = newSupplierToken();
  const request = await db.supplierRequest.create({
    data: {
      shopId: args.shopId,
      supplierName: args.supplierName.trim(),
      supplierEmail: args.supplierEmail?.trim() || null,
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + EXPIRY_DAYS * 86_400_000),
      createdBy: args.createdBy,
      items: { create: args.items },
    },
  });
  await db.auditLog.create({ data: { shopId: args.shopId, actor: args.createdBy, action: "supplier_request_created", count: args.items.length, newValue: request.id } });
  return { request, token };
}

export function supplierMessage(storeName: string, supplierName: string, link: string, count: number) {
  return [
    `Hi ${supplierName},`,
    ``,
    `From 1 November 2026, EU customs needs the manufacturer's product code for every item we ship to EU customers.`,
    `We need codes for ${count} item${count === 1 ? "" : "s"} you supply to ${storeName}.`,
    ``,
    `Please open this link and fill in the manufacturer code and barcode (GTIN/EAN/UPC) for each item. No login needed:`,
    link,
    ``,
    `You can also download the list as a spreadsheet, fill it in, and upload it on the same page.`,
    `The link works for 30 days. Thank you!`,
  ].join("\n");
}

export type ActiveRequest = SupplierRequest & { shop: { name: string | null; domain: string; active: boolean } };

/** UC-08 A1: expired, revoked, uninstalled or unknown links all return null (no data shown). */
export async function requestByToken(db: PrismaClient, token: string): Promise<ActiveRequest | null> {
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) return null;
  const hash = sha256(token);
  const req = await db.supplierRequest.findUnique({ where: { tokenHash: hash }, include: { shop: { select: { name: true, domain: true, active: true } } } });
  if (!req || !safeEqualHex(req.tokenHash, hash)) return null;
  if (req.revoked || req.expiresAt.getTime() < Date.now() || !req.shop.active) return null;
  return req;
}

/** NFR Supplier page: only title, variant title, image and merchant SKU leave the admin. */
export async function publicItems(db: PrismaClient, req: SupplierRequest) {
  const items = await db.supplierRequestItem.findMany({ where: { requestId: req.id } });
  const snaps = await db.variantSnapshot.findMany({
    where: { shopId: req.shopId, variantId: { in: items.map((i) => i.variantId) } },
    select: { variantId: true, productTitle: true, variantTitle: true, imageUrl: true, sku: true },
  });
  const subs = await db.supplierSubmission.findMany({ where: { requestId: req.id } });
  const snapBy = new Map(snaps.map((s) => [s.variantId, s]));
  const subBy = new Map(subs.map((s) => [s.variantId, s]));
  return items
    .map((it, i) => {
      const s = snapBy.get(it.variantId);
      if (!s) return null;
      const sub = subBy.get(it.variantId);
      return {
        ref: i + 1,
        variantId: it.variantId, // never rendered; used server-side only
        productTitle: s.productTitle,
        variantTitle: s.variantTitle,
        imageUrl: s.imageUrl,
        sku: s.sku ?? "",
        needsNspid: it.needsNspid,
        needsBarcode: it.needsBarcode,
        submitted: sub ? { nspid: sub.nspid ?? "", barcode: sub.barcode ?? "", noBarcode: sub.noBarcode, locked: sub.reviewStatus === "approved" } : null,
      };
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
}

export type SupplierRow = { ref: number; nspid: string; barcode: string; noBarcode: boolean };

export function validateSupplierRow(r: SupplierRow): string | null {
  const nspid = r.nspid.trim();
  if (nspid.length > 70 || /[\p{Cc}\p{Cf}]/u.test(nspid)) return "Manufacturer code is too long or has invalid characters.";
  const b = normalizeBarcode(r.barcode);
  if (b && !isValidGtin(b)) return "This barcode isn’t valid. Check the digits, or tick “no barcode”.";
  return null;
}

/** UC-08: save a (possibly partial) submission. Rate limited per link (AT-09). */
export async function submit(db: PrismaClient, req: SupplierRequest, rows: SupplierRow[]) {
  const since = new Date(Date.now() - 3_600_000);
  const recent = await db.auditLog.count({ where: { shopId: req.shopId, actor: `supplier:${req.id}`, action: "supplier_submit", at: { gte: since } } });
  if (recent >= SUBMITS_PER_HOUR) return { ok: false as const, error: "Too many submissions from this link. Please try again in an hour." };

  const items = await db.supplierRequestItem.findMany({ where: { requestId: req.id } });
  const byRef = new Map(items.map((it, i) => [i + 1, it]));
  const existing = await db.supplierSubmission.findMany({ where: { requestId: req.id } });
  const locked = new Set(existing.filter((e) => e.reviewStatus === "approved").map((e) => e.variantId));
  const errors: { ref: number; error: string }[] = [];
  let saved = 0;

  await db.auditLog.create({ data: { shopId: req.shopId, actor: `supplier:${req.id}`, action: "supplier_submit", count: rows.length } });

  for (const r of rows) {
    const it = byRef.get(r.ref);
    if (!it) continue;
    const empty = !r.nspid.trim() && !r.barcode.trim() && !r.noBarcode;
    if (empty) continue; // A2: partial submissions allowed
    if (locked.has(it.variantId)) continue;
    const err = validateSupplierRow(r);
    if (err) {
      errors.push({ ref: r.ref, error: err });
      continue;
    }
    const data = {
      nspid: r.nspid.trim() || null,
      barcode: normalizeBarcode(r.barcode) || null,
      noBarcode: !normalizeBarcode(r.barcode) && r.noBarcode,
      submittedAt: new Date(),
      reviewStatus: "pending",
      reviewedAt: null,
    };
    await db.supplierSubmission.upsert({
      where: { requestId_variantId: { requestId: req.id, variantId: it.variantId } },
      update: data,
      create: { requestId: req.id, variantId: it.variantId, ...data },
    });
    saved++;
  }
  return { ok: true as const, saved, errors };
}

export const SUPPLIER_CSV_HEADER = ["ref", "product", "variant", "store_sku", "manufacturer_code", "barcode", "no_barcode"];

export async function supplierCsv(db: PrismaClient, req: SupplierRequest) {
  const items = await publicItems(db, req);
  return toCsv([
    SUPPLIER_CSV_HEADER,
    ...items.map((i) => [String(i.ref), i.productTitle, i.variantTitle, i.sku, i.submitted?.nspid ?? "", i.submitted?.barcode ?? "", i.submitted?.noBarcode ? "yes" : ""]),
  ]);
}

export function parseSupplierCsv(text: string): SupplierRow[] {
  const rows = parseCsv(text);
  const h = (rows[0] ?? []).map((x) => x.trim().toLowerCase());
  const col = (n: string) => h.indexOf(n);
  if (col("ref") === -1) throw new Error("The file needs the ref column from the downloaded list.");
  return rows.slice(1).map((r) => ({
    ref: Number(r[col("ref")]),
    nspid: r[col("manufacturer_code")] ?? "",
    barcode: r[col("barcode")] ?? "",
    noBarcode: /^(yes|y|true|1|x)$/i.test((r[col("no_barcode")] ?? "").trim()),
  })).filter((r) => Number.isInteger(r.ref) && r.ref > 0);
}

/** UC-09: diff view — current value → submitted value, with validation. */
export async function reviewRows(db: PrismaClient, shopId: string, requestId: string) {
  const req = await db.supplierRequest.findFirst({ where: { id: requestId, shopId } });
  if (!req) return null;
  const subs = await db.supplierSubmission.findMany({ where: { requestId }, orderBy: { submittedAt: "desc" } });
  const snaps = await db.variantSnapshot.findMany({ where: { shopId, variantId: { in: subs.map((s) => s.variantId) } } });
  const by = new Map(snaps.map((s) => [s.variantId, s]));
  return {
    request: req,
    rows: subs.map((s) => {
      const snap = by.get(s.variantId);
      return {
        submission: s,
        exists: !!snap, // E-11
        title: snap ? [snap.productTitle, snap.variantTitle].filter(Boolean).join(" / ") : "Variant no longer exists",
        sku: snap?.sku ?? "",
        current: { nspid: snap?.nspid ?? "", barcode: snap?.barcodes[0] ?? "", noBarcode: snap?.noStandardIdentifier ?? false },
        valid: validateSupplierRow({ ref: 0, nspid: s.nspid ?? "", barcode: s.barcode ?? "", noBarcode: s.noBarcode }) === null,
      };
    }),
  };
}

/** UC-09: approval queues a job that writes like UC-04. E-11: deleted variants cannot be approved. */
export async function approve(db: PrismaClient, shopId: string, requestId: string, submissionIds: string[], actor: string) {
  const req = await db.supplierRequest.findFirst({ where: { id: requestId, shopId } });
  if (!req) throw new Error("Request not found");
  const subs = await db.supplierSubmission.findMany({ where: { requestId, id: { in: submissionIds }, reviewStatus: "pending" } });
  const snaps = await db.variantSnapshot.findMany({ where: { shopId, variantId: { in: subs.map((s) => s.variantId) } }, select: { variantId: true } });
  const alive = new Set(snaps.map((s) => s.variantId));
  const ok = subs.filter((s) => alive.has(s.variantId));
  if (!ok.length) return null;
  await db.auditLog.create({ data: { shopId, actor, action: "supplier_approve", count: ok.length, newValue: requestId } });
  return enqueue(db, shopId, "supplier_apply", { requestId, submissionIds: ok.map((s) => s.id) }, `${actor} via supplier:${requestId}`, ok.length);
}

export async function reject(db: PrismaClient, shopId: string, requestId: string, submissionIds: string[], actor: string) {
  const req = await db.supplierRequest.findFirst({ where: { id: requestId, shopId } });
  if (!req) throw new Error("Request not found");
  const r = await db.supplierSubmission.updateMany({
    where: { requestId, id: { in: submissionIds }, reviewStatus: "pending" },
    data: { reviewStatus: "rejected", reviewedAt: new Date() },
  });
  await db.auditLog.create({ data: { shopId, actor, action: "supplier_reject", count: r.count, newValue: requestId } });
  return r.count;
}

export async function revoke(db: PrismaClient, shopId: string, requestId: string, actor: string) {
  await db.supplierRequest.updateMany({ where: { id: requestId, shopId }, data: { revoked: true } });
  await db.auditLog.create({ data: { shopId, actor, action: "supplier_revoke", newValue: requestId } });
}

export async function pendingCount(db: PrismaClient, shopId: string) {
  return db.supplierSubmission.count({ where: { reviewStatus: "pending", request: { shopId } } });
}

export async function activeRequestCount(db: PrismaClient, shopId: string) {
  return db.supplierRequest.count({ where: { shopId, revoked: false, expiresAt: { gt: new Date() } } });
}

/** The token is shown once. If the merchant loses it, issue a new one (old link stops working). */
export async function rotateToken(db: PrismaClient, shopId: string, requestId: string, actor: string) {
  const token = newSupplierToken();
  const r = await db.supplierRequest.updateMany({
    where: { id: requestId, shopId },
    data: { tokenHash: sha256(token), revoked: false, expiresAt: new Date(Date.now() + EXPIRY_DAYS * 86_400_000) },
  });
  if (!r.count) throw new Error("Request not found");
  await db.auditLog.create({ data: { shopId, actor, action: "supplier_link_rotated", newValue: requestId } });
  return token;
}

export function supplierLink(token: string) {
  const base = (process.env.SHOPIFY_APP_URL || "http://localhost:3000").replace(/\/$/, "");
  return `${base}/s/${token}`;
}
