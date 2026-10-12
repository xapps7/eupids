// Section 10 — plans. Prices are hypotheses (Q-06). Shared by server and UI.
export type PlanId = "free" | "starter" | "growth" | "scale";

export const PLANS = [
  { id: "free" as PlanId, name: "Free", price: 0, cap: Infinity, supplierRequests: 0, features: ["Scan and dashboard", "See every issue", "Readiness report export"] },
  { id: "starter" as PlanId, name: "Starter", price: 9, cap: 1000, supplierRequests: 3, features: ["Up to 1,000 variants", "Inline fixes and bulk actions", "CSV apply", "3 active supplier requests"] },
  { id: "growth" as PlanId, name: "Growth", price: 19, cap: 10000, supplierRequests: Infinity, features: ["Up to 10,000 variants", "Unlimited supplier requests", "Weekly readiness email"] },
  { id: "scale" as PlanId, name: "Scale", price: 39, cap: Infinity, supplierRequests: Infinity, features: ["Unlimited variants", "Priority support"] },
] as const;

export function planById(id: string) {
  return PLANS.find((p) => p.id === id) ?? PLANS[0];
}

export function planByName(name: string) {
  return PLANS.find((p) => p.name.toLowerCase() === name.toLowerCase());
}

export type GateResult = { ok: true } | { ok: false; reason: "free_plan" | "variant_cap" | "supplier_cap"; needed: PlanId };

/**
 * UC-15 / FR-14: only fixing is gated. Scanning and viewing are always free.
 * Over the cap, variants already fixed stay fixable (Section 10).
 */
export function gateFix(plan: PlanId, inScopeVariants: number, opts: { variantAlreadyFixed?: boolean } = {}): GateResult {
  if (plan === "free") return { ok: false, reason: "free_plan", needed: inScopeVariants <= 1000 ? "starter" : inScopeVariants <= 10000 ? "growth" : "scale" };
  const p = planById(plan);
  if (inScopeVariants > p.cap && !opts.variantAlreadyFixed) {
    return { ok: false, reason: "variant_cap", needed: inScopeVariants <= 10000 ? "growth" : "scale" };
  }
  return { ok: true };
}

export function gateSupplierRequest(plan: PlanId, activeRequests: number): GateResult {
  const p = planById(plan);
  if (plan === "free") return { ok: false, reason: "free_plan", needed: "starter" };
  if (activeRequests >= p.supplierRequests) return { ok: false, reason: "supplier_cap", needed: "growth" };
  return { ok: true };
}
