/**
 * Passwordless Android device auth — the pure half (board task #104, AND1-A2).
 *
 * The owner direction: after the first Android login (password or phone OTP),
 * the app generates an **EC P-256 keypair in the Android Keystore** and
 * registers the public key; every later login is
 *
 *   POST /api/auth/device/challenge  -> a single-use nonce
 *   device signs the nonce
 *   POST /api/auth/device/verify     -> session token
 *
 * The private key never leaves the device and the server stores **public keys
 * only**. This module owns:
 *
 *   - public-key validation (`normalizePublicKey`): a value is accepted only if
 *     it decodes to an SPKI DER public key of type `ec`, so a random string can
 *     never be stored as a credential;
 *   - challenge creation (`createChallenge`, injectable RNG/clock) and the
 *     single-use/short-TTL usability rule (`challengeUsable`);
 *   - detached-signature verification (`verifyDeviceSignature`) via
 *     `node:crypto`, which performs the ECDSA check on the DER signature and
 *     never branches on the signature bytes;
 *   - request validation (`normalizeRegistration`).
 *
 * Deliberately dependency-free ESM (typed via JSDoc) so it is unit-testable with
 * the Node.js native test runner (`node --test`, zero install). `node:crypto`
 * is a builtin — the same import `auth/tokens.js` already uses in the no-install
 * CI job.
 */

import { createPublicKey, randomBytes, verify as cryptoVerify } from 'node:crypto';

/** The only accepted algorithm: ECDSA P-256 with SHA-256. */
export const DEVICE_ALGORITHM = 'ES256';
/** @type {readonly string[]} */
export const SUPPORTED_ALGORITHMS = Object.freeze([DEVICE_ALGORITHM]);
/** A leaked challenge nonce is useful only briefly; 2 minutes is plenty for one round-trip. */
export const DEFAULT_CHALLENGE_TTL_SECONDS = 120;
/** 32 random bytes = 256 bits of nonce entropy. */
export const CHALLENGE_BYTES = 32;
/** A device label is display-only, untrusted text. */
export const MAX_DEVICE_LABEL_LENGTH = 80;

/**
 * @param {unknown} algorithm
 * @returns {boolean}
 */
export function algorithmSupported(algorithm) {
  return typeof algorithm === 'string' && SUPPORTED_ALGORITHMS.includes(algorithm.toUpperCase());
}

/**
 * Decode standard or URL-safe base64, rejecting anything that is not base64.
 * `Buffer.from(x, 'base64')` silently ignores invalid characters, so the shape
 * is validated first.
 * @param {unknown} value
 * @returns {Buffer | null}
 */
function decodeBase64(value) {
  if (typeof value !== 'string') return null;
  const compact = value.trim().replace(/\s+/g, '');
  if (compact.length === 0) return null;
  const normalized = compact.replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) return null;
  const buffer = Buffer.from(normalized, 'base64');
  return buffer.length > 0 ? buffer : null;
}

/**
 * Parse a base64 SPKI public key and require it to be an EC key. Returns the
 * canonical (standard base64) form to store, or `null` when invalid.
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizePublicKey(value) {
  const der = decodeBase64(value);
  if (!der) return null;
  try {
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ec') return null;
    return der.toString('base64');
  } catch {
    return null;
  }
}

/**
 * Validate a device-registration body.
 * @param {unknown} body
 * @returns {{ ok: true, value: { algorithm: string, publicKey: string, deviceLabel: string | null } } | { ok: false, error: string, detail?: string }}
 */
export function normalizeRegistration(body) {
  if (body === null || typeof body !== 'object') {
    return { ok: false, error: 'invalid_input', detail: 'body must be an object' };
  }
  const b = /** @type {Record<string, unknown>} */ (body);
  const algorithm = String(b.algorithm ?? DEVICE_ALGORITHM).toUpperCase();
  if (!algorithmSupported(algorithm)) {
    return { ok: false, error: 'unsupported_algorithm' };
  }
  const publicKey = normalizePublicKey(b.publicKey);
  if (!publicKey) {
    return { ok: false, error: 'invalid_public_key' };
  }
  let deviceLabel = null;
  if (b.deviceLabel !== undefined && b.deviceLabel !== null && b.deviceLabel !== '') {
    if (typeof b.deviceLabel !== 'string') {
      return { ok: false, error: 'invalid_input', detail: 'deviceLabel must be a string' };
    }
    const trimmed = b.deviceLabel.trim();
    if (trimmed.length > MAX_DEVICE_LABEL_LENGTH) {
      return { ok: false, error: 'invalid_input', detail: 'deviceLabel is too long' };
    }
    deviceLabel = trimmed.length > 0 ? trimmed : null;
  }
  return { ok: true, value: { algorithm, publicKey, deviceLabel } };
}

/**
 * Create a single-use challenge nonce.
 * @param {{ ttlSeconds?: number, now?: number, randomBytes?: (size: number) => Buffer }} [options]
 * @returns {{ nonce: string, expiresAt: Date }}
 */
export function createChallenge(options = {}) {
  const ttlSeconds =
    Number.isFinite(options.ttlSeconds) && /** @type {number} */ (options.ttlSeconds) > 0
      ? Math.floor(/** @type {number} */ (options.ttlSeconds))
      : DEFAULT_CHALLENGE_TTL_SECONDS;
  const now = Number.isFinite(options.now) ? /** @type {number} */ (options.now) : Date.now();
  const rng = typeof options.randomBytes === 'function' ? options.randomBytes : randomBytes;
  const bytes = rng(CHALLENGE_BYTES);
  return { nonce: Buffer.from(bytes).toString('base64'), expiresAt: new Date(now + ttlSeconds * 1000) };
}

/**
 * A challenge is usable exactly once, before it expires. A used or expired
 * challenge can never open a session, even with a correct signature.
 * @param {{ usedAt?: Date | string | null, expiresAt?: Date | string | null } | null | undefined} challenge
 * @param {number} [now]
 * @returns {boolean}
 */
export function challengeUsable(challenge, now = Date.now()) {
  if (!challenge || typeof challenge !== 'object') return false;
  if (challenge.usedAt) return false;
  if (!challenge.expiresAt) return false;
  const expires = challenge.expiresAt instanceof Date ? challenge.expiresAt.getTime() : new Date(challenge.expiresAt).getTime();
  return Number.isFinite(expires) && expires > now;
}

/**
 * Verify a detached ECDSA signature over the UTF-8 bytes of `nonce`.
 *
 * Never throws on untrusted input; any malformed value is a plain `false`.
 * @param {{ publicKey?: unknown, algorithm?: unknown, nonce?: unknown, signature?: unknown }} [args]
 * @returns {boolean}
 */
export function verifyDeviceSignature(args = {}) {
  const algorithm = typeof args.algorithm === 'string' ? args.algorithm.toUpperCase() : DEVICE_ALGORITHM;
  if (!algorithmSupported(algorithm)) return false;
  if (typeof args.nonce !== 'string' || args.nonce.length === 0) return false;

  const der = decodeBase64(args.publicKey);
  if (!der) return false;
  const signature = decodeBase64(args.signature);
  if (!signature) return false;

  let key;
  try {
    key = createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch {
    return false;
  }
  try {
    // ES256 = ECDSA P-256 / SHA-256, DER-encoded signature. `crypto.verify`
    // performs the check against the key material; the code never compares
    // signature bytes itself, so there is no early-exit timing side channel.
    return cryptoVerify('sha256', Buffer.from(args.nonce, 'utf8'), { key, dsaEncoding: 'der' }, signature);
  } catch {
    return false;
  }
}
