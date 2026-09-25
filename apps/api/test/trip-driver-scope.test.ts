/**
 * Driver read-isolation regression test (board task #68, UG#38).
 *
 * A driver token could read the whole org's trip list and any other driver's
 * trip detail (writes were already correctly 403). This test drives the real
 * `buildServer()` with `app.inject()` against real signed tokens and the pilot
 * database, and proves:
 *
 *   1. driver A's list contains only driver A's trips, and A reads A's trip (200);
 *   2. driver B reads B's own trip (200) but A's trip is **404**, never 403
 *      (no existence leak) — and B's list never contains A's trip;
 *   3. a driver with no trips gets exactly 0 rows;
 *   4. a `?driverId=<somebody-else>` query cannot widen a driver's scope;
 *   5. the owner (a `trip:*` role) still reads the whole org and any trip — the
 *      org-wide behaviour is unchanged.
 *
 * The fixture lives in its **own org** (`qa-scope-org`), not the seeded pilot org,
 * so the rows this test writes can never race the concurrent DB-backed suites
 * (which all query the pilot org); it is removed in the `after` hook. The test
 * early-returns when no database is reachable, so it runs on a bare checkout.
 *
 * Runs the real API dependencies (`fastify`, `tsx`) and the database:
 *
 *   pnpm --filter @roadwisefleet/api test:router
 *
 * Kept out of `src/` so the no-install CI job never imports `fastify` /
 * `@prisma/client`; the dependency-free half is `../src/trip-visibility.test.js`.
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { signToken } from '../src/auth/tokens.js';

// Must be set before `env.ts` is imported: it throws when AUTH_SECRET is missing.
process.env.ALLOW_INSECURE_AUTH_SECRET = '1';

const { buildServer } = await import('../src/app.js');
const { env } = await import('../src/env.js');
const { prisma } = await import('../src/db.js');

/** A dedicated, isolated tenant so this test cannot race the pilot-org suites. */
const ORG_ID = 'qa-scope-org';
const OWNER = 'qa-scope-owner';
const DRIVER_A = 'qa-scope-driver-a';
const DRIVER_B = 'qa-scope-driver-b';
const DRIVER_NONE = 'qa-scope-driver-none';
const CUSTOMER_ID = 'qa-scope-customer';
const ORDER_ID = 'qa-scope-order';
const TRIP_A = 'qa-scope-trip-a';
const TRIP_B = 'qa-scope-trip-b';
const USER_IDS = [OWNER, DRIVER_A, DRIVER_B, DRIVER_NONE];
const TRIP_IDS = [TRIP_A, TRIP_B];

/** Set by `before`; when false every test early-returns (bare checkout). */
let dbReachable = false;
let app: any;

function token(sub: string, role: string, name: string): string {
  return signToken({ sub, org: ORG_ID, role, name }, env.AUTH_SECRET);
}

const driverToken = (id: string, name: string) => token(id, 'driver', name);
const ownerToken = () => token(OWNER, 'owner', 'QA Scope Owner');

/** Delete every dependent row the schema has no `onDelete: Cascade` for. */
async function removeFixture(): Promise<void> {
  try {
    const where = { tripId: { in: TRIP_IDS } };
    await prisma.$transaction([
      prisma.statusEvent.deleteMany({ where }),
      prisma.gpsPing.deleteMany({ where }),
      prisma.expense.deleteMany({ where }),
      prisma.document.deleteMany({ where }),
      prisma.settlement.deleteMany({ where }),
      prisma.tripStop.deleteMany({ where }),
      prisma.tripDriver.deleteMany({ where }),
      prisma.trip.deleteMany({ where: { id: { in: TRIP_IDS } } }),
      prisma.order.deleteMany({ where: { id: ORDER_ID } }),
      prisma.customer.deleteMany({ where: { id: CUSTOMER_ID } }),
      prisma.user.deleteMany({ where: { id: { in: USER_IDS } } }),
      prisma.org.deleteMany({ where: { id: ORG_ID } }),
    ]);
  } catch {
    /* best-effort cleanup: never fail the suite on teardown */
  }
}

before(async () => {
  try {
    // A direct probe is the cheapest reachability check, before any fixture write.
    await prisma.org.findFirst({ where: { id: 'pilot-org' } });
    await removeFixture(); // idempotent: clear a prior failed run first

    await prisma.org.create({ data: { id: ORG_ID, name: 'QA Scope Org', locale: 'en', dataRegion: 'eu', plan: 'free' } });
    for (const [id, roleId, name, email] of [
      [OWNER, 'owner', 'QA Scope Owner', 'qa-scope-owner@roadwisefleet.test'],
      [DRIVER_A, 'driver', 'QA Scope A', 'qa-scope-a@roadwisefleet.test'],
      [DRIVER_B, 'driver', 'QA Scope B', 'qa-scope-b@roadwisefleet.test'],
      [DRIVER_NONE, 'driver', 'QA Scope None', 'qa-scope-none@roadwisefleet.test'],
    ]) {
      await prisma.user.create({ data: { id, orgId: ORG_ID, roleId, name, email, lang: 'en' } });
    }
    await prisma.customer.create({ data: { id: CUSTOMER_ID, orgId: ORG_ID, name: 'QA Scope Customer' } });
    await prisma.order.create({ data: { id: ORDER_ID, customerId: CUSTOMER_ID, origin: 'QA', destination: 'Scope' } });
    await prisma.trip.create({ data: { id: TRIP_A, orgId: ORG_ID, orderId: ORDER_ID, driverId: DRIVER_A } });
    await prisma.trip.create({ data: { id: TRIP_B, orgId: ORG_ID, orderId: ORDER_ID, driverId: DRIVER_B } });

    app = buildServer();
    await app.ready();
    dbReachable = true;
  } catch (err) {
    console.error('fixture setup failed — DB assertions will be skipped:', (err as Error).message);
  }
});

after(async () => {
  await removeFixture();
  if (app) await app.close();
  await prisma.$disconnect();
});

function get(bearer: string, url: string) {
  return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${bearer}` } });
}

test('a driver lists only their own trips and reads their own trip', async (t) => {
  if (!dbReachable) return t.diagnostic('database not reachable here — assertions skipped');

  const res = await get(driverToken(DRIVER_A, 'QA Scope A'), '/api/trips');
  assert.equal(res.statusCode, 200);
  const trips = res.json().trips as Array<{ id: string; driverId: string }>;
  assert.deepEqual(
    trips.map((trip) => trip.id),
    [TRIP_A],
    "driver A must see exactly their own trip",
  );
  assert.ok(trips.every((trip) => trip.driverId === DRIVER_A), 'every row must belong to the caller');

  const own = await get(driverToken(DRIVER_A, 'QA Scope A'), `/api/trips/${TRIP_A}`);
  assert.equal(own.statusCode, 200, 'a driver reads their own trip');
});

test("another driver's trip is 404, never 403 (no existence leak)", async (t) => {
  if (!dbReachable) return t.diagnostic('database not reachable here — assertions skipped');

  const bearer = driverToken(DRIVER_B, 'QA Scope B');
  const list = await get(bearer, '/api/trips');
  assert.equal(list.statusCode, 200);
  const ids = (list.json().trips as Array<{ id: string }>).map((trip) => trip.id);
  assert.deepEqual(ids, [TRIP_B], "driver B's list is exactly their own trip, never driver A's");

  const own = await get(bearer, `/api/trips/${TRIP_B}`);
  assert.equal(own.statusCode, 200, 'the same token still reads its own trip');

  const other = await get(bearer, `/api/trips/${TRIP_A}`);
  assert.equal(other.statusCode, 404, "another driver's trip must read as 404");
  assert.equal(other.json().error, 'not_found', 'the body must not reveal which check failed');
});

test('a driver with no trips gets exactly zero rows', async (t) => {
  if (!dbReachable) return t.diagnostic('database not reachable here — assertions skipped');

  const res = await get(driverToken(DRIVER_NONE, 'QA Scope None'), '/api/trips');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().trips, [], 'a driver with no trips must get an empty list');
});

test('a driver cannot widen the scope with ?driverId=<somebody else>', async (t) => {
  if (!dbReachable) return t.diagnostic('database not reachable here — assertions skipped');

  const res = await get(driverToken(DRIVER_A, 'QA Scope A'), `/api/trips?driverId=${DRIVER_B}`);
  assert.equal(res.statusCode, 200);
  const trips = res.json().trips as Array<{ id: string; driverId: string }>;
  assert.ok(!trips.some((trip) => trip.id === TRIP_B), 'the client-supplied driverId must not widen the scope');
  assert.ok(trips.every((trip) => trip.driverId === DRIVER_A), 'the forced scope wins');
  assert.equal(res.json().filters.driverId, DRIVER_A, 'the echoed filter set must show the scope actually applied');
});

test('the owner (trip:*) still reads the whole org and any trip', async (t) => {
  if (!dbReachable) return t.diagnostic('database not reachable here — assertions skipped');

  const bearer = ownerToken();
  const list = await get(bearer, '/api/trips');
  assert.equal(list.statusCode, 200);
  const ids = (list.json().trips as Array<{ id: string }>).map((trip) => trip.id).sort();
  assert.deepEqual(ids, [TRIP_A, TRIP_B].sort(), 'the org-wide reader sees every trip');

  assert.equal((await get(bearer, `/api/trips/${TRIP_A}`)).statusCode, 200);
  assert.equal((await get(bearer, `/api/trips/${TRIP_B}`)).statusCode, 200);
});
