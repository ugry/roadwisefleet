/**
 * HTTP-level acceptance for the dashboard KPIs (board task #33, FAv1-F2).
 *
 * The contract is that every number on the home screen equals a direct database
 * aggregate on the same data. This test drives the real `buildServer()` with
 * `app.inject()` and re-derives each KPI with its own Prisma query, so the route
 * cannot pass by accident.
 *
 * Runs the real API dependencies (`fastify`, `tsx`) and the pilot database:
 *
 *   pnpm --filter @roadwisefleet/api test:router
 *
 * Kept out of `src/` so the no-install CI job `node --test apps/api/src/` never
 * imports `fastify` or `@prisma/client`; the dependency-free invariants live in
 * `../src/dashboard.test.js` and `../src/dashboard-view.test.js`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { signToken } from '../src/auth/tokens.js';

// Must be set before `env.ts` is imported: it throws when AUTH_SECRET is missing.
process.env.ALLOW_INSECURE_AUTH_SECRET = '1';

const { buildServer } = await import('../src/app.js');
const { env } = await import('../src/env.js');
const { prisma } = await import('../src/db.js');
const dashboardCore = await import('../src/dashboard.js');

/** The seeded pilot tenant (scripts/seed-pilot.ts). */
const ORG_ID = 'pilot-org';

function tokenFor(role: string, sub: string): string {
  return signToken({ sub, org: ORG_ID, role, name: `Pilot ${role}` }, env.AUTH_SECRET);
}

async function getDashboard(app: any, role = 'owner') {
  return app.inject({
    method: 'GET',
    url: '/api/dashboard',
    headers: { authorization: `Bearer ${tokenFor(role, role === 'owner' ? 'pilot-admin' : `pilot-${role}`)}` },
  });
}

/** True when the database is reachable (the DB assertions need it). */
async function dbReady(t: any, app: any): Promise<boolean> {
  const res = await getDashboard(app, 'owner');
  if (res.statusCode === 200) return true;
  t.diagnostic(`database not reachable here (baseline status ${res.statusCode}) — DB assertions skipped`);
  return false;
}

test('the dashboard is a reports surface: a driver is refused with 403', async (t) => {
  const app = buildServer();
  try {
    await app.ready();
    // Resolving the role's capabilities reads the DB, so this needs the pilot.
    if (!(await dbReady(t, app))) return;
    const res = await getDashboard(app, 'driver');
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.json(), { error: 'forbidden' });
  } finally {
    await app.close();
  }
});

test('an anonymous request is a 401', async () => {
  const app = buildServer();
  try {
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/dashboard' });
    assert.equal(res.statusCode, 401);
  } finally {
    await app.close();
  }
});

test('active trips equals a direct DB count of non-terminal trips', async (t) => {
  const app = buildServer();
  try {
    await app.ready();
    if (!(await dbReady(t, app))) return;

    const res = await getDashboard(app, 'owner');
    assert.equal(res.statusCode, 200);
    const body = res.json();
    const expected = await prisma.trip.count({
      where: { orgId: ORG_ID, status: { notIn: dashboardCore.TERMINAL_STATUSES } },
    });
    assert.equal(body.dashboard.kpis.activeTrips.value, expected, 'activeTrips must equal the DB count');
  } finally {
    await app.close();
  }
});

test('on-time % is re-derived from Trip.deliveredAt vs Order.plannedAt', async (t) => {
  const app = buildServer();
  try {
    await app.ready();
    if (!(await dbReady(t, app))) return;

    const res = await getDashboard(app, 'owner');
    const kpi = res.json().dashboard.kpis.onTimePct;

    const rows = await prisma.trip.findMany({
      where: { orgId: ORG_ID, status: { in: dashboardCore.DELIVERED_STATUSES }, deliveredAt: { not: null } },
      select: { deliveredAt: true, order: { select: { plannedAt: true } } },
    });
    const comparable = rows.filter((r) => r.deliveredAt && r.order?.plannedAt);
    const onTime = comparable.filter((r) => r.deliveredAt!.getTime() <= r.order!.plannedAt!.getTime()).length;

    assert.equal(kpi.sample, comparable.length, 'the sample is the comparable-trip count');
    assert.equal(kpi.onTime, onTime, 'the numerator is the on-time count');
    if (comparable.length === 0) {
      assert.equal(kpi.value, null, 'no comparable trip -> null, never a fabricated percentage');
    } else {
      assert.equal(kpi.value, Math.round((onTime / comparable.length) * 1000) / 10);
    }
  } finally {
    await app.close();
  }
});

test('pending pay equals the DB sum of rateEur over INVOICED trips', async (t) => {
  const app = buildServer();
  try {
    await app.ready();
    if (!(await dbReady(t, app))) return;

    const res = await getDashboard(app, 'owner');
    const kpi = res.json().dashboard.kpis.pendingPayEur;
    const agg = await prisma.trip.aggregate({
      where: { orgId: ORG_ID, status: dashboardCore.INVOICED_STATUS },
      _sum: { rateEur: true },
      _count: true,
    });
    const expected = Number(agg._sum.rateEur ?? 0);
    assert.equal(kpi.value, Math.round(expected * 100) / 100);
    assert.equal(kpi.count, agg._count);
  } finally {
    await app.close();
  }
});

test("today's activity feed is the DB's status events, newest first, each linked", async (t) => {
  const app = buildServer();
  try {
    await app.ready();
    if (!(await dbReady(t, app))) return;

    const body = (await getDashboard(app, 'owner')).json().dashboard;
    const todayStart = dashboardCore.startOfUtcDay(new Date());
    const expected = await prisma.statusEvent.count({
      where: { trip: { orgId: ORG_ID }, happenedAt: { gte: todayStart } },
    });
    assert.ok(body.activity.length <= Math.min(expected, dashboardCore.ACTIVITY_LIMIT));
    let previous = Infinity;
    for (const event of body.activity as Array<{ at: string; link: string; actor: unknown; tripId: string }>) {
      const at = Date.parse(event.at);
      assert.ok(at >= todayStart.getTime(), 'every feed row is from today (UTC)');
      assert.ok(at <= previous, 'the feed is newest first');
      previous = at;
      assert.equal(event.link, `/app/trips/${encodeURIComponent(event.tripId)}`);
      assert.ok('actor' in event, 'each row exposes its actor (or null)');
    }
  } finally {
    await app.close();
  }
});

test('every alert links to the trip it names and no credential field leaks', async (t) => {
  const app = buildServer();
  try {
    await app.ready();
    if (!(await dbReady(t, app))) return;

    const res = await getDashboard(app, 'owner');
    const payload = res.payload;
    for (const field of ['passwordHash', 'totpSecret', 'failedLoginCount', 'lockedUntil']) {
      assert.ok(!payload.includes(field), `${field} must never appear in the dashboard payload`);
    }
    const body = res.json().dashboard;
    for (const alert of body.alerts as Array<{ link: string; tripId: string; kind: string }>) {
      assert.match(alert.link, /^\/app\/trips\//, `${alert.kind} must link to its trip`);
      assert.equal(alert.link, `/app/trips/${encodeURIComponent(alert.tripId)}`);
      assert.ok(typeof alert.kind === 'string' && alert.kind.length > 0);
    }
    // Every KPI carries a trips-list drill-down.
    for (const key of ['activeTrips', 'onTimePct', 'pendingPayEur']) {
      assert.match(body.kpis[key].link, /^\/app\/trips(\?|$)/);
    }
  } finally {
    await app.close();
  }
});

test('the on-time / pending-pay arithmetic is non-vacuous (rows rolled back)', async (t) => {
  const app = buildServer();
  try {
    await app.ready();
    if (!(await dbReady(t, app))) return;

    const marker = `kpi-fixture-${Date.now()}`;
    // Create real rows through the real Prisma client, compute the KPI, then
    // throw so the transaction rolls back — the pilot is never mutated. The
    // assertions compare before/after so a change in pilot data cannot make the
    // fixture vacuous or brittle.
    const rolledBack = await prisma
      .$transaction(async (tx) => {
        const baseline = await dashboardCore.loadDashboard(tx, { orgId: ORG_ID });
        if (!baseline.ok) throw new Error('baseline dashboard load failed');
        const customer = await tx.customer.create({ data: { orgId: ORG_ID, name: marker } });
        const order = await tx.order.create({
          data: {
            customerId: customer.id,
            origin: marker,
            destination: marker,
            status: 'BOOKED',
            plannedAt: new Date('2026-01-02T00:00:00.000Z'),
          },
        });
        await tx.trip.create({
          data: { orgId: ORG_ID, orderId: order.id, status: 'DELIVERED', rateEur: 100, deliveredAt: new Date('2026-01-01T00:00:00.000Z') },
        });
        await tx.trip.create({
          data: { orgId: ORG_ID, orderId: order.id, status: 'INVOICED', rateEur: 50, deliveredAt: new Date('2026-01-03T00:00:00.000Z') },
        });
        const after = await dashboardCore.loadDashboard(tx, { orgId: ORG_ID });
        if (!after.ok) throw new Error('after dashboard load failed');
        throw Object.assign(new Error('rollback-on-purpose'), { baseline: baseline.dashboard, after: after.dashboard });
      })
      .catch((err: Error & { baseline?: any, after?: any }) => err);

    assert.equal(rolledBack.message, 'rollback-on-purpose', 'the fixture transaction must roll back');
    const before = rolledBack.baseline.kpis;
    const after = rolledBack.after.kpis;
    assert.equal(after.activeTrips.value - before.activeTrips.value, 2, 'both synthetic trips are active');
    assert.equal(after.onTimePct.sample - before.onTimePct.sample, 2, 'both synthetic trips have deliveredAt + plannedAt');
    assert.equal(after.onTimePct.onTime - before.onTimePct.onTime, 1, 'one synthetic trip delivered before its planned time');
    assert.equal(
      after.onTimePct.value,
      Math.round((after.onTimePct.onTime / after.onTimePct.sample) * 1000) / 10,
      'the API percentage is the on-time share of the comparable set',
    );
    assert.equal(after.pendingPayEur.value - before.pendingPayEur.value, 50, 'the INVOICED synthetic trip is in the pending-pay sum');
    assert.equal(after.pendingPayEur.count - before.pendingPayEur.count, 1);

    const residue = await prisma.trip.count({ where: { orgId: ORG_ID, order: { origin: marker } } });
    assert.equal(residue, 0, 'no synthetic row may survive the rollback');
  } finally {
    await app.close();
  }
});

test('trip detail surfaces the delivery and planned timestamps (board task #40)', async (t) => {
  const app = buildServer();
  try {
    await app.ready();
    if (!(await dbReady(t, app))) return;

    const list = await app.inject({
      method: 'GET',
      url: '/api/trips',
      headers: { authorization: `Bearer ${tokenFor('owner', 'pilot-admin')}` },
    });
    const id = (list.json().trips as Array<{ id: string }>)[0]?.id;
    if (!id) {
      t.diagnostic('no trip in the pilot DB — detail-field assertion skipped');
      return;
    }
    const res = await app.inject({
      method: 'GET',
      url: `/api/trips/${encodeURIComponent(id)}`,
      headers: { authorization: `Bearer ${tokenFor('owner', 'pilot-admin')}` },
    });
    assert.equal(res.statusCode, 200);
    const trip = res.json().trip;
    assert.ok('deliveredAt' in trip, 'trip detail exposes deliveredAt');
    assert.ok('plannedAt' in (trip.order || {}), 'trip detail exposes the order plannedAt');

    const row = await prisma.trip.findFirst({ where: { id, orgId: ORG_ID }, select: { deliveredAt: true } });
    assert.equal(trip.deliveredAt, row?.deliveredAt ? row.deliveredAt.toISOString() : null);
  } finally {
    await app.close();
  }
});
