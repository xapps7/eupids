// FR-03 / FR-04 / UC-10: evaluate stored snapshots and sync the issues table.
// We always re-evaluate the whole shop: cross-variant rules (duplicate SKUs,
// shared barcodes, repeated placeholders) mean one edit can resolve or create
// issues on other variants. 20,000 variants evaluate in well under a second.
import type { PrismaClient, Settings } from "@prisma/client";
import { evaluate, summarize, type EvaluateResult, type Issue as EngineIssue, type RuleSettings } from "@pidready/rules";
import { snapshotToInput } from "./snapshot";

export function toRuleSettings(s: Settings | null): Partial<RuleSettings> {
  if (!s) return {};
  return {
    includeDraft: s.includeDraft,
    ownBrandVendors: s.ownBrandVendors,
    extraPlaceholders: s.extraPlaceholders,
    hsAsError: s.hsAsError,
  };
}

const key = (variantId: string, code: string) => `${variantId}\u0000${code}`;
const chunk = <T,>(arr: T[], n: number) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

export type ReevaluateResult = { inScope: number; ready: number; opened: number; resolved: number; regressed: number };

export async function reevaluateShop(
  db: PrismaClient,
  shopId: string,
  opts: { source?: "scan" | "guard" | "settings" | "write" } = {},
): Promise<ReevaluateResult> {
  const [settings, snapshots, existing] = await Promise.all([
    db.settings.findUnique({ where: { shopId } }),
    db.variantSnapshot.findMany({ where: { shopId } }),
    db.issue.findMany({ where: { shopId } }),
  ]);

  const result = evaluate(snapshots.map(snapshotToInput), toRuleSettings(settings));

  const desired = new Map<string, EngineIssue>();
  for (const i of result.issues) desired.set(key(i.variantId, i.code), i);
  const have = new Map(existing.map((e) => [key(e.variantId, e.ruleCode), e]));

  const toCreate: EngineIssue[] = [];
  const toUpdate: { id: string; i: EngineIssue }[] = [];
  const toResolve: string[] = [];
  for (const [k, i] of desired) {
    const e = have.get(k);
    if (!e) toCreate.push(i);
    else if (e.status !== "open" || e.message !== i.message || e.severity !== i.severity || (e.suggestion ?? null) !== (i.suggestion ?? null))
      toUpdate.push({ id: e.id, i });
  }
  for (const [k, e] of have) if (e.status === "open" && !desired.has(k)) toResolve.push(e.id);

  const now = new Date();
  const ops = [
    ...chunk(toCreate, 1000).map((c) =>
      db.issue.createMany({
        data: c.map((i) => ({
          shopId,
          variantId: i.variantId,
          ruleCode: i.code,
          severity: i.severity,
          message: i.message,
          suggestion: i.suggestion ?? null,
        })),
        skipDuplicates: true,
      }),
    ),
    ...toUpdate.map(({ id, i }) =>
      db.issue.update({
        where: { id },
        data: { status: "open", resolvedAt: null, message: i.message, severity: i.severity, suggestion: i.suggestion ?? null },
      }),
    ),
    ...chunk(toResolve, 5000).map((ids) =>
      db.issue.updateMany({ where: { shopId, id: { in: ids } }, data: { status: "resolved", resolvedAt: now } }),
    ),
  ];

  // Snapshot readiness flags (for fast dashboard counts and guard regressions).
  const wasReady = new Set(snapshots.filter((s) => s.ready).map((s) => s.variantId));
  const byFlag = new Map<string, string[]>();
  let regressed = 0;
  for (const r of result.results) {
    const flag = `${r.inScope}|${r.ready}`;
    if (!byFlag.has(flag)) byFlag.set(flag, []);
    byFlag.get(flag)!.push(r.variantId);
    if (wasReady.has(r.variantId) && r.inScope && !r.ready) regressed++;
  }
  for (const [flag, ids] of byFlag) {
    const [inScope, ready] = flag.split("|").map((x) => x === "true");
    for (const c of chunk(ids, 5000))
      ops.push(db.variantSnapshot.updateMany({ where: { shopId, variantId: { in: c } }, data: { inScope, ready } }));
  }
  if (opts.source === "guard" && regressed > 0) {
    ops.push(db.shop.update({ where: { id: shopId }, data: { guardAlert: true } }) as any);
  }

  await db.$transaction(ops as any);
  return { inScope: result.inScope, ready: result.ready, opened: toCreate.length, resolved: toResolve.length, regressed };
}

/** UC-02 / AT-03: dashboard numbers come from the issues table and snapshots, so they match to the unit. */
export async function dashboardSummary(db: PrismaClient, shopId: string) {
  const [inScope, ready, outOfScope, open, snaps] = await Promise.all([
    db.variantSnapshot.count({ where: { shopId, inScope: true } }),
    db.variantSnapshot.count({ where: { shopId, inScope: true, ready: true } }),
    db.variantSnapshot.count({ where: { shopId, inScope: false } }),
    db.issue.findMany({
      where: { shopId, status: "open" },
      select: { variantId: true, ruleCode: true, severity: true, message: true },
    }),
    db.variantSnapshot.findMany({ where: { shopId, inScope: true }, select: { variantId: true, vendor: true } }),
  ]);
  const vendor = new Map(snaps.map((s) => [s.variantId, s.vendor]));
  const pseudo: EvaluateResult = {
    inScope,
    ready,
    outOfScope,
    results: [],
    issues: open.map((o) => ({
      variantId: o.variantId,
      code: o.ruleCode as EngineIssue["code"],
      severity: o.severity as EngineIssue["severity"],
      message: o.message,
    })),
  };
  return summarize(pseudo, (id) => vendor.get(id) ?? "");
}
