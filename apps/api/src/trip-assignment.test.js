/**
 * Trip driver assign/reassign (board task #36, FAv1-F5) — dependency-free
 * coverage for the core, run by the no-install CI job
 * (`node --test apps/api/src/`): `node:*` builtins only, no Fastify, no Prisma,
 * no HTTP. The HTTP-level acceptance (real route, real DB, before/after driver
 * views) lives in `apps/api/test/trip-assign.test.ts` (`pnpm test:router`).
 *
 * The contract under test:
 *   - only a `trip:*` holder may assign (a driver is forbidden, always);
 *   - the change keeps the trip's status and writes exactly one status event
 *     naming the acting user — in one transaction with the trip update;
 *   - the trip and the new driver must belong to the caller's org;
 *   - a locked/suspended (or non-driver) assignee is refused before any write.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assignDriver,
  canAssignDriver,
  DRIVER_ROLE_ID,
  isDriverAvailable,
  parseAssignmentInput,
  TRIP_ASSIGN_PERMISSION,
} from './trip-assignment.js';

/** Actors mirror the seeded roles (owner/dispatcher `trip:*`, driver limited). */
const OWNER = { userId: 'admin', permissions: ['org:manage', 'trip:*'] };
const DISPATCHER = { userId: 'disp', permissions: ['trip:*', 'user:read'] };
const DRIVER = { userId: 'd1', permissions: ['trip:read', 'trip:status', 'pod:upload'] };

const LOCKED_UNTIL = new Date('2026-10-01T00:00:00.000Z');
const NOW = new Date('2026-09-24T12:00:00.000Z');

/**
 * Minimal in-memory fake of the Prisma surface the module uses, so the decision
 * path is testable without a database. `$transaction` joins like the real one.
 */
function makeFakePrisma() {
  const state = {
    trips: [
      { id: 't1', orgId: 'org1', status: 'ASSIGNED', driverId: 'd1' },
      { id: 't-draft', orgId: 'org1', status: 'DRAFT', driverId: null },
      { id: 't-closed', orgId: 'org1', status: 'SETTLED', driverId: 'd1' },
      { id: 't-other-org', orgId: 'org2', status: 'ASSIGNED', driverId: 'x1' },
    ],
    users: [
      { id: 'd1', orgId: 'org1', roleId: DRIVER_ROLE_ID, name: 'Dana Driver' },
      { id: 'd2', orgId: 'org1', roleId: DRIVER_ROLE_ID, name: 'Sam Second' },
      { id: 'locked', orgId: 'org1', roleId: DRIVER_ROLE_ID, name: 'Lou Locked', lockedUntil: LOCKED_UNTIL },
      { id: 'admin', orgId: 'org1', roleId: 'owner', name: 'Pilot Admin' },
      { id: 'x1', orgId: 'org2', roleId: DRIVER_ROLE_ID, name: 'Other Org' },
    ],
    events: /** @type {any[]} */ ([]),
  };
  const match = (row, where) =>
    Object.entries(where ?? {}).every(([key, value]) => row[key] === value);
  const client = {
    state,
    trip: {
      findFirst: async ({ where }) => state.trips.find((t) => match(t, where)) ?? null,
      update: async ({ where, data }) => {
        const idx = state.trips.findIndex((t) => t.id === where.id);
        const updated = { ...state.trips[idx], ...data };
        state.trips[idx] = updated;
        return updated;
      },
    },
    user: { findFirst: async ({ where }) => state.users.find((u) => match(u, where)) ?? null },
    statusEvent: {
      create: async ({ data }) => {
        state.events.push(data);
        return data;
      },
    },
    $transaction: async (ops) => Promise.all(ops),
  };
  return client;
}

// --- the pure pieces --------------------------------------------------------

test('parseAssignmentInput requires a non-empty driverId', () => {
  assert.deepEqual(parseAssignmentInput({ driverId: 'd2' }), { ok: true, value: { driverId: 'd2' } });
  assert.deepEqual(parseAssignmentInput({ driverId: ' d2 ' }), { ok: true, value: { driverId: 'd2' } });
  for (const bad of [null, {}, { driverId: '' }, { driverId: '   ' }, { driverId: 42 }, { driverId: null }]) {
    const parsed = parseAssignmentInput(bad);
    assert.equal(parsed.ok, false, JSON.stringify(bad));
    assert.equal(parsed.error, 'invalid_input');
  }
  assert.match(parseAssignmentInput({}).detail, /driverId/);
});

test('canAssignDriver follows trip:* / trip:assign and denies drivers', () => {
  assert.equal(canAssignDriver(OWNER.permissions), true);
  assert.equal(canAssignDriver(DISPATCHER.permissions), true);
  assert.equal(canAssignDriver(['trip:assign']), true);
  assert.equal(canAssignDriver(DRIVER.permissions), false);
  assert.equal(canAssignDriver(['trip:read', 'trip:status']), false);
  assert.equal(canAssignDriver([]), false);
  assert.equal(canAssignDriver(null), false);
  assert.equal(TRIP_ASSIGN_PERMISSION, 'trip:assign');
});

test('isDriverAvailable excludes lock/suspension and non-drivers', () => {
  assert.equal(isDriverAvailable({ roleId: 'driver' }, { now: NOW }), true);
  assert.equal(isDriverAvailable({ roleId: 'driver', lockedUntil: null }, { now: NOW }), true);
  // Locked in the future -> unavailable; lock already expired -> available.
  assert.equal(isDriverAvailable({ roleId: 'driver', lockedUntil: LOCKED_UNTIL }, { now: NOW }), false);
  assert.equal(isDriverAvailable({ roleId: 'driver', lockedUntil: new Date('2026-09-01T00:00:00Z') }, { now: NOW }), true);
  assert.equal(isDriverAvailable({ roleId: 'owner' }, { now: NOW }), false);
  assert.equal(isDriverAvailable(null, { now: NOW }), false);
});

// --- authorisation ----------------------------------------------------------

test('a driver can never assign, and nothing is written', async () => {
  const prisma = makeFakePrisma();
  const result = await assignDriver(prisma, {
    orgId: 'org1',
    tripId: 't1',
    body: { driverId: 'd2' },
    actor: DRIVER,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'forbidden');
  assert.equal(prisma.state.trips[0].driverId, 'd1', 'the trip is untouched');
  assert.equal(prisma.state.events.length, 0, 'a denial writes no timeline event');
});

test('a missing actor is denied by default', async () => {
  const prisma = makeFakePrisma();
  assert.equal((await assignDriver(prisma, { orgId: 'org1', tripId: 't1', body: { driverId: 'd2' } })).error, 'forbidden');
});

// --- the happy path ---------------------------------------------------------

test('reassigning keeps the status and records a status event naming the actor', async () => {
  const prisma = makeFakePrisma();
  const result = await assignDriver(prisma, {
    orgId: 'org1',
    tripId: 't1',
    body: { driverId: 'd2' },
    actor: DISPATCHER,
    now: NOW,
  });

  assert.equal(result.ok, true);
  assert.equal(prisma.state.trips[0].driverId, 'd2', 'the trip carries the new driver');
  assert.equal(prisma.state.trips[0].status, 'ASSIGNED', 'the status does not move');
  assert.equal(result.previousDriverId, 'd1');
  assert.deepEqual(result.driver, { id: 'd2', name: 'Sam Second' });

  assert.equal(prisma.state.events.length, 1, 'exactly one timeline event');
  assert.deepEqual(prisma.state.events[0], {
    tripId: 't1',
    fromStatus: 'ASSIGNED',
    toStatus: 'ASSIGNED',
    actorId: 'disp',
  });
});

test('a DRAFT trip can be given a first driver', async () => {
  const prisma = makeFakePrisma();
  const result = await assignDriver(prisma, {
    orgId: 'org1',
    tripId: 't-draft',
    body: { driverId: 'd2' },
    actor: OWNER,
    now: NOW,
  });
  assert.equal(result.ok, true);
  assert.equal(prisma.state.trips[1].driverId, 'd2');
  assert.equal(result.previousDriverId, null, 'there was no previous driver');
  assert.equal(prisma.state.events[0].fromStatus, 'DRAFT');
  assert.equal(prisma.state.events[0].toStatus, 'DRAFT');
});

// --- refusals ---------------------------------------------------------------

test('a trip outside the org is not found (never an existence leak)', async () => {
  const prisma = makeFakePrisma();
  assert.equal((await assignDriver(prisma, { orgId: 'org1', tripId: 't-other-org', body: { driverId: 'd2' }, actor: OWNER })).error, 'not_found');
  assert.equal((await assignDriver(prisma, { orgId: 'org1', tripId: 'ghost', body: { driverId: 'd2' }, actor: OWNER })).error, 'not_found');
  assert.equal(prisma.state.events.length, 0);
});

test('a driver outside the org cannot be assigned', async () => {
  const prisma = makeFakePrisma();
  const result = await assignDriver(prisma, { orgId: 'org1', tripId: 't1', body: { driverId: 'x1' }, actor: OWNER });
  assert.equal(result.error, 'driver_not_found');
  assert.equal(prisma.state.trips[0].driverId, 'd1');
});

test('reassigning to a suspended (locked) driver is refused before any write', async () => {
  const prisma = makeFakePrisma();
  const result = await assignDriver(prisma, {
    orgId: 'org1',
    tripId: 't1',
    body: { driverId: 'locked' },
    actor: OWNER,
    now: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'driver_unavailable');
  assert.equal(prisma.state.trips[0].driverId, 'd1', 'the trip is untouched');
  assert.equal(prisma.state.events.length, 0, 'no event for a refused assignment');
});

test('a user who is not a driver cannot be assigned', async () => {
  const prisma = makeFakePrisma();
  assert.equal((await assignDriver(prisma, { orgId: 'org1', tripId: 't1', body: { driverId: 'admin' }, actor: OWNER, now: NOW })).error, 'driver_unavailable');
});

test('the current driver is already assigned — no duplicate event', async () => {
  const prisma = makeFakePrisma();
  const result = await assignDriver(prisma, { orgId: 'org1', tripId: 't1', body: { driverId: 'd1' }, actor: OWNER, now: NOW });
  assert.equal(result.error, 'already_assigned');
  assert.equal(prisma.state.events.length, 0);
});

test('a settled or cancelled trip takes no driver change', async () => {
  const prisma = makeFakePrisma();
  const result = await assignDriver(prisma, { orgId: 'org1', tripId: 't-closed', body: { driverId: 'd2' }, actor: OWNER, now: NOW });
  assert.equal(result.error, 'trip_closed');
  assert.equal(prisma.state.trips[2].driverId, 'd1');
});

test('an invalid body is refused before the trip is even read', async () => {
  const prisma = makeFakePrisma();
  const result = await assignDriver(prisma, { orgId: 'org1', tripId: 'ghost', body: {}, actor: OWNER });
  assert.equal(result.error, 'invalid_input');
  assert.match(result.detail, /driverId/);
});
