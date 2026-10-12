// A sample Shopify product export for a fictional home-textiles store.
// Clearly labelled as example data in the UI. Covers the common failure modes.
import { gtinCheckDigit, toCsv } from "@pidready/rules";

const HEAD = [
  "Handle", "Title", "Body (HTML)", "Vendor", "Type", "Tags", "Published",
  "Option1 Name", "Option1 Value", "Variant SKU", "Variant Price",
  "Variant Requires Shipping", "Variant Barcode", "Gift Card", "Status",
  "Manufacturer code (product.metafields.custom.mfr_code)",
];

const ean = (seed: number) => {
  const body = "890" + String(1234500000 + seed * 7919).slice(-9);
  return body + gtinCheckDigit(body);
};

type P = {
  handle: string; title: string; vendor: string; type: string; mfr?: string;
  status?: string; gift?: boolean; ship?: boolean;
  variants: { opt: string; sku: string; barcode: string }[];
};

const products: P[] = [
  { handle: "indigo-dabu-bedsheet", title: "Indigo Dabu Bedsheet", vendor: "Jaipur Block Prints", type: "Bedsheets", mfr: "JBP-DB-220",
    variants: [
      { opt: "Single", sku: "IL-BS-DB-S", barcode: ean(1) },
      { opt: "Double", sku: "IL-BS-DB-D", barcode: ean(2) },
      { opt: "King", sku: "IL-BS-DB-K", barcode: ean(3) },
    ] },
  { handle: "kantha-throw", title: "Kantha Stitch Throw", vendor: "Jaipur Block Prints", type: "Throws",
    variants: [
      { opt: "Rust", sku: "IL-TH-KA-R", barcode: ean(4) },
      { opt: "Teal", sku: "IL-TH-KA-T", barcode: ean(5).slice(0, -1) + "0" },
    ] },
  { handle: "cotton-waffle-towel", title: "Cotton Waffle Towel", vendor: "Panipat Weaves", type: "Towels",
    variants: [
      { opt: "Hand", sku: "IL-TW-WF-H", barcode: "" },
      { opt: "Bath", sku: "IL-TW-WF-B", barcode: "" },
      { opt: "Bath sheet", sku: "IL-TW-WF-B", barcode: "n/a" },
    ] },
  { handle: "handloom-table-runner", title: "Handloom Table Runner", vendor: "Panipat Weaves", type: "Table linen",
    variants: [
      { opt: "150 cm", sku: "IL-TR-HL-150", barcode: "B08N5WRWNW" },
      { opt: "200 cm", sku: "IL-TR-HL-200", barcode: "36000291452" },
    ] },
  { handle: "chambray-cushion-cover", title: "Chambray Cushion Cover", vendor: "Kanpur Cotton Mills", type: "Cushions",
    variants: [
      { opt: "40 x 40", sku: "IL-CC-CH-40", barcode: ean(8) },
      { opt: "50 x 50", sku: "IL-CC-CH-50", barcode: ean(9) },
      { opt: "60 x 60", sku: "", barcode: ean(10) },
    ] },
  { handle: "linen-napkin-set", title: "Linen Napkin Set of 4", vendor: "Kanpur Cotton Mills", type: "Table linen",
    variants: [
      { opt: "Natural", sku: "IL-NP-LN-N", barcode: "5 901234 123457" },
      { opt: "Charcoal", sku: "IL-NP-LN-C", barcode: "5901234123457" },
    ] },
  { handle: "indigo-loom-quilt", title: "Indigo Loom Signature Quilt", vendor: "Indigo Loom", type: "Quilts", mfr: "IL-QT-SG",
    variants: [
      { opt: "Double", sku: "IL-QT-SG-D", barcode: ean(12) },
      { opt: "King", sku: "IL-QT-SG-K", barcode: ean(13) },
    ] },
  { handle: "block-print-apron", title: "Block Print Apron", vendor: "Sanganer Crafts", type: "Kitchen",
    variants: [{ opt: "Default Title", sku: "IL-AP-BP", barcode: "" }] },
  { handle: "dhurrie-rug", title: "Cotton Dhurrie Rug", vendor: "Sanganer Crafts", type: "Rugs", mfr: "SC-DR-0457",
    variants: [
      { opt: "2 x 3 ft", sku: "IL-RG-DH-23", barcode: ean(15) },
      { opt: "4 x 6 ft", sku: "IL-RG-DH-46", barcode: ean(16) },
    ] },
  { handle: "gift-card", title: "Gift Card", vendor: "Indigo Loom", type: "Gift card", gift: true, ship: false,
    variants: [{ opt: "₹2,000", sku: "", barcode: "" }] },
  { handle: "muslin-swaddle", title: "Muslin Swaddle", vendor: "Kanpur Cotton Mills", type: "Baby", status: "draft",
    variants: [{ opt: "Default Title", sku: "IL-BB-MS", barcode: "" }] },
];

export function sampleCsv(): string {
  const rows: string[][] = [HEAD];
  for (const p of products) {
    p.variants.forEach((v, i) => {
      const first = i === 0;
      rows.push([
        p.handle,
        first ? p.title : "",
        first ? "<p>Handmade in India.</p>" : "",
        first ? p.vendor : "",
        first ? p.type : "",
        "",
        first ? "TRUE" : "",
        first ? "Size" : "",
        v.opt,
        v.sku,
        "1499.00",
        p.ship === false ? "FALSE" : "TRUE",
        v.barcode,
        first ? (p.gift ? "TRUE" : "FALSE") : "",
        first ? (p.status ?? "active") : "",
        first ? (p.mfr ?? "") : "",
      ]);
    });
  }
  return toCsv(rows);
}
