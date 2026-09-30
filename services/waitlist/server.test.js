'use strict';
/*
 * Waitlist limiter tests (board #45 / FAv1-OPS2).
 *
 * Dependency-free `node:test` suite, run in CI by the `api-tests` job:
 *   node --test services/waitlist/
 *
 * The regression this locks down: the limiter used to key on
 * `req.socket.remoteAddress`, which behind nginx is always 127.0.0.1, so all
 * visitors shared one 5-per-hour bucket. The end-to-end test below is the
 * "two different client IPs with independent buckets" demonstration the
 * task's acceptance criteria ask for, run against the real handler.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createWaitlistServer,
  resolveClientIp,
  isLoopback,
  RateLimiter,
  MAX_PER_WINDOW,
} = require('./server.js');

/** Minimal fake of the parts of a request the resolver reads. */
function fakeReq(peer, headers = {}) {
  return { socket: { remoteAddress: peer }, headers };
}

test('isLoopback recognises v4 loopback, ::1 and the v4-mapped form', () => {
  assert.equal(isLoopback('127.0.0.1'), true);
  assert.equal(isLoopback('127.0.0.9'), true);
  assert.equal(isLoopback('::1'), true);
  assert.equal(isLoopback('::ffff:127.0.0.1'), true);
  assert.equal(isLoopback('10.0.0.5'), false);
  assert.equal(isLoopback('51.222.139.227'), false);
  assert.equal(isLoopback(''), false);
  assert.equal(isLoopback(undefined), false);
});

test('resolveClientIp: a non-loopback peer never gets to spoof its address', () => {
  const req = fakeReq('203.0.113.7', {
    'x-real-ip': '198.51.100.1',
    'x-forwarded-for': '198.51.100.1, 203.0.113.7',
  });
  assert.equal(resolveClientIp(req), '203.0.113.7');
});

test('resolveClientIp: from our own nginx (loopback peer) X-Real-IP is the client', () => {
  assert.equal(resolveClientIp(fakeReq('127.0.0.1', { 'x-real-ip': '198.51.100.1' })), '198.51.100.1');
  assert.equal(resolveClientIp(fakeReq('::ffff:127.0.0.1', { 'x-real-ip': '198.51.100.2' })), '198.51.100.2');
});

test('resolveClientIp: XFF fallback trusts the hop our proxy appended, not the caller-supplied one', () => {
  assert.equal(
    resolveClientIp(fakeReq('127.0.0.1', { 'x-forwarded-for': '1.2.3.4, 198.51.100.9' })),
    '198.51.100.9',
  );
});

test('resolveClientIp: no proxy headers from a loopback peer falls back to the peer', () => {
  assert.equal(resolveClientIp(fakeReq('127.0.0.1')), '127.0.0.1');
});

test('RateLimiter: allows max per IP then denies, and buckets are per IP', () => {
  const limiter = new RateLimiter({ windowMs: 60_000, max: 5 });
  const now = 1_700_000_000_000;
  for (let i = 0; i < 5; i += 1) {
    assert.equal(limiter.check('198.51.100.1', now), false, `request ${i + 1} should pass`);
  }
  assert.equal(limiter.check('198.51.100.1', now), true, 'the 6th request is limited');
  // A different client is unaffected — this is the bug that was fixed.
  for (let i = 0; i < 5; i += 1) {
    assert.equal(limiter.check('198.51.100.2', now), false, 'other IP keeps its own bucket');
  }
  assert.equal(limiter.check('198.51.100.2', now), true);
});

test('RateLimiter: the window slides and prune drops quiet IPs', () => {
  const limiter = new RateLimiter({ windowMs: 1_000, max: 2, sweepEvery: 4 });
  assert.equal(limiter.check('a', 0), false);
  assert.equal(limiter.check('a', 1), false);
  assert.equal(limiter.check('a', 2), true);
  assert.equal(limiter.check('a', 1_001), false, 'first hit left the window');
  limiter.prune(10_000);
  assert.equal(limiter.hits.size, 0, 'idle keys are forgotten');
});

test('POST /api/waitlist: two client IPs have independent 5-per-hour buckets (regression)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rwf-waitlist-test-'));
  const dataFile = path.join(dir, 'waitlist.jsonl');
  const server = createWaitlistServer({ dataFile, tokenFile: path.join(dir, 'admin-token') });
  t.after(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const post = (ip, body = { email: 'signup@example.com' }) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/api/waitlist',
          headers: { 'content-type': 'application/json', 'x-real-ip': ip },
        },
        (res) => {
          let raw = '';
          res.on('data', (c) => { raw += c; });
          res.on('end', () => resolve({ status: res.statusCode, body: raw }));
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify(body));
    });

  for (let i = 0; i < MAX_PER_WINDOW; i += 1) {
    const res = await post('198.51.100.1');
    assert.equal(res.status, 201, `visitor A signup ${i + 1} accepted`);
  }
  const limited = await post('198.51.100.1');
  assert.equal(limited.status, 429, 'visitor A is over its own bucket');
  assert.match(limited.body, /rate_limited/);

  const other = await post('198.51.100.2');
  assert.equal(other.status, 201, 'visitor B is NOT blocked by visitor A (the old global-bucket bug)');

  // The honeypot path returns before the limiter, so bots never consume a real
  // visitor's allowance.
  for (let i = 0; i < 10; i += 1) {
    const res = await post('198.51.100.3', { email: 'bot@example.com', company_website: 'spam' });
    assert.equal(res.status, 201);
  }
  assert.equal((await post('198.51.100.3')).status, 201, 'honeypot traffic does not rate-limit a human');
});
