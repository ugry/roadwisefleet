/**
 * Fleet self-serve customer lane (board task #120, UXF-O3 lane 1) —
 * dependency-free coverage for the pure half of the `/app/customers` screen.
 *
 * Runs under the no-install CI job (`node --test apps/api/src/`): `node:*`
 * builtins only, no Fastify, no Prisma, no browser. The HTTP + database proof
 * (tenant isolation included) lives in
 * `apps/api/test/fleet-customer-lane.test.ts`; here we prove the decisions:
 *
 *   - the quick-add and order forms refuse an obviously invalid submit BEFORE
 *     a request leaves, one field at a time;
 *   - the request bodies are exactly the server contracts;
 *   - every API error maps to a catalogue key that exists in en.json;
 *   - the screen is a real implemented view for owner/dispatcher only;
 *   - a driver can never reach `/app/customers`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import customers from '../../../app/lib/customers.js';
import appCore from '../../../app/lib/app-core.js';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '../../../app');
const readApp = (name) => readFileSync(join(appDir, name), 'utf8');

const APP_JS = readApp('app.js');
const PAGE = readApp('index.html');
const CATALOGUE = JSON.parse(readApp('locales/en.json'));

// --- quick-add --------------------------------------------------------------

test('validateCustomerForm requires a name and normalises the email', () => {
  assert.deepEqual(customers.validateCustomerForm({}), { ok: false, field: 'name', key: 'customers.error.nameRequired' });
  assert.deepEqual(customers.validateCustomerForm({ name: '   ' }), { ok: false, field: 'name', key: 'customers.error.nameRequired' });
  assert.deepEqual(
    customers.validateCustomerForm({ name: 'ACME', email: 'nope' }),
    { ok: false, field: 'email', key: 'customers.error.emailInvalid' },
  );

  const ok = customers.validateCustomerForm({ name: ' Bäcker Schmidt ', email: 'orders@baecker.de', lang: 'de' });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.body, { name: 'Bäcker Schmidt', email: 'orders@baecker.de', whatsappId: '', lang: 'de' });
  // An empty phone is "no phone", and the language defaults to English.
  assert.equal(customers.validateCustomerForm({ name: 'ACME' }).body.lang, 'en');
});

// --- manual order -----------------------------------------------------------

test('validateOrderForm is fail-fast on customer, origin, destination and route', () => {
  assert.deepEqual(customers.validateOrderForm({}), { ok: false, field: 'customerId', key: 'customers.error.customerRequired' });
  assert.deepEqual(
    customers.validateOrderForm({ customerId: 'c1' }),
    { ok: false, field: 'origin', key: 'customers.error.originRequired' },
  );
  assert.deepEqual(
    customers.validateOrderForm({ customerId: 'c1', origin: 'Berlin' }),
    { ok: false, field: 'destination', key: 'customers.error.destinationRequired' },
  );
  assert.deepEqual(
    customers.validateOrderForm({ customerId: 'c1', origin: 'Berlin', destination: 'Berlin' }),
    { ok: false, field: 'destination', key: 'customers.error.sameRoute' },
  );
});

test('validateOrderForm builds exactly the POST /api/orders contract', () => {
  const res = customers.validateOrderForm({
    customerId: ' c1 ',
    origin: ' Berlin ',
    destination: 'Wien',
    cargo: 'Pallets',
    plannedAt: '2026-10-20T08:00',
    equipment: 'curtainsider',
    notes: 'Call ahead',
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.body, {
    customerId: 'c1',
    origin: 'Berlin',
    destination: 'Wien',
    cargo: 'Pallets',
    plannedAt: '2026-10-20T08:00',
    equipment: 'curtainsider',
    notes: 'Call ahead',
  });
  // The client never sends an org: tenancy is the token's.
  assert.equal('orgId' in res.body, false);
});

// --- display helpers --------------------------------------------------------

test('customerLabel and orderSummary never render a raw id', () => {
  assert.equal(customers.customerLabel({ id: 'cus_1', name: 'Acme BV' }), 'Acme BV');
  assert.equal(
    customers.customerLabel({ id: 'cus_1', name: 'Acme BV', email: 'ops@acme.test' }),
    'Acme BV — ops@acme.test',
  );
  assert.equal(customers.customerLabel(null), '');
  assert.equal(customers.orderSummary({ origin: 'Berlin', destination: 'Wien' }), 'Berlin → Wien');
  assert.equal(customers.orderSummary(null), '');
});

// --- error mapping ----------------------------------------------------------

test('every API failure maps to a readable catalogue key, never a raw status', () => {
  const cases = [
    [{ error: 'invalid_input', messageKey: 'customers.error.nameRequired' }, 'customers.error.nameRequired'],
    [{ error: 'customer_not_found' }, 'customers.error.customerNotFound'],
    [{ error: 'order_not_found' }, 'customers.error.orderNotFound'],
    [{ error: 'forbidden' }, 'error.forbidden'],
    [{ error: 'no_org' }, 'error.noOrg'],
    [{ error: 'network' }, 'customers.error.requestFailed'],
    [null, 'customers.error.requestFailed'],
  ];
  for (const [data, key] of cases) {
    assert.equal(customers.errorKey(data), key, JSON.stringify(data));
  }
});

// --- wiring -----------------------------------------------------------------

test('the shell loads the customers module before app.js', () => {
  assert.match(PAGE, /<script src="\/app\/lib\/customers\.js"><\/script>/);
  const core = PAGE.indexOf('/app/lib/app-core.js');
  const moduleTag = PAGE.indexOf('/app/lib/customers.js');
  const app = PAGE.indexOf('/app/app.js');
  assert.ok(core !== -1 && moduleTag !== -1 && app !== -1);
  assert.ok(core < moduleTag && moduleTag < app, 'customers.js must load between the core and app.js');
  assert.match(APP_JS, /RoadwiseCustomers/);
  assert.match(APP_JS, /CUST\.validateCustomerForm/);
  assert.match(APP_JS, /CUST\.validateOrderForm/);
});

test('the customers route is an implemented view for owners/dispatchers only', () => {
  const route = appCore.ROUTES.filter((r) => r.id === 'customers')[0];
  assert.ok(route, 'the customers route exists');
  assert.equal(route.view, 'customers');
  assert.equal(route.task, null, 'the panel is implemented, not pending');
  assert.deepEqual(route.roles, ['owner', 'dispatcher']);
  assert.equal(appCore.canOpen('driver', '/app/customers'), false);
  assert.equal(appCore.canOpen('owner', '/app/customers'), true);
  assert.equal(appCore.canOpen('dispatcher', '/app/customers'), true);
  const decision = appCore.guardDecision({ path: '/app/customers', hasToken: true, role: 'driver' });
  assert.equal(decision.action, 'redirect');
  assert.equal(decision.to, '/app/my-trips');
});

test('the injected screen resolves its dynamic elements with querySelector, never the shell el()', () => {
  // app-shell.test.js boots every id passed to el/setText/...; this form is
  // injected at render time, so it must not use the static-shell helper.
  assert.doesNotMatch(APP_JS, /\b(?:el|setText|setHidden|show|hide)\(\s*'customer/);
  assert.doesNotMatch(APP_JS, /\b(?:el|setText|setHidden|show|hide)\(\s*'order/);
  assert.match(APP_JS, /outlet\.querySelector/);
});

test('every customers catalogue key used by the module and app.js exists in en.json', () => {
  const sources = readApp('lib/customers.js') + '\n' + APP_JS;
  const keys = new Set();
  for (const m of sources.matchAll(/'((?:customers|error)\.[a-zA-Z0-9_.]+)'/g)) keys.add(m[1]);
  assert.ok(keys.size >= 20, `expected many customers/error keys, saw ${keys.size}`);
  const missing = [...keys].filter((key) => !(key in CATALOGUE));
  assert.deepEqual(missing, [], `missing catalogue keys: ${missing.join(', ')}`);
  // The success messages interpolate the new name / order id.
  assert.match(CATALOGUE['customers.created'], /\{name\}/);
  assert.match(CATALOGUE['customers.orderCreated'], /\{id\}/);
});

test('the server module and the browser module agree on every error message key', () => {
  const server = readFileSync(resolve(here, 'fleet-customers.js'), 'utf8');
  const client = readApp('lib/customers.js');
  const serverKeys = new Set([...server.matchAll(/'(customers\.error\.[a-zA-Z]+)'/g)].map((m) => m[1]));
  const clientKeys = new Set([...client.matchAll(/'(customers\.error\.[a-zA-Z]+)'/g)].map((m) => m[1]));
  assert.ok(serverKeys.size >= 10, `expected server error keys, saw ${serverKeys.size}`);
  const missing = [...serverKeys].filter((key) => !clientKeys.has(key) && !(key in CATALOGUE));
  assert.deepEqual(missing, [], `server keys without a client/catalogue home: ${missing.join(', ')}`);
});
