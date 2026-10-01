/**
 * GPS ingest rules (board task #106, AND1-A4) — pure and dependency-free, so the
 * Node.js native test runner pins them with no install (`gps-ingest.test.js`).
 *
 * The driver app samples a location every 10 minutes **only while a trip's
 * `tracking` flag is true**, stores the points in Room and uploads them in
 * batches; offline it queues and replays on reconnect (rule R28: every point
 * carries a client-generated id, so a replayed batch is idempotent server-side).
 *
 * This module owns the batch contract:
 *   - the body is `{ points: [{ id, lat, lng, at, accuracyM? }] }`;
 *   - every point must be well-formed: a non-empty client id, finite lat/lng in
 *     range, a parseable timestamp that is not in the future (a small clock
 *     skew is tolerated), and an optional non-negative accuracy in metres;
 *   - the batch is bounded, so one request cannot write an unbounded row set;
 *   - duplicate client ids inside one batch are collapsed, oldest first, so the
 *     insert cannot self-collide on the `(tripId, clientId)` unique index.
 *
 * The route maps a rejection to `400 invalid_gps` with a `detail` naming the
 * first offending point, and the DB write uses `createMany({ skipDuplicates })`,
 * so a replay across requests is a no-op rather than a 500.
 */

/** Hard cap on points per request. 6 hours of 10-minute samples is 36. */
export const GPS_MAX_BATCH = 200;

/** A point timestamp further ahead than this is a clock problem, not skew. */
export const GPS_MAX_FUTURE_SKEW_MS = 10 * 60 * 1000;

/** The client id is opaque to the server; only bound its length. */
export const GPS_MAX_CLIENT_ID_LENGTH = 128;

/** Accuracy beyond this is unusable for tracking; reject rather than store junk. */
export const GPS_MAX_ACCURACY_M = 100_000;

/**
 * Parse one timestamp: epoch milliseconds (number) or an ISO-8601 string.
 * @param {unknown} value
 * @returns {number | null} epoch milliseconds, or null when unusable
 */
export function parseGpsTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/**
 * Validate one point. Returns the normalized point or the failing field.
 * @param {unknown} raw
 * @param {{ now?: number }} [opts]
 * @returns {{ ok: true, point: { clientId: string, lat: number, lng: number, at: Date, accuracyM: number | null } } | { ok: false, detail: string }}
 */
export function parseGpsPoint(raw, { now = Date.now() } = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, detail: 'points[].object_required' };
  }
  const point = /** @type {Record<string, unknown>} */ (raw);
  const clientId = point.id ?? point.clientId;
  if (typeof clientId !== 'string' || clientId.trim().length === 0) {
    return { ok: false, detail: 'points[].id_required' };
  }
  if (clientId.length > GPS_MAX_CLIENT_ID_LENGTH) {
    return { ok: false, detail: 'points[].id_too_long' };
  }
  if (typeof point.lat !== 'number' || !Number.isFinite(point.lat) || point.lat < -90 || point.lat > 90) {
    return { ok: false, detail: 'points[].lat_out_of_range' };
  }
  if (typeof point.lng !== 'number' || !Number.isFinite(point.lng) || point.lng < -180 || point.lng > 180) {
    return { ok: false, detail: 'points[].lng_out_of_range' };
  }
  const atMs = parseGpsTime(point.at ?? point.atEpochMs ?? point.time);
  if (atMs === null) return { ok: false, detail: 'points[].at_invalid' };
  if (atMs > now + GPS_MAX_FUTURE_SKEW_MS) {
    return { ok: false, detail: 'points[].at_in_future' };
  }
  let accuracyM = null;
  const rawAccuracy = point.accuracyM ?? point.accuracy;
  if (rawAccuracy !== undefined && rawAccuracy !== null) {
    if (typeof rawAccuracy !== 'number' || !Number.isFinite(rawAccuracy) || rawAccuracy < 0) {
      return { ok: false, detail: 'points[].accuracy_invalid' };
    }
    if (rawAccuracy > GPS_MAX_ACCURACY_M) {
      return { ok: false, detail: 'points[].accuracy_out_of_range' };
    }
    accuracyM = Math.round(rawAccuracy);
  }
  return { ok: true, point: { clientId, lat: point.lat, lng: point.lng, at: new Date(atMs), accuracyM } };
}

/**
 * Parse a whole ingest body.
 * @param {unknown} body
 * @param {{ now?: number, maxBatch?: number }} [opts]
 * @returns {{
 *   ok: true,
 *   points: Array<{ clientId: string, lat: number, lng: number, at: Date, accuracyM: number | null }>,
 *   duplicates: number,
 * } | { ok: false, error: 'invalid_gps', detail: string }}
 */
export function parseGpsBatch(body, { now = Date.now(), maxBatch = GPS_MAX_BATCH } = {}) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'invalid_gps', detail: 'body.object_required' };
  }
  const rawPoints = /** @type {Record<string, unknown>} */ (body).points;
  if (!Array.isArray(rawPoints)) {
    return { ok: false, error: 'invalid_gps', detail: 'points.array_required' };
  }
  if (rawPoints.length === 0) {
    return { ok: false, error: 'invalid_gps', detail: 'points.empty' };
  }
  if (rawPoints.length > maxBatch) {
    return { ok: false, error: 'invalid_gps', detail: 'points.batch_too_large' };
  }
  const seen = new Set();
  const points = [];
  let duplicates = 0;
  for (const raw of rawPoints) {
    const parsed = parseGpsPoint(raw, { now });
    if (!parsed.ok) return { ok: false, error: 'invalid_gps', detail: parsed.detail };
    if (seen.has(parsed.point.clientId)) {
      duplicates += 1;
      continue;
    }
    seen.add(parsed.point.clientId);
    points.push(parsed.point);
  }
  return { ok: true, points, duplicates };
}

/**
 * The wire shape of one point for the realtime channel (SSE `data:` payload).
 * PII-free by construction: position + time + accuracy only, no driver, no
 * route, no customer.
 * @param {{ clientId?: string, at: Date | string, lat: number | string | { toString(): string }, lng: number | string | { toString(): string }, accuracyM?: number | null }} point
 * @returns {{ id: string | null, at: string, lat: number, lng: number, accuracyM: number | null }}
 */
export function gpsStreamPayload(point) {
  return {
    id: point.clientId ?? null,
    at: point.at instanceof Date ? point.at.toISOString() : new Date(point.at).toISOString(),
    lat: Number(point.lat),
    lng: Number(point.lng),
    accuracyM: point.accuracyM ?? null,
  };
}
