-- Customer portal v1 (board task #74, UXF-C1).
--
-- Purely additive TABLES: no existing model gains a scalar column. Every read of
-- `User`, `Customer`, `Order` and `Trip` that does not pass an explicit `select`
-- (login, create-trip, the trips list, the dashboard fixtures) would fail with
-- P2022 while the database lags this migration, so the portal keeps its data in
-- its own tables, which only the new `/c/` routes touch. This migration can
-- therefore be applied at any point in the deploy, before or after the code,
-- without breaking the running pilot.
--
-- Rollback (manual, only if the deploy is reverted):
--   DROP TABLE "OrderBooking";
--   DROP TABLE "CustomerProfile";
--   DROP TABLE "CustomerAccount";
--   DROP TABLE "CustomerAddress";

-- CreateTable
CREATE TABLE "CustomerAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerProfile" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "vatId" TEXT,
    "address" TEXT,
    "notifyPrefs" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerAddress" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "line1" TEXT NOT NULL,
    "city" TEXT,
    "postalCode" TEXT,
    "country" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerAddress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderBooking" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "supplyChoice" TEXT NOT NULL,
    "equipment" TEXT,
    "loadReadyAt" TIMESTAMP(3),
    "deliverByAt" TIMESTAMP(3),
    "notes" TEXT,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderBooking_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomerAccount_userId_key" ON "CustomerAccount"("userId");

-- CreateIndex
CREATE INDEX "CustomerAccount_customerId_idx" ON "CustomerAccount"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerProfile_customerId_key" ON "CustomerProfile"("customerId");

-- CreateIndex
CREATE INDEX "CustomerAddress_customerId_idx" ON "CustomerAddress"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderBooking_orderId_key" ON "OrderBooking"("orderId");

-- AddForeignKey
ALTER TABLE "CustomerAccount" ADD CONSTRAINT "CustomerAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerAccount" ADD CONSTRAINT "CustomerAccount_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerProfile" ADD CONSTRAINT "CustomerProfile_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerAddress" ADD CONSTRAINT "CustomerAddress_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderBooking" ADD CONSTRAINT "OrderBooking_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
