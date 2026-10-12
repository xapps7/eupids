// UC-01 / UC-14 / FR-02: full catalogue scan through one bulk operation.
// The JSONL result is streamed line by line; it is never loaded whole into memory.
import type { PrismaClient } from "@prisma/client";
import type { Gql } from "./gql.server";
import { BULK_CANCEL, BULK_RUN, BULK_STATUS, bulkScanQuery } from "./queries";
import { nodeToSnapshot, type SnapshotRow, type VariantNode } from "./snapshot";
import { reevaluateShop } from "./evaluate.server";
import { upsertSnapshots } from "./snapshot-store.server";
import { log } from "./log.server";

export const RETRY_DELAY_MS = Number(process.env.SCAN_RETRY_MS ?? 30_000); // UC-01 A1
const BATCH = 500;

/**
 * UC-14: at most one queued/running scan per shop. The shop row is locked for
 * the check-and-insert, so a double click can never start two bulk operations (AT-15).
 */
export async function startScan(db: PrismaClient, gql: Gql, shopId: string): Promise<{ scanId: string; started: boolean }> {
  const created = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Shop" WHERE id = ${shopId} FOR UPDATE`;
    const running = await tx.scan.findFirst({ where: { shopId, status: { in: ["queued", "running"] } } });
    if (running) return { scan: running, started: false };
    const scan = await tx.scan.create({ data: { shopId, status: "queued" } });
    return { scan, started: true };
  });
  if (!created.started) return { scanId: created.scan.id, started: false };
  await runBulk(db, gql, shopId, created.scan.id);
  return { scanId: created.scan.id, started: true };
}

async function runBulk(db: PrismaClient, gql: Gql, shopId: string, scanId: string) {
  const settings = await db.settings.findUnique({ where: { shopId } });
  const query = bulkScanQuery({ namespace: settings?.nspidNamespace ?? "customs", key: settings?.nspidKey ?? "manufacturer_product_id" });
  await db.scan.update({ where: { id: scanId }, data: { attempts: { increment: 1 } } });
  try {
    const data = await gql<any>(BULK_RUN, { query });
    const errs = data?.bulkOperationRunQuery?.userErrors ?? [];
    const op = data?.bulkOperationRunQuery?.bulkOperation;
    if (errs.length || !op) throw new Error(errs.map((e: any) => e.message).join("; ") || "No bulk operation returned");
    await db.scan.update({
      where: { id: scanId },
      data: { status: "running", bulkOpId: op.id, startedAt: new Date() },
    });
  } catch (e: any) {
    await failOrRetry(db, gql, shopId, scanId, String(e?.message ?? e));
  }
}

async function failOrRetry(db: PrismaClient, gql: Gql, shopId: string, scanId: string, error: string) {
  const scan = await db.scan.findUnique({ where: { id: scanId } });
  if (!scan) return;
  log.warn("scan_failed_attempt", { shopId, scanId, attempts: scan.attempts, error });
  if (scan.attempts < 2) {
    // A1: retry once after 30 s.
    await db.scan.update({ where: { id: scanId }, data: { status: "queued", error } });
    setTimeout(() => {
      runBulk(db, gql, shopId, scanId).catch((err) => log.error("scan_retry_error", { shopId, scanId, err: String(err) }));
    }, RETRY_DELAY_MS).unref?.();
    return;
  }
  await db.scan.update({ where: { id: scanId }, data: { status: "failed", error, finishedAt: new Date() } });
  log.error("scan_failed", { shopId, scanId, error });
}

/** bulk_operations/finish webhook, or the polling fallback. */
export async function onBulkFinish(
  db: PrismaClient,
  gql: Gql,
  shopId: string,
  bulkOpId: string,
  fetchImpl: typeof fetch = fetch,
) {
  const scan = await db.scan.findFirst({ where: { shopId, bulkOpId } });
  if (!scan || scan.status !== "running") return { handled: false };
  const data = await gql<any>(BULK_STATUS, { id: bulkOpId });
  const op = data?.node;
  if (!op) return { handled: false };
  if (op.status === "RUNNING" || op.status === "CREATED") return { handled: false };
  if (op.status !== "COMPLETED") {
    await failOrRetry(db, gql, shopId, scan.id, `Bulk operation ${op.status} ${op.errorCode ?? ""}`.trim());
    return { handled: true };
  }
  await ingest(db, shopId, scan.id, op.url ?? null, fetchImpl);
  return { handled: true };
}

async function* lines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.pipeThrough(new TextDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array>).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield line;
    }
  }
  if (buf.trim()) yield buf.trim();
}

async function writeBatch(db: PrismaClient, shopId: string, rows: SnapshotRow[]) {
  if (!rows.length) return;
  await upsertSnapshots(db, rows);
}

/** Stream the JSONL, upsert snapshots in batches, drop variants that no longer exist, evaluate. */
export async function ingest(db: PrismaClient, shopId: string, scanId: string, url: string | null, fetchImpl: typeof fetch = fetch) {
  const scan = await db.scan.findUniqueOrThrow({ where: { id: scanId } });
  let total = 0;
  if (url) {
    const res = await fetchImpl(url);
    if (!res.ok || !res.body) throw new Error(`Could not download bulk results (${res.status})`);
    let batch: SnapshotRow[] = [];
    for await (const line of lines(res.body)) {
      const node = JSON.parse(line) as VariantNode & { __parentId?: string };
      if (node.__parentId || !node.id?.includes("ProductVariant")) continue;
      batch.push(nodeToSnapshot(shopId, node, scanId));
      total++;
      if (batch.length >= BATCH) {
        await writeBatch(db, shopId, batch);
        batch = [];
      }
    }
    await writeBatch(db, shopId, batch);
  }
  // Variants deleted in Shopify: not in this scan and not touched by the guard since the scan began.
  await db.variantSnapshot.deleteMany({
    where: { shopId, OR: [{ scanId: { not: scanId } }, { scanId: null }], updatedAt: { lt: scan.startedAt } },
  });
  const r = await reevaluateShop(db, shopId, { source: "scan" });
  await db.scan.update({
    where: { id: scanId },
    data: { status: "complete", finishedAt: new Date(), variantsTotal: total, variantsInScope: r.inScope, error: null },
  });
  log.info("scan_complete", { shopId, scanId, total, inScope: r.inScope, ready: r.ready });
  return { total, ...r };
}

/** Polling fallback for a lost bulk_operations/finish webhook. */
export async function pollScan(db: PrismaClient, gql: Gql, shopId: string) {
  const scan = await db.scan.findFirst({ where: { shopId, status: "running" }, orderBy: { startedAt: "desc" } });
  if (!scan?.bulkOpId) return null;
  return onBulkFinish(db, gql, shopId, scan.bulkOpId);
}

/** E-12: cancel a running bulk operation on uninstall. */
export async function cancelScans(db: PrismaClient, gql: Gql | null, shopId: string) {
  const running = await db.scan.findMany({ where: { shopId, status: { in: ["queued", "running"] } } });
  for (const s of running) {
    if (gql && s.bulkOpId) await gql(BULK_CANCEL, { id: s.bulkOpId }).catch(() => undefined);
    await db.scan.update({ where: { id: s.id }, data: { status: "failed", error: "App uninstalled", finishedAt: new Date() } });
  }
}

export async function latestScan(db: PrismaClient, shopId: string) {
  return db.scan.findFirst({ where: { shopId }, orderBy: { startedAt: "desc" } });
}

export async function lastGoodScan(db: PrismaClient, shopId: string) {
  return db.scan.findFirst({ where: { shopId, status: "complete" }, orderBy: { finishedAt: "desc" } });
}
