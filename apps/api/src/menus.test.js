/**
 * Role / account-type menu configuration (board task #112, AND2-MENU1) —
 * dependency-free coverage for `app/lib/menus.js` and its wiring into the Fleet
 * Manager shell (`app/lib/app-core.js`).
 *
 * Runs under the no-install CI job (`node --test apps/api/src/`): `node:*`
 * builtins plus the CJS shared cores only. One configuration, keyed by account
 * type + role; no item is rendered for a role that must not see it; both the
 * fleet-employed and the solo driver path are exercised.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import menus from '../../../app/lib/menus.js';
import appCore from '../../../app/lib/app-core.js';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '../../../app');
const CATALOGUE = JSON.parse(readFileSync(join(appDir, 'locales/en.json'), 'utf8'));

const ids = (accountType, role) => menus.itemIds(accountType, role);

test('the account types are the three registration choices (board #111)', () => {
  assert.deepEqual([...menus.ACCOUNT_TYPES].sort(), ['customer', 'fleet', 'solo_driver']);
  assert.equal(menus.isAccountType('customer'), true);
  assert.equal(menus.isAccountType('fleet'), true);
  assert.equal(menus.isAccountType('solo_driver'), true);
  assert.equal(menus.isAccountType('admin'), false);
  assert.equal(menus.isAccountType(null), false);
});

test('every account type + role maps to exactly one persona', () => {
  assert.equal(menus.menuSetFor('customer', 'customer'), menus.CUSTOMER);
  assert.equal(menus.menuSetFor('fleet', 'owner'), menus.FLEET_MANAGER);
  assert.equal(menus.menuSetFor('fleet', 'dispatcher'), menus.FLEET_MANAGER);
  assert.equal(menus.menuSetFor('fleet', 'accountant'), menus.FLEET_MANAGER);
  assert.equal(menus.menuSetFor('fleet', 'driver'), menus.FLEET_DRIVER);
  assert.equal(menus.menuSetFor('solo_driver', 'solo'), menus.SOLO_DRIVER);
});

test('an unknown account type or role gets no menu at all (deny by default)', () => {
  assert.equal(menus.menuSetFor('admin', 'owner'), null);
  assert.equal(menus.menuSetFor('fleet', 'admin'), null);
  assert.equal(menus.menuSetFor('fleet', ''), null);
  assert.equal(menus.menuSetFor(null, null), null);
  assert.deepEqual(menus.itemsFor('fleet', 'admin'), []);
  assert.deepEqual(menus.itemIds('admin', 'owner'), []);
  assert.deepEqual(menus.appNav('admin'), []);
  assert.equal(menus.canSee('fleet', 'admin', 'trips'), false);
});

test('itemsFor hands out a copy, so a caller cannot mutate the configuration', () => {
  const first = menus.itemsFor('fleet', 'owner');
  first.push({ id: 'injected' });
  first[0].id = 'hacked';
  assert.equal(menus.itemIds('fleet', 'owner').includes('injected'), false);
  assert.equal(menus.itemIds('fleet', 'owner')[0], 'overview');
});

test('the fleet manager sees the management groups; a dispatcher/accountant fewer', () => {
  const owner = ids('fleet', 'owner');
  for (const id of ['overview', 'trips', 'dispatch', 'documents', 'tracking', 'reviews',
    'drivers', 'vehicles', 'customers', 'compliance', 'finance', 'analytics',
    'market', 'fleet', 'billing', 'settings']) {
    assert.ok(owner.includes(id), `owner menu must contain ${id}`);
  }
  const dispatcher = ids('fleet', 'dispatcher');
  assert.ok(dispatcher.includes('drivers'));
  assert.ok(dispatcher.includes('market'));
  for (const forbidden of ['finance', 'analytics', 'billing', 'settings']) {
    assert.ok(!dispatcher.includes(forbidden), `dispatcher must not see ${forbidden}`);
  }
  // An accountant has invoice/settlement/reports rights but not trip:read.
  assert.deepEqual(ids('fleet', 'accountant'), ['overview', 'finance', 'analytics']);
  for (const forbidden of ['trips', 'dispatch', 'drivers', 'market', 'billing']) {
    assert.ok(!ids('fleet', 'accountant').includes(forbidden), `accountant must not see ${forbidden}`);
  }
});

test('a fleet-employed driver has NO Hauling Market feed and NO billing', () => {
  const driver = ids('fleet', 'driver');
  assert.deepEqual(driver, ['overview', 'trips', 'documents', 'money', 'messages', 'more', 'sos']);
  for (const forbidden of ['market', 'billing', 'dispatch', 'drivers', 'finance', 'settings',
    'vehicles', 'customers', 'compliance', 'analytics']) {
    assert.ok(!driver.includes(forbidden), `fleet driver must not see ${forbidden}`);
  }
});

test('a solo driver gets the marketplace, own truck/customers and free billing', () => {
  const solo = ids('solo_driver', 'solo');
  assert.deepEqual(solo, ['loads', 'truck', 'customers', 'wallet', 'community', 'verification', 'reviews', 'billing']);
  for (const forbidden of ['dispatch', 'drivers', 'settings', 'finance', 'money', 'sos']) {
    assert.ok(!solo.includes(forbidden), `solo driver must not see ${forbidden}`);
  }
});

test('a customer gets the booking/documents/payments set and no carrier tools', () => {
  const customer = ids('customer', 'customer');
  assert.deepEqual(customer, ['book', 'shipments', 'documents', 'payments', 'carriers', 'reviews', 'account']);
  for (const forbidden of ['dispatch', 'drivers', 'loads', 'wallet', 'verification', 'billing', 'settings']) {
    assert.ok(!customer.includes(forbidden), `customer must not see ${forbidden}`);
  }
});

test('both driver paths are exercised and differ', () => {
  const fleetDriver = ids('fleet', 'driver');
  const soloDriver = ids('solo_driver', 'solo');
  assert.notDeepEqual(fleetDriver, soloDriver);
  // Fleet-employed: the fleet owns the work — money/messages, no feed, no billing.
  assert.equal(menus.canSee('fleet', 'driver', 'money'), true);
  assert.equal(menus.canSee('fleet', 'driver', 'billing'), false);
  assert.equal(menus.canSee('fleet', 'driver', 'loads'), false);
  // Solo: self-employed — the feed and their own billing, no fleet tools.
  assert.equal(menus.canSee('solo_driver', 'solo', 'loads'), true);
  assert.equal(menus.canSee('solo_driver', 'solo', 'billing'), true);
  assert.equal(menus.canSee('solo_driver', 'solo', 'money'), false);
});

test('the shell navigation is the menu configuration projected onto real routes', () => {
  for (const role of appCore.ROLES) {
    const expected = menus.appNav(role).map((entry) => entry.app)
      .filter((app) => appCore.ROUTES.some((route) => route.id === app && route.nav !== false));
    const actual = appCore.navFor(role).map((route) => route.id);
    assert.deepEqual([...actual].sort(), [...expected].sort(), `${role} navigation vs menu`);
  }
  assert.deepEqual(appCore.navFor('nobody'), []);
  // Every /app/ item the menu exposes really is a served route.
  for (const role of appCore.ROLES) {
    for (const entry of menus.appNav(role)) {
      assert.ok(appCore.ROUTES.some((route) => route.id === entry.app), `${entry.id} -> ${entry.app}`);
      assert.equal(appCore.routeForPath('/app/' + (entry.app === 'overview' ? '' : entry.app)).id, entry.app);
    }
  }
});

test('every menu label has an English catalogue entry (no dead menu)', () => {
  for (const [accountType, roles] of Object.entries(menus.MENUS)) {
    for (const [role, items] of Object.entries(roles)) {
      assert.ok(items.length > 0, `${accountType}/${role} has a menu`);
      for (const entry of items) {
        assert.ok(entry.i18n in CATALOGUE, `${accountType}/${role} ${entry.id} -> ${entry.i18n} is missing`);
        assert.notEqual(entry.i18n, '', entry.id);
      }
    }
  }
});

test('no two personas share the exact same menu (the sets are genuinely distinct)', () => {
  const sets = {
    customer: JSON.stringify(ids('customer', 'customer')),
    fleet_manager: JSON.stringify(ids('fleet', 'owner')),
    fleet_driver: JSON.stringify(ids('fleet', 'driver')),
    solo_driver: JSON.stringify(ids('solo_driver', 'solo')),
  };
  const seen = new Set(Object.values(sets));
  assert.equal(seen.size, 4, 'each persona must have its own menu');
});
