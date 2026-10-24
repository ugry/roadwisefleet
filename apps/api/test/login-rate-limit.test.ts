/**
 * `POST /api/auth/login` — HTTP-level rate limiting (board task #130, QA #128
 * finding O1).
 *
 *   pnpm --filter @roadwisefleet/api test:router
 *
 * What this proves at the HTTP boundary (no database needed: the refusal and the
 * budget arithmetic happen before validation and before the lookup):
 *   - attempts under the limit still reach the handler (the unchanged 400 body);
 *   - the attempt past the limit is `429 { error: 'rate_limited',
 *     retryAfterSeconds }` with a `retry-after` header — the exact shape the
 *     Android client maps to `auth.error.rateLimited`;
 *   - a request that WOULD have hit the database is refused before it does;
 *   - the budget is per (address, client): another address keeps its own window,
 *     and the same address from another client keeps its own.
 *
 * The window arithmetic and the key builder are covered dependency-free in
 * `../src/login-limit.test.js`; a real login still working under the default
 * limit is covered by `registration.test.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// Must be set before `env.ts` is imported (it throws without AUTH_SECRET).
process.env.ALLOW_INSECURE_AUTH_SECRET = '1';
// A tiny bound so the refusal is deterministic inside one window.
process.env.LOGIN_RATE_LIMIT_MAX = '3';
process.env.LOGIN_RATE_LIMIT_WINDOW_SECONDS = '900';

const { buildServer } = await import('../src/app.js');

const app = buildServer();
await app.ready();
test.after(() => app.close());

const EMAIL = 'qa-login-limit@roadwisefleet.test';
const OTHER_EMAIL = 'qa-login-limit-other@roadwisefleet.test';
const IP = '10.2.0.1';
const OTHER_IP = '10.2.0.2';

/** One login attempt, exactly as the app sends it. */
function login(payload: Record<string, unknown>, remoteAddress: string) {
  return app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload,
    remoteAddress,
  });
}

test('attempts under the limit reach the handler, the one past it is a 429', async () => {
  // An empty password is a local 400 — it proves the request passed the limiter
  // and never touches the database, so the budget arithmetic is deterministic.
  for (let i = 1; i <= 3; i += 1) {
    const res = await login({ email: EMAIL, password: '' }, IP);
    assert.equal(res.statusCode, 400, `attempt ${i} must pass the limiter: ${res.payload}`);
    assert.deepEqual(JSON.parse(res.payload), { error: 'invalid_credentials' });
  }

  // The fourth attempt carries a password that WOULD reach the user lookup: it
  // must still be refused, before any database work.
  const refused = await login({ email: EMAIL, password: 'not-the-password-1' }, IP);
  assert.equal(refused.statusCode, 429, refused.payload);
  const body = JSON.parse(refused.payload);
  assert.deepEqual(Object.keys(body).sort(), ['error', 'retryAfterSeconds']);
  assert.equal(body.error, 'rate_limited');
  assert.equal(body.retryAfterSeconds, 900);
  assert.equal(refused.headers['retry-after'], '900');
  assert.ok(!('token' in body), 'a refused login never issues a session');

  // Still refused inside the same window.
  assert.equal((await login({ email: EMAIL, password: 'x' }, IP)).statusCode, 429);
});

test('a different address from the same client keeps its own budget', async () => {
  const res = await login({ email: OTHER_EMAIL, password: '' }, IP);
  assert.equal(res.statusCode, 400, `another address must not be spent: ${res.payload}`);
  assert.deepEqual(JSON.parse(res.payload), { error: 'invalid_credentials' });
});

test('the same address from another client keeps its own budget', async () => {
  const res = await login({ email: EMAIL, password: '' }, OTHER_IP);
  assert.equal(res.statusCode, 400, `another client must not be spent: ${res.payload}`);
  // The per-account lockout is a separate bound (5 failures / 15 min, `423`):
  // this window never replaces it, it only refuses earlier for THIS client.
  assert.deepEqual(JSON.parse(res.payload), { error: 'invalid_credentials' });
});
