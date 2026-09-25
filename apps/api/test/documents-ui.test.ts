/**
 * Documents UI acceptance (board task #37, FAv1-F6) — the HTTP-level evidence
 * the issue asks for, driven through the real `buildServer()` with
 * `app.inject()` and a real signed token against the pilot database:
 *
 *   1. the POD gate is intact end to end: `POST /api/trips/:id/status`
 *      `POD_UPLOADED` is **400 `pod_required`** before a POD exists and **200**
 *      after one is uploaded through the real `POST /api/trips/:id/documents`;
 *   2. a driver cannot verify their own document — `PATCH /api/documents/:id`
 *      is **403** for a `driver` token and **200** for the owner;
 *   3. an unsupported MIME is rejected with a readable `unsupported_type`
 *      message, and the upload response never carries the internal storage key.
 *
 * The fixture lives in its **own org** (`qa-docs-org`), never the seeded pilot
 * org, so the rows it writes cannot race the concurrent DB-backed suites; it is
 * removed (rows and uploaded bytes) in the `after` hook. The test early-returns
 * when no database is reachable, so it still runs on a bare checkout.
 *
 * Runs the real API dependencies (`fastify`, `tsx`) and the database:
 *
 *   pnpm --filter @roadwisefleet/api test:router
 *
 * Kept out of `src/` so the no-install CI job never imports `fastify` /
 * `@prisma/client`; the dependency-free half is `../src/documents-ui.test.js`.
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signToken } from '../src/auth/tokens.js';

// Must be set before `env.ts` is imported: it throws when AUTH_SECRET is
// missing, and uploads must land in a throwaway directory, not the repo.
process.env.ALLOW_INSECURE_AUTH_SECRET = '1';
const UPLOAD_DIR = join(tmpdir(), 'eila-docs-ui-uploads');
process.env.UPLOAD_DIR = UPLOAD_DIR;

const { buildServer } = await import('../src/app.js');
const { env } = await import('../src/env.js');
const { prisma } = await import('../src/db.js');

/** A dedicated, isolated tenant so this test cannot race the pilot-org suites. */
const ORG_ID = 'qa-docs-org';
const OWNER = 'qa-docs-owner';
const DRIVER = 'qa-docs-driver';
const CUSTOMER_ID = 'qa-docs-customer';
const ORDER_ID = 'qa-docs-order';
const TRIP_ID = 'qa-docs-trip';
const USER_IDS = [OWNER, DRIVER];

/** 1x1 transparent PNG — the smallest real image the MIME allow-list accepts. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let dbReachable = false;
let app: any;

function token(sub: string, role: string, name: string): string {
  return signToken({ sub, org: ORG_ID, role, name }, env.AUTH_SECRET);
}

const ownerToken = () => token(OWNER, 'owner', 'QA Docs Owner');
const driverToken = () => token(DRIVER, 'driver', 'QA Docs Driver');

async function removeFixture(): Promise<void> {
  try {
    const where = { tripId: TRIP_ID };
    await prisma.$transaction([
      prisma.statusEvent.deleteMany({ where }),
      prisma.gpsPing.deleteMany({ where }),
      prisma.expense.deleteMany({ where }),
      prisma.document.deleteMany({ where }),
      prisma.settlement.deleteMany({ where }),
      prisma.tripStop.deleteMany({ where }),
      prisma.tripDriver.deleteMany({ where }),
      prisma.trip.deleteMany({ where: { id: TRIP_ID } }),
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
    await prisma.org.findFirst({ where: { id: 'pilot-org' } });
    await removeFixture();

    await prisma.org.create({ data: { id: ORG_ID, name: 'QA Docs Org', locale: 'en', dataRegion: 'eu', plan: 'free' } });
    await prisma.user.create({
      data: { id: OWNER, orgId: ORG_ID, roleId: 'owner', name: 'QA Docs Owner', email: 'qa-docs-owner@roadwisefleet.test', lang: 'en' },
    });
    await prisma.user.create({
      data: { id: DRIVER, orgId: ORG_ID, roleId: 'driver', name: 'QA Docs Driver', email: 'qa-docs-driver@roadwisefleet.test', lang: 'en' },
    });
    await prisma.customer.create({ data: { id: CUSTOMER_ID, orgId: ORG_ID, name: 'QA Docs Customer' } });
    await prisma.order.create({ data: { id: ORDER_ID, customerId: CUSTOMER_ID, origin: 'QA', destination: 'Docs' } });
    await prisma.trip.create({ data: { id: TRIP_ID, orgId: ORG_ID, orderId: ORDER_ID, driverId: DRIVER, status: 'DELIVERED' } });

    app = buildServer();
    await app.ready();
    dbReachable = true;
  } catch (err) {
    console.error('fixture setup failed — DB assertions will be skipped:', (err as Error).message);
  }
});

after(async () => {
  await removeFixture();
  await rm(UPLOAD_DIR, { recursive: true, force: true });
  if (app) await app.close();
  await prisma.$disconnect();
});

function post(bearer: string, url: string, body: unknown) {
  return app.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
}

function patch(bearer: string, url: string, body: unknown) {
  return app.inject({
    method: 'PATCH',
    url,
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
}

function get(bearer: string, url: string) {
  return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${bearer}` } });
}

async function uploadPod(bearer: string) {
  return post(bearer, `/api/trips/${TRIP_ID}/documents`, {
    docType: 'pod',
    filename: 'pod.png',
    mimeType: 'image/png',
    dataBase64: PNG_BASE64,
    capturedAt: '2026-09-25T10:00:00.000Z',
    geo: { lat: 52.52, lng: 13.405, accuracy: 12 },
  });
}

test('the POD gate is 400 before the upload and 200 after (board #37)', async (t) => {
  if (!dbReachable) return t.diagnostic('database not reachable here — assertions skipped');

  const before = await post(ownerToken(), `/api/trips/${TRIP_ID}/status`, { status: 'POD_UPLOADED' });
  assert.equal(before.statusCode, 400, 'no POD yet: the gate refuses');
  assert.equal(before.json().error, 'pod_required');

  const upload = await uploadPod(ownerToken());
  assert.equal(upload.statusCode, 201, 'the owner may upload a POD');
  const document = upload.json().document as Record<string, unknown>;
  assert.equal(document.docType, 'pod');
  assert.equal(document.status, 'UPLOADED');
  assert.equal('storageKey' in document, false, 'the storage key must never reach the client');
  assert.equal('storageKey' in JSON.parse(upload.payload), false);

  const afterRes = await post(ownerToken(), `/api/trips/${TRIP_ID}/status`, { status: 'POD_UPLOADED' });
  assert.equal(afterRes.statusCode, 200, 'the gate opens once a POD is present');
  assert.equal(afterRes.json().trip.status, 'POD_UPLOADED');
});

test('a driver cannot verify a document; the owner can (board #37)', async (t) => {
  if (!dbReachable) return t.diagnostic('database not reachable here — assertions skipped');

  const docs = await get(ownerToken(), `/api/trips/${TRIP_ID}/documents`);
  assert.equal(docs.statusCode, 200);
  const document = (docs.json().documents as Array<{ id: string }>)[0];
  assert.ok(document && document.id, 'the uploaded POD is listed');

  const denied = await patch(driverToken(), `/api/documents/${document.id}`, { status: 'VERIFIED' });
  assert.equal(denied.statusCode, 403, 'a driver must never verify their own document');
  assert.equal(denied.json().error, 'forbidden');

  const allowed = await patch(ownerToken(), `/api/documents/${document.id}`, { status: 'VERIFIED' });
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.json().document.status, 'VERIFIED');
  assert.equal('storageKey' in allowed.json().document, false);
});

test('an unsupported MIME is rejected with a readable message (board #37)', async (t) => {
  if (!dbReachable) return t.diagnostic('database not reachable here — assertions skipped');

  const res = await post(ownerToken(), `/api/trips/${TRIP_ID}/documents`, {
    docType: 'pod',
    filename: 'pod.gif',
    mimeType: 'image/gif',
    dataBase64: PNG_BASE64,
  });
  assert.equal(res.statusCode, 400);
  const body = res.json();
  assert.equal(body.error, 'unsupported_type');
  assert.match(String(body.detail), /mimeType must be one of/);
  assert.match(String(body.detail), /image\/jpeg/);
});
