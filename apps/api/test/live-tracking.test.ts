/**
 * HTTP-level acceptance for the live tracking surfaces (board task #107,
 * AND1-A5): the customer portal and the fleet web app read the SAME realtime
 * stream, but each is scoped to what it may see.
 *
 * The acceptance contract this pins:
 *   - a customer reads only their OWN cargo: another customer's order is a flat
 *     404, never a 403 (no existence leak) and the list is scoped server-side;
 *   - only a CURRENT trip (tracking = true) is live: a delivered trip reports
 *     `tracking: false`, so the surface says "not started yet"/"completed"
 *     instead of drawing a live map;
 *   - fleet scoping: an owner only reaches trips in their own org — another
 *     org's trip is a 404 — and a customer token has no org at all (403);
 *   - the public tracking payload stays PII-free (route/cargo/status/tracking
 *     only — no driver, customer or rate) and carries the `tracking` flag the
 *     live surfaces read.
 *
 * Realtime delivery itself (a new point reaching a scoped subscriber over a REAL
 * socket) is exercised in `gps-ingest.test.ts` (#106); this file checks the
 * scoping boundaries of the same streams.
 *
 * Drives the real `buildServer()` against the database. Everything it creates
 * belongs to a THROWAWAY org, so the pilot-org suites running in parallel
 * processes are untouched; fixtures are deleted in `finally` (dependents first —
 * no `onDelete: Cascade` in this schema).
 *
 *   pnpm --filter @roadwisefleet/api test:router
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { signToken } from '../src/auth/tokens.js';

// Must be set before `env.ts` is imported: it throws when AUTH_SECRET is missing.
process.env.ALLOW_INSECURE_AUTH_SECRET = '1';

const { buildServer } = await import('../src/app.js');
const { env } = await import('../src/env.js');
const { prisma } = await import('../src/db.js');
const { signTrackLink } = await import('../src/track-link.js');

function tokenFor(orgId: string | null, sub: string, role: string, name: string): string {
  return signToken({ sub, org: orgId, role, name }, env.AUTH_SECRET);
}

async function dbReady(t: any): Promise<boolean> {
  try {
    await prisma.org.count();
    return true;
  } catch (err) {
    t.diagnostic(`database not reachable here (${(err as Error).message}) — DB assertions skipped`);
    return false;
  }
}

/** Ensure the `customer` role row exists (the deploy path creates it). */
async function ensureCustomerRole() {
  await prisma.role.upsert({
    where: { id: 'customer' },
    update: {},
    create: { id: 'customer', permissions: ['order:create', 'order:read', 'customer:manage'] },
  });
}

/** Delete every fixture row this file creates (dependents first). */
async function cleanup(orgId: string) {
  await prisma.gpsPing.deleteMany({ where: { trip: { orgId } } }).catch(() => undefined);
  await prisma.statusEvent.deleteMany({ where: { trip: { orgId } } }).catch(() => undefined);
  await prisma.trip.deleteMany({ where: { orgId } }).catch(() => undefined);
  await prisma.order.deleteMany({ where: { customer: { orgId } } }).catch(() => undefined);
  await prisma.customerAccount.deleteMany({ where: { customer: { orgId } } }).catch(() => undefined);
  await prisma.customer.deleteMany({ where: { orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { orgId } }).catch(() => undefined);
  await prisma.org.deleteMany({ where: { id: orgId } }).catch(() => undefined);
}

test('a customer reads only their own cargo, and only the current trip is live (#107)', async (t) => {
  const app = buildServer();
  const orgId = `live-scope-${Date.now()}`;
  try {
    await app.ready();
    if (!(await dbReady(t))) return;
    await ensureCustomerRole();

    const marker = `live-scope-${Date.now()}`;
    const org = await prisma.org.create({ data: { id: orgId, name: marker } });
    // Two customers of the same carrier; each has one login.
    const customerA = await prisma.customer.create({ data: { orgId: org.id, name: `${marker} A` } });
    const customerB = await prisma.customer.create({ data: { orgId: org.id, name: `${marker} B` } });
    const userA = await prisma.user.create({
      data: { orgId: null, roleId: 'customer', name: `${marker} A`, email: `${marker}-a@example.test` },
    });
    const userB = await prisma.user.create({
      data: { orgId: null, roleId: 'customer', name: `${marker} B`, email: `${marker}-b@example.test` },
    });
    await prisma.customerAccount.create({ data: { userId: userA.id, customerId: customerA.id } });
    await prisma.customerAccount.create({ data: { userId: userB.id, customerId: customerB.id } });
    // A: an in-flight trip (tracking on) and a delivered one.
    const orderA = await prisma.order.create({
      data: { customerId: customerA.id, origin: `${marker} A-src`, destination: `${marker} A-dst`, status: 'BOOKED', cargo: 'steel coils' },
    });
    const liveTrip = await prisma.trip.create({
      data: { orgId: org.id, orderId: orderA.id, status: 'EN_ROUTE', tracking: true },
    });
    const orderA2 = await prisma.order.create({
      data: { customerId: customerA.id, origin: `${marker} A2-src`, destination: `${marker} A2-dst`, status: 'DELIVERED' },
    });
    const doneTrip = await prisma.trip.create({
      data: { orgId: org.id, orderId: orderA2.id, status: 'DELIVERED', tracking: false },
    });
    // B: an entirely separate order.
    const orderB = await prisma.order.create({
      data: { customerId: customerB.id, origin: `${marker} B-src`, destination: `${marker} B-dst`, status: 'BOOKED' },
    });

    const asA = tokenFor(null, userA.id, 'customer', `${marker} A`);

    // The list is scoped server-side: only A's orders.
    const list = await app.inject({ method: 'GET', url: '/api/customer/orders', headers: { authorization: `Bearer ${asA}` } });
    assert.equal(list.statusCode, 200, list.body);
    const ids = (list.json().orders as any[]).map((o) => o.id);
    assert.ok(ids.includes(orderA.id));
    assert.ok(!ids.includes(orderB.id), "another customer's order is not listed");
    // The live flag travels with the shipment: EN_ROUTE tracking=true, DELIVERED false.
    const liveSummary = (list.json().orders as any[]).find((o) => o.id === orderA.id);
    assert.equal(liveSummary.trip.tracking, true);
    const doneSummary = (list.json().orders as any[]).find((o) => o.id === orderA2.id);
    assert.equal(doneSummary.trip.tracking, false);

    // Customer B's order is "not found" for A — never a 403 (no existence leak).
    const foreign = await app.inject({
      method: 'GET',
      url: `/api/customer/orders/${encodeURIComponent(orderB.id)}`,
      headers: { authorization: `Bearer ${asA}` },
    });
    assert.equal(foreign.statusCode, 404, foreign.body);
    assert.equal(foreign.json().error, 'not_found');

    // A's own live shipment reads back with tracking on and no fleet internals.
    const own = await app.inject({
      method: 'GET',
      url: `/api/customer/orders/${encodeURIComponent(orderA.id)}`,
      headers: { authorization: `Bearer ${asA}` },
    });
    assert.equal(own.statusCode, 200, own.body);
    assert.equal(own.json().order.trip.tracking, true);
    const raw = JSON.stringify(own.json());
    for (const forbidden of ['driverId', 'passwordHash', 'rateEur', 'plate']) {
      assert.ok(!raw.includes(forbidden), `the customer payload must not carry ${forbidden}`);
    }

    // Sanity: the fixtures are the ones we think they are.
    assert.notEqual(liveTrip.id, doneTrip.id);
  } finally {
    await cleanup(orgId);
    await app.close();
  }
});

test('the public payload carries the tracking flag and stays PII-free (#107)', async (t) => {
  const app = buildServer();
  const orgId = `live-public-${Date.now()}`;
  try {
    await app.ready();
    if (!(await dbReady(t))) return;

    const marker = `live-public-${Date.now()}`;
    const org = await prisma.org.create({ data: { id: orgId, name: marker } });
    const customer = await prisma.customer.create({ data: { orgId: org.id, name: marker } });
    const order = await prisma.order.create({
      data: { customerId: customer.id, origin: `${marker}-src`, destination: `${marker}-dst`, status: 'BOOKED', cargo: `${marker} cargo` },
    });
    const liveTrip = await prisma.trip.create({
      data: { orgId: org.id, orderId: order.id, status: 'IN_TRANSIT', tracking: true },
    });
    const doneTrip = await prisma.trip.create({
      data: { orgId: org.id, orderId: order.id, status: 'DELIVERED', tracking: false },
    });

    const liveToken = signTrackLink({ tripId: liveTrip.id, authSecret: env.AUTH_SECRET });
    const liveRes = await app.inject({ method: 'GET', url: `/api/track/${liveToken.token}` });
    assert.equal(liveRes.statusCode, 200, liveRes.body);
    const payload = liveRes.json().tracking;
    assert.equal(payload.tracking, true);
    assert.equal(payload.status, 'IN_TRANSIT');
    assert.equal(payload.route.cargo, `${marker} cargo`);
    // The PII boundary: no driver, customer, truck plate or rate anywhere.
    const raw = JSON.stringify(payload);
    for (const forbidden of ['driver', 'Driver', 'customer', 'rateEur', 'plate']) {
      assert.ok(!raw.includes(forbidden), `the public payload must not carry ${forbidden}`);
    }

    const doneToken = signTrackLink({ tripId: doneTrip.id, authSecret: env.AUTH_SECRET });
    const doneRes = await app.inject({ method: 'GET', url: `/api/track/${doneToken.token}` });
    assert.equal(doneRes.statusCode, 200, doneRes.body);
    assert.equal(doneRes.json().tracking.tracking, false, 'a delivered trip is not live');
  } finally {
    await cleanup(orgId);
    await app.close();
  }
});

test('the live stream is org-scoped: a foreign owner and a customer are refused (#107)', async (t) => {
  const app = buildServer();
  const orgA = `live-a-${Date.now()}`;
  const orgB = `live-b-${Date.now()}`;
  try {
    await app.ready();
    if (!(await dbReady(t))) return;

    const marker = `live-scope-${Date.now()}`;
    const a = await prisma.org.create({ data: { id: orgA, name: `${marker} A` } });
    const b = await prisma.org.create({ data: { id: orgB, name: `${marker} B` } });
    const customerA = await prisma.customer.create({ data: { orgId: a.id, name: `${marker} A` } });
    const order = await prisma.order.create({ data: { customerId: customerA.id, origin: marker, destination: marker, status: 'BOOKED' } });
    await prisma.user.create({ data: { orgId: a.id, roleId: 'owner', name: `${marker} OwnerA` } });
    const ownerB = await prisma.user.create({ data: { orgId: b.id, roleId: 'owner', name: `${marker} OwnerB` } });
    const customerUser = await prisma.user.create({ data: { orgId: null, roleId: 'customer', name: `${marker} Cust` } });
    await prisma.customerAccount.create({ data: { userId: customerUser.id, customerId: customerA.id } });
    const trip = await prisma.trip.create({
      data: { orgId: a.id, orderId: order.id, status: 'EN_ROUTE', tracking: true },
    });

    const asOwnerB = tokenFor(b.id, ownerB.id, 'owner', `${marker} OwnerB`);
    const asCustomer = tokenFor(null, customerUser.id, 'customer', `${marker} Cust`);
    const url = `/api/trips/${encodeURIComponent(trip.id)}/stream`;

    // A customer has no org: the trip stream is not a customer surface at all.
    const customerStream = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${asCustomer}` } });
    assert.equal(customerStream.statusCode, 403, customerStream.body);

    // A different org's owner reads the trip as not found.
    const foreignStream = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${asOwnerB}` } });
    assert.equal(foreignStream.statusCode, 404, foreignStream.body);
    assert.equal(foreignStream.json().error, 'not_found');

    // The successful, hijacked SSE socket itself (and the point it receives) is
    // covered over a real socket in `gps-ingest.test.ts` (#106); `app.inject()`
    // buffers a response and cannot hold a stream open.
    assert.notEqual(trip.id, '');
  } finally {
    await cleanup(orgA);
    await cleanup(orgB);
    await app.close();
  }
});

test('the fleet trip-detail payload carries the live tracking flag (#107 review)', async (t) => {
  const app = buildServer();
  const orgId = `live-detail-${Date.now()}`;
  try {
    await app.ready();
    if (!(await dbReady(t))) return;

    const marker = `live-detail-${Date.now()}`;
    // Self-contained: the fleet owner role (deploy/seed creates it elsewhere).
    await prisma.role.upsert({
      where: { id: 'owner' },
      update: {},
      create: { id: 'owner', permissions: ['trip:*'] },
    });
    const org = await prisma.org.create({ data: { id: orgId, name: marker } });
    const owner = await prisma.user.create({
      data: { orgId: org.id, roleId: 'owner', name: `${marker} Owner`, email: `${marker}@example.test` },
    });
    const customer = await prisma.customer.create({ data: { orgId: org.id, name: marker } });
    const liveOrder = await prisma.order.create({
      data: { customerId: customer.id, origin: `${marker}-src`, destination: `${marker}-dst`, status: 'BOOKED', cargo: `${marker} cargo` },
    });
    const liveTrip = await prisma.trip.create({
      data: { orgId: org.id, orderId: liveOrder.id, status: 'EN_ROUTE', tracking: true },
    });
    const doneOrder = await prisma.order.create({
      data: { customerId: customer.id, origin: `${marker}-2src`, destination: `${marker}-2dst`, status: 'DELIVERED' },
    });
    const doneTrip = await prisma.trip.create({
      data: { orgId: org.id, orderId: doneOrder.id, status: 'DELIVERED', tracking: false },
    });

    const ownerToken = tokenFor(org.id, owner.id, 'owner', `${marker} Owner`);

    // Board task #107 review: the fleet panel reads `trip.tracking` from THIS
    // payload; without it the panel always said "not started" and never opened
    // the stream.
    const live = await app.inject({
      method: 'GET',
      url: `/api/trips/${encodeURIComponent(liveTrip.id)}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(live.statusCode, 200, live.body);
    assert.equal(live.json().trip.tracking, true, 'a live trip must report tracking=true to the fleet panel');

    const done = await app.inject({
      method: 'GET',
      url: `/api/trips/${encodeURIComponent(doneTrip.id)}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(done.statusCode, 200, done.body);
    assert.equal(done.json().trip.tracking, false, 'a delivered trip is not live');
  } finally {
    await cleanup(orgId);
    await app.close();
  }
});
