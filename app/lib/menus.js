/**
 * RoadwiseFleet — role / account-type menu configuration (board task #112,
 * AND2-MENU1).
 *
 * ONE configuration of "which menu a person sees", keyed by **account type and
 * role** (owner decision 2026-10-01, item 3: "menu options should be shown based
 * on who is driver part of fleet? Or solo?"). The four personas the design
 * defines (`docs/ux-flows/08-menus-overview.mmd`) each get their own set:
 *
 *   - customer          (accountType `customer`)        — the customer portal
 *   - fleet_manager     (accountType `fleet`, owner / dispatcher / accountant)
 *   - fleet_driver      (accountType `fleet`, role `driver`) — NO Hauling Market,
 *                       no billing: the fleet owns the work
 *   - solo_driver       (accountType `solo_driver`, role `solo`) — Hauling Market
 *                       feed, own truck/customers, wallet, community,
 *                       verification, two-way reviews; billing is Free
 *
 * The account-type ids mirror `app/lib/account-types.js` (board #111) so the
 * registration choice and the menu set are the same vocabulary. This module does
 * NOT re-derive the account type — the caller passes what the session holds — and
 * it never touches the DOM, network, storage or clock.
 *
 * Loaded twice, on purpose, exactly like the other shared cores:
 *   - in the browser as a classic script (`<script src="/app/lib/menus.js">`),
 *     exposing `window.RoadwiseMenus`;
 *   - in the API/no-install test suite (`apps/api/src/menus.test.js`).
 *
 * An item carries the `/app/` route id it maps to in `app` (`null` when the item
 * belongs to another surface — the customer portal, the solo portal or the
 * Android shell). `appNav(role)` is the projection the web Fleet-Manager shell
 * renders; the other surfaces consume the persona sets directly.
 *
 * Deny by default: an unknown account type/role gets no menu at all.
 * ES5-compatible syntax (the pilot targets cheap Android WebViews).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.RoadwiseMenus = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** The three account types a person can register as (board #111). */
  var ACCOUNT_TYPES = ['customer', 'fleet', 'solo_driver'];

  /** The four menu personas of the design (`08-menus-overview.mmd`). */
  var CUSTOMER = 'customer';
  var FLEET_MANAGER = 'fleet_manager';
  var FLEET_DRIVER = 'fleet_driver';
  var SOLO_DRIVER = 'solo_driver';

  /**
   * One menu item.
   * @param {string} id   the stable item id (also the `data-nav` value)
   * @param {string} i18n the catalogue key for its label
   * @param {string|null} [app] the `/app/` route id this item opens; omitted =>
   *   the same as `id`; `null` => another surface owns the item
   */
  function item(id, i18n, app) {
    return { id: id, i18n: i18n, app: app === undefined ? id : app };
  }

  /**
   * accountType -> role -> items, in the order the surface should show them.
   * The `fleet` persona is split by sub-role; the customer and solo sets are a
   * single role each.
   */
  var MENUS = {
    customer: {
      customer: [
        item('book', 'nav.book', null),
        item('shipments', 'nav.shipments', null),
        item('documents', 'nav.documents', null),
        item('payments', 'nav.payments', null),
        item('carriers', 'nav.carriers', null),
        item('reviews', 'nav.reviews', null),
        item('account', 'nav.account', null),
      ],
    },
    fleet: {
      owner: [
        item('overview', 'nav.overview'),
        item('trips', 'nav.trips'),
        item('dispatch', 'nav.dispatch'),
        item('documents', 'nav.documents'),
        item('tracking', 'nav.tracking'),
        item('reviews', 'nav.reviews'),
        item('drivers', 'nav.drivers'),
        item('vehicles', 'nav.vehicles'),
        item('customers', 'nav.customers'),
        item('compliance', 'nav.compliance'),
        item('finance', 'nav.finance'),
        item('analytics', 'nav.analytics'),
        item('market', 'nav.market'),
        item('fleet', 'nav.fleet'),
        item('billing', 'nav.billing'),
        item('settings', 'nav.settings'),
      ],
      dispatcher: [
        item('overview', 'nav.overview'),
        item('trips', 'nav.trips'),
        item('dispatch', 'nav.dispatch'),
        item('documents', 'nav.documents'),
        item('tracking', 'nav.tracking'),
        item('reviews', 'nav.reviews'),
        item('drivers', 'nav.drivers'),
        item('vehicles', 'nav.vehicles'),
        item('customers', 'nav.customers'),
        item('compliance', 'nav.compliance'),
        item('market', 'nav.market'),
        item('fleet', 'nav.fleet'),
      ],
      accountant: [
        item('overview', 'nav.overview'),
        item('finance', 'nav.finance'),
        item('analytics', 'nav.analytics'),
      ],
      // Fleet-employed driver (invited by the fleet). The web driver client is
      // `/app/my-trips`; the Android shell renders documents/money/messages/more
      // from the same items (their `app` is null because they are not /app/
      // routes). NO Hauling Market feed and NO billing — the fleet owns the work.
      driver: [
        item('overview', 'nav.overview', 'overview'),
        item('trips', 'nav.myTrips', 'my-trips'),
        item('documents', 'nav.documents', null),
        item('money', 'nav.money', null),
        item('messages', 'nav.messages', null),
        item('more', 'nav.more', null),
        item('sos', 'nav.sos', null),
      ],
    },
    // Solo driver (self-registered, free): the Hauling Market feed, own truck
    // and customers, wallet, community, optional verification marks, two-way
    // reviews. Billing shows Free — there is no plan to buy.
    solo_driver: {
      solo: [
        item('loads', 'nav.loads', null),
        item('truck', 'nav.truck', null),
        item('customers', 'nav.myCustomers', null),
        item('wallet', 'nav.wallet', null),
        item('community', 'nav.community', null),
        item('verification', 'nav.verification', null),
        item('reviews', 'nav.reviews', null),
        item('billing', 'nav.billingFree', null),
      ],
    },
  };

  /** @param {unknown} id @returns {boolean} */
  function isAccountType(id) {
    return typeof id === 'string' && ACCOUNT_TYPES.indexOf(id) !== -1;
  }

  /**
   * The persona a surface renders for an account type + role. `null` when the
   * pair is not a known persona (deny by default).
   * @param {unknown} accountType
   * @param {unknown} role
   * @returns {string|null}
   */
  function menuSetFor(accountType, role) {
    if (!isAccountType(accountType) || typeof role !== 'string' || role === '') return null;
    var byType = MENUS[accountType];
    if (!byType || !Object.prototype.hasOwnProperty.call(byType, role)) return null;
    if (accountType === 'customer') return CUSTOMER;
    if (accountType === 'solo_driver') return SOLO_DRIVER;
    if (accountType === 'fleet') return role === 'driver' ? FLEET_DRIVER : FLEET_MANAGER;
    return null;
  }

  /**
   * The menu items for an account type + role, in display order. A fresh array
   * (the config itself is never handed out) and `[]` for an unknown pair.
   * @param {unknown} accountType
   * @param {unknown} role
   * @returns {Array<{ id: string, i18n: string, app: string|null }>}
   */
  function itemsFor(accountType, role) {
    var byType = MENUS[accountType];
    if (!byType) return [];
    var items = byType[role];
    if (!Array.isArray(items)) return [];
    // A deep-enough copy: the caller gets fresh objects, so it can never mutate
    // the configuration itself.
    return items.map(function (entry) {
      return { id: entry.id, i18n: entry.i18n, app: entry.app };
    });
  }

  /**
   * @param {unknown} accountType
   * @param {unknown} role
   * @returns {string[]}
   */
  function itemIds(accountType, role) {
    return itemsFor(accountType, role).map(function (entry) { return entry.id; });
  }

  /**
   * May this account type + role see this menu item? Unknown pairs see nothing.
   * @param {unknown} accountType
   * @param {unknown} role
   * @param {unknown} id
   * @returns {boolean}
   */
  function canSee(accountType, role, id) {
    return itemIds(accountType, role).indexOf(id) !== -1;
  }

  /**
   * The items of the WEB Fleet-Manager app (`/app/`) for a role: the fleet
   * persona projected onto the app's own routes. Items owned by another surface
   * (`app: null`) are left out, so the app never links to a page it does not
   * serve. Returns `[]` for a role it does not know.
   * @param {unknown} role
   * @returns {Array<{ id: string, i18n: string, app: string }>}
   */
  function appNav(role) {
    return itemsFor('fleet', role).filter(function (entry) {
      return typeof entry.app === 'string' && entry.app !== '';
    });
  }

  return {
    ACCOUNT_TYPES: ACCOUNT_TYPES,
    CUSTOMER: CUSTOMER,
    FLEET_MANAGER: FLEET_MANAGER,
    FLEET_DRIVER: FLEET_DRIVER,
    SOLO_DRIVER: SOLO_DRIVER,
    MENUS: MENUS,
    isAccountType: isAccountType,
    menuSetFor: menuSetFor,
    itemsFor: itemsFor,
    itemIds: itemIds,
    canSee: canSee,
    appNav: appNav,
  };
});
