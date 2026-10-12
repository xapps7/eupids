-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "name" TEXT,
    "plan" TEXT NOT NULL DEFAULT 'free',
    "trialUsed" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sellsToEu" BOOLEAN,
    "guardAlert" BOOLEAN NOT NULL DEFAULT false,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" TIMESTAMP(3),
    "planCheckedAt" TIMESTAMP(3),

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Settings" (
    "shopId" TEXT NOT NULL,
    "includeDraft" BOOLEAN NOT NULL DEFAULT false,
    "nspidNamespace" TEXT NOT NULL DEFAULT 'customs',
    "nspidKey" TEXT NOT NULL DEFAULT 'manufacturer_product_id',
    "ownBrandVendors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "extraPlaceholders" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "hsAsError" BOOLEAN NOT NULL DEFAULT false,
    "weeklyEmail" BOOLEAN NOT NULL DEFAULT true,
    "mappingRequired" BOOLEAN NOT NULL DEFAULT false,
    "euBannerDismissed" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Settings_pkey" PRIMARY KEY ("shopId")
);

-- CreateTable
CREATE TABLE "Scan" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "bulkOpId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "variantsTotal" INTEGER NOT NULL DEFAULT 0,
    "variantsInScope" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Scan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VariantSnapshot" (
    "shopId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL,
    "variantTitle" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "productType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "requiresShipping" BOOLEAN NOT NULL,
    "isGiftCard" BOOLEAN NOT NULL,
    "sku" TEXT,
    "barcodes" TEXT[],
    "nspid" TEXT,
    "noStandardIdentifier" BOOLEAN NOT NULL DEFAULT false,
    "hsCode" TEXT,
    "countryOfOrigin" TEXT,
    "imageUrl" TEXT,
    "inventoryItemId" TEXT,
    "collectionIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "scanId" TEXT,
    "inScope" BOOLEAN NOT NULL DEFAULT true,
    "ready" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "VariantSnapshot_pkey" PRIMARY KEY ("shopId","variantId")
);

-- CreateTable
CREATE TABLE "Issue" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "ruleCode" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "suggestion" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "Issue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierRequest" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "supplierName" TEXT NOT NULL,
    "supplierEmail" TEXT,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierRequestItem" (
    "requestId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "needsNspid" BOOLEAN NOT NULL,
    "needsBarcode" BOOLEAN NOT NULL,

    CONSTRAINT "SupplierRequestItem_pkey" PRIMARY KEY ("requestId","variantId")
);

-- CreateTable
CREATE TABLE "SupplierSubmission" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "nspid" TEXT,
    "barcode" TEXT,
    "noBarcode" BOOLEAN NOT NULL DEFAULT false,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewStatus" TEXT NOT NULL DEFAULT 'pending',
    "reviewedAt" TIMESTAMP(3),

    CONSTRAINT "SupplierSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "payload" JSONB NOT NULL,
    "total" INTEGER NOT NULL DEFAULT 0,
    "done" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "failures" JSONB NOT NULL DEFAULT '[]',
    "resultFileUrl" TEXT,
    "actor" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "variantId" TEXT,
    "field" TEXT,
    "oldValue" TEXT,
    "newValue" TEXT,
    "count" INTEGER,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "webhookId" TEXT NOT NULL,
    "shopId" TEXT,
    "shopDomain" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("webhookId")
);

-- CreateIndex
CREATE INDEX "Session_shop_idx" ON "Session"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "Shop_domain_key" ON "Shop"("domain");

-- CreateIndex
CREATE INDEX "Scan_shopId_status_idx" ON "Scan"("shopId", "status");

-- CreateIndex
CREATE INDEX "Scan_bulkOpId_idx" ON "Scan"("bulkOpId");

-- CreateIndex
CREATE INDEX "VariantSnapshot_shopId_vendor_idx" ON "VariantSnapshot"("shopId", "vendor");

-- CreateIndex
CREATE INDEX "VariantSnapshot_shopId_productId_idx" ON "VariantSnapshot"("shopId", "productId");

-- CreateIndex
CREATE INDEX "VariantSnapshot_shopId_sku_idx" ON "VariantSnapshot"("shopId", "sku");

-- CreateIndex
CREATE INDEX "Issue_shopId_status_severity_idx" ON "Issue"("shopId", "status", "severity");

-- CreateIndex
CREATE INDEX "Issue_shopId_status_ruleCode_idx" ON "Issue"("shopId", "status", "ruleCode");

-- CreateIndex
CREATE UNIQUE INDEX "Issue_shopId_variantId_ruleCode_key" ON "Issue"("shopId", "variantId", "ruleCode");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierRequest_tokenHash_key" ON "SupplierRequest"("tokenHash");

-- CreateIndex
CREATE INDEX "SupplierRequest_shopId_idx" ON "SupplierRequest"("shopId");

-- CreateIndex
CREATE INDEX "SupplierSubmission_requestId_reviewStatus_idx" ON "SupplierSubmission"("requestId", "reviewStatus");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierSubmission_requestId_variantId_key" ON "SupplierSubmission"("requestId", "variantId");

-- CreateIndex
CREATE INDEX "Job_shopId_status_idx" ON "Job"("shopId", "status");

-- CreateIndex
CREATE INDEX "Job_status_idx" ON "Job"("status");

-- CreateIndex
CREATE INDEX "AuditLog_shopId_at_idx" ON "AuditLog"("shopId", "at");

-- CreateIndex
CREATE INDEX "AuditLog_shopId_actor_action_at_idx" ON "AuditLog"("shopId", "actor", "action", "at");

-- CreateIndex
CREATE INDEX "WebhookEvent_receivedAt_idx" ON "WebhookEvent"("receivedAt");

-- CreateIndex
CREATE INDEX "WebhookEvent_shopDomain_idx" ON "WebhookEvent"("shopDomain");

-- AddForeignKey
ALTER TABLE "Settings" ADD CONSTRAINT "Settings_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Scan" ADD CONSTRAINT "Scan_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VariantSnapshot" ADD CONSTRAINT "VariantSnapshot_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Issue" ADD CONSTRAINT "Issue_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierRequest" ADD CONSTRAINT "SupplierRequest_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierRequestItem" ADD CONSTRAINT "SupplierRequestItem_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "SupplierRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierSubmission" ADD CONSTRAINT "SupplierSubmission_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "SupplierRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
