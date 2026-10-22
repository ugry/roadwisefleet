/**
 * Guest document + invoice share views (board task #132, UXF-O1a) — the
 * HTTP-level evidence the issue asks for, driven through the real
 * `buildServer()` with `app.inject()`, a real signed capability and real bytes
 * on disk:
 *
 *   - `POST /api/documents/:id/share-link` mints a `/g/document/…` link for a
 *     POD and a `/g/invoice/…` link for an invoice (201);
 *   - an anonymous visitor downloads the POD with **no cookie and no session**
 *     (`content-disposition: attachment`, the exact stored bytes) and opens the
 *     invoice inline, both `noindex` + `no-store`;
 *   - a bogus/tampered token, a token of the other scope, and an expired token
 *     are all a flat 404 with no data and no `Set-Cookie`;
 *   - a document whose status becomes `REJECTED` (the per-document revoke) and
 *     a shipment link revoke (`trackLinkVersion` bump) both stop the link, and
 *     a re-minted shipment link never revives the old document token;
 *   - a driver without `trip:*`, another org's document, and a document with no
 *     live shipment link are refused at mint time.
 *
 * Runs the real dependencies and the pilot database:
 *
 *   pnpm --filter @roadwisefleet/api test:router
 *
 * Kept out of `src/` so the no-install CI job never imports `fastify` /
 * `@prisma/client`; the dependency-free contract tests are
 * `../src/guest-share.test.js`.
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Must be set before `env.ts` is imported: it throws when AUTH_SECRET is
// missing, and the upload directory is read once at import time.
process.env.ALLOW_INSECURE_AUTH_SECRET = '1';
const UPLOAD_DIR = mkdtempSync(join(tmpdir(), 'rwf-guest-share-'));
process.env.UPLOAD_DIR = UPLOAD_DIR;

const { signToken } = await import('../src/auth/tokens.js');
const { signShareLink } = await import('../src/track-link.js');
const { buildServer } = await import('../src/app.js');
const { env } = await import('../src/env.js');
const { prisma } = await import('../src/db.js');

/** A dedicated, isolated tenant so this test cannot race the pilot-org suites. */
const ORG_ID = 'qa-guest-share-org';
const OTHER_ORG_ID = 'qa-guest-share-other-org';
const OWNER = 'qa-guest-share-owner';
const DRIVER = 'qa-guest-share-driver';
const CUSTOMER_ID = 'qa-guest-share-customer';
const ORDER_ID = 'qa-guest-share-order';
const TRIP_ID = 'qa-guest-share-trip';
const OTHER_TRIP_ID = 'qa-guest-share-trip-2';
const POD_ID = 'qa-guest-share-pod';
const ECMR_ID = 'qa-guest-share-ecmr';
const INVOICE_ID = 'qa-guest-share-invoice';
const REJECTED_ID = 'qa-guest-share-rejected';
const OTHER_ORG_POD_ID = 'qa-guest-share-foreign-pod';
const USER_IDS = [OWNER, DRIVER];

const POD_BYTES = Buffer.from('POD-PHOTO-BYTES-A');
const ECMR_BYTES = Buffer.from('ECMR-PDF-BYTES-B');
const INVOICE_BYTES = Buffer.from('%PDF-1.4 INVOICE-BYTES');

let dbReachable = false;
let app: any;

function token(sub: string, role: string, name: string, org = ORG_ID): string {
  return signToken({ sub, org, role, name }, env.AUTH_SECRET);
}

const ownerToken = () => token(OWNER, 'owner', 'QA Guest Share Owner');
const driverToken = () => token(DRIVER, 'driver', 'QA Guest Share Driver');

/** Write real bytes at the storage key the route resolves against UPLOAD_DIR. */
function storeFile(storageKey: string, bytes: Buffer): void {
  const full = join(UPLOAD_DIR, storageKey);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, bytes);
}

async function removeFixture(): Promise<void> {
  try {
    const tripIds = [TRIP_ID, OTHER_TRIP_ID];
    await prisma.$transaction([
      prisma.statusEvent.deleteMany({ where: { tripId: { in: tripIds } } }),
      prisma.gpsPing.deleteMany({ where: { tripId: { in: tripIds } } }),
      prisma.expense.deleteMany({ where: { tripId: { in: tripIds } } }),
      prisma.document.deleteMany({ where: { tripId: { in: tripIds } } }),
      prisma.settlement.deleteMany({ where: { tripId: { in: tripIds } } }),
      prisma.tripStop.deleteMany({ where: { tripId: { in: tripIds } } }),
      prisma.tripDriver.deleteMany({ where: { tripId: { in: tripIds } } }),
      prisma.trip.deleteMany({ where: { id: { in: tripIds } } }),
      prisma.order.deleteMany({ where: { id: ORDER_ID } }),
      prisma.customer.deleteMany({ where: { id: CUSTOMER_ID } }),
      prisma.user.deleteMany({ where: { id: { in: USER_IDS } } }),
      prisma.org.deleteMany({ where: { id: { in: [ORG_ID, OTHER_ORG_ID] } } }),
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
      data: { id: ORG_ID, name: 'QA Guest Share Org', locale: 'en', dataRegion: 'eu', plan: 'free' },
    });
    await prisma.org.create({
      data: { id: OTHER_ORG_ID, name: 'QA Guest Share Other', locale: 'en', dataRegion: 'eu', plan: 'free' },
    });
    await prisma.user.create({
      data: { id: OWNER, orgId: ORG_ID, roleId: 'owner', name: 'QA Guest Share Owner', email: 'qa-guest-share-owner@roadwisefleet.test', lang: 'en' },
    });
    await prisma.user.create({
      data: { id: DRIVER, orgId: ORG_ID, roleId: 'driver', name: 'QA Guest Share Driver', email: 'qa-guest-share-driver@roadwisefleet.test', lang: 'en' },
    });
    await prisma.customer.create({ data: { id: CUSTOMER_ID, orgId: ORG_ID, name: 'QA Guest Share Customer' } });
    await prisma.order.create({
      data: { id: ORDER_ID, customerId: CUSTOMER_ID, origin: 'Hamburg', destination: 'Łódź', cargo: 'Machine parts' },
    });
    await prisma.trip.create({ data: { id: TRIP_ID, orgId: ORG_ID, orderId: ORDER_ID, status: 'IN_TRANSIT' } });
    await prisma.trip.create({ data: { id: OTHER_TRIP_ID, orgId: OTHER_ORG_ID, orderId: ORDER_ID, status: 'DRAFT' } });

    const podKey = `${TRIP_ID}/pod/${POD_ID}-pod.jpg`;
    const ecmrKey = `${TRIP_ID}/ecmr/${ECMR_ID}-ecmr.pdf`;
    const invoiceKey = `${TRIP_ID}/invoice/${INVOICE_ID}-invoice.pdf`;
    const rejectedKey = `${TRIP_ID}/pod/${REJECTED_ID}-pod.jpg`;
    storeFile(podKey, POD_BYTES);
    storeFile(ecmrKey, ECMR_BYTES);
    storeFile(invoiceKey, INVOICE_BYTES);
    storeFile(rejectedKey, Buffer.from('REJECTED-BYTES'));

    await prisma.document.create({ data: { id: POD_ID, tripId: TRIP_ID, docType: 'pod', storageKey: podKey, status: 'UPLOADED' } });
    await prisma.document.create({ data: { id: ECMR_ID, tripId: TRIP_ID, docType: 'ecmr', storageKey: ecmrKey, status: 'VERIFIED' } });
    await prisma.document.create({ data: { id: INVOICE_ID, tripId: TRIP_ID, docType: 'invoice', storageKey: invoiceKey, status: 'UPLOADED' } });
    await prisma.document.create({ data: { id: REJECTED_ID, tripId: TRIP_ID, docType: 'pod', storageKey: rejectedKey, status: 'UPLOADED' } });
    await prisma.document.create({
      data: { id: OTHER_ORG_POD_ID, tripId: OTHER_TRIP_ID, docType: 'pod', storageKey: `${OTHER_TRIP_ID}/pod/x.jpg`, status: 'UPLOADED' },
    });

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
  rmSync(UPLOAD_DIR, { recursive: true, force: true });
});

function post(url: string, bearer?: string) {
  return app.inject({
    method: 'POST',
    url,
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    payload: '',
  });
}

function del(url: string, bearer: string) {
  return app.inject({ method: 'DELETE', url, headers: { authorization: `Bearer ${bearer}` } });
}

function anon(url: string) {
  return app.inject({ method: 'GET', url });
}

/** Mint the shipment link so document links have a live window to bind to. */
async function mintShipmentLink(): Promise<void> {
  const res = await post(`/api/trips/${TRIP_ID}/track-link`, ownerToken());
  assert.equal(res.statusCode, 201, 'pre-condition: the shipment link mints');
}

/** Mint a document link and return its absolute path. */
async function mintDocumentLink(id: string): Promise<string> {
  const res = await post(`/api/documents/${id}/share-link`, ownerToken());
  assert.equal(res.statusCode, 201, `mint ${id}: ${res.payload}`);
  const link = res.json().link;
  assert.match(link.url, /^\/g\/(document|invoice)\//);
  return link.url as string;
}

function tamper(path: string): string {
  const prefix = path.slice(0, path.lastIndexOf('/') + 1);
  const raw = path.slice(path.lastIndexOf('/') + 1);
  const [header, payload, signature] = raw.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  claims.sub = claims.sub.replace(/-pod$/, '-forged');
  const forged = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${prefix}${header}.${forged}.${signature}`;
}

test('a POD downloads to an anonymous visitor with no cookie and no session (board #132)', async (t) => {
  if (!dbReachable) return t.diagnostic('database not reachable here — assertions skipped');
  await mintShipmentLink();

  const path = await mintDocumentLink(POD_ID);
  assert.match(path, /^\/g\/document\//);
  const token = path.slice('/g/document/'.length);
  assert.ok(token.length > 100, 'a real token: the maxParamLength regression guard');

  const res = await anon(path);
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type']), /image\/jpeg/);
  assert.equal(res.headers['content-disposition'], `attachment; filename="${POD_ID}-pod.jpg"`);
  assert.equal(res.headers['x-robots-tag'], 'noindex, nofollow');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['set-cookie'], undefined, 'a guest link must never set a cookie');
  assert.deepEqual(res.rawPayload, POD_BYTES, 'the exact stored bytes, not another document');

  // The eCMR (a PDF) downloads from the same attachment surface.
  const ecmr = await anon(await mintDocumentLink(ECMR_ID));
  assert.equal(ecmr.statusCode, 200);
  assert.match(String(ecmr.headers['content-type']), /application\/pdf/);
  assert.match(String(ecmr.headers['content-disposition']), /^attachment;/);
  assert.deepEqual(ecmr.rawPayload, ECMR_BYTES);
});

test('an invoice opens inline to an anonymous visitor (board #132)', async (t) => {
  if (!dbReachable) return t.diagnostic('database not reachable here — assertions skipped');
  await mintShipmentLink();

  const path = await mintDocumentLink(INVOICE_ID);
  assert.match(path, /^\/g\/invoice\//);
  const res = await anon(path);
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type']), /application\/pdf/);
  assert.equal(res.headers['content-disposition'], `inline; filename="${INVOICE_ID}-invoice.pdf"`);
  assert.equal(res.headers['set-cookie'], undefined);
  assert.deepEqual(res.rawPayload, INVOICE_BYTES);
});

test('every bad token is a flat 404 with no data and no cookie (board #132)', async (t) => {
  if (!dbReachable) return t.diagnostic('database not reachable here — assertions skipped');
  await mintShipmentLink();

  const podPath = await mintDocumentLink(POD_ID);
  const invoicePath = await mintDocumentLink(INVOICE_ID);

  const cases: Array<[string, string]> = [
    ['/g/document/bogus', 'unknown'],
    ['/g/invoice/bogus', 'unknown'],
    [tamper(podPath), 'tampered'],
    // Wrong scope: an invoice capability on the attachment surface, and the
    // other way round. The route owns the expected scope, never the token.
    [invoicePath.replace('/g/invoice/', '/g/document/'), 'invoice token on /g/document/'],
    [podPath.replace('/g/document/', '/g/invoice/'), 'document token on /g/invoice/'],
  ];

  for (const [url, label] of cases) {
    const res = await anon(url);
    assert.equal(res.statusCode, 404, label);
    assert.equal(res.json().error, 'invalid_token', label);
    assert.equal(res.headers['set-cookie'], undefined, label);
    // The body is the JSON error only — never document bytes.
    assert.equal(res.payload, '{"error":"invalid_token"}', `${label}: no data`);
    assert.equal(res.rawPayload.includes(Buffer.from('POD-PHOTO-BYTES-A')), false, label);
    assert.equal(res.rawPayload.includes(Buffer.from('%PDF')), false, label);
  }

  // An expired capability: signed with the real key, exp in the past.
  const expired = signShareLink({
    scope: 'document',
    documentId: POD_ID,
    version: 0,
    authSecret: env.AUTH_SECRET,
    secret: env.TRACK_LINK_SECRET,
    ttlSeconds: 60,
    now: Math.floor(Date.now() / 1000) - 120,
  });
  const expiredRes = await anon(`/g/document/${expired.token}`);
  assert.equal(expiredRes.statusCode, 404, 'expired');
  assert.equal(expiredRes.headers['set-cookie'], undefined);

  // A shipment tracking token must never open a document.
  const tripLink = await app.inject({ method: 'POST', url: `/api/trips/${TRIP_ID}/track-link`, headers: { authorization: `Bearer ${ownerToken()}` } });
  const trackingToken = tripLink.json().link.token;
  assert.equal((await anon(`/g/document/${trackingToken}`)).statusCode, 404);
});

test('rejecting a document and revoking the shipment link both stop the guest link (board #132)', async (t) => {
  if (!dbReachable) return t.diagnostic('database not reachable here — assertions skipped');
  await mintShipmentLink();

  // Per-document revoke: the link works while UPLOADED, dies on REJECTED.
  const rejectedPath = await mintDocumentLink(REJECTED_ID);
  assert.equal((await anon(rejectedPath)).statusCode, 200, 'pre-condition: an uploaded POD is shareable');
  await prisma.document.update({ where: { id: REJECTED_ID }, data: { status: 'REJECTED' } });
  assert.equal((await anon(rejectedPath)).statusCode, 404, 'a rejected document is not served');
  const remintRejected = await post(`/api/documents/${REJECTED_ID}/share-link`, ownerToken());
  assert.equal(remintRejected.statusCode, 409, 'and it cannot be minted again');
  assert.equal(remintRejected.json().error, 'document_not_shareable');
  await prisma.document.update({ where: { id: REJECTED_ID }, data: { status: 'UPLOADED' } });

  // Shipment revoke: bumping trackLinkVersion kills every document link of it.
  const before = await mintDocumentLink(POD_ID);
  assert.equal((await anon(before)).statusCode, 200, 'pre-condition: the link works');
  const revoked = await del(`/api/trips/${TRIP_ID}/track-link`, ownerToken());
  assert.equal(revoked.statusCode, 200);
  assert.equal((await anon(before)).statusCode, 404, 'the revoked shipment link revokes its documents');

  // A fresh shipment link does not revive the old document token, but a fresh
  // document mint works under the new version.
  await mintShipmentLink();
  assert.equal((await anon(before)).statusCode, 404, 'the old document token stays dead');
  const after = await mintDocumentLink(POD_ID);
  assert.notEqual(after, before);
  assert.equal((await anon(after)).statusCode, 200);
  assert.deepEqual((await anon(after)).rawPayload, POD_BYTES);
});

test('a document link needs a live shipment link, the right org and trip:* (board #132)', async (t) => {
  if (!dbReachable) return t.diagnostic('database not reachable here — assertions skipped');

  // No live shipment link: nothing to bind the document link to.
  await prisma.trip.update({
    where: { id: TRIP_ID },
    data: { trackLinkIssuedAt: null, trackLinkExpiresAt: null },
  });
  const noLink = await post(`/api/documents/${POD_ID}/share-link`, ownerToken());
  assert.equal(noLink.statusCode, 409);
  assert.equal(noLink.json().error, 'no_active_link');
  const readNoLink = await app.inject({ method: 'GET', url: `/api/documents/${POD_ID}/share-link`, headers: { authorization: `Bearer ${ownerToken()}` } });
  assert.equal(readNoLink.statusCode, 200);
  assert.equal(readNoLink.json().link, null);

  // The mint is org-scoped through the document's trip.
  assert.equal((await post(`/api/documents/${OTHER_ORG_POD_ID}/share-link`, ownerToken())).statusCode, 404);

  // A driver has no trip:*: no mint, no read.
  assert.equal((await post(`/api/documents/${POD_ID}/share-link`, driverToken())).statusCode, 403);
  assert.equal(
    (await app.inject({ method: 'GET', url: `/api/documents/${POD_ID}/share-link`, headers: { authorization: `Bearer ${driverToken()}` } })).statusCode,
    403,
  );

  // Anonymous callers cannot mint either.
  assert.equal((await post(`/api/documents/${POD_ID}/share-link`)).statusCode, 401);
});

test('the read endpoint returns the same link after a reload (board #132)', async (t) => {
  if (!dbReachable) return t.diagnostic('database not reachable here — assertions skipped');
  await mintShipmentLink();

  const minted = await mintDocumentLink(POD_ID);
  const read = await app.inject({
    method: 'GET',
    url: `/api/documents/${POD_ID}/share-link`,
    headers: { authorization: `Bearer ${ownerToken()}` },
  });
  assert.equal(read.statusCode, 200);
  assert.equal(read.json().link.url, minted, 'HMAC over the persisted window is deterministic');
  assert.equal(read.json().link.scope, 'document');
  assert.equal(JSON.stringify(read.json()).includes('storageKey'), false, 'never the storage path');
});
