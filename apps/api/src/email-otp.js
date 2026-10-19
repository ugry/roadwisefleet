/**
 * Email one-time codes (board task #125): the pure core.
 *
 * A 6-digit code is generated server-side, stored ONLY as an HMAC keyed from
 * AUTH_SECRET (never plaintext, so a database dump cannot be replayed), and is
 * single-use with a short TTL and a hard attempt cap. The same code service
 * backs both surfaces:
 *
 *   - `login`  — passwordless sign-in for an existing account (recovery code);
 *   - `verify` — email confirmation for signup / account verification.
 *
 * The two purposes are bound into the HMAC input, so a code minted for one
 * purpose can never be redeemed for the other.
 *
 * Deliberately dependency-free (only `node:crypto`) so the no-install CI job
 * (`node --test apps/api/src/`) pins every rule; the route injects the clock and
 * the RNG, so expiry/attempt boundaries are deterministic in tests.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Digits in a code. */
export const OTP_LENGTH = 6;
/** Codes live ten minutes (the app's copy and the email both say so). */
export const OTP_TTL_SECONDS = 10 * 60;
/** Wrong guesses allowed before the code is burned. */
export const OTP_MAX_ATTEMPTS = 5;
/** Minimum gap between two sends to the same address (the app's resend timer). */
export const OTP_RESEND_SECONDS = 60;

export const PURPOSE_LOGIN = 'login';
export const PURPOSE_VERIFY = 'verify';

/** Purposes a code may be minted for. Anything else is a programming error. */
export const PURPOSES = Object.freeze([PURPOSE_LOGIN, PURPOSE_VERIFY]);

/**
 * Normalise an address the same way `POST /api/auth/login` does, so a code
 * requested for `Driver@Example.com` verifies as `driver@example.com`.
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * A deliberately loose shape check. The database is the authority on whether an
 * account exists; this only keeps obvious junk (and header-injection attempts)
 * out of the mail path.
 * @param {unknown} value
 */
export function isValidEmail(value) {
  const email = normalizeEmail(value);
  if (email.length === 0 || email.length > 254) return false;
  if (/[\r\n]/.test(email)) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * A zero-padded numeric code. `randomInt` is injectable (the route passes
 * `crypto.randomInt`) so tests can pin the value; the default is `Math.random`
 * purely so the module stays dependency-free for a caller that forgets.
 *
 * @param {{ randomInt?: (maxExclusive: number) => number }} [options]
 * @returns {string}
 */
export function generateCode(options = {}) {
  const pick = typeof options.randomInt === 'function' ? options.randomInt : (max) => Math.floor(Math.random() * max);
  let value = 0;
  for (let i = 0; i < OTP_LENGTH; i += 1) {
    // One digit at a time: a single uniform draw over 10^6 is fine too, but
    // per-digit keeps the injected RNG's contract trivial (0 <= r < 10).
    const digit = pick(10);
    value = value * 10 + (Number.isInteger(digit) && digit >= 0 && digit < 10 ? digit : 0);
  }
  // value < 10^6 by construction, so padStart alone yields exactly 6 digits.
  return String(value).padStart(OTP_LENGTH, '0');
}

/**
 * The stored form of a code. Bound to purpose + email so a leaked hash from one
 * row cannot be replayed for another account or another purpose.
 *
 * @param {{ code: string, email: string, purpose: string, secret: string }} args
 * @returns {string} hex HMAC
 */
export function hashCode({ code, email, purpose, secret }) {
  if (!secret) throw new Error('email-otp: AUTH_SECRET is required to hash a code');
  const key = createHmac('sha256', String(secret)).update('roadwisefleet/email-otp/v1').digest();
  return createHmac('sha256', key)
    .update(`${purpose}:${normalizeEmail(email)}:${String(code)}`)
    .digest('hex');
}

/**
 * Constant-time comparison of a submitted code against a stored hash.
 * @param {{ code: string, email: string, purpose: string, hash: string | null | undefined, secret: string }} args
 */
export function codeMatches({ code, email, purpose, hash, secret }) {
  if (!hash) return false;
  const candidate = Buffer.from(hashCode({ code, email, purpose, secret }), 'hex');
  const stored = Buffer.from(String(hash), 'hex');
  if (candidate.length !== stored.length) return false;
  return timingSafeEqual(candidate, stored);
}

/**
 * @param {Date} now
 * @param {number} [ttlSeconds]
 * @returns {Date}
 */
export function expiryFor(now, ttlSeconds = OTP_TTL_SECONDS) {
  return new Date(now.getTime() + ttlSeconds * 1000);
}

/**
 * Whether a stored code may still be attempted.
 *
 * @param {{ hash?: string | null, expiresAt?: Date | string | null, attempts?: number | null, now?: Date }} args
 * @returns {{ ok: true } | { ok: false, error: 'otp_not_started' | 'otp_expired' | 'otp_locked' }}
 */
export function gate({ hash, expiresAt, attempts, now = new Date() } = {}) {
  if (!hash || !expiresAt) return { ok: false, error: 'otp_not_started' };
  if (Number(attempts || 0) >= OTP_MAX_ATTEMPTS) return { ok: false, error: 'otp_locked' };
  const expires = expiresAt instanceof Date ? expiresAt : new Date(String(expiresAt));
  if (Number.isNaN(expires.getTime())) return { ok: false, error: 'otp_expired' };
  if (expires.getTime() <= now.getTime()) return { ok: false, error: 'otp_expired' };
  return { ok: true };
}

/**
 * Seconds until a new code may be sent to this address (0 when it may).
 * @param {{ createdAt?: Date | string | null, now?: Date, resendSeconds?: number }} args
 */
export function resendWaitSeconds({ createdAt, now = new Date(), resendSeconds = OTP_RESEND_SECONDS } = {}) {
  if (!createdAt) return 0;
  const created = createdAt instanceof Date ? createdAt : new Date(String(createdAt));
  if (Number.isNaN(created.getTime())) return 0;
  const elapsed = (now.getTime() - created.getTime()) / 1000;
  return elapsed >= resendSeconds ? 0 : Math.max(1, Math.ceil(resendSeconds - elapsed));
}

/**
 * The next attempt counter and whether this failure burns the code. Keeping it
 * here (not in the route) means the cap is pinned by a unit test.
 * @param {number | null | undefined} attempts
 * @returns {{ attempts: number, exhausted: boolean }}
 */
export function nextAttempt(attempts) {
  const next = Number(attempts || 0) + 1;
  return { attempts: next, exhausted: next >= OTP_MAX_ATTEMPTS };
}

/** Purpose guard for route input; unknown purposes are refused, never guessed. */
export function isPurpose(value) {
  return typeof value === 'string' && PURPOSES.includes(value);
}
