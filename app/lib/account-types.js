/**
 * RoadwiseFleet — account types (board task #111, AND2-REG1).
 *
 * One catalogue of the three account types a person can register as — the
 * owner's decision (2026-10-01): "Register as a customer, register as a fleet,
 * register as a solo truck driver. For solo truck drivers everything is free,
 * for customers too." Loaded twice, on purpose, exactly like `signup.js`:
 *
 *   - in the browser, as a classic script (`<script src="/app/lib/account-types.js">`),
 *     which exposes `window.RoadwiseAccountTypes`;
 *   - in the API (`apps/api/src/routes/auth.ts`, `registration-accounts.js`) and
 *     in the no-install test suite
 *     (`apps/api/src/account-types.test.js`).
 *
 * The chosen type is persisted SERVER-SIDE as the account/org type + role: this
 * module is the single mapping from a type id to the role the server will grant,
 * so a client can never self-upgrade — `roleFor('solo_driver')` is `solo` no
 * matter what the request body claims. Nothing here touches the DOM, the network,
 * storage or the clock: decision logic only. ES5-compatible syntax (the pilot
 * targets cheap Android WebViews).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.RoadwiseAccountTypes = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * The three registration choices, in the order the signup form offers them.
   *
   *   id           the persisted account/org type
   *   role         the role the SERVER derives (never taken from the request)
   *   plan         the org plan written when this type creates an org
   *   free         true when the type costs nothing
   *   trialMonths  free months before billing starts (fleets only)
   *   priceEur     monthly price after the trial (0 when free)
   *   labelKey / hintKey  catalogue keys the form renders
   */
  var ACCOUNT_TYPES = [
    {
      id: 'customer',
      role: 'customer',
      plan: 'free',
      free: true,
      trialMonths: 0,
      priceEur: 0,
      labelKey: 'account.type.customer',
      hintKey: 'account.type.customerHint',
    },
    {
      id: 'fleet',
      role: 'owner',
      plan: 'free',
      free: false,
      trialMonths: 1,
      priceEur: 20,
      labelKey: 'account.type.fleet',
      hintKey: 'account.type.fleetHint',
    },
    {
      id: 'solo_driver',
      role: 'solo',
      plan: 'free',
      free: true,
      trialMonths: 0,
      priceEur: 0,
      labelKey: 'account.type.soloDriver',
      hintKey: 'account.type.soloDriverHint',
    },
  ];

  /** The type a request with no explicit choice is treated as (legacy clients). */
  var DEFAULT_ACCOUNT_TYPE = 'fleet';

  var BY_ID = {};
  for (var i = 0; i < ACCOUNT_TYPES.length; i++) BY_ID[ACCOUNT_TYPES[i].id] = ACCOUNT_TYPES[i];

  /** @returns {string[]} every valid account-type id, form order. */
  function ids() {
    return ACCOUNT_TYPES.map(function (t) { return t.id; });
  }

  /** @param {unknown} id @returns {boolean} */
  function isAccountType(id) {
    return typeof id === 'string' && Object.prototype.hasOwnProperty.call(BY_ID, id);
  }

  /** @param {unknown} id @returns {{ id: string, role: string, plan: string, free: boolean, trialMonths: number, priceEur: number, labelKey: string, hintKey: string }|null} */
  function type(id) {
    return isAccountType(id) ? BY_ID[id] : null;
  }

  /**
   * The role the SERVER grants for a chosen type. `null` for an unknown type, so
   * a caller can refuse rather than guess.
   * @param {unknown} id
   * @returns {string|null}
   */
  function roleFor(id) {
    var t = type(id);
    return t ? t.role : null;
  }

  /**
   * Whether a type's sign-up path is free. Unknown types are NOT free (deny by
   * default): a caller must decide, never assume a paid type is free.
   * @param {unknown} id
   * @returns {boolean}
   */
  function isFree(id) {
    var t = type(id);
    return t ? t.free === true : false;
  }

  /**
   * The type id to use when the request omits one (legacy clients register a
   * fleet). Valid ids pass through unchanged; anything else falls back to the
   * default, so validation (`isAccountType`) stays the authoritative gate.
   * @param {unknown} id
   * @returns {string}
   */
  function normalize(id) {
    return isAccountType(id) ? id : DEFAULT_ACCOUNT_TYPE;
  }

  /**
   * Derive the account type of an already-signed-in principal, so a surface can
   * pick the right menu without a second round-trip. This mirrors what the
   * server persisted: a `driver` with an org is fleet-employed, a `driver`
   * without one is a solo driver. Unknown roles return `null`.
   * @param {{ roleId?: unknown, orgId?: unknown }} [user]
   * @returns {string|null}
   */
  function accountTypeForUser(user) {
    var u = user || {};
    var role = typeof u.roleId === 'string' ? u.roleId : '';
    if (role === 'customer') return 'customer';
    if (role === 'solo') return 'solo_driver';
    if (role === 'driver') return u.orgId ? 'fleet' : 'solo_driver';
    if (role === 'owner' || role === 'dispatcher' || role === 'accountant') return 'fleet';
    return null;
  }

  return {
    ACCOUNT_TYPES: ACCOUNT_TYPES,
    DEFAULT_ACCOUNT_TYPE: DEFAULT_ACCOUNT_TYPE,
    ids: ids,
    isAccountType: isAccountType,
    type: type,
    roleFor: roleFor,
    isFree: isFree,
    normalize: normalize,
    accountTypeForUser: accountTypeForUser,
  };
});
