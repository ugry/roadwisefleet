-- Email one-time codes (board task #125).
--
-- Additive only: one new table plus two indexes. No existing table, column,
-- constraint or index is touched, so the deployer can apply it to the pilot in
-- any order relative to this merge.
CREATE TABLE "EmailOtp" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailOtp_pkey" PRIMARY KEY ("id")
);

-- One lookup shape: the newest code for (address, purpose).
CREATE INDEX "EmailOtp_email_purpose_createdAt_idx" ON "EmailOtp"("email", "purpose", "createdAt");

-- Housekeeping: expired rows are cheap to sweep.
CREATE INDEX "EmailOtp_expiresAt_idx" ON "EmailOtp"("expiresAt");
