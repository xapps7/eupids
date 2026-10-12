// FR-03: variant snapshots. Pure mapping between Shopify variant nodes, DB rows and engine input.
import type { ProductStatus, VariantInput } from "@pidready/rules";

export type VariantNode = {
  id: string;
  sku?: string | null;
  barcode?: string | null;
  /** Admin API 2026-10. In bulk results the entries arrive as child lines and are attached here. */
  barcodes?: { nodes: BarcodeEntry[] } | null;
  updatedAt: string;
  title?: string | null;
  product: {
    id: string;
    title: string;
    vendor?: string | null;
    productType?: string | null;
    status: string;
    isGiftCard?: boolean | null;
    featuredMedia?: { preview?: { image?: { url?: string | null } | null } | null } | null;
  };
  inventoryItem?: {
    id: string;
    requiresShipping?: boolean | null;
    harmonizedSystemCode?: string | null;
    countryCodeOfOrigin?: string | null;
  } | null;
  nspid?: { value?: string | null } | null;
  noStd?: { value?: string | null } | null;
};

export type BarcodeEntry = { value: string; type?: string | null };

const STANDARD_TYPES = new Set(["UPC", "EAN", "GTIN", "ISBN"]);

/**
 * Split a variant's barcodes into standard barcodes (S-PID candidates) and manufacturer codes.
 * Rules, in order:
 *  - typed NS_PID → the manufacturer code (Shopify's own type for it; Zonos, Passport and Global-e read it)
 *  - typed UPC/EAN/GTIN/ISBN → standard; typed ASIN → ignored (an Amazon id, not for customs)
 *  - an untyped entry equal to the stored manufacturer code → manufacturer code (an older untyped copy)
 *  - the first remaining entry → standard (that is what Shopify's single `barcode` field shows,
 *    so a wrong value there is still reported as a barcode problem)
 *  - later untyped entries: all digits → standard; otherwise → other (a manufacturer-code candidate)
 */
export function splitBarcodes(list: BarcodeEntry[], metafieldNspid: string | null) {
  const standard: string[] = [];
  const other: string[] = [];
  let nsBarcode: string | null = null;
  let first = true;
  for (const b of list) {
    const v = (b.value ?? "").trim();
    if (!v) continue;
    const t = b.type ? String(b.type).toUpperCase() : null;
    if (t === "NS_PID") {
      nsBarcode ??= v;
      continue;
    }
    if (t === "ASIN") continue;
    if (t && STANDARD_TYPES.has(t)) {
      standard.push(v);
      first = false;
      continue;
    }
    if (metafieldNspid && v === metafieldNspid) {
      other.unshift(v);
      continue;
    }
    if (first) {
      standard.push(v);
      first = false;
      continue;
    }
    if (/^[\d\s-]+$/.test(v)) standard.push(v);
    else other.push(v);
  }
  return { standard, other, nsBarcode };
}

export function barcodeList(n: Pick<VariantNode, "barcode" | "barcodes">): BarcodeEntry[] {
  if (n.barcodes?.nodes?.length) return n.barcodes.nodes;
  return n.barcode ? [{ value: n.barcode, type: null }] : [];
}

export type SnapshotRow = {
  shopId: string;
  variantId: string;
  productId: string;
  productTitle: string;
  variantTitle: string;
  vendor: string;
  productType: string;
  status: string;
  requiresShipping: boolean;
  isGiftCard: boolean;
  sku: string | null;
  barcodes: string[];
  nspid: string | null;
  noStandardIdentifier: boolean;
  nspidInBarcodes: boolean;
  hsCode: string | null;
  countryOfOrigin: string | null;
  imageUrl: string | null;
  inventoryItemId: string | null;
  collectionIds: string[];
  updatedAt: Date;
  scanId: string | null;
  inScope: boolean;
  ready: boolean;
};

export function nodeToSnapshot(shopId: string, n: VariantNode, scanId: string | null): SnapshotRow {
  const metaNspid = n.nspid?.value?.trim() || null;
  const split = splitBarcodes(barcodeList(n), metaNspid);
  // The NS-PID barcode is what providers read, so it wins. Then our metafield, then an extra
  // non-barcode code in the list.
  const nspid = split.nsBarcode ?? metaNspid ?? split.other[0] ?? null;
  return {
    shopId,
    variantId: n.id,
    productId: n.product.id,
    productTitle: n.product.title ?? "",
    variantTitle: n.title && n.title !== "Default Title" ? n.title : "",
    vendor: n.product.vendor ?? "",
    productType: n.product.productType ?? "",
    status: n.product.status,
    requiresShipping: n.inventoryItem?.requiresShipping ?? true,
    isGiftCard: !!n.product.isGiftCard,
    sku: n.sku ?? null,
    barcodes: split.standard,
    nspid,
    noStandardIdentifier: n.noStd?.value === "true",
    nspidInBarcodes: !!split.nsBarcode,
    hsCode: n.inventoryItem?.harmonizedSystemCode ?? null,
    countryOfOrigin: n.inventoryItem?.countryCodeOfOrigin ?? null,
    imageUrl: n.product.featuredMedia?.preview?.image?.url ?? null,
    inventoryItemId: n.inventoryItem?.id ?? null,
    collectionIds: [],
    updatedAt: new Date(n.updatedAt),
    scanId,
    inScope: true,
    ready: false,
  };
}

export function snapshotToInput(s: Pick<
  SnapshotRow,
  | "variantId" | "productId" | "vendor" | "status" | "requiresShipping" | "isGiftCard" | "sku"
  | "barcodes" | "nspid" | "noStandardIdentifier" | "hsCode" | "countryOfOrigin"
>): VariantInput {
  const status = (["ACTIVE", "DRAFT", "ARCHIVED"].includes(s.status) ? s.status : "ARCHIVED") as ProductStatus;
  return {
    id: s.variantId,
    productId: s.productId,
    vendor: s.vendor,
    status,
    requiresShipping: s.requiresShipping,
    isGiftCard: s.isGiftCard,
    sku: s.sku,
    barcodes: s.barcodes,
    nspid: s.nspid,
    noStandardIdentifier: s.noStandardIdentifier,
    hsCode: s.hsCode,
    countryOfOrigin: s.countryOfOrigin,
  };
}

/** Numeric id from a GID, for Shopify search syntax. */
export function legacyId(gid: string): string {
  return gid.split("/").pop() ?? gid;
}
