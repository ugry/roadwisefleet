/**
 * HTTP-level acceptance for the driver phases + Start Trip tracking gate
 * (board task #105, AND1-A3).
 *
 * The acceptance contract:
 *   - `POST /api/trips/:id/start` is assigned-driver only: a non-assigned
 *     driver (and an owner/dispatcher token) is refused 403 and writes nothing;
 *   - a legal Start Trip moves ASSIGNED → EN_ROUTE and persists
 *     `tracking = true` + `trackingStartedAt`;
 *   - Start Trip is legal only from ASSIGNED (any other status is a 400
 *     `invalid_transition`);
 *   - exactly one active assignment per driver: moving a second trip onto a
 *     driver who already has one in flight is a 409 `driver_busy`, both through
 *     the status transition and through the assign endpoint.
 *
 * This drives the real `buildServer()` with `app.inject()` against the database
 * and re-derives every expectation with a direct Prisma query, so the route
 * cannot pass by accident. Everything it creates belongs to a THROWAWAY org, so
 * the pilot org other suites read is never touched (they run in parallel
 * processes); the fixtures are deleted in `finally` (no `onDelete: Cascade` in
 * this schema: dependents first).
 *
 * Runs the real API dependencies (`fastify`, `tsx`) and the pilot database:
 *
 *   pnpm --filter @roadwisefleet/api test:router
 *
 * Kept out of `src/` so the no-install CI job `node --test apps/api/src/` never
 * imports `fastify` or `@prisma/client`; the dependency-free half lives in
 * `../src/trips-core.test.js` and `../src/trip-status.test.js`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { signToken } from '../src/auth/tokens.js';

// Must be set before `env.ts` is imported: it throws when AUTH_SECRET is missing.
process.env.ALLOW_INSECURE_AUTH_SECRET = '1';

const { buildServer } = await import('../src/app.js');
const { env } = await import('../src/env.js');
const { prisma } = await import('../src/db.js');

/** The seeded pilot tenant (scripts/seed-pilot.ts) — used only for the DB probe. */
const ORG_ID = 'pilot-org';

function tokenFor(orgId: string, sub: string, role: string, name: string): string {
  return signToken({ sub, org: orgId, role, name }, env.AUTH_SECRET);
}

const PILOT_OWNER = tokenFor(ORG_ID, 'pilot-admin', 'owner', 'Pilot Admin');

/** True when the database is reachable (the DB assertions need it). */
async function dbReady(t: any, app: any): Promise<boolean> {
  const res = await app.inject({
    method: 'GET',
    url: '/api/trips',
    headers: { authorization: `Bearer ${PILOT_OWNER}` },
  });
  if (res.statusCode === 200) return true;
  t.diagnostic(`database not reachable here (baseline status ${res.statusCode}) — DB assertions skipped`);
  return false;
}

function start(app: any, token: string, tripId: string) {
  return app.inject({
    method: 'POST',
    url: `/api/trips/${encodeURIComponent(tripId)}/start`,
    headers: { authorization: `Bearer ${token}` },
    payload: {},
  });
}

function status(app: any, token: string, tripId: string, to: string) {
  return app.inject({
    method: 'POST',
    url: `/api/trips/${encodeURIComponent(tripId)}/status`,
    headers: { authorization: `Bearer ${token}` },
    payload: { status: to },
  });
}

function assign(app: any, token: string, tripId: string, driverId: string) {
  return app.inject({
    method: 'POST',
    url: `/api/trips/${encodeURIComponent(tripId)}/assign`,
    headers: { authorization: `Bearer ${token}` },
    payload: { driverId },
  });
}

test('Start Trip is assigned-driver only and persists tracking (#105)', async (t) => {
  const app = buildServer();
  const orgId = `phases-start-${Date.now()}`;
  /** @type {any} */
  const ids: { trips: string[]; users: string[] } = { trips: [], users: [] };
  try {
    await app.ready();
    if (!(await dbReady(t, app))) return;

    const marker = `phases-start-${Date.now()}`;

    // The driver role must exist for the fixture users; idempotent.
    await prisma.role.upsert({
      where: { id: 'driver' },
      update: {},
      create: { id: 'driver', permissions: ['trip:read', 'trip:status', 'pod:upload'] },
    });

    // A throwaway org: nothing this test writes can be seen by the pilot-org
    // suites that run beside it.
    const org = await prisma.org.create({ data: { id: orgId, name: marker } });
    const customer = await prisma.customer.create({ data: { orgId: org.id, name: marker } });
    const order = await prisma.order.create({
      data: { customerId: customer.id, origin: marker, destination: marker, status: 'BOOKED' },
    });
    const driverA = await prisma.user.create({ data: { orgId: org.id, roleId: 'driver', name: `${marker} A` } });
    const driverB = await prisma.user.create({ data: { orgId: org.id, roleId: 'driver', name: `${marker} B` } });
    const ownerUser = await prisma.user.create({ data: { orgId: org.id, roleId: 'owner', name: `${marker} Owner` } });

    const assigned = await prisma.trip.create({
      data: { orgId: org.id, orderId: order.id, status: 'ASSIGNED', driverId: driverA.id },
    });
    const draft = await prisma.trip.create({
      data: { orgId: org.id, orderId: order.id, status: 'DRAFT', driverId: driverA.id },
    });
    ids.trips = [assigned.id, draft.id];
    ids.users = [driverA.id, driverB.id, ownerUser.id];

    const owner = tokenFor(org.id, ownerUser.id, 'owner', `${marker} Owner`);
    const asA = tokenFor(org.id, driverA.id, 'driver', `${marker} A`);
    const asB = tokenFor(org.id, driverB.id, 'driver', `${marker} B`);

    // A non-assigned driver is refused with 403 and nothing is written.
    const denied = await start(app, asB, assigned.id);
    assert.equal(denied.statusCode, 403, JSON.stringify(denied.json()));
    assert.equal(denied.json().error, 'forbidden');
    let row = await prisma.trip.findUnique({
      where: { id: assigned.id },
      select: { status: true, tracking: true, trackingStartedAt: true },
    });
    assert.equal(row!.status, 'ASSIGNED');
    assert.equal(row!.tracking, false);

    // An owner/dispatcher token is not the assigned driver either.
    const byOwner = await start(app, owner, assigned.id);
    assert.equal(byOwner.statusCode, 403);

    // The assigned driver starts the trip: EN_ROUTE + tracking on.
    const started = await start(app, asA, assigned.id);
    assert.equal(started.statusCode, 200, JSON.stringify(started.json()));
    assert.equal(started.json().trip.status, 'EN_ROUTE');
    assert.equal(started.json().trip.tracking, true, 'the response carries the boolean');
    row = await prisma.trip.findUnique({
      where: { id: assigned.id },
      select: { status: true, tracking: true, trackingStartedAt: true },
    });
    assert.equal(row!.status, 'EN_ROUTE');
    assert.equal(row!.tracking, true, 'tracking is persisted');
    assert.ok(row!.trackingStartedAt instanceof Date, 'the start instant is stamped');

    // Starting an already-started trip is an illegal transition (400).
    const again = await start(app, asA, assigned.id);
    assert.equal(again.statusCode, 400);
    assert.equal(again.json().error, 'invalid_transition');
    assert.equal(again.json().from, 'EN_ROUTE');

    // A DRAFT trip is not startable even by its assigned driver.
    const notYet = await start(app, asA, draft.id);
    assert.equal(notYet.statusCode, 400);
    assert.equal(notYet.json().error, 'invalid_transition');
    assert.equal(notYet.json().from, 'DRAFT');
  } finally {
    if (ids.trips.length) await prisma.statusEvent.deleteMany({ where: { tripId: { in: ids.trips } } });
    if (ids.trips.length) await prisma.trip.deleteMany({ where: { id: { in: ids.trips } } });
    await prisma.order.deleteMany({ where: { customer: { orgId } } });
    await prisma.customer.deleteMany({ where: { orgId } });
    if (ids.users.length) await prisma.user.deleteMany({ where: { id: { in: ids.users } } });
    await prisma.org.deleteMany({ where: { id: orgId } });
    await app.close();
  }
});

test('exactly one active assignment per driver is enforced at the API (#105)', async (t) => {
  const app = buildServer();
  const orgId = `phases-busy-${Date.now()}`;
  /** @type {any} */
  const ids: { trips: string[]; users: string[] } = { trips: [], users: [] };
  try {
    await app.ready();
    if (!(await dbReady(t, app))) return;

    const marker = `phases-busy-${Date.now()}`;

    await prisma.role.upsert({
      where: { id: 'driver' },
      update: {},
      create: { id: 'driver', permissions: ['trip:read', 'trip:status', 'pod:upload'] },
    });

    const org = await prisma.org.create({ data: { id: orgId, name: marker } });
    const customer = await prisma.customer.create({ data: { orgId: org.id, name: marker } });
    const order = await prisma.order.create({
      data: { customerId: customer.id, origin: marker, destination: marker, status: 'BOOKED' },
    });
    const driverB = await prisma.user.create({ data: { orgId: org.id, roleId: 'driver', name: `${marker} B` } });
    const ownerUser = await prisma.user.create({ data: { orgId: org.id, roleId: 'owner', name: `${marker} Owner` } });

    // driverB already has a trip in flight (EN_ROUTE is an active phase).
    const inFlight = await prisma.trip.create({
      data: { orgId: org.id, orderId: order.id, status: 'EN_ROUTE', driverId: driverB.id, tracking: true },
    });
    // Two more trips aimed at the same driver, one not yet active, one unassigned.
    const drafted = await prisma.trip.create({
      data: { orgId: org.id, orderId: order.id, status: 'DRAFT', driverId: driverB.id },
    });
    const unassignedActive = await prisma.trip.create({
      data: { orgId: org.id, orderId: order.id, status: 'ASSIGNED', driverId: null },
    });
    ids.trips = [inFlight.id, drafted.id, unassignedActive.id];
    ids.users = [driverB.id, ownerUser.id];

    const owner = tokenFor(org.id, ownerUser.id, 'owner', `${marker} Owner`);

    // Moving the DRAFT trip into ASSIGNED would double-book driverB -> 409.
    const busyTransition = await status(app, owner, drafted.id, 'ASSIGNED');
    assert.equal(busyTransition.statusCode, 409, JSON.stringify(busyTransition.json()));
    assert.equal(busyTransition.json().error, 'driver_busy');
    assert.equal(
      (await prisma.trip.findUnique({ where: { id: drafted.id } }))!.status,
      'DRAFT',
      'the refused move wrote nothing',
    );

    // Assigning the same busy driver to an active trip -> 409 too.
    const busyAssign = await assign(app, owner, unassignedActive.id, driverB.id);
    assert.equal(busyAssign.statusCode, 409, JSON.stringify(busyAssign.json()));
    assert.equal(busyAssign.json().error, 'driver_busy');
    assert.equal((await prisma.trip.findUnique({ where: { id: unassignedActive.id } }))!.driverId, null);

    // Sanity: a driver with no active trip is still assignable (the gate is not
    // a blanket refusal) — driver is free once the in-flight trip is delivered.
    await prisma.trip.update({ where: { id: inFlight.id }, data: { status: 'DELIVERED', tracking: false } });
    const nowOk = await assign(app, owner, unassignedActive.id, driverB.id);
    assert.equal(nowOk.statusCode, 200, JSON.stringify(nowOk.json()));
    assert.equal(nowOk.json().trip.driverId, driverB.id);
  } finally {
    if (ids.trips.length) await prisma.statusEvent.deleteMany({ where: { tripId: { in: ids.trips } } });
    if (ids.trips.length) await prisma.trip.deleteMany({ where: { id: { in: ids.trips } } });
    await prisma.order.deleteMany({ where: { customer: { orgId } } });
    await prisma.customer.deleteMany({ where: { orgId } });
    if (ids.users.length) await prisma.user.deleteMany({ where: { id: { in: ids.users } } });
    await prisma.org.deleteMany({ where: { id: orgId } });
    await app.close();
  }
});
