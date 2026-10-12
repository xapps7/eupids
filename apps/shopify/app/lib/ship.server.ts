// "Send to your shipping provider": status numbers, recent EU orders, the print sheet data.
import type { PrismaClient } from "@prisma/client";
import { isValidGtin, normalizeBarcode } from "@pidready/rules";
import type { EuLine } from "./eu-orders.server";

export type CodeRow = {
  variantId: string | null;
  title: string;
  variantTitle: string;
  quantity: number | null;
  unitPrice: string | null;
  currency: string | null;
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

export async function orderSheet(db: PrismaClient, shopId: string, orderId: string) {
  const order = await db.euOrder.findUnique({ where: { shopId_orderId: { shopId, orderId } } });
  if (!order) return null;
  const lines = order.lines as unknown as EuLine[];
  const ids = lines.map((l) => l.variantId).filter((x): x is string => !!x);
  const snaps = await db.variantSnapshot.findMany({ where: { shopId, variantId: { in: ids } }, select: SNAP_SELECT });
  const by = new Map(snaps.map((s) => [s.variantId, s]));
  const rows: CodeRow[] = lines.map((l) => ({
    variantId: l.variantId,
    title: l.title,
    variantTitle: l.variantTitle,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    currency: l.currency,
    ...codesOf(l.variantId ? by.get(l.variantId) : undefined),
  }));
  return { name: order.name, createdAt: order.createdAt.toISOString(), country: order.country, rows };
}

/** All items shipped to the EU (or all in-scope items), as one printable list. */
export async function productSheet(db: PrismaClient, shopId: string, euOnly: boolean, limit = 1000) {
  const demand = euOnly ? await db.euDemand.findMany({ where: { shopId }, select: { variantId: true } }) : null;
  const snaps = await db.variantSnapshot.findMany({
    where: { shopId, inScope: true, ...(demand ? { variantId: { in: demand.map((d) => d.variantId) } } : {}) },
    select: SNAP_SELECT,
    orderBy: [{ productTitle: "asc" }, { variantTitle: "asc" }],
    take: limit,
  });
  return snaps.map<CodeRow>((s) => ({
    variantId: s.variantId,
    title: s.productTitle,
    variantTitle: s.variantTitle,
    quantity: null,
    unitPrice: null,
    currency: null,
    ...codesOf(s),
  }));
}

export async function recentEuOrders(db: PrismaClient, shopId: string, take = 25) {
  const orders = await db.euOrder.findMany({ where: { shopId }, orderBy: { createdAt: "desc" }, take });
  const ids = [...new Set(orders.flatMap((o) => (o.lines as unknown as EuLine[]).map((l) => l.variantId).filter((x): x is string => !!x)))];
  const ready = new Set(
    (await db.variantSnapshot.findMany({ where: { shopId, variantId: { in: ids }, ready: true }, select: { variantId: true } })).map((s) => s.variantId),
  );
  return orders.map((o) => {
    const lines = o.lines as unknown as EuLine[];
    const ok = lines.filter((l) => l.variantId && ready.has(l.variantId)).length;
    return { orderId: o.orderId, name: o.name, createdAt: o.createdAt.toISOString(), country: o.country, items: lines.length, ready: ok };
  });
}

/** Variants whose manufacturer code is stored but not yet in the barcode list. */
export async function barcodeSyncCandidates(db: PrismaClient, shopId: string) {
  const rows = await db.variantSnapshot.findMany({
    where: { shopId, inScope: true, nspid: { not: null }, nspidInBarcodes: false },
    select: { variantId: true, barcodes: true },
  });
  return { ids: rows.map((r) => r.variantId), withoutBarcode: rows.filter((r) => r.barcodes.length === 0).length };
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
