/**
 * Alternate trip endings — shared view model (board task #127, UXF-O4).
 *
 * Diagram 07 (A3–A6) is the specification. This module is the UI mirror the
 * Fleet Manager (`/app/`), the solo driver surface (`/s/`) and the API tests
 * read, so neither surface can invent a different ending, a different source
 * status or a different recovery edge.
 *
 * It is deliberately pure and dependency-free: no DOM, no network, no clock.
 * The server (`apps/api/src/trip-status.js`) stays authoritative and rejects
 * anything this table gets wrong; a dependency-free test
 * (`apps/api/src/disruptions.test.js`) fails the build if the two drift.
 *
 * UMD, like `driver-core.js`: a browser global (`RoadwiseDisruptions`) and a
 * CJS export for `node --test`. ES5-compatible syntax (cheap Android WebViews).
 */

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.RoadwiseDisruptions = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * One record per ending: the only source statuses it may be entered from
   * (diagram 07), and the one documented recovery target. `reportable` marks
   * the endings an employed driver may set on their own trip.
   */
  var ENDINGS = [
    {
      status: 'REFUSED',
      sources: ['AT_PICKUP'],
      resumeTo: 'LOADED',
      reportable: true,
    },
    {
      status: 'BREAKDOWN',
      sources: ['EN_ROUTE'],
      resumeTo: 'EN_ROUTE',
      reportable: true,
    },
    {
      status: 'DELAYED',
      sources: ['IN_TRANSIT'],
      resumeTo: 'IN_TRANSIT',
      reportable: false,
    },
    {
      status: 'CUSTOMS_HOLD',
      sources: ['AT_DELIVERY'],
      resumeTo: 'AT_DELIVERY',
      reportable: false,
    },
  ];

  /** The four ending statuses, in table order. */
  var ENDING_STATUSES = ENDINGS.map(function (e) {
    return e.status;
  });

  /** @param {unknown} status @returns {string} */
  function norm(status) {
    return typeof status === 'string' ? status.trim().toUpperCase() : '';
  }

  /**
   * The record for an ending, as a fresh object so a caller mutating it cannot
   * corrupt the table for every later caller.
   * @param {unknown} status
   * @returns {{ status: string, sources: string[], resumeTo: string, reportable: boolean }|null}
   */
  function ending(status) {
    var s = norm(status);
    for (var i = 0; i < ENDINGS.length; i += 1) {
      if (ENDINGS[i].status === s) {
        return {
          status: ENDINGS[i].status,
          sources: ENDINGS[i].sources.slice(),
          resumeTo: ENDINGS[i].resumeTo,
          reportable: ENDINGS[i].reportable,
        };
      }
    }
    return null;
  }

  /** @param {unknown} status @returns {boolean} */
  function isEnding(status) {
    return ending(status) !== null;
  }

  /**
   * The endings that may be entered from `from`, in table order. `carrier`
   * (a role with `trip:*` — owner, dispatcher, or a solo driver acting as their
   * own carrier) sees all of them; an employed driver sees only the reportable
   * ones, because the server refuses the rest.
   * @param {unknown} from
   * @param {boolean} [carrier]
   * @returns {string[]}
   */
  function endingsFrom(from, carrier) {
    var s = norm(from);
    if (!s) return [];
    var out = [];
    for (var i = 0; i < ENDINGS.length; i += 1) {
      var e = ENDINGS[i];
      if (e.sources.indexOf(s) === -1) continue;
      if (!carrier && !e.reportable) continue;
      out.push(e.status);
    }
    return out;
  }

  /**
   * The actions a trip in `status` offers, in order:
   *   - in an ending: the single documented recovery (`kind: 'resume'`), and
   *     only for the carrier side — the recovery decision is never a driver's;
   *   - in a normal status: every ending its source allows.
   * @param {unknown} status
   * @param {{ carrier?: boolean }} [options]
   * @returns {Array<{ to: string, kind: 'ending'|'resume' }>}
   */
  function actionsFrom(status, options) {
    var carrier = !!(options && options.carrier);
    var current = norm(status);
    var e = ending(current);
    if (e) {
      return carrier ? [{ to: e.resumeTo, kind: 'resume' }] : [];
    }
    return endingsFrom(current, carrier).map(function (to) {
      return { to: to, kind: 'ending' };
    });
  }

  /**
   * The recovery target for an ending, or null. Mirrors the server's recovery
   * edge; shown on the tracking page as the next step.
   * @param {unknown} status
   * @returns {string|null}
   */
  function resumeTo(status) {
    var e = ending(status);
    return e ? e.resumeTo : null;
  }

  return {
    ENDINGS: ENDINGS,
    ENDING_STATUSES: ENDING_STATUSES,
    ending: ending,
    isEnding: isEnding,
    endingsFrom: endingsFrom,
    actionsFrom: actionsFrom,
    resumeTo: resumeTo,
  };
});
