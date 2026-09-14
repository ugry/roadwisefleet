/**
 * Core trip-loop domain logic, decoupled from Fastify and from Prisma's
 * concrete client so it can be unit-tested against a fake client with the
 * Node.js native test runner (`node --test`, zero install).
 *
 * The route layer (`routes/trips.ts`) only does auth, HTTP mapping and calls
 * into these functions. Status legality stays in `trip-status.js` — the
 * merged state machine remains the single source of truth.
 *
 * Every function takes a `prisma`-like object as its first argument; the real
 * `PrismaClient` and the test fake both satisfy the small surface used here:
 * `trip.findFirst/findMany/create/update`, `order.findFirst`,
 * `user.findFirst`, `truck.findFirst`, `statusEvent.create`, `$transaction`.
 *
 * Mutating functions also take an `actor` (`{ userId, permissions }`) and
 * enforce RBAC here, next to the tenancy check, so a caller cannot persist a
 * trip change without passing an authorization decision. `permissions` is the
 * capability list resolved from the token's role by
 * `auth/permissions.js#loadRolePermissions`.
 */

import { canCreateTrip, canTransitionTrip } from './auth/permissions.js';
import { canTransition, isTripStatus } from './trip-status.js';

/**
 * @typedef {Object} TripsClient
 * @property {any} trip
 * @property {any} order
 * @property {any} user
 * @property {any} truck
 * @property {any} statusEvent
 * @property {(ops: any[]) => Promise<any[]>} $transaction
 */

/** @typedef {{ ok: true, value: any } | { ok: false, error: string, detail?: string }} Normalized */

/**
 * Validate and normalise a create-trip request body.
 * @param {unknown} body
 * @returns {Normalized}
 */
export function normalizeCreateTripInput(body) {
  if (body === null || typeof body !== 'object') {
    return { ok: false, error: 'invalid_input', detail: 'body must be an object' };
  }
  const b = /** @type {Record<string, unknown>} */ (body);
  const orderId = typeof b.orderId === 'string' ? b.orderId.trim() : '';
  if (!orderId) {
    return { ok: false, error: 'invalid_input', detail: 'orderId is required' };
  }
  const driverId = b.driverId === undefined || b.driverId === null ? null : String(b.driverId);
  const truckId = b.truckId === undefined || b.truckId === null ? null : String(b.truckId);
  let rateEur = null;
  if (b.rateEur !== undefined && b.rateEur !== null && b.rateEur !== '') {
    rateEur = Number(b.rateEur);
    if (!Number.isFinite(rateEur) || rateEur < 0) {
      return { ok: false, error: 'invalid_input', detail: 'rateEur must be a non-negative number' };
    }
  }
  return { ok: true, value: { orderId, driverId, truckId, rateEur } };
}

/**
 * Create a DRAFT trip owned by `orgId`, after checking the actor's role has
 * `trip:create`/`trip:*` and confirming the referenced order/driver/truck all
 * belong to that org (tenancy is never trusted from the client).
 * @param {TripsClient} prisma
 * @param {{ orgId: string, body: unknown, actor?: { userId?: string | null, permissions?: unknown } }} args
 * @returns {Promise<{ ok: true, trip: any } | { ok: false, error: string }>}
 */
export async function createTrip(prisma, { orgId, body, actor }) {
  if (!actor || !canCreateTrip(actor.permissions)) return { ok: false, error: 'forbidden' };

  const normalized = normalizeCreateTripInput(body);
  if (!normalized.ok) return { ok: false, error: normalized.error };

  const { orderId, driverId, truckId, rateEur } = normalized.value;

  const order = await prisma.order.findFirst({ where: { id: orderId, customer: { orgId } } });
  if (!order) return { ok: false, error: 'order_not_found' };

  if (driverId) {
    const driver = await prisma.user.findFirst({ where: { id: driverId, orgId } });
    if (!driver) return { ok: false, error: 'driver_not_found' };
  }
  if (truckId) {
    const truck = await prisma.truck.findFirst({ where: { id: truckId, orgId } });
    if (!truck) return { ok: false, error: 'truck_not_found' };
  }

  const trip = await prisma.trip.create({
    data: {
      orgId,
      orderId,
      driverId,
      truckId,
      rateEur,
      status: 'DRAFT',
    },
  });
  return { ok: true, trip };
}

/**
 * Persist a status change, enforcing RBAC (the actor must hold `trip:*` or be
 * the trip's assigned driver with `trip:status`), the state machine, and
 * recording a StatusEvent in the same transaction.
 * @param {TripsClient} prisma
 * @param {{ orgId: string, tripId: string, to: unknown, actor?: { userId?: string | null, permissions?: unknown } }} args
 * @returns {Promise<
 *   { ok: true, trip: any } |
 *   { ok: false, error: 'forbidden' } |
 *   { ok: false, error: 'not_found' | 'invalid_status' } |
 *   { ok: false, error: 'invalid_transition', from: string, to: string }
 * >}
 */
export async function transitionTrip(prisma, { orgId, tripId, to, actor }) {
  const current = await prisma.trip.findFirst({ where: { id: tripId, orgId } });
  if (!current) return { ok: false, error: 'not_found' };

  const authorized = canTransitionTrip({
    granted: actor?.permissions,
    userId: actor?.userId,
    tripDriverId: current.driverId,
  });
  if (!authorized) return { ok: false, error: 'forbidden' };

  const target = String(to ?? '');
  const from = current.status;
  if (!isTripStatus(target)) return { ok: false, error: 'invalid_status' };
  if (!canTransition(from, target)) {
    return { ok: false, error: 'invalid_transition', from, to: target };
  }

  const [trip] = await prisma.$transaction([
    prisma.trip.update({ where: { id: tripId }, data: { status: target } }),
    prisma.statusEvent.create({ data: { tripId, fromStatus: from, toStatus: target } }),
  ]);
  return { ok: true, trip };
}

/**
 * Dashboard trip list: every trip in the org, newest first.
 * @param {TripsClient} prisma
 * @param {{ orgId: string }} args
 * @returns {Promise<any[]>}
 */
export function listOrgTrips(prisma, { orgId }) {
  return prisma.trip.findMany({
    where: { orgId },
    include: { driver: true, truck: true, order: true },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
}

/**
 * Driver view: only the logged-in driver's trips, with live state + stops.
 * @param {TripsClient} prisma
 * @param {{ orgId: string, driverId: string }} args
 * @returns {Promise<any[]>}
 */
export function listDriverTrips(prisma, { orgId, driverId }) {
  return prisma.trip.findMany({
    where: { orgId, driverId },
    include: { order: true, truck: true, stops: true, statusEvents: { orderBy: { happenedAt: 'asc' } } },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
}
