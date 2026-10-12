// UC-15 / FR-14: server-side billing gate for fixing actions. Never trusts a client flag.
import prisma from "../db.server";
import { gateFix, gateSupplierRequest, type GateResult, type PlanId } from "./plans";
import { activeRequestCount } from "./supplier.server";

export async function checkFixGate(shopId: string, plan: PlanId, variantIds: string[] = []): Promise<GateResult> {
  const inScope = await prisma.variantSnapshot.count({ where: { shopId, inScope: true } });
  const first = gateFix(plan, inScope);
  if (first.ok || first.reason !== "variant_cap" || !variantIds.length) return first;
  // Over the cap: variants the app already fixed stay fixable (Section 10).
  const fixed = await prisma.auditLog.findMany({
    where: { shopId, variantId: { in: variantIds } },
    distinct: ["variantId"],
    select: { variantId: true },
  });
  return fixed.length === variantIds.length ? { ok: true } : first;
}

export async function checkSupplierGate(shopId: string, plan: PlanId) {
  return gateSupplierRequest(plan, await activeRequestCount(prisma, shopId));
}

export function upgradeResponse(g: Exclude<GateResult, { ok: true }>, next: string) {
  return { upgrade: { reason: g.reason, needed: g.needed, next } };
}
