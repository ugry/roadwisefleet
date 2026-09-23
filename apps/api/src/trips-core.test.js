import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createTrip,
  listDriverTrips,
  listOrgTrips,
  normalizeCreateTripInput,
  transitionTrip,
} from './trips-core.js';

/** Actors mirror the seeded roles (owner/dispatcher `trip:*`, driver limited). */
const OWNER = { userId: 'admin', permissions: ['org:manage', 'trip:*'] };
const DISPATCHER = { userId: 'disp', permissions: ['trip:*', 'user:read'] };
const DRIVER1 = { userId: 'd1', permissions: ['trip:read', 'trip:status', 'pod:upload'] };
const DRIVER2 = { userId: 'd2', permissions: ['trip:read', 'trip:status'] };


/**
 * Minimal in-memory fake of the Prisma surface trips-core.js uses, so the
 * core loop can be tested without a database.
 */
function makeFakePrisma() {
  let seq = 0;
  const state = {
    orders: [{ id: 'o1', orgId: 'org1' }],
    users: [
      { id: 'd1', orgId: 'org1', roleId: 'driver' },
      { id: 'x1', orgId: 'org2', roleId: 'driver' },
    ],
    trucks: [{ id: 't1', orgId: 'org1' }],
    trips: /** @type {any[]} */ ([]),
    events: /** @type {any[]} */ ([]),
    docs: /** @type {any[]} */ ([]),
  };
  const match = (row, where) => {
    for (const [k, v] of Object.entries(where ?? {})) {
      if (k === 'customer') {
        if (v?.orgId !== 'org1' || !state.orders.some((o) => o.id === row.id && o.orgId === 'org1')) {
          return false;
        }
        continue;
      }
      if (row[k] !== v) return false;
    }
    return true;
  };
  const client = {
    state,
    order: { findFirst: async ({ where }) => state.orders.find((o) => match(o, where)) ?? null },
    user: { findFirst: async ({ where }) => state.users.find((u) => match(u, where)) ?? null },
    truck: { findFirst: async ({ where }) => state.trucks.find((t) => match(t, where)) ?? null },
    trip: {
      create: async ({ data }) => {
        const trip = { id: `trip${++seq}`, createdAt: new Date(), ...data };
        state.trips.push(trip);
        return trip;
      },
      findFirst: async ({ where }) => state.trips.find((t) => match(t, where)) ?? null,
      findMany: async ({ where }) => state.trips.filter((t) => match(t, where)),
      update: async ({ where, data }) => {
        // Replace with a new object, like Prisma does, so an earlier
        // findFirst() snapshot is not mutated by the update.
        const idx = state.trips.findIndex((t) => t.id === where.id);
        const updated = { ...state.trips[idx], ...data };
        state.trips[idx] = updated;
        return updated;
      },
    },
    statusEvent: {
      create: async ({ data }) => {
        state.events.push(data);
        return data;
      },
    },
    document: {
      count: async ({ where }) =>
        state.docs.filter((d) => {
          if (d.tripId !== where.tripId) return false;
          if (where.docType?.in && !where.docType.in.includes(d.docType)) return false;
          if (where.status?.in && !where.status.in.includes(d.status)) return false;
          return true;
        }).length,
    },
    $transaction: async (ops) => Promise.all(ops),
  };
  return client;
}

test('normalizeCreateTripInput requires an orderId and validates rateEur', () => {
  assert.deepEqual(normalizeCreateTripInput({ orderId: 'o1' }), {
    ok: true,
    value: { orderId: 'o1', driverId: null, truckId: null, rateEur: null },
  });
  assert.equal(normalizeCreateTripInput(null).ok, false);
  assert.equal(normalizeCreateTripInput({}).error, 'invalid_input');
  assert.equal(normalizeCreateTripInput({ orderId: '  ' }).error, 'invalid_input');
  assert.equal(normalizeCreateTripInput({ orderId: 'o1', rateEur: -1 }).error, 'invalid_input');
  assert.equal(normalizeCreateTripInput({ orderId: 'o1', rateEur: 'abc' }).error, 'invalid_input');
  const ok = normalizeCreateTripInput({ orderId: ' o1 ', driverId: 'd1', truckId: 't1', rateEur: '12.5' });
  assert.deepEqual(ok, {
    ok: true,
    value: { orderId: 'o1', driverId: 'd1', truckId: 't1', rateEur: 12.5 },
  });
});

test('createTrip persists a DRAFT trip scoped to the org', async () => {
  const prisma = makeFakePrisma();
  const result = await createTrip(prisma, {
    orgId: 'org1',
    body: { orderId: 'o1', driverId: 'd1' },
    actor: OWNER,
  });
  assert.equal(result.ok, true);
  assert.equal(result.trip.status, 'DRAFT');
  assert.equal(result.trip.orgId, 'org1');
  assert.equal(result.trip.orderId, 'o1');
  assert.equal(result.trip.driverId, 'd1');
});

test('createTrip rejects unknown order, cross-org order and cross-org driver', async () => {
  const prisma = makeFakePrisma();
  assert.equal(
    (await createTrip(prisma, { orgId: 'org1', body: { orderId: 'nope' }, actor: OWNER })).error,
    'order_not_found',
  );
  assert.equal(
    (await createTrip(prisma, { orgId: 'org2', body: { orderId: 'o1' }, actor: OWNER })).error,
    'order_not_found',
  );
  assert.equal(
    (await createTrip(prisma, { orgId: 'org1', body: { orderId: 'o1', driverId: 'x1' }, actor: OWNER }))
      .error,
    'driver_not_found',
  );
});

test('transitionTrip enforces the state machine and records a StatusEvent', async () => {
  const prisma = makeFakePrisma();
  const created = await createTrip(prisma, { orgId: 'org1', body: { orderId: 'o1' }, actor: OWNER });
  const id = created.trip.id;

  const assigned = await transitionTrip(prisma, { orgId: 'org1', tripId: id, to: 'ASSIGNED', actor: OWNER });
  assert.equal(assigned.ok, true);
  assert.equal(assigned.trip.status, 'ASSIGNED');
  assert.deepEqual(prisma.state.events, [{ tripId: id, fromStatus: 'DRAFT', toStatus: 'ASSIGNED' }]);
});

test('transitionTrip rejects unknown trips, unknown statuses and illegal moves', async () => {
  const prisma = makeFakePrisma();
  const created = await createTrip(prisma, { orgId: 'org1', body: { orderId: 'o1' }, actor: OWNER });
  const id = created.trip.id;

  assert.equal(
    (await transitionTrip(prisma, { orgId: 'org1', tripId: 'ghost', to: 'ASSIGNED', actor: OWNER })).error,
    'not_found',
  );
  assert.equal(
    (await transitionTrip(prisma, { orgId: 'org2', tripId: id, to: 'ASSIGNED', actor: OWNER })).error,
    'not_found',
  );
  assert.equal(
    (await transitionTrip(prisma, { orgId: 'org1', tripId: id, to: 'BOOKED', actor: OWNER })).error,
    'invalid_status',
  );
  const illegal = await transitionTrip(prisma, { orgId: 'org1', tripId: id, to: 'SETTLED', actor: OWNER });
  assert.deepEqual(illegal, { ok: false, error: 'invalid_transition', from: 'DRAFT', to: 'SETTLED' });
  assert.equal(prisma.state.events.length, 0, 'no event is written for a rejected transition');
});

test('listOrgTrips returns org trips and listDriverTrips narrows to the driver', async () => {
  const prisma = makeFakePrisma();
  await createTrip(prisma, { orgId: 'org1', body: { orderId: 'o1', driverId: 'd1' }, actor: OWNER });
  await createTrip(prisma, { orgId: 'org1', body: { orderId: 'o1' }, actor: OWNER });

  assert.equal((await listOrgTrips(prisma, { orgId: 'org1' })).length, 2);
  assert.equal((await listOrgTrips(prisma, { orgId: 'org2' })).length, 0);
  const driverTrips = await listDriverTrips(prisma, { orgId: 'org1', driverId: 'd1' });
  assert.equal(driverTrips.length, 1);
  assert.equal(driverTrips[0].driverId, 'd1');
});

// --- RBAC (issues #6): driver tokens must not create trips or move others' trips ---

test('a driver cannot create a trip (trip:create denied)', async () => {
  const prisma = makeFakePrisma();
  const result = await createTrip(prisma, {
    orgId: 'org1',
    body: { orderId: 'o1', driverId: 'd1' },
    actor: DRIVER1,
  });
  assert.deepEqual(result, { ok: false, error: 'forbidden' });
  assert.equal(prisma.state.trips.length, 0, 'no trip is persisted on a denied create');
});

test('a driver cannot transition a trip that is not assigned to them', async () => {
  const prisma = makeFakePrisma();
  const created = await createTrip(prisma, {
    orgId: 'org1',
    body: { orderId: 'o1', driverId: 'd1' },
    actor: OWNER,
  });
  const id = created.trip.id;

  const denied = await transitionTrip(prisma, { orgId: 'org1', tripId: id, to: 'ASSIGNED', actor: DRIVER2 });
  assert.deepEqual(denied, { ok: false, error: 'forbidden' });
  assert.equal((await prisma.trip.findFirst({ where: { id } })).status, 'DRAFT');
  assert.equal(prisma.state.events.length, 0, 'no StatusEvent is written on a denied transition');
});

test('the assigned driver can run a legal transition', async () => {
  const prisma = makeFakePrisma();
  const created = await createTrip(prisma, {
    orgId: 'org1',
    body: { orderId: 'o1', driverId: 'd1' },
    actor: OWNER,
  });
  const id = created.trip.id;

  const ok = await transitionTrip(prisma, { orgId: 'org1', tripId: id, to: 'ASSIGNED', actor: DRIVER1 });
  assert.equal(ok.ok, true);
  assert.equal(ok.trip.status, 'ASSIGNED');
  assert.deepEqual(prisma.state.events, [{ tripId: id, fromStatus: 'DRAFT', toStatus: 'ASSIGNED' }]);
});

test('a driver cannot transition an unassigned trip even with trip:status', async () => {
  const prisma = makeFakePrisma();
  const created = await createTrip(prisma, { orgId: 'org1', body: { orderId: 'o1' }, actor: OWNER });
  const denied = await transitionTrip(prisma, {
    orgId: 'org1',
    tripId: created.trip.id,
    to: 'ASSIGNED',
    actor: DRIVER2,
  });
  assert.deepEqual(denied, { ok: false, error: 'forbidden' });
});

test('dispatcher and owner can create and transition any trip in the org', async () => {
  for (const actor of [OWNER, DISPATCHER]) {
    const prisma = makeFakePrisma();
    const created = await createTrip(prisma, {
      orgId: 'org1',
      body: { orderId: 'o1', driverId: 'd1' },
      actor,
    });
    assert.equal(created.ok, true);
    const moved = await transitionTrip(prisma, {
      orgId: 'org1',
      tripId: created.trip.id,
      to: 'ASSIGNED',
      actor,
    });
    assert.equal(moved.ok, true);
    assert.equal(moved.trip.status, 'ASSIGNED');
  }
});

test('transitionTrip requires a POD/eCMR document before POD_UPLOADED', async () => {
  const prisma = makeFakePrisma();
  const created = await createTrip(prisma, {
    orgId: 'org1',
    body: { orderId: 'o1', driverId: 'd1' },
    actor: OWNER,
  });
  const id = created.trip.id;
  for (const to of ['ASSIGNED', 'LOADED', 'IN_TRANSIT', 'DELIVERED']) {
    const step = await transitionTrip(prisma, { orgId: 'org1', tripId: id, to, actor: OWNER });
    assert.equal(step.ok, true, `expected ${to} to be legal`);
  }

  const blocked = await transitionTrip(prisma, { orgId: 'org1', tripId: id, to: 'POD_UPLOADED', actor: OWNER });
  assert.deepEqual(blocked, { ok: false, error: 'pod_required' });
  assert.equal((await prisma.trip.findFirst({ where: { id } })).status, 'DELIVERED');

  prisma.state.docs.push({ tripId: id, docType: 'pod', status: 'UPLOADED' });
  const allowed = await transitionTrip(prisma, { orgId: 'org1', tripId: id, to: 'POD_UPLOADED', actor: OWNER });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.trip.status, 'POD_UPLOADED');
});

test('an actor with no permissions is denied by default', async () => {
  const prisma = makeFakePrisma();
  const created = await createTrip(prisma, { orgId: 'org1', body: { orderId: 'o1' }, actor: OWNER });
  assert.deepEqual(
    await createTrip(prisma, { orgId: 'org1', body: { orderId: 'o1' } }),
    { ok: false, error: 'forbidden' },
    'no actor is denied',
  );
  assert.deepEqual(
    await createTrip(prisma, { orgId: 'org1', body: { orderId: 'o1' }, actor: { permissions: [] } }),
    { ok: false, error: 'forbidden' },
  );
  assert.deepEqual(
    await transitionTrip(prisma, { orgId: 'org1', tripId: created.trip.id, to: 'ASSIGNED' }),
    { ok: false, error: 'forbidden' },
  );
});
