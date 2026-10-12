// "Send to your shipping provider": status numbers, recent EU orders, the print sheet data.
import type { PrismaClient } from "@prisma/client";
import { isValidGtin, normalizeBarcode } from "@pidready/rules";
import { fedexPidText } from "./csv.server";

export type CodeRow = {
  variantId: string | null;
  title: string;
  variantTitle: string;
  fedex: string; // FedEx Ship Manager "Product Identifier (PID)" text
  sku: string;
  nspid: string;
  barcode: string; // a valid GTIN, "Y081" when marked as none, or "" when missing/invalid
  hsCode: string;
  origin: string;
  ready: boolean;
  known: boolean; // false: the variant was deleted or is not in our last check
};

type Snap = {
  variantId: string; productTitle: string; variantTitle: string; sku: string | null; nspid: string | null;
  barcodes: string[]; noStandardIdentifier: boolean; hsCode: string | null; countryOfOrigin: string | null; ready: boolean;
};

function codesOf(s: Snap | undefined) {
  if (!s) return { sku: "", nspid: "", barcode: "", hsCode: "", origin: "", ready: false, known: false };
  const gtin = s.barcodes.map(normalizeBarcode).find(isValidGtin);
  return {
    sku: s.sku ?? "",
    nspid: s.nspid ?? "",
    barcode: gtin ?? (s.noStandardIdentifier ? "Y081" : ""),
    hsCode: s.hsCode ?? "",
    origin: s.countryOfOrigin ?? "",
    ready: s.ready,
    known: true,
  };
}

const SNAP_SELECT = {
  variantId: true, productTitle: true, variantTitle: true, sku: true, nspid: true, barcodes: true,
  noStandardIdentifier: true, hsCode: true, countryOfOrigin: true, ready: true,
} as const;

/** Items that can ship to the EU (or all in-scope items), as one printable list. */
export async function productSheet(db: PrismaClient, shopId: string, only: Set<string> | null, limit = 2000) {
  const snaps = await db.variantSnapshot.findMany({
    where: { shopId, inScope: true, ...(only ? { variantId: { in: [...only] } } : {}) },
    select: SNAP_SELECT,
    orderBy: [{ productTitle: "asc" }, { variantTitle: "asc" }],
    take: limit,
  });
  return snaps.map<CodeRow>((s) => {
    const c = codesOf(s);
    return { variantId: s.variantId, title: s.productTitle, variantTitle: s.variantTitle, ...c, fedex: c.sku && c.nspid && c.barcode ? fedexPidText(c.sku, c.nspid, c.barcode === "Y081" ? "" : c.barcode) : "" };
  });
}

/** Variants whose manufacturer code is known but not yet an NS-PID barcode in Shopify. */
export async function barcodeSyncCandidates(db: PrismaClient, shopId: string) {
  const rows = await db.variantSnapshot.findMany({
    where: { shopId, inScope: true, nspid: { not: null }, nspidInBarcodes: false },
    select: { variantId: true, barcodes: true },
  });
  return { ids: rows.map((r) => r.variantId), withoutBarcode: rows.filter((r) => r.barcodes.length === 0).length };
}

/** Every in-scope variant with a manufacturer code (FlavorCloud mirror writes all of them). */
export async function allWithNspid(db: PrismaClient, shopId: string) {
  const rows = await db.variantSnapshot.findMany({ where: { shopId, inScope: true, nspid: { not: null } }, select: { variantId: true } });
  return rows.map((r) => r.variantId);
}

export async function shipStatus(db: PrismaClient, shopId: string) {
  const [withNspid, inBarcodes, ready, inScope] = await Promise.all([
    db.variantSnapshot.count({ where: { shopId, inScope: true, nspid: { not: null } } }),
    db.variantSnapshot.count({ where: { shopId, inScope: true, nspid: { not: null }, nspidInBarcodes: true } }),
    db.variantSnapshot.count({ where: { shopId, inScope: true, ready: true } }),
    db.variantSnapshot.count({ where: { shopId, inScope: true } }),
  ]);
  return { withNspid, inBarcodes, ready, inScope };
}
