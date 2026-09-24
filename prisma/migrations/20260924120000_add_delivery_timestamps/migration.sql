-- FAv1-DB (board task #40) — delivery / planned timestamps.
--
-- The on-time KPI (board task #33, F2) compares the time a trip was actually
-- delivered (`Trip.deliveredAt`) against the time the order was promised for
-- (`Order.plannedAt`). Both columns are nullable and purely additive, so this
-- migration is safe to apply on a live database and leaves every existing row
-- valid (NULL = "not recorded", which the KPI excludes from its denominator).
--
-- This is the ONLY migration for these fields (F2 and FAv1-DB share it).

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "plannedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Trip" ADD COLUMN "deliveredAt" TIMESTAMP(3);

-- Rollback (Prisma has no down-migration; run these by hand to reverse it):
--   ALTER TABLE "Trip" DROP COLUMN "deliveredAt";
--   ALTER TABLE "Order" DROP COLUMN "plannedAt";
