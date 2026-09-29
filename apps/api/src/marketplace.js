/**
 * Connect marketplace — core domain (board task #76, UXF-M1).
 *
 * The marketplace is the matching engine of diagram `docs/ux-flows/05-marketplace-flow.mmd`:
 * demand posts a load, supply declares capacity (a beacon) or answers with a
 * structured offer, the shipper awards, and the award becomes the SAME `Trip`
 * object the fleet/driver already executes — nobody re-enters the load.
 *
 * Everything here is pure: no Prisma, no Fastify, no clock, no network. The
 * `routes/marketplace.ts` layer does auth, tenancy and persistence and calls
 * into these functions; `auth/permissions.js` stays the RBAC source of truth and
 * `trip-status.js` the trip state machine. That split is what lets the whole
 * state machine, the award plan, the matching rules and the validation be
 * covered by `node --test apps/api/src/` with no install (see
 * `marketplace.test.js`); the HTTP + database end-to-end proof lives in
 * `apps/api/test/marketplace.test.ts`.
 *
 * Payment is **invoice-first** in v1 (this task): escrow waits for the owner's
 * merchant-of-record answer (UXF-OWN1, #73), so `awardPaymentMethod()` refuses
 * escrow with a reason instead of silently accepting it.
 *
 * Equipment vocabulary is NOT redefined here: it is imported from the customer
 * portal's shared core (`customer/lib/customer-core.js`), which the book-a-load
 * wizard and the marketplace must agree on or an offer can never match a load.
 */

import { EQUIPMENT } from '../../../customer/lib/customer-core.js';
import { hasPermission } from './auth/permissions.js';

/* --------------------------------------------------------------- constants --- */

/**
 * Load-posting lifecycle (diagram 05). A posted load collects offers, is
 * awarded (once), or dies by expiry/cancellation. AWARDED/EXPIRED/CANCELLED are
 * terminal.
 * @type {readonly string[]}
 */
export const LOAD_STATUSES = Object.freeze(['POSTED', 'OFFERS', 'AWARDED', 'EXPIRED', 'CANCELLED']);

/** Load statuses that are still collectible (an offer may be made). */
export const OPEN_LOAD_STATUSES = Object.freeze(['POSTED', 'OFFERS']);

/** Load statuses that end the posting. */
export const TERMINAL_LOAD_STATUSES = Object.freeze(['AWARDED', 'EXPIRED', 'CANCELLED']);

/**
 * Offer lifecycle (diagram 05: SENT · VIEWED · COUNTERED · ACCEPTED · DECLINED
 * · EXPIRED), plus WITHDRAWN so a carrier can pull an offer before it is
 * decided. Only SENT/VIEWED are open; every other state is terminal.
 * @type {readonly string[]}
 */
export const OFFER_STATUSES = Object.freeze([
  'SENT',
  'VIEWED',
  'COUNTERED',
  'ACCEPTED',
  'DECLINED',
  'EXPIRED',
  'WITHDRAWN',
]);

/** Offer statuses a decision (counter/accept/decline/withdraw) may act on. */
export const OPEN_OFFER_STATUSES = Object.freeze(['SENT', 'VIEWED']);

/**
 * Which side of the load made an offer. `carrier` = a fleet/solo answering the
 * load; `shipper` = the load's owner answering with a counter.
 * @type {readonly string[]}
 */
export const OFFER_SIDES = Object.freeze(['carrier', 'shipper']);

/** Pricing modes, matching the book-a-load wizard (`customer-core.js`). */
export const PRICING_MODES = Object.freeze(['instant', 'quotes', 'budget']);

/** Equipment the marketplace can match on — the wizard's list, one source. */
export const EQUIPMENT_OPTIONS = Object.freeze([...EQUIPMENT]);

/**
 * Payment methods an award accepts. **Invoice-first**: escrow is deliberately
 * absent until the owner answers UXF-OWN1 (#73).
 */
export const AWARD_PAYMENT_METHODS = Object.freeze(['invoice']);

/** Escrow refusal reason, surfaced to the client instead of a silent accept. */
export const ESCROW_DEFERRED_REASON = 'escrow_deferred_uxf_own1';

/** Free-text cap, so a pasted document cannot reach the database. */
export const MARKETPLACE_TEXT_MAX = 500;

/** Default offer lifetime (24 h) and load lifetime (14 days), in seconds. */
export const DEFAULT_OFFER_TTL_SECONDS = 24 * 60 * 60;
export const DEFAULT_LOAD_TTL_SECONDS = 14 * 24 * 60 * 60;

/** The capability a carrier needs to browse, beacon and bid. */
export const SUPPLY_PERMISSION = 'trip:create';
/** The capability a shipper needs to post a load (customer or fleet). */
export const POST_PERMISSION = 'order:create';
/** The capability a fleet needs to post an uncovered load. */
export const FLEET_POST_PERMISSION = 'trip:create';

const LOAD_TRANSITIONS = Object.freeze({
  POSTED: Object.freeze(['OFFERS', 'AWARDED', 'EXPIRED', 'CANCELLED']),
  OFFERS: Object.freeze(['AWARDED', 'EXPIRED', 'CANCELLED']),
  AWARDED: Object.freeze([]),
  EXPIRED: Object.freeze([]),
  CANCELLED: Object.freeze([]),
});

const OFFER_TRANSITIONS = Object.freeze({
  SENT: Object.freeze(['VIEWED', 'COUNTERED', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'WITHDRAWN']),
  VIEWED: Object.freeze(['COUNTERED', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'WITHDRAWN']),
  COUNTERED: Object.freeze([]),
  ACCEPTED: Object.freeze([]),
  DECLINED: Object.freeze([]),
  EXPIRED: Object.freeze([]),
  WITHDRAWN: Object.freeze([]),
});

/* ------------------------------------------------------------------ states --- */

/** @param {unknown} status @returns {boolean} */
export function isLoadStatus(status) {
  return typeof status === 'string' && Object.prototype.hasOwnProperty.call(LOAD_TRANSITIONS, status);
}

/** @param {unknown} from @param {unknown} to @returns {boolean} */
export function canTransitionLoad(from, to) {
  if (!isLoadStatus(from) || !isLoadStatus(to)) return false;
  return LOAD_TRANSITIONS[from].includes(to);
}

/** @param {unknown} status @returns {boolean} */
export function isLoadOpen(status) {
  return typeof status === 'string' && OPEN_LOAD_STATUSES.includes(status);
}

/** @param {unknown} status @returns {boolean} */
export function isLoadTerminal(status) {
  return typeof status === 'string' && TERMINAL_LOAD_STATUSES.includes(status);
}

/** @param {unknown} status @returns {boolean} */
export function isOfferStatus(status) {
  return typeof status === 'string' && Object.prototype.hasOwnProperty.call(OFFER_TRANSITIONS, status);
}

/** @param {unknown} from @param {unknown} to @returns {boolean} */
export function canTransitionOffer(from, to) {
  if (!isOfferStatus(from) || !isOfferStatus(to)) return false;
  return OFFER_TRANSITIONS[from].includes(to);
}

/** @param {unknown} status @returns {boolean} */
export function isOfferOpen(status) {
  return typeof status === 'string' && OPEN_OFFER_STATUSES.includes(status);
}

/** @param {unknown} side @returns {boolean} */
export function isOfferSide(side) {
  return typeof side === 'string' && OFFER_SIDES.includes(side);
}

/* --------------------------------------------------------------- expiry --- */

/**
 * Is `value` a past instant relative to `now`? Null/absent/invalid → false, so
 * a row without an expiry never expires.
 * @param {unknown} value
 * @param {Date|string|number} now
 * @returns {boolean}
 */
export function isExpired(value, now) {
  if (!value) return false;
  const at = value instanceof Date ? value : new Date(/** @type {any} */ (value));
  if (Number.isNaN(at.getTime())) return false;
  const nowDate = now instanceof Date ? now : new Date(/** @type {any} */ (now));
  if (Number.isNaN(nowDate.getTime())) return false;
  return at.getTime() <= nowDate.getTime();
}

/**
 * The ids of rows that are still open but past their `expiresAt`. The route
 * layer persists exactly these (lazy sweep on read), so expiry is real state and
 * not a render-time illusion.
 * @param {Array<{ id: string, status?: unknown, expiresAt?: unknown }>} rows
 * @param {Date|string|number} now
 * @param {(status: unknown) => boolean} isOpen
 * @returns {string[]}
 */
export function expiryIds(rows, now, isOpen) {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row) => row && typeof row.id === 'string' && isOpen(row.status) && isExpired(row.expiresAt, now))
    .map((row) => row.id);
}

/** The ids of open offers that have expired. */
export function expiredOfferIds(offers, now) {
  return expiryIds(offers, now, isOfferOpen);
}

/** The ids of open loads that have expired. */
export function expiredLoadIds(loads, now) {
  return expiryIds(loads, now, isLoadOpen);
}

/**
 * The status an offer/load takes once expired.
 * @param {unknown} status
 * @returns {string}
 */
export function expiredStatusFor(status) {
  return isLoadStatus(status) ? 'EXPIRED' : 'EXPIRED';
}

/* ----------------------------------------------------------- validation --- */

/** @param {unknown} value @returns {boolean} */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} value @param {number} [max] @returns {string} */
function text(value, max) {
  if (value === null || value === undefined) return '';
  const cap = max || MARKETPLACE_TEXT_MAX;
  const s = String(value).trim();
  return s.length > cap ? s.slice(0, cap) : s;
}

/** @param {unknown} value @returns {{ ok: true, value: number|null } | { ok: false }} */
function optionalNumber(value) {
  if (value === null || value === undefined || value === '') return { ok: true, value: null };
  const n = typeof value === 'number' ? value : Number(String(value).trim().replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) return { ok: false };
  return { ok: true, value: n };
}

/** @param {unknown} value @returns {{ ok: true, value: Date|null } | { ok: false }} */
function optionalDate(value) {
  if (value === null || value === undefined || value === '') return { ok: true, value: null };
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return { ok: false };
  return { ok: true, value: date };
}

/**
 * @param {string} field
 * @param {string} messageKey
 * @param {string} detail
 * @returns {{ ok: false, error: 'invalid_input', field: string, messageKey: string, detail: string }}
 */
function fail(field, messageKey, detail) {
  return { ok: false, error: 'invalid_input', field, messageKey, detail };
}

/**
 * Validate a load posting (shipper side). Fail-fast: exactly one field error per
 * call, so the form can focus a single control.
 * @param {unknown} body
 * @returns {{ ok: true, value: any } | { ok: false, error: string, field: string, messageKey: string, detail: string }}
 */
export function normalizeLoadPosting(body) {
  if (!isObject(body)) return fail('form', 'market.load.error.formInvalid', 'body must be an object');
  const b = /** @type {Record<string, any>} */ (body);

  const origin = text(b.origin, 200);
  if (!origin) return fail('origin', 'market.load.error.originRequired', 'origin is required');
  const destination = text(b.destination, 200);
  if (!destination) return fail('destination', 'market.load.error.destinationRequired', 'destination is required');
  if (origin === destination) {
    return fail('destination', 'market.load.error.sameRoute', 'destination must differ from origin');
  }

  const equipment = text(b.equipment, 40);
  if (equipment && !EQUIPMENT_OPTIONS.includes(equipment)) {
    return fail('equipment', 'market.load.error.equipmentUnknown', 'unknown equipment: ' + equipment);
  }

  const loadReadyAt = optionalDate(b.loadReadyAt);
  if (!loadReadyAt.ok) return fail('loadReadyAt', 'market.load.error.dateInvalid', 'loadReadyAt must be a valid ISO-8601 date');
  const deliverByAt = optionalDate(b.deliverByAt);
  if (!deliverByAt.ok) return fail('deliverByAt', 'market.load.error.dateInvalid', 'deliverByAt must be a valid ISO-8601 date');
  if (loadReadyAt.value && deliverByAt.value && deliverByAt.value.getTime() < loadReadyAt.value.getTime()) {
    return fail('deliverByAt', 'market.load.error.windowOrder', 'deliverByAt must not precede loadReadyAt');
  }

  const pricingMode = text(b.pricingMode, 20) || 'quotes';
  if (!PRICING_MODES.includes(pricingMode)) {
    return fail('pricingMode', 'market.load.error.pricingUnknown', 'unknown pricingMode: ' + pricingMode);
  }
  const price = optionalNumber(b.priceEur);
  if (!price.ok) return fail('priceEur', 'market.load.error.amountInvalid', 'priceEur must be a non-negative number');
  if (pricingMode === 'instant' && (price.value === null || price.value <= 0)) {
    return fail('priceEur', 'market.load.error.instantRateRequired', 'an instant-rate load needs a priceEur > 0');
  }

  const expiresAt = optionalDate(b.expiresAt);
  if (!expiresAt.ok) return fail('expiresAt', 'market.load.error.dateInvalid', 'expiresAt must be a valid ISO-8601 date');

  return {
    ok: true,
    value: {
      origin,
      destination,
      cargo: text(b.cargo, 200) || null,
      equipment: equipment || null,
      loadReadyAt: loadReadyAt.value,
      deliverByAt: deliverByAt.value,
      pricingMode,
      priceEur: price.value,
      expiresAt: expiresAt.value,
      orderId: text(b.orderId, 60) || null,
    },
  };
}

/**
 * Validate a capacity beacon (supply side).
 * @param {unknown} body
 * @returns {{ ok: true, value: any } | { ok: false, error: string, field: string, messageKey: string, detail: string }}
 */
export function normalizeBeacon(body) {
  if (!isObject(body)) return fail('form', 'market.beacon.error.formInvalid', 'body must be an object');
  const b = /** @type {Record<string, any>} */ (body);
  const location = text(b.location, 200);
  if (!location) return fail('location', 'market.beacon.error.locationRequired', 'location is required');
  const equipment = text(b.equipment, 40);
  if (equipment && !EQUIPMENT_OPTIONS.includes(equipment)) {
    return fail('equipment', 'market.beacon.error.equipmentUnknown', 'unknown equipment: ' + equipment);
  }
  const availableFrom = optionalDate(b.availableFrom);
  if (!availableFrom.ok) return fail('availableFrom', 'market.beacon.error.dateInvalid', 'availableFrom must be a valid ISO-8601 date');
  const expiresAt = optionalDate(b.expiresAt);
  if (!expiresAt.ok) return fail('expiresAt', 'market.beacon.error.dateInvalid', 'expiresAt must be a valid ISO-8601 date');
  const minRate = optionalNumber(b.minRateEur);
  if (!minRate.ok) return fail('minRateEur', 'market.beacon.error.amountInvalid', 'minRateEur must be a non-negative number');
  return {
    ok: true,
    value: {
      location,
      heading: text(b.heading, 200) || null,
      availableFrom: availableFrom.value,
      equipment: equipment || null,
      minRateEur: minRate.value,
      expiresAt: expiresAt.value,
    },
  };
}

/**
 * Validate a structured offer or counter-offer. A counter needs no price: it may
 * accept the parent's terms with a note, or name a new price. The price is
 * always present on a carrier's first offer.
 * @param {unknown} body
 * @param {{ requirePrice?: boolean }} [options]
 * @returns {{ ok: true, value: any } | { ok: false, error: string, field: string, messageKey: string, detail: string }}
 */
export function normalizeOffer(body, options = {}) {
  const requirePrice = options.requirePrice !== false;
  if (!isObject(body)) return fail('form', 'market.offer.error.formInvalid', 'body must be an object');
  const b = /** @type {Record<string, any>} */ (body);
  const price = optionalNumber(b.priceEur);
  if (!price.ok) return fail('priceEur', 'market.offer.error.amountInvalid', 'priceEur must be a non-negative number');
  if (requirePrice && (price.value === null || price.value <= 0)) {
    return fail('priceEur', 'market.offer.error.priceRequired', 'priceEur must be greater than 0');
  }
  const pickupEtaAt = optionalDate(b.pickupEtaAt);
  if (!pickupEtaAt.ok) return fail('pickupEtaAt', 'market.offer.error.dateInvalid', 'pickupEtaAt must be a valid ISO-8601 date');
  const deliveryEtaAt = optionalDate(b.deliveryEtaAt);
  if (!deliveryEtaAt.ok) return fail('deliveryEtaAt', 'market.offer.error.dateInvalid', 'deliveryEtaAt must be a valid ISO-8601 date');
  if (pickupEtaAt.value && deliveryEtaAt.value && deliveryEtaAt.value.getTime() < pickupEtaAt.value.getTime()) {
    return fail('deliveryEtaAt', 'market.offer.error.windowOrder', 'deliveryEtaAt must not precede pickupEtaAt');
  }
  const expiresAt = optionalDate(b.expiresAt);
  if (!expiresAt.ok) return fail('expiresAt', 'market.offer.error.dateInvalid', 'expiresAt must be a valid ISO-8601 date');
  return {
    ok: true,
    value: {
      priceEur: price.value,
      pickupEtaAt: pickupEtaAt.value,
      deliveryEtaAt: deliveryEtaAt.value,
      note: text(b.note) || null,
      expiresAt: expiresAt.value,
    },
  };
}

/**
 * Validate the award payload. Payment is invoice-first: escrow is refused with a
 * reason (UXF-OWN1) rather than accepted.
 * @param {unknown} body
 * @returns {{ ok: true, value: { paymentMethod: string } } | { ok: false, error: string, field: string, messageKey: string, detail: string }}
 */
export function normalizeAward(body) {
  const b = isObject(body) ? /** @type {Record<string, any>} */ (body) : {};
  const paymentMethod = text(b.paymentMethod, 30) || 'invoice';
  if (paymentMethod === 'escrow') {
    return fail('paymentMethod', 'market.award.error.escrowDeferred', ESCROW_DEFERRED_REASON);
  }
  if (!AWARD_PAYMENT_METHODS.includes(paymentMethod)) {
    return fail('paymentMethod', 'market.award.error.paymentUnknown', 'unknown paymentMethod: ' + paymentMethod);
  }
  return { ok: true, value: { paymentMethod } };
}

/* ------------------------------------------------------------- matching --- */

/** @param {unknown} value @returns {string} */
function normText(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * Does the load's lane satisfy the filter? Both origin and destination are
 * case-insensitive substring matches, so "Berlin" matches "Berlin, DE".
 * @param {any} load
 * @param {{ origin?: unknown, destination?: unknown }} filter
 * @returns {boolean}
 */
export function laneMatches(load, filter = {}) {
  const origin = normText(filter.origin);
  const destination = normText(filter.destination);
  if (origin && !normText(load?.origin).includes(origin)) return false;
  if (destination && !normText(load?.destination).includes(destination)) return false;
  return true;
}

/**
 * Does the load's ready time fall inside the window? A load with no ready time
 * is date-agnostic and matches; bounds are inclusive.
 * @param {any} load
 * @param {{ readyFrom?: unknown, readyTo?: unknown }} filter
 * @returns {boolean}
 */
export function dateFits(load, filter = {}) {
  const at = load?.loadReadyAt ? new Date(/** @type {any} */ (load.loadReadyAt)) : null;
  if (!at || Number.isNaN(at.getTime())) return true;
  const from = filter.readyFrom ? new Date(String(filter.readyFrom)) : null;
  if (from && !Number.isNaN(from.getTime()) && at.getTime() < from.getTime()) return false;
  const to = filter.readyTo ? new Date(String(filter.readyTo)) : null;
  if (to && !Number.isNaN(to.getTime()) && at.getTime() > to.getTime()) return false;
  return true;
}

/**
 * Does the load's equipment fit? An empty required equipment fits anything.
 * @param {any} load
 * @param {unknown} equipment
 * @returns {boolean}
 */
export function equipmentFits(load, equipment) {
  const wanted = normText(equipment);
  if (!wanted) return true;
  return normText(load?.equipment) === wanted;
}

/**
 * The match filter from a raw query object: only known keys, empty strings
 * dropped, and an `equipment` value that is not in the vocabulary is ignored
 * (a filter is a preference, not a payload — it can never 400 a feed).
 * @param {unknown} query
 * @returns {{ origin?: string, destination?: string, equipment?: string, readyFrom?: string, readyTo?: string }}
 */
export function parseMatchFilter(query) {
  const q = isObject(query) ? /** @type {Record<string, any>} */ (query) : {};
  /** @type {Record<string, string>} */
  const out = {};
  for (const key of ['origin', 'destination', 'readyFrom', 'readyTo']) {
    const value = text(q[key], 100);
    if (value) out[key] = value;
  }
  const equipment = text(q.equipment, 40);
  if (equipment && EQUIPMENT_OPTIONS.includes(equipment)) out.equipment = equipment;
  return out;
}

/**
 * Apply the match filter to a list of loads.
 * @param {any[]} loads
 * @param {any} filter
 * @returns {any[]}
 */
export function filterLoads(loads, filter = {}) {
  if (!Array.isArray(loads)) return [];
  return loads.filter(
    (load) => laneMatches(load, filter) && dateFits(load, filter) && equipmentFits(load, filter.equipment),
  );
}

/**
 * Score a load↔beacon pairing (diagram 05: lane fit · date fit · equipment fit).
 * The weights make the reasons readable and testable; a future engine can score
 * detour km / rating / reliability on top without changing the contract.
 * @param {any} load
 * @param {any} beacon
 * @returns {{ score: number, reasons: string[] }}
 */
export function scorePairing(load, beacon) {
  const reasons = [];
  let score = 0;
  const location = normText(beacon?.location);
  const origin = normText(load?.origin);
  const destination = normText(load?.destination);
  const heading = normText(beacon?.heading);
  if (location && origin && (location.includes(origin) || origin.includes(location))) {
    score += 50;
    reasons.push('lane_origin');
  } else if (heading && (heading.includes(destination) || destination.includes(heading))) {
    score += 30;
    reasons.push('lane_heading');
  }
  const availableAt = beacon?.availableFrom ? new Date(/** @type {any} */ (beacon.availableFrom)) : null;
  const readyAt = load?.loadReadyAt ? new Date(/** @type {any} */ (load.loadReadyAt)) : null;
  if (!availableAt || !readyAt || availableAt.getTime() <= readyAt.getTime()) {
    score += 20;
    reasons.push('date_fit');
  }
  if (equipmentFits(load, beacon?.equipment)) {
    score += 30;
    reasons.push('equipment_fit');
  }
  return { score, reasons };
}

/**
 * Rank beacons for a load, best first.
 * @param {any} load
 * @param {any[]} beacons
 * @returns {Array<{ beacon: any, score: number, reasons: string[] }>}
 */
export function rankBeacons(load, beacons) {
  if (!Array.isArray(beacons)) return [];
  return beacons
    .map((beacon) => ({ beacon, ...scorePairing(load, beacon) }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Rank open loads for a beacon, best first.
 * @param {any} beacon
 * @param {any[]} loads
 * @returns {Array<{ load: any, score: number, reasons: string[] }>}
 */
export function rankLoadsForBeacon(beacon, loads) {
  if (!Array.isArray(loads)) return [];
  return loads
    .map((load) => ({ load, ...scorePairing(load, beacon) }))
    .sort((a, b) => b.score - a.score);
}

/* ----------------------------------------------------------------- award --- */

/**
 * Decide the award of a load from its offers — the pure half of the transaction
 * the route runs.
 *
 * Rules (diagram 05):
 *   - only an open load can be awarded;
 *   - the winning offer must be open and not expired;
 *   - every other open offer is DECLINED (never left dangling);
 *   - the load must carry an order, because the award creates the Trip against
 *     it and nobody re-enters the load.
 * @param {{ load: any, offers: any[], offerId: unknown, now?: Date|string|number }} args
 * @returns {{ ok: true, winnerId: string, declinedIds: string[] } | { ok: false, error: string }}
 */
export function awardPlan({ load, offers, offerId, now = new Date() } = /** @type {any} */ ({})) {
  if (!load) return { ok: false, error: 'load_not_found' };
  if (load.status === 'AWARDED') return { ok: false, error: 'load_awarded' };
  if (!isLoadOpen(load.status)) return { ok: false, error: 'load_closed' };
  if (isExpired(load.expiresAt, now)) return { ok: false, error: 'load_expired' };
  if (!load.orderId) return { ok: false, error: 'order_required' };

  const list = Array.isArray(offers) ? offers : [];
  const winner = list.find((offer) => offer && offer.id === offerId);
  if (!winner) return { ok: false, error: 'offer_not_found' };
  if (winner.status === 'EXPIRED' || isExpired(winner.expiresAt, now)) {
    return { ok: false, error: 'offer_expired' };
  }
  if (!isOfferOpen(winner.status)) return { ok: false, error: 'offer_closed' };

  const declinedIds = list
    .filter((offer) => offer && offer.id !== winner.id && isOfferOpen(offer.status))
    .map((offer) => offer.id);

  return { ok: true, winnerId: winner.id, declinedIds };
}

/**
 * The `Trip` an award creates: the same trip object the carrier already
 * executes, in the CARRIER's org, against the load's order, at the awarded
 * price. A solo driver's personal org (`offer.carrierOrgId`) is the home; the
 * driver becomes the trip's driver when the offer names one.
 * @param {{ load: any, offer: any }} args
 * @returns {any}
 */
export function buildAwardTripData({ load, offer }) {
  return {
    orgId: offer.carrierOrgId,
    orderId: load.orderId,
    driverId: offer.carrierUserId || null,
    truckId: null,
    rateEur: offer.priceEur,
    status: 'DRAFT',
  };
}

/* ------------------------------------------------------------ isolation --- */

/** @param {unknown} permissions @returns {boolean} */
export function canPostLoad(permissions) {
  return hasPermission(permissions, POST_PERMISSION) || hasPermission(permissions, FLEET_POST_PERMISSION);
}

/** @param {unknown} permissions @returns {boolean} */
export function canSupply(permissions) {
  return hasPermission(permissions, SUPPLY_PERMISSION);
}

/**
 * The tenant a load belongs to: a customer id or an org id (exactly one is set).
 * @param {any} load
 * @returns {{ customerId: string|null, orgId: string|null }}
 */
export function loadScope(load) {
  return {
    customerId: load?.customerId || null,
    orgId: load?.orgId || null,
  };
}

/**
 * Is this principal the load's owner? A customer principal matches `customerId`;
 * an org principal matches `orgId`. Denies by default.
 * @param {any} load
 * @param {{ customerId?: string|null, orgId?: string|null }} principal
 * @returns {boolean}
 */
export function isLoadPoster(load, principal) {
  if (!load || !principal) return false;
  if (load.customerId && principal.customerId) return load.customerId === principal.customerId;
  if (load.orgId && principal.orgId) return load.orgId === principal.orgId;
  return false;
}

/**
 * May this principal read this load? The poster always may; a carrier may read
 * an open load (it is the public board); after the award only the poster and the
 * awarded carrier may.
 * @param {{ load: any, principal: any, permissions?: unknown }} args
 * @returns {boolean}
 */
export function canReadLoad({ load, principal, permissions } = /** @type {any} */ ({})) {
  if (!load) return false;
  if (isLoadPoster(load, principal)) return true;
  if (load.status === 'AWARDED') {
    return false;
  }
  return canSupply(permissions);
}

/**
 * Is this offer made *by* the carrier the principal speaks for?
 * @param {any} offer
 * @param {{ userId?: string|null, orgId?: string|null }} principal
 * @returns {boolean}
 */
export function isCarrierOf(offer, principal) {
  if (!offer || !principal) return false;
  if (principal.orgId && offer.carrierOrgId) return principal.orgId === offer.carrierOrgId;
  if (principal.userId && offer.carrierUserId) return principal.userId === offer.carrierUserId;
  return false;
}

/**
 * May this principal counter this offer? The shipper counters a carrier's offer;
 * the carrier counters a shipper's counter. Nobody else. Denies by default.
 * @param {{ offer: any, load: any, principal: any }} args
 * @returns {boolean}
 */
export function canCounter({ offer, load, principal } = /** @type {any} */ ({})) {
  if (!offer || !isOfferOpen(offer.status)) return false;
  if (offer.side === 'carrier') return isLoadPoster(load, principal);
  if (offer.side === 'shipper') return isCarrierOf(offer, principal);
  return false;
}

/**
 * May this principal award or decline this offer? Only the load's owner.
 * @param {{ offer: any, load: any, principal: any }} args
 * @returns {boolean}
 */
export function canDecideOffer({ offer, load, principal } = /** @type {any} */ ({})) {
  if (!offer || !load) return false;
  return isLoadPoster(load, principal);
}

/**
 * May this principal withdraw this offer? Only the carrier that made a
 * carrier-side offer may withdraw it.
 * @param {{ offer: any, principal: any }} args
 * @returns {boolean}
 */
export function canWithdrawOffer({ offer, principal } = /** @type {any} */ ({})) {
  if (!offer || offer.side !== 'carrier' || !isOfferOpen(offer.status)) return false;
  return isCarrierOf(offer, principal);
}

/* ------------------------------------------------------------ read model --- */

/**
 * The comparable card a client renders (diagram 05: price · pickup ETA ·
 * delivery ETA · note · verification badge). No credential, no relation dump.
 * @param {any} offer
 * @returns {any|null}
 */
export function offerCard(offer) {
  if (!offer || typeof offer !== 'object') return null;
  return {
    id: offer.id,
    loadId: offer.loadId,
    side: offer.side || 'carrier',
    carrierOrgId: offer.carrierOrgId || null,
    carrierUserId: offer.carrierUserId || null,
    carrierName: offer.carrierName || null,
    priceEur: offer.priceEur ?? null,
    pickupEtaAt: offer.pickupEtaAt || null,
    deliveryEtaAt: offer.deliveryEtaAt || null,
    note: offer.note || null,
    status: offer.status || null,
    parentOfferId: offer.parentOfferId || null,
    expiresAt: offer.expiresAt || null,
    createdAt: offer.createdAt || null,
  };
}

/**
 * The cards for a set of offers, cheapest first — the honest side-by-side order
 * the compare screen (#78) starts from.
 * @param {any[]} offers
 * @returns {any[]}
 */
export function offerCards(offers) {
  if (!Array.isArray(offers)) return [];
  return offers
    .map(offerCard)
    .filter(Boolean)
    .sort((a, b) => Number(a.priceEur ?? 0) - Number(b.priceEur ?? 0));
}

/**
 * The load card for the feed: the demand, its pricing and its window — never the
 * poster's internals.
 * @param {any} load
 * @returns {any|null}
 */
export function loadCard(load) {
  if (!load || typeof load !== 'object') return null;
  return {
    id: load.id,
    origin: load.origin,
    destination: load.destination,
    cargo: load.cargo || null,
    equipment: load.equipment || null,
    loadReadyAt: load.loadReadyAt || null,
    deliverByAt: load.deliverByAt || null,
    pricingMode: load.pricingMode || 'quotes',
    priceEur: load.priceEur ?? null,
    status: load.status,
    expiresAt: load.expiresAt || null,
    createdAt: load.createdAt || null,
  };
}
