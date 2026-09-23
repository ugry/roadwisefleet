/**
 * Reference data for the dispatch create-trip form (board task #1).
 *
 * The old form asked the dispatcher to type raw `orderId`/`driverId` strings by
 * hand — unusable for a real dispatcher. These loaders return the small,
 * org-scoped option lists the dashboard needs to render dropdowns instead.
 *
 * Decoupled from Fastify and from Prisma's concrete client so it can be
 * unit-tested against a fake client with the Node.js native test runner
 * (`node --test`, zero install). The route layer
 * (`routes/reference.ts`) only does auth, HTTP mapping and calls in here.
 *
 * Tenancy is always the caller's `orgId` (from the signed token, never the
 * client): every query is scoped so one org can never read another's data.
 *
 * `ACTIVE` drivers: the schema has no `active`/`status` column on `User`, so
 * the closest available signal is the lock state — a user whose `lockedUntil`
 * is in the future is excluded. If a real lifecycle flag is added later, swap
 * the filter here (single place).
 */

/** Seeded driver role id (mirrors `scripts/seed-pilot.ts`). */
export const DRIVER_ROLE_ID = 'driver';

/**
 * Permission a caller must hold to read the create-trip reference lists.
 * Drivers (`trip:read`/`trip:status`/`pod:upload`) do not have it, so the
 * endpoints return 403 for them.
 */
export const REFERENCE_PERMISSION = 'trip:create';

/**
 * @typedef {Object} ReferenceClient
 * @property {any} order
 * @property {any} user
 * @property {any} truck
 * @property {any} customer
 */

/**
 * Orders for the org, newest first, with the customer name folded in so the
 * dropdown label needs no second lookup. Scoped through the `customer`
 * relation because `Order` itself has no `orgId`.
 * @param {ReferenceClient} prisma
 * @param {{ orgId: string }} args
 * @returns {Promise<any[]>}
 */
export function listOrders(prisma, { orgId }) {
  return prisma.order.findMany({
    where: { customer: { orgId } },
    select: {
      id: true,
      origin: true,
      destination: true,
      cargo: true,
      status: true,
      customer: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
}

/**
 * Active drivers in the org (role `driver`, not currently locked), by name.
 * @param {ReferenceClient} prisma
 * @param {{ orgId: string, now?: Date }} args
 * @returns {Promise<any[]>}
 */
export function listDrivers(prisma, { orgId, now = new Date() }) {
  return prisma.user.findMany({
    where: {
      orgId,
      roleId: DRIVER_ROLE_ID,
      OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
    },
    select: { id: true, name: true, phone: true },
    orderBy: { name: 'asc' },
  });
}

/**
 * Trucks in the org, by plate.
 * @param {ReferenceClient} prisma
 * @param {{ orgId: string }} args
 * @returns {Promise<any[]>}
 */
export function listTrucks(prisma, { orgId }) {
  return prisma.truck.findMany({
    where: { orgId },
    select: { id: true, plate: true, dimensions: true, euroClass: true },
    orderBy: { plate: 'asc' },
  });
}

/**
 * Customers in the org, by name.
 * @param {ReferenceClient} prisma
 * @param {{ orgId: string }} args
 * @returns {Promise<any[]>}
 */
export function listCustomers(prisma, { orgId }) {
  return prisma.customer.findMany({
    where: { orgId },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
}

/**
 * The shared reference loader: one round-trip's worth of option lists for the
 * create-trip form. The four individual endpoints and `GET /api/reference`
 * both go through this, so the form and the per-resource APIs can never drift.
 * @param {ReferenceClient} prisma
 * @param {{ orgId: string, now?: Date }} args
 * @returns {Promise<{ orders: any[], drivers: any[], trucks: any[], customers: any[] }>}
 */
export async function loadReferenceData(prisma, { orgId, now }) {
  const [orders, drivers, trucks, customers] = await Promise.all([
    listOrders(prisma, { orgId }),
    listDrivers(prisma, { orgId, now }),
    listTrucks(prisma, { orgId }),
    listCustomers(prisma, { orgId }),
  ]);
  return { orders, drivers, trucks, customers };
}
