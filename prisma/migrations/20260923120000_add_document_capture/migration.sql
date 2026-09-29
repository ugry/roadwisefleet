-- POD capture metadata (board task #4 — driver PWA v1).
--
-- A driver's photo proof of delivery must carry when and where it was taken.
-- Purely additive and nullable: uploaded documents may have no timestamp and no
-- GPS fix (a driver in a basement loading bay denies the position), and every
-- existing row stays valid with NULLs.

-- AlterTable
ALTER TABLE "Document" ADD COLUMN "capturedAt" TIMESTAMP(3),
ADD COLUMN "captureLat" DECIMAL(9,6),
ADD COLUMN "captureLng" DECIMAL(9,6),
ADD COLUMN "captureAccuracyM" INTEGER;
