/**
 * Trip driver assignment / reassignment (board task #36, FAv1-F5).
 *
 * Dispatch without reassignment is not dispatch: the create-trip form (F4) can
 * put a driver on a new trip, but a dispatcher must also be able to change the
 * driver of an existing trip — a breakdown, a shift change, a suspension. This
 * module is that change, and it is deliberately a *status event*: the acting
 * user is recorded next to the change, so the trip timeline answers "who put
 * whom on this trip, and when".
 *
 * The state machine (`trip-status.js`) does not move: a reassignment keeps the
 * current status, so the event it writes has `fromStatus === toStatus`. That
 * same-status shape is what `trip-detail.js` renders as a reassignment; a normal
 * transition always changes the status.
 *
 * Decoupled from Fastify and from Prisma's concrete client so it can be
 * unit-tested against a fake client with the Node.js native test runner
 * (`node --test`, zero install). The route layer (`routes/trips.ts`) only does
 * auth, HTTP mapping and calls in here.
 *
 * Tenancy is always the caller's `orgId` (from the signed token, never the
 * client): both the trip and the new driver must belong to that org, so one org
 * can never assign another org's driver.
 */

import { hasPermission } from './auth/permissions.js';
import { isTerminal } from './trip-status.js';

/**
 * Permission a caller must hold to assign/reassign a trip's driver. The seeded
 * owner and dispatcher roles hold `trip:*`, which grants every trip action, so
 * they pass; a driver holds neither `trip:assign` nor `trip:*` and is refused.
 */
export const TRIP_ASSIGN_PERMISSION = 'trip:assign';

/**
 * The role a new assignee must have. The schema has no `active`/`status` column
 * on `User`, so "suspended/unavailable" is read from the lock state — the same
 * signal `reference-data.js#listDrivers` uses for its ACTIVE driver list.
 */
export const DRIVER_ROLE_ID = 'driver';

/**
 * @typedef {Object} AssignmentClient
 * @property {any} trip
 * @property {any} user
 * @property {any} statusEvent
 * @property {(ops: any[]) => Promise<any[]>} $transaction
 */

/** @typedef {{ ok: true, value: { driverId: string } } | { ok: false, error: string, detail?: string }} Normalized */

/**
 * Is this user a driver who can take a trip right now? Must hold the driver role
 * and must not be locked (`lockedUntil` in the future).
 * @param {any} user
 * @param {{ now?: Date|string|number }} [opts]
 * @returns {boolean}
 */
export function isDriverAvailable(user, opts = {}) {
  if (!user || typeof user !== 'object') return false;
  if (user.roleId !== DRIVER_ROLE_ID) return false;
  if (!user.lockedUntil) return true;
  const now = opts.now === undefined ? new Date() : new Date(opts.now);
  const until = user.lockedUntil instanceof Date ? user.lockedUntil : new Date(user.lockedUntil);
  if (Number.isNaN(now.getTime()) || Number.isNaN(until.getTime())) return false;
  return until.getTime() <= now.getTime();
}

/**
 * Does the actor hold the capability to change a trip's driver?
 * @param {unknown} granted
 * @returns {boolean}
 */
export function canAssignDriver(granted) {
  return hasPermission(granted, TRIP_ASSIGN_PERMISSION);
}

/**
 * Validate an assignment request body: a non-empty `driverId` is required.
 * @param {unknown} body
 * @returns {Normalized}
 */
export function parseAssignmentInput(body) {
  if (body === null || typeof body !== 'object') {
    return { ok: false, error: 'invalid_input', detail: 'body must be an object' };
  }
  const b = /** @type {Record<string, unknown>} */ (body);
  const driverId = typeof b.driverId === 'string' ? b.driverId.trim() : '';
  if (!driverId) {
    return { ok: false, error: 'invalid_input', detail: 'driverId is required' };
  }
  return { ok: true, value: { driverId } };
}

/**
 * Assign or reassign the driver of one org trip, recording the change as a
 * status event naming the acting user — all in one transaction, so the trip row
 * and its timeline can never disagree.
 *
 * Refusals (each mapped to an HTTP status by `http-errors.js`):
 *   forbidden          the actor lacks `trip:assign` (a driver can never do this)
 *   invalid_input      the body carries no usable `driverId`
 *   not_found          the trip is unknown or in another org
 *   trip_closed        the trip is SETTLED/CANCELLED — no driver changes after
 *                      the lifecycle ends
 *   already_assigned   the named driver already has the trip (nothing to record)
 *   driver_not_found   the user does not exist in this org
 *   driver_unavailable the user is not a driver, or is locked/suspended
 *
 * @param {AssignmentClient} prisma
 * @param {{ orgId: string, tripId: string, body: unknown, actor?: { userId?: string | null, permissions?: unknown }, now?: Date|string|number }} args
 * @returns {Promise<
 *   { ok: true, trip: any, driver: { id: string, name: string }|null, previousDriverId: string|null } |
 *   { ok: false, error: string, detail?: string }
 * >}
 */
export async function assignDriver(prisma, { orgId, tripId, body, actor, now }) {
  if (!actor || !canAssignDriver(actor.permissions)) return { ok: false, error: 'forbidden' };

  const normalized = parseAssignmentInput(body);
  if (!normalized.ok) return { ok: false, error: normalized.error, detail: normalized.detail };
  const { driverId } = normalized.value;

  const current = await prisma.trip.findFirst({ where: { id: tripId, orgId } });
  if (!current) return { ok: false, error: 'not_found' };

  if (isTerminal(current.status)) return { ok: false, error: 'trip_closed' };

  const previousDriverId = current.driverId ?? null;
  if (previousDriverId === driverId) return { ok: false, error: 'already_assigned' };

  const driver = await prisma.user.findFirst({ where: { id: driverId, orgId } });
  if (!driver) return { ok: false, error: 'driver_not_found' };
  if (!isDriverAvailable(driver, { now })) return { ok: false, error: 'driver_unavailable' };

  // One transaction: the trip row and the timeline entry it must explain. The
  // status deliberately does not move — the event is the record of who acted.
  const [trip] = await prisma.$transaction([
    prisma.trip.update({ where: { id: tripId }, data: { driverId } }),
    prisma.statusEvent.create({
      data: {
        tripId,
        fromStatus: current.status,
        toStatus: current.status,
        actorId: actor.userId ?? null,
      },
    }),
  ]);

  return {
    ok: true,
    trip,
    driver: { id: driver.id, name: driver.name ?? null },
    previousDriverId,
  };
}
