/**
 * Pure trip-status state machine — the single source of truth for the trip
 * lifecycle documented in `docs/diagrams-data-menu-flow.md` §7:
 *
 *   DRAFT → ASSIGNED → EN_ROUTE → AT_PICKUP → LOADED → IN_TRANSIT
 *         → AT_DELIVERY → DELIVERED → POD_UPLOADED → INVOICED → SETTLED
 *   DRAFT → CANCELLED
 *   ASSIGNED → CANCELLED
 *
 * The driver phases (board task #105, AND1-A3) are the intermediate states the
 * driver app walks through on the current-assignment card: **Start Trip** moves
 * ASSIGNED → EN_ROUTE, then AT_PICKUP → LOADED → IN_TRANSIT → AT_DELIVERY →
 * DELIVERED. The pre-existing "jump" edges (ASSIGNED → LOADED, IN_TRANSIT →
 * DELIVERED) are kept so trips dispatched before the phases existed, and the
 * dispatcher flows, keep working — the phases extend the machine, they do not
 * replace it.
 *
 * SETTLED and CANCELLED are terminal. Every other move is illegal.
 *
 * Deliberately dependency-free ESM (typed via JSDoc) so it can be unit-tested
 * with the Node.js native test runner (`node --test`) without a build step or
 * any install. TypeScript consumers — e.g. `src/routes/trips.ts` — pick up the
 * JSDoc types through `allowJs` in `tsconfig.json`.
 */

/**
 * @typedef {'DRAFT'|'ASSIGNED'|'EN_ROUTE'|'AT_PICKUP'|'LOADED'|'IN_TRANSIT'|'AT_DELIVERY'|'DELIVERED'|'POD_UPLOADED'|'INVOICED'|'SETTLED'|'CANCELLED'} TripStatus
 */

/**
 * Every valid status, in lifecycle order (terminal CANCELLED last).
 * @type {readonly TripStatus[]}
 */
export const TRIP_STATUSES = Object.freeze([
  'DRAFT',
  'ASSIGNED',
  'EN_ROUTE',
  'AT_PICKUP',
  'LOADED',
  'IN_TRANSIT',
  'AT_DELIVERY',
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
  ASSIGNED: Object.freeze(['EN_ROUTE', 'LOADED', 'CANCELLED']),
  EN_ROUTE: Object.freeze(['AT_PICKUP']),
  AT_PICKUP: Object.freeze(['LOADED']),
  LOADED: Object.freeze(['IN_TRANSIT']),
  IN_TRANSIT: Object.freeze(['AT_DELIVERY', 'DELIVERED']),
  AT_DELIVERY: Object.freeze(['DELIVERED']),
  DELIVERED: Object.freeze(['POD_UPLOADED']),
  POD_UPLOADED: Object.freeze(['INVOICED']),
  INVOICED: Object.freeze(['SETTLED']),
  SETTLED: Object.freeze([]),
  CANCELLED: Object.freeze([]),
});

/**
 * The driver-facing phase chain (board task #105): the order the current
 * assignment card walks through while a driver is on a job. INVOICED/SETTLED
 * are back-office states and are not driver phases.
 * @type {readonly TripStatus[]}
 */
export const DRIVER_PHASES = Object.freeze([
  'ASSIGNED',
  'EN_ROUTE',
  'AT_PICKUP',
  'LOADED',
  'IN_TRANSIT',
  'AT_DELIVERY',
  'DELIVERED',
  'POD_UPLOADED',
]);

/**
 * The status that Start Trip sets. It is the only transition that turns the
 * trip's GPS tracking on (`trips-core.js#transitionTrip`), and DELIVERED is the
 * only one that turns it off again (board task #105).
 * @type {TripStatus}
 */
export const START_TRIP_STATUS = 'EN_ROUTE';

/**
 * Statuses in which a driver counts as *actively assigned* to a trip, used to
 * enforce "exactly one active assignment per driver" (board task #105). DRAFT
 * is not active (nothing has started) and DELIVERED / POD_UPLOADED / INVOICED /
 * SETTLED are done driving (only back-office work remains), so a driver may be
 * put on a new job while an old one is being invoiced.
 * @type {readonly TripStatus[]}
 */
export const ACTIVE_ASSIGNMENT_STATUSES = Object.freeze([
  'ASSIGNED',
  'EN_ROUTE',
  'AT_PICKUP',
  'LOADED',
  'IN_TRANSIT',
  'AT_DELIVERY',
]);

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

/**
 * True for statuses in which a driver is actively assigned to the trip — the
 * gate for "exactly one active assignment per driver".
 * @param {unknown} status
 * @returns {boolean}
 */
export function isActiveAssignment(status) {
  return ACTIVE_ASSIGNMENT_STATUSES.includes(/** @type {TripStatus} */ (status));
}
