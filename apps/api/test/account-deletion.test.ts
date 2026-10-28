/**
 * Account deletion — DB-backed router test (board task #142, AND1-A3).
 *
 * Drives the real `buildServer()` with `app.inject()` against real signed
 * tokens and the database. The acceptance items come straight from the issue:
 *
 *   1. `DELETE /api/account` anonymises the signed-in `User` row in place
 *      (name / e-mail / phone / password / 2FA scrubbed, `deletedAt` stamped);
 *   2. the deleted account can NEVER authenticate again: the password login is
 *      refused, `GET /api/auth/me` with the pre-deletion token is 401, device
 *      registration is refused and the device credential is revoked (a challenge
 *      for it is 403 `credential_revoked`);
 *   3. no trip/document row is deleted and the tenant can still read the trip
 *      whose driver was deleted — retention is the owner decision on #13/#46, so
 *      the data stays and the response SAYS so;
 *   4. the endpoint is idempotent: a second call is a clean 200 `alreadyDeleted`
 *      with no further writes.
 *
 * Board task #144 (AND1-A3b) adds the last-administrator gate and its tests are
 * at the bottom of this file:
 *
 *   5. a fleet owner who is the org's ONLY administrator gets `409 last_owner`
 *      and the row is completely unchanged (name, address, password, deletedAt);
 *   6. the same owner may delete once a second administrator exists — then the
 *      tombstone applies and one administrator remains;
 *   7. a solo carrier (`solo` role, own one-person org) is NOT gated, so the
 *      Play-required deletion of #142 keeps working for them.
 *
 * The fixture lives in its own org (`qa-142-org`), never the seeded pilot org,
 * so it cannot race the concurrent pilot-org suites; it is removed in `after`.
 * Every test early-returns when no database is reachable, so the file also runs
 * on a bare checkout.
 *
 *   pnpm --filter @roadwisefleet/api test:router
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { hashPassword } from '../src/auth/password.js';
import { signToken } from '../src/auth/tokens.js';

process.env.ALLOW_INSECURE_AUTH_SECRET = '1';

const { buildServer } = await import('../src/app.js');
const { env } = await import('../src/env.js');
const { prisma } = await import('../src/db.js');
const { activeAdminWhere } = await import('../src/account-deletion.js');

const ORG_ID = 'qa-142-org';
const USER_ID = 'qa-142-user';
const READER_ID = 'qa-142-owner';
const CUSTOMER_ID = 'qa-142-customer';
const ORDER_ID = 'qa-142-order';
const TRIP_ID = 'qa-142-trip';
const DOC_ID = 'qa-142-doc';
const EMAIL = 'qa142.driver@example.com';
const PASSWORD = 'Qa142-Passw0rd!';

/* Board #144 (AND1-A3b): a fleet whose only administrator wants to leave, and a
 * solo carrier whose deletion must keep working (#142). */
const LAST_ORG_ID = 'qa-144-org';
const LAST_OWNER_ID = 'qa-144-owner';
const SECOND_OWNER_ID = 'qa-144-owner-2';
const LAST_OWNER_EMAIL = 'qa144.owner@example.com';
const SOLO_ORG_ID = 'qa-144-solo-org';
const SOLO_ID = 'qa-144-solo';

const P256 = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PUBLIC_KEY = P256.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

let dbReachable = false;
let app: any;
/** The token minted by a REAL login, before the account was deleted. */
let sessionToken = '';
let credentialId = '';
let delivered: any;

const readerToken = () => signToken({ sub: READER_ID, org: ORG_ID, role: 'owner', name: 'QA 142 Reader' }, env.AUTH_SECRET);

/** A bearer token for any fixture account (the route reads the DB row, not this claim). */
const tokenFor = (userId: string, orgId: string, roleId: string, name: string) =>
  signToken({ sub: userId, org: orgId, role: roleId, name }, env.AUTH_SECRET);

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function removeFixture(): Promise<void> {
  try {
    await prisma.document.deleteMany({ where: { id: DOC_ID } });
    await prisma.statusEvent.deleteMany({ where: { tripId: TRIP_ID } });
    await prisma.trip.deleteMany({ where: { id: TRIP_ID } });
    await prisma.order.deleteMany({ where: { id: ORDER_ID } });
    await prisma.customer.deleteMany({ where: { id: CUSTOMER_ID } });
    await prisma.deviceChallenge.deleteMany({ where: { credential: { driverId: USER_ID } } });
    await prisma.deviceCredential.deleteMany({ where: { driverId: USER_ID } });
    await prisma.emailOtp.deleteMany({ where: { email: EMAIL } });
    await prisma.auditLog.deleteMany({ where: { orgId: { in: [ORG_ID, LAST_ORG_ID, SOLO_ORG_ID] } } });
    await prisma.user.deleteMany({
      where: { id: { in: [USER_ID, READER_ID, LAST_OWNER_ID, SECOND_OWNER_ID, SOLO_ID] } },
    });
    await prisma.org.deleteMany({ where: { id: { in: [ORG_ID, LAST_ORG_ID, SOLO_ORG_ID] } } });
  } catch {
    /* best-effort cleanup: never fail the suite on teardown */
  }
}

before(async () => {
  try {
    // Reachability probe: any DB-backed assertion below depends on it.
    await prisma.org.findFirst({ where: { id: 'pilot-org' } });
    await removeFixture();
    await prisma.org.create({ data: { id: ORG_ID, name: 'QA Account Deletion Org', locale: 'en', dataRegion: 'eu', plan: 'free' } });
    await prisma.user.create({
      data: {
        id: USER_ID,
        orgId: ORG_ID,
        roleId: 'driver',
        name: 'QA 142 Driver',
        email: EMAIL,
        phone: '+48 600 142 142',
        passwordHash: hashPassword(PASSWORD),
        totpSecret: 'JBSWY3DPEHPK3PXP',
        emailVerifiedAt: new Date(),
      },
    });
    await prisma.user.create({
      data: { id: READER_ID, orgId: ORG_ID, roleId: 'owner', name: 'QA 142 Reader', email: 'qa142.reader@example.com' },
    });
    await prisma.customer.create({ data: { id: CUSTOMER_ID, orgId: ORG_ID, name: 'QA 142 Customer' } });
    await prisma.order.create({
      data: { id: ORDER_ID, customerId: CUSTOMER_ID, origin: 'Warszawa', destination: 'Gdańsk', cargo: 'pallets' },
    });
    await prisma.trip.create({
      data: { id: TRIP_ID, orgId: ORG_ID, orderId: ORDER_ID, driverId: USER_ID, status: 'ASSIGNED' },
    });
    await prisma.document.create({
      data: { id: DOC_ID, tripId: TRIP_ID, docType: 'pod', storageKey: 'qa/142/pod.pdf', status: 'UPLOADED' },
    });
    const credential = await prisma.deviceCredential.create({
      data: { driverId: USER_ID, publicKey: PUBLIC_KEY, algorithm: 'ES256', deviceLabel: 'QA 142 phone' },
    });
    credentialId = credential.id;
    await prisma.emailOtp.create({
      data: {
        email: EMAIL,
        purpose: 'login',
        hash: 'qa-142-not-a-real-hash',
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });
    app = buildServer();
    await app.ready();

    // Board #144 fixtures: a fleet with exactly one administrator, and a solo
    // carrier in its own one-person org. Role rows are created only when absent
    // (`update: {}`), so the seeded permissions are never rewritten.
    await prisma.role.upsert({ where: { id: 'owner' }, update: {}, create: { id: 'owner', permissions: ['trip:*', 'user:manage'] } });
    await prisma.role.upsert({ where: { id: 'solo' }, update: {}, create: { id: 'solo', permissions: ['trip:*'] } });
    await prisma.org.create({ data: { id: LAST_ORG_ID, name: 'QA 144 Sole Owner Org', locale: 'en', dataRegion: 'eu', plan: 'free' } });
    await prisma.user.create({
      data: {
        id: LAST_OWNER_ID,
        orgId: LAST_ORG_ID,
        roleId: 'owner',
        name: 'QA 144 Sole Owner',
        email: LAST_OWNER_EMAIL,
        passwordHash: hashPassword(PASSWORD),
      },
    });
    await prisma.org.create({ data: { id: SOLO_ORG_ID, name: 'QA 144 Solo Carrier Org', locale: 'en', dataRegion: 'eu', plan: 'free' } });
    await prisma.user.create({
      data: {
        id: SOLO_ID,
        orgId: SOLO_ORG_ID,
        roleId: 'solo',
        name: 'QA 144 Solo Carrier',
        email: 'qa144.solo@example.com',
        passwordHash: hashPassword(PASSWORD),
      },
    });

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

test('the fixture password really logs in before the deletion (non-vacuous)', async () => {
  if (!dbReachable) return;
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: EMAIL, password: PASSWORD } });
  assert.equal(res.statusCode, 200);
  sessionToken = res.json().token;
  assert.ok(sessionToken, 'a real session token is required for the deletion call');

  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: bearer(sessionToken) });
  assert.equal(me.statusCode, 200);
});

test('the deletion endpoint requires a bearer token', async () => {
  if (!dbReachable) return;
  const res = await app.inject({ method: 'DELETE', url: '/api/account' });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, 'unauthorized');
});

test('DELETE /api/account anonymises the row and states what remains', async () => {
  if (!dbReachable) return;
  const res = await app.inject({ method: 'DELETE', url: '/api/account', headers: bearer(sessionToken) });
  assert.equal(res.statusCode, 200);
  delivered = res.json();
  assert.equal(delivered.deleted, true);
  assert.equal(delivered.alreadyDeleted, false);
  assert.equal(delivered.anonymized, true);
  assert.equal(delivered.retentionPolicy, 'owner_decision_pending');
  assert.equal(delivered.messageKey, 'account.delete.done');
  assert.deepEqual(
    delivered.retained.map((entry: any) => entry.type),
    ['trips', 'documents', 'reviews'],
  );
  assert.ok(delivered.anonymizedAt, 'the response carries when the anonymisation happened');

  // The response itself must not echo the personal data it just erased.
  const payload = res.payload;
  assert.ok(!payload.includes(EMAIL));
  assert.ok(!payload.includes('QA 142 Driver'));
  assert.ok(!payload.includes('+48 600 142 142'));
  assert.ok(!payload.includes('JBSWY3DPEHPK3PXP'));
});

test('the User row is tombstoned in the database', async () => {
  if (!dbReachable) return;
  const row = await prisma.user.findUnique({ where: { id: USER_ID } });
  assert.ok(row);
  assert.equal(row!.name, 'Deleted account');
  assert.equal(row!.email, `deleted+${USER_ID}@deleted.invalid`);
  assert.equal(row!.phone, null);
  assert.equal(row!.passwordHash, null);
  assert.equal(row!.totpSecret, null);
  assert.equal(row!.emailVerifiedAt, null);
  assert.equal(row!.lockedUntil, null);
  assert.equal(row!.failedLoginCount, 0);
  assert.ok(row!.deletedAt, 'deletedAt is stamped');
  // The tenant link is kept: trips and status events still reference this row.
  assert.equal(row!.orgId, ORG_ID);
});

test('a deleted account can never authenticate again', async () => {
  if (!dbReachable) return;

  // 1. The password login is refused (same generic answer as a bad password).
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: EMAIL, password: PASSWORD } });
  assert.equal(login.statusCode, 401);
  assert.equal(login.json().error, 'invalid_credentials');

  // 2. The pre-deletion bearer token no longer identifies the account.
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: bearer(sessionToken) });
  assert.equal(me.statusCode, 401);
  assert.equal(me.json().error, 'unauthorized');

  // 3. No new device may be bound to the tombstone.
  const register = await app.inject({
    method: 'POST',
    url: '/api/auth/device/register',
    headers: bearer(sessionToken),
    payload: { publicKey: PUBLIC_KEY, algorithm: 'ES256', deviceLabel: 'QA 142 second phone' },
  });
  assert.equal(register.statusCode, 401);
});

test('every device credential is revoked and cannot mint a challenge', async () => {
  if (!dbReachable) return;
  const credential = await prisma.deviceCredential.findUnique({ where: { id: credentialId } });
  assert.ok(credential);
  assert.ok(credential!.revokedAt, 'revokedAt is set by the deletion');

  const challenge = await app.inject({
    method: 'POST',
    url: '/api/auth/device/challenge',
    payload: { credentialId },
  });
  assert.equal(challenge.statusCode, 403);
  assert.equal(challenge.json().error, 'credential_revoked');

  // No single-use nonces are left behind for the revocation to be undone by.
  const challenges = await prisma.deviceChallenge.count({ where: { credential: { driverId: USER_ID } } });
  assert.equal(challenges, 0);
});

test('outstanding e-mail one-time codes for the old address are gone', async () => {
  if (!dbReachable) return;
  const codes = await prisma.emailOtp.count({ where: { email: EMAIL } });
  assert.equal(codes, 0);
});

test('trips and documents survive, and the tenant can still read them', async () => {
  if (!dbReachable) return;
  const trip = await prisma.trip.findUnique({ where: { id: TRIP_ID } });
  assert.ok(trip, 'the trip row is NOT deleted');
  assert.equal(trip!.driverId, USER_ID, 'the trip keeps pointing at the tombstoned driver');
  const doc = await prisma.document.findUnique({ where: { id: DOC_ID } });
  assert.ok(doc, 'the delivery evidence is NOT deleted');

  // Readable by the tenant: a colleague in the same org lists it through the API.
  const list = await app.inject({ method: 'GET', url: '/api/trips', headers: bearer(readerToken()) });
  assert.equal(list.statusCode, 200);
  const trips = list.json().trips as any[];
  assert.ok(
    trips.some((entry) => entry.id === TRIP_ID),
    'the trip whose driver was deleted is still visible to its tenant',
  );
  // The tombstoned driver is serialised without credential or personal fields.
  const listed = trips.find((entry) => entry.id === TRIP_ID);
  const driverPayload = JSON.stringify(listed.driver ?? {});
  assert.ok(!driverPayload.includes(EMAIL));
  assert.ok(!driverPayload.includes('passwordHash'));
});

test('a second deletion is a clean no-op', async () => {
  if (!dbReachable) return;
  const first = await prisma.user.findUnique({ where: { id: USER_ID }, select: { deletedAt: true } });
  const again = await app.inject({ method: 'DELETE', url: '/api/account', headers: bearer(sessionToken) });
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().deleted, true);
  assert.equal(again.json().alreadyDeleted, true);

  const afterSecond = await prisma.user.findUnique({ where: { id: USER_ID }, select: { deletedAt: true } });
  assert.equal(afterSecond!.deletedAt!.toISOString(), first!.deletedAt!.toISOString(), 'no second write');
  // The statement is still returned, so a retry is informative rather than blank.
  assert.equal(again.json().retentionPolicy, 'owner_decision_pending');
});

/* ------------------------------------------------------------------ *
 * Board #144 (AND1-A3b): a fleet owner must not leave the org with no
 * administrator. Refuse the deletion, change nothing.
 * ------------------------------------------------------------------ */

test('the only administrator of a fleet is refused with 409 last_owner and the row is unchanged', async () => {
  if (!dbReachable) return;

  const beforeRow = await prisma.user.findUnique({ where: { id: LAST_OWNER_ID } });
  assert.ok(beforeRow, 'the sole-owner fixture exists before the attempt');

  const res = await app.inject({
    method: 'DELETE',
    url: '/api/account',
    headers: bearer(tokenFor(LAST_OWNER_ID, LAST_ORG_ID, 'owner', 'QA 144 Sole Owner')),
  });
  assert.equal(res.statusCode, 409);
  const body = res.json();
  assert.equal(body.error, 'last_owner');
  assert.equal(body.messageKey, 'account.delete.lastOwner', 'the clients localise this key');
  // The refusal is a refusal, not a partial success.
  assert.equal(body.deleted, undefined);
  assert.equal(body.alreadyDeleted, undefined);
  assert.ok(!res.payload.includes(LAST_OWNER_EMAIL), 'the refusal never echoes personal data');

  // NOTHING changed: the person can still use (and later hand over) the account.
  const afterRow = await prisma.user.findUnique({ where: { id: LAST_OWNER_ID } });
  assert.ok(afterRow);
  assert.equal(afterRow!.name, 'QA 144 Sole Owner');
  assert.equal(afterRow!.email, LAST_OWNER_EMAIL);
  assert.ok(afterRow!.passwordHash, 'the password hash survives a refused deletion');
  assert.equal(afterRow!.deletedAt, null);
  assert.equal(afterRow!.orgId, LAST_ORG_ID);
  assert.equal(afterRow!.roleId, 'owner');

  // No audit entry claims a deletion that did not happen.
  const audits = await prisma.auditLog.count({ where: { orgId: LAST_ORG_ID, action: 'account.deleted' } });
  assert.equal(audits, 0);

  // And the session is still valid: a refusal is not a sign-out.
  const me = await app.inject({
    method: 'GET',
    url: '/api/auth/me',
    headers: bearer(tokenFor(LAST_OWNER_ID, LAST_ORG_ID, 'owner', 'QA 144 Sole Owner')),
  });
  assert.equal(me.statusCode, 200);
});

test('once a second administrator exists the same owner may delete', async () => {
  if (!dbReachable) return;

  await prisma.user.create({
    data: {
      id: SECOND_OWNER_ID,
      orgId: LAST_ORG_ID,
      roleId: 'owner',
      name: 'QA 144 Second Owner',
      email: 'qa144.owner2@example.com',
    },
  });

  const res = await app.inject({
    method: 'DELETE',
    url: '/api/account',
    headers: bearer(tokenFor(LAST_OWNER_ID, LAST_ORG_ID, 'owner', 'QA 144 Sole Owner')),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().deleted, true);
  assert.equal(res.json().alreadyDeleted, false);

  const row = await prisma.user.findUnique({ where: { id: LAST_OWNER_ID } });
  assert.ok(row!.deletedAt, 'the tombstone is stamped');
  assert.equal(row!.email, `deleted+${LAST_OWNER_ID}@deleted.invalid`);
  assert.equal(row!.passwordHash, null);

  // The fleet is still manageable: exactly one LIVE administrator remains.
  const admins = await prisma.user.count({ where: activeAdminWhere(LAST_ORG_ID) });
  assert.equal(admins, 1);
});

test('a solo carrier is not gated as a fleet owner and can still delete (#142 survives)', async () => {
  if (!dbReachable) return;
  const res = await app.inject({
    method: 'DELETE',
    url: '/api/account',
    headers: bearer(tokenFor(SOLO_ID, SOLO_ORG_ID, 'solo', 'QA 144 Solo Carrier')),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().deleted, true);

  const row = await prisma.user.findUnique({ where: { id: SOLO_ID } });
  assert.ok(row!.deletedAt, 'a solo carrier is anonymised as before');
  assert.equal(row!.email, `deleted+${SOLO_ID}@deleted.invalid`);
});
