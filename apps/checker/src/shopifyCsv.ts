// FR-16: map a Shopify product CSV export to engine input.
// Supports the classic export ("Variant SKU", "Variant Barcode") and the newer
// export ("SKU", "Barcode", "Barcodes" with typed values, Sep 2026).
import { splitTypedBarcodes, type ProductStatus, type VariantInput } from "@pidready/rules";

export type Field =
  | "handle"
  | "title"
  | "vendor"
  | "type"
  | "status"
  | "published"
  | "option1"
  | "option2"
  | "option3"
  | "sku"
  | "barcode"
  | "barcodes"
  | "price"
  | "requiresShipping"
  | "giftCard"
  | "hsCode"
  | "countryOfOrigin"
  | "nspid";

/** Known header spellings, lower-case. */
const ALIASES: Record<Exclude<Field, "nspid">, string[]> = {
  handle: ["handle", "url handle"],
  title: ["title"],
  vendor: ["vendor"],
  type: ["type", "product type"],
  status: ["status"],
  published: ["published", "published on online store"],
  option1: ["option1 value"],
  option2: ["option2 value"],
  option3: ["option3 value"],
  sku: ["variant sku", "sku"],
  barcode: ["variant barcode", "barcode"],
  barcodes: ["barcodes", "variant barcodes"],
  price: ["variant price", "price"],
  requiresShipping: ["variant requires shipping", "requires shipping"],
  giftCard: ["gift card"],
  hsCode: ["variant hs code", "hs code", "harmonized system code", "harmonized code", "variant harmonized system code"],
  countryOfOrigin: [
    "variant country of origin",
    "country of origin",
    "country/region of origin",
    "variant country/region of origin",
  ],
};

/** UC-11 heuristics: a metafield column that looks like a manufacturer code. */
const NSPID_KEY_HINT = /(mpn|manufacturer|mfr|model|part)/i;
const METAFIELD_HEADER = /\((product|variant)\.metafields\.([a-z0-9_$-]+)\.([a-z0-9_-]+)\)/i;

export type ColumnMap = Partial<Record<Field, number>>;

export type NspidCandidate = { index: number; header: string; level: "product" | "variant"; key: string };

export function detectColumns(headers: string[]): { map: ColumnMap; nspidCandidates: NspidCandidate[] } {
  const lower = headers.map((h) => h.trim().toLowerCase());
  const map: ColumnMap = {};
  for (const [field, names] of Object.entries(ALIASES) as [Field, string[]][]) {
    for (const name of names) {
      const i = lower.indexOf(name);
      if (i !== -1) {
        map[field] = i;
        break;
      }
    }
  }
  const nspidCandidates: NspidCandidate[] = [];
  headers.forEach((h, index) => {
    const m = METAFIELD_HEADER.exec(h);
    if (!m) return;
    const key = `${m[2]}.${m[3]}`;
    if (key === "customs.manufacturer_product_id" || NSPID_KEY_HINT.test(key) || NSPID_KEY_HINT.test(h.split("(")[0] ?? "")) {
      nspidCandidates.push({ index, header: h, level: m[1]!.toLowerCase() as "product" | "variant", key });
    }
  });
  // Prefer the PID Ready default key, then variant-level, then first found.
  nspidCandidates.sort((a, b) => score(b) - score(a));
  if (nspidCandidates[0]) map.nspid = nspidCandidates[0].index;
  return { map, nspidCandidates };
}

function score(c: NspidCandidate) {
  return (c.key === "customs.manufacturer_product_id" ? 10 : 0) + (c.level === "variant" ? 1 : 0);
}

/** E-15: the columns we cannot work without. */
export function missingRequired(map: ColumnMap): Field[] {
  const out: Field[] = [];
  if (map.handle === undefined) out.push("handle");
  if (map.sku === undefined) out.push("sku");
  if (map.barcode === undefined && map.barcodes === undefined) out.push("barcode");
  return out;
}

export type DisplayRow = {
  productTitle: string;
  variantTitle: string;
  vendor: string;
  sku: string;
  barcode: string;
  nspid: string;
};

export type ParsedCatalogue = {
  variants: VariantInput[];
  display: Map<string, DisplayRow>;
  products: number;
  rows: number;
  has: { hsCode: boolean; countryOfOrigin: boolean; nspid: boolean; typedBarcodes: boolean };
};

const truthy = (s: string) => /^(true|yes|1)$/i.test(s.trim());

function toStatus(status: string | undefined, published: string | undefined): ProductStatus {
  const s = (status ?? "").trim().toLowerCase();
  if (s === "active") return "ACTIVE";
  if (s === "draft") return "DRAFT";
  if (s === "archived") return "ARCHIVED";
  if (published !== undefined && published.trim() !== "") return truthy(published) ? "ACTIVE" : "DRAFT";
  return "ACTIVE";
}

export function toVariants(rows: string[][], map: ColumnMap): ParsedCatalogue {
  const [, ...body] = rows;
  const get = (r: string[], f: Field) => (map[f] === undefined ? undefined : (r[map[f]!] ?? ""));

  const variants: VariantInput[] = [];
  const display = new Map<string, DisplayRow>();
  const products = new Map<
    string,
    { title: string; vendor: string; status: ProductStatus; giftCard: boolean; nspid: string; count: number }
  >();

  for (const r of body) {
    const handle = (get(r, "handle") ?? "").trim();
    if (!handle) continue;

    let p = products.get(handle);
    if (!p) {
      p = {
        title: (get(r, "title") ?? "").trim() || handle,
        vendor: (get(r, "vendor") ?? "").trim(),
        status: toStatus(get(r, "status"), get(r, "published")),
        giftCard: truthy(get(r, "giftCard") ?? ""),
        nspid: "",
        count: 0,
      };
      products.set(handle, p);
    }
    // Product-level metafield value sits on the product's first row.
    const nsCell = (get(r, "nspid") ?? "").trim();
    const nsIsVariantLevel = map.nspid !== undefined && /\(variant\.metafields/i.test(rows[0]?.[map.nspid] ?? "");
    if (nsCell && !nsIsVariantLevel && !p.nspid) p.nspid = nsCell;

    // A variant row carries variant data; image-only rows don't.
    const sku = get(r, "sku") ?? "";
    const barcode = get(r, "barcode") ?? "";
    const typed = get(r, "barcodes") ?? "";
    const isVariantRow = [sku, barcode, typed, get(r, "price") ?? "", get(r, "option1") ?? ""].some((c) => c.trim() !== "");
    if (!isVariantRow) continue;

    p.count++;
    const id = `${handle}#${p.count}`;
    const barcodes = [...(typed.trim() ? splitTypedBarcodes(typed) : []), ...(barcode.trim() ? [barcode] : [])];
    const dedup = [...new Set(barcodes.map((b) => b.trim()).filter(Boolean))];
    const reqShip = get(r, "requiresShipping");

    const v: VariantInput = {
      id,
      productId: handle,
      vendor: p.vendor,
      status: p.status,
      requiresShipping: reqShip === undefined || reqShip.trim() === "" ? true : truthy(reqShip),
      isGiftCard: p.giftCard,
      sku: sku.trim() || null,
      barcodes: dedup,
      nspid: (nsIsVariantLevel ? nsCell : p.nspid) || null,
      noStandardIdentifier: false, // variant metafields are not in the CSV export
      hsCode: (get(r, "hsCode") ?? "").trim() || null,
      countryOfOrigin: (get(r, "countryOfOrigin") ?? "").trim() || null,
    };
    variants.push(v);
    const variantTitle = [get(r, "option1"), get(r, "option2"), get(r, "option3")]
      .map((s) => (s ?? "").trim())
      .filter((s) => s && s !== "Default Title")
      .join(" / ");
    display.set(id, {
      productTitle: p.title,
      variantTitle,
      vendor: p.vendor,
      sku: sku.trim(),
      barcode: dedup.join(", "),
      nspid: v.nspid ?? "",
    });
  }

  // Product-level NS-PID found on a later row still applies to earlier variants of the product.
  for (const v of variants) {
    if (!v.nspid) {
      const p = products.get(v.productId);
      if (p?.nspid) {
        v.nspid = p.nspid;
        display.get(v.id)!.nspid = p.nspid;
      }
    }
  }

  return {
    variants,
    display,
    products: products.size,
    rows: body.length,
    has: {
      hsCode: map.hsCode !== undefined,
      countryOfOrigin: map.countryOfOrigin !== undefined,
      nspid: map.nspid !== undefined,
      typedBarcodes: map.barcodes !== undefined,
    },
  };
}
