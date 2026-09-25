/**
 * Tracking-link UI acceptance (board task #39, FAv1-F8) — the HTTP-level
 * evidence the issue asks for, driven through the real `buildServer()` with
 * `app.inject()` and a real signed token against the pilot database:
 *
 *   1. `POST /api/trips/:id/track-link` mints a link (201) and
 *      `GET /api/trips/:id/track-link` returns the **identical** URL — the token
 *      is recomputed from the persisted mint parameters, so the trip detail can
 *      show it after a reload without the server storing the token;
 *   2. an anonymous visitor can open the minted link (200 HTML + 200 JSON,
 *      `noindex`), and a tampered token 404s;
 *   3. `DELETE /api/trips/:id/track-link` revokes it: the previously working
 *      link now 404s, the GET says `link: null`, and a fresh mint works again —
 *      while another trip's link is untouched;
 *   4. the token is never exposed on the authenticated surfaces that are not the
 *      acting trip: the trips list carries only `{ active, expiresAt }`, and the
 *      raw token string appears nowhere in it.
 *
 * The fixture lives in its **own org** (`qa-track-org`), never the seeded pilot
 * org, so the rows it writes cannot race the concurrent DB-backed suites; it is
 * removed in the `after` hook. The test early-returns when no database is
 * reachable, so it still runs on a bare checkout.
 *
 * Runs the real API dependencies (`fastify`, `tsx`) and the database:
 *
 *   pnpm --filter @roadwisefleet/api test:router
 *
 * Kept out of `src/` so the no-install CI job never imports `fastify` /
 * `@prisma/client`; the dependency-free half is `../src/tracking-ui.test.js`.
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
const ORG_ID = 'qa-track-org';
const OWNER = 'qa-track-owner';
const DRIVER = 'qa-track-driver';
const CUSTOMER_ID = 'qa-track-customer';
const ORDER_ID = 'qa-track-order';
const TRIP_ID = 'qa-track-trip';
const OTHER_ORDER_ID = 'qa-track-order-2';
const OTHER_TRIP_ID = 'qa-track-trip-2';
const USER_IDS = [OWNER, DRIVER];

let dbReachable = false;
let app: any;

function token(sub: string, role: string, name: string): string {
  return signToken({ sub, org: ORG_ID, role, name }, env.AUTH_SECRET);
}

const ownerToken = () => token(OWNER, 'owner', 'QA Track Owner');
const driverToken = () => token(DRIVER, 'driver', 'QA Track Driver');

async function removeFixture(): Promise<void> {
  try {
    const where = { tripId: { in: [TRIP_ID, OTHER_TRIP_ID] } };
    await prisma.$transaction([
      prisma.statusEvent.deleteMany({ where }),
      prisma.gpsPing.deleteMany({ where }),
      prisma.expense.deleteMany({ where }),
      prisma.document.deleteMany({ where }),
      prisma.settlement.deleteMany({ where }),
      prisma.tripStop.deleteMany({ where }),
      prisma.tripDriver.deleteMany({ where }),
      prisma.trip.deleteMany({ where: { id: { in: [TRIP_ID, OTHER_TRIP_ID] } } }),
      prisma.order.deleteMany({ where: { id: { in: [ORDER_ID, OTHER_ORDER_ID] } } }),
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
    await prisma.org.findFirst({ where: { id: 'pilot-org' } });
    await removeFixture();

    await prisma.org.create({
      data: { id: ORG_ID, name: 'QA Track Org', locale: 'en', dataRegion: 'eu', plan: 'free' },
    });
    await prisma.user.create({
      data: { id: OWNER, orgId: ORG_ID, roleId: 'owner', name: 'QA Track Owner', email: 'qa-track-owner@roadwisefleet.test', lang: 'en' },
    });
    await prisma.user.create({
      data: { id: DRIVER, orgId: ORG_ID, roleId: 'driver', name: 'QA Track Driver', email: 'qa-track-driver@roadwisefleet.test', lang: 'en' },
    });
    await prisma.customer.create({ data: { id: CUSTOMER_ID, orgId: ORG_ID, name: 'QA Track Customer' } });
    await prisma.order.create({
      data: { id: ORDER_ID, customerId: CUSTOMER_ID, origin: 'Hamburg', destination: 'Łódź', cargo: 'Machine parts' },
    });
    await prisma.order.create({
      data: { id: OTHER_ORDER_ID, customerId: CUSTOMER_ID, origin: 'Berlin', destination: 'Prague' },
    });
    await prisma.trip.create({ data: { id: TRIP_ID, orgId: ORG_ID, orderId: ORDER_ID, driverId: DRIVER, status: 'IN_TRANSIT' } });
    await prisma.trip.create({ data: { id: OTHER_TRIP_ID, orgId: ORG_ID, orderId: OTHER_ORDER_ID, status: 'DRAFT' } });

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

function post(bearer: string, url: string) {
  return app.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    payload: JSON.stringify({}),
  });
}

function del(bearer: string, url: string) {
  return app.inject({ method: 'DELETE', url, headers: { authorization: `Bearer ${bearer}` } });
}

function anon(url: string) {
  return app.inject({ method: 'GET', url });
}

/** The path out of a mint response body. */
function linkPath(body: any): string {
  const url = body?.link?.url;
  assert.equal(typeof url, 'string');
  return url as string;
}

/** Tamper a token payload so the signature no longer matches. */
function tamper(path: string): string {
  const prefix = path.slice(0, path.lastIndexOf('/') + 1);
  const token = path.slice(path.lastIndexOf('/') + 1);
  const [header, payload, signature] = token.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  claims.sub = `${claims.sub}-forged`;
  const forgedPayload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${prefix}${header}.${forgedPayload}.${signature}`;
}

/** The validity check: `/track/:token` is always the static shell; the JSON is
 * what actually verifies the token. */
function trackJson(path: string): string {
  return path.replace('/track/', '/api/track/');
}

test('mint creates a link, GET returns the identical URL, and the list never carries the token (board #39)', async (t) => {
  if (!dbReachable) return t.diagnostic('database not reachable here — assertions skipped');

  const minted = await post(ownerToken(), `/api/trips/${TRIP_ID}/track-link`);
  assert.equal(minted.statusCode, 201, 'the owner may mint a tracking link');
  const mintedPath = linkPath(minted.json());
  assert.match(mintedPath, /^\/track\//);
  const mintedToken = mintedPath.slice('/track/'.length);
  assert.ok(mintedToken.length > 100, 'a real token (the 414 regression guard)');

  // The trip detail can re-read the SAME link: HMAC over the persisted mint
  // parameters is deterministic, so nothing was lost by not storing the token.
  const fetched = await get(ownerToken(), `/api/trips/${TRIP_ID}/track-link`);
  assert.equal(fetched.statusCode, 200);
  assert.equal(linkPath(fetched.json()), mintedPath);

  // The list carries only the state — never the token.
  const list = await get(ownerToken(), '/api/trips');
  assert.equal(list.statusCode, 200);
  const row = (list.json().trips as any[]).find((r) => r.id === TRIP_ID);
  assert.ok(row, 'the trip is in the list');
  assert.equal(row.tracking.active, true);
  assert.equal(typeof row.tracking.expiresAt, 'string');
  assert.deepEqual(Object.keys(row.tracking).sort(), ['active', 'expiresAt'], 'only state, never the token');
  assert.equal('trackLinkVersion' in row, false, 'internal columns stay server-side');
  assert.equal(list.payload.includes(mintedToken), false, 'the token must not appear on the list surface');
});

test('an anonymous visitor opens the minted link; a tampered token 404s (board #39)', async (t) => {
  if (!dbReachable) return t.diagnostic('database not reachable here — assertions skipped');

  const minted = await post(ownerToken(), `/api/trips/${TRIP_ID}/track-link`);
  const path = linkPath(minted.json());

  const page = await anon(path);
  assert.equal(page.statusCode, 200);
  assert.match(String(page.headers['content-type']), /text\/html/);
  assert.equal(page.headers['x-robots-tag'], 'noindex, nofollow');

  const json = await anon(trackJson(path));
  assert.equal(json.statusCode, 200);
  const payload = json.json();
  assert.equal(payload.tracking.status, 'IN_TRANSIT');
  assert.deepEqual(payload.tracking.route.origin, 'Hamburg');
  assert.equal(JSON.stringify(payload).includes('QA Track Driver'), false, 'no PII on the public surface');

  const forged = await anon(trackJson(tamper(path)));
  assert.equal(forged.statusCode, 404, 'a tampered token is a flat 404');
  assert.equal(forged.json().error, 'invalid_token');
});

test('revoke stops the link; a re-mint works and another trip is untouched (board #39)', async (t) => {
  if (!dbReachable) return t.diagnostic('database not reachable here — assertions skipped');

  const minted = await post(ownerToken(), `/api/trips/${TRIP_ID}/track-link`);
  const revokedPath = linkPath(minted.json());
  const other = await post(ownerToken(), `/api/trips/${OTHER_TRIP_ID}/track-link`);
  const otherPath = linkPath(other.json());
  assert.equal((await anon(trackJson(revokedPath))).statusCode, 200, 'pre-condition: the link works');

  const revoked = await del(ownerToken(), `/api/trips/${TRIP_ID}/track-link`);
  assert.equal(revoked.statusCode, 200);
  assert.equal(revoked.json().revoked, true);

  // The acceptance: revocation stops the link working.
  assert.equal((await anon(trackJson(revokedPath))).statusCode, 404, 'the revoked link no longer resolves');
  const after = await get(ownerToken(), `/api/trips/${TRIP_ID}/track-link`);
  assert.equal(after.statusCode, 200);
  assert.equal(after.json().link, null);
  assert.equal((await anon(trackJson(otherPath))).statusCode, 200, 'per-trip revoke never touches another trip');

  // ...and a fresh mint on the revoked trip works again under the new version.
  const reminted = await post(ownerToken(), `/api/trips/${TRIP_ID}/track-link`);
  assert.equal(reminted.statusCode, 201);
  const freshPath = linkPath(reminted.json());
  assert.notEqual(freshPath, revokedPath, 'the new token is a new version');
  assert.equal((await anon(trackJson(freshPath))).statusCode, 200);
  assert.equal((await anon(trackJson(revokedPath))).statusCode, 404, 'the old token stays dead after a re-mint');
});

test('a driver (no trip:*) cannot mint, read or revoke a link (board #39)', async (t) => {
  if (!dbReachable) return t.diagnostic('database not reachable here — assertions skipped');

  const url = `/api/trips/${TRIP_ID}/track-link`;
  assert.equal((await post(driverToken(), url)).statusCode, 403);
  assert.equal((await get(driverToken(), url)).statusCode, 403);
  assert.equal((await del(driverToken(), url)).statusCode, 403);
});
