/**
 * `POST /api/auth/login` rate limiting (board task #130, QA #128 finding O1).
 *
 * What must not drift:
 *   - the key is the address being tried PLUS the real client IP, so one client
 *     cannot spend someone else's budget and a spray across addresses is capped;
 *   - the window is short (5 minutes by default) and env-tunable;
 *   - the route refuses with the existing `429 { error: 'rate_limited',
 *     retryAfterSeconds }` shape the Android client maps to
 *     `auth.error.rateLimited`;
 *   - the 423 lockout and the 400/401 bodies are untouched.
 *
 * Dependency-free (no Fastify, no Prisma): runs in the no-install CI job. The
 * HTTP-level refusal is covered by `test/login-rate-limit.test.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LOGIN_LIMIT_DEFAULT_MAX,
  LOGIN_LIMIT_DEFAULT_WINDOW_MS,
  LOGIN_LIMIT_MAX_EMAIL_LENGTH,
  createLoginLimiter,
  loginLimitKey,
  normalizeLoginEmail,
} from './login-limit.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

// ---------------------------------------------------------------------------
// The key: (address, real client)
// ---------------------------------------------------------------------------

test('the key is the client IP followed by the normalized address', () => {
  assert.equal(loginLimitKey('Ada@Example.com', '203.0.113.9'), '203.0.113.9|ada@example.com');
  // Same person, same client, differently spelled: ONE budget.
  assert.equal(
    loginLimitKey('  ADA@example.com ', '203.0.113.9'),
    loginLimitKey('ada@example.com', '203.0.113.9'),
  );
});

test('different addresses from one client are different keys', () => {
  const ip = '203.0.113.9';
  assert.notEqual(loginLimitKey('ada@example.com', ip), loginLimitKey('bob@example.com', ip));
});

test('the same address from different clients is a different key', () => {
  const email = 'ada@example.com';
  assert.notEqual(loginLimitKey(email, '203.0.113.9'), loginLimitKey(email, '198.51.100.7'));
});

test('a missing address or client still yields a usable, bounded key', () => {
  // A body without an `email` must not mint a fresh bucket per request.
  assert.equal(loginLimitKey('', '203.0.113.9'), loginLimitKey(undefined, '203.0.113.9'));
  assert.equal(loginLimitKey('', '203.0.113.9'), '203.0.113.9|');
  // A caller cannot grow the in-memory map with an unbounded "email".
  const huge = 'x'.repeat(200_000);
  const key = loginLimitKey(huge, '203.0.113.9');
  assert.equal(key.length, '203.0.113.9|'.length + LOGIN_LIMIT_MAX_EMAIL_LENGTH);
  assert.equal(normalizeLoginEmail(huge).length, LOGIN_LIMIT_MAX_EMAIL_LENGTH);
  // Non-string bodies are treated as "no address", never as `[object Object]`.
  assert.equal(normalizeLoginEmail({ email: 'ada@example.com' }), '');
  assert.equal(loginLimitKey('ada@example.com', ''), loginLimitKey('ada@example.com', undefined));
});

// ---------------------------------------------------------------------------
// The window: under the limit passes, over the limit refuses
// ---------------------------------------------------------------------------

test('attempts under the limit pass, the one past it is refused with a retry hint', () => {
  const limiter = createLoginLimiter({ max: 3, windowMs: 5 * 60 * 1000 });
  const ip = '198.51.100.7';
  const email = 'ada@example.com';

  for (let i = 1; i <= 3; i += 1) {
    const gate = limiter.check(email, ip);
    assert.equal(gate.allowed, true, `attempt ${i} must pass`);
    assert.equal(gate.remaining, 3 - i);
    assert.equal(gate.retryAfterSeconds, 0);
  }

  const refused = limiter.check(email, ip);
  assert.equal(refused.allowed, false);
  assert.equal(refused.remaining, 0);
  assert.equal(refused.retryAfterSeconds, 300);
  // The refusal does not reset the window: a second attempt is refused too.
  assert.equal(limiter.check(email, ip).allowed, false);
});

test('each (address, client) pair has its own budget', () => {
  const limiter = createLoginLimiter({ max: 2, windowMs: 60 * 1000 });
  const ip = '198.51.100.7';
  const otherIp = '203.0.113.9';
  const email = 'ada@example.com';

  limiter.check(email, ip);
  limiter.check(email, ip);
  assert.equal(limiter.check(email, ip).allowed, false);

  // Another address from the same client still has its full budget: one
  // person's spray never locks out a colleague behind the same NAT.
  assert.equal(limiter.check('bob@example.com', ip).allowed, true);
  // The same address from another client is untouched: the account-level
  // lockout is the per-account bound, not this window.
  assert.equal(limiter.check(email, otherIp).allowed, true);
  assert.equal(limiter.size(), 3);
});

test('the window resets after the configured interval', () => {
  let now = 1_000_000;
  const limiter = createLoginLimiter({ max: 1, windowMs: 5 * 60 * 1000, now: () => now });
  const ip = '198.51.100.7';
  const email = 'ada@example.com';

  assert.equal(limiter.check(email, ip).allowed, true);
  const refused = limiter.check(email, ip);
  assert.equal(refused.allowed, false);
  assert.equal(refused.retryAfterSeconds, 300);

  now += 299_000;
  assert.equal(limiter.check(email, ip).allowed, false, 'still inside the window');

  now += 1_000; // exactly one window later
  assert.equal(limiter.check(email, ip).allowed, true, 'the window moved on');
});

test('the defaults are 10 attempts per 5 minutes', () => {
  // The route passes these through `env`, whose defaults must agree.
  assert.equal(LOGIN_LIMIT_DEFAULT_MAX, 10);
  assert.equal(LOGIN_LIMIT_DEFAULT_WINDOW_MS, 5 * 60 * 1000);

  const limiter = createLoginLimiter();
  const email = 'ada@example.com';
  for (let i = 1; i <= LOGIN_LIMIT_DEFAULT_MAX; i += 1) {
    assert.equal(limiter.check(email, '198.51.100.7').allowed, true, `attempt ${i}`);
  }
  const refused = limiter.check(email, '198.51.100.7');
  assert.equal(refused.allowed, false);
  assert.ok(
    refused.retryAfterSeconds > 0 && refused.retryAfterSeconds <= 300,
    `a legitimate retry waits seconds, not hours: ${refused.retryAfterSeconds}`,
  );
});

// ---------------------------------------------------------------------------
// The route wiring (drift guard)
// ---------------------------------------------------------------------------

test('the login route applies the limiter before the lookup and keeps the bodies', () => {
  const route = read('apps/api/src/routes/auth.ts');
  const start = route.indexOf("app.post('/auth/login'");
  assert.ok(start > -1, 'the login route must exist');
  const login = route.slice(start, route.indexOf("app.get('/auth/me'", start));
  assert.ok(login.length > 0, 'the login route slice must end at the next route');

  // Keyed on the address AND the resolved real client — never the shared
  // loopback peer that nginx forwards from.
  assert.match(login, /loginLimiter\.check\(email, resolveClientIp\(req\)\)/);
  assert.doesNotMatch(login, /loginLimiter\.check\(req\.ip/);
  assert.match(login, /error: 'rate_limited'/);
  assert.match(login, /reply\.header\('retry-after'/);
  assert.match(login, /reply\.code\(429\)/);

  // Refused before any database work.
  assert.ok(
    login.indexOf('loginLimiter.check(') < login.indexOf('prisma.user.findUnique('),
    'the limiter must run before the user lookup',
  );

  // The pre-existing semantics QA #128 asserts are untouched.
  assert.match(login, /reply\.code\(423\)\.send\(\{ error: 'account_locked' \}\)/);
  assert.match(login, /reply\.code\(400\)\.send\(\{ error: 'invalid_credentials' \}\)/);
  assert.match(login, /reply\.code\(401\)\.send\(\{ error: 'invalid_credentials' \}\)/);

  // Env-tunable, with the safe defaults documented in `env.ts`.
  const envFile = read('apps/api/src/env.ts');
  assert.match(envFile, /LOGIN_RATE_LIMIT_MAX: Number\(process\.env\.LOGIN_RATE_LIMIT_MAX \|\| 10\)/);
  assert.match(
    envFile,
    /LOGIN_RATE_LIMIT_WINDOW_SECONDS: Number\(process\.env\.LOGIN_RATE_LIMIT_WINDOW_SECONDS \|\| 5 \* 60\)/,
  );
});
