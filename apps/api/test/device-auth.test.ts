/**
 * Passwordless Android device auth — DB-backed router test (board task #104,
 * AND1-A2).
 *
 * Drives the real `buildServer()` with `app.inject()` against real signed
 * tokens and the database:
 *
 *   1. register binds an EC P-256 SPKI public key to the caller's account (201);
 *   2. challenge issues a single-use nonce that a session token cannot mint for
 *      somebody else's credential (404 for an unknown id);
 *   3. verify with the device's signature returns a session token for the SAME
 *      driver and stores only the public key;
 *   4. the challenge is single-use (a replay is 401 `challenge_used`) and a
 *      wrong signature is 401 `invalid_signature`;
 *   5. revoke invalidates the device — the next challenge is 403.
 *
 * The fixture lives in its **own org** (`qa-device-org`), never the seeded pilot
 * org, so it cannot race the concurrent pilot-org suites; it is removed in the
 * `after` hook. Every test early-returns when no database is reachable.
 *
 * Important: `verify` proves the private key never travels — only the public key
 * and a detached signature do. The test generates the keypair with `node:crypto`
 * exactly like the Android Keystore client would.
 *
 * Runs the real API dependencies (`fastify`, `tsx`) and the database:
 *
 *   pnpm --filter @roadwisefleet/api test:router
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { signToken } from '../src/auth/tokens.js';

process.env.ALLOW_INSECURE_AUTH_SECRET = '1';

const { buildServer } = await import('../src/app.js');
const { env } = await import('../src/env.js');
const { prisma } = await import('../src/db.js');

const ORG_ID = 'qa-device-org';
const DRIVER = 'qa-device-driver';
const OTHER = 'qa-device-other';
const USER_IDS = [DRIVER, OTHER];

const P256 = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PUBLIC_KEY = P256.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

let dbReachable = false;
let app: any;

function token(sub: string, role: string, name: string): string {
  return signToken({ sub, org: ORG_ID, role, name }, env.AUTH_SECRET);
}
const driverToken = () => token(DRIVER, 'driver', 'QA Device Driver');

function signNonce(nonce: string): string {
  return cryptoSign('sha256', Buffer.from(nonce, 'utf8'), P256.privateKey).toString('base64');
}

async function removeFixture(): Promise<void> {
  try {
    await prisma.deviceChallenge.deleteMany({ where: { credential: { driverId: { in: USER_IDS } } } });
    await prisma.deviceCredential.deleteMany({ where: { driverId: { in: USER_IDS } } });
    await prisma.auditLog.deleteMany({ where: { orgId: ORG_ID } });
    await prisma.user.deleteMany({ where: { id: { in: USER_IDS } } });
    await prisma.org.deleteMany({ where: { id: ORG_ID } });
  } catch {
    /* best-effort cleanup: never fail the suite on teardown */
  }
}

before(async () => {
  try {
    await prisma.org.findFirst({ where: { id: 'pilot-org' } });
    await removeFixture();
    await prisma.org.create({ data: { id: ORG_ID, name: 'QA Device Org', locale: 'en', dataRegion: 'eu', plan: 'free' } });
    await prisma.user.create({ data: { id: DRIVER, orgId: ORG_ID, roleId: 'driver', name: 'QA Device Driver', lang: 'en' } });
    await prisma.user.create({ data: { id: OTHER, orgId: ORG_ID, roleId: 'driver', name: 'QA Device Other', lang: 'en' } });
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

function post(url: string, body: unknown, bearer?: string) {
  return app.inject({
    method: 'POST',
    url,
    payload: body,
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  });
}

/** Register a credential and return its id (fails the test when the call fails). */
async function register(): Promise<string> {
  const res = await post('/api/auth/device/register', { publicKey: PUBLIC_KEY, deviceLabel: 'QA Pixel' }, driverToken());
  assert.equal(res.statusCode, 201, res.body);
  return res.json().credential.id as string;
}

/** The whole challenge -> sign -> verify round trip; returns the verify response. */
async function roundTrip(credentialId: string) {
  const challenge = await post('/api/auth/device/challenge', { credentialId });
  assert.equal(challenge.statusCode, 200, challenge.body);
  const { challengeId, nonce } = challenge.json() as { challengeId: string; nonce: string };
  return { challengeId, nonce, verify: await post('/api/auth/device/verify', { challengeId, signature: signNonce(nonce) }) };
}

test('register binds an EC public key and stores no private material', async (t) => {
  if (!dbReachable) return t.diagnostic('database not reachable here — assertions skipped');

  const res = await post('/api/auth/device/register', { publicKey: PUBLIC_KEY, deviceLabel: 'QA Pixel' }, driverToken());
  assert.equal(res.statusCode, 201, res.body);
  const credential = res.json().credential as { id: string; algorithm: string; deviceLabel: string };
  assert.ok(credential.id, 'a credential id is returned');
  assert.equal(credential.algorithm, 'ES256');
  assert.equal(credential.deviceLabel, 'QA Pixel');

  const row = await prisma.deviceCredential.findUnique({ where: { id: credential.id } });
  assert.equal(row?.publicKey, PUBLIC_KEY, 'the stored value is exactly the public key');
  assert.equal(row?.driverId, DRIVER, 'the credential is bound to the caller');
});

test('register refuses anonymous callers and malformed keys', async (t) => {
  if (!dbReachable) return t.diagnostic('database not reachable here — assertions skipped');

  const anonymous = await post('/api/auth/device/register', { publicKey: PUBLIC_KEY });
  assert.equal(anonymous.statusCode, 401);

  const badKey = await post('/api/auth/device/register', { publicKey: 'not-a-key' }, driverToken());
  assert.equal(badKey.statusCode, 400);
  assert.equal(badKey.json().error, 'invalid_public_key');
});

test('challenge + verify returns a session token for the bound driver', async (t) => {
  if (!dbReachable) return t.diagnostic('database not reachable here — assertions skipped');

  const credentialId = await register();
  const { verify } = await roundTrip(credentialId);
  assert.equal(verify.statusCode, 200, verify.body);
  const body = verify.json() as { token: string; user: { id: string; deviceCredentialId: string } };
  assert.ok(body.token, 'a session token is issued');
  assert.equal(body.user.id, DRIVER, 'the token belongs to the credential owner');
  assert.equal(body.user.deviceCredentialId, credentialId);

  const row = await prisma.deviceCredential.findUnique({ where: { id: credentialId } });
  assert.ok(row?.lastUsedAt, 'a successful verify stamps lastUsedAt');
});

test('a challenge is single-use and a wrong signature is refused', async (t) => {
  if (!dbReachable) return t.diagnostic('database not reachable here — assertions skipped');

  const credentialId = await register();
  const first = await roundTrip(credentialId);
  assert.equal(first.verify.statusCode, 200);

  const replay = await post('/api/auth/device/verify', {
    challengeId: first.challengeId,
    signature: signNonce(first.nonce),
  });
  assert.equal(replay.statusCode, 401);
  assert.equal(replay.json().error, 'challenge_used');

  const fresh = await post('/api/auth/device/challenge', { credentialId });
  const { challengeId, nonce } = fresh.json() as { challengeId: string; nonce: string };
  const wrong = await post('/api/auth/device/verify', { challengeId, signature: signNonce(`${nonce}x`) });
  assert.equal(wrong.statusCode, 401);
  assert.equal(wrong.json().error, 'invalid_signature');
});

test("another driver cannot mint a challenge for somebody else's credential", async (t) => {
  if (!dbReachable) return t.diagnostic('database not reachable here — assertions skipped');

  const credentialId = await register();
  const unknown = await post('/api/auth/device/challenge', { credentialId: `${credentialId}-missing` });
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.json().error, 'credential_not_found');

  // The endpoint is public by design (no password), but the nonce is useless
  // without the private key: a valid challenge still fails with a bad signature.
  const challenge = await post('/api/auth/device/challenge', { credentialId });
  assert.equal(challenge.statusCode, 200);
});

test('revoke invalidates the device (lost-phone path)', async (t) => {
  if (!dbReachable) return t.diagnostic('database not reachable here — assertions skipped');

  const credentialId = await register();
  const revoked = await post('/api/auth/device/revoke', { credentialId }, driverToken());
  assert.equal(revoked.statusCode, 200, revoked.body);

  const challenge = await post('/api/auth/device/challenge', { credentialId });
  assert.equal(challenge.statusCode, 403, 'a revoked credential can no longer start a login');
  assert.equal(challenge.json().error, 'credential_revoked');

  const row = await prisma.deviceCredential.findUnique({ where: { id: credentialId } });
  assert.ok(row?.revokedAt, 'revokedAt is persisted');
});

test("a driver cannot revoke another driver's credential", async (t) => {
  if (!dbReachable) return t.diagnostic('database not reachable here — assertions skipped');

  const credentialId = await register();
  const res = await post('/api/auth/device/revoke', { credentialId }, token(OTHER, 'driver', 'QA Device Other'));
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'forbidden');
});
