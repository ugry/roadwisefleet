import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign, randomBytes } from 'node:crypto';

import {
  DEVICE_ALGORITHM,
  DEFAULT_CHALLENGE_TTL_SECONDS,
  algorithmSupported,
  challengeUsable,
  createChallenge,
  normalizePublicKey,
  normalizeRegistration,
  verifyDeviceSignature,
} from './device-auth.js';

/**
 * Unit tests for the passwordless device-auth core (board task #104, AND1-A2).
 * Runs on the Node.js native test runner with zero install (`node:crypto` is a
 * builtin), so the pure rules are covered even though the Android Keystore
 * client needs a device. The DB-backed half is
 * `../test/device-auth.test.ts` (`pnpm test:router`).
 */

const P256 = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const SPKI_B64 = P256.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

/** Sign the UTF-8 bytes of `nonce` exactly as the Android client does. */
function signNonce(nonce, privateKey = P256.privateKey) {
  return cryptoSign('sha256', Buffer.from(nonce, 'utf8'), privateKey).toString('base64');
}

test('normalizePublicKey accepts a P-256 SPKI key and canonicalises it', () => {
  assert.equal(normalizePublicKey(SPKI_B64), SPKI_B64);
  // A URL-safe copy decodes to the same key and is re-emitted as standard base64.
  const urlsafe = SPKI_B64.replace(/\+/g, '-').replace(/\//g, '_');
  assert.equal(normalizePublicKey(urlsafe), SPKI_B64);
  assert.equal(normalizePublicKey(`  ${SPKI_B64}  `), SPKI_B64);
});

test('normalizePublicKey rejects non-key input', () => {
  for (const bad of [null, undefined, 42, {}, '', '   ', 'not base64!', Buffer.from('hello').toString('base64')]) {
    assert.equal(normalizePublicKey(bad), null, `${String(bad)} must be refused`);
  }
  // A valid key of another type (Ed25519) is not an EC key.
  const ed = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  assert.equal(normalizePublicKey(ed), null, 'only EC keys are device credentials');
});

test('normalizeRegistration applies the ES256 default and trims the label', () => {
  const ok = normalizeRegistration({ publicKey: SPKI_B64, deviceLabel: '  Pixel 8  ' });
  assert.deepEqual(ok, { ok: true, value: { algorithm: DEVICE_ALGORITHM, publicKey: SPKI_B64, deviceLabel: 'Pixel 8' } });

  const noLabel = normalizeRegistration({ publicKey: SPKI_B64 });
  assert.equal(noLabel.ok, true);
  if (noLabel.ok) assert.equal(noLabel.value.deviceLabel, null);
});

test('normalizeRegistration refuses bad keys, algorithms and labels', () => {
  assert.equal(normalizeRegistration({ publicKey: 'nope' }).error, 'invalid_public_key');
  assert.equal(normalizeRegistration({ publicKey: SPKI_B64, algorithm: 'RS256' }).error, 'unsupported_algorithm');
  assert.equal(normalizeRegistration({ publicKey: SPKI_B64, deviceLabel: 42 }).error, 'invalid_input');
  assert.equal(normalizeRegistration({ publicKey: SPKI_B64, deviceLabel: 'x'.repeat(200) }).error, 'invalid_input');
  assert.equal(normalizeRegistration(null).error, 'invalid_input');
});

test('createChallenge is deterministic with an injected rng/clock and is single-use sized', () => {
  const fixed = Buffer.alloc(32, 7);
  const { nonce, expiresAt } = createChallenge({
    now: 1_700_000_000_000,
    ttlSeconds: 120,
    randomBytes: () => fixed,
  });
  assert.equal(nonce, fixed.toString('base64'));
  assert.equal(expiresAt.toISOString(), new Date(1_700_000_000_000 + 120_000).toISOString());

  const real = createChallenge({ randomBytes });
  assert.equal(Buffer.from(real.nonce, 'base64').length, 32);
  assert.ok(real.expiresAt.getTime() > Date.now());
  assert.equal(DEFAULT_CHALLENGE_TTL_SECONDS, 120);
});

test('challengeUsable enforces single-use and the expiry', () => {
  const now = 1_700_000_000_000;
  const fresh = { usedAt: null, expiresAt: new Date(now + 1000) };
  assert.equal(challengeUsable(fresh, now), true);
  assert.equal(challengeUsable({ ...fresh, usedAt: new Date(now - 1) }, now), false, 'used is refused');
  assert.equal(challengeUsable({ ...fresh, expiresAt: new Date(now) }, now), false, 'expiry is exclusive');
  assert.equal(challengeUsable(null, now), false);
});

test('verifyDeviceSignature accepts the matching key/signature and rejects everything else', () => {
  const nonce = Buffer.from(randomBytes(32)).toString('base64');
  const signature = signNonce(nonce);

  assert.equal(verifyDeviceSignature({ publicKey: SPKI_B64, nonce, signature }), true);

  assert.equal(
    verifyDeviceSignature({ publicKey: SPKI_B64, nonce: `${nonce}x`, signature }),
    false,
    'a different nonce must fail',
  );
  assert.equal(
    verifyDeviceSignature({ publicKey: SPKI_B64, nonce, signature: signNonce(`${nonce}x`) }),
    false,
    'a signature over other bytes must fail',
  );

  const tampered = Buffer.from(signature, 'base64');
  tampered[0] ^= 0xff;
  assert.equal(verifyDeviceSignature({ publicKey: SPKI_B64, nonce, signature: tampered.toString('base64') }), false);

  // A second device's key must not verify the first device's signature.
  const other = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const otherSpki = other.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  assert.equal(verifyDeviceSignature({ publicKey: otherSpki, nonce, signature }), false);

  // Malformed input never throws.
  for (const bad of [
    {},
    { publicKey: 'x', nonce, signature },
    { publicKey: SPKI_B64, nonce, signature: '!!!' },
    { publicKey: SPKI_B64, nonce: '', signature },
    { publicKey: SPKI_B64, algorithm: 'HS256', nonce, signature },
  ]) {
    assert.equal(verifyDeviceSignature(bad), false);
  }
});

test('algorithmSupported accepts only ES256', () => {
  assert.equal(algorithmSupported('ES256'), true);
  assert.equal(algorithmSupported('es256'), true);
  assert.equal(algorithmSupported('RS256'), false);
  assert.equal(algorithmSupported(undefined), false);
});
