// FR-03: variant snapshots. Pure mapping between Shopify variant nodes, DB rows and engine input.
import type { ProductStatus, VariantInput } from "@pidready/rules";

export type VariantNode = {
  id: string;
  sku?: string | null;
  barcode?: string | null;
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
    barcodes: n.barcode ? [n.barcode] : [],
    nspid: n.nspid?.value ?? null,
    noStandardIdentifier: n.noStd?.value === "true",
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
