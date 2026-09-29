/**
 * Pure trip-status state machine — the single source of truth for the trip
 * lifecycle documented in `docs/diagrams-data-menu-flow.md` §7:
 *
 *   DRAFT → ASSIGNED → LOADED → IN_TRANSIT → DELIVERED → POD_UPLOADED
 *         → INVOICED → SETTLED
 *   DRAFT → CANCELLED
 *   ASSIGNED → CANCELLED
 *
 * SETTLED and CANCELLED are terminal. Every other move is illegal.
 *
 * Deliberately dependency-free ESM (typed via JSDoc) so it can be unit-tested
 * with the Node.js native test runner (`node --test`) without a build step or
 * any install. TypeScript consumers — e.g. `src/routes/trips.ts` — pick up the
 * JSDoc types through `allowJs` in `tsconfig.json`.
 */

/**
 * @typedef {'DRAFT'|'ASSIGNED'|'LOADED'|'IN_TRANSIT'|'DELIVERED'|'POD_UPLOADED'|'INVOICED'|'SETTLED'|'CANCELLED'} TripStatus
 */

/**
 * Every valid status, in lifecycle order (terminal CANCELLED last).
 * @type {readonly TripStatus[]}
 */
export const TRIP_STATUSES = Object.freeze([
  'DRAFT',
  'ASSIGNED',
  'LOADED',
  'IN_TRANSIT',
  'DELIVERED',
  'POD_UPLOADED',
  'INVOICED',
  'SETTLED',
  'CANCELLED',
]);

/**
 * Statuses with no outgoing transitions.
 * @type {readonly TripStatus[]}
 */
export const TERMINAL_STATUSES = Object.freeze(['SETTLED', 'CANCELLED']);

/**
 * Adjacency list of the state machine. A status maps to the exact set of
 * statuses it may move to; anything absent is rejected.
 * @type {Readonly<Record<TripStatus, readonly TripStatus[]>>}
 */
export const TRANSITIONS = Object.freeze({
  DRAFT: Object.freeze(['ASSIGNED', 'CANCELLED']),
  ASSIGNED: Object.freeze(['LOADED', 'CANCELLED']),
  LOADED: Object.freeze(['IN_TRANSIT']),
  IN_TRANSIT: Object.freeze(['DELIVERED']),
  DELIVERED: Object.freeze(['POD_UPLOADED']),
  POD_UPLOADED: Object.freeze(['INVOICED']),
  INVOICED: Object.freeze(['SETTLED']),
  SETTLED: Object.freeze([]),
  CANCELLED: Object.freeze([]),
});

/**
 * Narrow an arbitrary value to a known trip status.
 * @param {unknown} status
 * @returns {status is TripStatus}
 */
export function isTripStatus(status) {
  return (
    typeof status === 'string' &&
    Object.prototype.hasOwnProperty.call(TRANSITIONS, status)
  );
}

/**
 * The statuses reachable from `from` (empty for unknown/terminal statuses).
 * @param {unknown} from
 * @returns {readonly TripStatus[]}
 */
export function nextStatuses(from) {
  return isTripStatus(from) ? TRANSITIONS[from] : [];
}

/**
 * True only when `to` is a legal next status from `from`.
 * Unknown statuses and no-op moves are rejected.
 * @param {unknown} from
 * @param {unknown} to
 * @returns {boolean}
 */
export function canTransition(from, to) {
  if (!isTripStatus(from) || !isTripStatus(to)) return false;
  return TRANSITIONS[from].includes(to);
}

/**
 * True for statuses that end the trip lifecycle (SETTLED, CANCELLED).
 * @param {unknown} status
 * @returns {boolean}
 */
export function isTerminal(status) {
  return isTripStatus(status) && TRANSITIONS[status].length === 0;
}
