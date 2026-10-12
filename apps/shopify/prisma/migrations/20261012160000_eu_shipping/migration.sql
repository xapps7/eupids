-- EU focus now comes from shipping settings, not orders. No order data is kept.
DROP TABLE IF EXISTS "EuDemand";
DROP TABLE IF EXISTS "EuOrder";
ALTER TABLE "Shop" DROP COLUMN IF EXISTS "euOrderCount";
ALTER TABLE "Shop" ADD COLUMN "euDefaultShips" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN "euCountries" TEXT[] DEFAULT ARRAY[]::TEXT[];
UPDATE "Shop" SET "euSyncStatus" = NULL, "euSyncError" = NULL, "euSyncedAt" = NULL;
ALTER TABLE "Settings" ADD COLUMN "nspidBarcode" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "EuProfileVariant" (
    "shopId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "shipsEu" BOOLEAN NOT NULL,
    "profile" TEXT NOT NULL,
    CONSTRAINT "EuProfileVariant_pkey" PRIMARY KEY ("shopId","variantId")
);
ALTER TABLE "EuProfileVariant" ADD CONSTRAINT "EuProfileVariant_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
