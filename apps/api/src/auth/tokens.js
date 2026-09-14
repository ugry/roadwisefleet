/**
 * Minimal stateless session tokens for the pilot — an HMAC-SHA256 JWT-alike
 * built on `node:crypto`, no dependency.
 *
 *   base64url(header) . base64url(payload) . base64url(HMAC-SHA256)
 *
 * header = { alg: "HS256", typ: "JWT" }
 * payload carries `sub` (userId), `org`, `role`, `name`, `iat`, `exp`.
 *
 * There is no signup / email verification / password reset in the pilot, so a
 * signed token issued by `POST /api/auth/login` is the whole session story.
 * The server keeps no session table: verification is signature + expiry only.
 * Tokens are therefore revocable only by rotating `AUTH_SECRET` (acceptable
 * for a pre-email pilot; a server-side session store is a later phase).
 *
 * Pure ESM + JSDoc types: unit-testable with `node --test`, no build step.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

const HEADER = Object.freeze({ alg: 'HS256', typ: 'JWT' });
/** @type {number} */
export const DEFAULT_TTL_SECONDS = 12 * 60 * 60;

/**
 * @param {string} value
 * @returns {string}
 */
function b64url(value) {
  return Buffer.from(value, 'utf8').toString('base64url');
}

/**
 * @param {string} value
 * @returns {string}
 */
function b64urlJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/**
 * @param {string} data
 * @param {string} secret
 * @returns {string}
 */
function sign(data, secret) {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

/**
 * Issue a token for a user.
 * @param {{ sub: string, org?: string | null, role?: string | null, name?: string | null }} claims
 * @param {string} secret
 * @param {{ ttlSeconds?: number, now?: number }} [opts]
 * @returns {string}
 */
export function signToken(claims, secret, opts = {}) {
  if (!claims || typeof claims.sub !== 'string' || claims.sub.length === 0) {
    throw new TypeError('claims.sub is required');
  }
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new TypeError('secret is required');
  }
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const ttl = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const payload = {
    sub: claims.sub,
    org: claims.org ?? null,
    role: claims.role ?? null,
    name: claims.name ?? null,
    iat: now,
    exp: now + ttl,
  };
  const body = `${b64urlJson(HEADER)}.${b64urlJson(payload)}`;
  return `${body}.${sign(body, secret)}`;
}

/**
 * Verify a token's signature and expiry.
 * Returns the payload on success, `null` on any failure (malformed, bad
 * signature, expired). Never throws on untrusted input.
 * @param {unknown} token
 * @param {string} secret
 * @param {{ now?: number }} [opts]
 * @returns {{ sub: string, org: string | null, role: string | null, name: string | null, iat: number, exp: number } | null}
 */
export function verifyToken(token, secret, opts = {}) {
  if (typeof token !== 'string' || typeof secret !== 'string' || secret.length === 0) {
    return null;
  }
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signature] = parts;
  const expected = sign(`${headerB64}.${payloadB64}`, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let header;
  let payload;
  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!header || header.alg !== 'HS256') return null;
  if (!payload || typeof payload.sub !== 'string' || typeof payload.exp !== 'number') {
    return null;
  }
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (payload.exp <= now) return null;
  return payload;
}

/**
 * Extract a bearer token from an Authorization header value.
 * @param {unknown} header
 * @returns {string | null}
 */
export function bearerToken(header) {
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}
