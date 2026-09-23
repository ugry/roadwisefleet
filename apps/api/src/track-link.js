/**
 * Tokenized customer tracking link (board task #5) — a shareable, login-free
 * read-only view of one trip.
 *
 * The link is a stateless HMAC-SHA256 token binding **one trip id** to an
 * expiry. It is signed with a secret *derived* from `AUTH_SECRET` (domain
 * separated), so a tracking token can never be replayed as a session token and
 * vice versa. Reusing the session token primitives (`auth/tokens.js`) keeps the
 * format auditable; the derived key keeps the domains apart:
 *
 *   trackSecret = HMAC-SHA256(key = AUTH_SECRET, msg = "roadwisefleet/track-link/v1")
 *
 * Revocation: tokens are stateless, so a link is revoked by rotating the signing
 * secret — either `AUTH_SECRET` itself or the dedicated `TRACK_LINK_SECRET`
 * override. Every outstanding link stops verifying immediately; no table, no
 * server-side session store (same trade-off as session tokens, documented).
 *
 * The public payload is deliberately small and PII-free: route (origin /
 * destination / cargo), current status, the status timeline, the last known GPS
 * ping (if any), an ETA placeholder and a POD-availability flag. Driver names
 * and phone numbers, customer names, plate numbers and rates are **never**
 * exposed here — `shapeTrackedTrip` simply has no fields for them.
 *
 * Pure ESM + JSDoc types: unit-testable with `node --test`, zero install, no
 * build step. The route layer (`routes/track.ts`) only does HTTP mapping.
 */

import { createHmac } from 'node:crypto';
import { signToken, verifyToken } from './auth/tokens.js';
import { hasPodDocument } from './documents.js';

/** Default link lifetime: 30 days (gap spec §3). */
export const DEFAULT_TRACK_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Domain-separation context; change it only with a token version bump. */
const DERIVE_CONTEXT = 'roadwisefleet/track-link/v1';

/** Permission required to mint a tracking link (owner / dispatcher). */
export const TRACK_LINK_PERMISSION = 'trip:*';

/**
 * @typedef {Object} TrackLinkClient
 * @property {any} trip
 * @property {any} document
 */

/**
 * Derive the tracking-link signing key from the API secret.
 *
 * `override` (the optional `TRACK_LINK_SECRET` env var) wins when present, so an
 * operator can revoke every outstanding link without rotating `AUTH_SECRET` —
 * and rotate tracking links without signing every user out.
 *
 * @param {unknown} authSecret
 * @param {{ override?: unknown }} [opts]
 * @returns {string} base64url key
 * @throws {TypeError} when neither secret is provided
 */
export function deriveTrackSecret(authSecret, { override } = {}) {
  if (typeof override === 'string' && override.trim().length > 0) return override.trim();
  if (typeof authSecret !== 'string' || authSecret.length === 0) {
    throw new TypeError('authSecret is required');
  }
  return createHmac('sha256', authSecret).update(DERIVE_CONTEXT).digest('base64url');
}

/**
 * Mint a tracking token for one trip.
 * @param {{ tripId?: unknown, authSecret?: unknown, secret?: unknown, ttlSeconds?: unknown, now?: number }} [args]
 * @returns {{ token: string, expiresAt: string, ttlSeconds: number }}
 * @throws {TypeError} when `tripId` is missing
 */
export function signTrackLink({ tripId, authSecret, secret, ttlSeconds, now } = {}) {
  if (typeof tripId !== 'string' || tripId.trim().length === 0) {
    throw new TypeError('tripId is required');
  }
  const ttl =
    Number.isFinite(ttlSeconds) && /** @type {number} */ (ttlSeconds) > 0
      ? Math.floor(/** @type {number} */ (ttlSeconds))
      : DEFAULT_TRACK_TTL_SECONDS;
  const issuedAt = typeof now === 'number' ? now : Math.floor(Date.now() / 1000);
  const key = deriveTrackSecret(authSecret, { override: secret });
  const token = signToken({ sub: tripId.trim() }, key, { ttlSeconds: ttl, now: issuedAt });
  return { token, expiresAt: new Date((issuedAt + ttl) * 1000).toISOString(), ttlSeconds: ttl };
}

/**
 * Verify a tracking token. Never throws on untrusted input.
 *
 * Rejects: malformed tokens, a bad signature, an expired token, a token signed
 * with another secret (i.e. a revoked/rotated link), and — defensively — a
 * session token, whose payload always carries `org`/`role`/`name`.
 *
 * @param {unknown} token
 * @param {{ authSecret?: unknown, secret?: unknown, now?: number }} [opts]
 * @returns {{ tripId: string, iat: number, exp: number } | null}
 */
export function verifyTrackLink(token, { authSecret, secret, now } = {}) {
  let key;
  try {
    key = deriveTrackSecret(authSecret, { override: secret });
  } catch {
    return null;
  }
  const at = typeof now === 'number' ? now : Math.floor(Date.now() / 1000);
  const payload = verifyToken(token, key, { now: at });
  if (!payload || typeof payload.sub !== 'string' || payload.sub.length === 0) return null;
  // A session token must never verify as a tracking link (different key already
  // prevents it; this is defence in depth if a key is ever shared by mistake).
  if (payload.org !== null || payload.role !== null || payload.name !== null) return null;
  return { tripId: payload.sub, iat: payload.iat, exp: payload.exp };
}

/**
 * Build the public track URL. `baseUrl` is optional: without it the URL is
 * origin-relative (`/track/<token>`), which is what a same-origin pilot page
 * wants.
 * @param {unknown} baseUrl
 * @param {unknown} token
 * @returns {string}
 */
export function publicTrackUrl(baseUrl, token) {
  const path = `/track/${encodeURIComponent(String(token ?? ''))}`;
  const base = typeof baseUrl === 'string' ? baseUrl.trim().replace(/\/+$/, '') : '';
  return base ? base + path : path;
}

/**
 * Coerce a Prisma `Decimal | number | string | null` to a finite number (or
 * null). Prisma serialises Decimal as an object with `toNumber()`.
 * @param {unknown} value
 * @returns {number | null}
 */
function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof value === 'object' && typeof (/** @type {any} */ (value).toNumber) === 'function') {
    const n = /** @type {any} */ (value).toNumber();
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * The relations the public tracking read needs. Kept in one place so the route
 * and the tests cannot drift. `gpsPings` is newest-first with `take: 1` — the
 * last known position.
 * @returns {any}
 */
export function trackTripInclude() {
  return {
    order: { select: { origin: true, destination: true, cargo: true } },
    statusEvents: {
      orderBy: { happenedAt: 'asc' },
      select: { fromStatus: true, toStatus: true, happenedAt: true },
    },
    gpsPings: { orderBy: { at: 'desc' }, take: 1, select: { at: true, lat: true, lng: true } },
  };
}

/**
 * Shape a raw trip into the **public** tracking payload. Pure and
 * dependency-free so the PII boundary is unit-testable: there is deliberately
 * no driver, customer, truck-plate or rate field.
 * @param {any} trip
 * @param {{ podAvailable?: boolean }} [opts]
 * @returns {any}
 */
export function shapeTrackedTrip(trip, { podAvailable = false } = {}) {
  const order = trip?.order ?? null;
  const events = Array.isArray(trip?.statusEvents) ? trip.statusEvents : [];
  const pings = Array.isArray(trip?.gpsPings) ? trip.gpsPings : [];
  const last = pings.length > 0 ? pings[0] : null;

  return {
    status: trip?.status ?? null,
    route: order
      ? {
          origin: order.origin ?? null,
          destination: order.destination ?? null,
          cargo: order.cargo ?? null,
        }
      : null,
    statusTimeline: events.map((ev) => ({
      from: ev?.fromStatus ?? null,
      to: ev?.toStatus ?? null,
      at: ev?.happenedAt ?? null,
    })),
    // Placeholder until the GPS ingest pipeline lands: the value is the newest
    // ping when one exists, `null` otherwise (the page renders "not available").
    lastKnownPosition: last
      ? { at: last.at ?? null, lat: toNumber(last.lat), lng: toNumber(last.lng) }
      : null,
    // ETA is not computed in the pilot yet (gap spec §3) — explicit placeholder.
    eta: null,
    pod: { available: Boolean(podAvailable) },
  };
}

/**
 * Load one trip by id and shape it for the public tracking page. There is no
 * org scoping here by design: the signed token **is** the capability, and it is
 * bound to exactly this trip id.
 * @param {TrackLinkClient} prisma
 * @param {{ tripId?: unknown }} [args]
 * @returns {Promise<{ ok: true, trip: any } | { ok: false, error: 'not_found' }>}
 */
export async function loadTrackedTrip(prisma, { tripId } = {}) {
  const id = typeof tripId === 'string' ? tripId.trim() : '';
  if (!id) return { ok: false, error: 'not_found' };

  const trip = await prisma.trip.findFirst({ where: { id }, include: trackTripInclude() });
  if (!trip) return { ok: false, error: 'not_found' };

  const podAvailable = await hasPodDocument(prisma, { tripId: id });
  return { ok: true, trip: shapeTrackedTrip(trip, { podAvailable }) };
}
