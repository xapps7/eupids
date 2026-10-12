// AT-01: one passing and one failing case per rule code in Section 9, plus scope and edge cases.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { evaluate, buildIndex, readinessScore, type VariantInput, type RuleCode } from "../src/index.js";

let n = 0;
function v(over: Partial<VariantInput> = {}): VariantInput {
  n++;
  return {
    id: `gid://shopify/ProductVariant/${n}`,
    productId: `gid://shopify/Product/${n}`,
    vendor: "Acme Textiles",
    status: "ACTIVE",
    requiresShipping: true,
    isGiftCard: false,
    sku: `SKU-${n}`,
    barcodes: ["5901234123457"].map((b) => b), // replaced below when uniqueness matters
    nspid: `MFR-${n}`,
    noStandardIdentifier: false,
    hsCode: "630221",
    countryOfOrigin: "IN",
    ...over,
  };
}

/** A fully valid variant with a unique valid barcode. */
function good(over: Partial<VariantInput> = {}): VariantInput {
  const base = v();
  const body = String(100000000000 + n).padStart(12, "0");
  // compute EAN-13 check digit
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(body[11 - i]) * (i % 2 === 0 ? 3 : 1);
  const ean = body + ((10 - (sum % 10)) % 10);
  return { ...base, barcodes: [ean], ...over };
}

function codes(variants: VariantInput[], settings = {}, only?: string): RuleCode[] {
  const r = evaluate(variants, settings);
  return r.issues.filter((i) => !only || i.variantId === only).map((i) => i.code);
}

describe("baseline", () => {
  test("a complete variant has zero issues and is ready", () => {
    const x = good();
    const r = evaluate([x]);
    assert.deepEqual(r.issues, []);
    assert.equal(r.ready, 1);
    assert.equal(readinessScore(r), 100);
  });
});

describe("scope D-01 / E-07 / E-08", () => {
  test("gift card, no-shipping, archived and draft are out of scope and never flagged", () => {
    const vs = [
      good({ isGiftCard: true, sku: null }),
      good({ requiresShipping: false, sku: null }),
      good({ status: "ARCHIVED", sku: null }),
      good({ status: "DRAFT", sku: null }),
    ];
    const r = evaluate(vs);
    assert.equal(r.inScope, 0);
    assert.equal(r.outOfScope, 4);
    assert.equal(r.issues.length, 0);
    assert.equal(readinessScore(r), null);
  });
  test("draft is in scope when includeDraft is on; archived never", () => {
    const d = good({ status: "DRAFT", sku: null });
    const a = good({ status: "ARCHIVED", sku: null });
    const r = evaluate([d, a], { includeDraft: true });
    assert.equal(r.inScope, 1);
    assert.deepEqual(r.issues.map((i) => i.code), ["R-MPID-01"]);
  });
});

describe("M-PID", () => {
  test("R-MPID-01 fails on empty and placeholder, passes on real SKU", () => {
    const a = good({ sku: "" });
    const b = good({ sku: "  N/A " });
    const c = good();
    assert.ok(codes([a]).includes("R-MPID-01"));
    assert.ok(codes([b]).includes("R-MPID-01"));
    assert.ok(!codes([c]).includes("R-MPID-01"));
  });
  test("R-MPID-02 flags shared SKUs with the other-variant count", () => {
    const a = good({ sku: "DUP" });
    const b = good({ sku: "DUP" });
    const c = good({ sku: "DUP" });
    const r = evaluate([a, b, c]);
    const i = r.issues.filter((x) => x.code === "R-MPID-02");
    assert.equal(i.length, 3);
    assert.match(i[0]!.message, /used by 2 other variants/);
    assert.ok(!codes([good({ sku: "UNIQUE-1" }), good({ sku: "UNIQUE-2" })]).includes("R-MPID-02"));
  });
  test("SKU shared with an out-of-scope variant is not a duplicate", () => {
    const a = good({ sku: "S1" });
    const b = good({ sku: "S1", status: "ARCHIVED" });
    assert.ok(!codes([a, b]).includes("R-MPID-02"));
  });
});

describe("NS-PID", () => {
  test("R-NSPID-01 fails on empty/placeholder, passes on a real code", () => {
    assert.ok(codes([good({ nspid: null })]).includes("R-NSPID-01"));
    assert.ok(codes([good({ nspid: "TBD" })]).includes("R-NSPID-01"));
    assert.ok(!codes([good({ nspid: "HT-4402-B" })]).includes("R-NSPID-01"));
  });
  test("R-NSPID-02 warns when NS-PID equals SKU for a non-own-brand vendor", () => {
    const x = good({ sku: "ABC-1", nspid: "abc-1" });
    const r = evaluate([x]);
    const i = r.issues.find((y) => y.code === "R-NSPID-02");
    assert.equal(i?.severity, "warning");
    assert.equal(r.ready, 1, "warning does not block ready");
    assert.ok(!codes([good({ sku: "ABC-2", nspid: "MFR-9" })]).includes("R-NSPID-02"));
  });
  test("R-NSPID-03 info for own-brand vendor (D-09)", () => {
    const x = good({ vendor: "My Brand", sku: "MB-1", nspid: "MB-1" });
    const c = codes([x], { ownBrandVendors: ["my brand"] });
    assert.ok(c.includes("R-NSPID-03"));
    assert.ok(!c.includes("R-NSPID-02"));
    assert.ok(!codes([good({ vendor: "My Brand", sku: "MB-2", nspid: "F-2" })], { ownBrandVendors: ["My Brand"] }).includes("R-NSPID-03"));
  });
  test("R-NSPID-04 fails on >70 chars or control chars; 70 chars passes", () => {
    assert.ok(codes([good({ nspid: "A".repeat(71) })]).includes("R-NSPID-04"));
    assert.ok(codes([good({ nspid: "AB\u0007C" })]).includes("R-NSPID-04"));
    assert.ok(!codes([good({ nspid: "A".repeat(70) })]).includes("R-NSPID-04"));
  });
  test("R-NSPID-05 (E-16) accepts non-Latin with a warning", () => {
    const r = evaluate([good({ nspid: "型号-300" })]);
    assert.deepEqual(r.issues.map((i) => i.code), ["R-NSPID-05"]);
    assert.equal(r.ready, 1);
    assert.ok(!codes([good({ nspid: "Modèle-300" })]).includes("R-NSPID-05"));
  });
  test("D-07 NS-PID repeated across more than 5 products counts as missing", () => {
    const six = Array.from({ length: 6 }, () => good({ nspid: "SAME" }));
    const five = Array.from({ length: 5 }, () => good({ nspid: "SAME5" }));
    assert.equal(evaluate(six).issues.filter((i) => i.code === "R-NSPID-01").length, 6);
    assert.equal(evaluate(five).issues.filter((i) => i.code === "R-NSPID-01").length, 0);
  });
});

describe("S-PID", () => {
  test("R-SPID-01 fails on blank without flag; flag gives Y081 and passes", () => {
    assert.ok(codes([good({ barcodes: [] })]).includes("R-SPID-01"));
    const r = evaluate([good({ barcodes: [""], noStandardIdentifier: true })]);
    assert.equal(r.issues.length, 0);
    assert.equal(r.results[0]!.spidException, "Y081");
  });
  test("R-SPID-02 wrong length; E-01 suggests leading zero", () => {
    const r = evaluate([good({ barcodes: ["36000291452"] })]);
    const i = r.issues.find((x) => x.code === "R-SPID-02");
    assert.ok(i);
    assert.equal(i.suggestion, "036000291452");
    assert.ok(!codes([good({ barcodes: ["036000291452"] })]).includes("R-SPID-02"));
  });
  test("R-SPID-02 with E-04 ISBN-10 suggestion", () => {
    const r = evaluate([good({ barcodes: ["0-306-40615-2"] })]);
    const i = r.issues.find((x) => x.code === "R-SPID-02");
    assert.equal(i?.suggestion, "9780306406157");
  });
  test("R-SPID-03 bad check digit", () => {
    assert.ok(codes([good({ barcodes: ["5901234123458"] })]).includes("R-SPID-03"));
    assert.ok(!codes([good({ barcodes: ["5901234123457"] })]).includes("R-SPID-03"));
  });
  test("R-SPID-04 placeholder or equal to SKU", () => {
    assert.ok(codes([good({ barcodes: ["000000"] })]).includes("R-SPID-04"));
    assert.ok(codes([good({ sku: "12345678", barcodes: ["12345678"] })]).includes("R-SPID-04"));
    assert.ok(!codes([good()]).includes("R-SPID-04"));
  });
  test("placeholder barcode with no-barcode flag is treated as none (Y081), not R-SPID-04/07", () => {
    const r = evaluate([good({ barcodes: ["n/a"], noStandardIdentifier: true })]);
    assert.deepEqual(r.issues, []);
    assert.equal(r.results[0]!.spidException, "Y081");
  });
  test("R-SPID-05 internal code with letters (ASIN)", () => {
    assert.ok(codes([good({ barcodes: ["B08N5WRWNW"] })]).includes("R-SPID-05"));
    assert.ok(!codes([good()]).includes("R-SPID-05"));
  });
  test("R-SPID-06 same barcode on different products; same product is fine", () => {
    const a = good({ barcodes: ["4006381333931"] });
    const b = good({ barcodes: ["4006381333931"] });
    assert.equal(evaluate([a, b]).issues.filter((i) => i.code === "R-SPID-06").length, 2);
    const c = good({ barcodes: ["96385074"], productId: "P-same" });
    const d = good({ barcodes: ["96385074"], productId: "P-same" });
    assert.equal(evaluate([c, d]).issues.filter((i) => i.code === "R-SPID-06").length, 0);
  });
  test("D-07 barcode repeated across more than 5 products is a placeholder → R-SPID-04", () => {
    const six = Array.from({ length: 6 }, () => good({ barcodes: ["40170725"] }));
    const r = evaluate(six);
    assert.equal(r.issues.filter((i) => i.code === "R-SPID-04").length, 6);
    assert.equal(r.issues.filter((i) => i.code === "R-SPID-06").length, 0);
  });
  test("R-SPID-07 barcode present and flag set", () => {
    assert.ok(codes([good({ noStandardIdentifier: true })]).includes("R-SPID-07"));
    assert.ok(!codes([good()]).includes("R-SPID-07"));
  });
  test("E-03 first valid barcode wins; others shown read-only", () => {
    const r = evaluate([good({ barcodes: ["INTERNAL-1", "5901234123457", "036000291452"] })]);
    assert.equal(r.results[0]!.spid, "5901234123457");
    assert.deepEqual(r.results[0]!.otherBarcodes, ["INTERNAL-1", "036000291452"]);
    assert.ok(!r.issues.some((i) => i.code.startsWith("R-SPID")));
  });
  test("E-02 spaced barcode is normalized before validation", () => {
    const r = evaluate([good({ barcodes: ["5 901234 123457"] })]);
    assert.equal(r.results[0]!.spid, "5901234123457");
    assert.equal(r.issues.length, 0);
  });
});

describe("customs data D-08", () => {
  test("R-HS-01 warning by default, error when hsAsError", () => {
    const x = good({ hsCode: null });
    const r1 = evaluate([x]);
    assert.equal(r1.issues.find((i) => i.code === "R-HS-01")?.severity, "warning");
    assert.equal(r1.ready, 1);
    const r2 = evaluate([x], { hsAsError: true });
    assert.equal(r2.issues.find((i) => i.code === "R-HS-01")?.severity, "error");
    assert.equal(r2.ready, 0);
    assert.ok(!codes([good()]).includes("R-HS-01"));
  });
  test("R-HS-02 not 6–10 digits; dotted codes normalize", () => {
    assert.ok(codes([good({ hsCode: "6302" })]).includes("R-HS-02"));
    assert.ok(codes([good({ hsCode: "63022100001" })]).includes("R-HS-02"));
    assert.ok(!codes([good({ hsCode: "6302.21" })]).includes("R-HS-02"));
  });
  test("R-COO-01 missing origin", () => {
    assert.ok(codes([good({ countryOfOrigin: "" })]).includes("R-COO-01"));
    assert.ok(!codes([good()]).includes("R-COO-01"));
  });
  test("skipRules removes rules the data source cannot provide", () => {
    const x = good({ hsCode: null, countryOfOrigin: null });
    assert.deepEqual(codes([x], { skipRules: ["R-HS-01", "R-HS-02", "R-COO-01"] }), []);
  });
});

describe("guard path (UC-12) with a precomputed index", () => {
  test("changed variant is checked against the stored catalogue", () => {
    const stored = [good({ sku: "EXISTING" }), good()];
    const changed = good({ sku: "EXISTING" });
    const index = buildIndex([...stored, changed]);
    const r = evaluate([changed], {}, { index });
    assert.equal(r.inScope, 1);
    const dup = r.issues.find((i) => i.code === "R-MPID-02");
    assert.match(dup!.message, /used by 1 other variants/);
  });
});

describe("extra placeholders from settings", () => {
  test("custom placeholder counts as missing", () => {
    assert.ok(codes([good({ nspid: "PENDING" })], { extraPlaceholders: ["pending"] }).includes("R-NSPID-01"));
    assert.ok(!codes([good({ nspid: "PENDING" })]).includes("R-NSPID-01"));
  });
});
