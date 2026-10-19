/**
 * Fleet self-serve customer lane (board task #120, UXF-O3 lane 1) — HTTP +
 * database end-to-end checks through the real `buildServer()` and `app.inject()`.
 *
 *   pnpm --filter @roadwisefleet/api test:router
 *
 * What this proves (the task's acceptance):
 *   - `POST /api/fleet/customers` and `POST /api/orders` exist (they were 404s)
 *     and answer 201 with the surface shapes;
 *   - validation is a 4xx, never a 500, and a refused write creates no row;
 *   - auth is required, and a role without `trip:create` is 403;
 *   - TENANT ISOLATION: fleet A cannot read, post against, or repeat fleet B's
 *     customers/orders — every foreign id is a flat 404;
 *   - a repeat creates a NEW order with the source lane/customer, never re-uses
 *     the old one.
 *
 * The fixture lives in dedicated orgs and is removed in `after`, dependent rows
 * first: `tsx --test` runs test files concurrently and other suites re-derive
 * counts from the pilot org. The suite is DB-gated (diagnostic + skip on a bare
 * checkout); the dependency-free rules run in `src/fleet-customers.test.js`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.ALLOW_INSECURE_AUTH_SECRET = '1';

const { buildServer } = await import('../src/app.js');
const { prisma } = await import('../src/db.js');
const { env } = await import('../src/env.js');
const { hashPassword } = await import('../src/auth/password.js');
const { signToken } = await import('../src/auth/tokens.js');
const { FLEET_CUSTOMER_PERMISSION } = await import('../src/fleet-customers.js');

const ORG_A = 'qa-fc-org-a';
const ORG_B = 'qa-fc-org-b';
const OWNER_A = 'qa-fc-owner-a';
const OWNER_B = 'qa-fc-owner-b';
const DRIVER_A = 'qa-fc-driver-a';
const admin = hashPassword('qa-fc-password');

const app = buildServer();
await app.ready();
test.after(() => app.close());

async function probeDb(): Promise<boolean> {
  try {
    await prisma.$queryRawUnsafe('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

async function ready(): Promise<boolean> {
  if (!(await probeDb())) return false;
  try {
    await prisma.customer.findFirst({ where: { orgId: ORG_A }, select: { id: true } });
    await prisma.order.findFirst({ where: { customer: { orgId: ORG_A } }, select: { id: true } });
    return true;
  } catch {
    return false;
  }
}

const tokenFor = (sub: string, org: string, role: string, name: string) =>
  signToken({ sub, org, role, name }, env.AUTH_SECRET, { ttlSeconds: 3600 });
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function cleanup(): Promise<void> {
  const orgs = [ORG_A, ORG_B];
  const customers = await prisma.customer.findMany({ where: { orgId: { in: orgs } }, select: { id: true } });
  const customerIds = customers.map((c) => c.id);
  const orders = await prisma.order.findMany({ where: { customerId: { in: customerIds } }, select: { id: true } });
  await prisma.orderBooking.deleteMany({ where: { orderId: { in: orders.map((o) => o.id) } } });
  await prisma.order.deleteMany({ where: { id: { in: orders.map((o) => o.id) } } });
  await prisma.customerAccount.deleteMany({ where: { customerId: { in: customerIds } } });
  await prisma.customerProfile.deleteMany({ where: { customerId: { in: customerIds } } });
  await prisma.customerAddress.deleteMany({ where: { customerId: { in: customerIds } } });
  await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
  await prisma.auditLog.deleteMany({ where: { orgId: { in: orgs } } });
  await prisma.user.deleteMany({ where: { id: { in: [OWNER_A, OWNER_B, DRIVER_A] } } });
  await prisma.org.deleteMany({ where: { id: { in: orgs } } });
}

async function seedFixture(): Promise<void> {
  await cleanup();
  await prisma.role.upsert({
    where: { id: 'owner' },
    update: {},
    create: { id: 'owner', permissions: ['org:manage', 'user:manage', 'trip:*', 'invoice:*', 'reports:read'] },
  });
  await prisma.role.upsert({
    where: { id: 'driver' },
    update: {},
    create: { id: 'driver', permissions: ['trip:read', 'trip:status', 'pod:upload', 'expense:create'] },
  });
  await prisma.org.create({ data: { id: ORG_A, name: 'QA Fleet Customer A', locale: 'en', dataRegion: 'eu' } });
  await prisma.org.create({ data: { id: ORG_B, name: 'QA Fleet Customer B', locale: 'en', dataRegion: 'eu' } });
  await prisma.user.create({
    data: { id: OWNER_A, orgId: ORG_A, roleId: 'owner', name: 'QA Fleet A Owner', email: 'qa-fc-a@roadwisefleet.test', passwordHash: admin, lang: 'en' },
  });
  await prisma.user.create({
    data: { id: OWNER_B, orgId: ORG_B, roleId: 'owner', name: 'QA Fleet B Owner', email: 'qa-fc-b@roadwisefleet.test', passwordHash: admin, lang: 'en' },
  });
  await prisma.user.create({
    data: { id: DRIVER_A, orgId: ORG_A, roleId: 'driver', name: 'QA Fleet A Driver', email: 'qa-fc-driver@roadwisefleet.test', passwordHash: admin, lang: 'en' },
  });
}

const isReady = await ready();

if (!isReady) {
  test('fleet customer lane end-to-end (skipped)', (t) => {
    t.diagnostic('database unreachable — set DATABASE_URL to enable this suite');
    assert.ok(true);
  });
} else {
  await seedFixture();
  test.after(cleanup);

  const ownerA = tokenFor(OWNER_A, ORG_A, 'owner', 'QA Fleet A Owner');
  const ownerB = tokenFor(OWNER_B, ORG_B, 'owner', 'QA Fleet B Owner');
  const driverA = tokenFor(DRIVER_A, ORG_A, 'driver', 'QA Fleet A Driver');

  let customerAId = '';
  let orderAId = '';

  assert.equal(FLEET_CUSTOMER_PERMISSION, 'trip:create');

  test('both writes require a logged-in principal', async () => {
    for (const [url, payload] of [
      ['/api/fleet/customers', { name: 'X' }],
      ['/api/orders', { customerId: 'x', origin: 'A', destination: 'B' }],
    ] as const) {
      const res = await app.inject({ method: 'POST', url, payload });
      assert.equal(res.statusCode, 401, `${url}: ${res.payload}`);
    }
  });

  test('a role without trip:create is refused, before touching the body', async () => {
    for (const [url, payload] of [
      ['/api/fleet/customers', {}],
      ['/api/orders', {}],
    ] as const) {
      const res = await app.inject({ method: 'POST', url, headers: bearer(driverA), payload });
      assert.equal(res.statusCode, 403, `${url}: ${res.payload}`);
      assert.equal(res.json().error, 'forbidden');
    }
  });

  test('fleet A quick-adds a customer (201) and validates per field', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/fleet/customers', headers: bearer(ownerA), payload: { name: '' } });
    assert.equal(bad.statusCode, 400, bad.payload);
    assert.equal(bad.json().field, 'name');
    const badEmail = await app.inject({
      method: 'POST',
      url: '/api/fleet/customers',
      headers: bearer(ownerA),
      payload: { name: 'ACME', email: 'nope' },
    });
    assert.equal(badEmail.statusCode, 400, badEmail.payload);
    assert.equal(badEmail.json().field, 'email');
    assert.equal(await prisma.customer.count({ where: { orgId: ORG_A } }), 0, 'refused writes create no row');

    const res = await app.inject({
      method: 'POST',
      url: '/api/fleet/customers',
      headers: bearer(ownerA),
      payload: { name: ' Bäcker Schmidt ', email: 'orders@baecker.de', phone: '+49 30 1234', lang: 'de' },
    });
    assert.equal(res.statusCode, 201, res.payload);
    customerAId = res.json().customer.id;
    assert.equal(res.json().customer.name, 'Bäcker Schmidt');
    assert.equal(res.json().customer.email, 'orders@baecker.de');
    assert.equal(res.json().customer.lang, 'de');
    const row = await prisma.customer.findUnique({ where: { id: customerAId } });
    assert.equal(row?.orgId, ORG_A, 'the org comes from the token, never the body');
  });

  test('tenant isolation on the READ: fleet B never sees fleet A customer', async () => {
    const listA = await app.inject({ method: 'GET', url: '/api/customers', headers: bearer(ownerA) });
    assert.equal(listA.statusCode, 200, listA.payload);
    assert.ok((listA.json().customers as Array<{ id: string }>).some((c) => c.id === customerAId));

    const listB = await app.inject({ method: 'GET', url: '/api/customers', headers: bearer(ownerB) });
    assert.equal(listB.statusCode, 200, listB.payload);
    assert.equal((listB.json().customers as Array<{ id: string }>).some((c) => c.id === customerAId), false);

    // The screen's list endpoint is scoped the same way and carries the fields
    // it renders (contact, language, order count) plus the equipment vocabulary.
    const laneA = await app.inject({ method: 'GET', url: '/api/fleet/customers', headers: bearer(ownerA) });
    assert.equal(laneA.statusCode, 200, laneA.payload);
    const rowA = (laneA.json().customers as Array<Record<string, unknown>>).find((c) => c.id === customerAId);
    assert.ok(rowA, 'fleet A sees its own customer');
    assert.equal(rowA?.email, 'orders@baecker.de');
    assert.equal(rowA?.whatsappId, '+49 30 1234');
    assert.equal(rowA?.lang, 'de');
    assert.equal(Array.isArray(laneA.json().equipment), true, 'the order form gets the server vocabulary');

    const laneB = await app.inject({ method: 'GET', url: '/api/fleet/customers', headers: bearer(ownerB) });
    assert.equal(laneB.statusCode, 200, laneB.payload);
    assert.equal((laneB.json().customers as Array<{ id: string }>).length, 0, 'fleet B sees none of fleet A\'s rows');
  });

  test('fleet A creates a manual order for its customer (201, BOOKED + booking row)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: bearer(ownerA),
      payload: {
        customerId: customerAId,
        origin: 'Berlin, DE',
        destination: 'Wien, AT',
        cargo: 'Palletised goods',
        equipment: 'curtainsider',
        plannedAt: '2026-10-20T08:00:00.000Z',
      },
    });
    assert.equal(res.statusCode, 201, res.payload);
    orderAId = res.json().order.id;
    assert.equal(res.json().order.status, 'BOOKED');
    assert.equal(res.json().order.customer.name, 'Bäcker Schmidt');
    assert.equal(res.json().order.booking.equipment, 'curtainsider');

    const row = await prisma.order.findUnique({ where: { id: orderAId }, include: { booking: true } });
    assert.equal(row?.customerId, customerAId);
    assert.equal(row?.status, 'BOOKED');
    assert.equal(row?.booking?.supplyChoice, 'fleet');
  });

  test('an invalid order is a 4xx, not a 500, and creates nothing', async () => {
    const noLane = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: bearer(ownerA),
      payload: { customerId: customerAId },
    });
    assert.equal(noLane.statusCode, 400, noLane.payload);
    assert.equal(noLane.json().field, 'origin');

    const noCustomer = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: bearer(ownerA),
      payload: { origin: 'A', destination: 'B' },
    });
    assert.equal(noCustomer.statusCode, 400, noCustomer.payload);
    assert.equal(noCustomer.json().field, 'customerId');
    assert.equal(await prisma.order.count({ where: { customerId: customerAId } }), 1, 'no extra order was created');
  });

  test('TENANT ISOLATION: fleet B cannot order against fleet A customer (404)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: bearer(ownerB),
      payload: { customerId: customerAId, origin: 'Paris', destination: 'Lyon' },
    });
    assert.equal(res.statusCode, 404, res.payload);
    assert.equal(res.json().error, 'customer_not_found');
    assert.equal(await prisma.order.count({ where: { customerId: customerAId } }), 1, 'nothing was written');
  });

  test('a repeat copies the source order into a NEW order, and is tenant-scoped', async () => {
    const foreign = await app.inject({ method: 'POST', url: '/api/orders', headers: bearer(ownerB), payload: { repeatOf: orderAId } });
    assert.equal(foreign.statusCode, 404, foreign.payload);
    assert.equal(foreign.json().error, 'order_not_found');

    const res = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: bearer(ownerA),
      payload: { repeatOf: orderAId, plannedAt: '2026-10-27T08:00:00.000Z' },
    });
    assert.equal(res.statusCode, 201, res.payload);
    const repeat = res.json().order;
    assert.notEqual(repeat.id, orderAId, 'a repeat is a new order');
    assert.equal(repeat.customerId, customerAId);
    assert.equal(repeat.origin, 'Berlin, DE');
    assert.equal(repeat.destination, 'Wien, AT');
    assert.equal(repeat.booking.equipment, 'curtainsider');
    assert.equal(repeat.plannedAt, '2026-10-27T08:00:00.000Z');
    assert.equal(await prisma.order.count({ where: { customerId: customerAId } }), 2);
  });

  test('the fixture state is real while the suite runs (cleanup runs in after)', async () => {
    assert.equal(await prisma.customer.count({ where: { orgId: ORG_A } }), 1);
    assert.equal(await prisma.customer.count({ where: { orgId: ORG_B } }), 0);
    assert.equal(await prisma.order.count({ where: { customerId: customerAId } }), 2);

    const lane = await app.inject({ method: 'GET', url: '/api/fleet/customers', headers: bearer(ownerA) });
    assert.equal(lane.statusCode, 200, lane.payload);
    const row = (lane.json().customers as Array<{ id: string; orderCount: number }>).find((c) => c.id === customerAId);
    assert.equal(row?.orderCount, 2, 'the list reports how much work the customer has');
  });
}
