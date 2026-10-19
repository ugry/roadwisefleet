/**
 * Email one-time codes — pure core tests (board task #125).
 *
 * Dependency-free (`node:test` + `node:assert` + `node:crypto`), so the
 * no-install CI job (`node --test apps/api/src/`) runs them on every PR.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OTP_LENGTH,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_SECONDS,
  OTP_TTL_SECONDS,
  PURPOSE_LOGIN,
  PURPOSE_VERIFY,
  codeMatches,
  expiryFor,
  gate,
  generateCode,
  hashCode,
  isPurpose,
  isValidEmail,
  nextAttempt,
  normalizeEmail,
  resendWaitSeconds,
} from './email-otp.js';

const SECRET = 'test-secret-not-a-real-one';

test('normalizeEmail trims and lowercases; rejects header injection', () => {
  assert.equal(normalizeEmail('  Driver@Example.COM '), 'driver@example.com');
  assert.equal(normalizeEmail(null), '');
  assert.equal(isValidEmail('driver@example.com'), true);
  assert.equal(isValidEmail('  DRIVER@EXAMPLE.COM '), true);
  assert.equal(isValidEmail('driver@example'), false);
  assert.equal(isValidEmail('driver example.com'), false);
  assert.equal(isValidEmail(''), false);
  assert.equal(isValidEmail('a@b.c\r\nBcc: evil@example.com'), false);
  assert.equal(isValidEmail('a@b.c\nBcc: evil@example.com'), false);
});

test('generateCode emits exactly six digits, zero-padded, from the injected RNG', () => {
  const zeros = generateCode({ randomInt: () => 0 });
  assert.equal(zeros, '000000');
  assert.equal(zeros.length, OTP_LENGTH);

  const nine = generateCode({ randomInt: () => 9 });
  assert.equal(nine, '999999');

  // A leading zero must survive: digits 0,1,2,3,4,5 -> 012345.
  const seq = [0, 1, 2, 3, 4, 5];
  let i = 0;
  const code = generateCode({ randomInt: () => seq[i++ % seq.length] });
  assert.equal(code, '012345');

  // A hostile RNG value can never escape the numeric contract.
  assert.match(generateCode({ randomInt: () => 42 }), /^\d{6}$/);
});

test('hashCode is deterministic, purpose- and address-bound, keyed by the secret', () => {
  const base = { code: '123456', email: 'driver@example.com', purpose: PURPOSE_LOGIN, secret: SECRET };
  assert.equal(hashCode(base), hashCode({ ...base }));
  assert.notEqual(hashCode(base), hashCode({ ...base, email: 'other@example.com' }));
  assert.notEqual(hashCode(base), hashCode({ ...base, purpose: PURPOSE_VERIFY }));
  assert.notEqual(hashCode(base), hashCode({ ...base, secret: 'another-secret' }));
  // Normalisation is applied, so a differently-cased request still matches.
  assert.equal(hashCode(base), hashCode({ ...base, email: '  DRIVER@example.com ' }));
  assert.match(hashCode(base), /^[0-9a-f]{64}$/);
});

test('hashCode refuses to run without a secret', () => {
  assert.throws(() => hashCode({ code: '1', email: 'a@b.co', purpose: PURPOSE_LOGIN, secret: '' }), /AUTH_SECRET/);
});

test('codeMatches is true only for the exact code, and false for a missing hash', () => {
  const args = { email: 'driver@example.com', purpose: PURPOSE_LOGIN, secret: SECRET };
  const hash = hashCode({ ...args, code: '123456' });
  assert.equal(codeMatches({ ...args, code: '123456', hash }), true);
  assert.equal(codeMatches({ ...args, code: '123457', hash }), false);
  assert.equal(codeMatches({ ...args, code: '123456', hash: null }), false);
  assert.equal(codeMatches({ ...args, code: '123456', hash: '' }), false);
  // A code minted for the other purpose can never be redeemed here.
  const verifyHash = hashCode({ ...args, code: '123456', purpose: PURPOSE_VERIFY });
  assert.equal(codeMatches({ ...args, code: '123456', hash: verifyHash }), false);
});

test('gate: not started, expired, locked, then ok', () => {
  const now = new Date('2026-10-19T12:00:00.000Z');
  assert.equal(gate({ now }).error, 'otp_not_started');
  assert.equal(gate({ hash: 'abc', now }).error, 'otp_not_started');
  assert.equal(gate({ hash: 'abc', expiresAt: '2026-10-19T11:59:00.000Z', attempts: 0, now }).error, 'otp_expired');
  // Expiry is exclusive: at exactly expiresAt the code is gone.
  assert.equal(gate({ hash: 'abc', expiresAt: '2026-10-19T12:00:00.000Z', attempts: 0, now }).error, 'otp_expired');
  assert.equal(
    gate({ hash: 'abc', expiresAt: '2026-10-19T12:10:00.000Z', attempts: OTP_MAX_ATTEMPTS, now }).error,
    'otp_locked',
  );
  assert.equal(gate({ hash: 'abc', expiresAt: '2026-10-19T12:10:00.000Z', attempts: 1, now }).ok, true);
});

test('expiryFor is exactly the TTL', () => {
  const now = new Date('2026-10-19T12:00:00.000Z');
  assert.equal(expiryFor(now).toISOString(), new Date(now.getTime() + OTP_TTL_SECONDS * 1000).toISOString());
  assert.equal(OTP_TTL_SECONDS, 600);
});

test('nextAttempt burns the code on the fifth wrong guess', () => {
  assert.deepEqual(nextAttempt(0), { attempts: 1, exhausted: false });
  assert.deepEqual(nextAttempt(OTP_MAX_ATTEMPTS - 2), { attempts: OTP_MAX_ATTEMPTS - 1, exhausted: false });
  assert.deepEqual(nextAttempt(OTP_MAX_ATTEMPTS - 1), { attempts: OTP_MAX_ATTEMPTS, exhausted: true });
  assert.deepEqual(nextAttempt(null), { attempts: 1, exhausted: false });
});

test('resendWaitSeconds enforces the send gap', () => {
  const now = new Date('2026-10-19T12:00:00.000Z');
  assert.equal(resendWaitSeconds({ now }), 0);
  assert.equal(resendWaitSeconds({ createdAt: now, now }), OTP_RESEND_SECONDS);
  assert.equal(resendWaitSeconds({ createdAt: '2026-10-19T11:59:30.000Z', now }), 30);
  assert.equal(resendWaitSeconds({ createdAt: '2026-10-19T11:59:00.000Z', now }), 0);
  // A sub-second remainder rounds up. A code created 0.6 s ago still has
  // 59.4 s to go, so the app must not enable the resend button early.
  assert.equal(resendWaitSeconds({ createdAt: '2026-10-19T11:59:59.400Z', now }), 60);
});

test('purposes are a closed set', () => {
  assert.equal(isPurpose('login'), true);
  assert.equal(isPurpose('verify'), true);
  assert.equal(isPurpose('reset'), false);
  assert.equal(isPurpose(undefined), false);
});
