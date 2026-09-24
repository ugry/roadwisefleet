/**
 * Fleet Manager app shell (board task #32, FAv1-F1) — dependency-free coverage
 * for `app/lib/app-core.js`, the routing/role/guard logic both the browser and
 * the tests share.
 *
 * Runs under the no-install CI job (`node --test apps/api/src/`), so it imports
 * only `node:*` builtins plus the CJS app core. The HTTP-level assertions on the
 * same files live in `apps/api/test/app-shell.test.ts` (`pnpm test:router`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import appCore from '../../../app/lib/app-core.js';

const ROUTE_IDS = (role) => appCore.navFor(role).map((r) => r.id);

test('the role model is exactly the four seeded roles', () => {
  assert.deepEqual([...appCore.ROLES].sort(), ['accountant', 'dispatcher', 'driver', 'owner']);
  assert.equal(appCore.isKnownRole('owner'), true);
  assert.equal(appCore.isKnownRole('admin'), false);
  assert.equal(appCore.isKnownRole(null), false);
});

test('an unknown role gets no navigation at all (deny by default)', () => {
  assert.deepEqual(appCore.navFor('admin'), []);
  assert.deepEqual(appCore.navFor(null), []);
  assert.deepEqual(appCore.navFor(''), []);
});

test('a driver never sees dispatcher navigation', () => {
  const driver = ROUTE_IDS('driver');
  assert.deepEqual(driver, ['overview', 'my-trips']);
  for (const forbidden of ['trips', 'dispatch', 'documents', 'tracking', 'finance', 'fleet', 'settings']) {
    assert.ok(!driver.includes(forbidden), `driver nav must not contain ${forbidden}`);
  }
});

test('dispatcher, accountant and owner get the navigation their capabilities allow', () => {
  const dispatcher = ROUTE_IDS('dispatcher');
  assert.deepEqual(dispatcher, ['overview', 'trips', 'dispatch', 'documents', 'tracking', 'fleet']);
  for (const forbidden of ['finance', 'settings', 'my-trips']) {
    assert.ok(!dispatcher.includes(forbidden), `dispatcher nav must not contain ${forbidden}`);
  }
  // An accountant has invoice:*/settlement:*/reports:read but not trip:read, so
  // the trips list is deliberately absent.
  assert.deepEqual(ROUTE_IDS('accountant'), ['overview', 'finance']);
  const owner = ROUTE_IDS('owner');
  for (const id of ['overview', 'trips', 'dispatch', 'documents', 'tracking', 'finance', 'fleet', 'settings']) {
    assert.ok(owner.includes(id), `owner nav must contain ${id}`);
  }
});

test('every route is mounted under /app and ids/paths are unique', () => {
  const ids = new Set();
  const paths = new Set();
  for (const route of appCore.ROUTES) {
    assert.ok(route.path.indexOf('/app/') === 0, `${route.id} must live under /app/`);
    assert.ok(!ids.has(route.id), `duplicate route id ${route.id}`);
    assert.ok(!paths.has(route.path), `duplicate route path ${route.path}`);
    ids.add(route.id);
    paths.add(route.path);
  }
});

test('paths are normalised before matching', () => {
  assert.equal(appCore.normalizePath('/app/trips/'), '/app/trips');
  assert.equal(appCore.normalizePath('/app/trips?x=1#y'), '/app/trips');
  assert.equal(appCore.normalizePath('/app/'), '/app');
  assert.equal(appCore.normalizePath(''), '/');
  assert.equal(appCore.isAppPath('/app/anything'), true);
  assert.equal(appCore.isAppPath('/app'), true);
  assert.equal(appCore.isAppPath('/api/trips'), false);
  assert.equal(appCore.isLoginPath('/app/login'), true);
});

test('routeForPath maps the app root, the login screen and unknown deep links', () => {
  assert.equal(appCore.routeForPath('/app').id, 'overview');
  assert.equal(appCore.routeForPath('/app/').id, 'overview');
  assert.equal(appCore.routeForPath('/app/login').id, 'login');
  assert.equal(appCore.routeForPath('/app/login.html').id, 'login');
  assert.equal(appCore.routeForPath('/app/trips').id, 'trips');
  assert.equal(appCore.routeForPath('/app/nowhere').id, 'not-found');
  assert.equal(appCore.routeForPath('/pilot/dashboard.html'), null);
});

test('an unauthenticated visit to any /app/* path goes to login', () => {
  for (const path of ['/app', '/app/', '/app/trips', '/app/dispatch', '/app/my-trips', '/app/unknown']) {
    const decision = appCore.guardDecision({ path, hasToken: false, role: null });
    assert.deepEqual(decision, { action: 'login', to: '/app/login' }, `${path} must redirect to login`);
  }
});

test('the login screen renders when there is no session, and bounces a signed-in user home', () => {
  assert.equal(appCore.guardDecision({ path: '/app/login', hasToken: false, role: null }).action, 'render');
  assert.deepEqual(appCore.guardDecision({ path: '/app/login', hasToken: true, role: 'owner' }), {
    action: 'home',
    to: '/app/',
  });
  assert.deepEqual(appCore.guardDecision({ path: '/app/login', hasToken: true, role: 'driver' }), {
    action: 'home',
    to: '/app/my-trips',
  });
});

test('a signed-in role is redirected off a route it does not own', () => {
  assert.deepEqual(appCore.guardDecision({ path: '/app/trips', hasToken: true, role: 'driver' }), {
    action: 'redirect',
    to: '/app/my-trips',
  });
  // The client guard mirrors the API's RBAC: an accountant has no trip:read.
  assert.deepEqual(appCore.guardDecision({ path: '/app/trips', hasToken: true, role: 'accountant' }), {
    action: 'redirect',
    to: '/app/',
  });
  assert.deepEqual(appCore.guardDecision({ path: '/app/settings', hasToken: true, role: 'dispatcher' }), {
    action: 'redirect',
    to: '/app/',
  });
});

test('a token with an unrecognised role is treated as no session', () => {
  assert.deepEqual(appCore.guardDecision({ path: '/app/trips', hasToken: true, role: 'superuser' }), {
    action: 'login',
    to: '/app/login',
  });
});

test('allowed routes render, and an unknown /app/* path renders the not-found panel inside the shell', () => {
  assert.equal(appCore.guardDecision({ path: '/app/trips', hasToken: true, role: 'dispatcher' }).route.id, 'trips');
  assert.equal(appCore.guardDecision({ path: '/app/my-trips', hasToken: true, role: 'driver' }).route.id, 'my-trips');
  assert.equal(appCore.guardDecision({ path: '/app/nope', hasToken: true, role: 'owner' }).route.id, 'not-found');
});

test('canOpen agrees with navFor', () => {
  for (const role of appCore.ROLES) {
    for (const route of appCore.ROUTES) {
      assert.equal(
        appCore.canOpen(role, route.path),
        route.roles.includes(role),
        `${role} + ${route.path}`,
      );
    }
  }
  assert.equal(appCore.canOpen('driver', '/app/trips'), false);
  assert.equal(appCore.canOpen('nobody', '/app/'), false);
});

test('nav markup is role-scoped, marks the current page and escapes its labels', () => {
  const t = (key) => `[${key}]`;
  const driverNav = appCore.navHtml('driver', t, '/app/my-trips');
  assert.match(driverNav, /data-nav="my-trips"/);
  assert.ok(!driverNav.includes('data-nav="trips"'), 'the driver nav must not contain the dispatcher trips entry');
  assert.match(driverNav, /aria-current="page"/);
  assert.match(driverNav, /\[nav\.myTrips\]/);

  const injected = appCore.navHtml('owner', () => '<img src=x onerror=alert(1)>', '/app/');
  assert.ok(!injected.includes('<img'), 'catalogue text must be escaped before it reaches innerHTML');
  assert.match(injected, /&lt;img/);
});

test('escapeHtml neutralises the five dangerous characters', () => {
  assert.equal(appCore.escapeHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  assert.equal(appCore.escapeHtml(null), '');
  assert.equal(appCore.escapeHtml(0), '0');
});

test('panelFor marks implemented views and names the board task that fills a placeholder', () => {
  const t = (key, params) => `${key}${params && params.task ? '(' + params.task + ')' : ''}`;
  // Board task #34 (FAv1-F3): the trips list is implemented, so the core only
  // supplies its title and an honest loading body — no "pending task" note.
  const trips = appCore.panelFor(appCore.routeForPath('/app/trips'), t);
  assert.equal(trips.title, 'nav.trips');
  assert.equal(trips.body, 'common.loading');
  assert.equal(trips.task, null);
  // The dynamic trip-detail route is implemented too.
  assert.equal(appCore.panelFor(appCore.routeForPath('/app/trips/trip-1'), t).title, 'trips.detailTitle');
  // A route still awaiting its task keeps the placeholder that names the task.
  const dispatch = appCore.panelFor(appCore.routeForPath('/app/dispatch'), t);
  assert.match(dispatch.body, /common\.pending\(F4\/F5 · board #35\/#36\)/);
  assert.equal(appCore.panelFor(appCore.routeForPath('/app/nope'), t).title, 'error.notFoundTitle');
  const overview = appCore.panelFor(appCore.routeForPath('/app/'), t);
  assert.equal(overview.title, 'overview.title');
  assert.equal(overview.task, null);
});

test('errorKey maps API errors and status codes to catalogue keys', () => {
  assert.equal(appCore.errorKey('invalid_credentials', 401), 'error.invalidCredentials');
  assert.equal(appCore.errorKey('account_locked', 423), 'error.accountLocked');
  assert.equal(appCore.errorKey('unauthorized', 401), 'error.sessionExpired');
  assert.equal(appCore.errorKey(undefined, 403), 'error.forbidden');
  assert.equal(appCore.errorKey(undefined, 429), 'error.rateLimited');
  assert.equal(appCore.errorKey('whatever', 999), 'error.unexpected');
  assert.equal(appCore.errorKey(undefined, undefined), 'error.unexpected');
});

test('roleKey never leaks a raw role id it does not know', () => {
  assert.equal(appCore.roleKey('driver'), 'role.driver');
  assert.equal(appCore.roleKey('admin'), 'role.unknown');
  assert.equal(appCore.roleKey(undefined), 'role.unknown');
});

test('the session keys are app-scoped, not shared with the pilot', () => {
  assert.equal(appCore.TOKEN_KEY, 'rwf.app.token');
  assert.equal(appCore.USER_KEY, 'rwf.app.user');
  assert.notEqual(appCore.TOKEN_KEY, 'rwf_token');
});
