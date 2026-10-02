/**
 * RoadwiseFleet — live tracking view model (board task #107, AND1-A5).
 *
 * The single pure half of the two live tracking surfaces the owner asked for
 * (customer portal `customer/` and fleet web app `app/`): which phases make up
 * a live trip, whether a trip is "not started yet", live, completed or
 * cancelled, how a GPS point advances the last-known position, and how the SSE
 * frames the API streams are parsed.
 *
 * Loaded twice, on purpose, exactly like `app/lib/tracking.js` and
 * `app/lib/app-core.js`:
 *   - in the browser as a classic script
 *     (`<script src="/pilot/lib/live-tracking.js">`), which exposes
 *     `window.RoadwiseLiveTracking` — used by the fleet app and by the customer
 *     portal (one module, so the two surfaces cannot disagree about what "not
 *     started" means). It lives under the shared `/pilot/` static route because
 *     the customer portal deliberately never references the dispatcher app.
 *   - in the API no-install test suite (`apps/api/src/live-tracking.test.js`),
 *     so every rule here is covered by `node --test apps/api/src/` with no
 *     install and no browser.
 *
 * Nothing here touches the DOM, the network, storage or the clock (callers pass
 * timestamps in). ES5-compatible syntax: the pilot targets cheap Android
 * WebViews. The phase chain mirrors `apps/api/src/trip-status.js#DRIVER_PHASES`;
 * the *scope* (whose trip this is) is decided server-side and is deliberately
 * not re-implemented here.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.RoadwiseLiveTracking = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * The driver-facing phase chain, in lifecycle order. Mirrors
   * `DRIVER_PHASES` in `apps/api/src/trip-status.js`; the customer/fleet live
   * view renders these as milestones.
   */
  var MILESTONES = [
    'ASSIGNED',
    'EN_ROUTE',
    'AT_PICKUP',
    'LOADED',
    'IN_TRANSIT',
    'AT_DELIVERY',
    'DELIVERED'
  ];

  /** Statuses at or after delivery: the trip is no longer live-tracked. */
  var CLOSED_STATUSES = ['DELIVERED', 'POD_UPLOADED', 'INVOICED', 'SETTLED'];

  /** The only status that means "the job was called off". */
  var CANCELLED_STATUS = 'CANCELLED';

  /** Catalogue keys for the four live states. */
  var STATE_KEYS = {
    not_started: 'live.state.notStarted',
    live: 'live.state.live',
    completed: 'live.state.completed',
    cancelled: 'live.state.cancelled'
  };

  var MILESTONE_KEYS = {
    ASSIGNED: 'live.phase.assigned',
    EN_ROUTE: 'live.phase.enRoute',
    AT_PICKUP: 'live.phase.atPickup',
    LOADED: 'live.phase.loaded',
    IN_TRANSIT: 'live.phase.inTransit',
    AT_DELIVERY: 'live.phase.atDelivery',
    DELIVERED: 'live.phase.delivered'
  };

  /** @param {unknown} value @returns {string} */
  function norm(value) {
    return typeof value === 'string' ? value.trim().toUpperCase() : '';
  }

  /**
   * The state a live surface shows for a trip.
   *
   *   'cancelled'   the job was called off
   *   'completed'   delivered (or later): history, never live
   *   'not_started' tracking has not been turned on yet
   *   'live'        tracking is on and the trip is in flight
   *
   * A delivered trip reads `completed` even if a stale `tracking` flag were
   * still true: delivery is what ends live tracking (board task #105).
   * @param {{ tracking?: unknown, status?: unknown }} [input]
   * @returns {'not_started'|'live'|'completed'|'cancelled'}
   */
  function liveState(input) {
    var b = input || {};
    var status = norm(b.status);
    if (status === CANCELLED_STATUS) return 'cancelled';
    if (CLOSED_STATUSES.indexOf(status) !== -1) return 'completed';
    if (b.tracking !== true) return 'not_started';
    return 'live';
  }

  /**
   * @param {unknown} state a value returned by `liveState`
   * @returns {string} a catalogue key
   */
  function stateKey(state) {
    var key = STATE_KEYS[state];
    return typeof key === 'string' ? key : STATE_KEYS.not_started;
  }

  /**
   * The index of a status within the milestone chain, or -1 when the status is
   * unknown / not part of the driver phases (DRAFT never shows as reached; a
   * back-office status reads as "past the end" so every milestone is done).
   * @param {unknown} status
   * @returns {number}
   */
  function phaseIndex(status) {
    var s = norm(status);
    if (!s) return -1;
    if (s === CANCELLED_STATUS || s === 'DRAFT') return -1;
    var i = MILESTONES.indexOf(s);
    if (i !== -1) return i;
    // DELIVERED-and-later back-office states read as fully done.
    if (CLOSED_STATUSES.indexOf(s) !== -1) return MILESTONES.length - 1;
    return -1;
  }

  /**
   * The milestone rows a live surface renders: every phase with its state.
   * A cancelled trip keeps whatever it had reached and is not marked current.
   * @param {unknown} status
   * @returns {Array<{ id: string, key: string, state: 'done'|'current'|'todo' }>}
   */
  function milestoneRows(status) {
    var s = norm(status);
    var current = phaseIndex(s);
    var cancelled = s === CANCELLED_STATUS;
    // A finished trip (delivered or later, or cancelled) has no "current"
    // milestone: every phase it reached is simply done.
    var finished = cancelled || CLOSED_STATUSES.indexOf(s) !== -1;
    return MILESTONES.map(function (id, index) {
      var state = 'todo';
      if (current > index) state = 'done';
      else if (current === index) state = finished ? 'done' : 'current';
      return { id: id, key: MILESTONE_KEYS[id] || id, state: state };
    });
  }

  /**
   * Coerce a GPS frame/point into the display shape, or null when it is not a
   * usable position. Out-of-range latitude/longitude is rejected (the API
   * validates at ingest; this is defence in depth at the render boundary).
   * @param {unknown} point
   * @returns {{ lat: number, lng: number, at: string|null, accuracyM: number|null }|null}
   */
  function normalizePoint(point) {
    if (!point || typeof point !== 'object') return null;
    var p = /** @type {Record<string, unknown>} */ (point);
    var lat = Number(p.lat);
    var lng = Number(p.lng);
    if (!isFinite(lat) || !isFinite(lng)) return null;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    var at = typeof p.at === 'string' && p.at.length > 0 ? p.at : null;
    var accuracy = Number(p.accuracyM);
    return {
      lat: lat,
      lng: lng,
      at: at,
      accuracyM: isFinite(accuracy) ? accuracy : null
    };
  }

  /**
   * Advance a live state with one GPS frame. A point that is not newer than the
   * last known one (a replay or an out-of-order frame from the offline queue) is
   * ignored, so the map never jumps backwards.
   * @param {{ lastPosition?: any, updatedAt?: string|null }} [state]
   * @param {unknown} point
   * @returns {{ lastPosition: any, updatedAt: string|null }}
   */
  function applyPoint(state, point) {
    var current = state && typeof state === 'object' ? state : {};
    var next = normalizePoint(point);
    if (!next) return { lastPosition: current.lastPosition || null, updatedAt: current.updatedAt || null };
    var last = current.lastPosition || null;
    if (last) {
      var lastAt = typeof last.at === 'string' ? Date.parse(last.at) : NaN;
      var nextAt = next.at ? Date.parse(next.at) : NaN;
      if (isFinite(lastAt) && isFinite(nextAt) && nextAt <= lastAt) {
        return { lastPosition: last, updatedAt: current.updatedAt || null };
      }
    }
    return { lastPosition: next, updatedAt: next.at };
  }

  /**
   * Parse a chunk of an SSE stream into complete frames. Incomplete bytes are
   * returned as `rest` for the next chunk; `:` comment frames (keep-alive) are
   * dropped. Never throws on malformed JSON — the raw data is returned.
   * @param {unknown} buffer the unparsed tail from the previous call ('' first)
   * @param {unknown} chunk the newly received text
   * @returns {{ events: Array<{ event: string, data: any }>, rest: string }}
   */
  function parseSseChunk(buffer, chunk) {
    var text = String(buffer || '') + String(chunk === null || chunk === undefined ? '' : chunk);
    var events = [];
    var index = text.indexOf('\n\n');
    while (index >= 0) {
      var raw = text.slice(0, index);
      text = text.slice(index + 2);
      var event = 'message';
      var dataLine = null;
      var lines = raw.split('\n');
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (line.indexOf('event:') === 0) event = line.slice(6).trim();
        else if (line.indexOf('data:') === 0) dataLine = line.slice(5).trim();
      }
      if (dataLine !== null) {
        var data = dataLine;
        try {
          data = JSON.parse(dataLine);
        } catch (err) {
          /* keep the raw string, the caller decides */
        }
        events.push({ event: event, data: data });
      }
      index = text.indexOf('\n\n');
    }
    return { events: events, rest: text };
  }

  /**
   * The authenticated SSE path for one trip (fleet app). The id is encoded so it
   * can never change the request path.
   * @param {unknown} tripId
   * @returns {string}
   */
  function streamPathForTrip(tripId) {
    return '/api/trips/' + encodeURIComponent(String(tripId === null || tripId === undefined ? '' : tripId)) + '/stream';
  }

  /**
   * The token out of a shareable tracking url (`/track/<token>`, absolute or
   * relative), or ''. Used by the customer portal to open the read-only SSE
   * channel for the link it already owns.
   * @param {unknown} url
   * @returns {string}
   */
  function trackTokenFromUrl(url) {
    var value = String(url === null || url === undefined ? '' : url);
    var match = /(?:^|\/)track\/([^/?#]+)/.exec(value);
    if (!match) return '';
    try {
      return decodeURIComponent(match[1]);
    } catch (err) {
      return match[1];
    }
  }

  /**
   * The public SSE path for a shareable tracking url, or '' when the url does
   * not carry a `/track/<token>` segment.
   * @param {unknown} url
   * @returns {string}
   */
  function streamPathForTrackUrl(url) {
    var token = trackTokenFromUrl(url);
    return token ? '/api/track/' + encodeURIComponent(token) + '/stream' : '';
  }

  /**
   * True when `status` is one a live surface may show the map for. Historical
   * (completed/cancelled) cargo is never live-tracked.
   * @param {unknown} status
   * @returns {boolean}
   */
  function isTrackableStatus(status) {
    var s = norm(status);
    if (!s) return false;
    return s !== CANCELLED_STATUS && CLOSED_STATUSES.indexOf(s) === -1;
  }

  return {
    MILESTONES: MILESTONES,
    CLOSED_STATUSES: CLOSED_STATUSES,
    CANCELLED_STATUS: CANCELLED_STATUS,
    STATE_KEYS: STATE_KEYS,
    MILESTONE_KEYS: MILESTONE_KEYS,
    liveState: liveState,
    stateKey: stateKey,
    phaseIndex: phaseIndex,
    milestoneRows: milestoneRows,
    normalizePoint: normalizePoint,
    applyPoint: applyPoint,
    parseSseChunk: parseSseChunk,
    streamPathForTrip: streamPathForTrip,
    trackTokenFromUrl: trackTokenFromUrl,
    streamPathForTrackUrl: streamPathForTrackUrl,
    isTrackableStatus: isTrackableStatus
  };
});
