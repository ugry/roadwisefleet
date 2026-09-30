/**
 * Self-service registration — HTTP-level guards (board task #86).
 *
 *   pnpm --filter @roadwisefleet/api test:router
 *
 * What this proves, without touching the database:
 *   - the shared validation (`app/lib/signup.js`, the SAME module the browser
 *     loads) refuses a bad body with 400, exactly one `field` and a catalogue
 *     `messageKey`;
 *   - the endpoint is rate-limited per client IP before validation or any query:
 *     the refusal is a 429 with `retry-after`, and even a malformed body gets the
 *     429 (so a flood can never reach the database);
 *   - the limiter is per-IP (a different client still gets its 400).
 *
 * The successful path (register → login → dashboard) is the DB-backed suite in
 * `registration.test.ts`; the limiter's window arithmetic is covered with an
 * injected clock in `../src/rate-limit.test.js`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// Must be set before `env.ts` is imported (it throws without AUTH_SECRET).
process.env.ALLOW_INSECURE_AUTH_SECRET = '1';
// A tiny bound so the refusal is deterministic in one window.
process.env.REGISTER_RATE_LIMIT_MAX = '3';
process.env.REGISTER_RATE_LIMIT_WINDOW_SECONDS = '900';

const { buildServer } = await import('../src/app.js');

const app = buildServer();
await app.ready();
test.after(() => app.close());

const VALID = {
  name: 'QA Register',
  company: 'QA Register GmbH',
  email: 'qa-register@roadwisefleet.test',
  password: 'qa-register-1',
};

/**
 * One client IP per case: the limiter is keyed by IP, so a case can never spend
 * another case's budget (and each case is independent of test order).
 */
let ipCounter = 0;
const nextIp = () => `10.1.0.${(ipCounter += 1)}`;

test('a rejected body is a 400 with one field and a catalogue message key', async () => {
  const cases: Array<[Record<string, unknown>, string, string]> = [
    [{ ...VALID, name: '   ' }, 'name', 'signup.error.nameRequired'],
    [{ ...VALID, email: '' }, 'email', 'signup.error.emailRequired'],
    [{ ...VALID, email: 'not-an-email' }, 'email', 'signup.error.emailInvalid'],
    [{ ...VALID, password: 'short' }, 'password', 'signup.error.passwordShort'],
    [{ ...VALID, password: 'x'.repeat(201) }, 'password', 'signup.error.passwordLong'],
  ];
  for (const [payload, field, messageKey] of cases) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload,
      remoteAddress: nextIp(),
    });
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
    const data = JSON.parse(res.payload);
    assert.deepEqual(
      { error: data.error, field: data.field, messageKey: data.messageKey },
      { error: 'invalid_input', field, messageKey },
    );
    assert.equal(typeof data.detail, 'string');
    assert.ok(!('token' in data), 'a refused registration never issues a session');
  }
});

test('a non-object body is refused the same way', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: '[]',
    headers: { 'content-type': 'application/json' },
    remoteAddress: nextIp(),
  });
  assert.equal(res.statusCode, 400);
  const data = JSON.parse(res.payload);
  assert.equal(data.messageKey, 'signup.error.formInvalid');
});

test('the public endpoint is rate-limited per client IP, before validation', async () => {
  const ip = '10.9.9.9';
  const bad = { ...VALID, password: 'x' };

  // The first three hits are counted even though every one is a 400.
  for (let i = 0; i < 3; i += 1) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: bad,
      remoteAddress: ip,
    });
    assert.equal(res.statusCode, 400, `request ${i + 1} is still under the limit`);
  }

  const refused = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: VALID,
    remoteAddress: ip,
  });
  assert.equal(refused.statusCode, 429);
  const data = JSON.parse(refused.payload);
  assert.equal(data.error, 'rate_limited');
  assert.ok(data.retryAfterSeconds >= 1, 'the refusal says when to try again');
  assert.equal(refused.headers['retry-after'], String(data.retryAfterSeconds));

  // The gate runs first: even a body that would fail validation is refused, so a
  // flood cannot reach the database.
  const malformed = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: {},
    remoteAddress: ip,
  });
  assert.equal(malformed.statusCode, 429);
});

test('another client has its own window', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { ...VALID, email: 'nope' },
    remoteAddress: '10.9.9.10',
  });
  assert.equal(res.statusCode, 400, 'the exhausted window belongs to the first IP only');
});
