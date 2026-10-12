// AT-01 (GTIN part): check digit on 50 known-valid and 50 known-invalid codes.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  gtinCheckDigit,
  isValidGtin,
  isIsbn10,
  isbn10To13,
  normalizeBarcode,
  suggestLeadingZero,
  splitTypedBarcodes,
} from "../src/index.js";

// Published reference codes (GS1 / ISBN / UPC examples).
const REFERENCE_VALID = [
  "4006381333931", // EAN-13, Stabilo pen
  "5901234123457", // EAN-13, GS1 example
  "036000291452", // UPC-A, Wikipedia example
  "9780306406157", // ISBN-13
  "9781861972712", // ISBN-13
  "96385074", // GTIN-8
  "40170725", // GTIN-8
  "00012345600012", // GTIN-14
  "10012345678902", // GTIN-14
  "012345678905", // UPC-A
];

// Independent check-digit formula (weights assigned from the LEFT, by parity of
// distance to the end) so the test does not just re-run the code under test.
function independentCheck(body: string): number {
  const len = body.length + 1;
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const distFromEnd = len - 1 - i; // check digit is distance 0
    sum += Number(body[i]) * (distFromEnd % 2 === 1 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

// Deterministic pseudo-random bodies for the other 40 valid codes.
function lcg(seed: number) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) % 2147483648);
}
const rnd = lcg(42);
const generated: string[] = [];
const lengths = [8, 12, 13, 14];
for (let i = 0; generated.length < 40; i++) {
  const L = lengths[i % 4]!;
  let body = "";
  for (let j = 0; j < L - 1; j++) body += String(rnd() % 10);
  generated.push(body + independentCheck(body));
}

const VALID = [...REFERENCE_VALID, ...generated];
// Flip the last digit → guaranteed wrong check digit.
const INVALID = VALID.map((c) => c.slice(0, -1) + String((Number(c.at(-1)) + 1) % 10));

test("50 known-valid GTINs pass", () => {
  assert.equal(VALID.length, 50);
  for (const c of VALID) assert.ok(isValidGtin(c), `expected valid: ${c}`);
});

test("50 known-invalid GTINs fail", () => {
  assert.equal(INVALID.length, 50);
  for (const c of INVALID) assert.ok(!isValidGtin(c), `expected invalid: ${c}`);
});

test("check digit matches the D-06 worked example", () => {
  assert.equal(gtinCheckDigit("590123412345"), 7);
  assert.equal(gtinCheckDigit("03600029145"), 2);
});

test("E-02 normalization strips spaces and hyphens", () => {
  assert.equal(normalizeBarcode(" 5 901234 123457 "), "5901234123457");
  assert.equal(normalizeBarcode("978-0-306-40615-7"), "9780306406157");
});

test("E-01 leading zero suggestion", () => {
  assert.equal(suggestLeadingZero("36000291452"), "036000291452");
  assert.equal(suggestLeadingZero("36000291453"), null);
});

test("E-04 ISBN-10 detection and conversion", () => {
  assert.ok(isIsbn10("0306406152"));
  assert.ok(isIsbn10("080442957X"));
  assert.ok(!isIsbn10("0306406153"));
  assert.equal(isbn10To13("0306406152"), "9780306406157");
});

test("typed Barcodes column is split (Sep 2026 export format)", () => {
  assert.deepEqual(splitTypedBarcodes("gtin:00012345678905; upc:012345678905; INTERNAL-123"), [
    "00012345678905",
    "012345678905",
    "INTERNAL-123",
  ]);
});
