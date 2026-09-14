import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createTrip,
  listDriverTrips,
  listOrgTrips,
  normalizeCreateTripInput,
  transitionTrip,
} from './trips-core.js';

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
  const result = await createTrip(prisma, { orgId: 'org1', body: { orderId: 'o1', driverId: 'd1' } });
  assert.equal(result.ok, true);
  assert.equal(result.trip.status, 'DRAFT');
  assert.equal(result.trip.orgId, 'org1');
  assert.equal(result.trip.orderId, 'o1');
  assert.equal(result.trip.driverId, 'd1');
});

test('createTrip rejects unknown order, cross-org order and cross-org driver', async () => {
  const prisma = makeFakePrisma();
  assert.equal((await createTrip(prisma, { orgId: 'org1', body: { orderId: 'nope' } })).error, 'order_not_found');
  assert.equal((await createTrip(prisma, { orgId: 'org2', body: { orderId: 'o1' } })).error, 'order_not_found');
  assert.equal(
    (await createTrip(prisma, { orgId: 'org1', body: { orderId: 'o1', driverId: 'x1' } })).error,
    'driver_not_found',
  );
});

test('transitionTrip enforces the state machine and records a StatusEvent', async () => {
  const prisma = makeFakePrisma();
  const created = await createTrip(prisma, { orgId: 'org1', body: { orderId: 'o1' } });
  const id = created.trip.id;

  const assigned = await transitionTrip(prisma, { orgId: 'org1', tripId: id, to: 'ASSIGNED' });
  assert.equal(assigned.ok, true);
  assert.equal(assigned.trip.status, 'ASSIGNED');
  assert.deepEqual(prisma.state.events, [{ tripId: id, fromStatus: 'DRAFT', toStatus: 'ASSIGNED' }]);
});

test('transitionTrip rejects unknown trips, unknown statuses and illegal moves', async () => {
  const prisma = makeFakePrisma();
  const created = await createTrip(prisma, { orgId: 'org1', body: { orderId: 'o1' } });
  const id = created.trip.id;

  assert.equal((await transitionTrip(prisma, { orgId: 'org1', tripId: 'ghost', to: 'ASSIGNED' })).error, 'not_found');
  assert.equal((await transitionTrip(prisma, { orgId: 'org2', tripId: id, to: 'ASSIGNED' })).error, 'not_found');
  assert.equal((await transitionTrip(prisma, { orgId: 'org1', tripId: id, to: 'BOOKED' })).error, 'invalid_status');
  const illegal = await transitionTrip(prisma, { orgId: 'org1', tripId: id, to: 'SETTLED' });
  assert.deepEqual(illegal, { ok: false, error: 'invalid_transition', from: 'DRAFT', to: 'SETTLED' });
  assert.equal(prisma.state.events.length, 0, 'no event is written for a rejected transition');
});

test('listOrgTrips returns org trips and listDriverTrips narrows to the driver', async () => {
  const prisma = makeFakePrisma();
  await createTrip(prisma, { orgId: 'org1', body: { orderId: 'o1', driverId: 'd1' } });
  await createTrip(prisma, { orgId: 'org1', body: { orderId: 'o1' } });

  assert.equal((await listOrgTrips(prisma, { orgId: 'org1' })).length, 2);
  assert.equal((await listOrgTrips(prisma, { orgId: 'org2' })).length, 0);
  const driverTrips = await listDriverTrips(prisma, { orgId: 'org1', driverId: 'd1' });
  assert.equal(driverTrips.length, 1);
  assert.equal(driverTrips[0].driverId, 'd1');
});
