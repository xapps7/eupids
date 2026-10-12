// Shared summary math for the checker and the app dashboard (UC-02 counts).
import { readinessScore } from "./engine.js";
import type { EvaluateResult, Issue } from "./types.js";

export type IdCounts = { missing: number; invalid: number; ok: number };

export type Summary = {
  score: number | null;
  inScope: number;
  ready: number;
  outOfScope: number;
  mpid: IdCounts;
  nspid: IdCounts;
  spid: IdCounts;
  errorVariants: number;
  byRule: { code: string; severity: Issue["severity"]; message: string; variants: number }[];
  topVendorsMissingNspid: { vendor: string; count: number }[];
};

const MPID_MISSING = new Set(["R-MPID-01"]);
const MPID_INVALID = new Set(["R-MPID-02"]);
const NSPID_MISSING = new Set(["R-NSPID-01"]);
const NSPID_INVALID = new Set(["R-NSPID-04"]);
const SPID_MISSING = new Set(["R-SPID-01"]);
const SPID_INVALID = new Set(["R-SPID-02", "R-SPID-03", "R-SPID-04", "R-SPID-05"]);

export function summarize(result: EvaluateResult, vendorOf: (variantId: string) => string): Summary {
  const byVariant = new Map<string, Set<string>>();
  for (const i of result.issues) {
    let s = byVariant.get(i.variantId);
    if (!s) byVariant.set(i.variantId, (s = new Set()));
    s.add(i.code);
  }
  const count = (missing: Set<string>, invalid: Set<string>): IdCounts => {
    let m = 0;
    let inv = 0;
    for (const codes of byVariant.values()) {
      if ([...codes].some((c) => missing.has(c))) m++;
      else if ([...codes].some((c) => invalid.has(c))) inv++;
    }
    return { missing: m, invalid: inv, ok: result.inScope - m - inv };
  };

  const rules = new Map<string, { severity: Issue["severity"]; message: string; variants: Set<string> }>();
  for (const i of result.issues) {
    let r = rules.get(i.code);
    if (!r) rules.set(i.code, (r = { severity: i.severity, message: i.message.replace(/used by \d+ other/, "used by other"), variants: new Set() }));
    r.variants.add(i.variantId);
  }
  const sevOrder = { error: 0, warning: 1, info: 2 } as const;
  const byRule = [...rules.entries()]
    .map(([code, r]) => ({ code, severity: r.severity, message: r.message, variants: r.variants.size }))
    .sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity] || b.variants - a.variants);

  const vendors = new Map<string, number>();
  for (const [id, codes] of byVariant) {
    if (codes.has("R-NSPID-01")) {
      const v = vendorOf(id) || "(no vendor)";
      vendors.set(v, (vendors.get(v) ?? 0) + 1);
    }
  }
  const topVendorsMissingNspid = [...vendors.entries()]
    .map(([vendor, count]) => ({ vendor, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const errorVariants = new Set(result.issues.filter((i) => i.severity === "error").map((i) => i.variantId)).size;

  return {
    score: readinessScore(result),
    inScope: result.inScope,
    ready: result.ready,
    outOfScope: result.outOfScope,
    mpid: count(MPID_MISSING, MPID_INVALID),
    nspid: count(NSPID_MISSING, NSPID_INVALID),
    spid: count(SPID_MISSING, SPID_INVALID),
    errorVariants,
    byRule,
    topVendorsMissingNspid,
  };
}

/** UC-02 (d): whole days left until enforcement, or null once enforced. */
export function daysUntilEnforcement(now: Date = new Date()): number | null {
  const deadline = Date.UTC(2026, 10, 1); // 1 Nov 2026
  const ms = deadline - now.getTime();
  return ms <= 0 ? null : Math.ceil(ms / 86_400_000);
}
