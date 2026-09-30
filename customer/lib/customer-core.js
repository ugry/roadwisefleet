/**
 * RoadwiseFleet customer portal — core domain (board task #74, UXF-C1).
 *
 * The customer side of the product (diagrams `docs/ux-flows/01-customer-flow.mmd`
 * and `06-offplatform-customers.mmd`): signup data, the book-a-load wizard with
 * its explicit supply choice, and the read model the shipments list renders.
 *
 * Loaded twice, on purpose:
 *   - in the browser, as an ES module (`<script type="module" src="/c/customer.js">`
 *     imports it), exposed as `window.RoadwiseCustomer` for the harness;
 *   - in the API (`apps/api/src/routes/customer.ts`) and its test suite, so the
 *     browser and the server validate the SAME payload with the SAME rules —
 *     the client can never be "more permissive" than the API.
 *
 * Nothing here touches the DOM, the network, storage or the clock (except an
 * injectable date), so it is covered by `node --test apps/api/src/` with no
 * install and no browser. Plain ES5-compatible syntax inside the functions: the
 * pilot targets cheap Android WebViews.
 *
 * Supply choice (the owner's first requirement: the customer chooses how to
 * ship). Two of the five paths are bookable today — a carrier that is already on
 * RoadwiseFleet (own carrier, direct booking) and one that is not (off-platform,
 * job link). The marketplace paths (find a fleet / find a solo driver /
 * auto-match / recurring contract) are reachable and explained, and return an
 * honest "marketplace opens with UXF-M1 (#76)" answer instead of a dead end.
 */

/**
 * The role a customer login holds. Created by the deploy path —
 * `prisma/migrations/20260929230000_add_customer_role` (a migration is the only
 * step the deployer is guaranteed to run; see the PR #67 review of 2026-09-29) —
 * and re-asserted idempotently by the signup transaction, so a missing row can
 * never turn a signup into a foreign-key error (Prisma P2003) again.
 */
export const CUSTOMER_ROLE = 'customer';

/**
 * The permission set of `CUSTOMER_ROLE`. One source of truth for the migration
 * SQL, the signup transaction, the seeder and the tests — a customer login may
 * create and read its OWN orders and manage its own account, and holds no
 * `org:*` / `trip:*`, so no org-scoped route is reachable with its token.
 * `apps/api/src/customer-role.test.js` fails if the migration drifts from this.
 */
export const CUSTOMER_PERMISSIONS = ['order:create', 'order:read', 'customer:manage'];

/** The marketplace task that unblocks the fleet/solo/auto/recurring paths. */
export const MARKETPLACE_TASK = 'UXF-M1 (#76)';

/**
 * The five supply choices of diagram 01 stage 3, in the order the wizard
 * offers them. `bookable` = the path creates an Order today; the rest answer
 * with `marketplaceNotice()` and offer the fallback.
 */
export const SUPPLY_CHOICES = [
  {
    id: 'fleet',
    i18n: 'book.supply.fleet',
    descI18n: 'book.supply.fleetDesc',
    bookable: false,
    marketplace: true
  },
  {
    id: 'solo',
    i18n: 'book.supply.solo',
    descI18n: 'book.supply.soloDesc',
    bookable: false,
    marketplace: true
  },
  {
    id: 'auto',
    i18n: 'book.supply.auto',
    descI18n: 'book.supply.autoDesc',
    bookable: false,
    marketplace: true
  },
  {
    id: 'own_carrier',
    i18n: 'book.supply.ownCarrier',
    descI18n: 'book.supply.ownCarrierDesc',
    bookable: true,
    marketplace: false
  },
  {
    id: 'recurring',
    i18n: 'book.supply.recurring',
    descI18n: 'book.supply.recurringDesc',
    bookable: false,
    marketplace: true
  }
];

/** Path ④ has a second face: the saved carrier is not registered. */
export const OFF_PLATFORM_CHOICE = {
  id: 'off_platform',
  i18n: 'book.supply.offPlatform',
  descI18n: 'book.supply.offPlatformDesc',
  bookable: true,
  marketplace: false
};

/** All accepted `supplyChoice` values (the wizard's five + the off-platform case). */
export const SUPPLY_CHOICE_IDS = SUPPLY_CHOICES.map((c) => c.id).concat([OFF_PLATFORM_CHOICE.id]);

/** Equipment list from diagram 01 stage 2 (frozen static list, no lookup table yet). */
export const EQUIPMENT = [
  'curtainsider',
  'reefer',
  'flatbed',
  'box',
  'tanker',
  'tail_lift',
  'adr',
  'container'
];

/** Pricing modes (diagram 01 stage 2, F7). */
export const PRICING_MODES = ['instant', 'quotes', 'budget'];

/** Who pays (diagram 01 stage 2, F8). */
export const PAYERS = ['me', 'consignee', 'third_party'];

/**
 * Payment methods. Escrow is deliberately absent: task #76 fixes "payment
 * first = invoice; escrow waits for UXF-OWN1", so escrow is shown disabled
 * with that reason rather than silently accepted.
 */
export const PAYMENT_METHODS = ['invoice', 'card', 'sepa', 'pay_on_delivery'];

/** Notification channels (diagram 01 registration step). */
export const NOTIFY_CHANNELS = ['email', 'sms', 'whatsapp'];

/** The wizard's stop list cap — enough for a milk run, not a routing engine. */
export const MAX_STOPS = 5;

/** Free-text cap, so a paste of a whole document cannot reach the database. */
export const MAX_TEXT = 500;

/* --------------------------------------------------------------- helpers --- */

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Trim and cap a free-text value.
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
function text(value, max) {
  if (value === null || value === undefined) return '';
  const cap = max || MAX_TEXT;
  const s = String(value).trim();
  return s.length > cap ? s.slice(0, cap) : s;
}

/**
 * Coerce an optional non-negative number. `''`/null/undefined → null.
 * @param {unknown} value
 * @returns {{ ok: true, value: number|null } | { ok: false }}
 */
function optionalNumber(value) {
  if (value === null || value === undefined || value === '') return { ok: true, value: null };
  const n = typeof value === 'number' ? value : Number(String(value).trim().replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) return { ok: false };
  return { ok: true, value: n };
}

/**
 * Coerce an optional whole number ≥ 0.
 * @param {unknown} value
 * @returns {{ ok: true, value: number|null } | { ok: false }}
 */
function optionalInt(value) {
  const n = optionalNumber(value);
  if (!n.ok) return n;
  if (n.value === null) return { ok: true, value: null };
  if (Math.floor(n.value) !== n.value) return { ok: false };
  return { ok: true, value: n.value };
}

/**
 * Parse an optional date. Empty → null; anything present must parse, so a typo
 * can never store an Invalid Date (the #66 `plannedAt` rule).
 * @param {unknown} value
 * @returns {{ ok: true, value: Date|null } | { ok: false }}
 */
function optionalDate(value) {
  if (value === null || value === undefined || value === '') return { ok: true, value: null };
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return { ok: false };
  return { ok: true, value: date };
}

/**
 * A loose but real email check; the API is authoritative, this is UX.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidEmail(value) {
  if (typeof value !== 'string') return false;
  const s = value.trim();
  if (s.length < 5 || s.length > 200) return false;
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(s);
}

/**
 * A loose phone check: 7–20 chars, digits plus space/+/()-/ separators.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isPlausiblePhone(value) {
  if (typeof value !== 'string') return false;
  const s = value.trim();
  return s.length >= 7 && s.length <= 20 && /^[+()\d][\d\s()+/-]*$/.test(s);
}

/* ---------------------------------------------------------- supply choice --- */

/**
 * The choice descriptor for an id, `own_carrier`/`off_platform` included.
 * @param {unknown} id
 * @returns {{ id: string, i18n: string, descI18n: string, bookable: boolean, marketplace: boolean }|null}
 */
export function supplyChoiceInfo(id) {
  if (id === OFF_PLATFORM_CHOICE.id) return OFF_PLATFORM_CHOICE;
  for (const choice of SUPPLY_CHOICES) {
    if (choice.id === id) return choice;
  }
  return null;
}

/** @param {unknown} id @returns {boolean} */
export function isKnownChoice(id) {
  return supplyChoiceInfo(id) !== null;
}

/** @param {unknown} id @returns {boolean} */
export function isBookableChoice(id) {
  const info = supplyChoiceInfo(id);
  return Boolean(info && info.bookable);
}

/** @param {unknown} id @returns {boolean} */
export function isMarketplaceChoice(id) {
  const info = supplyChoiceInfo(id);
  return Boolean(info && info.marketplace);
}

/**
 * What the API answers for a marketplace path: not an error, not a dead end —
 * an honest "this opens with UXF-M1" state the UI explains and offers the
 * bookable fallback for.
 * @param {unknown} id
 * @returns {{ code: string, task: string, i18n: string, fallback: string }|null}
 */
export function marketplaceNotice(id) {
  if (!isMarketplaceChoice(id)) return null;
  return {
    code: 'marketplace_unavailable',
    task: MARKETPLACE_TASK,
    i18n: 'book.marketplacePending',
    fallback: 'own_carrier'
  };
}

/* ------------------------------------------------------------- auto-match --- */

/**
 * The owner gate the auto-match toggle waits on (board task #78). The server
 * (`apps/api/src/marketplace.js`) is the authority; this constant only lets the
 * UI name the same gate without a second round trip.
 */
export const AUTO_MATCH_OWNER_GATE = 'UXF-OWN1 (#73 q6)';

/**
 * The empty auto-match rules the screen starts from.
 * @returns {{ enabled: boolean, maxPriceEur: null, minRating: null }}
 */
export function autoMatchDefaults() {
  return { enabled: false, maxPriceEur: null, minRating: null };
}

/* ---------------------------------------------------------------- booking --- */

/**
 * The empty wizard form the UI starts from.
 * @returns {any}
 */
export function initialBooking() {
  return {
    origin: '',
    destination: '',
    stops: [],
    cargo: '',
    weightKg: '',
    pallets: '',
    equipment: '',
    loadReadyAt: '',
    deliverByAt: '',
    specialRequirements: '',
    pricingMode: 'instant',
    budgetEur: '',
    payer: 'me',
    paymentMethod: 'invoice',
    insuranceValueEur: '',
    supplyChoice: '',
    offPlatform: false
  };
}

/**
 * An invalid-payload result. `field` drives focus, `messageKey` the copy.
 * @param {string} field
 * @param {string} messageKey
 * @param {string} [detail]
 * @returns {any}
 */
function fail(field, messageKey, detail) {
  return { ok: false, error: 'invalid_input', field, messageKey, detail: detail || messageKey };
}

/**
 * Validate and normalise a booking request — the single rule set the browser
 * and the API share.
 * @param {unknown} body
 * @returns {{ ok: true, value: any } | { ok: false, error: string, field: string, messageKey: string, detail: string }}
 */
export function normalizeBooking(body) {
  if (!isObject(body)) return fail('form', 'book.error.formInvalid', 'body must be an object');
  const b = /** @type {Record<string, any>} */ (body);

  const origin = text(b.origin, 200);
  if (!origin) return fail('origin', 'book.error.originRequired', 'origin is required');
  const destination = text(b.destination, 200);
  if (!destination) return fail('destination', 'book.error.destinationRequired', 'destination is required');
  if (origin === destination) {
    return fail('destination', 'book.error.sameRoute', 'destination must differ from origin');
  }

  const choice = typeof b.supplyChoice === 'string' ? b.supplyChoice : '';
  if (!choice) return fail('supplyChoice', 'book.error.supplyRequired', 'supplyChoice is required');
  if (!isKnownChoice(choice)) {
    return fail('supplyChoice', 'book.error.supplyUnknown', 'unknown supplyChoice: ' + choice);
  }

  /** @type {Array<{ kind: string, address: string }>} */
  const stops = [];
  if (b.stops !== undefined && b.stops !== null) {
    if (!Array.isArray(b.stops)) return fail('stops', 'book.error.stopsInvalid', 'stops must be an array');
    if (b.stops.length > MAX_STOPS) {
      return fail('stops', 'book.error.tooManyStops', 'at most ' + MAX_STOPS + ' stops');
    }
    for (const raw of b.stops) {
      if (!isObject(raw)) return fail('stops', 'book.error.stopsInvalid', 'each stop must be an object');
      const stop = /** @type {Record<string, any>} */ (raw);
      const address = text(stop.address, 200);
      if (!address) return fail('stops', 'book.error.stopAddressRequired', 'every stop needs an address');
      const kind = stop.kind === 'pickup' || stop.kind === 'delivery' ? stop.kind : 'checkpoint';
      stops.push({ kind, address });
    }
  }

  const equipment = text(b.equipment, 40);
  if (equipment && !EQUIPMENT.includes(equipment)) {
    return fail('equipment', 'book.error.equipmentUnknown', 'unknown equipment: ' + equipment);
  }

  const loadReadyAt = optionalDate(b.loadReadyAt);
  if (!loadReadyAt.ok) return fail('loadReadyAt', 'book.error.dateInvalid', 'loadReadyAt must be a valid date');
  const deliverByAt = optionalDate(b.deliverByAt);
  if (!deliverByAt.ok) return fail('deliverByAt', 'book.error.dateInvalid', 'deliverByAt must be a valid date');
  if (loadReadyAt.value && deliverByAt.value && deliverByAt.value.getTime() < loadReadyAt.value.getTime()) {
    return fail('deliverByAt', 'book.error.windowOrder', 'deliverByAt must not precede loadReadyAt');
  }

  const pricingMode = text(b.pricingMode, 20) || 'instant';
  if (!PRICING_MODES.includes(pricingMode)) {
    return fail('pricingMode', 'book.error.pricingUnknown', 'unknown pricingMode: ' + pricingMode);
  }
  const budget = optionalNumber(b.budgetEur);
  if (!budget.ok) return fail('budgetEur', 'book.error.amountInvalid', 'budgetEur must be a non-negative number');

  const payer = text(b.payer, 20) || 'me';
  if (!PAYERS.includes(payer)) return fail('payer', 'book.error.payerUnknown', 'unknown payer: ' + payer);

  const paymentMethod = text(b.paymentMethod, 30) || 'invoice';
  if (paymentMethod === 'escrow') {
    // Honest refusal: escrow needs the owner's merchant-of-record answer
    // (UXF-OWN1). The UI shows the option disabled with this reason.
    return fail('paymentMethod', 'book.error.escrowUnavailable', 'escrow is not available yet (UXF-OWN1)');
  }
  if (!PAYMENT_METHODS.includes(paymentMethod)) {
    return fail('paymentMethod', 'book.error.paymentUnknown', 'unknown paymentMethod: ' + paymentMethod);
  }

  const weight = optionalNumber(b.weightKg);
  if (!weight.ok) return fail('weightKg', 'book.error.amountInvalid', 'weightKg must be a non-negative number');
  const pallets = optionalInt(b.pallets);
  if (!pallets.ok) return fail('pallets', 'book.error.amountInvalid', 'pallets must be a non-negative whole number');
  const insurance = optionalNumber(b.insuranceValueEur);
  if (!insurance.ok) {
    return fail('insuranceValueEur', 'book.error.amountInvalid', 'insuranceValueEur must be a non-negative number');
  }

  return {
    ok: true,
    value: {
      supplyChoice: choice,
      origin,
      destination,
      stops,
      cargo: text(b.cargo, 200),
      weightKg: weight.value,
      pallets: pallets.value,
      equipment,
      loadReadyAt: loadReadyAt.value,
      deliverByAt: deliverByAt.value,
      specialRequirements: text(b.specialRequirements),
      notes: text(b.notes),
      pricingMode,
      budgetEur: budget.value,
      payer,
      paymentMethod,
      insuranceValueEur: insurance.value,
      marketplace: isMarketplaceChoice(choice),
      bookable: isBookableChoice(choice)
    }
  };
}

/**
 * The rows a booking creates: the `Order` (the shared demand object) and its
 * `OrderBooking` detail (the wizard fields the marketplace engine will read in
 * #76: stops / pricing / payer / payment / insurance, plus lane-adjacent
 * equipment and windows). Keeping the wizard in its own table is deliberate —
 * the shared `Order` reads (`include: { order: true }`) must not depend on the
 * portal migration.
 * @param {any} value the `normalizeBooking` result
 * @param {{ customerId: string }} args
 * @returns {{ order: any, booking: any }}
 */
export function buildOrderData(value, args) {
  return {
    order: {
      customerId: args.customerId,
      origin: value.origin,
      destination: value.destination,
      cargo: value.cargo || null,
      status: 'BOOKED',
      // The promised delivery time (already on Order, board task #66) is what
      // the on-time KPI compares against.
      plannedAt: value.deliverByAt || null
    },
    booking: {
      supplyChoice: value.supplyChoice,
      equipment: value.equipment || null,
      loadReadyAt: value.loadReadyAt || null,
      deliverByAt: value.deliverByAt || null,
      notes: value.notes || null,
      details: {
        stops: value.stops,
        pricingMode: value.pricingMode,
        budgetEur: value.budgetEur,
        payer: value.payer,
        paymentMethod: value.paymentMethod,
        insuranceValueEur: value.insuranceValueEur,
        specialRequirements: value.specialRequirements,
        bookedVia: 'customer-portal'
      }
    }
  };
}

/**
 * The `Trip` a bookable choice creates: DRAFT and unassigned, so it lands in
 * the fleet manager's trips list for dispatching — the customer never picks a
 * driver and the rate is the carrier's to set.
 * @param {{ orgId: string, orderId: string }} args
 * @returns {any}
 */
export function buildTripData(args) {
  return {
    orgId: args.orgId,
    orderId: args.orderId,
    status: 'DRAFT',
    driverId: null,
    truckId: null,
    rateEur: null
  };
}

/* ------------------------------------------------------------- read model --- */

/**
 * The status key for a catalogue lookup. Trip statuses (trip-status.js) and
 * order statuses share one namespace so the shipments list can render either.
 * @param {unknown} status
 * @returns {string}
 */
export function statusKey(status) {
  const s = typeof status === 'string' ? status.trim().toUpperCase() : '';
  return s ? 'status.' + s : 'status.UNKNOWN';
}

/**
 * The customer-facing summary of an order. Deliberately free of every fleet
 * internal (driver name/phone, truck plate, rate) — the customer sees the
 * route, the state and their own booking, nothing else.
 * @param {any} order a Prisma `Order` with `trips` (selected down)
 * @returns {any|null}
 */
export function orderSummary(order) {
  if (!order || typeof order !== 'object') return null;
  const trips = Array.isArray(order.trips) ? order.trips : [];
  const trip = trips.length > 0 ? trips[0] : null;
  const booking = isObject(order.booking) ? order.booking : null;
  return {
    id: order.id,
    origin: order.origin || '',
    destination: order.destination || '',
    cargo: order.cargo || null,
    status: order.status || 'DRAFT',
    supplyChoice: booking && booking.supplyChoice ? booking.supplyChoice : null,
    createdAt: order.createdAt || null,
    plannedAt: order.plannedAt || null,
    trip: trip
      ? {
          id: trip.id,
          status: trip.status || null,
          deliveredAt: trip.deliveredAt || null
        }
      : null
  };
}

/**
 * The customer-facing detail: the summary plus the booking fields the wizard
 * captured (all of them the customer's own input).
 * @param {any} order
 * @returns {any|null}
 */
export function orderDetail(order) {
  const summary = orderSummary(order);
  if (!summary) return null;
  const booking = isObject(order.booking) ? order.booking : {};
  const details = isObject(booking.details) ? booking.details : {};
  return {
    id: summary.id,
    origin: summary.origin,
    destination: summary.destination,
    cargo: summary.cargo,
    status: summary.status,
    supplyChoice: summary.supplyChoice,
    createdAt: summary.createdAt,
    plannedAt: summary.plannedAt,
    trip: summary.trip,
    booking: {
      stops: Array.isArray(details.stops) ? details.stops : [],
      equipment: booking.equipment || null,
      loadReadyAt: booking.loadReadyAt || null,
      deliverByAt: booking.deliverByAt || null,
      pricingMode: details.pricingMode || null,
      budgetEur: details.budgetEur === undefined ? null : details.budgetEur,
      payer: details.payer || null,
      paymentMethod: details.paymentMethod || null,
      insuranceValueEur: details.insuranceValueEur === undefined ? null : details.insuranceValueEur,
      specialRequirements: details.specialRequirements || '',
      notes: booking.notes || ''
    }
  };
}

/* --------------------------------------------------------------- account --- */

/**
 * The notification preference object, defaulted to email-only.
 * @param {unknown} value
 * @returns {any}
 */
export function normalizeNotifyPrefs(value) {
  const src = isObject(value) ? /** @type {Record<string, any>} */ (value) : {};
  /** @type {Record<string, boolean>} */
  const out = {};
  for (const channel of NOTIFY_CHANNELS) {
    out[channel] = src[channel] === undefined ? channel === 'email' : Boolean(src[channel]);
  }
  return out;
}

/**
 * Validate a signup. Name, email and password are required; company and phone
 * are optional (the diagram's "2 minutes, no paperwork").
 * @param {unknown} body
 * @returns {{ ok: true, value: any } | { ok: false, error: string, field: string, messageKey: string, detail: string }}
 */
export function validateSignup(body) {
  if (!isObject(body)) return fail('form', 'signup.error.formInvalid', 'body must be an object');
  const b = /** @type {Record<string, any>} */ (body);
  const name = text(b.name, 120);
  if (!name) return fail('name', 'signup.error.nameRequired', 'name is required');
  const email = text(b.email, 200).toLowerCase();
  if (!email) return fail('email', 'signup.error.emailRequired', 'email is required');
  if (!isValidEmail(email)) return fail('email', 'signup.error.emailInvalid', 'email is not valid');
  const password = typeof b.password === 'string' ? b.password : '';
  if (password.length < 8) {
    return fail('password', 'signup.error.passwordShort', 'password must be at least 8 characters');
  }
  if (password.length > 200) return fail('password', 'signup.error.passwordLong', 'password is too long');
  const phone = text(b.phone, 30);
  if (phone && !isPlausiblePhone(phone)) {
    return fail('phone', 'signup.error.phoneInvalid', 'phone is not valid');
  }
  return {
    ok: true,
    value: {
      name,
      company: text(b.company, 120),
      email,
      phone: phone || null,
      password,
      notifyPrefs: normalizeNotifyPrefs(b.notifyPrefs)
    }
  };
}

/**
 * Validate a profile update (company data + preferences). Every field is
 * optional on a PATCH; only what is present is applied.
 * @param {unknown} body
 * @returns {{ ok: true, value: any } | { ok: false, error: string, field: string, messageKey: string, detail: string }}
 */
export function normalizeProfile(body) {
  if (!isObject(body)) return fail('form', 'account.error.formInvalid', 'body must be an object');
  const b = /** @type {Record<string, any>} */ (body);
  /** @type {Record<string, any>} */
  const out = {};
  if (b.name !== undefined) {
    const name = text(b.name, 120);
    if (!name) return fail('name', 'account.error.nameRequired', 'name must not be empty');
    out.name = name;
  }
  if (b.company !== undefined) out.company = text(b.company, 120);
  if (b.vatId !== undefined) out.vatId = text(b.vatId, 40);
  if (b.address !== undefined) out.address = text(b.address, 200);
  if (b.notifyPrefs !== undefined) out.notifyPrefs = normalizeNotifyPrefs(b.notifyPrefs);
  return { ok: true, value: out };
}

/**
 * Validate an address-book entry.
 * @param {unknown} body
 * @returns {{ ok: true, value: any } | { ok: false, error: string, field: string, messageKey: string, detail: string }}
 */
export function normalizeAddress(body) {
  if (!isObject(body)) return fail('form', 'account.error.formInvalid', 'body must be an object');
  const b = /** @type {Record<string, any>} */ (body);
  const line1 = text(b.line1, 200);
  if (!line1) return fail('line1', 'account.error.addressRequired', 'line1 is required');
  return {
    ok: true,
    value: {
      label: text(b.label, 60) || 'Address',
      line1,
      city: text(b.city, 80) || null,
      postalCode: text(b.postalCode, 20) || null,
      country: text(b.country, 60) || null,
      isDefault: Boolean(b.isDefault)
    }
  };
}

/* --------------------------------------------------------- access control --- */

/**
 * @param {unknown} roleId
 * @returns {boolean}
 */
export function roleIsCustomer(roleId) {
  return roleId === CUSTOMER_ROLE;
}

/**
 * The tenant rule for the whole customer surface: an order belongs to exactly
 * one customer, and the token's resolved `customerId` must be it. There is no
 * org-wide path here — "not mine" is `not_found`, never `forbidden`.
 * @param {unknown} customerId
 * @param {any} order
 * @returns {boolean}
 */
export function canAccessOrder(customerId, order) {
  if (typeof customerId !== 'string' || !customerId) return false;
  return Boolean(order) && order.customerId === customerId;
}

/**
 * The Prisma `where` for every customer read — the scope is applied
 * server-side from the token, so no request parameter can widen it.
 * @param {string} customerId
 * @returns {{ customerId: string }}
 */
export function customerOrderWhere(customerId) {
  return { customerId };
}
