/**
 * RoadwiseFleet Fleet Manager — trips view model (board task #34, FAv1-F3).
 *
 * The pure half of the trips list/detail screens: filter normalisation, the
 * query string sent to `GET /api/trips`, the CSV export, and the flat row the
 * table and the CSV both read. Loaded twice, on purpose, exactly like
 * `app-core.js`:
 *
 *   - in the browser, as a classic script (`<script src="lib/trips.js">`),
 *     exposing `window.RoadwiseTrips`;
 *   - in the API test suite (`apps/api/src/trips-view.test.js`), so the
 *     filter/CSV behaviour is covered by `node --test apps/api/src/` with no
 *     install and no browser.
 *
 * Nothing here touches the DOM, the network, storage or the clock (the caller
 * passes `now`). ES5-compatible syntax: the app targets cheap Android WebViews.
 */

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.RoadwiseTrips = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** Every status the state machine can hold, in lifecycle order. */
  var TRIP_STATUSES = [
    'DRAFT', 'ASSIGNED', 'LOADED', 'IN_TRANSIT',
    'DELIVERED', 'POD_UPLOADED', 'INVOICED', 'SETTLED', 'CANCELLED'
  ];

  /** The order the query string is built in, so the same filters give one URL. */
  var FILTER_KEYS = ['status', 'driverId', 'from', 'to', 'q'];

  /**
   * The CSV header — stable machine names, not localised labels: the export is
   * data, and the same file must parse the same way in any locale.
   */
  var CSV_COLUMNS = ['id', 'status', 'origin', 'destination', 'customer', 'driver', 'truck', 'rate_eur', 'created_at'];

  function text(value) {
    return value === null || value === undefined ? '' : String(value);
  }

  /**
   * Trim the raw form values into the filter set. Unknown keys are dropped;
   * empty values mean "no filter".
   * @param {Record<string, unknown>} [raw]
   * @returns {{ status?: string, driverId?: string, from?: string, to?: string, q?: string }}
   */
  function normalizeFilters(raw) {
    var input = raw && typeof raw === 'object' ? raw : {};
    var out = {};
    for (var i = 0; i < FILTER_KEYS.length; i++) {
      var key = FILTER_KEYS[i];
      var value = input[key];
      if (value === null || value === undefined) continue;
      var trimmed = String(value).trim();
      if (trimmed !== '') out[key] = trimmed;
    }
    return out;
  }

  /**
   * The filtered request path. Only present filters are sent, in a fixed order,
   * each value encoded — a filter string can never change the path.
   * @param {Record<string, unknown>} [filters]
   * @returns {string}
   */
  function buildQuery(filters) {
    var clean = normalizeFilters(filters);
    var parts = [];
    for (var i = 0; i < FILTER_KEYS.length; i++) {
      var key = FILTER_KEYS[i];
      if (Object.prototype.hasOwnProperty.call(clean, key)) {
        parts.push(key + '=' + encodeURIComponent(clean[key]));
      }
    }
    return parts.length ? '?' + parts.join('&') : '';
  }

  /**
   * `GET /api/trips` for a filter set.
   * @param {Record<string, unknown>} [filters]
   * @returns {string}
   */
  function tripsPath(filters) {
    return '/api/trips' + buildQuery(filters);
  }

  /** @param {unknown} value @returns {number|null} */
  function toNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    var n = typeof value === 'number' ? value : Number(value);
    return isFinite(n) ? n : null;
  }

  /**
   * One raw API trip as the flat row the table and the CSV share. Never throws
   * on a missing relation — an empty string is the "no value" cell.
   * @param {any} trip
   * @returns {{ id: string, status: string, origin: string, destination: string, customer: string, driver: string, truck: string, rate_eur: string, created_at: string }}
   */
  function tripRow(trip) {
    var t = trip && typeof trip === 'object' ? trip : {};
    var order = t.order && typeof t.order === 'object' ? t.order : {};
    var customer = order.customer && typeof order.customer === 'object' ? order.customer : {};
    var driver = t.driver && typeof t.driver === 'object' ? t.driver : {};
    var truck = t.truck && typeof t.truck === 'object' ? t.truck : {};
    var rate = toNumber(t.rateEur);
    return {
      id: text(t.id),
      status: text(t.status),
      origin: text(order.origin),
      destination: text(order.destination),
      customer: text(customer.name),
      driver: text(driver.name || driver.email || t.driverId),
      truck: text(truck.plate || t.truckId),
      rate_eur: rate === null ? '' : String(rate),
      created_at: text(t.createdAt)
    };
  }

  /** RFC 4180: quote when the value holds a delimiter, a quote or a newline. */
  function csvCell(value) {
    var s = text(value);
    if (/[",\r\n]/.test(s)) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  /**
   * The CSV text for the rows exactly as the list shows them, so the file is
   * row-for-row the filtered list by construction. `\r\n` line endings and a
   * trailing newline: what spreadsheets expect.
   * @param {any[]} trips
   * @returns {string}
   */
  function toCsv(trips) {
    var rows = (Array.isArray(trips) ? trips : []).map(tripRow);
    var lines = [CSV_COLUMNS.join(',')];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var cells = [];
      for (var c = 0; c < CSV_COLUMNS.length; c++) {
        cells.push(csvCell(row[CSV_COLUMNS[c]]));
      }
      lines.push(cells.join(','));
    }
    return lines.join('\r\n') + '\r\n';
  }

  /**
   * The export file name, UTC-dated so two exports on different days never
   * collide.
   * @param {Date|string|number} [now]
   * @returns {string}
   */
  function csvFileName(now) {
    var date = now instanceof Date ? now : new Date(now === undefined ? Date.now() : now);
    if (isNaN(date.getTime())) date = new Date(0);
    var iso = date.toISOString().slice(0, 10);
    return 'roadwisefleet-trips-' + iso + '.csv';
  }

  /**
   * The empty-state catalogue key: with filters applied an empty list means
   * "nothing matched", without filters it means "no trips yet".
   * @param {Record<string, unknown>} [filters]
   * @returns {string}
   */
  function emptyStateKey(filters) {
    var clean = normalizeFilters(filters);
    for (var i = 0; i < FILTER_KEYS.length; i++) {
      if (Object.prototype.hasOwnProperty.call(clean, FILTER_KEYS[i])) return 'trips.emptyFiltered';
    }
    return 'trips.empty';
  }

  /** The catalogue key for a status pill / option. */
  function statusKey(status) {
    return 'trips.status.' + text(status);
  }

  return {
    TRIP_STATUSES: TRIP_STATUSES,
    FILTER_KEYS: FILTER_KEYS,
    CSV_COLUMNS: CSV_COLUMNS,
    normalizeFilters: normalizeFilters,
    buildQuery: buildQuery,
    tripsPath: tripsPath,
    toNumber: toNumber,
    tripRow: tripRow,
    toCsv: toCsv,
    csvFileName: csvFileName,
    emptyStateKey: emptyStateKey,
    statusKey: statusKey
  };
});
