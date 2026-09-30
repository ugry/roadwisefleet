/**
 * Dashboard KPIs (board task #33, FAv1-F2) — dependency-free coverage for
 * `apps/api/src/dashboard.js`.
 *
 * Runs under the no-install CI job (`node --test apps/api/src/`), so it imports
 * only `node:*` builtins plus the module under test. The DB-backed acceptance
 * (every KPI equals a direct Prisma aggregate) lives in
 * `apps/api/test/dashboard.test.ts` (`pnpm test:router`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTIVE_STATUSES,
  ALERT_LIMIT,
  DELIVERED_STATUSES,
  INVOICED_STATUS,
  TERMINAL_STATUSES,
  UNASSIGNED_STATUSES,
  loadDashboard,
  onTimeShare,
  shapeDashboard,
  startOfUtcDay,
  toNumber,
} from './dashboard.js';

/** The nine states of the merged trip state machine (`trip-status.js`). */
const ALL_STATUSES = [
  'DRAFT', 'ASSIGNED', 'LOADED', 'IN_TRANSIT',
  'DELIVERED', 'POD_UPLOADED', 'INVOICED', 'SETTLED', 'CANCELLED',
];

test('active and terminal statuses partition the whole state machine', () => {
  const union = [...ACTIVE_STATUSES, ...TERMINAL_STATUSES].sort();
  assert.deepEqual(union, [...ALL_STATUSES].sort());
  for (const status of TERMINAL_STATUSES) assert.ok(!ACTIVE_STATUSES.includes(status));
});

test('onTimeShare compares deliveredAt against plannedAt and ignores unknown rows', () => {
  const rows = [
    { deliveredAt: '2026-09-20T08:00:00.000Z', plannedAt: '2026-09-20T10:00:00.000Z' }, // on time
    { deliveredAt: '2026-09-20T12:00:00.000Z', plannedAt: '2026-09-20T10:00:00.000Z' }, // late
    { deliveredAt: '2026-09-20T09:00:00.000Z', plannedAt: '2026-09-20T09:00:00.000Z' }, // exactly on time
    { deliveredAt: null, plannedAt: '2026-09-20T10:00:00.000Z' }, // excluded
    { deliveredAt: '2026-09-20T09:00:00.000Z', plannedAt: null }, // excluded
  ];
  const share = onTimeShare(rows);
  assert.equal(share.sample, 3);
  assert.equal(share.onTime, 2);
  assert.equal(share.value, 66.7);
});

test('onTimeShare is null (not 0) when nothing is comparable', () => {
  assert.deepEqual(onTimeShare([]), { value: null, onTime: 0, sample: 0 });
  assert.equal(onTimeShare([{ deliveredAt: null, plannedAt: null }]).value, null);
});

test('startOfUtcDay truncates to the UTC calendar day', () => {
  assert.equal(startOfUtcDay('2026-09-24T15:30:00.000Z').toISOString(), '2026-09-24T00:00:00.000Z');
  assert.equal(startOfUtcDay('2026-09-24T00:00:00.000Z').toISOString(), '2026-09-24T00:00:00.000Z');
});

test('toNumber handles Prisma Decimal, number, string and null', () => {
  assert.equal(toNumber({ toNumber: () => 12.5 }), 12.5);
  assert.equal(toNumber(3), 3);
  assert.equal(toNumber('4.25'), 4.25);
  assert.equal(toNumber(null), null);
  assert.equal(toNumber('abc'), null);
});

test('shapeDashboard builds every KPI from the raw query results', () => {
  const now = new Date('2026-09-24T12:00:00.000Z');
  const payload = shapeDashboard(
    {
      activeTrips: 7,
      delivered: [
        { deliveredAt: new Date('2026-09-24T08:00:00.000Z'), order: { plannedAt: new Date('2026-09-24T10:00:00.000Z') } },
        { deliveredAt: new Date('2026-09-24T12:00:00.000Z'), order: { plannedAt: new Date('2026-09-24T10:00:00.000Z') } },
      ],
      pendingPay: { _sum: { rateEur: { toNumber: () => 1450 } }, _count: 2 },
      activity: [
        {
          id: 'ev1', tripId: 't1', fromStatus: 'LOADED', toStatus: 'IN_TRANSIT',
          happenedAt: new Date('2026-09-24T09:00:00.000Z'), actor: { id: 'u1', name: 'Olive' },
        },
      ],
      unassigned: [
        { id: 't9', status: 'ASSIGNED', createdAt: new Date('2026-09-23T08:00:00.000Z'), order: { origin: 'Berlin', destination: 'Hamburg' } },
      ],
      expiring: [
        { id: 'd1', tripId: 't2', docType: 'insurance', status: 'UPLOADED', expiresAt: new Date('2026-09-20T00:00:00.000Z') },
        { id: 'd2', tripId: 't3', docType: 'cpc', status: 'UPLOADED', expiresAt: new Date('2026-10-01T00:00:00.000Z') },
      ],
      settlements: [
        { id: 's1', tripId: 't4', amountEur: { toNumber: () => 320 }, status: 'PENDING', createdAt: new Date('2026-09-22T08:00:00.000Z') },
      ],
    },
    { now },
  );

  assert.equal(payload.generatedAt, '2026-09-24T12:00:00.000Z');
  assert.equal(payload.today, '2026-09-24T00:00:00.000Z');
  assert.equal(payload.kpis.activeTrips.value, 7);
  assert.equal(payload.kpis.activeTrips.link, '/app/trips?status=' + ACTIVE_STATUSES.join(','));
  assert.equal(payload.kpis.onTimePct.value, 50);
  assert.equal(payload.kpis.onTimePct.sample, 2);
  assert.equal(payload.kpis.onTimePct.link, '/app/trips?status=' + DELIVERED_STATUSES.join(','));
  assert.equal(payload.kpis.pendingPayEur.value, 1450);
  assert.equal(payload.kpis.pendingPayEur.count, 2);
  assert.equal(payload.kpis.pendingPayEur.link, '/app/trips?status=' + INVOICED_STATUS);
  // Every KPI names the aggregate it came from, so the tester can re-derive it.
  for (const key of ['activeTrips', 'onTimePct', 'pendingPayEur']) {
    assert.equal(typeof payload.kpis[key].query, 'string');
    assert.ok(payload.kpis[key].query.length > 0);
  }

  assert.equal(payload.activity.length, 1);
  assert.deepEqual(payload.activity[0], {
    id: 'ev1', tripId: 't1', from: 'LOADED', to: 'IN_TRANSIT',
    at: '2026-09-24T09:00:00.000Z',
    actor: { id: 'u1', name: 'Olive' },
    link: '/app/trips/t1',
  });

  // Alerts: expired doc (high) before unassigned (high) before expiring (medium)
  // before pending settlement (medium) — and every one links to its trip.
  const kinds = payload.alerts.map((a) => a.kind);
  assert.ok(kinds.includes('document_expired'));
  assert.ok(kinds.includes('document_expiring'));
  assert.ok(kinds.includes('trip_unassigned'));
  assert.ok(kinds.includes('settlement_pending'));
  const expired = payload.alerts.find((a) => a.kind === 'document_expired');
  assert.equal(expired.severity, 'high');
  assert.equal(expired.tripId, 't2');
  assert.equal(expired.link, '/app/trips/t2');
  const expiring = payload.alerts.find((a) => a.kind === 'document_expiring');
  assert.equal(expiring.severity, 'medium');
  for (const alert of payload.alerts) assert.match(alert.link, /^\/app\/trips\//);
  assert.equal(payload.alertCounts.total, payload.alerts.length);
});

test('shapeDashboard never serialises a credential field from an actor', () => {
  const payload = shapeDashboard({
    activeTrips: 0,
    delivered: [],
    pendingPay: { _sum: { rateEur: null }, _count: 0 },
    activity: [
      {
        id: 'ev1', tripId: 't1', fromStatus: 'DRAFT', toStatus: 'ASSIGNED',
        happenedAt: new Date('2026-09-24T09:00:00.000Z'),
        actor: { id: 'u1', name: 'Olive', passwordHash: 'scrypt$deadbeef', totpSecret: 'S3CR3T' },
      },
    ],
    unassigned: [], expiring: [], settlements: [],
  }, { now: new Date('2026-09-24T12:00:00.000Z') });
  const json = JSON.stringify(payload);
  assert.ok(!/passwordHash|totpSecret|failedLoginCount|lockedUntil/.test(json));
  assert.deepEqual(payload.activity[0].actor, { id: 'u1', name: 'Olive' });
});

test('shapeDashboard caps the alerts and keeps an empty payload honest', () => {
  const unassigned = [];
  for (let i = 0; i < ALERT_LIMIT + 5; i += 1) {
    unassigned.push({ id: `t${i}`, status: 'ASSIGNED', createdAt: new Date('2026-09-23T08:00:00.000Z'), order: {} });
  }
  const payload = shapeDashboard({
    activeTrips: 0, delivered: [], pendingPay: { _sum: { rateEur: null }, _count: 0 },
    activity: [], unassigned, expiring: [], settlements: [],
  }, { now: new Date('2026-09-24T12:00:00.000Z') });
  assert.equal(payload.alerts.length, ALERT_LIMIT);
  assert.equal(payload.alertCounts.unassigned, ALERT_LIMIT + 5);
  assert.equal(payload.kpis.onTimePct.value, null, 'no comparable trip -> null, never 0');
  assert.equal(payload.kpis.pendingPayEur.value, 0, 'a real sum of zero is 0');
  assert.deepEqual(payload.activity, []);
});

/** A fake Prisma client that records the `where` of every query it serves. */
function fakeClient(data) {
  const calls = [];
  return {
    calls,
    trip: {
      count: async (args) => { calls.push({ model: 'trip.count', args }); return data.activeTrips; },
      findMany: async (args) => {
        calls.push({ model: 'trip.findMany', args });
        const statuses = args?.where?.status?.in || [];
        if (statuses.includes(UNASSIGNED_STATUSES[0])) return data.unassigned;
        return data.delivered;
      },
      aggregate: async (args) => { calls.push({ model: 'trip.aggregate', args }); return data.pendingPay; },
    },
    statusEvent: { findMany: async (args) => { calls.push({ model: 'statusEvent.findMany', args }); return data.activity; } },
    document: { findMany: async (args) => { calls.push({ model: 'document.findMany', args }); return data.expiring; } },
    settlement: { findMany: async (args) => { calls.push({ model: 'settlement.findMany', args }); return data.settlements; } },
  };
}

test('loadDashboard refuses without an org and never queries in that case', async () => {
  const client = fakeClient({});
  const result = await loadDashboard(client, { orgId: null });
  assert.deepEqual(result, { ok: false, error: 'no_org' });
  assert.equal(client.calls.length, 0);
});

test('loadDashboard scopes every query to the caller org', async () => {
  const client = fakeClient({
    activeTrips: 3,
    delivered: [],
    pendingPay: { _sum: { rateEur: 0 }, _count: 0 },
    activity: [],
    unassigned: [],
    expiring: [],
    settlements: [],
  });
  const result = await loadDashboard(client, { orgId: 'org-1', now: new Date('2026-09-24T12:00:00.000Z') });
  assert.equal(result.ok, true);
  assert.equal(client.calls.length, 7, 'seven reads: count, delivered, aggregate, activity, unassigned, documents, settlements');
  const scoped = {
    'trip.count': (c) => c.args.where.orgId,
    'trip.aggregate': (c) => c.args.where.orgId,
    'statusEvent.findMany': (c) => c.args.where.trip.orgId,
    'document.findMany': (c) => c.args.where.trip.orgId,
    'settlement.findMany': (c) => c.args.where.trip.orgId,
  };
  for (const call of client.calls) {
    if (call.model === 'trip.findMany') {
      assert.equal(call.args.where.orgId, 'org-1', 'trip.findMany is org-scoped');
      continue;
    }
    assert.equal(scoped[call.model](call), 'org-1', `${call.model} must be org-scoped`);
  }
  const activity = client.calls.find((c) => c.model === 'statusEvent.findMany');
  assert.equal(activity.args.where.happenedAt.gte.toISOString(), '2026-09-24T00:00:00.000Z');
  assert.equal(activity.args.orderBy.happenedAt, 'desc');
});

test('the dashboard module stays pure: no fastify and no prisma import', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('./dashboard.js', import.meta.url), 'utf8');
  assert.ok(!/from\s+['"]fastify['"]/.test(source));
  assert.ok(!/@prisma\/client/.test(source));
  assert.ok(!/console\.log/.test(source));
});
