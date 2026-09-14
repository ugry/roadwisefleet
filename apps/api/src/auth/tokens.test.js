import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_TTL_SECONDS, bearerToken, signToken, verifyToken } from './tokens.js';

const SECRET = 'test-secret';
const NOW = 1_700_000_000;

test('signToken/verifyToken round-trips the claims', () => {
  const token = signToken({ sub: 'u1', org: 'o1', role: 'driver', name: 'Dee' }, SECRET, { now: NOW });
  const payload = verifyToken(token, SECRET, { now: NOW + 60 });
  assert.ok(payload);
  assert.equal(payload.sub, 'u1');
  assert.equal(payload.org, 'o1');
  assert.equal(payload.role, 'driver');
  assert.equal(payload.name, 'Dee');
  assert.equal(payload.iat, NOW);
  assert.equal(payload.exp, NOW + DEFAULT_TTL_SECONDS);
});

test('verifyToken rejects a tampered payload', () => {
  const token = signToken({ sub: 'u1' }, SECRET, { now: NOW });
  const [header, , signature] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ sub: 'admin', exp: NOW + 999 })).toString('base64url');
  assert.equal(verifyToken(`${header}.${forged}.${signature}`, SECRET, { now: NOW }), null);
});

test('verifyToken rejects a wrong secret and malformed tokens', () => {
  const token = signToken({ sub: 'u1' }, SECRET, { now: NOW });
  assert.equal(verifyToken(token, 'other-secret', { now: NOW }), null);
  assert.equal(verifyToken('', SECRET, { now: NOW }), null);
  assert.equal(verifyToken('a.b', SECRET, { now: NOW }), null);
  assert.equal(verifyToken('a.b.c.d', SECRET, { now: NOW }), null);
  assert.equal(verifyToken(/** @type {any} */ (null), SECRET, { now: NOW }), null);
});

test('verifyToken rejects an expired token', () => {
  const token = signToken({ sub: 'u1' }, SECRET, { now: NOW, ttlSeconds: 10 });
  assert.equal(verifyToken(token, SECRET, { now: NOW + 11 }), null);
  assert.ok(verifyToken(token, SECRET, { now: NOW + 9 }));
});

test('signToken validates its inputs', () => {
  assert.throws(() => signToken(/** @type {any} */ ({}), SECRET), TypeError);
  assert.throws(() => signToken({ sub: 'u1' }, ''), TypeError);
});

test('bearerToken extracts only well-formed bearer headers', () => {
  assert.equal(bearerToken('Bearer abc.def.ghi'), 'abc.def.ghi');
  assert.equal(bearerToken('bearer abc'), 'abc');
  assert.equal(bearerToken('Token abc'), null);
  assert.equal(bearerToken(undefined), null);
  assert.equal(bearerToken(42), null);
});
