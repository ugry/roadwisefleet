/**
 * Password hashing for the pilot — `node:crypto` scrypt, no external deps.
 *
 * Stored format (a single `passwordHash` column, no schema change):
 *
 *   scrypt$<N>$<r>$<p>$<saltBase64>$<hashBase64>
 *
 * The parameters travel with the hash so they can be raised later without
 * invalidating existing hashes. Verification is constant-time.
 *
 * Pure ESM + JSDoc types so it is unit-testable with `node --test` (no build,
 * no install) and consumable from the TypeScript routes/seed via `allowJs`.
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/** @type {number} */
export const SCRYPT_N = 16384;
/** @type {number} */
export const SCRYPT_R = 8;
/** @type {number} */
export const SCRYPT_P = 1;
/** @type {number} */
export const SCRYPT_KEYLEN = 32;
/** @type {number} */
export const SALT_BYTES = 16;
const MAXMEM = 64 * 1024 * 1024; // 128*N*r needs ~16 MiB; headroom for N=32768+

/**
 * Derive a scrypt key.
 * @param {string} password
 * @param {Buffer} salt
 * @param {number} N
 * @param {number} r
 * @param {number} p
 * @returns {Buffer}
 */
function derive(password, salt, N, r, p) {
  return scryptSync(password, salt, SCRYPT_KEYLEN, { N, r, p, maxmem: MAXMEM });
}

/**
 * Hash a plaintext password.
 * @param {string} password
 * @returns {string}
 */
export function hashPassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new TypeError('password must be a non-empty string');
  }
  const salt = randomBytes(SALT_BYTES);
  const hash = derive(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64'),
    hash.toString('base64'),
  ].join('$');
}

/**
 * Constant-time verify a plaintext password against a stored hash.
 * Returns false for malformed stored values instead of throwing.
 * @param {string} password
 * @param {string | null | undefined} stored
 * @returns {boolean}
 */
export function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[4], 'base64');
    expected = Buffer.from(parts[5], 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;
  let actual;
  try {
    actual = derive(password, salt, N, r, p);
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
