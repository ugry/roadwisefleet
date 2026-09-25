import test from 'node:test';
import assert from 'node:assert/strict';

import { getTripDetail, shapeTripDetail, tripDetailInclude } from './trip-detail.js';

/**
 * Minimal in-memory fake of the Prisma surface `trip-detail.js` uses. The
 * `include` argument is ignored: the fake returns the fully-populated trip it
 * was given, which is exactly what the real client would return for
 * `tripDetailInclude()`.
 */
function makeFakePrisma(trips) {
  return {
    trip: {
      findFirst: async ({ where }) =>
        trips.find((t) => t.id === where.id && t.orgId === where.orgId) ?? null,
    },
  };
}

/** A fully-populated org-1 trip: order+customer, driver, truck, events, docs,
 * expenses and a settlement — the "renders a seeded trip with real events" case. */
function fullTrip(overrides = {}) {
  return {
    id: 'trip-1',
    orgId: 'org1',
    status: 'IN_TRANSIT',
    rateEur: '1200.00',
    createdAt: new Date('2026-09-20T08:00:00Z'),
    order: {
      id: 'o1',
      origin: 'Berlin, DE',
      destination: 'Hamburg, DE',
      cargo: 'Palletised goods',
      status: 'DISPATCHED',
      customer: { id: 'c1', name: 'Acme Freight', email: 'ops@acme.test' },
    },
    driver: { id: 'd1', name: 'Driver One', email: 'd1@x.test', phone: '+49 1' },
    truck: { id: 'tr1', plate: 'RW-001', euroClass: 'Euro 6', dimensions: '13.6m' },
    statusEvents: [
      {
        id: 'e1',
        fromStatus: 'DRAFT',
        toStatus: 'ASSIGNED',
        happenedAt: new Date('2026-09-20T09:00:00Z'),
        actor: { id: 'admin', name: 'Pilot Admin' },
      },
      {
        id: 'e2',
        fromStatus: 'ASSIGNED',
        toStatus: 'LOADED',
        happenedAt: new Date('2026-09-20T10:00:00Z'),
        actor: null,
      },
    ],
    documents: [
      { id: 'doc1', docType: 'pod', status: 'UPLOADED', createdAt: new Date('2026-09-21T10:00:00Z'), expiresAt: null },
    ],
    expenses: [
      { id: 'x1', category: 'fuel', amountEur: '300.50', createdAt: new Date('2026-09-20T11:00:00Z') },
      { id: 'x2', category: 'toll', amountEur: 49.5, createdAt: new Date('2026-09-20T12:00:00Z') },
    ],
    settlement: { id: 's1', amountEur: '1200.00', status: 'PENDING', createdAt: new Date('2026-09-22T08:00:00Z') },
    ...overrides,
  };
}

test('shapeTripDetail maps the relations, timeline and P&L', () => {
  const detail = shapeTripDetail(fullTrip());

  assert.equal(detail.id, 'trip-1');
  assert.equal(detail.status, 'IN_TRANSIT');
  assert.equal(detail.rateEur, 1200);
  assert.equal(detail.order.origin, 'Berlin, DE');
  assert.equal(detail.order.customer.name, 'Acme Freight');
  assert.equal(detail.driver.name, 'Driver One');
  assert.equal(detail.truck.plate, 'RW-001');

  // Timeline is oldest-first and keeps the actor, including a null actor.
  assert.deepEqual(
    detail.statusEvents.map((e) => [e.from, e.to, e.actor?.name ?? null]),
    [
      ['DRAFT', 'ASSIGNED', 'Pilot Admin'],
      ['ASSIGNED', 'LOADED', null],
    ],
  );

  // Board task #36: only a same-status event is a reassignment; a lifecycle
  // move always changes the status.
  assert.deepEqual(
    detail.statusEvents.map((e) => e.kind),
    ['status', 'status'],
  );

  // Document has no uploadedAt column: it mirrors createdAt.
  assert.equal(detail.documents[0].docType, 'pod');
  assert.deepEqual(detail.documents[0].uploadedAt, new Date('2026-09-21T10:00:00Z'));

  assert.deepEqual(
    detail.expenses.map((e) => [e.category, e.amountEur]),
    [
      ['fuel', 300.5],
      ['toll', 49.5],
    ],
  );
  assert.equal(detail.settlement.amountEur, 1200);
  assert.equal(detail.settlement.status, 'PENDING');

  // P&L = rateEur - sum(expenses) = 1200 - 350 = 850.
  assert.equal(detail.totals.expensesEur, 350);
  assert.equal(detail.totals.pnlEur, 850);
});

test('shapeTripDetail handles a trip with no events, documents, expenses or settlement', () => {
  const detail = shapeTripDetail(
    fullTrip({
      status: 'DRAFT',
      driver: null,
      truck: null,
      statusEvents: [],
      documents: [],
      expenses: [],
      settlement: null,
    }),
  );

  assert.deepEqual(detail.statusEvents, []);
  assert.deepEqual(detail.documents, []);
  assert.deepEqual(detail.expenses, []);
  assert.equal(detail.settlement, null);
  assert.equal(detail.driver, null);
  assert.equal(detail.truck, null);
  // No expenses: P&L equals the rate.
  assert.equal(detail.totals.expensesEur, 0);
  assert.equal(detail.totals.pnlEur, 1200);
});

test('shapeTripDetail returns a null P&L when the trip has no rate', () => {
  const detail = shapeTripDetail(fullTrip({ rateEur: null }));
  assert.equal(detail.rateEur, null);
  assert.equal(detail.totals.expensesEur, 350);
  assert.equal(detail.totals.pnlEur, null);
});

test('shapeTripDetail accepts Prisma Decimal values (toNumber) and empty strings', () => {
  const detail = shapeTripDetail(
    fullTrip({
      rateEur: { toNumber: () => 1000.25 },
      expenses: [{ id: 'x', category: 'other', amountEur: { toNumber: () => 0.25 }, createdAt: null }],
      settlement: { id: 's', amountEur: '', status: 'PAID', createdAt: null },
    }),
  );
  assert.equal(detail.rateEur, 1000.25);
  assert.equal(detail.totals.pnlEur, 1000);
  assert.equal(detail.settlement.amountEur, null);
});

test('getTripDetail returns the shaped trip for a matching org', async () => {
  const prisma = makeFakePrisma([fullTrip()]);
  const result = await getTripDetail(prisma, { orgId: 'org1', tripId: 'trip-1' });
  assert.equal(result.ok, true);
  assert.equal(result.trip.id, 'trip-1');
  assert.equal(result.trip.totals.pnlEur, 850);
});

test('getTripDetail isolates orgs: a trip in another org is not_found (404), not forbidden', async () => {
  const prisma = makeFakePrisma([fullTrip()]);
  assert.deepEqual(await getTripDetail(prisma, { orgId: 'org2', tripId: 'trip-1' }), {
    ok: false,
    error: 'not_found',
  });
});

test('getTripDetail returns not_found for an unknown or blank id', async () => {
  const prisma = makeFakePrisma([fullTrip()]);
  assert.deepEqual(await getTripDetail(prisma, { orgId: 'org1', tripId: 'ghost' }), {
    ok: false,
    error: 'not_found',
  });
  assert.deepEqual(await getTripDetail(prisma, { orgId: 'org1', tripId: '   ' }), {
    ok: false,
    error: 'not_found',
  });
  assert.deepEqual(await getTripDetail(prisma, { orgId: 'org1', tripId: null }), {
    ok: false,
    error: 'not_found',
  });
});

test('getTripDetail refuses a caller with no org', async () => {
  const prisma = makeFakePrisma([fullTrip()]);
  assert.deepEqual(await getTripDetail(prisma, { orgId: null, tripId: 'trip-1' }), {
    ok: false,
    error: 'no_org',
  });
});

test('tripDetailInclude orders the timeline and loads the actor', () => {
  const include = tripDetailInclude();
  assert.deepEqual(include.statusEvents.orderBy, { happenedAt: 'asc' });
  assert.equal(include.statusEvents.include.actor.select.id, true);
  assert.equal(include.order.include.customer.select.name, true);
  assert.equal(include.settlement, true);
});

test('a same-status event is shaped as a reassignment with its actor (#36)', () => {
  const detail = shapeTripDetail(
    fullTrip({
      driver: { id: 'd2', name: 'Driver Two', email: null, phone: null },
      statusEvents: [
        {
          id: 'e1',
          fromStatus: 'ASSIGNED',
          toStatus: 'ASSIGNED',
          happenedAt: new Date('2026-09-24T09:00:00Z'),
          actor: { id: 'disp', name: 'Dispatcher Dee' },
        },
      ],
    }),
  );
  assert.equal(detail.statusEvents.length, 1);
  const event = detail.statusEvents[0];
  assert.equal(event.kind, 'reassignment');
  assert.equal(event.from, 'ASSIGNED');
  assert.equal(event.to, 'ASSIGNED');
  assert.deepEqual(event.actor, { id: 'disp', name: 'Dispatcher Dee' });
  assert.equal(detail.driver.id, 'd2', 'the detail carries the newly assigned driver');
});
