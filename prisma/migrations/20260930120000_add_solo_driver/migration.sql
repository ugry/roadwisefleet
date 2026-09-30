-- Solo driver Connect MVP (board task #77, UXF-M2)
--
-- ADDITIVE-ONLY: three new tables (profile, verification papers, saved
-- searches) and their indexes/foreign keys. No existing table, column,
-- constraint or index is altered or dropped, so the running pilot keeps working
-- whether or not this migration has been applied yet.
--
-- Generated with:
--   prisma migrate diff \
--     --from-schema-datamodel <main schema> \
--     --to-schema-datamodel prisma/schema.prisma --script

-- CreateTable
CREATE TABLE "SoloDriverProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "phone" TEXT,
    "phoneVerifiedAt" TIMESTAMP(3),
    "otpHash" TEXT,
    "otpExpiresAt" TIMESTAMP(3),
    "otpAttempts" INTEGER NOT NULL DEFAULT 0,
    "verificationStatus" TEXT NOT NULL DEFAULT 'NONE',
    "verificationNote" TEXT,
    "truckPlate" TEXT,
    "truckEquipment" TEXT,
    "truckCapacityKg" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SoloDriverProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SoloVerificationDoc" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "docType" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "filename" TEXT,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SoloVerificationDoc_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SoloSavedSearch" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "filter" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SoloSavedSearch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SoloDriverProfile_userId_key" ON "SoloDriverProfile"("userId");

-- CreateIndex
CREATE INDEX "SoloDriverProfile_verificationStatus_idx" ON "SoloDriverProfile"("verificationStatus");

-- CreateIndex
CREATE INDEX "SoloVerificationDoc_driverId_docType_idx" ON "SoloVerificationDoc"("driverId", "docType");

-- CreateIndex
CREATE INDEX "SoloSavedSearch_driverId_idx" ON "SoloSavedSearch"("driverId");

-- AddForeignKey
ALTER TABLE "SoloDriverProfile" ADD CONSTRAINT "SoloDriverProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SoloDriverProfile" ADD CONSTRAINT "SoloDriverProfile_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SoloVerificationDoc" ADD CONSTRAINT "SoloVerificationDoc_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SoloSavedSearch" ADD CONSTRAINT "SoloSavedSearch_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
