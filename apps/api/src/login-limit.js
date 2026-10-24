/**
 * The `POST /api/auth/login` rate limiter (board task #130, QA #128 finding O1).
 *
 * Why this exists: before this module the only 429 source for login was the
 * nginx edge zone (`rwf_api`, 30 r/s per IP), so password spraying across many
 * addresses was bounded only per IP — and the per-account lockout (5 failed
 * attempts / 15 min) is remotely triggerable for ANY known address, which is an
 * availability trade-off an attacker can use against a real user. A route-level
 * window keyed on **the address being tried + the real client IP** narrows both:
 *
 * - spraying one address from one client is capped at `max` attempts per window;
 * - another person's address keeps its own budget (a spray never spends it);
 * - the per-account lockout is untouched — this is an ADDITIONAL bound, not a
 *   replacement (`routes/auth.ts` still returns 423 for a locked account).
 *
 * The window is deliberately short (5 minutes by default) so a person retyping
 * a password is never locked out for long.
 *
 * Pure ESM + JSDoc types, no Fastify/Prisma import: unit-testable with the
 * no-install `node --test` job and an injected clock. The key builder and the
 * limiter are the whole contract; `routes/auth.ts` only calls `check()`.
 */
import { createRateLimiter } from './rate-limit.js';

/** 10 attempts per 5 minutes per (email, client IP). */
export const LOGIN_LIMIT_DEFAULT_MAX = 10;
export const LOGIN_LIMIT_DEFAULT_WINDOW_MS = 5 * 60 * 1000;

/**
 * RFC 5321 caps a path at 256 octets; 320 is the usual practical limit for an
 * address. The key is bounded so a caller cannot grow the in-memory map with a
 * megabyte-long "email" (each distinct key would otherwise be stored whole).
 */
export const LOGIN_LIMIT_MAX_EMAIL_LENGTH = 320;

/**
 * The address as the login handler compares it: trimmed and lower-cased, so
 * `Ada@Example.com ` and `ada@example.com` share one budget instead of handing
 * an attacker a case-shifted bypass. Bounded to the address limit above.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeLoginEmail(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase().slice(0, LOGIN_LIMIT_MAX_EMAIL_LENGTH);
}

/**
 * The limiter key: the real client IP first (it can never contain the
 * separator), then the normalized address. An empty address still gets a key —
 * a body without an `email` must not mint a fresh bucket per request — and it
 * is scoped to the client, like every other key.
 *
 * @param {unknown} email
 * @param {unknown} clientIp
 * @returns {string}
 */
export function loginLimitKey(email, clientIp) {
  const ip = typeof clientIp === 'string' && clientIp.trim() ? clientIp.trim() : 'unknown';
  return `${ip}|${normalizeLoginEmail(email)}`;
}

/**
 * A limiter whose `check(email, clientIp)` counts one attempt against the
 * (address, client) window and answers the same shape as `rate-limit.js`.
 *
 * @param {{ max?: number, windowMs?: number, now?: () => number, maxKeys?: number }} [options]
 * @returns {{
 *   check: (email: unknown, clientIp: unknown) => { allowed: boolean, remaining: number, retryAfterSeconds: number, resetAt: number },
 *   size: () => number,
 *   reset: () => void,
 * }}
 */
export function createLoginLimiter(options = {}) {
  const windowMs =
    typeof options.windowMs === 'number' && options.windowMs > 0
      ? options.windowMs
      : LOGIN_LIMIT_DEFAULT_WINDOW_MS;
  const limiter = createRateLimiter({
    windowMs,
    max: typeof options.max === 'number' ? options.max : LOGIN_LIMIT_DEFAULT_MAX,
    now: options.now,
    maxKeys: options.maxKeys,
  });

  return {
    /** Count one login attempt for this (address, client) pair. */
    check(email, clientIp) {
      return limiter.check(loginLimitKey(email, clientIp));
    },
    /** How many windows are tracked (test/inspection hook). */
    size() {
      return limiter.size();
    },
    /** Forget every window (test hook). */
    reset() {
      limiter.reset();
    },
  };
}
