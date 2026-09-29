/**
 * HTTP-level acceptance for driver assign/reassign (board task #36, FAv1-F5).
 *
 * The acceptance contract:
 *   - after a reassignment the PREVIOUS driver is refused on that trip (403)
 *     and no longer sees it in `GET /api/driver/trips`;
 *   - the NEW driver sees it there;
 *   - the trip timeline shows the reassignment with the correct actor;
 *   - reassigning to a suspended (locked) driver is refused.
 *
 * This test drives the real `buildServer()` with `app.inject()` against the
 * database and re-derives every expectation with a direct Prisma query, so the
 * route cannot pass by accident. Everything it creates belongs to a THROWAWAY
 * org, so the pilot org other suites read is never touched (they run in
 * parallel processes); the fixtures are deleted in `finally` (no
 * `onDelete: Cascade` in this schema: dependents first).
 *
 * Runs the real API dependencies (`fastify`, `tsx`) and the pilot database:
 *
 *   pnpm --filter @roadwisefleet/api test:router
 *
 * Kept out of `src/` so the no-install CI job `node --test apps/api/src/` never
 * imports `fastify` or `@prisma/client`; the dependency-free half lives in
 * `../src/trip-assignment.test.js`.
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

async function assign(app: any, token: string, tripId: string, driverId: string) {
  return app.inject({
    method: 'POST',
    url: `/api/trips/${encodeURIComponent(tripId)}/assign`,
    headers: { authorization: `Bearer ${token}` },
    payload: { driverId },
  });
}

async function driverTrips(app: any, token: string): Promise<string[]> {
  const res = await app.inject({
    method: 'GET',
    url: '/api/driver/trips',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200, 'the driver view is readable by the driver');
  return (res.json().trips as Array<{ id: string }>).map((trip) => trip.id);
}

test('reassigning a driver flips the before/after driver views and the timeline actor (#36)', async (t) => {
  const app = buildServer();
  const orgId = `assign-test-${Date.now()}`;
  /** @type {any} */
  const ids: { trip?: string; users: string[] } = { users: [] };
  try {
    await app.ready();
    if (!(await dbReady(t, app))) return;

    const marker = `assign-${Date.now()}`;

    // The driver role must exist for the fixture users; idempotent, and it
    // matches the seed exactly when the seed already ran.
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
    const suspended = await prisma.user.create({
      data: { orgId: org.id, roleId: 'driver', name: `${marker} locked`, lockedUntil: new Date(Date.now() + 86_400_000) },
    });
    // The acting owner must be a real User row: StatusEvent.actorId is a foreign
    // key, exactly as the seeded `pilot-admin` is in the pilot org.
    const ownerUser = await prisma.user.create({ data: { orgId: org.id, roleId: 'owner', name: `${marker} Owner` } });
    const trip = await prisma.trip.create({
      data: { orgId: org.id, orderId: order.id, status: 'ASSIGNED', driverId: driverA.id },
    });
    ids.trip = trip.id;
    ids.users = [driverA.id, driverB.id, suspended.id, ownerUser.id];

    const owner = tokenFor(org.id, ownerUser.id, 'owner', `${marker} Owner`);
    const asA = tokenFor(org.id, driverA.id, 'driver', `${marker} A`);
    const asB = tokenFor(org.id, driverB.id, 'driver', `${marker} B`);

    // The driver assigned to the trip may act on it; a driver may never reassign.
    const denied = await assign(app, asA, trip.id, driverB.id);
    assert.equal(denied.statusCode, 403, 'a driver cannot assign');
    assert.equal((await prisma.trip.findUnique({ where: { id: trip.id } }))!.driverId, driverA.id);
    assert.equal(
      await prisma.statusEvent.count({ where: { tripId: trip.id } }),
      0,
      'a denied assign writes no timeline event',
    );

    // BEFORE: the first driver sees it, the second does not.
    assert.ok((await driverTrips(app, asA)).includes(trip.id));
    assert.ok(!(await driverTrips(app, asB)).includes(trip.id));

    // The owner (trip:*) reassigns.
    const res = await assign(app, owner, trip.id, driverB.id);
    assert.equal(res.statusCode, 200, JSON.stringify(res.json()));
    const body = res.json();
    assert.equal(body.trip.driverId, driverB.id);
    assert.equal(body.previousDriverId, driverA.id);
    assert.equal(body.driver.id, driverB.id);

    const row = await prisma.trip.findUnique({ where: { id: trip.id }, select: { driverId: true, status: true } });
    assert.equal(row!.driverId, driverB.id, 'the DB carries the new driver');
    assert.equal(row!.status, 'ASSIGNED', 'the status did not move');

    // AFTER: the previous driver no longer sees it and is refused on it; the new
    // driver sees it.
    const aTrips = await driverTrips(app, asA);
    assert.ok(!aTrips.includes(trip.id), 'the previous driver no longer sees the trip');
    const refused = await app.inject({
      method: 'POST',
      url: `/api/trips/${trip.id}/status`,
      headers: { authorization: `Bearer ${asA}` },
      payload: { status: 'LOADED' },
    });
    assert.equal(refused.statusCode, 403, 'the previous driver is refused on that trip');
    assert.ok((await driverTrips(app, asB)).includes(trip.id), 'the new driver sees it');

    // Timeline: one event, still ASSIGNED -> ASSIGNED, naming the acting owner.
    const detail = await app.inject({
      method: 'GET',
      url: `/api/trips/${trip.id}`,
      headers: { authorization: `Bearer ${owner}` },
    });
    assert.equal(detail.statusCode, 200);
    const events = detail.json().trip.statusEvents as Array<any>;
    assert.equal(events.length, 1, 'exactly the reassignment event');
    assert.equal(events[0].kind, 'reassignment');
    assert.equal(events[0].from, 'ASSIGNED');
    assert.equal(events[0].to, 'ASSIGNED');
    assert.equal(events[0].actor.name, `${marker} Owner`);
    assert.equal(detail.json().trip.driver.id, driverB.id, 'the detail names the new driver');

    // A suspended (locked) driver is refused with 409, and nothing changes.
    const unavailable = await assign(app, owner, trip.id, suspended.id);
    assert.equal(unavailable.statusCode, 409);
    assert.equal(unavailable.json().error, 'driver_unavailable');
    assert.equal((await prisma.trip.findUnique({ where: { id: trip.id } }))!.driverId, driverB.id);

    // Assigning the driver already on the trip is a conflict, not a silent no-op.
    const same = await assign(app, owner, trip.id, driverB.id);
    assert.equal(same.statusCode, 409);
    assert.equal(same.json().error, 'already_assigned');

    // A driver we do not know is a 400 (same contract as create-trip).
    const ghost = await assign(app, owner, trip.id, 'no-such-driver');
    assert.equal(ghost.statusCode, 400);
    assert.equal(ghost.json().error, 'driver_not_found');

    // Exactly one event still: the refusals wrote nothing.
    assert.equal(await prisma.statusEvent.count({ where: { tripId: trip.id } }), 1);
  } finally {
    // No `onDelete: Cascade` in this schema: delete dependents before the trip.
    if (ids.trip) await prisma.statusEvent.deleteMany({ where: { tripId: ids.trip } });
    if (ids.trip) await prisma.trip.deleteMany({ where: { id: ids.trip } });
    await prisma.order.deleteMany({ where: { customer: { orgId } } });
    await prisma.customer.deleteMany({ where: { orgId } });
    if (ids.users.length) await prisma.user.deleteMany({ where: { id: { in: ids.users } } });
    await prisma.org.deleteMany({ where: { id: orgId } });
    await app.close();
  }
});
