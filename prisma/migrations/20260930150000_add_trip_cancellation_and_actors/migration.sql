-- 20260930150000_add_trip_cancellation_and_actors
-- Forward-fix for the schema drift introduced when the docs PR #61 merged
-- prisma/schema.prisma changes (Trip cancellation fields + Request /
-- CancellationPolicy / TripActor) without a migration. Additive-only and
-- idempotent: safe to apply on the already-patched pilot DB and on a fresh DB.

ALTER TABLE "Trip" ADD COLUMN IF NOT EXISTS "cancellationFeeEur" DECIMAL(12,2),
                   ADD COLUMN IF NOT EXISTS "cancellationReasonCode" TEXT,
                   ADD COLUMN IF NOT EXISTS "cancelledById" TEXT;

CREATE TABLE IF NOT EXISTS "Request" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "tripId" TEXT,
    "type" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "subjectUserId" TEXT,
    "reasonCode" TEXT,
    "note" TEXT,
    "evidenceDocIds" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "slaDueAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "policySnapshot" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Request_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Request_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "CancellationPolicy" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "customerId" TEXT,
    "freeNoticeHours" INTEGER NOT NULL DEFAULT 12,
    "lateCancelFeePct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "requireEvidence" BOOLEAN NOT NULL DEFAULT false,
    "slaMinutes" INTEGER NOT NULL DEFAULT 120,
    "autoApproveEvidence" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CancellationPolicy_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "TripActor" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "userId" TEXT,
    "orgId" TEXT,
    "relationship" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TripActor_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TripActor_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "Request_orgId_status_idx" ON "Request"("orgId", "status");
CREATE INDEX IF NOT EXISTS "Request_tripId_idx" ON "Request"("tripId");
CREATE INDEX IF NOT EXISTS "TripActor_tripId_idx" ON "TripActor"("tripId");
