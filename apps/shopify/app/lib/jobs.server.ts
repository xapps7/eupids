// FR-08: bulk actions as background jobs — batches of 25, progress, retry on throttle
// (inside the Gql client), at most 2 running jobs per shop, resumable after a crash.
import type { Job, PrismaClient } from "@prisma/client";
import type { Gql } from "./gql.server";
import { publishCodes, applyChanges, type WriteItem } from "./writes.server";
import { syncEuShipping } from "./eu-shipping.server";
import { reevaluateShop } from "./evaluate.server";
import { log } from "./log.server";

export const BATCH = 25;
export const MAX_RUNNING_PER_SHOP = 2;

export type JobType = "no_barcode_bulk" | "csv_apply" | "supplier_apply" | "barcode_sync" | "eu_sync";

export type NoBarcodePayload = { variantIds: string[] };
export type CsvApplyPayload = { items: WriteItem[]; fileName?: string };
export type SupplierApplyPayload = { requestId: string; submissionIds: string[] };
export type BarcodeSyncPayload = { variantIds: string[]; flavorcloud?: boolean };

export type Failure = { variantId: string; status: string; errors: Record<string, string> };

export async function enqueue(db: PrismaClient, shopId: string, type: JobType, payload: unknown, actor: string, total: number) {
  return db.job.create({ data: { shopId, type, payload: payload as any, actor, total } });
}

/** Resolve the items a job writes. Supplier jobs read submissions at run time (E-11). */
async function itemsFor(db: PrismaClient, job: Job): Promise<WriteItem[]> {
  switch (job.type as JobType) {
    case "barcode_sync":
    case "eu_sync":
      return [];
    case "no_barcode_bulk":
      return (job.payload as NoBarcodePayload).variantIds.map((variantId) => ({ variantId, changes: { noStandardIdentifier: true } }));
    case "csv_apply":
      return (job.payload as CsvApplyPayload).items;
    case "supplier_apply": {
      const p = job.payload as SupplierApplyPayload;
      const subs = await db.supplierSubmission.findMany({
        where: { id: { in: p.submissionIds }, requestId: p.requestId, request: { shopId: job.shopId } },
      });
      return subs.map((s) => ({
        variantId: s.variantId,
        changes: {
          ...(s.nspid ? { nspid: s.nspid } : {}),
          ...(s.barcode ? { barcode: s.barcode } : {}),
          ...(s.noBarcode && !s.barcode ? { noStandardIdentifier: true } : {}),
        },
      }));
    }
  }
}

export async function runJob(db: PrismaClient, gql: Gql, jobId: string) {
  const job = await db.job.findUniqueOrThrow({ where: { id: jobId } });
  const shop = await db.shop.findUnique({ where: { id: job.shopId } });
  if (!shop?.active) {
    // E-12: uninstalled — no further writes.
    await db.job.update({ where: { id: job.id }, data: { status: "failed" } });
    return;
  }
  if (job.type === "eu_sync") {
    const r = await syncEuShipping(db, gql, job.shopId);
    await db.job.update({ where: { id: job.id }, data: { status: r.ok ? "complete" : "failed", done: 1, total: 1 } });
    return;
  }
  const items = await itemsFor(db, job);
  const syncIds = job.type === "barcode_sync" ? (job.payload as BarcodeSyncPayload).variantIds : null;
  const count = syncIds ? syncIds.length : items.length;
  const failures: Failure[] = Array.isArray(job.failures) ? (job.failures as Failure[]) : [];
  let done = job.done;
  let failed = job.failed;
  const actor = job.actor;
  const perField = job.type !== "no_barcode_bulk";

  // Resume from where a crashed run stopped; re-applying is safe because only diffs are written.
  for (let i = done; i < count; i += BATCH) {
    const still = await db.shop.findUnique({ where: { id: job.shopId }, select: { active: true } });
    if (!still?.active) {
      await db.job.update({ where: { id: job.id }, data: { status: "failed" } });
      return;
    }
    const batchLen = Math.min(BATCH, count - i);
    const outcomes = syncIds
      ? await publishCodes(db, gql, { shopId: job.shopId, actor }, syncIds.slice(i, i + BATCH), {
          flavorcloud: !!(job.payload as BarcodeSyncPayload).flavorcloud,
        })
      : await applyChanges(
          db,
          gql,
          { shopId: job.shopId, actor, auditAction: job.type },
          items.slice(i, i + BATCH),
          { reevaluate: false, audit: perField ? "per-field" : "none" },
        );
    for (const o of outcomes) {
      const hasErr = o.status === "conflict" || o.status === "missing" || o.status === "error" || Object.keys(o.errors).length > 0;
      if (hasErr) {
        failed++;
        failures.push({ variantId: o.variantId, status: o.status, errors: o.errors as Record<string, string> });
      }
    }
    done = Math.min(count, i + batchLen);
    await db.job.update({ where: { id: job.id }, data: { done, failed, failures: failures as any } });
  }

  if (job.type === "supplier_apply") {
    const p = job.payload as SupplierApplyPayload;
    const failedIds = new Set(failures.map((f) => f.variantId));
    const subs = await db.supplierSubmission.findMany({ where: { id: { in: p.submissionIds } } });
    const ok = subs.filter((s) => !failedIds.has(s.variantId)).map((s) => s.id);
    if (ok.length) await db.supplierSubmission.updateMany({ where: { id: { in: ok } }, data: { reviewStatus: "approved", reviewedAt: new Date() } });
  }

  await db.auditLog.create({
    data: { shopId: job.shopId, actor, action: `${job.type}_done`, count: done - failed },
  });
  await reevaluateShop(db, job.shopId, { source: "write" });
  await db.job.update({ where: { id: job.id }, data: { status: "complete", done, failed, failures: failures as any } });
  log.info("job_complete", { shopId: job.shopId, jobId: job.id, type: job.type, done, failed });
}

/** Claim runnable jobs, respecting the per-shop limit. Atomic claim via conditional update. */
export async function claimJobs(db: PrismaClient, limit = 10): Promise<Job[]> {
  const queued = await db.job.findMany({ where: { status: "queued" }, orderBy: { createdAt: "asc" }, take: 50 });
  const claimed: Job[] = [];
  for (const j of queued) {
    if (claimed.length >= limit) break;
    const running = await db.job.count({ where: { shopId: j.shopId, status: "running" } });
    if (running >= MAX_RUNNING_PER_SHOP) continue;
    const r = await db.job.updateMany({ where: { id: j.id, status: "queued" }, data: { status: "running" } });
    if (r.count === 1) claimed.push({ ...j, status: "running" });
  }
  return claimed;
}

/** Crash recovery: jobs left "running" by a dead process go back to the queue and resume. */
export async function requeueStale(db: PrismaClient, olderThanMs = 120_000) {
  const cutoff = new Date(Date.now() - olderThanMs);
  return db.job.updateMany({ where: { status: "running", updatedAt: { lt: cutoff } }, data: { status: "queued" } });
}
