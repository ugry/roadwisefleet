/**
 * Fleet self-serve customer lane (board task #120, UXF-O3 lane 1) —
 * dependency-free unit suite for the pure writes in `fleet-customers.js`.
 *
 * Runs on the Node 20 native runner with NO install (`node --test
 * apps/api/src/`), so CI covers the domain rules on a bare checkout. The HTTP +
 * database proof (tenant isolation included) lives in
 * `apps/api/test/fleet-customer-lane.test.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as fleet from './fleet-customers.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

/* --------------------------------------------------------- quick add --- */

test('normalizeFleetCustomer trims, lower-cases the email and defaults the language', () => {
  const res = fleet.normalizeFleetCustomer({ name: '  Bäcker Schmidt ', email: ' ORDERS@Baecker.DE ', phone: '+49 30 1234' });
  assert.equal(res.ok, true);
  assert.equal(res.value.name, 'Bäcker Schmidt');
  assert.equal(res.value.email, 'orders@baecker.de');
  assert.equal(res.value.whatsappId, '+49 30 1234');
  assert.equal(res.value.lang, 'en');
});

test('normalizeFleetCustomer is fail-fast on name, then email, then language', () => {
  assert.equal(fleet.normalizeFleetCustomer({}).field, 'name');
  assert.equal(fleet.normalizeFleetCustomer({ name: '   ' }).field, 'name');
  assert.equal(fleet.normalizeFleetCustomer({ name: 'A', email: 'nope' }).field, 'email');
  assert.equal(fleet.normalizeFleetCustomer({ name: 'A', lang: 'xx' }).field, 'lang');
  assert.equal(fleet.normalizeFleetCustomer(null).ok, false, 'a non-object body is refused, not thrown on');
  // An empty email is "no email", not an invalid one.
  assert.equal(fleet.normalizeFleetCustomer({ name: 'A', email: '' }).value.email, null);
});

test('customerRow exposes only the surface fields', () => {
  const row = fleet.customerRow({
    id: 'c1',
    name: 'ACME',
    email: 'a@b.de',
    whatsappId: null,
    lang: 'pl',
    createdAt: new Date('2026-10-01T08:00:00.000Z'),
    _count: { orders: 3 },
    secretInternalField: 'never exposed',
  });
  assert.deepEqual(Object.keys(row).sort(), ['createdAt', 'email', 'id', 'lang', 'name', 'orderCount', 'portalAccounts', 'whatsappId']);
  assert.equal(row.orderCount, 3);
  assert.equal(row.portalAccounts, null, 'no account count in this fixture reads as unknown, never as 0');
  assert.equal(row.createdAt, '2026-10-01T08:00:00.000Z');
  assert.equal(fleet.customerRow(null), null);
});

test('customerRow reports linked logins so the screen knows when to offer an invite', () => {
  const none = fleet.customerRow({ id: 'c1', name: 'ACME', _count: { orders: 0, accounts: 0 } });
  assert.equal(none.portalAccounts, 0);
  assert.equal(fleet.customerRow({ id: 'c2', name: 'ACME', _count: { orders: 1, accounts: 2 } }).portalAccounts, 2);
});

/* ------------------------------------------------------------ orders --- */

test('normalizeFleetOrder validates the lane, the windows and the equipment', () => {
  assert.equal(fleet.normalizeFleetOrder({}, { customerId: 'c1' }).field, 'origin');
  assert.equal(fleet.normalizeFleetOrder({ origin: 'A' }, { customerId: 'c1' }).field, 'destination');
  assert.equal(fleet.normalizeFleetOrder({ origin: 'A', destination: 'A' }, { customerId: 'c1' }).field, 'destination');
  assert.equal(
    fleet.normalizeFleetOrder({ origin: 'A', destination: 'B', plannedAt: 'not-a-date' }, { customerId: 'c1' }).field,
    'plannedAt',
  );
  assert.equal(
    fleet.normalizeFleetOrder(
      { origin: 'A', destination: 'B', loadReadyAt: '2026-10-02T08:00:00Z', deliverByAt: '2026-10-01T08:00:00Z' },
      { customerId: 'c1' },
    ).field,
    'deliverByAt',
  );
  assert.equal(fleet.normalizeFleetOrder({ origin: 'A', destination: 'B', equipment: 'hovercraft' }, { customerId: 'c1' }).field, 'equipment');
});

test('buildFleetOrderRows marks the work as fleet staff, BOOKED, with a booking row', () => {
  const value = fleet.normalizeFleetOrder(
    { origin: ' Berlin ', destination: 'Hamburg', cargo: 'Pallets', equipment: 'curtainsider', plannedAt: '2026-10-02T08:00:00Z' },
    { customerId: 'c1' },
  ).value;
  const rows = fleet.buildFleetOrderRows(value);
  assert.equal(rows.order.customerId, 'c1');
  assert.equal(rows.order.origin, 'Berlin');
  assert.equal(rows.order.status, 'BOOKED');
  assert.equal(rows.booking.supplyChoice, 'fleet');
  assert.equal(rows.booking.equipment, 'curtainsider');
  assert.deepEqual(rows.booking.details, { createdVia: 'fleet-app', manual: true });
});

test('repeatOrderBody copies the source order and honours explicit overrides', () => {
  const source = {
    customerId: 'c1',
    origin: 'Berlin',
    destination: 'Wien',
    cargo: 'Steel',
    booking: { equipment: 'flatbed' },
  };
  const copied = fleet.repeatOrderBody(source, { plannedAt: '2026-10-05T08:00:00Z' });
  assert.equal(copied.customerId, 'c1');
  assert.equal(copied.origin, 'Berlin');
  assert.equal(copied.destination, 'Wien');
  assert.equal(copied.cargo, 'Steel');
  assert.equal(copied.equipment, 'flatbed');
  assert.equal(copied.plannedAt, '2026-10-05T08:00:00Z');

  const overridden = fleet.repeatOrderBody(source, { destination: 'Graz', equipment: 'reefer' });
  assert.equal(overridden.destination, 'Graz');
  assert.equal(overridden.equipment, 'reefer');
  assert.equal(overridden.customerId, 'c1', 'a repeat can never change the customer');
});

test('orderRow shapes the created order for the app', () => {
  const row = fleet.orderRow({
    id: 'o1',
    customerId: 'c1',
    customer: { id: 'c1', name: 'ACME' },
    origin: 'Berlin',
    destination: 'Wien',
    cargo: null,
    status: 'BOOKED',
    plannedAt: new Date('2026-10-02T08:00:00.000Z'),
    booking: { equipment: 'flatbed', loadReadyAt: null, deliverByAt: null, notes: 'Call ahead' },
  });
  assert.equal(row.id, 'o1');
  assert.equal(row.customer.name, 'ACME');
  assert.equal(row.cargo, null);
  assert.equal(row.plannedAt, '2026-10-02T08:00:00.000Z');
  assert.equal(row.booking.notes, 'Call ahead');
  assert.equal(fleet.orderRow(null), null);
});

/* -------------------------------------------------- source guards --- */

test('the lane is registered, org-scoped and gated by the dispatch capability', () => {
  const route = readFileSync(resolve(repoRoot, 'apps/api/src/routes/fleet-customers.ts'), 'utf8');
  assert.match(route, /app\.post\('\/fleet\/customers'/);
  assert.match(route, /app\.post\('\/orders'/);
  assert.match(route, /FLEET_CUSTOMER_PERMISSION/, 'one permission constant, no drift');
  assert.match(route, /where: \{ id: customerId, orgId \}/, 'the customer is looked up inside the caller org');
  assert.match(route, /where: \{ id: repeatOf, customer: \{ orgId \} \}/, 'a repeated order is scoped too');
  const app = readFileSync(resolve(repoRoot, 'apps/api/src/app.ts'), 'utf8');
  assert.match(app, /fleetCustomerRoutes/, 'the routes are registered');
  // The old 404s are the defect: no route may be missing again.
  assert.doesNotMatch(route, /orgId: body/, 'tenancy never comes from the body');
});
