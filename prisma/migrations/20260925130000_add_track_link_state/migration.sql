-- FAv1-F8 (board task #39) — per-trip customer tracking-link state.
--
-- The tracking link itself stays stateless: it is an HMAC over
-- (trip id, version, expiry), signed with a key derived from AUTH_SECRET. These
-- columns only add *per-trip* control on top, which the global key rotation of
-- board task #5 could not give:
--
--   trackLinkVersion    monotonic counter. Revoking a link increments it, so
--                       every token that carries an older version stops
--                       verifying. Re-minting signs the new version.
--   trackLinkIssuedAt   the mint instant, so the identical token can be
--   trackLinkExpiresAt  recomputed for `GET /api/trips/:id/track-link`
--                       (HMAC is deterministic) and shown in the trip detail.
--
-- All three are additive and leave every existing row valid:
-- version defaults to 0 (no link has ever been revoked) and the timestamps are
-- NULL ("no link minted yet"). Safe to apply on a live database.

-- AlterTable
ALTER TABLE "Trip" ADD COLUMN     "trackLinkVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "trackLinkIssuedAt" TIMESTAMP(3),
ADD COLUMN     "trackLinkExpiresAt" TIMESTAMP(3);

-- Rollback (Prisma has no down-migration; run this by hand to reverse it):
--   ALTER TABLE "Trip" DROP COLUMN "trackLinkExpiresAt";
--   ALTER TABLE "Trip" DROP COLUMN "trackLinkIssuedAt";
--   ALTER TABLE "Trip" DROP COLUMN "trackLinkVersion";
