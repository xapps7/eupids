-- EU orders focus, provider choice, manufacturer code in barcodes.
ALTER TABLE "Shop" ADD COLUMN "euSyncStatus" TEXT, ADD COLUMN "euSyncError" TEXT, ADD COLUMN "euSyncedAt" TIMESTAMP(3), ADD COLUMN "euOrderCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Settings" ADD COLUMN "euOnly" BOOLEAN NOT NULL DEFAULT true, ADD COLUMN "provider" TEXT NOT NULL DEFAULT '';
ALTER TABLE "VariantSnapshot" ADD COLUMN "nspidInBarcodes" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "EuDemand" (
    "shopId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "orders" INTEGER NOT NULL,
    "units" INTEGER NOT NULL,
    "lastOrderAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EuDemand_pkey" PRIMARY KEY ("shopId","variantId")
);

CREATE TABLE "EuOrder" (
    "shopId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "country" TEXT NOT NULL,
    "lines" JSONB NOT NULL,
    CONSTRAINT "EuOrder_pkey" PRIMARY KEY ("shopId","orderId")
);
CREATE INDEX "EuOrder_shopId_createdAt_idx" ON "EuOrder"("shopId", "createdAt");

ALTER TABLE "EuDemand" ADD CONSTRAINT "EuDemand_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EuOrder" ADD CONSTRAINT "EuOrder_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
