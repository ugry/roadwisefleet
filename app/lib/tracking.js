/**
 * RoadwiseFleet Fleet Manager — customer tracking-link view model
 * (board task #39, FAv1-F8).
 *
 * The pure half of the tracking-link control: who may manage a link, the exact
 * request path, how a link's state (none / active / expired) is derived, and how
 * an API refusal reads back as a catalogue key.
 *
 * The signing, the token format and the per-trip revocation version all stay in
 * `apps/api/src/track-link.js` — this module never builds a token and never
 * restates the TTL; it only renders what the server returned. The one capability
 * it mirrors is the `trip:*` gate (`TRACK_LINK_PERMISSION`), so the control is
 * hidden from a role the API would refuse anyway.
 *
 * Loaded twice, on purpose, exactly like `app-core.js` and `documents.js`:
 *   - in the browser, as a classic script (`<script src="lib/tracking.js">`),
 *     which exposes `window.RoadwiseTracking`;
 *   - in the API test suite (`apps/api/src/tracking-ui.test.js`), so the state
 *     derivation and the error mapping are covered by `node --test
 *     apps/api/src/` with no install and no browser.
 *
 * Nothing here touches the DOM, the network, storage or the clock (callers pass
 * `nowMs` where the clock matters).
 * ES5-compatible syntax: the app targets cheap Android WebViews.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.RoadwiseTracking = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** Roles that hold `trip:*` and may mint/copy/revoke a tracking link. */
  var MANAGE_ROLES = ['owner', 'dispatcher'];

  /** Mirrors `TRACK_LINK_PERMISSION` in `apps/api/src/track-link.js`. */
  var TRACK_LINK_PERMISSION = 'trip:*';

  /** Mirrors the API default TTL (30 days) — display only. */
  var DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60;

  function text(value) {
    return value === null || value === undefined ? '' : String(value);
  }

  function trim(value) {
    return text(value).trim();
  }

  /**
   * Does this role hold `trip:*` (so it may mint/revoke a link)? Deny by
   * default. Mirrors `documents.js#canManageDocuments` and `app-core.js`.
   * @param {unknown} role
   * @returns {boolean}
   */
  function canManageTracking(role) {
    return MANAGE_ROLES.indexOf(trim(role)) !== -1;
  }

  /**
   * The per-trip tracking-link endpoint. The id is URL-encoded so it can never
   * change the request path.
   * @param {unknown} tripId
   * @returns {string}
   */
  function trackingPath(tripId) {
    return '/api/trips/' + encodeURIComponent(text(tripId)) + '/track-link';
  }

  /**
   * The link object out of a `{ link }` response body, or null. A response with
   * `link: null` (no live link) is `null`, and a body without a usable `url` is
   * treated as "no link" rather than rendered as one.
   * @param {any} data
   * @returns {{ token?: string, url: string, expiresAt?: string|null, ttlSeconds?: number }|null}
   */
  function linkFrom(data) {
    var link = data && data.link ? data.link : null;
    if (!link || typeof link.url !== 'string' || link.url.length === 0) return null;
    return link;
  }

  /**
   * The state of a link for display: `none`, `active` or `expired`. A link with
   * no parsable expiry is treated as active (the API only returns live links).
   * @param {any} link
   * @param {number} [nowMs]
   * @returns {'none'|'active'|'expired'}
   */
  function linkState(link, nowMs) {
    if (!link || typeof link.url !== 'string' || link.url.length === 0) return 'none';
    if (typeof link.expiresAt === 'string' && link.expiresAt.length > 0) {
      var expires = Date.parse(link.expiresAt);
      var now = typeof nowMs === 'number' ? nowMs : Date.now();
      if (isFinite(expires) && expires <= now) return 'expired';
    }
    return 'active';
  }

  /** Catalogue keys for the three display states. */
  var STATE_KEYS = {
    none: 'tracking.state.none',
    active: 'tracking.state.active',
    expired: 'tracking.state.expired'
  };

  /** The catalogue key for a link state. @param {unknown} state @returns {string} */
  function stateKey(state) {
    var key = STATE_KEYS[trim(state)];
    return typeof key === 'string' ? key : STATE_KEYS.none;
  }

  /**
   * The text the one-action copy button should put on the clipboard — the full
   * shareable URL, never a bare token.
   * @param {any} link
   * @returns {string}
   */
  function copyTarget(link) {
    return link && typeof link.url === 'string' ? link.url : '';
  }

  /** Error codes the API can answer with, mapped to a catalogue key. */
  var ERROR_KEYS = {
    forbidden: 'error.forbidden',
    no_org: 'error.noOrg',
    not_found: 'tracking.error.notFound',
    invalid_token: 'tracking.error.invalid'
  };

  /**
   * Map a tracking-link API failure to a catalogue key that says what to do.
   * Never returns a raw status code to the screen. Mirrors
   * `assign.js#assignErrorKey`.
   * @param {{ status?: number, data?: any }|null} res
   * @returns {string}
   */
  function errorKey(res) {
    var status = res ? res.status : 0;
    if (status === 401) return 'error.sessionExpired';
    if (status === 429) return 'error.rateLimited';
    if (status === 0) return 'error.network';
    var code = res && res.data ? res.data.error : null;
    if (typeof code === 'string' && Object.prototype.hasOwnProperty.call(ERROR_KEYS, code)) {
      return ERROR_KEYS[code];
    }
    if (status === 403) return 'error.forbidden';
    if (status === 404) return 'tracking.error.notFound';
    if (status === 400) return 'error.badRequest';
    return 'error.unexpected';
  }

  /**
   * The `{ detail }` the API attaches to a refusal, or ''.
   * @param {{ data?: any }|null} res
   * @returns {string}
   */
  function errorDetail(res) {
    var detail = res && res.data ? res.data.detail : null;
    return typeof detail === 'string' ? detail : '';
  }

  return {
    MANAGE_ROLES: MANAGE_ROLES,
    TRACK_LINK_PERMISSION: TRACK_LINK_PERMISSION,
    DEFAULT_TTL_SECONDS: DEFAULT_TTL_SECONDS,
    canManageTracking: canManageTracking,
    trackingPath: trackingPath,
    linkFrom: linkFrom,
    linkState: linkState,
    stateKey: stateKey,
    copyTarget: copyTarget,
    errorKey: errorKey,
    errorDetail: errorDetail
  };
});
