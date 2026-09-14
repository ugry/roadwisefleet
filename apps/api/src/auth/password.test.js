import test from 'node:test';
import assert from 'node:assert/strict';

import { hashPassword, verifyPassword } from './password.js';

test('hashPassword produces a scrypt-format hash with a random salt', () => {
  const a = hashPassword('correct horse battery staple');
  const b = hashPassword('correct horse battery staple');
  assert.match(a, /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.notEqual(a, b, 'two hashes of the same password must differ (random salt)');
});

test('verifyPassword accepts the right password and rejects the wrong one', () => {
  const stored = hashPassword('s3cret-pass');
  assert.equal(verifyPassword('s3cret-pass', stored), true);
  assert.equal(verifyPassword('s3cret-pas', stored), false);
  assert.equal(verifyPassword('', stored), false);
  assert.equal(verifyPassword('s3cret-pass ', stored), false);
});

test('verifyPassword handles unicode and long passwords', () => {
  const pw = 'şifre-🔐-' + 'x'.repeat(200);
  const stored = hashPassword(pw);
  assert.equal(verifyPassword(pw, stored), true);
  assert.equal(verifyPassword(pw.slice(0, -1), stored), false);
});

test('verifyPassword returns false for malformed or missing stored hashes', () => {
  for (const bad of [null, undefined, '', 'not-a-hash', 'scrypt$1$2$3$only-five-parts']) {
    assert.equal(verifyPassword('anything', bad), false);
  }
});

test('hashPassword rejects an empty password', () => {
  assert.throws(() => hashPassword(''), TypeError);
  assert.throws(() => hashPassword(/** @type {any} */ (null)), TypeError);
});
