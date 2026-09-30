import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DRIVER_ROLE_ID,
  REFERENCE_PERMISSION,
  listCustomers,
  listDrivers,
  listOrders,
  listTrucks,
  loadReferenceData,
} from './reference-data.js';
import { hasPermission } from './auth/permissions.js';

/**
 * Minimal in-memory fake of the Prisma surface `reference-data.js` uses.
 * It honours the `where` clauses the loaders rely on — org scoping, the
 * `customer: { orgId }` relation filter, `roleId`, and the lock `OR` — so the
 * tests exercise real filtering, not just call shape.
 */
function makeFakePrisma() {
  const state = {
    customers: [
      { id: 'c1', orgId: 'org1', name: 'Acme Freight' },
      { id: 'c2', orgId: 'org2', name: 'Other Freight' },
    ],
    orders: [
      { id: 'o1', customerId: 'c1', origin: 'Berlin', destination: 'Hamburg', cargo: 'Pallets', status: 'BOOKED' },
      { id: 'o2', customerId: 'c1', origin: 'Munich', destination: 'Vienna', cargo: 'Chilled', status: 'DRAFT' },
      { id: 'o3', customerId: 'c2', origin: 'Paris', destination: 'Lyon', cargo: 'Bulk', status: 'BOOKED' },
    ],
    users: [
      { id: 'd1', orgId: 'org1', roleId: 'driver', name: 'Driver One', phone: '+49001' },
      { id: 'd2', orgId: 'org1', roleId: 'driver', name: 'Driver Two', phone: null },
      { id: 'd3', orgId: 'org1', roleId: 'driver', name: 'Locked Driver', phone: '+49003', lockedUntil: new Date('2999-01-01') },
      { id: 'd4', orgId: 'org1', roleId: 'driver', name: 'Unlocked Driver', phone: '+49004', lockedUntil: new Date('2000-01-01') },
      { id: 'a1', orgId: 'org1', roleId: 'owner', name: 'Owner', phone: null },
      { id: 'x1', orgId: 'org2', roleId: 'driver', name: 'Foreign Driver', phone: '+33001' },
    ],
    trucks: [
      { id: 't1', orgId: 'org1', plate: 'RW-002', dimensions: '13.6m', euroClass: 'Euro 6' },
      { id: 't2', orgId: 'org1', plate: 'RW-001', dimensions: null, euroClass: 'Euro 5' },
      { id: 't3', orgId: 'org2', plate: 'ZZ-999', dimensions: null, euroClass: null },
    ],
  };

  const matchValue = (row, key, expected) => {
    if (expected === null) return row[key] === null || row[key] === undefined;
    if (expected && typeof expected === 'object' && 'lte' in expected) {
      return row[key] !== null && row[key] !== undefined && row[key] <= expected.lte;
    }
    return row[key] === expected;
  };

  const match = (row, where) => {
    for (const [k, v] of Object.entries(where ?? {})) {
      if (k === 'customer') {
        const customer = state.customers.find((c) => c.id === row.customerId);
        if (!customer || customer.orgId !== v.orgId) return false;
        continue;
      }
      if (k === 'OR') {
        if (!v.some((branch) => Object.entries(branch).every(([bk, bv]) => matchValue(row, bk, bv)))) {
          return false;
        }
        continue;
      }
      if (!matchValue(row, k, v)) return false;
    }
    return true;
  };

  const table = (rows, decorate) => ({
    findMany: async ({ where, select } = {}) =>
      rows
        .filter((row) => match(row, where))
        .map((row) => project(decorate ? decorate(row) : row, select)),
  });

  // Prisma resolves the relation and returns only the selected fields; the fake
  // does the same so a test failure means a real query/response mismatch.
  const project = (row, select) => {
    if (!select) return row;
    const out = {};
    for (const [k, v] of Object.entries(select)) {
      if (!v) continue;
      if (v === true) {
        out[k] = row[k];
      } else if (typeof v === 'object' && v.select) {
        out[k] = row[k] ? project(row[k], v.select) : null;
      }
    }
    return out;
  };

  const withCustomer = (order) => ({
    ...order,
    customer: state.customers.find((c) => c.id === order.customerId) ?? null,
  });

  return {
    state,
    order: table(state.orders, withCustomer),
    user: table(state.users),
    truck: table(state.trucks),
    customer: table(state.customers),
  };
}

test('listOrders returns only the org orders and folds in the customer', async () => {
  const prisma = makeFakePrisma();
  const orders = await listOrders(prisma, { orgId: 'org1' });
  assert.deepEqual(
    orders.map((o) => o.id).sort(),
    ['o1', 'o2'],
  );
  assert.equal(orders.find((o) => o.id === 'o1').customer.name, 'Acme Freight');
  assert.deepEqual(await listOrders(prisma, { orgId: 'org2' }).then((r) => r.map((o) => o.id)), ['o3']);
  assert.deepEqual(await listOrders(prisma, { orgId: 'ghost' }), []);
});

test('listDrivers returns active org drivers only', async () => {
  const prisma = makeFakePrisma();
  const drivers = await listDrivers(prisma, { orgId: 'org1' });
  const ids = drivers.map((d) => d.id).sort();
  assert.deepEqual(ids, ['d1', 'd2', 'd4'], 'drivers of the org, excluding the locked one');
  assert.ok(!ids.includes('d3'), 'a currently locked driver is not offered');
  assert.ok(!ids.includes('a1'), 'a non-driver role is not offered');
  assert.ok(!ids.includes('x1'), 'another org is never visible');
  assert.equal(drivers.find((d) => d.id === 'd2').phone, null);
});

test('listTrucks and listCustomers are org-scoped', async () => {
  const prisma = makeFakePrisma();
  const trucks = await listTrucks(prisma, { orgId: 'org1' });
  assert.deepEqual(trucks.map((t) => t.id).sort(), ['t1', 't2']);
  assert.equal(trucks.find((t) => t.id === 't1').plate, 'RW-002');

  const customers = await listCustomers(prisma, { orgId: 'org1' });
  assert.deepEqual(customers.map((c) => c.id), ['c1']);
  assert.deepEqual(customers[0], { id: 'c1', name: 'Acme Freight' });
});

test('loadReferenceData returns every option list in one call', async () => {
  const prisma = makeFakePrisma();
  const ref = await loadReferenceData(prisma, { orgId: 'org1' });
  assert.deepEqual(Object.keys(ref).sort(), ['customers', 'drivers', 'orders', 'trucks']);
  assert.equal(ref.orders.length, 2);
  assert.equal(ref.drivers.length, 3);
  assert.equal(ref.trucks.length, 2);
  assert.equal(ref.customers.length, 1);

  const empty = await loadReferenceData(prisma, { orgId: 'ghost' });
  assert.deepEqual(empty, { orders: [], drivers: [], trucks: [], customers: [] });
});

test('the reference permission is trip:create, which a driver does not hold', () => {
  assert.equal(REFERENCE_PERMISSION, 'trip:create');
  const driver = ['trip:read', 'trip:status', 'pod:upload', 'expense:create'];
  const dispatcher = ['trip:*', 'user:read', 'reports:read'];
  assert.equal(hasPermission(driver, REFERENCE_PERMISSION), false, 'drivers get 403');
  assert.equal(hasPermission(dispatcher, REFERENCE_PERMISSION), true);
  assert.equal(hasPermission(['*'], REFERENCE_PERMISSION), true);
});

test('the driver role id matches the seeded role', () => {
  assert.equal(DRIVER_ROLE_ID, 'driver');
});
