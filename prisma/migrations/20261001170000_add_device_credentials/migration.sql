-- Passwordless Android device auth (board task #104, AND1-A2).
--
-- Purely additive: two new tables, an index and two foreign keys. No existing
-- table or column is altered or dropped, so the running pilot keeps working
-- whether or not this migration has been applied yet.

-- CreateTable
CREATE TABLE "DeviceCredential" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL DEFAULT 'ES256',
    "deviceLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "DeviceCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceChallenge" (
    "id" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeviceCredential_driverId_idx" ON "DeviceCredential"("driverId");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceChallenge_nonce_key" ON "DeviceChallenge"("nonce");

-- CreateIndex
CREATE INDEX "DeviceChallenge_credentialId_idx" ON "DeviceChallenge"("credentialId");

-- AddForeignKey
ALTER TABLE "DeviceCredential" ADD CONSTRAINT "DeviceCredential_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceChallenge" ADD CONSTRAINT "DeviceChallenge_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "DeviceCredential"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
