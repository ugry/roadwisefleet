/**
 * Email one-time codes — DB-backed router test (board task #125).
 *
 * Drives the real `buildServer()` with `app.inject()` against the database and a
 * fake delivery transport (nothing is sent over the network):
 *
 *   1. request -> one message, a live 6-digit code, stored ONLY as an HMAC;
 *   2. the resend gap: a second request inside 60 s does not send again;
 *   3. verify -> the same `{ token, user }` shape as `/api/auth/login`, and the
 *      token authenticates `/api/auth/me`;
 *   4. the code is single-use;
 *   5. no enumeration: an unknown address gets the same body and no message;
 *   6. wrong guesses are bounded: the fifth failure burns the code, so the
 *      correct value is refused afterwards;
 *   7. an expired code is refused;
 *   8. the per-address window returns 429 (and no message) once exhausted;
 *   9. email confirmation is the SAME service with a different purpose, and a
 *      sign-in code can never be redeemed as a confirmation code;
 *  10. fail-closed: an unconfigured sender creates no redeemable row and still
 *      answers generically.
 *
 * The fixture lives in its own org (`qa-otp-org`), never the seeded pilot org.
 * Every test early-returns when no database is reachable.
 *
 * Runs with the real API dependencies and the database:
 *
 *   pnpm --filter @roadwisefleet/api test:router
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { signToken } from '../src/auth/tokens.js';

process.env.ALLOW_INSECURE_AUTH_SECRET = '1';

const { buildServer } = await import('../src/app.js');
const { env } = await import('../src/env.js');
const { prisma } = await import('../src/db.js');

const ORG_ID = 'qa-otp-org';
const DRIVER = 'qa-otp-driver';
const EMAIL = 'qa-otp-driver@example.com';
const OTHER_EMAIL = 'qa-otp-unknown@example.com';
const BURN_EMAIL = 'qa-otp-burn@example.com';
const LIMIT_EMAIL = 'qa-otp-limit@example.com';

/** Every message the fake transport "delivered", in order. */
const delivered: Array<{ to: string; code: string; purpose: string }> = [];
const mailer = {
  configured: true,
  async sendCode(args: { to: string; code: string; purpose: string }) {
    delivered.push({ ...args });
    return { sent: true };
  },
};

/** A sender that is NOT configured (the state before #124's credential lands). */
const deadMailer = {
  configured: false,
  async sendCode() {
    return { sent: false, reason: 'not_configured' };
  },
};

/** The first live sign-in code, captured so later tests do not depend on the
 *  delivered[] array (each test resets it). */
let loginCode = '';

let dbReachable = false;
let app: any;
let deadApp: any;

function driverToken(id = DRIVER): string {
  return signToken({ sub: id, org: ORG_ID, role: 'driver', name: 'QA OTP Driver' }, env.AUTH_SECRET);
}

async function removeFixture(): Promise<void> {
  try {
    await prisma.emailOtp.deleteMany({
      where: { email: { in: [EMAIL, OTHER_EMAIL, BURN_EMAIL, LIMIT_EMAIL] } },
    });
    await prisma.auditLog.deleteMany({ where: { orgId: ORG_ID } });
    await prisma.user.deleteMany({ where: { id: { in: [DRIVER, 'qa-otp-burn'] } } });
    await prisma.org.deleteMany({ where: { id: ORG_ID } });
  } catch {
    /* best-effort cleanup: never fail the suite on teardown */
  }
}

function lastCode(to: string): string {
  const message = [...delivered].reverse().find((entry) => entry.to === to);
  assert.ok(message, `expected a message to ${to}`);
  assert.match(message.code, /^\d{6}$/);
  return message.code;
}

before(async () => {
  try {
    await prisma.org.findFirst({ where: { id: 'pilot-org' } });
    await removeFixture();
    await prisma.org.create({ data: { id: ORG_ID, name: 'QA OTP Org', locale: 'en', dataRegion: 'eu', plan: 'free' } });
    await prisma.user.create({
      data: { id: DRIVER, orgId: ORG_ID, roleId: 'driver', name: 'QA OTP Driver', email: EMAIL, lang: 'en' },
    });
    app = buildServer({ emailSender: mailer });
    await app.ready();
    deadApp = buildServer({ emailSender: deadMailer });
    await deadApp.ready();
    dbReachable = true;
  } catch (err) {
    console.error('fixture setup failed — DB assertions will be skipped:', (err as Error).message);
  }
});

after(async () => {
  await removeFixture();
  if (app) await app.close();
  if (deadApp) await deadApp.close();
  await prisma.$disconnect();
});

function post(server: any, url: string, body: unknown, bearer?: string) {
  return server.inject({
    method: 'POST',
    url,
    payload: body,
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  });
}

test('request: delivers one code, stores only its HMAC', async (t) => {
  if (!dbReachable) return t.diagnostic('database not reachable here — assertions skipped');
  delivered.length = 0;

  const res = await post(app, '/api/auth/otp/email/request', { email: EMAIL });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.expiresInSeconds, 600);
  assert.equal(body.resendAfterSeconds, 60);

  assert.equal(delivered.length, 1);
  const code = lastCode(EMAIL);
  loginCode = code;
  assert.equal(delivered[0].purpose, 'login');

  const row = await prisma.emailOtp.findFirst({ where: { email: EMAIL, purpose: 'login' } });
  assert.ok(row);
  assert.notEqual(row.hash, code);
  assert.match(row.hash, /^[0-9a-f]{64}$/);
  assert.equal(row.attempts, 0);
  assert.equal(row.usedAt, null);
  assert.ok(row.expiresAt.getTime() > Date.now() + 9 * 60 * 1000);
  // The plaintext code appears nowhere in the row.
  assert.doesNotMatch(JSON.stringify(row), new RegExp(code));
});

test('request: the 60-second resend gap sends nothing', async (t) => {
  if (!dbReachable) return t.diagnostic('database not reachable here — assertions skipped');
  delivered.length = 0;

  const res = await post(app, '/api/auth/otp/email/request', { email: EMAIL });
  assert.equal(res.statusCode, 200, res.body);
  // The body is CONSTANT by design: the app runs its own 60 s timer and the
  // server silently enforces the real gap, so the response can never signal
  // whether a code was actually sent.
  assert.equal(res.json().resendAfterSeconds, 60);
  assert.equal(delivered.length, 0, 'no second message inside the gap');
});

test('verify: issues the same token shape as password login, single use', async (t) => {
  if (!dbReachable) return t.diagnostic('database not reachable here — assertions skipped');
  const code = loginCode;

  const res = await post(app, '/api/auth/otp/email/verify', { email: EMAIL, code });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.ok(body.token);
  assert.equal(body.user.id, DRIVER);
  assert.equal(body.user.roleId, 'driver');
  assert.equal(body.user.orgId, ORG_ID);
  assert.ok(body.user.locale, 'locale travels with the response');

  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${body.token}` } });
  assert.equal(me.statusCode, 200, me.body);
  assert.equal(me.json().user.id, DRIVER);

  // Single use: the same code can never mint a second session.
  const replay = await post(app, '/api/auth/otp/email/verify', { email: EMAIL, code });
  assert.equal(replay.statusCode, 401, replay.body);
  assert.equal(replay.json().error, 'invalid_code');
});

test('request: an unknown address is indistinguishable and sends nothing', async (t) => {
  if (!dbReachable) return t.diagnostic('database not reachable here — assertions skipped');
  delivered.length = 0;

  const known = await post(app, '/api/auth/otp/email/request', { email: EMAIL });
  const unknown = await post(app, '/api/auth/otp/email/request', { email: OTHER_EMAIL });
  assert.equal(unknown.statusCode, known.statusCode);
  // Byte-identical bodies: same keys, same values.
  assert.deepEqual(unknown.json(), known.json());
  assert.deepEqual(Object.keys(unknown.json()).sort(), ['expiresInSeconds', 'ok', 'resendAfterSeconds']);
  assert.equal(unknown.json().expiresInSeconds, 600);
  assert.equal(delivered.length, 0, 'nothing is sent to an address without an account');

  // ...and verify answers exactly like a wrong code.
  const res = await post(app, '/api/auth/otp/email/verify', { email: OTHER_EMAIL, code: '123456' });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, 'invalid_code');
});

test('verify: five wrong guesses burn the code — the right one is then refused', async (t) => {
  if (!dbReachable) return t.diagnostic('database not reachable here — assertions skipped');
  await prisma.user.create({
    data: { id: 'qa-otp-burn', orgId: ORG_ID, roleId: 'driver', name: 'QA OTP Burn', email: BURN_EMAIL, lang: 'en' },
  });
  delivered.length = 0;
  const requested = await post(app, '/api/auth/otp/email/request', { email: BURN_EMAIL });
  assert.equal(requested.statusCode, 200, requested.body);
  const code = lastCode(BURN_EMAIL);
  const wrong = code === '000000' ? '111111' : '000000';

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const res = await post(app, '/api/auth/otp/email/verify', { email: BURN_EMAIL, code: wrong });
    assert.equal(res.statusCode, 401, `attempt ${attempt}: ${res.body}`);
    assert.equal(res.json().error, 'invalid_code');
  }
  const row = await prisma.emailOtp.findFirst({ where: { email: BURN_EMAIL } });
  assert.equal(row?.attempts, 5);
  assert.equal(row?.hash, '', 'the cap burns the stored hash');

  const correct = await post(app, '/api/auth/otp/email/verify', { email: BURN_EMAIL, code });
  assert.equal(correct.statusCode, 401, 'a burned code cannot be redeemed');
});

test('verify: an expired code is refused', async (t) => {
  if (!dbReachable) return t.diagnostic('database not reachable here — assertions skipped');
  const code = '424242';
  const { hashCode } = await import('../src/email-otp.js');
  await prisma.emailOtp.deleteMany({ where: { email: BURN_EMAIL } });
  await prisma.emailOtp.create({
    data: {
      email: BURN_EMAIL,
      purpose: 'login',
      hash: hashCode({ code, email: BURN_EMAIL, purpose: 'login', secret: env.AUTH_SECRET }),
      expiresAt: new Date(Date.now() - 1000),
    },
  });
  const res = await post(app, '/api/auth/otp/email/verify', { email: BURN_EMAIL, code });
  assert.equal(res.statusCode, 401, res.body);
  assert.equal(res.json().error, 'invalid_code');
});

test('request: the per-address window returns 429 and sends nothing', async (t) => {
  if (!dbReachable) return t.diagnostic('database not reachable here — assertions skipped');
  delivered.length = 0;
  const statuses: number[] = [];
  for (let i = 0; i < 6; i += 1) {
    const res = await post(app, '/api/auth/otp/email/request', { email: LIMIT_EMAIL });
    statuses.push(res.statusCode);
  }
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429]);
  assert.equal(delivered.length, 0, 'an unknown address is never mailed');
});

test('email confirmation: same service, separate purpose, bearer required', async (t) => {
  if (!dbReachable) return t.diagnostic('database not reachable here — assertions skipped');
  await prisma.user.update({ where: { id: DRIVER }, data: { emailVerifiedAt: null } });
  delivered.length = 0;

  const anonymous = await post(app, '/api/auth/email/confirm/request', {});
  assert.equal(anonymous.statusCode, 401);

  const requested = await post(app, '/api/auth/email/confirm/request', {}, driverToken());
  assert.equal(requested.statusCode, 200, requested.body);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].purpose, 'verify');
  assert.equal(delivered[0].to, EMAIL);
  const code = lastCode(EMAIL);

  // A sign-in code is not a confirmation code: mint one for 'login' and try it.
  await prisma.emailOtp.deleteMany({ where: { email: EMAIL, purpose: 'login' } });
  const signIn = await post(app, '/api/auth/otp/email/request', { email: EMAIL });
  assert.equal(signIn.statusCode, 200, signIn.body);
  const loginCode = lastCode(EMAIL);
  const crossed = await post(app, '/api/auth/email/confirm/verify', { code: loginCode }, driverToken());
  assert.equal(crossed.statusCode, 401, 'a login code cannot confirm an email');

  const confirmed = await post(app, '/api/auth/email/confirm/verify', { code }, driverToken());
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  assert.equal(confirmed.json().ok, true);
  assert.ok(confirmed.json().emailVerifiedAt);

  const row = await prisma.user.findUnique({ where: { id: DRIVER } });
  assert.ok(row?.emailVerifiedAt);
});

test('fail-closed: an unconfigured sender creates no redeemable row', async (t) => {
  if (!dbReachable) return t.diagnostic('database not reachable here — assertions skipped');
  await prisma.emailOtp.deleteMany({ where: { email: EMAIL, purpose: 'login' } });

  const res = await post(deadApp, '/api/auth/otp/email/request', { email: EMAIL });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().ok, true);
  assert.equal(res.json().resendAfterSeconds, 60);

  const row = await prisma.emailOtp.findFirst({ where: { email: EMAIL, purpose: 'login' } });
  assert.equal(row, null, 'nothing was created because nothing can be delivered');

  const status = await deadApp.inject({ method: 'GET', url: '/api/auth/otp/email/status' });
  assert.equal(status.statusCode, 200);
  assert.equal(status.json().configured, false);
});
