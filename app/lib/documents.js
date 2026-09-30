/**
 * RoadwiseFleet Fleet Manager — documents view model (board task #37, FAv1-F6).
 *
 * The pure half of the trip-detail documents panel: which document types and
 * MIME types are acceptable, whether a chosen file may be uploaded at all (so an
 * over-limit file is refused in the UI before any request is sent), the exact
 * upload / verify / reject payloads, and how an API refusal reads back.
 *
 * The document *rules* are not restated here. The checklist, `requiredMissing`,
 * `podSatisfied` and `canMarkPodUploaded` are delegated to
 * `pilot/lib/driver-core.js` — the same module the driver client and
 * `apps/api/src/driver-pwa.test.js` use — so there is one definition of "the
 * POD gate is satisfied" in the product. The API stays authoritative; this
 * module only makes the UI agree with it.
 *
 * Loaded twice, on purpose, exactly like `app-core.js`:
 *   - in the browser, as a classic script (`<script src="lib/documents.js">`),
 *     which exposes `window.RoadwiseDocuments`;
 *   - in the API test suite (`apps/api/src/documents-ui.test.js`), so the
 *     validation, the payloads and the error mapping are covered by
 *     `node --test apps/api/src/` with no install and no browser.
 *
 * Nothing here touches the DOM, the network, storage or the clock.
 * ES5-compatible syntax: the app targets cheap Android WebViews.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.RoadwiseDocuments = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

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
    'e_irsaliye'
  ];

  /** Mirrors `POD_DOC_TYPES`: these satisfy the POD_UPLOADED gate. */
  var POD_DOC_TYPES = ['pod', 'ecmr'];

  /** Mirrors `ALLOWED_MIME` in `apps/api/src/documents.js`. */
  var ALLOWED_MIME = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/heic': 'heic',
    'image/heif': 'heif',
    'application/pdf': 'pdf'
  };

  /** Mirrors the API's default `MAX_UPLOAD_BYTES` (10 MiB). */
  var DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

  /** Roles that hold `trip:*` and may upload/verify any trip's documents. */
  var MANAGE_ROLES = ['owner', 'dispatcher'];

  /** Document statuses that mean "the file is really there". */
  var PRESENT_STATUSES = ['UPLOADED', 'VERIFIED'];

  /** The two statuses `PATCH /api/documents/:id` accepts. */
  var MANAGE_STATUSES = ['VERIFIED', 'REJECTED'];

  function text(value) {
    return value === null || value === undefined ? '' : String(value);
  }

  function trim(value) {
    return text(value).trim();
  }

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  /** @param {unknown} docType @returns {boolean} */
  function isKnownDocType(docType) {
    return DOC_TYPES.indexOf(trim(docType)) !== -1;
  }

  /** @param {unknown} mimeType @returns {boolean} */
  function isAllowedMime(mimeType) {
    return hasOwn(ALLOWED_MIME, trim(mimeType));
  }

  /**
   * Does this role hold `trip:*` (so it may verify/reject a document)?
   * Deny by default. Mirrors `documents.js#canManageDocuments` and
   * `app-core.js#canManageTrips`.
   * @param {unknown} role
   * @returns {boolean}
   */
  function canManageDocuments(role) {
    return MANAGE_ROLES.indexOf(trim(role)) !== -1;
  }

  /**
   * May this role upload to this trip's documents? A managing role may upload to
   * any trip; a driver may only upload to their own assigned trip.
   * Mirrors `documents.js#canUploadDocument`.
   * @param {unknown} role
   * @param {unknown} isAssignedDriver
   * @returns {boolean}
   */
  function canUploadDocuments(role, isAssignedDriver) {
    if (canManageDocuments(role)) return true;
    return trim(role) === 'driver' && isAssignedDriver === true;
  }

  /** True when the status means the bytes are really stored. */
  function isPresentStatus(status) {
    return PRESENT_STATUSES.indexOf(trim(status)) !== -1;
  }

  /**
   * A byte count as a short human string ("31 MB", "512 KB", "900 B"). Used in
   * the limit messages so a driver reads the size, not a number of bytes.
   * @param {unknown} bytes
   * @returns {string}
   */
  function formatBytes(bytes) {
    var n = Number(bytes);
    if (!isFinite(n) || n < 0) return '';
    if (n >= 1024 * 1024) {
      var mb = Math.round((n / (1024 * 1024)) * 10) / 10;
      return (mb === Math.floor(mb) ? String(Math.floor(mb)) : String(mb)) + ' MB';
    }
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return Math.round(n) + ' B';
  }

  /**
   * The `maxBytes` to enforce client-side, or the shipped default.
   * @param {unknown} maxBytes
   * @returns {number}
   */
  function resolveMaxBytes(maxBytes) {
    var n = Number(maxBytes);
    return isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_UPLOAD_BYTES;
  }

  /**
   * Validate a chosen file BEFORE any request: the shared allow-lists decide.
   * `field` names where the message belongs (`docType` or `file`); `key` is a
   * catalogue key and `params` its interpolation values. Never returns a raw
   * status code.
   *
   * `size` is the real file size (the browser's `File.size`), which is exactly
   * what the API compares the decoded bytes against.
   * @param {{ docType?: unknown, mimeType?: unknown, size?: unknown, maxBytes?: unknown }} [input]
   * @returns {{ ok: true, value: { docType: string, mimeType: string, size: number } } | { ok: false, field: string, key: string, params?: any }}
   */
  function validateUpload(input) {
    var b = input || {};
    if (!isKnownDocType(b.docType)) {
      return { ok: false, field: 'docType', key: 'docs.error.docType' };
    }
    if (!isAllowedMime(b.mimeType)) {
      return { ok: false, field: 'file', key: 'docs.error.mime' };
    }
    var size = Number(b.size);
    if (!isFinite(size) || size <= 0) {
      return { ok: false, field: 'file', key: 'docs.error.empty' };
    }
    var max = resolveMaxBytes(b.maxBytes);
    if (size > max) {
      return {
        ok: false,
        field: 'file',
        key: 'docs.error.tooLarge',
        params: { size: formatBytes(size), max: formatBytes(max) }
      };
    }
    return {
      ok: true,
      value: { docType: trim(b.docType), mimeType: trim(b.mimeType), size: size }
    };
  }

  /** The `accept` attribute for the file input, from the shared allow-list. */
  function acceptAttribute() {
    var out = [];
    for (var key in ALLOWED_MIME) {
      if (hasOwn(ALLOWED_MIME, key)) out.push(key);
    }
    return out.join(',');
  }

  /**
   * `POST /api/trips/:id/documents` for one trip. The id is encoded, so a trip
   * id can never change the request path.
   * @param {unknown} tripId
   * @returns {string}
   */
  function uploadPath(tripId) {
    return '/api/trips/' + encodeURIComponent(trim(tripId)) + '/documents';
  }

  /**
   * `PATCH /api/documents/:id` for one document.
   * @param {unknown} documentId
   * @returns {string}
   */
  function documentPath(documentId) {
    return '/api/documents/' + encodeURIComponent(trim(documentId));
  }

  /**
   * Coerce optional capture metadata to the API's `geo` shape, or null. Bad
   * coordinates are dropped rather than sent (the API would 400 them, and a
   * missing fix is fine — GPS is best-effort).
   * @param {any} geo
   * @returns {{ lat: number, lng: number, accuracy?: number }|null}
   */
  function normalizeGeo(geo) {
    if (!geo || typeof geo !== 'object' || Array.isArray(geo)) return null;
    var lat = Number(geo.lat);
    var lng = Number(geo.lng);
    if (!isFinite(lat) || !isFinite(lng)) return null;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    var out = { lat: lat, lng: lng };
    var accuracy = Number(geo.accuracy);
    if (isFinite(accuracy) && accuracy >= 0) out.accuracy = Math.round(accuracy);
    return out;
  }

  /**
   * The exact `POST /api/trips/:id/documents` body. Optional capture fields are
   * OMITTED when absent, never sent as null, so the request shape is stable.
   * @param {{ docType?: unknown, filename?: unknown, mimeType?: unknown, dataBase64?: unknown, capturedAt?: unknown, geo?: any }} [input]
   * @returns {{ docType: string, filename: string, mimeType: string, dataBase64: string, capturedAt?: string, geo?: any }}
   */
  function uploadPayload(input) {
    var b = input || {};
    var body = {
      docType: trim(b.docType),
      filename: text(b.filename),
      mimeType: trim(b.mimeType),
      dataBase64: text(b.dataBase64)
    };
    var capturedAt = trim(b.capturedAt);
    if (capturedAt) body.capturedAt = capturedAt;
    var geo = normalizeGeo(b.geo);
    if (geo) body.geo = geo;
    return body;
  }

  /**
   * The `PATCH /api/documents/:id` body. Only VERIFIED / REJECTED are accepted
   * (any other value maps to VERIFIED, mirroring the server's whitelist).
   * @param {unknown} status
   * @returns {{ status: string }}
   */
  function verifyPayload(status) {
    var next = trim(status).toUpperCase();
    return { status: MANAGE_STATUSES.indexOf(next) === -1 ? 'VERIFIED' : next };
  }

  /**
   * The checklist for a trip, delegated to the shared driver core so the app
   * and the driver client cannot disagree about the POD gate.
   * @param {any[]|undefined} documents
   * @param {any} core `pilot/lib/driver-core.js`
   * @returns {any[]}
   */
  function checklistRows(documents, core) {
    if (!core || typeof core.documentChecklist !== 'function') return [];
    return asArray(core.documentChecklist(documents));
  }

  /** Outstanding required-document count, delegated to the shared core. */
  function requiredMissing(documents, core) {
    if (!core || typeof core.requiredMissing !== 'function') return 0;
    return Number(core.requiredMissing(documents)) || 0;
  }

  /** Is the POD/eCMR requirement met? Delegated to the shared core. */
  function podSatisfied(documents, core) {
    if (!core || typeof core.podSatisfied !== 'function') return false;
    return Boolean(core.podSatisfied(documents));
  }

  /** May the trip move to POD_UPLOADED right now? Delegated to the shared core. */
  function canMarkPodUploaded(status, documents, core) {
    if (!core || typeof core.canMarkPodUploaded !== 'function') return false;
    return Boolean(core.canMarkPodUploaded(status, documents));
  }

  /** API error code -> catalogue key. Every key exists in `locales/en.json`. */
  var ERROR_KEYS = {
    invalid_doc_type: 'docs.error.docType',
    invalid_filename: 'docs.error.filename',
    unsupported_type: 'docs.error.mime',
    invalid_size: 'docs.error.empty',
    file_too_large: 'docs.error.tooLargeServer',
    invalid_capture: 'docs.error.capture',
    invalid_upload: 'docs.error.file',
    invalid_status: 'docs.error.status',
    forbidden: 'error.forbidden',
    not_found: 'docs.error.notFound',
    no_org: 'error.noOrg',
    storage_failed: 'docs.error.storage'
  };

  /**
   * Map a document request failure to a catalogue key that says what to do next.
   * Never returns a raw status code to the screen. A 413 (the reverse proxy's
   * own over-limit page) is mapped too, so an HTML error body can never reach
   * the driver as a blank result.
   * @param {{ status?: number, data?: any }|null} res
   * @returns {string}
   */
  function errorKey(res) {
    var status = res ? res.status : 0;
    if (status === 401) return 'error.sessionExpired';
    if (status === 403) return 'error.forbidden';
    if (status === 413) return 'docs.error.tooLargeServer';
    if (status === 429) return 'error.rateLimited';
    if (status === 0) return 'error.network';
    var code = res && res.data ? res.data.error : null;
    if (typeof code === 'string' && hasOwn(ERROR_KEYS, code)) return ERROR_KEYS[code];
    if (status === 400) return 'error.badRequest';
    return 'error.unexpected';
  }

  /**
   * The `{ detail }` the API attaches to a rejection, or '' — the message shows
   * it rather than dropping it.
   * @param {{ data?: any }|null} res
   * @returns {string}
   */
  function errorDetail(res) {
    var detail = res && res.data ? res.data.detail : null;
    return typeof detail === 'string' ? detail : '';
  }

  /** The catalogue key for a document status pill. */
  function statusKey(status) {
    return 'trips.docstatus.' + trim(status);
  }

  /** The catalogue key for a document type label. */
  function docTypeKey(docType) {
    return 'trips.doctype.' + trim(docType);
  }

  /** The `<select>` entries for the upload form, in the API's order. */
  function docTypeEntries() {
    var out = [];
    for (var i = 0; i < DOC_TYPES.length; i++) {
      out.push({ value: DOC_TYPES[i], labelKey: docTypeKey(DOC_TYPES[i]) });
    }
    return out;
  }

  return {
    DOC_TYPES: DOC_TYPES,
    POD_DOC_TYPES: POD_DOC_TYPES,
    ALLOWED_MIME: ALLOWED_MIME,
    DEFAULT_MAX_UPLOAD_BYTES: DEFAULT_MAX_UPLOAD_BYTES,
    MANAGE_ROLES: MANAGE_ROLES,
    PRESENT_STATUSES: PRESENT_STATUSES,
    MANAGE_STATUSES: MANAGE_STATUSES,
    isKnownDocType: isKnownDocType,
    isAllowedMime: isAllowedMime,
    isPresentStatus: isPresentStatus,
    canManageDocuments: canManageDocuments,
    canUploadDocuments: canUploadDocuments,
    formatBytes: formatBytes,
    resolveMaxBytes: resolveMaxBytes,
    validateUpload: validateUpload,
    acceptAttribute: acceptAttribute,
    uploadPath: uploadPath,
    documentPath: documentPath,
    normalizeGeo: normalizeGeo,
    uploadPayload: uploadPayload,
    verifyPayload: verifyPayload,
    checklistRows: checklistRows,
    requiredMissing: requiredMissing,
    podSatisfied: podSatisfied,
    canMarkPodUploaded: canMarkPodUploaded,
    errorKey: errorKey,
    errorDetail: errorDetail,
    statusKey: statusKey,
    docTypeKey: docTypeKey,
    docTypeEntries: docTypeEntries
  };
});
