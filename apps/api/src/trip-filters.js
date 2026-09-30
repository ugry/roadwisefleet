/**
 * Trip-list filters (board task #34, FAv1-F3).
 *
 * The trips list is the daily workhorse: a dispatcher narrows the org's trips
 * by status, driver, a created-date range and free text. This module turns a
 * Fastify query object into a validated filter set and then into the Prisma
 * `where` clause — one place, so the route, the core query and the tests can
 * never drift.
 *
 * Decoupled from Fastify and from Prisma's concrete client so it is covered by
 * the no-install CI job (`node --test apps/api/src/`) with no database. The
 * tenant scope (`orgId`) is always supplied by the signed token, never by the
 * client: `buildTripWhere` starts from `{ orgId }` and only narrows.
 *
 * Accepted query params (all optional, all combinable):
 *   status    one or more trip statuses, comma-separated or repeated
 *             (`?status=DRAFT,ASSIGNED`); an unknown status is a 400.
 *   driverId  exact assigned-driver id.
 *   from,to   created-at window; `YYYY-MM-DD` is expanded to the whole UTC day,
 *             a full ISO timestamp is used as-is. `from > to` is a 400.
 *   q         free text over order origin/destination/cargo, customer name and
 *             driver name (case-insensitive `contains`).
 */

import { isTripStatus } from './trip-status.js';

/** Longest accepted free-text query, so a pathological `q` cannot reach the DB. */
export const MAX_QUERY_LENGTH = 80;

/** @typedef {{ statuses?: string[], driverId?: string, from?: Date, to?: Date, q?: string }} TripFilters */

/** @typedef {{ ok: true, filters: TripFilters } | { ok: false, error: 'invalid_filter', detail: string }} Parsed */

/**
 * A query value that may have arrived once or several times.
 * @param {unknown} value
 * @returns {unknown[]}
 */
function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

/**
 * A single trimmed string, or `undefined` when absent/empty.
 * @param {unknown} value
 * @returns {string | undefined}
 */
function singleString(value) {
  const list = asArray(value);
  if (list.length === 0) return undefined;
  const first = list[0];
  if (typeof first !== 'string') return undefined;
  const trimmed = first.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Parse a `from`/`to` value. `YYYY-MM-DD` means the whole UTC day (00:00:00.000
 * for `from`, 23:59:59.999 for `to`); anything else must be a valid date.
 * @param {string} value
 * @param {boolean} endOfDay
 * @returns {Date | null}
 */
function parseDate(value, endOfDay) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const iso = endOfDay ? `${value}T23:59:59.999Z` : `${value}T00:00:00.000Z`;
    const day = new Date(iso);
    return Number.isNaN(day.getTime()) ? null : day;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Validate and normalise a query object into the filter set.
 * @param {unknown} query
 * @returns {Parsed}
 */
export function parseTripFilters(query) {
  const raw = query && typeof query === 'object' ? /** @type {Record<string, unknown>} */ (query) : {};
  /** @type {TripFilters} */
  const filters = {};

  const statuses = [];
  for (const entry of asArray(raw.status)) {
    if (typeof entry !== 'string') return { ok: false, error: 'invalid_filter', detail: 'status' };
    for (const part of entry.split(',')) {
      const status = part.trim();
      if (status === '') continue;
      if (!isTripStatus(status)) return { ok: false, error: 'invalid_filter', detail: 'status' };
      if (!statuses.includes(status)) statuses.push(status);
    }
  }
  if (statuses.length > 0) filters.statuses = statuses;

  const driverId = singleString(raw.driverId);
  if (driverId !== undefined) filters.driverId = driverId;

  const from = singleString(raw.from);
  if (from !== undefined) {
    const parsed = parseDate(from, false);
    if (parsed === null) return { ok: false, error: 'invalid_filter', detail: 'from' };
    filters.from = parsed;
  }
  const to = singleString(raw.to);
  if (to !== undefined) {
    const parsed = parseDate(to, true);
    if (parsed === null) return { ok: false, error: 'invalid_filter', detail: 'to' };
    filters.to = parsed;
  }
  if (filters.from && filters.to && filters.from.getTime() > filters.to.getTime()) {
    return { ok: false, error: 'invalid_filter', detail: 'range' };
  }

  const q = singleString(raw.q);
  if (q !== undefined) {
    if (q.length > MAX_QUERY_LENGTH) return { ok: false, error: 'invalid_filter', detail: 'q' };
    filters.q = q;
  }

  return { ok: true, filters };
}

/**
 * The Prisma `where` clause for the org's trips narrowed by `filters`. Keys are
 * only added when a filter is present, so the unfiltered list query is byte-for
 * -byte what it always was.
 * @param {{ orgId: string, filters?: TripFilters }} args
 * @returns {any}
 */
export function buildTripWhere({ orgId, filters }) {
  const where = { orgId };
  if (!filters) return where;

  if (filters.statuses && filters.statuses.length > 0) {
    where.status = { in: filters.statuses };
  }
  if (filters.driverId) {
    where.driverId = filters.driverId;
  }
  if (filters.from || filters.to) {
    where.createdAt = {};
    if (filters.from) where.createdAt.gte = filters.from;
    if (filters.to) where.createdAt.lte = filters.to;
  }
  if (filters.q) {
    const contains = { contains: filters.q, mode: 'insensitive' };
    where.OR = [
      { order: { origin: contains } },
      { order: { destination: contains } },
      { order: { cargo: contains } },
      { order: { customer: { name: contains } } },
      { driver: { name: contains } },
    ];
  }
  return where;
}

/**
 * The filter set as plain strings, for the API response so a client can show
 * exactly what the server applied.
 * @param {TripFilters} [filters]
 * @returns {{ status?: string, driverId?: string, from?: string, to?: string, q?: string }}
 */
export function serializeTripFilters(filters) {
  if (!filters) return {};
  /** @type {Record<string, string>} */
  const out = {};
  if (filters.statuses && filters.statuses.length > 0) out.status = filters.statuses.join(',');
  if (filters.driverId) out.driverId = filters.driverId;
  if (filters.from) out.from = filters.from.toISOString();
  if (filters.to) out.to = filters.to.toISOString();
  if (filters.q) out.q = filters.q;
  return out;
}
