/**
 * Client-IP resolution for the register limiter (PR #78 review, P1).
 *
 * Dependency-free: `node --test src/` runs this with no install.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { isLoopback, resolveClientIp } from './client-ip.js';

test('isLoopback recognises IPv4, ::1 and IPv4-mapped loopback', () => {
  assert.equal(isLoopback('127.0.0.1'), true);
  assert.equal(isLoopback('127.9.8.7'), true);
  assert.equal(isLoopback('::1'), true);
  assert.equal(isLoopback('::ffff:127.0.0.1'), true);
  assert.equal(isLoopback('10.0.0.1'), false);
  assert.equal(isLoopback('::ffff:203.0.113.7'), false);
  assert.equal(isLoopback(''), false);
  assert.equal(isLoopback(undefined), false);
});

test('a non-loopback peer is the truth and proxy headers are ignored', () => {
  const ip = resolveClientIp({
    socket: { remoteAddress: '203.0.113.7' },
    headers: { 'x-real-ip': '198.51.100.9', 'x-forwarded-for': '10.0.0.1' },
  });
  assert.equal(ip, '203.0.113.7');
});

test('behind a loopback peer X-Real-IP wins', () => {
  const ip = resolveClientIp({
    socket: { remoteAddress: '127.0.0.1' },
    headers: { 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '1.2.3.4' },
  });
  assert.equal(ip, '203.0.113.7');
});

test('without X-Real-IP the LAST X-Forwarded-For hop is used', () => {
  // nginx appends the real client; earlier hops are caller-controlled.
  const ip = resolveClientIp({
    socket: { remoteAddress: '::ffff:127.0.0.1' },
    headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.7' },
  });
  assert.equal(ip, '203.0.113.7');
});

test('two proxied clients never resolve to the same key', () => {
  const a = resolveClientIp({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-real-ip': '203.0.113.7' } });
  const b = resolveClientIp({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-real-ip': '198.51.100.9' } });
  assert.notEqual(a, b);
  assert.notEqual(a, '127.0.0.1');
});

test('a loopback request with no proxy headers falls back to the peer', () => {
  assert.equal(resolveClientIp({ socket: { remoteAddress: '127.0.0.1' }, headers: {} }), '127.0.0.1');
});

test('a request with no address at all is "unknown"', () => {
  assert.equal(resolveClientIp({}), 'unknown');
  assert.equal(resolveClientIp(undefined), 'unknown');
});
