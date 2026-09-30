/**
 * Dispatch create-trip form (board task #35, FAv1-F4) — dependency-free
 * coverage for the pure half of the form.
 *
 * Runs under the no-install CI job (`node --test apps/api/src/`): `node:*`
 * builtins only, no Fastify, no Prisma, no browser. The HTTP-level assertions
 * live in the app-shell/router suites; here we prove the decisions:
 *
 *   - the option labels never leak a raw id;
 *   - validation catches every mistake BEFORE the request is sent, and each
 *     error names the field to fix;
 *   - the payload is exactly the `POST /api/trips` contract;
 *   - the API error codes map to catalogue keys that exist in en.json;
 *   - a driver can never reach `/app/dispatch`;
 *   - `app.js` resolves the dynamic form elements with `querySelector`, never
 *     with the static-shell `el()` helper (which the shell test boots on).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import dispatch from '../../../app/lib/dispatch.js';
import appCore from '../../../app/lib/app-core.js';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '../../../app');
const readApp = (name) => readFileSync(join(appDir, name), 'utf8');

const APP_JS = readApp('app.js');
const PAGE = readApp('index.html');
const CATALOGUE = JSON.parse(readApp('locales/en.json'));

/** A realistic `GET /api/reference` payload (seeded pilot shape). */
const REFERENCE = {
  orders: [
    { id: 'ord_1', origin: 'Rotterdam', destination: 'Berlin', cargo: 'Pallets', status: 'BOOKED', customer: { id: 'cus_1', name: 'Acme BV' } },
    { id: 'ord_2', origin: 'Ghent', destination: 'Lyon', cargo: null, status: 'DRAFT', customer: { id: 'cus_2', name: 'Petit SARL' } }
  ],
  drivers: [
    { id: 'usr_d1', name: 'Dana Driver', phone: '+31612345678' },
    { id: 'usr_d2', name: 'Sam Second', phone: null }
  ],
  trucks: [
    { id: 'trk_1', plate: 'AB-123-CD', dimensions: '13.6m', euroClass: 'Euro 6' }
  ],
  customers: [
    { id: 'cus_1', name: 'Acme BV' },
    { id: 'cus_2', name: 'Petit SARL' }
  ]
};

// --- option lists -----------------------------------------------------------

test('referenceState tolerates a missing or partial payload', () => {
  const empty = dispatch.referenceState(null);
  assert.deepEqual(empty, { orders: [], drivers: [], trucks: [], customers: [] });
  const partial = dispatch.referenceState({ orders: [{ id: 'a' }], drivers: 'nope' });
  assert.equal(partial.orders.length, 1);
  assert.deepEqual(partial.drivers, []);
  assert.deepEqual(partial.trucks, []);
  assert.deepEqual(partial.customers, []);
});

test('option entries label a human choice and never expose a raw id as the label', () => {
  const orders = dispatch.optionEntries(REFERENCE.orders, 'order');
  assert.deepEqual(orders[0], { value: 'ord_1', label: 'Rotterdam → Berlin · Acme BV' });
  assert.equal(orders[1].label, 'Ghent → Lyon · Petit SARL');

  const drivers = dispatch.optionEntries(REFERENCE.drivers, 'driver');
  assert.deepEqual(drivers[0], { value: 'usr_d1', label: 'Dana Driver · +31612345678' });
  assert.equal(drivers[1].label, 'Sam Second', 'a missing phone must not add a separator');

  const trucks = dispatch.optionEntries(REFERENCE.trucks, 'truck');
  assert.deepEqual(trucks[0], { value: 'trk_1', label: 'AB-123-CD · 13.6m' });

  for (const entry of orders.concat(drivers, trucks)) {
    assert.notEqual(entry.label, entry.value, 'the label must be human, not the id');
    assert.match(entry.label, /\S/);
  }
});

test('a malformed item never throws and never prints undefined', () => {
  assert.equal(dispatch.orderLabel(null), '');
  assert.equal(dispatch.driverLabel(undefined), '');
  assert.equal(dispatch.truckLabel({ plate: 'X' }), 'X');
  assert.equal(dispatch.orderLabel({ origin: 'A' }), 'A → ');
  assert.deepEqual(dispatch.optionEntries(null, 'order'), []);
});

// --- validation -------------------------------------------------------------

test('an empty form is refused with the order message', () => {
  const check = dispatch.validateDispatchForm({}, REFERENCE);
  assert.equal(check.ok, false);
  assert.equal(check.errors.orderId, 'dispatch.error.orderRequired');
  assert.deepEqual(Object.keys(check.errors), ['orderId'], 'only the order is missing');
});

test('an id that is not in the loaded lists is refused, per field', () => {
  assert.equal(
    dispatch.validateDispatchForm({ orderId: 'nope' }, REFERENCE).errors.orderId,
    'dispatch.error.orderUnknown'
  );
  assert.equal(
    dispatch.validateDispatchForm({ orderId: 'ord_1', driverId: 'usr_x' }, REFERENCE).errors.driverId,
    'dispatch.error.driverUnknown'
  );
  assert.equal(
    dispatch.validateDispatchForm({ orderId: 'ord_1', truckId: 'trk_x' }, REFERENCE).errors.truckId,
    'dispatch.error.truckUnknown'
  );
});

test('the rate must be a non-negative number or empty', () => {
  for (const bad of ['-1', 'abc', '1e999', 'NaN']) {
    const check = dispatch.validateDispatchForm({ orderId: 'ord_1', rateEur: bad }, REFERENCE);
    assert.equal(check.ok, false, `${bad} must be refused`);
    assert.equal(check.errors.rateEur, 'dispatch.error.rate');
  }
  assert.equal(dispatch.validateDispatchForm({ orderId: 'ord_1', rateEur: '' }, REFERENCE).ok, true);
  assert.equal(dispatch.validateDispatchForm({ orderId: 'ord_1', rateEur: '0' }, REFERENCE).rateEur, 0);
  assert.equal(dispatch.validateDispatchForm({ orderId: 'ord_1', rateEur: '1250.50' }, REFERENCE).rateEur, 1250.5);
});

test('a customer that does not belong to the order is an invalid combination', () => {
  const check = dispatch.validateDispatchForm(
    { orderId: 'ord_1', customerId: 'cus_2' },
    REFERENCE
  );
  assert.equal(check.ok, false);
  assert.equal(check.errors.customerId, 'dispatch.error.customerMismatch');
  // The matching customer (or none at all) is fine.
  assert.equal(dispatch.validateDispatchForm({ orderId: 'ord_1', customerId: 'cus_1' }, REFERENCE).ok, true);
  assert.equal(dispatch.validateDispatchForm({ orderId: 'ord_1' }, REFERENCE).ok, true);
});

test('a valid form yields exactly the POST /api/trips body', () => {
  const check = dispatch.validateDispatchForm(
    { orderId: 'ord_1', customerId: 'cus_1', driverId: 'usr_d1', truckId: 'trk_1', rateEur: '1450' },
    REFERENCE
  );
  assert.equal(check.ok, true);
  assert.deepEqual(check.payload, {
    orderId: 'ord_1',
    driverId: 'usr_d1',
    truckId: 'trk_1',
    rateEur: 1450
  });
  assert.deepEqual(Object.keys(check.payload).sort(), ['driverId', 'orderId', 'rateEur', 'truckId']);
  assert.equal(check.order.id, 'ord_1', 'the chosen order is returned for the summary');

  // Optional driver/truck are null, not '' — the API contract.
  const minimal = dispatch.validateDispatchForm({ orderId: 'ord_2' }, REFERENCE);
  assert.equal(minimal.ok, true);
  assert.deepEqual(minimal.payload, { orderId: 'ord_2', driverId: null, truckId: null, rateEur: null });
});

test('buildCreateTripPayload never forwards an out-of-range rate', () => {
  assert.deepEqual(
    dispatch.buildCreateTripPayload({ orderId: ' x ', driverId: '', truckId: '', rateEur: '-3' }),
    { orderId: 'x', driverId: null, truckId: null, rateEur: null }
  );
  assert.equal(dispatch.buildCreateTripPayload({ orderId: 'a', rateEur: 0 }).rateEur, 0);
});

// --- planned delivery time (board task #66) ---------------------------------

test('an empty planned time is omitted from the payload, not sent as null', () => {
  const base = dispatch.buildCreateTripPayload({ orderId: 'a' });
  assert.deepEqual(Object.keys(base).sort(), ['driverId', 'orderId', 'rateEur', 'truckId']);
  assert.ok(!('plannedAt' in base), 'absent when blank — the original F4 contract is unchanged');
});

test('a chosen planned time is sent as an ISO-8601 instant', () => {
  const payload = dispatch.buildCreateTripPayload({ orderId: 'a', plannedAt: '2026-09-25T08:00' });
  assert.equal(payload.plannedAt, new Date('2026-09-25T08:00').toISOString());
  assert.deepEqual(Object.keys(payload).sort(), ['driverId', 'orderId', 'plannedAt', 'rateEur', 'truckId']);
  // A datetime-local value with seconds is preserved to the second.
  assert.equal(
    dispatch.buildCreateTripPayload({ orderId: 'a', plannedAt: '2026-09-25T08:30:15' }).plannedAt,
    new Date('2026-09-25T08:30:15').toISOString()
  );
});

test('a malformed planned time is refused before the request is sent', () => {
  const bad = dispatch.validateDispatchForm({ orderId: 'ord_1', plannedAt: 'tomorrow-ish' }, REFERENCE);
  assert.equal(bad.ok, false);
  assert.equal(bad.errors.plannedAt, 'dispatch.error.plannedAt');
  const good = dispatch.validateDispatchForm(
    { orderId: 'ord_1', plannedAt: '2026-09-25T08:00' },
    REFERENCE
  );
  assert.equal(good.ok, true);
  assert.equal(good.payload.plannedAt, new Date('2026-09-25T08:00').toISOString());
  // Blank is fine: the time is optional.
  assert.equal(dispatch.validateDispatchForm({ orderId: 'ord_1', plannedAt: '' }, REFERENCE).ok, true);
});

// --- error mapping ----------------------------------------------------------

test('every POST failure maps to a readable catalogue key, never a raw status', () => {
  const cases = [
    [{ status: 400, data: { error: 'invalid_input', detail: 'rateEur must be a non-negative number' } }, 'dispatch.error.invalidInput'],
    [{ status: 404, data: { error: 'order_not_found' } }, 'dispatch.error.orderNotFound'],
    [{ status: 404, data: { error: 'driver_not_found' } }, 'dispatch.error.driverNotFound'],
    [{ status: 404, data: { error: 'truck_not_found' } }, 'dispatch.error.truckNotFound'],
    [{ status: 403, data: { error: 'forbidden' } }, 'error.forbidden'],
    [{ status: 403, data: { error: 'no_org' } }, 'error.noOrg'],
    [{ status: 401, data: null }, 'error.sessionExpired'],
    [{ status: 429, data: null }, 'error.rateLimited'],
    [{ status: 0, data: { error: 'network' } }, 'error.network'],
    [{ status: 500, data: null }, 'error.unexpected']
  ];
  for (const [res, key] of cases) {
    assert.equal(dispatch.createTripErrorKey(res), key, JSON.stringify(res));
  }
  assert.equal(dispatch.errorDetail({ data: { detail: 'orders are closed' } }), 'orders are closed');
  assert.equal(dispatch.errorDetail({}), '');
});

// --- wiring -----------------------------------------------------------------

test('the shell loads the dispatch module before app.js', () => {
  assert.match(PAGE, /<script src="\/app\/lib\/dispatch\.js"><\/script>/);
  const core = PAGE.indexOf('/app/lib/app-core.js');
  const dispatchTag = PAGE.indexOf('/app/lib/dispatch.js');
  const app = PAGE.indexOf('/app/app.js');
  assert.ok(core !== -1 && dispatchTag !== -1 && app !== -1);
  assert.ok(core < dispatchTag && dispatchTag < app, 'dispatch.js must load between the core and app.js');
  assert.match(APP_JS, /RoadwiseDispatch/);
  assert.match(APP_JS, /DISPATCH\.validateDispatchForm/);
});

test('the dispatch route is owners/dispatchers only, and a driver is redirected away', () => {
  const route = appCore.ROUTES.filter((r) => r.id === 'dispatch')[0];
  assert.ok(route, 'the dispatch route exists');
  assert.equal(route.view, 'dispatch');
  assert.deepEqual(route.roles, ['owner', 'dispatcher']);
  assert.equal(route.task, null, 'the panel is implemented, not pending');
  assert.equal(appCore.canOpen('driver', '/app/dispatch'), false);
  assert.equal(appCore.canOpen('owner', '/app/dispatch'), true);
  const decision = appCore.guardDecision({ path: '/app/dispatch', hasToken: true, role: 'driver' });
  assert.equal(decision.action, 'redirect');
  assert.equal(decision.to, '/app/my-trips');
});

test('the dynamic form elements are resolved with querySelector, not the shell el() helper', () => {
  // The shell test asserts every id passed to el/setText/setHidden/show/hide
  // exists in index.html; the dispatch form is injected, so it must not use them.
  assert.doesNotMatch(APP_JS, /\b(?:el|setText|setHidden|show|hide)\(\s*'dispatch/);
  assert.match(APP_JS, /outlet\.querySelector/);
});

test('every dispatch catalogue key used by the module and app.js exists in en.json', () => {
  const sources = readApp('lib/dispatch.js') + '\n' + APP_JS;
  const keys = new Set();
  for (const m of sources.matchAll(/'((?:dispatch|error)\.[a-zA-Z0-9_.]+)'/g)) keys.add(m[1]);
  assert.ok(keys.size >= 20, `expected many dispatch/error keys, saw ${keys.size}`);
  const missing = [...keys].filter((key) => !(key in CATALOGUE));
  assert.deepEqual(missing, [], `missing catalogue keys: ${missing.join(', ')}`);
  // The success message interpolates the new trip id.
  assert.match(CATALOGUE['dispatch.created'], /\{id\}/);
});
