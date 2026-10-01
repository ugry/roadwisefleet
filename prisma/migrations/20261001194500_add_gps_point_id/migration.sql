-- Board task #106 (AND1-A4): idempotent GPS points.
--
-- Additive only: two new NULLABLE columns on "GpsPing" and one new unique
-- index. No existing column, constraint, index or table is altered, so this is
-- safe to apply to the pilot database ahead of the merge.
--
-- `clientId` is the driver app's per-point id. The app queues points offline and
-- replays the batch on reconnect, so the same point can arrive more than once;
-- the ingest writes with `createMany({ skipDuplicates: true })` and this unique
-- index makes the replay a no-op (rule R28). Postgres allows many NULLs under a
-- unique index, so rows written before this column existed stay valid.
ALTER TABLE "GpsPing" ADD COLUMN "accuracyM" INTEGER,
ADD COLUMN "clientId" TEXT;

CREATE UNIQUE INDEX "GpsPing_tripId_clientId_key" ON "GpsPing"("tripId", "clientId");
