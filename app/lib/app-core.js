/**
 * RoadwiseFleet Fleet Manager — application core (board task #32, FAv1-F1).
 *
 * The fleet-manager app is the first *real* product surface (board F1): an
 * authenticated shell at `/app/` that every later function (dashboard, trips,
 * dispatch, documents, tracking, finance) plugs into as a route.
 *
 * Loaded twice, on purpose, exactly like `pilot/lib/driver-core.js`:
 *   - in the browser, as a classic script (`<script src="lib/app-core.js">`),
 *     which exposes `window.RoadwiseAppCore`;
 *   - in the API test suite (`apps/api/src/app-shell.test.js`), so the routing,
 *     the role model, the guard and the renderers are covered by
 *     `node --test apps/api/src/` with no install and no browser.
 *
 * Nothing here touches the DOM, the network, storage or the clock: this file is
 * the decision logic only. `app.js` owns the DOM and the session; `app-core.js`
 * answers "is this path allowed for this role, and what does the shell look
 * like". ES5-compatible syntax: the pilot targets cheap Android WebViews.
 *
 * The role model mirrors the seeded roles in the API
 * (`apps/api/scripts/seed-pilot.ts`) and the RBAC helper
 * (`apps/api/src/auth/permissions.js`) — the API is authoritative; the app only
 * decides what to *show*. Deny by default: an unknown role gets no navigation
 * and no application.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.RoadwiseAppCore = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** Where the app is mounted. Absolute, so deep links and assets resolve. */
  var APP_BASE = '/app';
  var LOGIN_PATH = '/app/login';
  var HOME_PATH = '/app/';

  /** Session storage keys. Distinct from the pilot's so the two never share a token. */
  var TOKEN_KEY = 'rwf.app.token';
  var USER_KEY = 'rwf.app.user';

  /** The seeded roles. Anything else is unknown and treated as unauthenticated. */
  var ROLES = ['owner', 'dispatcher', 'accountant', 'driver'];

  /** Role labels (i18n keys). The app never prints a raw role id. */
  var ROLE_KEYS = {
    owner: 'role.owner',
    dispatcher: 'role.dispatcher',
    accountant: 'role.accountant',
    driver: 'role.driver'
  };

  /**
   * Where each role lands after login, and where a forbidden route sends it.
   * A driver's day starts on their own trips; dispatch roles start at home.
   */
  var ROLE_HOME = {
    owner: HOME_PATH,
    dispatcher: HOME_PATH,
    accountant: HOME_PATH,
    driver: '/app/my-trips'
  };

  /**
   * The route table. `roles` is the set of seeded roles allowed to open the
   * route — it is the app-level mirror of the API's capability checks:
   *
   *   owner       org:manage user:manage trip:* invoice:* settlement:* reports:read
   *   dispatcher  trip:* user:read reports:read
   *   accountant  invoice:* settlement:* reports:read
   *   driver      trip:read trip:status pod:upload expense:create
   *
   * So `trips` needs `trip:read` (owner/dispatcher/driver — the driver has their
   * own route), `finance` needs the invoice/settlement capabilities
   * (owner/accountant), and nothing but the owner gets `settings`.
   *
   * `task` is the board task that fills the panel in. Until that task lands the
   * route renders an honest empty state naming it, never fabricating data.
   */
  var ROUTES = [
    {
      id: 'overview',
      path: HOME_PATH,
      i18n: 'nav.overview',
      roles: ['owner', 'dispatcher', 'accountant', 'driver'],
      task: null
    },
    {
      id: 'trips',
      path: '/app/trips',
      i18n: 'nav.trips',
      roles: ['owner', 'dispatcher'],
      task: 'F3 · board #34'
    },
    {
      id: 'dispatch',
      path: '/app/dispatch',
      i18n: 'nav.dispatch',
      roles: ['owner', 'dispatcher'],
      task: 'F4/F5 · board #35/#36'
    },
    {
      id: 'documents',
      path: '/app/documents',
      i18n: 'nav.documents',
      roles: ['owner', 'dispatcher'],
      task: 'F6 · board #37'
    },
    {
      id: 'tracking',
      path: '/app/tracking',
      i18n: 'nav.tracking',
      roles: ['owner', 'dispatcher'],
      task: 'F8 · board #39'
    },
    {
      id: 'finance',
      path: '/app/finance',
      i18n: 'nav.finance',
      roles: ['owner', 'accountant'],
      task: 'F10 · board #51–#52'
    },
    {
      id: 'fleet',
      path: '/app/fleet',
      i18n: 'nav.fleet',
      roles: ['owner', 'dispatcher'],
      task: 'board #19'
    },
    {
      id: 'settings',
      path: '/app/settings',
      i18n: 'nav.settings',
      roles: ['owner'],
      task: null
    },
    {
      id: 'my-trips',
      path: '/app/my-trips',
      i18n: 'nav.myTrips',
      roles: ['driver'],
      task: 'F7 · board #38'
    }
  ];

  /** The login screen is a route too, but it is never in the navigation. */
  var LOGIN_ROUTE = { id: 'login', path: LOGIN_PATH, i18n: 'login.title', roles: [] };

  /** Rendered for an unknown `/app/*` path inside the shell (never a blank page). */
  var NOT_FOUND_ROUTE = { id: 'not-found', path: null, i18n: 'error.notFoundTitle', roles: [] };

  /**
   * @param {unknown} value
   * @returns {string}
   */
  function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * A path reduced to what the router matches on: no query, no fragment, no
   * trailing slash (except the mount root itself).
   * @param {unknown} value
   * @returns {string}
   */
  function normalizePath(value) {
    var path = String(value === null || value === undefined ? '' : value);
    path = path.split('#')[0].split('?')[0];
    if (!path) return '/';
    if (path.length > 1 && path.charAt(path.length - 1) === '/') path = path.slice(0, -1);
    return path;
  }

  /**
   * Is this path inside the app? (`/app`, `/app/`, `/app/anything`)
   * @param {unknown} pathname
   * @returns {boolean}
   */
  function isAppPath(pathname) {
    var path = normalizePath(pathname);
    return path === APP_BASE || path.indexOf(APP_BASE + '/') === 0;
  }

  /** @param {unknown} pathname @returns {boolean} */
  function isLoginPath(pathname) {
    return normalizePath(pathname) === LOGIN_PATH || normalizePath(pathname) === '/app/login.html';
  }

  /** @param {unknown} role @returns {boolean} */
  function isKnownRole(role) {
    return typeof role === 'string' && ROLES.indexOf(role) !== -1;
  }

  /**
   * The route for a path, or `NOT_FOUND_ROUTE` for an unknown `/app/*` path,
   * or `null` when the path is outside the app entirely.
   * @param {unknown} pathname
   * @returns {{ id: string, path: string|null, i18n: string, roles: string[], task?: string|null }|null}
   */
  function routeForPath(pathname) {
    if (!isAppPath(pathname)) return null;
    if (isLoginPath(pathname)) return LOGIN_ROUTE;
    var path = normalizePath(pathname);
    if (path === APP_BASE) return ROUTES[0];
    for (var i = 0; i < ROUTES.length; i++) {
      if (ROUTES[i].path === path) return ROUTES[i];
    }
    return NOT_FOUND_ROUTE;
  }

  /**
   * The navigation a role may see. Unknown roles get nothing — deny by default.
   * @param {unknown} role
   * @returns {Array<{ id: string, path: string, i18n: string, roles: string[] }>}
   */
  function navFor(role) {
    if (!isKnownRole(role)) return [];
    return ROUTES.filter(function (route) {
      return route.roles.indexOf(role) !== -1;
    });
  }

  /** @param {unknown} role @returns {boolean} */
  function canOpen(role, pathname) {
    if (!isKnownRole(role)) return false;
    var route = routeForPath(pathname);
    if (!route) return false;
    return route.roles.indexOf(role) !== -1;
  }

  /**
   * The single guard decision for a navigation.
   *
   *   { action: 'login' }                        no (or unusable) session
   *   { action: 'home', to }                     already signed in, on /app/login
   *   { action: 'redirect', to }                 signed in, route not for this role
   *   { action: 'render', route }                signed in, route allowed
   *
   * @param {{ path?: unknown, hasToken?: unknown, role?: unknown }} [input]
   * @returns {{ action: string, to?: string, route?: any }}
   */
  function guardDecision(input) {
    var b = input || {};
    if (!isAppPath(b.path)) return { action: 'render', route: null };
    var role = isKnownRole(b.role) ? b.role : null;
    var signedIn = Boolean(b.hasToken) && role !== null;

    if (isLoginPath(b.path)) {
      if (signedIn) return { action: 'home', to: ROLE_HOME[role] || HOME_PATH };
      return { action: 'render', route: LOGIN_ROUTE };
    }
    if (!signedIn) return { action: 'login', to: LOGIN_PATH };

    var route = routeForPath(b.path);
    if (!route) return { action: 'login', to: LOGIN_PATH };
    if (route.id === 'not-found') return { action: 'render', route: route };
    if (route.roles.indexOf(role) === -1) {
      return { action: 'redirect', to: ROLE_HOME[role] || HOME_PATH };
    }
    return { action: 'render', route: route };
  }

  /**
   * Navigation markup for a role. Labels come from the catalogue and are
   * escaped; ids and hrefs come from the static table above, never from input.
   * @param {unknown} role
   * @param {(key: string) => string} [t]
   * @param {unknown} [currentPath]
   * @returns {string}
   */
  function navHtml(role, t, currentPath) {
    var translate = typeof t === 'function' ? t : function (key) { return key; };
    var current = normalizePath(currentPath);
    var items = navFor(role);
    var html = '';
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var active = normalizePath(item.path) === current;
      html += '<a class="nav-item' + (active ? ' is-active' : '') + '"' +
        ' data-nav="' + escapeHtml(item.id) + '"' +
        ' href="' + escapeHtml(item.path) + '"' +
        (active ? ' aria-current="page"' : '') + '>' +
        escapeHtml(translate(item.i18n)) +
        '</a>';
      }
    return html;
  }

  /**
   * The empty/placeholder panel body for a route. Until the owning task lands,
   * the panel states which task fills it — it never shows invented data.
   * @param {{ task?: string|null }|null} route
   * @param {(key: string, params?: any) => string} [t]
   * @returns {{ title: string, body: string, task: string|null }}
   */
  function panelFor(route, t) {
    var translate = typeof t === 'function' ? t : function (key) { return key; };
    if (!route) {
      return { title: translate('error.notFoundTitle'), body: translate('error.notFoundBody'), task: null };
    }
    if (route.id === 'not-found') {
      return { title: translate('error.notFoundTitle'), body: translate('error.notFoundBody'), task: null };
    }
    if (route.id === 'overview') {
      return { title: translate('overview.title'), body: translate('overview.body'), task: null };
    }
    return {
      title: translate(route.i18n),
      body: translate('common.pending', { task: route.task || translate('common.unplanned') }),
      task: route.task || null
    };
  }

  /**
   * Map an API error to a catalogue key, so the app shows "what to do next"
   * rather than a raw status code. Unknown codes fall back to a generic key.
   * @param {unknown} error
   * @param {unknown} [status]
   * @returns {string}
   */
  function errorKey(error, status) {
    var known = {
      invalid_credentials: 'error.invalidCredentials',
      account_locked: 'error.accountLocked',
      unauthorized: 'error.sessionExpired',
      forbidden: 'error.forbidden',
      no_org: 'error.noOrg',
      not_found: 'error.notFoundBody'
    };
    if (typeof error === 'string' && Object.prototype.hasOwnProperty.call(known, error)) {
      return known[error];
    }
    var statusKeys = {
      400: 'error.badRequest',
      401: 'error.sessionExpired',
      403: 'error.forbidden',
      404: 'error.notFoundBody',
      423: 'error.accountLocked',
      429: 'error.rateLimited'
    };
    if (status && Object.prototype.hasOwnProperty.call(statusKeys, status)) return statusKeys[status];
    return 'error.unexpected';
  }

  /** The role label key, or the generic "signed in" key for an unknown role. */
  function roleKey(role) {
    return ROLE_KEYS[role] || 'role.unknown';
  }

  /**
   * The path segment the static server uses to find the app root. Kept as a
   * function so `app.js`, the tests and the API agree on one constant.
   * @returns {string}
   */
  function appBase() {
    return APP_BASE;
  }

  return {
    APP_BASE: APP_BASE,
    LOGIN_PATH: LOGIN_PATH,
    HOME_PATH: HOME_PATH,
    TOKEN_KEY: TOKEN_KEY,
    USER_KEY: USER_KEY,
    ROLES: ROLES,
    ROLE_KEYS: ROLE_KEYS,
    ROLE_HOME: ROLE_HOME,
    ROUTES: ROUTES,
    LOGIN_ROUTE: LOGIN_ROUTE,
    NOT_FOUND_ROUTE: NOT_FOUND_ROUTE,
    appBase: appBase,
    escapeHtml: escapeHtml,
    normalizePath: normalizePath,
    isAppPath: isAppPath,
    isLoginPath: isLoginPath,
    isKnownRole: isKnownRole,
    routeForPath: routeForPath,
    navFor: navFor,
    canOpen: canOpen,
    guardDecision: guardDecision,
    navHtml: navHtml,
    panelFor: panelFor,
    errorKey: errorKey,
    roleKey: roleKey
  };
});
