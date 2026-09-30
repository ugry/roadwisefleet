/**
 * Rate limiter (board task #86) — dependency-free coverage for
 * `src/rate-limit.js`, the fixed-window guard in front of `POST /api/auth/register`.
 *
 * Runs under the no-install CI job; the clock is injected so the window boundary
 * is deterministic. The HTTP wiring (429 + `retry-after`) is asserted in
 * `apps/api/test/register-router.test.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createRateLimiter } from './rate-limit.js';

/** A millisecond clock the test advances by hand. */
function fakeClock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms) => { now += ms; } };
}

test('the first max requests in a window pass, the next one is refused', () => {
  const clock = fakeClock();
  const limiter = createRateLimiter({ windowMs: 60_000, max: 3, now: clock.now });

  assert.deepEqual(limiter.check('ip').allowed, true);
  assert.equal(limiter.check('ip').allowed, true);
  assert.equal(limiter.check('ip').allowed, true);
  const refused = limiter.check('ip');
  assert.equal(refused.allowed, false);
  assert.equal(refused.remaining, 0);
  assert.ok(refused.retryAfterSeconds >= 1, 'a refusal tells the caller when to retry');
});

test('remaining counts down and is never negative', () => {
  const limiter = createRateLimiter({ windowMs: 1000, max: 2 });
  assert.equal(limiter.check('a').remaining, 1);
  assert.equal(limiter.check('a').remaining, 0);
  assert.equal(limiter.check('a').remaining, 0);
});

test('a new window resets the counter', () => {
  const clock = fakeClock();
  const limiter = createRateLimiter({ windowMs: 1000, max: 1, now: clock.now });
  assert.equal(limiter.check('ip').allowed, true);
  assert.equal(limiter.check('ip').allowed, false);
  clock.advance(1000);
  assert.equal(limiter.check('ip').allowed, true, 'the window has rolled over');
});

test('retryAfterSeconds is bounded by the window end', () => {
  const clock = fakeClock();
  const limiter = createRateLimiter({ windowMs: 10_000, max: 1, now: clock.now });
  limiter.check('ip');
  const refused = limiter.check('ip');
  assert.equal(refused.retryAfterSeconds, 10);
  clock.advance(4000);
  assert.equal(limiter.check('ip').retryAfterSeconds, 6);
});

test('keys are independent', () => {
  const limiter = createRateLimiter({ windowMs: 1000, max: 1 });
  assert.equal(limiter.check('1.1.1.1').allowed, true);
  assert.equal(limiter.check('1.1.1.1').allowed, false);
  assert.equal(limiter.check('2.2.2.2').allowed, true, 'a different client has its own window');
  assert.equal(limiter.size(), 2);
});

test('an empty or non-string key is bucketed as "unknown", never crashing', () => {
  const limiter = createRateLimiter({ windowMs: 1000, max: 1 });
  assert.equal(limiter.check('').allowed, true);
  assert.equal(limiter.check('').allowed, false);
  assert.equal(limiter.check(undefined).allowed, false);
  assert.equal(limiter.size(), 1);
});

test('the tracked windows stay bounded', () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 5, maxKeys: 3 });
  for (const key of ['a', 'b', 'c', 'd', 'e']) limiter.check(key);
  assert.ok(limiter.size() <= 3, `expected at most 3 windows, saw ${limiter.size()}`);
});

test('expired windows are dropped from the map', () => {
  const clock = fakeClock();
  const limiter = createRateLimiter({ windowMs: 1000, max: 5, now: clock.now });
  limiter.check('a');
  limiter.check('b');
  assert.equal(limiter.size(), 2);
  clock.advance(1001);
  limiter.check('c');
  assert.equal(limiter.size(), 1, 'a and b were pruned');
});

test('reset forgets every window', () => {
  const limiter = createRateLimiter({ windowMs: 1000, max: 1 });
  limiter.check('a');
  assert.equal(limiter.check('a').allowed, false);
  limiter.reset();
  assert.equal(limiter.check('a').allowed, true);
  assert.equal(limiter.size(), 1);
});

test('the defaults are the documented pilot bounds', () => {
  const limiter = createRateLimiter();
  // 10 per 15 minutes by default: the 10th passes, the 11th is refused.
  for (let i = 0; i < 10; i += 1) assert.equal(limiter.check('ip').allowed, true, `request ${i + 1}`);
  assert.equal(limiter.check('ip').allowed, false);
});
