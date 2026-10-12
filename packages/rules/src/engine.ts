// PRD Section 9 — the validation engine. Pure: no Shopify, no DOM, no I/O (FR-01).
import {
  hasValidCheckDigit,
  isIsbn10,
  isbn10To13,
  isValidGtin,
  normalizeBarcode,
  suggestLeadingZero,
  GTIN_LENGTHS,
} from "./gtin.js";
import { RULES } from "./messages.js";
import { buildPlaceholderSet, isPlaceholder, REPEAT_PLACEHOLDER_THRESHOLD } from "./placeholders.js";
import type { EvaluateResult, Issue, RuleCode, RuleSettings, VariantInput, VariantResult } from "./types.js";
import { DEFAULT_SETTINGS } from "./types.js";

const NSPID_MAX = 70; // D-03
const CONTROL_CHARS = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}]/u; // D-03 "printable characters only"
const NON_LATIN = /[^ -ɏ]/; // E-16: outside Basic Latin … Latin Extended-B

// ---------- scope (D-01, E-07, E-08) ----------

export function isInScope(v: VariantInput, settings: Pick<RuleSettings, "includeDraft">): boolean {
  if (v.isGiftCard || !v.requiresShipping) return false;
  if (v.status === "ACTIVE") return true;
  if (v.status === "DRAFT") return settings.includeDraft;
  return false; // ARCHIVED always out
}

// ---------- cross-variant index (R-MPID-02, R-SPID-06, D-07 repeated values) ----------

export type CrossIndex = {
  /** sku → in-scope variant ids using it */
  skuVariants: Map<string, Set<string>>;
  /** sku → product ids using it */
  skuProducts: Map<string, Set<string>>;
  /** nspid → product ids using it */
  nspidProducts: Map<string, Set<string>>;
  /** normalized barcode → product ids using it */
  barcodeProducts: Map<string, Set<string>>;
};

function add(map: Map<string, Set<string>>, key: string, value: string) {
  let s = map.get(key);
  if (!s) map.set(key, (s = new Set()));
  s.add(value);
}

/**
 * Build the cross-variant index from the full in-scope catalogue.
 * Guard path (UC-12): build this from variant_snapshots with the changed
 * variants swapped in, then call evaluate(changed, settings, { index }).
 */
export function buildIndex(all: VariantInput[], settings: RuleSettings = DEFAULT_SETTINGS): CrossIndex {
  const idx: CrossIndex = {
    skuVariants: new Map(),
    skuProducts: new Map(),
    nspidProducts: new Map(),
    barcodeProducts: new Map(),
  };
  for (const v of all) {
    if (!isInScope(v, settings)) continue;
    const sku = (v.sku ?? "").trim();
    if (sku) {
      add(idx.skuVariants, sku, v.id);
      add(idx.skuProducts, sku, v.productId);
    }
    const nspid = (v.nspid ?? "").trim();
    if (nspid) add(idx.nspidProducts, nspid, v.productId);
    for (const raw of v.barcodes) {
      const b = normalizeBarcode(raw);
      if (b) add(idx.barcodeProducts, b, v.productId);
    }
  }
  return idx;
}

function repeatedAcrossProducts(map: Map<string, Set<string>>, key: string): boolean {
  return (map.get(key)?.size ?? 0) > REPEAT_PLACEHOLDER_THRESHOLD;
}

// ---------- evaluation ----------

export type EvaluateOptions = {
  /** Precomputed index (guard path). If omitted, built from `variants`. */
  index?: CrossIndex;
};

export function evaluate(
  variants: VariantInput[],
  settingsIn: Partial<RuleSettings> = {},
  options: EvaluateOptions = {},
): EvaluateResult {
  const settings: RuleSettings = { ...DEFAULT_SETTINGS, ...settingsIn };
  const placeholders = buildPlaceholderSet(settings.extraPlaceholders);
  const ownBrand = new Set(settings.ownBrandVendors.map((v) => v.trim().toLowerCase()));
  const skip = new Set(settings.skipRules ?? []);
  const index = options.index ?? buildIndex(variants, settings);

  const issues: Issue[] = [];
  const results: VariantResult[] = [];
  let inScope = 0;
  let ready = 0;
  let outOfScope = 0;

  for (const v of variants) {
    if (!isInScope(v, settings)) {
      outOfScope++;
      results.push({ variantId: v.id, inScope: false, ready: false, spid: null, spidException: null, otherBarcodes: [] });
      continue;
    }
    inScope++;
    const own: Issue[] = [];
    const push = (code: RuleCode, extra: { n?: number; suggestion?: string; severity?: Issue["severity"] } = {}) => {
      if (skip.has(code)) return;
      const rule = RULES[code];
      own.push({
        variantId: v.id,
        code,
        severity: extra.severity ?? rule.severity,
        message: rule.message.replace("{n}", String(extra.n ?? "")),
        ...(extra.suggestion ? { suggestion: extra.suggestion } : {}),
      });
    };

    // --- M-PID (D-02) ---
    const sku = (v.sku ?? "").trim();
    if (!sku || isPlaceholder(sku, placeholders) || repeatedAcrossProducts(index.skuProducts, sku)) {
      push("R-MPID-01");
    } else {
      const users = index.skuVariants.get(sku);
      const others = users ? users.size - (users.has(v.id) ? 1 : 0) : 0;
      if (others > 0) push("R-MPID-02", { n: others });
    }

    // --- NS-PID (D-03, D-09) ---
    const nspid = (v.nspid ?? "").trim();
    if (!nspid || isPlaceholder(nspid, placeholders) || repeatedAcrossProducts(index.nspidProducts, nspid)) {
      push("R-NSPID-01");
    } else {
      if (nspid.length > NSPID_MAX || CONTROL_CHARS.test(nspid)) push("R-NSPID-04");
      else if (NON_LATIN.test(nspid)) push("R-NSPID-05");
      if (sku && nspid.toLowerCase() === sku.toLowerCase()) {
        push(ownBrand.has(v.vendor.trim().toLowerCase()) ? "R-NSPID-03" : "R-NSPID-02");
      }
    }

    // --- S-PID (D-04, D-05, D-06, E-01..E-04) ---
    const normalized = v.barcodes.map(normalizeBarcode).filter(Boolean);
    const isFake = (b: string) =>
      isPlaceholder(b, placeholders) ||
      repeatedAcrossProducts(index.barcodeProducts, b) ||
      (sku !== "" && b.toLowerCase() === normalizeBarcode(sku).toLowerCase());
    const real = normalized.filter((b) => !isFake(b));
    const fakes = normalized.filter(isFake);

    let spid: string | null = null;
    let spidException: "Y081" | null = null;

    if (real.length === 0) {
      if (v.noStandardIdentifier) {
        spidException = "Y081"; // D-05
      } else if (fakes.length > 0) {
        push("R-SPID-04");
      } else {
        push("R-SPID-01");
      }
    } else {
      if (v.noStandardIdentifier) push("R-SPID-07");
      spid = real.find(isValidGtin) ?? null; // E-03: first valid wins
      if (!spid) {
        const first = real[0]!;
        if (isIsbn10(first)) {
          push("R-SPID-02", { suggestion: isbn10To13(first) }); // E-04
        } else if (/[^0-9]/.test(first)) {
          push("R-SPID-05");
        } else if (!(GTIN_LENGTHS as readonly number[]).includes(first.length)) {
          const fix = suggestLeadingZero(first); // E-01
          push("R-SPID-02", fix ? { suggestion: fix } : {});
        } else if (!hasValidCheckDigit(first)) {
          push("R-SPID-03");
        }
      } else {
        const products = index.barcodeProducts.get(spid);
        if (products && products.size > 1) push("R-SPID-06");
      }
    }

    // --- customs data (D-08) ---
    const secondary = settings.hsAsError ? "error" : "warning";
    const hs = (v.hsCode ?? "").trim();
    if (!hs || isPlaceholder(hs, placeholders)) {
      push("R-HS-01", { severity: secondary });
    } else if (!/^\d{6,10}$/.test(hs.replace(/[\s.]/g, ""))) {
      push("R-HS-02");
    }
    const coo = (v.countryOfOrigin ?? "").trim();
    if (!coo || isPlaceholder(coo, placeholders)) push("R-COO-01", { severity: secondary });

    const isReady = !own.some((i) => i.severity === "error");
    if (isReady) ready++;
    issues.push(...own);
    results.push({
      variantId: v.id,
      inScope: true,
      ready: isReady,
      spid,
      spidException,
      // show the other values as the merchant stored them (E-03)
      otherBarcodes: v.barcodes
        .map((b) => b.trim())
        .filter((b) => b && (!spid || normalizeBarcode(b) !== spid)),
    });
  }

  return { inScope, ready, outOfScope, issues, results };
}

/** UC-02: ready ÷ in-scope, whole percent. Null when nothing is in scope (A2). */
export function readinessScore(r: Pick<EvaluateResult, "inScope" | "ready">): number | null {
  return r.inScope === 0 ? null : Math.round((r.ready / r.inScope) * 100);
}
