/**
 * Delivery-timestamp writer acceptance (board task #66).
 *
 * The F2 dashboard (#33) and the delivery-timestamps migration (#40) shipped,
 * but nothing wrote the two columns the on-time KPI reads — so `onTimePct` could
 * never produce a number. This test drives the REAL status-transition path
 * (`trips-core.js#transitionTrip`) and then the REAL dashboard loader, and
 * asserts the KPI moved, all inside a transaction that is rolled back so the
 * pilot is never mutated.
 *
 * Why the small `$transaction` shim: Prisma's interactive-transaction client
 * (`tx`) deliberately exposes no `$transaction`, while `transitionTrip` performs
 * its two writes through one. The shim runs the real transition against `tx` and
 * joins the array with `Promise.all` — the same shape the dependency-free unit
 * fake uses — so the code under test is exactly the production path.
 *
 * Runs the real API dependencies (`fastify`, `tsx`) and the pilot database:
 *
 *   pnpm --filter @roadwisefleet/api test:router
 *
 * Kept out of `src/` so the no-install CI job `node --test apps/api/src/` never
 * imports `fastify` or `@prisma/client`; the dependency-free half lives in
 * `../src/trips-core.test.js`.
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
const tripsCore = await import('../src/trips-core.js');

/** The seeded pilot tenant (scripts/seed-pilot.ts). */
const ORG_ID = 'pilot-org';

function ownerToken(): string {
  return signToken({ sub: 'pilot-admin', org: ORG_ID, role: 'owner', name: 'Pilot owner' }, env.AUTH_SECRET);
}

/** True when the database is reachable (the DB assertions need it). */
async function dbReady(t: any, app: any): Promise<boolean> {
  const res = await app.inject({
    method: 'GET',
    url: '/api/dashboard',
    headers: { authorization: `Bearer ${ownerToken()}` },
  });
  if (res.statusCode === 200) return true;
  t.diagnostic(`database not reachable here (baseline status ${res.statusCode}) — DB assertions skipped`);
  return false;
}

test('delivering a trip through the status flow writes deliveredAt and moves the on-time KPI (#66)', async (t) => {
  const app = buildServer();
  try {
    await app.ready();
    if (!(await dbReady(t, app))) return;

    const marker = `kpi-writer-${Date.now()}`;
    const planned = new Date('2026-01-02T00:00:00.000Z');
    const deliveredAt = new Date('2026-01-01T00:00:00.000Z');

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
            plannedAt: planned,
          },
        });
        // A trip one legal step away from DELIVERED — the normal status flow.
        const trip = await tx.trip.create({
          data: { orgId: ORG_ID, orderId: order.id, status: 'IN_TRANSIT', rateEur: 100 },
        });

        // The real transition code, writing through the interactive transaction.
        const txClient = {
          trip: tx.trip,
          statusEvent: tx.statusEvent,
          order: tx.order,
          user: tx.user,
          truck: tx.truck,
          document: tx.document,
          $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
        };
        const moved = await tripsCore.transitionTrip(txClient as any, {
          orgId: ORG_ID,
          tripId: trip.id,
          to: 'DELIVERED',
          actor: { userId: 'pilot-admin', permissions: ['trip:*'] },
          now: deliveredAt,
        });
        if (!moved.ok) throw new Error(`transition failed: ${moved.error}`);

        const row = await tx.trip.findFirst({
          where: { id: trip.id },
          select: { status: true, deliveredAt: true },
        });
        const after = await dashboardCore.loadDashboard(tx, { orgId: ORG_ID });
        if (!after.ok) throw new Error('after dashboard load failed');

        // Re-derive the same KPI with a direct DB query on the same rows.
        const rows = await tx.trip.findMany({
          where: { orgId: ORG_ID, status: { in: dashboardCore.DELIVERED_STATUSES }, deliveredAt: { not: null } },
          select: { deliveredAt: true, order: { select: { plannedAt: true } } },
        });
        const comparable = rows.filter((r) => r.deliveredAt && r.order?.plannedAt);
        const onTime = comparable.filter((r) => r.deliveredAt!.getTime() <= r.order!.plannedAt!.getTime()).length;

        throw Object.assign(new Error('rollback-on-purpose'), {
          baseline: baseline.dashboard,
          after: after.dashboard,
          row,
          direct: { sample: comparable.length, onTime },
        });
      })
      .catch((err: Error & { baseline?: any; after?: any; row?: any; direct?: any }) => err);

    assert.equal(rolledBack.message, 'rollback-on-purpose', 'the fixture transaction must roll back');

    // The writer produced the column the KPI reads.
    assert.equal(rolledBack.row.status, 'DELIVERED');
    assert.ok(rolledBack.row.deliveredAt instanceof Date, 'deliveredAt is written by the transition');
    assert.equal(rolledBack.row.deliveredAt.getTime(), deliveredAt.getTime());

    // ...and the KPI now has a comparable sample with a real percentage that
    // equals a direct DB query on the same rows.
    const before = rolledBack.baseline.kpis.onTimePct;
    const after = rolledBack.after.kpis.onTimePct;
    assert.equal(after.sample - before.sample, 1, 'the delivered trip enters the on-time sample');
    assert.equal(after.onTime - before.onTime, 1, 'it was delivered before its planned time');
    assert.equal(after.sample, rolledBack.direct.sample, 'the KPI sample equals the direct DB count');
    assert.equal(after.onTime, rolledBack.direct.onTime, 'the KPI numerator equals the direct DB count');
    assert.equal(
      after.value,
      Math.round((after.onTime / after.sample) * 1000) / 10,
      'the API percentage is the on-time share of the comparable set',
    );

    // The fixture is gone: no residue in the pilot.
    const residue = await prisma.trip.count({ where: { orgId: ORG_ID, order: { origin: marker } } });
    assert.equal(residue, 0, 'no synthetic row may survive the rollback');
  } finally {
    await app.close();
  }
});

test('a malformed plannedAt on POST /api/trips is a 400 before any write (#66)', async (t) => {
  const app = buildServer();
  try {
    await app.ready();
    if (!(await dbReady(t, app))) return;
    const res = await app.inject({
      method: 'POST',
      url: '/api/trips',
      headers: { authorization: `Bearer ${ownerToken()}` },
      payload: { orderId: 'probe-does-not-exist', plannedAt: 'not-a-date' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'invalid_input');
    assert.match(String(res.json().detail ?? ''), /plannedAt/);
  } finally {
    await app.close();
  }
});

test('the on-time KPI stays null when neither timestamp is recorded (#66)', async (t) => {
  const app = buildServer();
  try {
    await app.ready();
    if (!(await dbReady(t, app))) return;

    const marker = `kpi-empty-${Date.now()}`;
    const rolledBack = await prisma
      .$transaction(async (tx) => {
        const baseline = await dashboardCore.loadDashboard(tx, { orgId: ORG_ID });
        if (!baseline.ok) throw new Error('baseline dashboard load failed');
        const customer = await tx.customer.create({ data: { orgId: ORG_ID, name: marker } });
        const order = await tx.order.create({
          data: { customerId: customer.id, origin: marker, destination: marker, status: 'BOOKED' },
        });
        // Delivered, but with no planned time: not comparable, so it must not
        // fabricate a 0/100 — the KPI stays unknown.
        await tx.trip.create({ data: { orgId: ORG_ID, orderId: order.id, status: 'DELIVERED', rateEur: 100 } });
        const after = await dashboardCore.loadDashboard(tx, { orgId: ORG_ID });
        if (!after.ok) throw new Error('after dashboard load failed');
        throw Object.assign(new Error('rollback-on-purpose'), { baseline: baseline.dashboard, after: after.dashboard });
      })
      .catch((err: Error & { baseline?: any; after?: any }) => err);

    assert.equal(rolledBack.message, 'rollback-on-purpose');
    const before = rolledBack.baseline.kpis.onTimePct;
    const after = rolledBack.after.kpis.onTimePct;
    assert.equal(after.sample, before.sample, 'a trip with no deliveredAt/plannedAt pair is not in the sample');
    assert.equal(after.value, before.value, 'the percentage is unchanged — unknown stays unknown');
    if (after.sample === 0) assert.equal(after.value, null, 'no comparable trip -> null, never 0/100');
  } finally {
    await app.close();
  }
});
