// In-process worker: runs queued jobs, polls scans whose finish webhook never arrived,
// and purges old webhook ids. One loop per server process; jobs are claimed atomically
// so several processes can run side by side.
import prisma from "../db.server";
import { gqlForShop as offlineGql } from "./context.server";
import { claimJobs, requeueStale, runJob } from "./jobs.server";
import { pollScan, queueEuSync } from "./scan.server";
import { log } from "./log.server";

declare global {
  // eslint-disable-next-line no-var
  var __pidWorker: ReturnType<typeof setInterval> | undefined;
}

const TICK_MS = 2000;
let busy = false;
let ticks = 0;

async function tick() {
  if (busy) return;
  busy = true;
  try {
    ticks++;
    if (ticks % 30 === 1) await requeueStale(prisma);

    const jobs = await claimJobs(prisma);
    for (const job of jobs) {
      const shop = await prisma.shop.findUnique({ where: { id: job.shopId } });
      if (!shop) continue;
      offlineGql(shop.domain)
        .then((gql) => runJob(prisma, gql, job.id))
        .catch(async (e) => {
          log.error("job_error", { shopId: job.shopId, jobId: job.id, err: String(e) });
          await prisma.job.update({ where: { id: job.id }, data: { status: "failed" } }).catch(() => undefined);
        });
    }

    // Polling fallback for bulk_operations/finish (every ~30 s).
    if (ticks % 15 === 0) {
      const stale = await prisma.scan.findMany({
        where: { status: "running", startedAt: { lt: new Date(Date.now() - 60_000) } },
        include: { shop: true },
        take: 20,
      });
      for (const s of stale) {
        offlineGql(s.shop.domain)
          .then((gql) => pollScan(prisma, gql, s.shopId))
          .catch((e) => log.warn("scan_poll_failed", { shopId: s.shopId, err: String(e) }));
      }
    }

    // EU orders: refresh once a day per active shop (every ~30 min we check who is due).
    if (ticks % 900 === 450) {
      const due = await prisma.shop.findMany({
        where: {
          active: true,
          euSyncStatus: { in: ["ok", "failed"] },
          OR: [{ euSyncedAt: null }, { euSyncedAt: { lt: new Date(Date.now() - 86_400_000) } }],
        },
        select: { id: true },
        take: 50,
      });
      for (const s of due) await queueEuSync(prisma, s.id);
    }

    // Webhook idempotency rows: purge after 7 days.
    if (ticks % 1800 === 0) {
      await prisma.webhookEvent.deleteMany({ where: { receivedAt: { lt: new Date(Date.now() - 7 * 86_400_000) } } });
    }
  } catch (e) {
    log.error("worker_tick_error", { err: String(e) });
  } finally {
    busy = false;
  }
}

export function startWorker() {
  if (process.env.DISABLE_WORKER === "1" || global.__pidWorker) return;
  global.__pidWorker = setInterval(tick, TICK_MS);
  log.info("worker_started");
}
