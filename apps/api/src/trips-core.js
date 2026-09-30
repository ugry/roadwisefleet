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
 * `user.findFirst`, `truck.findFirst`, `statusEvent.create`, `document.count`,
 * `$transaction`.
 *
 * Mutating functions also take an `actor` (`{ userId, permissions }`) and
 * enforce RBAC here, next to the tenancy check, so a caller cannot persist a
 * trip change without passing an authorization decision. `permissions` is the
 * capability list resolved from the token's role by
 * `auth/permissions.js#loadRolePermissions`.
 */

import { canCreateTrip, canTransitionTrip } from './auth/permissions.js';
import { canTransition, isTripStatus } from './trip-status.js';
import { hasPodDocument } from './documents.js';
import { buildTripWhere } from './trip-filters.js';
import { publicUserSelect } from './user-payload.js';

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
 * Parse an optional planned-delivery timestamp (board task #66). Accepts a Date,
 * an ISO-8601 string or epoch milliseconds. Empty/absent is a valid `null` (the
 * plan is optional data); anything present but unparseable is refused so a typo
 * can never silently store an Invalid Date.
 * @param {unknown} value
 * @returns {{ ok: true, value: Date|null } | { ok: false }}
 */
export function parsePlannedAt(value) {
  if (value === undefined || value === null || value === '') return { ok: true, value: null };
  const date = value instanceof Date ? value : new Date(/** @type {any} */ (value));
  if (Number.isNaN(date.getTime())) return { ok: false };
  return { ok: true, value: date };
}

/**
 * Coerce an optional clock value to a Date (board task #66). Absent → now, so
 * production callers pass nothing while tests can pin the instant.
 * @param {Date|string|number|undefined} value
 * @returns {Date}
 */
function toDate(value) {
  if (value === undefined) return new Date();
  return value instanceof Date ? value : new Date(/** @type {any} */ (value));
}

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
  // Board task #66: the promised delivery time may be supplied when the trip is
  // dispatched (optional, nullable). It is recorded on the order.
  const plannedAt = parsePlannedAt(b.plannedAt);
  if (!plannedAt.ok) {
    return { ok: false, error: 'invalid_input', detail: 'plannedAt must be a valid ISO-8601 date' };
  }
  return { ok: true, value: { orderId, driverId, truckId, rateEur, plannedAt: plannedAt.value } };
}

/**
 * Create a DRAFT trip owned by `orgId`, after checking the actor's role has
 * `trip:create`/`trip:*` and confirming the referenced order/driver/truck all
 * belong to that org (tenancy is never trusted from the client).
 * @param {TripsClient} prisma
 * @param {{ orgId: string, body: unknown, actor?: { userId?: string | null, permissions?: unknown } }} args
 * @returns {Promise<{ ok: true, trip: any } | { ok: false, error: string, detail?: string }>}
 */
export async function createTrip(prisma, { orgId, body, actor }) {
  if (!actor || !canCreateTrip(actor.permissions)) return { ok: false, error: 'forbidden' };

  const normalized = normalizeCreateTripInput(body);
  // Carry the field-level `detail` through so the route (and the dispatch form)
  // can say which field failed, not just "invalid_input".
  if (!normalized.ok) return { ok: false, error: normalized.error, detail: normalized.detail };

  const { orderId, driverId, truckId, rateEur, plannedAt } = normalized.value;

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

  const data = {
    orgId,
    orderId,
    driverId,
    truckId,
    rateEur,
    status: 'DRAFT',
  };

  // Board task #66: when the dispatcher records the promised delivery time, it
  // is written on the order (the entity the on-time KPI compares against) in the
  // same transaction as the trip, so a trip can never be dispatched without the
  // plan it was dispatched under — and vice versa.
  if (plannedAt) {
    const [, trip] = await prisma.$transaction([
      prisma.order.update({ where: { id: orderId }, data: { plannedAt } }),
      prisma.trip.create({ data }),
    ]);
    return { ok: true, trip };
  }

  const trip = await prisma.trip.create({ data });
  return { ok: true, trip };
}

/**
 * Persist a status change, enforcing RBAC (the actor must hold `trip:*` or be
 * the trip's assigned driver with `trip:status`), the state machine, and
 * recording a StatusEvent in the same transaction.
 * @param {TripsClient} prisma
 * @param {{ orgId: string, tripId: string, to: unknown, actor?: { userId?: string | null, permissions?: unknown }, now?: Date|string|number }} args
 * @returns {Promise<
 *   { ok: true, trip: any } |
 *   { ok: false, error: 'forbidden' } |
 *   { ok: false, error: 'not_found' | 'invalid_status' | 'pod_required' } |
 *   { ok: false, error: 'invalid_transition', from: string, to: string }
 * >}
 */
export async function transitionTrip(prisma, { orgId, tripId, to, actor, now }) {
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

  // Board task #3: a trip can only reach POD_UPLOADED once a POD/eCMR document
  // has actually been uploaded (or verified).
  if (target === 'POD_UPLOADED' && !(await hasPodDocument(prisma, { tripId }))) {
    return { ok: false, error: 'pod_required' };
  }

  /** @type {{ status: string, deliveredAt?: Date }} */
  const updateData = { status: target };
  // Board task #66: the moment a trip becomes DELIVERED is the actual delivery
  // time the on-time KPI reads (`deliveredAt`). Written in the same transaction
  // as the status event, so the timeline and the KPI can never disagree. The
  // `now` argument exists for deterministic tests; production always uses the
  // wall clock.
  if (target === 'DELIVERED') updateData.deliveredAt = toDate(now);

  const [trip] = await prisma.$transaction([
    prisma.trip.update({ where: { id: tripId }, data: updateData }),
    prisma.statusEvent.create({
      data: {
        tripId,
        fromStatus: from,
        toStatus: target,
        // Who moved the trip, for the detail timeline (board task #2).
        actorId: actor?.userId ?? null,
      },
    }),
  ]);
  return { ok: true, trip };
}

/**
 * Dashboard trip list: every trip in the org, newest first, optionally narrowed
 * by the validated filters from `trip-filters.js` (status / driver / created-at
 * window / free text). Board task #34 (F3).
 *
 * The driver relation is loaded with an explicit public `select` (board task
 * #63): including the whole driver row returned every `User` column, credentials
 * included. `truck`/`order` carry no credential fields.
 * @param {TripsClient} prisma
 * @param {{ orgId: string, filters?: import('./trip-filters.js').TripFilters }} args
 * @returns {Promise<any[]>}
 */
export function listOrgTrips(prisma, { orgId, filters }) {
  return prisma.trip.findMany({
    where: buildTripWhere({ orgId, filters }),
    include: { driver: { select: publicUserSelect() }, truck: true, order: true },
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
