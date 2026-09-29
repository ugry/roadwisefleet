-- Connect marketplace (board task #76, UXF-M1).
--
-- Purely additive TABLES: no existing model gains a scalar column. Every read
-- of `Org`, `User`, `Customer`, `Order` and `Trip` that does not pass an
-- explicit `select` (login, create-trip, the trips list, the dashboard) would
-- fail with P2022 while the database lags this migration, so the marketplace
-- keeps its data in its own tables, touched only by the new `/api/marketplace/*`
-- routes. This migration can be applied at any point in the deploy, before or
-- after the code, without breaking the running pilot (the same discipline as the
-- customer portal, 20260929140000_add_customer_portal).
--
-- Payment is invoice-first in v1 (task #76): escrow waits for the owner's
-- merchant-of-record answer (UXF-OWN1, #73). No money-movement table is created.
--
-- Rollback (manual, only if the deploy is reverted):
--   ALTER TABLE "LoadPosting" DROP CONSTRAINT "LoadPosting_tripId_fkey";
--   DROP TABLE "MarketplaceOffer";
--   DROP TABLE "CapacityBeacon";
--   DROP TABLE "LoadPosting";

-- CreateTable
CREATE TABLE "LoadPosting" (
    "id" TEXT NOT NULL,
    "customerId" TEXT,
    "orgId" TEXT,
    "orderId" TEXT,
    "origin" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "cargo" TEXT,
    "equipment" TEXT,
    "loadReadyAt" TIMESTAMP(3),
    "deliverByAt" TIMESTAMP(3),
    "pricingMode" TEXT NOT NULL DEFAULT 'quotes',
    "priceEur" DECIMAL(12,2),
    "status" TEXT NOT NULL DEFAULT 'POSTED',
    "postedById" TEXT,
    "expiresAt" TIMESTAMP(3),
    "awardedOfferId" TEXT,
    "awardedAt" TIMESTAMP(3),
    "tripId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoadPosting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CapacityBeacon" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "driverId" TEXT,
    "location" TEXT NOT NULL,
    "heading" TEXT,
    "availableFrom" TIMESTAMP(3),
    "equipment" TEXT,
    "minRateEur" DECIMAL(12,2),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CapacityBeacon_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketplaceOffer" (
    "id" TEXT NOT NULL,
    "loadId" TEXT NOT NULL,
    "carrierOrgId" TEXT NOT NULL,
    "carrierUserId" TEXT,
    "carrierName" TEXT NOT NULL,
    "priceEur" DECIMAL(12,2) NOT NULL,
    "pickupEtaAt" TIMESTAMP(3),
    "deliveryEtaAt" TIMESTAMP(3),
    "note" TEXT,
    "side" TEXT NOT NULL DEFAULT 'carrier',
    "status" TEXT NOT NULL DEFAULT 'SENT',
    "parentOfferId" TEXT,
    "createdById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketplaceOffer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LoadPosting_tripId_key" ON "LoadPosting"("tripId");

-- CreateIndex
CREATE INDEX "LoadPosting_status_loadReadyAt_idx" ON "LoadPosting"("status", "loadReadyAt");

-- CreateIndex
CREATE INDEX "LoadPosting_origin_destination_idx" ON "LoadPosting"("origin", "destination");

-- CreateIndex
CREATE INDEX "LoadPosting_customerId_idx" ON "LoadPosting"("customerId");

-- CreateIndex
CREATE INDEX "LoadPosting_orgId_idx" ON "LoadPosting"("orgId");

-- CreateIndex
CREATE INDEX "CapacityBeacon_active_availableFrom_idx" ON "CapacityBeacon"("active", "availableFrom");

-- CreateIndex
CREATE INDEX "CapacityBeacon_orgId_idx" ON "CapacityBeacon"("orgId");

-- CreateIndex
CREATE INDEX "CapacityBeacon_driverId_idx" ON "CapacityBeacon"("driverId");

-- CreateIndex
CREATE INDEX "MarketplaceOffer_loadId_status_idx" ON "MarketplaceOffer"("loadId", "status");

-- CreateIndex
CREATE INDEX "MarketplaceOffer_carrierOrgId_status_idx" ON "MarketplaceOffer"("carrierOrgId", "status");

-- AddForeignKey
ALTER TABLE "LoadPosting" ADD CONSTRAINT "LoadPosting_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoadPosting" ADD CONSTRAINT "LoadPosting_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoadPosting" ADD CONSTRAINT "LoadPosting_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoadPosting" ADD CONSTRAINT "LoadPosting_postedById_fkey" FOREIGN KEY ("postedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoadPosting" ADD CONSTRAINT "LoadPosting_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapacityBeacon" ADD CONSTRAINT "CapacityBeacon_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapacityBeacon" ADD CONSTRAINT "CapacityBeacon_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketplaceOffer" ADD CONSTRAINT "MarketplaceOffer_loadId_fkey" FOREIGN KEY ("loadId") REFERENCES "LoadPosting"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketplaceOffer" ADD CONSTRAINT "MarketplaceOffer_carrierOrgId_fkey" FOREIGN KEY ("carrierOrgId") REFERENCES "Org"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketplaceOffer" ADD CONSTRAINT "MarketplaceOffer_carrierUserId_fkey" FOREIGN KEY ("carrierUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketplaceOffer" ADD CONSTRAINT "MarketplaceOffer_parentOfferId_fkey" FOREIGN KEY ("parentOfferId") REFERENCES "MarketplaceOffer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketplaceOffer" ADD CONSTRAINT "MarketplaceOffer_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
