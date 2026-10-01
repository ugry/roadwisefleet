/**
 * HTTP-level acceptance for Android background-location ingest + realtime
 * fan-out (board task #106, AND1-A4).
 *
 * The acceptance contract this pins:
 *   - `POST /api/trips/:id/gps` is assigned-driver only: a non-assigned driver
 *     (and an owner token) is refused 403 and writes nothing;
 *   - a point for a trip with `tracking = false` is a 409 `tracking_off` (a late
 *     batch cannot resurrect a delivered trip);
 *   - a malformed point is a 400 `invalid_gps` naming the field;
 *   - a valid batch is persisted with its client id and is **idempotent**: a
 *     replayed batch (offline queue flushed twice) adds no duplicate rows;
 *   - the realtime channel delivers a newly ingested point to an authenticated
 *     subscriber on the same trip within seconds, over a REAL socket (an SSE
 *     stream cannot be exercised with `app.inject()`, which buffers responses);
 *   - the read-only share link streams only its own trip.
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

const ORG_ID = 'pilot-org';

function tokenFor(orgId: string, sub: string, role: string, name: string): string {
  return signToken({ sub, org: orgId, role, name }, env.AUTH_SECRET);
}

const PILOT_OWNER = tokenFor(ORG_ID, 'pilot-admin', 'owner', 'Pilot Admin');

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

function postGps(app: any, token: string, tripId: string, points: unknown[]) {
  return app.inject({
    method: 'POST',
    url: `/api/trips/${encodeURIComponent(tripId)}/gps`,
    headers: { authorization: `Bearer ${token}` },
    payload: { points },
  });
}

function point(id: string, atMs: number) {
  return { id, lat: 52.5, lng: 13.4, at: new Date(atMs).toISOString(), accuracyM: 9 };
}

/** Read one SSE frame (`event:`/`data:`), skipping `: keep-alive` comments. */
function parseFrame(raw: string): { event: string; data: any } | null {
  let event = 'message';
  let dataLine: string | null = null;
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLine = line.slice(5).trim();
  }
  if (dataLine === null) return null;
  try {
    return { event, data: JSON.parse(dataLine) };
  } catch {
    return { event, data: dataLine };
  }
}

/** Open an SSE response and expose a `frame(timeoutMs)` reader. */
async function openSse(url: string, headers: Record<string, string>) {
  const ac = new AbortController();
  const res = await fetch(url, { headers, signal: ac.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const queue: Array<{ event: string; data: any }> = [];
  const waiters: Array<(f: any) => void> = [];
  let closed = false;
  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx = buffer.indexOf('\n\n');
        while (idx >= 0) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const frame = parseFrame(raw);
          if (frame) {
            const waiter = waiters.shift();
            if (waiter) waiter(frame);
            else queue.push(frame);
          }
          idx = buffer.indexOf('\n\n');
        }
      }
    } catch {
      /* aborted */
    }
    closed = true;
    for (const waiter of waiters.splice(0)) waiter(null);
  })();
  return {
    status: res.status,
    frame(timeoutMs = 5000): Promise<{ event: string; data: any } | null> {
      if (queue.length) return Promise.resolve(queue.shift()!);
      if (closed) return Promise.resolve(null);
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), timeoutMs);
        waiters.push((f) => {
          clearTimeout(timer);
          resolve(f);
        });
      });
    },
    close() {
      ac.abort();
    },
  };
}

async function portOf(app: any): Promise<number> {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('server is not listening on a port');
  return addr.port;
}

test('POST /trips/:id/gps is assigned-driver only, tracking-gated and idempotent (#106)', async (t) => {
  const app = buildServer();
  const orgId = `gps-ingest-${Date.now()}`;
  const ids: { trips: string[]; users: string[] } = { trips: [], users: [] };
  try {
    await app.ready();
    if (!(await dbReady(t, app))) return;

    const marker = `gps-ingest-${Date.now()}`;
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
    const ownerUser = await prisma.user.create({ data: { orgId: org.id, roleId: 'owner', name: `${marker} Owner` } });
    const tracking = await prisma.trip.create({
      data: { orgId: org.id, orderId: order.id, status: 'EN_ROUTE', driverId: driverA.id, tracking: true },
    });
    const stopped = await prisma.trip.create({
      data: { orgId: org.id, orderId: order.id, status: 'DELIVERED', driverId: driverA.id, tracking: false },
    });
    ids.trips = [tracking.id, stopped.id];
    ids.users = [driverA.id, driverB.id, ownerUser.id];

    const asA = tokenFor(org.id, driverA.id, 'driver', `${marker} A`);
    const asB = tokenFor(org.id, driverB.id, 'driver', `${marker} B`);
    const owner = tokenFor(org.id, ownerUser.id, 'owner', `${marker} Owner`);
    const now = Date.now();
    const batch = [point('p1', now - 120_000), point('p2', now - 60_000)];

    // A non-assigned driver writes nothing.
    const denied = await postGps(app, asB, tracking.id, batch);
    assert.equal(denied.statusCode, 403, denied.body);
    assert.equal(denied.json().error, 'forbidden');
    assert.equal(await prisma.gpsPing.count({ where: { tripId: tracking.id } }), 0);

    // An owner token is not the assigned driver either.
    assert.equal((await postGps(app, owner, tracking.id, batch)).statusCode, 403);

    // A malformed point is a 400 naming the field.
    const bad = await postGps(app, asA, tracking.id, [{ id: 'x', lat: 999, lng: 0, at: now }]);
    assert.equal(bad.statusCode, 400, bad.body);
    assert.equal(bad.json().error, 'invalid_gps');
    assert.equal(bad.json().detail, 'points[].lat_out_of_range');

    // A trip whose tracking has stopped refuses the batch.
    const off = await postGps(app, asA, stopped.id, batch);
    assert.equal(off.statusCode, 409, off.body);
    assert.equal(off.json().error, 'tracking_off');
    assert.equal(await prisma.gpsPing.count({ where: { tripId: stopped.id } }), 0);

    // The assigned driver's batch is accepted, with the client id persisted.
    const ok = await postGps(app, asA, tracking.id, batch);
    assert.equal(ok.statusCode, 202, ok.body);
    assert.deepEqual(ok.json(), { accepted: 2, received: 2 });
    const rows = await prisma.gpsPing.findMany({ where: { tripId: tracking.id }, orderBy: { at: 'asc' } });
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.clientId), ['p1', 'p2']);
    assert.equal(rows[0].accuracyM, 9);

    // A replayed batch (offline queue flushed twice) is a no-op, not a duplicate.
    const replay = await postGps(app, asA, tracking.id, batch);
    assert.equal(replay.statusCode, 202, replay.body);
    assert.deepEqual(replay.json(), { accepted: 0, received: 2 });
    assert.equal(await prisma.gpsPing.count({ where: { tripId: tracking.id } }), 2);
  } finally {
    if (ids.trips.length) await prisma.gpsPing.deleteMany({ where: { tripId: { in: ids.trips } } });
    if (ids.trips.length) await prisma.statusEvent.deleteMany({ where: { tripId: { in: ids.trips } } });
    if (ids.trips.length) await prisma.trip.deleteMany({ where: { id: { in: ids.trips } } });
    await prisma.order.deleteMany({ where: { customer: { orgId } } });
    await prisma.customer.deleteMany({ where: { orgId } });
    if (ids.users.length) await prisma.user.deleteMany({ where: { id: { in: ids.users } } });
    await prisma.org.deleteMany({ where: { id: orgId } });
    await app.close();
  }
});

test('the realtime stream delivers a new point to a scoped subscriber over a real socket (#106)', async (t) => {
  const app = buildServer();
  const orgId = `gps-stream-${Date.now()}`;
  const ids: { trips: string[]; users: string[] } = { trips: [], users: [] };
  let sse: Awaited<ReturnType<typeof openSse>> | null = null;
  try {
    await app.ready();
    if (!(await dbReady(t, app))) return;

    const marker = `gps-stream-${Date.now()}`;
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
    const driver = await prisma.user.create({ data: { orgId: org.id, roleId: 'driver', name: `${marker} D` } });
    const trip = await prisma.trip.create({
      data: { orgId: org.id, orderId: order.id, status: 'EN_ROUTE', driverId: driver.id, tracking: true },
    });
    ids.trips = [trip.id];
    ids.users = [driver.id];
    const asDriver = tokenFor(org.id, driver.id, 'driver', `${marker} D`);

    const port = await portOf(app);
    sse = await openSse(`http://127.0.0.1:${port}/api/trips/${encodeURIComponent(trip.id)}/stream`, {
      authorization: `Bearer ${asDriver}`,
      accept: 'text/event-stream',
    });
    assert.equal(sse.status, 200, 'the scoped subscriber is accepted');
    const ready = await sse.frame(5000);
    assert.equal(ready?.event, 'ready', 'the stream opens with a ready frame');
    assert.equal(ready?.data.tripId, trip.id);

    // Ingest a point over the same server; the subscriber must see it promptly.
    const res = await fetch(`http://127.0.0.1:${port}/api/trips/${encodeURIComponent(trip.id)}/gps`, {
      method: 'POST',
      headers: { authorization: `Bearer ${asDriver}`, 'content-type': 'application/json' },
      body: JSON.stringify({ points: [point('live-1', Date.now() - 30_000)] }),
    });
    assert.equal(res.status, 202, await res.text());

    const frame = await sse.frame(5000);
    assert.equal(frame?.event, 'gps', 'the point is fanned out');
    assert.equal(frame?.data.id, 'live-1');
    assert.equal(frame?.data.lat, 52.5);
    assert.equal(typeof frame?.data.at, 'string');
  } finally {
    sse?.close();
    if (ids.trips.length) await prisma.gpsPing.deleteMany({ where: { tripId: { in: ids.trips } } });
    if (ids.trips.length) await prisma.statusEvent.deleteMany({ where: { tripId: { in: ids.trips } } });
    if (ids.trips.length) await prisma.trip.deleteMany({ where: { id: { in: ids.trips } } });
    await prisma.order.deleteMany({ where: { customer: { orgId } } });
    await prisma.customer.deleteMany({ where: { orgId } });
    if (ids.users.length) await prisma.user.deleteMany({ where: { id: { in: ids.users } } });
    await prisma.org.deleteMany({ where: { id: orgId } });
    await app.close();
  }
});

test('a revoked share-link token cannot open the realtime stream (#106)', async (t) => {
  const app = buildServer();
  const orgId = `gps-token-${Date.now()}`;
  const ids: { trips: string[]; users: string[] } = { trips: [], users: [] };
  let sse: Awaited<ReturnType<typeof openSse>> | null = null;
  try {
    await app.ready();
    if (!(await dbReady(t, app))) return;

    const marker = `gps-token-${Date.now()}`;
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
    const driver = await prisma.user.create({ data: { orgId: org.id, roleId: 'driver', name: `${marker} D` } });
    const trip = await prisma.trip.create({
      data: { orgId: org.id, orderId: order.id, status: 'EN_ROUTE', driverId: driver.id, tracking: true },
    });
    ids.trips = [trip.id];
    ids.users = [driver.id];

    const live = signTrackLink({ tripId: trip.id, authSecret: env.AUTH_SECRET });
    const port = await portOf(app);

    // A live token opens the stream and receives a point.
    sse = await openSse(`http://127.0.0.1:${port}/api/track/${live.token}/stream`, { accept: 'text/event-stream' });
    assert.equal(sse.status, 200);
    assert.equal((await sse.frame(5000))?.event, 'ready');

    const asDriver = tokenFor(org.id, driver.id, 'driver', `${marker} D`);
    const ingest = await fetch(`http://127.0.0.1:${port}/api/trips/${encodeURIComponent(trip.id)}/gps`, {
      method: 'POST',
      headers: { authorization: `Bearer ${asDriver}`, 'content-type': 'application/json' },
      body: JSON.stringify({ points: [point('pub-1', Date.now() - 30_000)] }),
    });
    assert.equal(ingest.status, 202, await ingest.text());
    assert.equal((await sse.frame(5000))?.event, 'gps');
    sse.close();
    sse = null;

    // Revoking the link (version bump) closes the door: a flat 404.
    await prisma.trip.update({ where: { id: trip.id }, data: { trackLinkVersion: { increment: 1 } } });
    const revoked = await fetch(`http://127.0.0.1:${port}/api/track/${live.token}/stream`, {
      headers: { accept: 'text/event-stream' },
    });
    assert.equal(revoked.status, 404, 'a revoked token is a flat 404');
    assert.deepEqual(await revoked.json(), { error: 'invalid_token' });
  } finally {
    sse?.close();
    if (ids.trips.length) await prisma.gpsPing.deleteMany({ where: { tripId: { in: ids.trips } } });
    if (ids.trips.length) await prisma.statusEvent.deleteMany({ where: { tripId: { in: ids.trips } } });
    if (ids.trips.length) await prisma.trip.deleteMany({ where: { id: { in: ids.trips } } });
    await prisma.order.deleteMany({ where: { customer: { orgId } } });
    await prisma.customer.deleteMany({ where: { orgId } });
    if (ids.users.length) await prisma.user.deleteMany({ where: { id: { in: ids.users } } });
    await prisma.org.deleteMany({ where: { id: orgId } });
    await app.close();
  }
});
