// AT-00: build a Shopify product-import CSV for a development store.
//   node scripts/make-fixture.mjs > fixture.csv   then Shopify admin → Products → Import.
// Covers every rule code and the edge cases that can be expressed in a product CSV.
// Note: variant metafields (manufacturer code, "no barcode" flag) can't be imported by CSV;
// set a few in the admin or with the app to cover R-NSPID-02/03/04/05 and R-SPID-07.
// Shopify caps a product at 2,048 variants, so the "big product" uses 2,048 (E-05).
const ean = (seed) => {
  const body = "890" + String(1_000_000_000 + seed * 7919).slice(-9);
  let s = 0;
  for (let i = 0; i < 12; i++) s += Number(body[11 - i]) * (i % 2 === 0 ? 3 : 1);
  return body + ((10 - (s % 10)) % 10);
};
const H = ["Handle", "Title", "Vendor", "Type", "Status", "Gift Card", "Option1 Name", "Option1 Value", "Option2 Name", "Option2 Value",
  "Variant SKU", "Variant Price", "Variant Requires Shipping", "Variant Barcode", "Variant Inventory Tracker"];
const rows = [H];
const q = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const vendors = Array.from({ length: 12 }, (_, i) => `Fixture Vendor ${String.fromCharCode(65 + i)}`);
let n = 0;
function product(handle, title, vendor, variants, extra = {}) {
  variants.forEach((v, i) => {
    rows.push([
      handle, i ? "" : title, i ? "" : vendor, i ? "" : "Textiles", i ? "" : (extra.status ?? "active"), i ? "" : (extra.gift ? "TRUE" : "FALSE"),
      i ? "" : "Size", v.opt, v.opt2 ? (i ? "" : "Colour") : "", v.opt2 ?? "",
      v.sku ?? "", "19.00", extra.ship === false ? "FALSE" : "TRUE", v.barcode ?? "", "shopify",
    ]);
    n++;
  });
}
// 1,150 ordinary variants across 12 vendors, with rule-triggering values mixed in.
for (let p = 0; p < 230; p++) {
  const vs = [];
  for (let i = 0; i < 5; i++) {
    const seed = p * 10 + i;
    let sku = `FX-${p}-${i}`, barcode = ean(seed);
    if (seed % 23 === 0) sku = "";                         // R-MPID-01
    if (seed % 29 === 0) sku = "n/a";                      // R-MPID-01 placeholder
    if (seed % 31 === 0) sku = `FX-DUP-${p}`;              // R-MPID-02 (with next)
    if (seed % 31 === 1) sku = `FX-DUP-${p}`;
    if (seed % 7 === 0) barcode = "";                      // R-SPID-01
    if (seed % 11 === 0) barcode = barcode.slice(1);       // R-SPID-02 / E-01 (leading zero lost for UPC)
    if (seed % 13 === 0) barcode = barcode.slice(0, -1) + ((Number(barcode.at(-1)) + 1) % 10); // R-SPID-03
    if (seed % 17 === 0) barcode = "000000";               // R-SPID-04
    if (seed % 19 === 0) barcode = "B08N5WRWNW";           // R-SPID-05
    if (seed % 37 === 0) barcode = "5 901234 123457";      // E-02 spaced
    if (seed % 41 === 0) barcode = "0306406152";           // E-04 ISBN-10
    if (seed % 43 === 0) barcode = "4006381333931";        // R-SPID-06 shared across products
    vs.push({ opt: ["XS", "S", "M", "L", "XL"][i], sku, barcode });
  }
  product(`fixture-${p}`, `Fixture Product ${p}`, vendors[p % 12], vs);
}
// 3 gift cards, 20 drafts, 1 archived, 1 non-shipping (E-07, E-08).
for (let g = 0; g < 3; g++) product(`fixture-gift-${g}`, `Gift Card ${g}`, vendors[0], [{ opt: `$${25 * (g + 1)}` }], { gift: true, ship: false });
for (let d = 0; d < 20; d++) product(`fixture-draft-${d}`, `Draft Product ${d}`, vendors[d % 12], [{ opt: "One", sku: `DR-${d}` }], { status: "draft" });
product("fixture-archived", "Archived Product", vendors[1], [{ opt: "One", sku: "AR-1" }], { status: "archived" });
product("fixture-digital", "Digital Pattern", vendors[2], [{ opt: "PDF", sku: "DG-1" }], { ship: false });
// E-05: one product with 2,048 variants (Shopify's per-product maximum).
const big = [];
for (let i = 0; i < 2048; i++) big.push({ opt: `Size ${Math.floor(i / 32)}`, opt2: `Colour ${i % 32}`, sku: `BIG-${i}`, barcode: i % 3 ? ean(90000 + i) : "" });
product("fixture-big", "Fixture Big Product", vendors[3], big);
process.stdout.write(rows.map((r) => r.map(q).join(",")).join("\n") + "\n");
process.stderr.write(`wrote ${n} variants\n`);
