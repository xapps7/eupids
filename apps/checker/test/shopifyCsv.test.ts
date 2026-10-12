// FR-16: both barcode column formats; product/variant row handling; E-15 detection.
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, parseCsv, toCsv } from "@pidready/rules";
import { detectColumns, missingRequired, toVariants } from "../src/shopifyCsv.js";
import { sampleCsv } from "../src/sample.js";

test("CSV parser handles quotes, commas, newlines and BOM", () => {
  const rows = parseCsv('﻿a,b\r\n"x, y","he said ""hi""\nbye"\r\n');
  assert.deepEqual(rows, [["a", "b"], ["x, y", 'he said "hi"\nbye']]);
  assert.deepEqual(parseCsv(toCsv(rows)), rows);
});

test("classic export: Variant SKU / Variant Barcode, image-only rows skipped", () => {
  const csv = toCsv([
    ["Handle", "Title", "Vendor", "Option1 Value", "Variant SKU", "Variant Price", "Variant Barcode", "Image Src", "Status"],
    ["tee", "Tee", "Acme", "S", "TEE-S", "10", "5901234123457", "https://x/1.jpg", "active"],
    ["tee", "", "", "M", "TEE-M", "10", "4006381333931", "", ""],
    ["tee", "", "", "", "", "", "", "https://x/2.jpg", ""],
  ]);
  const rows = parseCsv(csv);
  const { map } = detectColumns(rows[0]!);
  const cat = toVariants(rows, map);
  assert.equal(cat.variants.length, 2);
  assert.equal(cat.products, 1);
  assert.equal(cat.variants[1]!.vendor, "Acme", "vendor carried from first row");
  assert.deepEqual(cat.variants[1]!.barcodes, ["4006381333931"]);
  assert.equal(cat.variants[0]!.status, "ACTIVE");
});

test("new export: SKU / Barcodes typed column (Sep 2026)", () => {
  const csv = toCsv([
    ["URL handle", "Title", "Vendor", "Status", "SKU", "Barcodes", "Price", "Requires shipping"],
    ["mug", "Mug", "Acme", "active", "MUG-1", "gtin:00012345678905; upc:012345678905; INTERNAL-123", "5", "TRUE"],
  ]);
  const rows = parseCsv(csv);
  const { map } = detectColumns(rows[0]!);
  const cat = toVariants(rows, map);
  assert.equal(cat.has.typedBarcodes, true);
  assert.deepEqual(cat.variants[0]!.barcodes, ["00012345678905", "012345678905", "INTERNAL-123"]);
  const r = evaluate(cat.variants);
  assert.equal(r.results[0]!.spid, "00012345678905");
});

test("product metafield manufacturer column is detected and applied to all variants", () => {
  const csv = toCsv([
    ["Handle", "Title", "Vendor", "Option1 Value", "Variant SKU", "Variant Barcode", "Manufacturer code (product.metafields.custom.mfr_code)"],
    ["a", "A", "V", "S", "A-S", "", "MFR-77"],
    ["a", "", "", "M", "A-M", "", ""],
  ]);
  const rows = parseCsv(csv);
  const { map, nspidCandidates } = detectColumns(rows[0]!);
  assert.equal(nspidCandidates[0]!.key, "custom.mfr_code");
  const cat = toVariants(rows, map);
  assert.deepEqual(cat.variants.map((v) => v.nspid), ["MFR-77", "MFR-77"]);
});

test("E-15: translated headers leave required columns unmapped", () => {
  const { map } = detectColumns(["Identificador", "Título", "SKU de variante", "Código de barras"]);
  assert.deepEqual(missingRequired(map), ["handle", "sku", "barcode"]);
});

test("gift card and requires-shipping=false are out of scope; draft status respected", () => {
  const rows = parseCsv(sampleCsv());
  const { map } = detectColumns(rows[0]!);
  const cat = toVariants(rows, map);
  const r = evaluate(cat.variants);
  assert.equal(r.outOfScope, 2); // gift card + draft
  assert.ok(r.inScope > 15);
  assert.ok(r.issues.length > 0);
});
