/**
 * Alternate endings A3–A6 over real HTTP + database (board task #127, UXF-O4).
 *
 * The acceptance contract from the issue:
 *   - each ending is reachable from its documented source status (diagram 07:
 *     AT_PICKUP → REFUSED, EN_ROUTE → BREAKDOWN, IN_TRANSIT → DELAYED,
 *     AT_DELIVERY → CUSTOMS_HOLD);
 *   - every move writes the audit event (from/to/actor) the timeline reads;
 *   - an illegal source is a 400 `invalid_transition` and writes nothing;
 *   - an employed driver may report REFUSED / BREAKDOWN on their own trip but
 *     not decide a recovery or a carrier-only ending (403);
 *   - tenant isolation is unchanged: another org's owner reads 404, never 403.
 *
 * Drives the real `buildServer()` with `app.inject()` and re-derives every
 * expectation with a direct Prisma query, so the route cannot pass by accident.
 * The whole fixture lives in a THROWAWAY org and is deleted in `finally`
 * (dependent rows first — this schema has no `onDelete: Cascade`), because
 * `tsx --test` runs test files concurrently.
 *
 *   pnpm --filter @roadwisefleet/api test:router
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { signToken } from '../src/auth/tokens.js';

process.env.ALLOW_INSECURE_AUTH_SECRET = '1';

const { buildServer } = await import('../src/app.js');
const { env } = await import('../src/env.js');
const { prisma } = await import('../src/db.js');

const PILOT_OWNER = signToken(
  { sub: 'pilot-admin', org: 'pilot-org', role: 'owner', name: 'Pilot Admin' },
  env.AUTH_SECRET,
);

function tokenFor(orgId: string, sub: string, role: string, name: string): string {
  return signToken({ sub, org: orgId, role, name }, env.AUTH_SECRET);
}

function status(app: any, token: string, tripId: string, to: string) {
  return app.inject({
    method: 'POST',
    url: `/api/trips/${encodeURIComponent(tripId)}/status`,
    headers: { authorization: `Bearer ${token}` },
    payload: { status: to },
  });
}

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

test('each diagram-07 ending is reachable, audited and resumable (#127)', async (t) => {
  const app = buildServer();
  const orgId = `disrupt-${Date.now()}`;
  const ids: { trips: string[]; users: string[] } = { trips: [], users: [] };
  try {
    await app.ready();
    if (!(await dbReady(t, app))) return;
    const marker = `disrupt-${Date.now()}`;

    await prisma.role.upsert({
      where: { id: 'dispatcher' },
      update: {},
      create: { id: 'dispatcher', permissions: ['trip:*', 'user:read'] },
    });

    const org = await prisma.org.create({ data: { id: orgId, name: marker } });
    const customer = await prisma.customer.create({ data: { orgId: org.id, name: marker } });
    const order = await prisma.order.create({
      data: { customerId: customer.id, origin: marker, destination: marker, status: 'BOOKED' },
    });
    const dispatcherUser = await prisma.user.create({
      data: { orgId: org.id, roleId: 'dispatcher', name: `${marker} Dispatcher` },
    });
    ids.users.push(dispatcherUser.id);
    const dispatcher = tokenFor(org.id, dispatcherUser.id, 'dispatcher', `${marker} Dispatcher`);

    const cases = [
      { ending: 'REFUSED', source: 'AT_PICKUP', resume: 'LOADED' },
      { ending: 'BREAKDOWN', source: 'EN_ROUTE', resume: 'EN_ROUTE' },
      { ending: 'DELAYED', source: 'IN_TRANSIT', resume: 'IN_TRANSIT' },
      { ending: 'CUSTOMS_HOLD', source: 'AT_DELIVERY', resume: 'AT_DELIVERY' },
    ];

    for (const c of cases) {
      const trip = await prisma.trip.create({
        data: { orgId: org.id, orderId: order.id, status: c.source, tracking: true },
      });
      ids.trips.push(trip.id);

      const moved = await status(app, dispatcher, trip.id, c.ending);
      assert.equal(moved.statusCode, 200, `${c.ending}: ${JSON.stringify(moved.json())}`);
      assert.equal(moved.json().trip.status, c.ending);

      const row = await prisma.trip.findUnique({ where: { id: trip.id }, select: { status: true } });
      assert.equal(row!.status, c.ending, `${c.ending} is persisted`);

      const event = await prisma.statusEvent.findFirst({
        where: { tripId: trip.id },
        orderBy: { happenedAt: 'desc' },
      });
      assert.ok(event, `${c.ending} wrote an audit event`);
      assert.equal(event!.fromStatus, c.source);
      assert.equal(event!.toStatus, c.ending);
      assert.equal(event!.actorId, dispatcherUser.id, 'the audit event names the actor');

      const resumed = await status(app, dispatcher, trip.id, c.resume);
      assert.equal(resumed.statusCode, 200, `${c.ending} resumes to ${c.resume}`);
      assert.equal(resumed.json().trip.status, c.resume);
    }
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

test('an ending from the wrong source is a 400 and writes nothing (#127)', async (t) => {
  const app = buildServer();
  const orgId = `disrupt-src-${Date.now()}`;
  const ids: { trips: string[]; users: string[] } = { trips: [], users: [] };
  try {
    await app.ready();
    if (!(await dbReady(t, app))) return;
    const marker = `disrupt-src-${Date.now()}`;

    await prisma.role.upsert({
      where: { id: 'owner' },
      update: {},
      create: { id: 'owner', permissions: ['org:manage', 'trip:*'] },
    });

    const org = await prisma.org.create({ data: { id: orgId, name: marker } });
    const customer = await prisma.customer.create({ data: { orgId: org.id, name: marker } });
    const order = await prisma.order.create({
      data: { customerId: customer.id, origin: marker, destination: marker, status: 'BOOKED' },
    });
    const ownerUser = await prisma.user.create({ data: { orgId: org.id, roleId: 'owner', name: marker } });
    ids.users.push(ownerUser.id);
    const owner = tokenFor(org.id, ownerUser.id, 'owner', marker);

    const draft = await prisma.trip.create({
      data: { orgId: org.id, orderId: order.id, status: 'DRAFT' },
    });
    const inTransit = await prisma.trip.create({
      data: { orgId: org.id, orderId: order.id, status: 'IN_TRANSIT' },
    });
    ids.trips.push(draft.id, inTransit.id);

    // None of the endings may be entered from DRAFT, and CUSTOMS_HOLD has one
    // source only — a border hold is not a mid-transit button.
    for (const ending of ['REFUSED', 'BREAKDOWN', 'DELAYED', 'CUSTOMS_HOLD']) {
      const res = await status(app, owner, draft.id, ending);
      assert.equal(res.statusCode, 400, `${ending} from DRAFT: ${JSON.stringify(res.json())}`);
      assert.equal(res.json().error, 'invalid_transition');
      assert.equal(res.json().from, 'DRAFT');
      assert.equal(res.json().to, ending);
    }
    const wrongSource = await status(app, owner, inTransit.id, 'CUSTOMS_HOLD');
    assert.equal(wrongSource.statusCode, 400);
    assert.equal(wrongSource.json().error, 'invalid_transition');

    const rows = await prisma.trip.findMany({ where: { id: { in: [draft.id, inTransit.id] } } });
    assert.deepEqual(rows.map((r: any) => r.status).sort(), ['DRAFT', 'IN_TRANSIT']);
    const events = await prisma.statusEvent.count({ where: { tripId: { in: [draft.id, inTransit.id] } } });
    assert.equal(events, 0, 'a refused move writes no audit event');
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

test('driver may report REFUSED/BREAKDOWN on their trip, never a carrier decision (#127)', async (t) => {
  const app = buildServer();
  const orgId = `disrupt-driver-${Date.now()}`;
  const ids: { trips: string[]; users: string[] } = { trips: [], users: [] };
  try {
    await app.ready();
    if (!(await dbReady(t, app))) return;
    const marker = `disrupt-driver-${Date.now()}`;

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
    const driverA = await prisma.user.create({ data: { orgId: org.id, roleId: 'driver', name: `${marker} A` } });
    const driverB = await prisma.user.create({ data: { orgId: org.id, roleId: 'driver', name: `${marker} B` } });
    const driverC = await prisma.user.create({ data: { orgId: org.id, roleId: 'driver', name: `${marker} C` } });
    ids.users.push(driverA.id, driverB.id, driverC.id);

    const atPickup = await prisma.trip.create({
      data: { orgId: org.id, orderId: order.id, status: 'AT_PICKUP', driverId: driverA.id, tracking: true },
    });
    const inTransit = await prisma.trip.create({
      data: { orgId: org.id, orderId: order.id, status: 'IN_TRANSIT', driverId: driverC.id, tracking: true },
    });
    ids.trips.push(atPickup.id, inTransit.id);

    const enRoute = await prisma.trip.create({
      data: { orgId: org.id, orderId: order.id, status: 'EN_ROUTE', driverId: driverB.id, tracking: true },
    });
    ids.trips.push(enRoute.id);

    const asA = tokenFor(org.id, driverA.id, 'driver', `${marker} A`);
    const asB = tokenFor(org.id, driverB.id, 'driver', `${marker} B`);
    const asC = tokenFor(org.id, driverC.id, 'driver', `${marker} C`);

    // The assigned driver reports each driver-reportable ending.
    const refused = await status(app, asA, atPickup.id, 'REFUSED');
    assert.equal(refused.statusCode, 200, JSON.stringify(refused.json()));
    const brokenDown = await status(app, asB, enRoute.id, 'BREAKDOWN');
    assert.equal(brokenDown.statusCode, 200, JSON.stringify(brokenDown.json()));
    const delayed = await status(app, asC, inTransit.id, 'DELAYED');
    assert.equal(delayed.statusCode, 403, 'DELAYED is a carrier decision');
    assert.equal(delayed.json().error, 'forbidden');

    // Recovery is the carrier's, even on the trip they reported.
    const driverResume = await status(app, asA, atPickup.id, 'LOADED');
    assert.equal(driverResume.statusCode, 403);
    assert.equal(driverResume.json().error, 'forbidden');
    assert.equal(
      (await prisma.trip.findUnique({ where: { id: atPickup.id }, select: { status: true } }))!.status,
      'REFUSED',
      'the refused recovery wrote nothing',
    );

    // Another driver sees nothing to act on.
    const other = await status(app, asB, atPickup.id, 'LOADED');
    assert.equal(other.statusCode, 403);

    // CUSTOMS_HOLD is never a driver report.
    const customs = await prisma.trip.create({
      data: { orgId: org.id, orderId: order.id, status: 'AT_DELIVERY', driverId: driverA.id, tracking: false },
    });
    ids.trips.push(customs.id);
    const held = await status(app, asA, customs.id, 'CUSTOMS_HOLD');
    assert.equal(held.statusCode, 403);
    assert.equal(held.json().error, 'forbidden');
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

test('tenant isolation is unchanged for the endings (#127)', async (t) => {
  const app = buildServer();
  const orgA = `disrupt-a-${Date.now()}`;
  const orgB = `disrupt-b-${Date.now()}`;
  const ids: { trips: string[]; users: string[] } = { trips: [], users: [] };
  try {
    await app.ready();
    if (!(await dbReady(t, app))) return;
    const marker = `disrupt-tenant-${Date.now()}`;
    await prisma.role.upsert({
      where: { id: 'owner' },
      update: {},
      create: { id: 'owner', permissions: ['org:manage', 'trip:*'] },
    });

    const a = await prisma.org.create({ data: { id: orgA, name: marker } });
    const b = await prisma.org.create({ data: { id: orgB, name: marker } });
    const customer = await prisma.customer.create({ data: { orgId: a.id, name: marker } });
    const order = await prisma.order.create({
      data: { customerId: customer.id, origin: marker, destination: marker, status: 'BOOKED' },
    });
    const ownerA = await prisma.user.create({ data: { orgId: a.id, roleId: 'owner', name: marker } });
    const ownerB = await prisma.user.create({ data: { orgId: b.id, roleId: 'owner', name: marker } });
    ids.users.push(ownerA.id, ownerB.id);

    const trip = await prisma.trip.create({
      data: { orgId: a.id, orderId: order.id, status: 'IN_TRANSIT' },
    });
    ids.trips.push(trip.id);
    const asB = tokenFor(b.id, ownerB.id, 'owner', marker);

    const res = await status(app, asB, trip.id, 'DELAYED');
    assert.equal(res.statusCode, 404, 'another tenant must not learn the trip exists');
    assert.equal(res.json().error, 'not_found');
    assert.equal(
      (await prisma.trip.findUnique({ where: { id: trip.id }, select: { status: true } }))!.status,
      'IN_TRANSIT',
    );
  } finally {
    if (ids.trips.length) await prisma.statusEvent.deleteMany({ where: { tripId: { in: ids.trips } } });
    if (ids.trips.length) await prisma.trip.deleteMany({ where: { id: { in: ids.trips } } });
    await prisma.order.deleteMany({ where: { customer: { orgId: orgA } } });
    await prisma.customer.deleteMany({ where: { orgId: orgA } });
    if (ids.users.length) await prisma.user.deleteMany({ where: { id: { in: ids.users } } });
    await prisma.org.deleteMany({ where: { id: { in: [orgA, orgB] } } });
    await app.close();
  }
});
