-- Board task #105 (AND1-A3): live GPS tracking on a trip.
--
-- Additive only: two new columns on "Trip" (one NOT NULL with a default, one
-- nullable). No existing column, constraint or index is altered, so this is
-- safe to apply to the pilot database ahead of the merge.
ALTER TABLE "Trip" ADD COLUMN "tracking" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Trip" ADD COLUMN "trackingStartedAt" TIMESTAMP(3);
