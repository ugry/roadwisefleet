/**
 * Connect marketplace — the lazy expiry sweep (board tasks #76 / #78).
 *
 * Diagram 05: an offer (and the load it answers) expires. The sweep runs on the
 * reads that are about to show open rows, so an expired row becomes EXPIRED
 * state instead of a render-time illusion — and, because it is persisted, the
 * state survives a refresh.
 *
 * Shared by `routes/marketplace.ts` (carrier/shipper) and `routes/customer.ts`
 * (the customer compare screen) so the one expiry rule cannot drift. Prisma is
 * passed in, so the module holds no client of its own.
 */

const OPEN_LOADS = ['POSTED', 'OFFERS'];
const OPEN_OFFERS = ['SENT', 'VIEWED'];

/**
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string[]} [loadIds] when given, only these loads' open rows are swept
 * @returns {Promise<void>}
 */
export async function sweepExpired(prisma, loadIds) {
  const now = new Date();
  const loadWhere = { status: { in: OPEN_LOADS }, expiresAt: { lte: now } };
  if (loadIds) loadWhere.id = { in: loadIds };
  await prisma.loadPosting.updateMany({ where: loadWhere, data: { status: 'EXPIRED' } });

  const offerWhere = { status: { in: OPEN_OFFERS }, expiresAt: { lte: now } };
  if (loadIds) offerWhere.loadId = { in: loadIds };
  await prisma.marketplaceOffer.updateMany({ where: offerWhere, data: { status: 'EXPIRED', decidedAt: now } });
}
