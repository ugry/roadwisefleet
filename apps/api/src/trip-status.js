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
 * Alternate endings (board task #127, UXF-O4, diagram 07 A3–A6) are the designed
 * exits of the execution lane. Each has exactly one documented source status and
 * exactly one documented recovery edge, from the flow diagram:
 *
 *   AT_PICKUP   → REFUSED       (cargo not as described)   REFUSED       → LOADED
 *   EN_ROUTE    → BREAKDOWN     (driver reports a problem) BREAKDOWN     → EN_ROUTE
 *   IN_TRANSIT  → DELAYED       (traffic / rest / weather) DELAYED       → IN_TRANSIT
 *   AT_DELIVERY → CUSTOMS_HOLD  (paperwork problem)        CUSTOMS_HOLD  → AT_DELIVERY
 *
 * DELAYED is deliberately resumable. The other three have a documented recovery
 * path in diagram 07 as well, so they are resumable **only along that edge** —
 * never terminal, and never open-ended: no other move out of them is legal.
 *
 * Deliberately dependency-free ESM (typed via JSDoc) so it can be unit-tested
 * with the Node.js native test runner (`node --test`) without a build step or
 * any install. TypeScript consumers — e.g. `src/routes/trips.ts` — pick up the
 * JSDoc types through `allowJs` in `tsconfig.json`.
 */

/**
 * @typedef {'DRAFT'|'ASSIGNED'|'EN_ROUTE'|'AT_PICKUP'|'LOADED'|'IN_TRANSIT'|'AT_DELIVERY'|'DELIVERED'|'POD_UPLOADED'|'INVOICED'|'SETTLED'|'REFUSED'|'BREAKDOWN'|'DELAYED'|'CUSTOMS_HOLD'|'CANCELLED'} TripStatus
 */

/**
 * Every valid status: the lifecycle order first, then the alternate endings of
 * diagram 07 A3–A6, then the terminal CANCELLED.
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
  'REFUSED',
  'BREAKDOWN',
  'DELAYED',
  'CUSTOMS_HOLD',
  'CANCELLED',
]);

/**
 * The four designed alternate endings (board task #127). They are states a trip
 * can be in, not terminals: each one has a documented recovery edge below.
 * @type {readonly TripStatus[]}
 */
export const DISRUPTION_STATUSES = Object.freeze([
  'REFUSED',
  'BREAKDOWN',
  'DELAYED',
  'CUSTOMS_HOLD',
]);

/**
 * The status each ending resumes to — the single documented recovery edge of
 * diagram 07 (A3 → LOADED, A4 → EN_ROUTE, A5 → IN_TRANSIT, A6 → AT_DELIVERY).
 * @type {Readonly<Record<string, TripStatus>>}
 */
export const DISRUPTION_RESUME = Object.freeze({
  REFUSED: 'LOADED',
  BREAKDOWN: 'EN_ROUTE',
  DELAYED: 'IN_TRANSIT',
  CUSTOMS_HOLD: 'AT_DELIVERY',
});

/**
 * The statuses each ending may be entered from — exactly the documented source
 * of the flow diagram, so no surface can invent a new exit.
 * @type {Readonly<Record<string, readonly TripStatus[]>>}
 */
export const DISRUPTION_SOURCES = Object.freeze({
  REFUSED: Object.freeze(['AT_PICKUP']),
  BREAKDOWN: Object.freeze(['EN_ROUTE']),
  DELAYED: Object.freeze(['IN_TRANSIT']),
  CUSTOMS_HOLD: Object.freeze(['AT_DELIVERY']),
});

/**
 * The endings an employed driver may report from their own trip (diagram 07:
 * "driver reports a problem" / "load not as agreed"). Setting DELAYED or
 * CUSTOMS_HOLD, and every recovery edge, is the dispatcher's / carrier's call
 * (a solo driver is their own carrier and holds `trip:*`, so they keep it).
 * @type {readonly TripStatus[]}
 */
export const DRIVER_REPORTABLE_ENDINGS = Object.freeze(['REFUSED', 'BREAKDOWN']);

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
  EN_ROUTE: Object.freeze(['AT_PICKUP', 'BREAKDOWN']),
  AT_PICKUP: Object.freeze(['LOADED', 'REFUSED']),
  LOADED: Object.freeze(['IN_TRANSIT']),
  IN_TRANSIT: Object.freeze(['AT_DELIVERY', 'DELIVERED', 'DELAYED']),
  AT_DELIVERY: Object.freeze(['DELIVERED', 'CUSTOMS_HOLD']),
  DELIVERED: Object.freeze(['POD_UPLOADED']),
  POD_UPLOADED: Object.freeze(['INVOICED']),
  INVOICED: Object.freeze(['SETTLED']),
  SETTLED: Object.freeze([]),
  REFUSED: Object.freeze(['LOADED']),
  BREAKDOWN: Object.freeze(['EN_ROUTE']),
  DELAYED: Object.freeze(['IN_TRANSIT']),
  CUSTOMS_HOLD: Object.freeze(['AT_DELIVERY']),
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
  // A disrupted trip still holds its driver: a breakdown, delay, refusal or
  // customs hold is unfinished work, not a free truck (board task #127).
  'REFUSED',
  'BREAKDOWN',
  'DELAYED',
  'CUSTOMS_HOLD',
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

/**
 * True for one of the four designed alternate endings (board task #127).
 * @param {unknown} status
 * @returns {boolean}
 */
export function isDisruption(status) {
  return DISRUPTION_STATUSES.includes(/** @type {TripStatus} */ (status));
}

/**
 * The documented recovery target for a disrupted trip, or null.
 * @param {unknown} status
 * @returns {TripStatus|null}
 */
export function resumeStatus(status) {
  if (!isDisruption(status)) return null;
  return DISRUPTION_RESUME[/** @type {string} */ (status)] || null;
}

/**
 * The endings a trip in `from` may enter. Empty for unknown or terminal states.
 * @param {unknown} from
 * @returns {readonly TripStatus[]}
 */
export function endingsFrom(from) {
  return nextStatuses(from).filter((to) => isDisruption(to));
}

/**
 * The recovery action a disrupted trip offers: `{ from: <ending>, to: <status> }`,
 * or null when the trip is not in an ending state.
 * @param {unknown} status
 * @returns {{ from: TripStatus, to: TripStatus }|null}
 */
export function recoveryFor(status) {
  const to = resumeStatus(status);
  return to ? { from: /** @type {TripStatus} */ (status), to } : null;
}

/**
 * True when a move out of / into a disruption may only be taken by the carrier
 * side (a role holding `trip:*` — owner, dispatcher, or a solo driver acting as
 * their own carrier). An employed driver may report REFUSED/BREAKDOWN on their
 * own trip and nothing else; the recovery decision is never theirs.
 * @param {unknown} from
 * @param {unknown} to
 * @returns {boolean}
 */
export function requiresCarrierActor(from, to) {
  if (!isTripStatus(from) || !isTripStatus(to)) return false;
  if (!canTransition(from, to)) return false;
  if (isDisruption(to)) {
    return !DRIVER_REPORTABLE_ENDINGS.includes(/** @type {TripStatus} */ (to));
  }
  return isDisruption(from);
}
