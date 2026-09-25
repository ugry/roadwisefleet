/**
 * RoadwiseFleet Fleet Manager — driver client view model (board task #38, FAv1-F7a).
 *
 * The pure half of the driver screen at `/app/my-trips`. Like every other
 * `app/lib/*.js` module it is loaded twice, on purpose:
 *   - in the browser, as a classic script before `app.js` (exposes
 *     `window.RoadwiseDriverView`);
 *   - in the API test suite, via `require` from
 *     `apps/api/src/driver-client.test.js`.
 *
 * Nothing here touches the DOM, the network or storage. It does not restate the
 * driver rules either: the transition table, the confirm-on-DELIVERED rule, the
 * checklist, the POD gate, the capture validation and the offline-queue plan all
 * come from the shared `pilot/lib/driver-core.js` (board task #4) and the shared
 * document rules from `app/lib/documents.js` (board task #37). Both are passed
 * in (`create(core, docs)`), so the Node test proves the SAME code the browser
 * runs — no copied constants.
 *
 * Why the app has its own driver view model at all: the two decisions the app
 * adds on top of the shared core are (a) the POD gate is shown as a *disabled*
 * action with a reason, never hidden, and (b) every upload failure is a
 * catalogue key that names what to do — including the two over-limit paths the
 * owner called out (the pre-upload size check and the server/proxy rejection).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.RoadwiseDriverView = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** The driver's own trips: the only trip read this screen ever makes. */
  var MY_TRIPS_PATH = '/api/driver/trips';

  /** `localStorage` key for the offline queue. */
  var QUEUE_KEY = 'rwf_driver_queue';

  /**
   * The queue is a JSON string in `localStorage`; this is the ceiling we allow
   * before telling the driver to reconnect instead of losing the capture. It is
   * below the usual 5 MB per-origin quota, leaving room for the rest of the app.
   */
  var DEFAULT_QUEUE_MAX_CHARS = 4500000;

  /** The status the API refuses without a POD/eCMR on the trip. */
  var GATED_STATUS = 'POD_UPLOADED';

  function text(value) {
    return String(value === null || value === undefined ? '' : value).trim();
  }

  /**
   * Is this user a driver? (The server is authoritative; this only decides what
   * the shell renders.)
   * @param {{ roleId?: unknown }|null|undefined} user
   * @returns {boolean}
   */
  function canUseDriverView(user) {
    return Boolean(user) && text(user.roleId) === 'driver';
  }

  /** @returns {string} */
  function myTripsPath() {
    return MY_TRIPS_PATH;
  }

  /** @param {unknown} status @returns {string} */
  function statusKey(status) {
    return 'trips.status.' + text(status);
  }

  /** @param {unknown} status @returns {string} */
  function actionKey(status) {
    return 'driver.action.' + text(status);
  }

  /** @param {unknown} status @returns {string} */
  function confirmKey(status) {
    return 'driver.confirm.' + text(status);
  }

  /**
   * The one-tap buttons for a trip: every next legal status. `confirm` marks the
   * irreversible one (DELIVERED) and `blocked` marks the POD gate — the button
   * is rendered disabled with `blockedKey`, never hidden, so the driver sees
   * what is missing instead of a vanished action.
   * @param {any} core `pilot/lib/driver-core.js`
   * @param {any} trip
   * @returns {Array<{ status: string, actionKey: string, confirm: boolean, confirmKey: string|null, blocked: boolean, blockedKey: string|null }>}
   */
  function statusActions(core, trip) {
    var t = trip || {};
    var documents = Array.isArray(t.documents) ? t.documents : [];
    var next = core && typeof core.nextLegalStatuses === 'function' ? core.nextLegalStatuses(t.status) : [];
    return next.map(function (status) {
      var gated = status === GATED_STATUS;
      var missing = gated && core && typeof core.podSatisfied === 'function' ? !core.podSatisfied(documents) : false;
      var confirm = core && typeof core.requiresConfirmation === 'function' ? core.requiresConfirmation(status) : false;
      return {
        status: status,
        actionKey: actionKey(status),
        confirm: confirm,
        confirmKey: confirm ? confirmKey(status) : null,
        blocked: missing,
        blockedKey: missing ? 'driver.podGate' : null,
      };
    });
  }

  /** May the trip move to POD_UPLOADED right now? (Shared core decides.) */
  function podReady(core, status, documents) {
    if (!core || typeof core.canMarkPodUploaded !== 'function') return false;
    return Boolean(core.canMarkPodUploaded(status, documents));
  }

  /** The checklist rows (shared core decides present/required/alternative). */
  function checklist(core, documents) {
    if (!core || typeof core.documentChecklist !== 'function') return [];
    return core.documentChecklist(documents);
  }

  /** Outstanding required-document count (shared core decides). */
  function requiredMissing(core, documents) {
    if (!core || typeof core.requiredMissing !== 'function') return 0;
    return Number(core.requiredMissing(documents)) || 0;
  }

  /* ------------------------------------------------------------- capture --- */

  /**
   * The capture metadata for a photo: when it was taken and, best-effort, where.
   * Delegates to the shared core so the app and the pilot agree on what a valid
   * fix/timestamp is. On failure the caller shows `key` (a catalogue key), never
   * the developer `detail`.
   * @param {any} core
   * @param {{ capturedAt?: unknown, geo?: unknown, now?: number }} [input]
   * @returns {{ ok: true, value: any } | { ok: false, key: string, detail: string }}
   */
  function captureMeta(core, input) {
    if (!core || typeof core.normalizeCapture !== 'function') {
      return { ok: false, key: 'driver.capture.unavailable', detail: 'driver core not loaded' };
    }
    var res = core.normalizeCapture(input || {});
    if (res && res.ok) return { ok: true, value: res.value };
    return { ok: false, key: (res && res.detailKey) || 'docs.error.capture', detail: (res && res.detail) || '' };
  }

  /**
   * The GPS/timestamp numbers the screen shows next to a captured photo, or null.
   * @param {any} core
   * @param {any} capture
   */
  function captureCoords(core, capture) {
    if (!core || typeof core.captureCoords !== 'function') return null;
    return core.captureCoords(capture);
  }

  /* -------------------------------------------------------- photo errors --- */

  /**
   * Pre-upload check: decided BEFORE any request, so an over-limit photo never
   * reaches the server (and the proxy's own HTML 413 page can never be what the
   * driver sees). The key is the existing, actionable catalogue string:
   * `docs.error.tooLarge` = "Photo is {size} — the maximum is {max}. Choose a
   * smaller file." (board #38 owner directive, issue #41).
   * @param {any} docs `app/lib/documents.js`
   * @param {{ docType?: unknown, mimeType?: unknown, size?: unknown, maxBytes?: unknown }} [input]
   * @returns {{ ok: true, value: any } | { ok: false, field: string, key: string, params?: any }}
   */
  function photoCheck(docs, input) {
    if (!docs || typeof docs.validateUpload !== 'function') {
      return { ok: false, field: 'file', key: 'docs.error.file' };
    }
    var b = input || {};
    return docs.validateUpload({
      docType: b.docType || 'pod',
      mimeType: b.mimeType,
      size: b.size,
      maxBytes: b.maxBytes,
    });
  }

  /**
   * The message for a *server-side* upload failure. `file_too_large` (the API's
   * own 400) and 413 (the reverse proxy's page) both get a driver message that
   * names the limit and the remedy — never a raw code and never an HTML body.
   * Everything else is the shared documents mapping.
   * @param {any} docs
   * @param {{ status?: number, data?: any }|null} res
   * @returns {{ key: string, params?: any }}
   */
  function uploadError(docs, res) {
    var status = res ? Number(res.status) : 0;
    var code = res && res.data ? text(res.data.error) : '';
    var max = docs && typeof docs.formatBytes === 'function' && docs.DEFAULT_MAX_UPLOAD_BYTES
      ? docs.formatBytes(docs.DEFAULT_MAX_UPLOAD_BYTES)
      : null;
    if (code === 'file_too_large' || status === 413) {
      return max
        ? { key: 'driver.photo.tooLargeServer', params: { max: max } }
        : { key: 'docs.error.tooLargeServer' };
    }
    var key = docs && typeof docs.errorKey === 'function' ? docs.errorKey(res) : 'error.unexpected';
    var detail = docs && typeof docs.errorDetail === 'function' ? docs.errorDetail(res) : '';
    return detail ? { key: key, params: { detail: detail } } : { key: key };
  }

  /* ---------------------------------------------------------- the queue --- */

  /**
   * A stable id for one queued action, so a double tap or a repeated reconnect
   * cannot enqueue the same change twice.
   * @param {string} kind
   * @param {unknown} tripId
   * @param {number} at
   * @returns {string}
   */
  function queueId(kind, tripId, at) {
    return text(kind) + ':' + text(tripId) + ':' + String(at);
  }

  /**
   * Append `item` unless an item with the same id is already queued. Returns the
   * new queue (oldest first) and whether it was added.
   * @param {any} core
   * @param {any[]|undefined} items
   * @param {any} item
   */
  function enqueue(core, items, item) {
    var list = Array.isArray(items) ? items.slice() : [];
    var id = item ? text(item.id) : '';
    if (!id) return { queue: list, added: false, reason: 'no_id' };
    for (var i = 0; i < list.length; i += 1) {
      if (list[i] && text(list[i].id) === id) return { queue: list, added: false, reason: 'duplicate' };
    }
    list.push(item);
    return {
      queue: core && typeof core.sortQueue === 'function' ? core.sortQueue(list) : list,
      added: true,
      reason: null,
    };
  }

  /** What to send now (nothing while offline; oldest first when online). */
  function syncPlan(core, items, online) {
    if (!core || typeof core.planQueueSync !== 'function') return { online: Boolean(online), send: [], deferred: [], reason: 'unavailable' };
    return core.planQueueSync(items, { online: online !== false });
  }

  /** Fold send results back in: sent items leave the queue, failures do not. */
  function syncResults(core, items, results) {
    if (!core || typeof core.applySyncResults !== 'function') return { queue: Array.isArray(items) ? items.slice() : [], sent: [], dropped: [], retried: [] };
    return core.applySyncResults(items, results);
  }

  /** The one header state: syncing / offline / error / pending / synced. */
  function indicator(core, items, opts) {
    if (!core || typeof core.syncIndicator !== 'function') return { state: 'synced', pending: 0, labelKey: 'driver.sync.synced' };
    return core.syncIndicator(items, opts || {});
  }

  /** The URL a queued item will be replayed to. */
  function queueItemUrl(core, item) {
    if (!core || typeof core.queueItemUrl !== 'function') return null;
    return core.queueItemUrl(item);
  }

  /** Serialise the queue for storage. Never throws. */
  function queueJson(items) {
    try {
      return JSON.stringify(Array.isArray(items) ? items : []);
    } catch (err) {
      return '[]';
    }
  }

  /** Parse a stored queue; anything malformed degrades to an empty queue. */
  function parseQueue(raw) {
    if (typeof raw !== 'string' || !raw) return [];
    try {
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      return [];
    }
  }

  /**
   * Whether the serialised queue still fits in `localStorage`. When it does not,
   * the caller tells the driver to reconnect and send the capture now rather
   * than silently losing it.
   * @param {any[]|undefined} items
   * @param {number} [maxChars]
   */
  function queueFits(items, maxChars) {
    var max = Number(maxChars);
    if (!isFinite(max) || max <= 0) max = DEFAULT_QUEUE_MAX_CHARS;
    return queueJson(items).length <= max;
  }

  return {
    MY_TRIPS_PATH: MY_TRIPS_PATH,
    QUEUE_KEY: QUEUE_KEY,
    DEFAULT_QUEUE_MAX_CHARS: DEFAULT_QUEUE_MAX_CHARS,
    GATED_STATUS: GATED_STATUS,
    canUseDriverView: canUseDriverView,
    myTripsPath: myTripsPath,
    statusKey: statusKey,
    actionKey: actionKey,
    confirmKey: confirmKey,
    statusActions: statusActions,
    podReady: podReady,
    checklist: checklist,
    requiredMissing: requiredMissing,
    captureMeta: captureMeta,
    captureCoords: captureCoords,
    photoCheck: photoCheck,
    uploadError: uploadError,
    queueId: queueId,
    enqueue: enqueue,
    syncPlan: syncPlan,
    syncResults: syncResults,
    indicator: indicator,
    queueItemUrl: queueItemUrl,
    queueJson: queueJson,
    parseQueue: parseQueue,
    queueFits: queueFits,
  };
});
