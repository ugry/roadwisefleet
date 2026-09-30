/**
 * RoadwiseFleet driver PWA — shared, dependency-free domain core (board task #4).
 *
 * This file is loaded twice, on purpose:
 *   - in the browser, as a classic script (`<script src="lib/driver-core.js">`)
 *     which exposes `window.RoadwiseDriverCore`;
 *   - in the API test suite, via `require`/`import` from
 *     `apps/api/src/driver-pwa.test.js`, so the tour-card, checklist, capture
 *     and offline-queue rules are covered by `node --test apps/api/src/`.
 *
 * Nothing here touches the DOM, the network or storage: the page and the
 * service worker own those. The API stays authoritative for status legality
 * (`apps/api/src/trip-status.js`) — `TRANSITIONS` is a mirror, and
 * `driver-pwa.test.js` fails if the two ever drift apart.
 *
 * Every user-visible sentence is a catalogue *key* (`pilot/locales/*.json`,
 * board task #6) — no English literal lives in this file, so the driver app is
 * translatable without touching the domain rules.
 *
 * No secrets, no build step, ES5-compatible syntax (the pilot targets cheap
 * Android WebViews).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.RoadwiseDriverCore = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** Mirror of `apps/api/src/trip-status.js` §7 — UI convenience only. */
  var TRANSITIONS = {
    DRAFT: ['ASSIGNED', 'CANCELLED'],
    ASSIGNED: ['LOADED', 'CANCELLED'],
    LOADED: ['IN_TRANSIT'],
    IN_TRANSIT: ['DELIVERED'],
    DELIVERED: ['POD_UPLOADED'],
    POD_UPLOADED: ['INVOICED'],
    INVOICED: ['SETTLED'],
    SETTLED: [],
    CANCELLED: [],
  };

  /** Mirrors `DOC_TYPES` in `apps/api/src/documents.js`. */
  var DOC_TYPES = [
    'ecmr',
    'pod',
    'invoice',
    'driver_license',
    'cpc',
    'medical',
    'insurance',
    'tacho_file',
    'e_irsaliye',
  ];

  /** Mirrors `POD_DOC_TYPES`: these satisfy the POD_UPLOADED gate. */
  var POD_DOC_TYPES = ['pod', 'ecmr'];

  /** Document statuses that mean "the file is really there". */
  var PRESENT_DOC_STATUSES = ['UPLOADED', 'VERIFIED'];

  /**
   * The trip's document checklist. The POD gate is one requirement that either
   * a `pod` **or** an `ecmr` satisfies (`POD_DOC_TYPES`); the alternative row is
   * marked so the driver is not told to produce both. The rest is the pilot
   * paperwork attachable from the same screen.
   *
   * Text lives in the locale catalogues (`pilot/locales/*.json`) — this module
   * carries keys, never English, so the pilot can be read in EN/DE/PL/TR
   * (board task #6).
   */
  var CHECKLIST = [
    { docType: 'pod', labelKey: 'doctype.pod', hintKey: 'doctype.pod.hint', required: true, alternative: false },
    { docType: 'ecmr', labelKey: 'doctype.ecmr', hintKey: 'doctype.ecmr.hint', required: true, alternative: true },
    { docType: 'e_irsaliye', labelKey: 'doctype.e_irsaliye', hintKey: 'doctype.e_irsaliye.hint', required: false, alternative: false },
    { docType: 'invoice', labelKey: 'doctype.invoice', hintKey: 'doctype.invoice.hint', required: false, alternative: false },
    { docType: 'tacho_file', labelKey: 'doctype.tacho_file', hintKey: 'doctype.tacho_file.hint', required: false, alternative: false },
  ];

  /** One requirement per group: the trip needs at least one document from each. */
  var REQUIRED_GROUPS = [POD_DOC_TYPES.slice()];


  /** Statuses the driver app asks the driver to confirm before sending. */
  var CONFIRM_STATUSES = ['DELIVERED'];

  /** HTTP statuses that will never succeed on retry — drop them from the queue. */
  var PERMANENT_HTTP = [400, 401, 403, 404, 409, 413, 415, 422];

  /** Weight given to a capture's accuracy when judging it usable. */
  var MAX_USABLE_ACCURACY_M = 2000;

  function nextLegalStatuses(status) {
    var list = TRANSITIONS[status];
    return Array.isArray(list) ? list.slice() : [];
  }

  function isTerminal(status) {
    return nextLegalStatuses(status).length === 0;
  }

  function requiresConfirmation(to) {
    return CONFIRM_STATUSES.indexOf(to) !== -1;
  }

  function isKnownDocType(docType) {
    return DOC_TYPES.indexOf(docType) !== -1;
  }

  /** True when the trip already has an uploaded/verified document of `docType`. */
  function hasPresentDocument(documents, docType) {
    var docs = Array.isArray(documents) ? documents : [];
    for (var i = 0; i < docs.length; i++) {
      var d = docs[i] || {};
      if (d.docType === docType && PRESENT_DOC_STATUSES.indexOf(d.status) !== -1) return true;
    }
    return false;
  }

  /** True when the trip already has an uploaded/verified POD or eCMR. */
  function podSatisfied(documents) {
    for (var i = 0; i < POD_DOC_TYPES.length; i++) {
      if (hasPresentDocument(documents, POD_DOC_TYPES[i])) return true;
    }
    return false;
  }

  /**
   * How many outstanding document requirements the trip still has. Each group
   * in `REQUIRED_GROUPS` is one requirement satisfied by any of its types, so
   * a missing POD *and* eCMR is one outstanding requirement, not two.
   * @param {any[]|undefined} documents
   */
  function requiredMissing(documents) {
    var missing = 0;
    for (var g = 0; g < REQUIRED_GROUPS.length; g++) {
      var group = REQUIRED_GROUPS[g];
      var satisfied = false;
      for (var i = 0; i < group.length; i++) {
        if (hasPresentDocument(documents, group[i])) satisfied = true;
      }
      if (!satisfied) missing += 1;
    }
    return missing;
  }

  /**
   * The checklist rows for one trip: every configured document with whether it
   * is attached, its latest status, and whether it is required.
   * @param {any[]|undefined} documents
   */
  function documentChecklist(documents) {
    var docs = Array.isArray(documents) ? documents : [];
    return CHECKLIST.map(function (row) {
      var match = null;
      for (var i = 0; i < docs.length; i++) {
        var d = docs[i] || {};
        if (d.docType === row.docType) match = d;
      }
      var status = match ? String(match.status || '') : '';
      return {
        docType: row.docType,
        labelKey: row.labelKey,
        hintKey: row.hintKey,
        required: row.required,
        alternative: row.alternative,
        present: PRESENT_DOC_STATUSES.indexOf(status) !== -1,
        status: status || null,
        documentId: match && match.id ? match.id : null,
      };
    });
  }

  /**
   * Whether the driver may move the trip to POD_UPLOADED right now: the status
   * machine must allow DELIVERED → POD_UPLOADED *and* a POD/eCMR must be on
   * the trip (the API enforces the same rule, `pod_required`).
   */
  function canMarkPodUploaded(status, documents) {
    return nextLegalStatuses(status).indexOf('POD_UPLOADED') !== -1 && podSatisfied(documents);
  }

  function money(value) {
    if (value === null || value === undefined || value === '') return null;
    var n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * Shape one driver trip into the "tour card" the page renders: route, cargo,
   * truck, rate, an explicit ETA placeholder, the required-documents checklist
   * and the next legal statuses. Pure — no formatting that depends on the
   * environment's locale.
   * @param {any} trip
   */
  function buildTourCard(trip) {
    var t = trip || {};
    var order = t.order || {};
    var truck = t.truck || {};
    var documents = Array.isArray(t.documents) ? t.documents : [];
    var events = Array.isArray(t.statusEvents) ? t.statusEvents : [];
    var checklist = documentChecklist(documents);
    var status = String(t.status || 'DRAFT');
    return {
      id: t.id || null,
      status: status,
      route: {
        origin: order.origin || null,
        destination: order.destination || null,
      },
      cargo: order.cargo || null,
      customer: (order.customer && order.customer.name) || null,
      truck: {
        plate: truck.plate || null,
        euroClass: truck.euroClass || null,
      },
      rateEur: money(t.rateEur),
      // No ETA source in the pilot data model yet: say so instead of inventing one.
      eta: null,
      etaKey: 'driver.etaUnavailable',
      stops: (Array.isArray(t.stops) ? t.stops : []).map(function (s) {
        return {
          seq: s.seq,
          kind: s.kind || null,
          address: s.address || null,
          plannedAt: s.plannedAt || null,
          arrivedAt: s.arrivedAt || null,
        };
      }),
      documents: documents,
      checklist: checklist,
      requiredMissing: requiredMissing(documents),
      podSatisfied: podSatisfied(documents),
      nextStatuses: nextLegalStatuses(status),
      updatedAt: events.length ? events[events.length - 1].happenedAt || null : null,
    };
  }

  /**
   * The trip the driver app opens on: the first trip still in play (not
   * SETTLED/CANCELLED), else the newest one. Tenancy is the API's job — this
   * only chooses which card to show first.
   * @param {any[]|undefined} trips
   */
  function pickCurrentTrip(trips) {
    var list = Array.isArray(trips) ? trips : [];
    for (var i = 0; i < list.length; i++) {
      if (!isTerminal(list[i] && list[i].status)) return list[i];
    }
    return list.length ? list[0] : null;
  }

  /**
   * Validate the capture metadata a POD upload carries: when the photo was
   * taken and (optionally) where. `capturedAt` is an ISO string or epoch ms;
   * `geo` is `{ lat, lng, accuracy }` straight from `navigator.geolocation`.
   *
   * GPS is best-effort: a missing/denied position is valid (both fields null),
   * but a *malformed* one is rejected rather than silently stored, and a
   * timestamp in the future is a clock problem the driver should see.
   *
   * `detail` is the developer-facing sentence (parity with the server-side
   * `documents.js#normalizeCapture`); `detailKey` is the catalogue key the page
   * shows the driver (board task #6).
   * @param {{ capturedAt?: unknown, geo?: unknown, now?: number }} [input]
   * @returns {{ ok: true, value: { capturedAt: string|null, lat: number|null, lng: number|null, accuracyM: number|null } } | { ok: false, error: string, detail: string, detailKey: string }}
   */
  function normalizeCapture(input) {
    var b = input || {};
    var now = typeof b.now === 'number' ? b.now : Date.now();

    var capturedAt = null;
    if (b.capturedAt !== undefined && b.capturedAt !== null && b.capturedAt !== '') {
      var ms = typeof b.capturedAt === 'number' ? b.capturedAt : Date.parse(String(b.capturedAt));
      if (!Number.isFinite(ms)) {
        return { ok: false, error: 'invalid_capture', detail: 'capturedAt must be an ISO date or epoch milliseconds', detailKey: 'capture.badTimestamp' };
      }
      if (ms > now + 24 * 60 * 60 * 1000) {
        return { ok: false, error: 'invalid_capture', detail: 'capturedAt is in the future', detailKey: 'capture.futureTimestamp' };
      }
      capturedAt = new Date(ms).toISOString();
    }

    if (b.geo === undefined || b.geo === null) {
      return { ok: true, value: { capturedAt: capturedAt, lat: null, lng: null, accuracyM: null } };
    }
    var g = b.geo;
    if (typeof g !== 'object') {
      return { ok: false, error: 'invalid_capture', detail: 'geo must be an object', detailKey: 'capture.geoNotObject' };
    }
    var lat = Number(g.lat);
    var lng = Number(g.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return { ok: false, error: 'invalid_capture', detail: 'geo.lat and geo.lng are required numbers', detailKey: 'capture.geoRequired' };
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return { ok: false, error: 'invalid_capture', detail: 'geo.lat/lng out of range', detailKey: 'capture.geoRange' };
    }
    var accuracyM = null;
    if (g.accuracy !== undefined && g.accuracy !== null && g.accuracy !== '') {
      var acc = Number(g.accuracy);
      if (!Number.isFinite(acc) || acc < 0) {
        return { ok: false, error: 'invalid_capture', detail: 'geo.accuracy must be a non-negative number', detailKey: 'capture.accuracy' };
      }
      accuracyM = Math.round(acc);
    }
    return { ok: true, value: { capturedAt: capturedAt, lat: lat, lng: lng, accuracyM: accuracyM } };
  }

  /**
   * The numeric parts of a GPS fix, ready for the page to put into a translated
   * string (`driver.gpsCoords`, `driver.gpsCoordsAccuracy`). Coordinates keep
   * their conventional dot decimals — that is how drivers read a position — so
   * nothing here is locale-dependent.
   * @param {{ lat?: any, lng?: any, accuracyM?: any }|null} capture
   * @returns {{ lat: string, lng: string, accuracyM: number|null }|null}
   */
  function captureCoords(capture) {
    var c = capture || {};
    if (c.lat === null || c.lat === undefined || c.lng === null || c.lng === undefined) return null;
    return {
      lat: Number(c.lat).toFixed(4),
      lng: Number(c.lng).toFixed(4),
      accuracyM: (c.accuracyM === null || c.accuracyM === undefined) ? null : Number(c.accuracyM),
    };
  }

  /** True when the fix is too coarse to be worth attaching. */
  function isUsableFix(position) {
    if (!position || !position.coords) return false;
    var acc = Number(position.coords.accuracy);
    return Number.isFinite(acc) ? acc <= MAX_USABLE_ACCURACY_M : false;
  }

  /**
   * Build a queue item. `payload` is exactly what the API call will send, so a
   * sync never has to re-derive anything (a document item also carries the
   * photo as a `Blob`, kept outside `payload`).
   * @param {{ kind: 'status'|'document', tripId: string, payload?: any, photo?: any, at?: number, id: string }} input
   */
  function makeQueueItem(input) {
    var b = input || {};
    if (b.kind !== 'status' && b.kind !== 'document') {
      throw new Error('queue item kind must be status or document');
    }
    if (!b.id) throw new Error('queue item id is required');
    if (!b.tripId) throw new Error('queue item tripId is required');
    return {
      id: String(b.id),
      kind: b.kind,
      tripId: String(b.tripId),
      at: typeof b.at === 'number' ? b.at : Date.now(),
      attempts: 0,
      payload: b.payload || {},
      photo: b.photo || null,
    };
  }

  /** Oldest first — a trip's changes must replay in the order they happened. */
  function sortQueue(items) {
    var list = Array.isArray(items) ? items.slice() : [];
    list.sort(function (a, b) {
      if (a.at !== b.at) return a.at - b.at;
      return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
    });
    return list;
  }

  /**
   * What to send right now: nothing while offline (per-trip order is
   * preserved), otherwise the whole queue oldest-first.
   * @param {any[]|undefined} items
   * @param {{ online?: boolean }} [opts]
   */
  function planQueueSync(items, opts) {
    var online = !(opts && opts.online === false);
    var queue = sortQueue(items);
    if (!online) return { online: false, send: [], deferred: queue, reason: 'offline' };
    return { online: true, send: queue, deferred: [], reason: null };
  }

  /**
   * Whether a failed send may be retried. Network errors and 5xx/429/408 are
   * retried; a 4xx the server will never accept is a permanent drop (it stays
   * in the failed list so the driver sees why).
   * @param {number|undefined|null} status
   */
  function classifyFailure(status) {
    var code = Number(status);
    if (!Number.isFinite(code)) return 'retry';
    if (code === 408 || code === 429) return 'retry';
    if (code >= 500) return 'retry';
    if (PERMANENT_HTTP.indexOf(code) !== -1) return 'drop';
    return code >= 400 && code < 500 ? 'drop' : 'retry';
  }

  /**
   * Fold send results back into the queue: successes are removed, permanent
   * failures are removed *and* reported, everything else stays for the next
   * sync with its attempt count bumped.
   * @param {any[]|undefined} items
   * @param {Array<{ id: string, ok?: boolean, status?: number, error?: string }>|undefined} results
   */
  function applySyncResults(items, results) {
    var queue = Array.isArray(items) ? items : [];
    var list = Array.isArray(results) ? results : [];
    var sent = [];
    var dropped = [];
    var retried = [];
    var byId = {};
    for (var i = 0; i < list.length; i++) {
      var r = list[i] || {};
      byId[String(r.id)] = r;
    }
    var keep = [];
    for (var j = 0; j < queue.length; j++) {
      var item = queue[j];
      var result = byId[String(item.id)];
      if (!result) {
        keep.push(item);
        continue;
      }
      if (result.ok) {
        sent.push(item.id);
        continue;
      }
      if (classifyFailure(result.status) === 'drop') {
        dropped.push({ id: item.id, status: result.status === undefined ? null : result.status, error: result.error || null });
        continue;
      }
      var bumped = {};
      for (var k in item) {
        if (Object.prototype.hasOwnProperty.call(item, k)) bumped[k] = item[k];
      }
      bumped.attempts = (item.attempts || 0) + 1;
      keep.push(bumped);
      retried.push(item.id);
    }
    return { queue: keep, sent: sent, dropped: dropped, retried: retried };
  }

  /**
   * The sync indicator: one state, the pending count, and the catalogue key the
   * page renders (with `{ count }`, so the plural form comes from the locale).
   * @param {any[]|undefined} items
   * @param {{ online?: boolean, syncing?: boolean, lastError?: string|null }} [opts]
   */
  function syncIndicator(items, opts) {
    var b = opts || {};
    var pending = Array.isArray(items) ? items.length : 0;
    if (b.syncing) return { state: 'syncing', pending: pending, labelKey: 'driver.sync.syncing' };
    if (b.online === false) return { state: 'offline', pending: pending, labelKey: 'driver.sync.offline' };
    if (b.lastError) return { state: 'error', pending: pending, labelKey: 'driver.sync.error' };
    if (pending > 0) return { state: 'pending', pending: pending, labelKey: 'driver.sync.pending' };
    return { state: 'synced', pending: 0, labelKey: 'driver.sync.synced' };
  }

  /** The URL a queued item will be sent to. */
  function queueItemUrl(item) {
    var id = encodeURIComponent(String((item && item.tripId) || ''));
    if (item && item.kind === 'status') return '/api/trips/' + id + '/status';
    if (item && item.kind === 'document') return '/api/trips/' + id + '/documents';
    return null;
  }

  /** The HTTP method a queued item will use. */
  function queueItemMethod() {
    return 'POST';
  }

  /** A queued item is a capture when it carries a photo. */
  function isCaptureItem(item) {
    return Boolean(item && item.kind === 'document' && item.photo);
  }

  return {
    TRANSITIONS: TRANSITIONS,
    DOC_TYPES: DOC_TYPES,
    POD_DOC_TYPES: POD_DOC_TYPES,
    PRESENT_DOC_STATUSES: PRESENT_DOC_STATUSES,
    CHECKLIST: CHECKLIST,
    REQUIRED_GROUPS: REQUIRED_GROUPS,
    CONFIRM_STATUSES: CONFIRM_STATUSES,
    MAX_USABLE_ACCURACY_M: MAX_USABLE_ACCURACY_M,
    nextLegalStatuses: nextLegalStatuses,
    isTerminal: isTerminal,
    requiresConfirmation: requiresConfirmation,
    isKnownDocType: isKnownDocType,
    hasPresentDocument: hasPresentDocument,
    podSatisfied: podSatisfied,
    requiredMissing: requiredMissing,
    documentChecklist: documentChecklist,
    canMarkPodUploaded: canMarkPodUploaded,
    buildTourCard: buildTourCard,
    pickCurrentTrip: pickCurrentTrip,
    normalizeCapture: normalizeCapture,
    captureCoords: captureCoords,
    isUsableFix: isUsableFix,
    makeQueueItem: makeQueueItem,
    sortQueue: sortQueue,
    planQueueSync: planQueueSync,
    classifyFailure: classifyFailure,
    applySyncResults: applySyncResults,
    syncIndicator: syncIndicator,
    queueItemUrl: queueItemUrl,
    queueItemMethod: queueItemMethod,
    isCaptureItem: isCaptureItem,
  };
});
