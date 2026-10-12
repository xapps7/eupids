// Upsert snapshots with INSERT … ON CONFLICT so concurrent writers (webhook guard,
// inline save, scan batches) never collide on (shopId, variantId).
import { Prisma, type PrismaClient } from "@prisma/client";
import type { SnapshotRow } from "./snapshot";

const COLS = [
  "shopId", "variantId", "productId", "productTitle", "variantTitle", "vendor", "productType", "status",
  "requiresShipping", "isGiftCard", "sku", "barcodes", "nspid", "noStandardIdentifier", "nspidInBarcodes", "hsCode",
  "countryOfOrigin", "imageUrl", "inventoryItemId", "collectionIds", "updatedAt", "scanId", "inScope", "ready",
] as const;

/** Columns refreshed from Shopify on conflict. inScope/ready are left to the evaluator. */
const UPDATE = COLS.filter((c) => !["shopId", "variantId", "inScope", "ready"].includes(c));

// 24 params per row; Postgres allows 32,767 per statement.
const CHUNK = 1000;

export async function upsertSnapshots(db: PrismaClient | Prisma.TransactionClient, rows: SnapshotRow[], opts: { keepScanId?: boolean } = {}) {
  let n = 0;
  for (let i = 0; i < rows.length; i += CHUNK) n += await upsertChunk(db, rows.slice(i, i + CHUNK), opts);
  return n;
}

async function upsertChunk(db: PrismaClient | Prisma.TransactionClient, rows: SnapshotRow[], opts: { keepScanId?: boolean }) {
  if (!rows.length) return 0;
  const values = rows.map(
    (r) =>
      Prisma.sql`(${Prisma.join(
        COLS.map((c) => {
          const v = (r as any)[c];
          if (c === "barcodes" || c === "collectionIds") return Prisma.sql`${v as string[]}::text[]`;
          return Prisma.sql`${v}`;
        }),
      )})`,
  );
  const cols = Prisma.raw(COLS.map((c) => `"${c}"`).join(", "));
  const updates = Prisma.raw(
    UPDATE.filter((c) => !(opts.keepScanId && c === "scanId"))
      .map((c) => `"${c}" = EXCLUDED."${c}"`)
      .join(", "),
  );
  return db.$executeRaw`INSERT INTO "VariantSnapshot" (${cols}) VALUES ${Prisma.join(values)} ON CONFLICT ("shopId", "variantId") DO UPDATE SET ${updates}`;
}
