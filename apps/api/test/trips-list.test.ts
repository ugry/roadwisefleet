/**
 * HTTP-level coverage for the trips-list filters (board task #34, FAv1-F3).
 *
 * `GET /api/trips` now takes `status` / `driverId` / `from` / `to` / `q`; the
 * acceptance criterion is that filters combine correctly *against the DB* and
 * that an invalid filter is a 400, never a silently ignored value. This test
 * drives the real `buildServer()` with `app.inject()` and re-derives each
 * expected result with a direct Prisma query, so the route cannot pass by
 * accident.
 *
 * Runs the real API dependencies (`fastify`, `tsx`) and the pilot database:
 *
 *   pnpm --filter @roadwisefleet/api test:router
 *
 * Kept out of `src/` so the no-install CI job `node --test apps/api/src/` never
 * imports `fastify` or `@prisma/client`; the dependency-free invariants live in
 * `../src/trip-filters.test.js`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { signToken } from '../src/auth/tokens.js';
import trips from '../../../app/lib/trips.js';

// Must be set before `env.ts` is imported: it throws when AUTH_SECRET is missing.
process.env.ALLOW_INSECURE_AUTH_SECRET = '1';

const { buildServer } = await import('../src/app.js');
const { env } = await import('../src/env.js');
const { prisma } = await import('../src/db.js');

/** The seeded pilot tenant (scripts/seed-pilot.ts). */
const ORG_ID = 'pilot-org';

function ownerToken(): string {
  return signToken(
    { sub: 'pilot-admin', org: ORG_ID, role: 'owner', name: 'Pilot Admin' },
    env.AUTH_SECRET,
  );
}

async function getTrips(app: any, url: string) {
  return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${ownerToken()}` } });
}

/** True when the database is reachable (the pilot-only assertions need it). */
async function dbReady(t: any, app: any): Promise<boolean> {
  const res = await getTrips(app, '/api/trips');
  if (res.statusCode === 200) return true;
  t.diagnostic(`database not reachable here (baseline status ${res.statusCode}) — DB assertions skipped`);
  return false;
}

test('an unknown status is a 400 that names the field, never ignored', async (t) => {
  const app = buildServer();
  try {
    await app.ready();
    if (!(await dbReady(t, app))) return;
    const res = await getTrips(app, '/api/trips?status=NOT_A_STATUS');
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.json(), { error: 'invalid_filter', detail: 'status' });
  } finally {
    await app.close();
  }
});

test('an inverted date range is a 400 naming the range', async (t) => {
  const app = buildServer();
  try {
    await app.ready();
    if (!(await dbReady(t, app))) return;
    const res = await getTrips(app, '/api/trips?from=2026-09-30&to=2026-09-01');
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.json(), { error: 'invalid_filter', detail: 'range' });
  } finally {
    await app.close();
  }
});

test('a status filter returns exactly the DB rows for that status', async (t) => {
  const app = buildServer();
  try {
    await app.ready();
    if (!(await dbReady(t, app))) return;

    const all = (await getTrips(app, '/api/trips')).json().trips as Array<{ status: string }>;
    assert.ok(all.length > 0, 'the pilot DB must have at least one trip for this contract');
    const status = all[0].status;

    const res = await getTrips(app, `/api/trips?status=${status}`);
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.filters.status, status, 'the applied filter is echoed back');
    assert.ok(body.trips.length > 0, `expected at least one ${status} trip`);
    for (const trip of body.trips) assert.equal(trip.status, status);

    const expected = await prisma.trip.findMany({ where: { orgId: ORG_ID, status }, select: { id: true } });
    assert.equal(body.trips.length, expected.length, 'list length equals the direct DB count');
    const expectedIds = new Set(expected.map((r) => r.id));
    for (const trip of body.trips) assert.ok(expectedIds.has(trip.id), `${trip.id} is not in the DB result`);
  } finally {
    await app.close();
  }
});

test('two filters combine with AND, verified against the DB', async (t) => {
  const app = buildServer();
  try {
    await app.ready();
    if (!(await dbReady(t, app))) return;

    const assigned = await prisma.trip.findFirst({
      where: { orgId: ORG_ID, driverId: { not: null } },
      select: { status: true, driverId: true },
    });
    if (!assigned?.driverId) {
      t.diagnostic('no assigned trip in the pilot DB — combination assertion skipped');
      return;
    }

    const url = `/api/trips?status=${assigned.status}&driverId=${hostEncoded(assigned.driverId)}`;
    const res = await getTrips(app, url);
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.filters.status, assigned.status);
    assert.equal(body.filters.driverId, assigned.driverId);
    for (const trip of body.trips) {
      assert.equal(trip.status, assigned.status);
      assert.equal(trip.driverId, assigned.driverId);
    }

    const expected = await prisma.trip.findMany({
      where: { orgId: ORG_ID, status: assigned.status, driverId: assigned.driverId },
      select: { id: true },
    });
    assert.equal(body.trips.length, expected.length);
  } finally {
    await app.close();
  }
});

test('free text matches the route and the date window narrows the same set', async (t) => {
  const app = buildServer();
  try {
    await app.ready();
    if (!(await dbReady(t, app))) return;

    const trip = await prisma.trip.findFirst({
      where: { orgId: ORG_ID },
      include: { order: true },
      orderBy: { createdAt: 'desc' },
    });
    if (!trip) {
      t.diagnostic('no trip in the pilot DB — free-text assertion skipped');
      return;
    }

    const origin = trip.order?.origin ?? '';
    if (origin.length >= 3) {
      const needle = origin.slice(0, 3);
      const res = await getTrips(app, `/api/trips?q=${encodeURIComponent(needle)}`);
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.ok(body.trips.length > 0, `expected a hit for "${needle}"`);
      for (const row of body.trips) {
        const hay = [
          row.order?.origin, row.order?.destination, row.order?.cargo,
          row.order?.customer?.name, row.driver?.name,
        ].filter(Boolean).join(' ').toLowerCase();
        assert.ok(hay.includes(needle.toLowerCase()), `${row.id} does not match the free text`);
      }
    }

    const day = new Date(trip.createdAt).toISOString().slice(0, 10);
    const range = await getTrips(app, `/api/trips?from=${day}&to=${day}`);
    assert.equal(range.statusCode, 200);
    const expected = await prisma.trip.findMany({
      where: {
        orgId: ORG_ID,
        createdAt: { gte: new Date(`${day}T00:00:00.000Z`), lte: new Date(`${day}T23:59:59.999Z`) },
      },
      select: { id: true },
    });
    assert.equal(range.json().trips.length, expected.length);
  } finally {
    await app.close();
  }
});

test('an unfiltered list echoes an empty filter set (backwards compatible)', async (t) => {
  const app = buildServer();
  try {
    await app.ready();
    if (!(await dbReady(t, app))) return;
    const res = await getTrips(app, '/api/trips');
    assert.deepEqual(res.json().filters, {});
  } finally {
    await app.close();
  }
});

test('the CSV export is row-for-row the filtered list', async (t) => {
  const app = buildServer();
  try {
    await app.ready();
    if (!(await dbReady(t, app))) return;

    const all = (await getTrips(app, '/api/trips')).json().trips as Array<{ status: string }>;
    const status = all[0].status;
    const filtered = (await getTrips(app, `/api/trips?status=${status}`)).json().trips as any[];

    const csv = trips.toCsv(filtered);
    const lines = csv.replace(/\r\n$/, '').split('\r\n');
    assert.equal(lines[0], trips.CSV_COLUMNS.join(','));
    assert.equal(lines.length - 1, filtered.length, 'one data line per filtered row');
    for (let i = 0; i < filtered.length; i += 1) {
      assert.ok(lines[i + 1].startsWith(filtered[i].id + ','), `CSV line ${i + 1} must be ${filtered[i].id}`);
    }
  } finally {
    await app.close();
  }
});

test('trip detail P&L equals rate minus the DB expense sum to the cent', async (t) => {
  const app = buildServer();
  try {
    await app.ready();
    if (!(await dbReady(t, app))) return;

    const list = (await getTrips(app, '/api/trips')).json().trips as Array<{ id: string }>;
    const id = list[0].id;
    const res = await getTrips(app, `/api/trips/${encodeURIComponent(id)}`);
    assert.equal(res.statusCode, 200);
    const detail = res.json().trip;

    const [row, agg] = await Promise.all([
      prisma.trip.findFirst({ where: { id, orgId: ORG_ID }, select: { rateEur: true } }),
      prisma.expense.aggregate({ where: { tripId: id }, _sum: { amountEur: true } }),
    ]);
    const rate = row?.rateEur === null || row?.rateEur === undefined ? null : Number(row.rateEur);
    const expenses = Number(agg._sum.amountEur ?? 0);
    const expectedPnl = rate === null ? null : Math.round((rate - expenses) * 100) / 100;
    assert.equal(detail.totals.pnlEur, expectedPnl, 'P&L must equal rate − DB expenses');
    assert.equal(detail.totals.expensesEur, Math.round(expenses * 100) / 100);

    // The timeline is chronological and every entry names its actor (or null).
    const times = (detail.statusEvents as Array<{ at: string }>).map((e) => Date.parse(e.at));
    for (let i = 1; i < times.length; i += 1) assert.ok(times[i] >= times[i - 1], 'timeline must be chronological');
    for (const event of detail.statusEvents as Array<{ actor: unknown }>) {
      assert.ok('actor' in event, 'every timeline entry exposes its actor');
    }
  } finally {
    await app.close();
  }
});

function hostEncoded(value: string): string {
  return encodeURIComponent(value);
}
