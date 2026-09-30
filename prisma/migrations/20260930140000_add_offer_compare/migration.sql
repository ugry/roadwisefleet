-- Board task #78 (UXF-C2): the customer offer compare/award screen.
--
-- Additive only: four nullable/defaulted columns on two tables that were
-- introduced by the customer-portal (#74) and marketplace (#76) migrations —
-- never a column on a shared model (User / Customer / Order / Trip), so the
-- running pilot keeps working whether or not this migration has been applied.
-- Both tables are always read with an explicit `select`, so existing reads are
-- unaffected by the new columns.
--
--   MarketplaceOffer.carrierTruck / carrierVerified / cancellationTerms
--     = the compare-screen facets, derived at offer time from the carrier's own
--       rows (never a client value). `carrierRating` is deliberately absent:
--       there is no rating store yet.
--   CustomerProfile.autoMatch
--     = the auto-match rules JSON (max price / min rating / enabled). Stored
--       even while `enabled` is gated on the owner's #73 q6 answer.
--
-- Rollback (manual, for a bad deploy):
--   ALTER TABLE "MarketplaceOffer" DROP COLUMN "cancellationTerms";
--   ALTER TABLE "MarketplaceOffer" DROP COLUMN "carrierTruck";
--   ALTER TABLE "MarketplaceOffer" DROP COLUMN "carrierVerified";
--   ALTER TABLE "CustomerProfile" DROP COLUMN "autoMatch";

-- AlterTable
ALTER TABLE "CustomerProfile" ADD COLUMN     "autoMatch" JSONB;

-- AlterTable
ALTER TABLE "MarketplaceOffer" ADD COLUMN     "cancellationTerms" TEXT,
ADD COLUMN     "carrierTruck" TEXT,
ADD COLUMN     "carrierVerified" BOOLEAN NOT NULL DEFAULT false;
