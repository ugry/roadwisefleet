/**
 * RoadwiseFleet Fleet Manager — assign / reassign driver (board task #36, FAv1-F5).
 *
 * The pure half of the trip-detail driver control: which drivers may be offered,
 * what the form is allowed to submit, and how an API refusal reads back. The
 * server is authoritative — it enforces `trip:assign`, the org boundary and the
 * driver's availability — and this module makes the UI agree with it rather than
 * paraphrase it.
 *
 * Loaded twice, on purpose, exactly like `app-core.js`:
 *   - in the browser, as a classic script (`<script src="lib/assign.js">`),
 *     which exposes `window.RoadwiseAssign`;
 *   - in the API test suite (`apps/api/src/assign-form.test.js`), so the
 *     validation and the error mapping are covered by
 *     `node --test apps/api/src/` with no install and no browser.
 *
 * Nothing here touches the DOM, the network, storage or the clock.
 * ES5-compatible syntax: the app targets cheap Android WebViews.
 *
 * Reassignment keeps the trip's status, so the server records it as a status
 * event whose `from` and `to` are the same (`isReassignment`). A normal
 * lifecycle move always changes the status.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.RoadwiseAssign = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** Statuses after which no driver may be assigned — mirrors `trip-status.js`. */
  var CLOSED_STATUSES = ['SETTLED', 'CANCELLED'];

  /**
   * @param {unknown} value
   * @returns {string} trimmed string, never null/undefined
   */
  function text(value) {
    return value === null || value === undefined ? '' : String(value).trim();
  }

  /** @param {unknown} value @returns {any[]} */
  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  /**
   * The path of the assignment endpoint for one trip. The id is encoded, so a
   * trip id can never change the request path.
   * @param {unknown} tripId
   * @returns {string}
   */
  function assignPath(tripId) {
    return '/api/trips/' + encodeURIComponent(text(tripId)) + '/assign';
  }

  /**
   * Has the trip's lifecycle ended? A settled/cancelled trip takes no driver
   * change — the server refuses it with `trip_closed`; the UI hides the control.
   * @param {unknown} status
   * @returns {boolean}
   */
  function isClosed(status) {
    return CLOSED_STATUSES.indexOf(text(status)) !== -1;
  }

  /**
   * Is this status event a driver reassignment? Reassignment keeps the status,
   * so `from === to`; a lifecycle transition always changes it.
   * @param {any} event
   * @returns {boolean}
   */
  function isReassignment(event) {
    if (!event || typeof event !== 'object') return false;
    var from = text(event.from);
    var to = text(event.to);
    return from !== '' && from === to;
  }

  /**
   * The `<select>` entries for the assignable drivers. The current driver is
   * marked selected so the control opens on the truth; a driver already on the
   * trip is still listed (choosing it is refused as `already_assigned` rather
   * than silently doing nothing).
   * @param {any[]} drivers
   * @param {unknown} [currentDriverId]
   * @returns {Array<{ value: string, label: string, selected: boolean }>}
   */
  function driverEntries(drivers, currentDriverId) {
    var current = text(currentDriverId);
    var list = asArray(drivers);
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var driver = list[i] || {};
      var name = text(driver.name) || text(driver.email) || text(driver.id);
      var phone = text(driver.phone);
      var id = text(driver.id);
      out.push({ value: id, label: phone ? name + ' · ' + phone : name, selected: id !== '' && id === current });
    }
    return out;
  }

  /**
   * Validate the control BEFORE a request is sent, so every message says what to
   * fix. `values.driverId` is the raw form value; `drivers` is the loaded
   * reference list; `trip` is the detail payload.
   * @param {{ driverId?: unknown }} [values]
   * @param {any} [trip]
   * @param {any[]} [drivers]
   * @returns {{ ok: true, payload: { driverId: string } } | { ok: false, errors: { driverId: string } }}
   */
  function validateAssign(values, trip, drivers) {
    var v = values || {};
    var driverId = text(v.driverId);
    var errors = {};

    if (!driverId) {
      errors.driverId = 'assign.error.required';
    } else if (!findDriver(drivers, driverId)) {
      errors.driverId = 'assign.error.unknownDriver';
    } else if (trip && text(trip.driverId || (trip.driver && trip.driver.id)) === driverId) {
      errors.driverId = 'assign.error.alreadyAssigned';
    } else if (trip && isClosed(trip.status)) {
      errors.driverId = 'assign.error.tripClosed';
    }

    if (Object.keys(errors).length) return { ok: false, errors: errors };
    return { ok: true, payload: { driverId: driverId } };
  }

  /**
   * @param {unknown} drivers
   * @param {string} id
   * @returns {any|null}
   */
  function findDriver(drivers, id) {
    var wanted = text(id);
    if (!wanted) return null;
    var list = asArray(drivers);
    for (var i = 0; i < list.length; i++) {
      if (list[i] && text(list[i].id) === wanted) return list[i];
    }
    return null;
  }

  /** API error code -> catalogue key. Every key exists in `locales/en.json`. */
  var ERROR_KEYS = {
    invalid_input: 'assign.error.invalidInput',
    not_found: 'assign.error.tripNotFound',
    driver_not_found: 'assign.error.driverNotFound',
    driver_unavailable: 'assign.error.driverUnavailable',
    already_assigned: 'assign.error.alreadyAssigned',
    trip_closed: 'assign.error.tripClosed',
    forbidden: 'error.forbidden',
    no_org: 'error.noOrg'
  };

  /**
   * Map an assignment failure to a catalogue key that says what to do next.
   * Never returns a raw status code to the screen.
   * @param {{ status?: number, data?: any }|null} res
   * @returns {string}
   */
  function assignErrorKey(res) {
    var status = res ? res.status : 0;
    if (status === 401) return 'error.sessionExpired';
    if (status === 429) return 'error.rateLimited';
    if (status === 0) return 'error.network';
    var code = res && res.data ? res.data.error : null;
    if (typeof code === 'string' && Object.prototype.hasOwnProperty.call(ERROR_KEYS, code)) {
      return ERROR_KEYS[code];
    }
    if (status === 403) return 'error.forbidden';
    if (status === 409) return 'assign.error.conflict';
    if (status === 400) return 'error.badRequest';
    return 'error.unexpected';
  }

  /**
   * The `{ detail }` the API attaches to `invalid_input`, or '' — the message
   * shows it rather than dropping it.
   * @param {{ data?: any }|null} res
   * @returns {string}
   */
  function assignErrorDetail(res) {
    var detail = res && res.data ? res.data.detail : null;
    return typeof detail === 'string' ? detail : '';
  }

  return {
    CLOSED_STATUSES: CLOSED_STATUSES,
    assignPath: assignPath,
    isClosed: isClosed,
    isReassignment: isReassignment,
    driverEntries: driverEntries,
    validateAssign: validateAssign,
    findDriver: findDriver,
    assignErrorKey: assignErrorKey,
    assignErrorDetail: assignErrorDetail
  };
});
