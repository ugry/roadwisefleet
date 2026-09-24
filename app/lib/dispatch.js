/**
 * RoadwiseFleet Fleet Manager — dispatch create-trip form (board task #35, FAv1-F4).
 *
 * The form the dispatcher actually uses: pick an order, a driver and a truck
 * from the org's own lists (`GET /api/reference`) instead of typing raw ids, and
 * hand the API exactly the body it documents (`POST /api/trips` takes
 * `orderId`, `driverId`, `truckId`, `rateEur` and the optional `plannedAt` — the
 * promised delivery time recorded on the order, board task #66).
 *
 * Loaded twice, on purpose, exactly like `app-core.js`:
 *   - in the browser, as a classic script (`<script src="lib/dispatch.js">`),
 *     which exposes `window.RoadwiseDispatch`;
 *   - in the API test suite (`apps/api/src/dispatch-form.test.js`), so the
 *     validation, the option labels and the error mapping are covered by
 *     `node --test apps/api/src/` with no install and no browser.
 *
 * Nothing here touches the DOM, the network, storage or the clock: this is the
 * decision logic only. `app.js` owns the DOM and the session; ES5-compatible
 * syntax because the pilot targets cheap Android WebViews.
 *
 * The customer is never a free choice: it belongs to the selected order. The
 * form shows it read-only and this module rejects a payload whose customer does
 * not match the order (`dispatch.error.customerMismatch`), so a stale or
 * hand-edited form cannot dispatch an order under the wrong customer.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.RoadwiseDispatch = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** The status `POST /api/trips` gives a new trip — the form says so plainly. */
  var CREATED_STATUS = 'DRAFT';

  /**
   * @param {unknown} value
   * @returns {string} trimmed string, never null/undefined
   */
  function text(value) {
    return value === null || value === undefined ? '' : String(value).trim();
  }

  /**
   * @param {unknown} value
   * @returns {any[]}
   */
  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  /**
   * Normalise a `GET /api/reference` payload (or `null` while it loads) into the
   * four option lists, so the renderer never reads a missing property.
   * @param {unknown} reference
   * @returns {{ orders: any[], drivers: any[], trucks: any[], customers: any[] }}
   */
  function referenceState(reference) {
    var r = reference && typeof reference === 'object' ? reference : {};
    return {
      orders: asArray(r.orders),
      drivers: asArray(r.drivers),
      trucks: asArray(r.trucks),
      customers: asArray(r.customers)
    };
  }

  /**
   * @param {any} order
   * @returns {string} human label for an order option — never a raw id.
   */
  function orderLabel(order) {
    if (!order) return '';
    var route = text(order.origin) + ' → ' + text(order.destination);
    var customer = order.customer ? text(order.customer.name) : '';
    return customer ? route + ' · ' + customer : route;
  }

  /**
   * @param {any} driver
   * @returns {string}
   */
  function driverLabel(driver) {
    if (!driver) return '';
    var name = text(driver.name) || text(driver.email);
    var phone = text(driver.phone);
    return phone ? name + ' · ' + phone : name;
  }

  /**
   * @param {any} truck
   * @returns {string}
   */
  function truckLabel(truck) {
    if (!truck) return '';
    var plate = text(truck.plate);
    var dimensions = text(truck.dimensions);
    return dimensions ? plate + ' · ' + dimensions : plate;
  }

  /**
   * @param {any} customer
   * @returns {string}
   */
  function customerLabel(customer) {
    return customer ? text(customer.name) : '';
  }

  /**
   * The `<select>` entries for one list. `kind` is `order|driver|truck|customer`
   * and only picks the label formatter; an unknown kind falls back to the name.
   * @param {any[]} items
   * @param {string} kind
   * @returns {Array<{ value: string, label: string }>}
   */
  function optionEntries(items, kind) {
    var list = asArray(items);
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var item = list[i] || {};
      var label;
      if (kind === 'order') label = orderLabel(item);
      else if (kind === 'driver') label = driverLabel(item);
      else if (kind === 'truck') label = truckLabel(item);
      else if (kind === 'customer') label = customerLabel(item);
      else label = text(item.name);
      out.push({ value: text(item.id), label: label });
    }
    return out;
  }

  /**
   * @param {any[]} list
   * @param {string} id
   * @returns {any|null}
   */
  function findById(list, id) {
    var wanted = text(id);
    if (!wanted) return null;
    var items = asArray(list);
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (item && text(item.id) === wanted) return item;
    }
    return null;
  }

  /**
   * The exact JSON body `POST /api/trips` documents. Empty optional fields are
   * `null`, not `''`, so the API's own validation sees what it expects.
   *
   * `plannedAt` (board task #66) is the one optional field that is OMITTED when
   * empty rather than sent as `null`: it is the promised delivery time recorded
   * on the order, and the API treats "absent" and "null" as "no plan". Sending
   * it only when the dispatcher actually chose a time keeps the original F4
   * contract byte-for-byte for a form that leaves it blank.
   * @param {{ orderId?: unknown, driverId?: unknown, truckId?: unknown, rateEur?: unknown, plannedAt?: unknown }} values
   * @returns {{ orderId: string, driverId: string|null, truckId: string|null, rateEur: number|null, plannedAt?: string }}
   */
  function buildCreateTripPayload(values) {
    var v = values || {};
    var rate = null;
    if (v.rateEur !== null && v.rateEur !== undefined && text(v.rateEur) !== '') {
      var n = Number(v.rateEur);
      if (isFinite(n) && n >= 0) rate = n;
    }
    var payload = {
      orderId: text(v.orderId),
      driverId: text(v.driverId) || null,
      truckId: text(v.truckId) || null,
      rateEur: rate
    };
    var planned = plannedIso(v.plannedAt);
    if (planned) payload.plannedAt = planned;
    return payload;
  }

  /**
   * Coerce a form date/time (`datetime-local` value or any Date-parseable string)
   * to an ISO-8601 instant, or null when empty/invalid. Empty means "no plan".
   * @param {unknown} value
   * @returns {string|null}
   */
  function plannedIso(value) {
    if (value === null || value === undefined || text(value) === '') return null;
    var d = new Date(text(value));
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  /**
   * Validate the form BEFORE a request is sent, so the common mistakes are
   * caught client-side and every message says what to fix. Values are the raw
   * form strings; `reference` is the `GET /api/reference` payload.
   * @param {Record<string, unknown>} [values]
   * @param {unknown} [reference]
   * @returns {{ ok: true, payload: any, order: any, rateEur: number|null }
   *   | { ok: false, errors: Record<string, string> }}
   */
  function validateDispatchForm(values, reference) {
    var v = values || {};
    var ref = referenceState(reference);
    /** @type {Record<string, string>} */
    var errors = {};

    var orderId = text(v.orderId);
    var order = orderId ? findById(ref.orders, orderId) : null;
    if (!orderId) errors.orderId = 'dispatch.error.orderRequired';
    else if (!order) errors.orderId = 'dispatch.error.orderUnknown';

    var driverId = text(v.driverId);
    if (driverId && !findById(ref.drivers, driverId)) {
      errors.driverId = 'dispatch.error.driverUnknown';
    }

    var truckId = text(v.truckId);
    if (truckId && !findById(ref.trucks, truckId)) {
      errors.truckId = 'dispatch.error.truckUnknown';
    }

    var rateEur = null;
    if (v.rateEur !== null && v.rateEur !== undefined && text(v.rateEur) !== '') {
      var n = Number(v.rateEur);
      if (!isFinite(n) || n < 0) errors.rateEur = 'dispatch.error.rate';
      else rateEur = n;
    }

    // The customer belongs to the order: a form whose shown customer no longer
    // matches the selected order is stale and must not be dispatched.
    var customerId = text(v.customerId);
    var orderCustomerId = order && order.customer ? text(order.customer.id) : '';
    if (order && orderCustomerId && customerId && customerId !== orderCustomerId) {
      errors.customerId = 'dispatch.error.customerMismatch';
    }

    // The promised delivery time (board task #66) is optional; a value that is
    // present but not a real date/time is refused rather than sent and rejected.
    var plannedInput = text(v.plannedAt);
    if (plannedInput && !plannedIso(plannedInput)) {
      errors.plannedAt = 'dispatch.error.plannedAt';
    }

    for (var key in errors) {
      if (Object.prototype.hasOwnProperty.call(errors, key)) return { ok: false, errors: errors };
    }

    return {
      ok: true,
      payload: buildCreateTripPayload({ orderId: orderId, driverId: driverId, truckId: truckId, rateEur: rateEur, plannedAt: plannedInput }),
      order: order,
      rateEur: rateEur
    };
  }

  /** API error code -> catalogue key. Every key exists in `locales/en.json`. */
  var ERROR_KEYS = {
    invalid_input: 'dispatch.error.invalidInput',
    order_not_found: 'dispatch.error.orderNotFound',
    driver_not_found: 'dispatch.error.driverNotFound',
    truck_not_found: 'dispatch.error.truckNotFound',
    forbidden: 'error.forbidden',
    no_org: 'error.noOrg'
  };

  /**
   * Map a `POST /api/trips` failure to a catalogue key that says what to do
   * next. Never returns a raw status code to the screen.
   * @param {{ status?: number, data?: any }|null} res
   * @returns {string}
   */
  function createTripErrorKey(res) {
    var status = res ? res.status : 0;
    if (status === 401) return 'error.sessionExpired';
    if (status === 429) return 'error.rateLimited';
    if (status === 0) return 'error.network';
    var code = res && res.data ? res.data.error : null;
    if (typeof code === 'string' && Object.prototype.hasOwnProperty.call(ERROR_KEYS, code)) {
      return ERROR_KEYS[code];
    }
    if (status === 403) return 'error.forbidden';
    if (status === 400) return 'error.badRequest';
    return 'error.unexpected';
  }

  /**
   * The `{ detail }` the API attaches to `invalid_input`, or '' — the form shows
   * it inside the readable message rather than dropping it.
   * @param {{ data?: any }|null} res
   * @returns {string}
   */
  function errorDetail(res) {
    var detail = res && res.data ? res.data.detail : null;
    return typeof detail === 'string' ? detail : '';
  }

  return {
    CREATED_STATUS: CREATED_STATUS,
    referenceState: referenceState,
    orderLabel: orderLabel,
    driverLabel: driverLabel,
    truckLabel: truckLabel,
    customerLabel: customerLabel,
    optionEntries: optionEntries,
    findById: findById,
    buildCreateTripPayload: buildCreateTripPayload,
    plannedIso: plannedIso,
    validateDispatchForm: validateDispatchForm,
    createTripErrorKey: createTripErrorKey,
    errorDetail: errorDetail
  };
});
