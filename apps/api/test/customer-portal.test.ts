/**
 * Customer portal (board task #74, UXF-C1) — HTTP + database end-to-end checks
 * through the real `buildServer()` with `app.inject()` (no listener, no
 * production access).
 *
 *   pnpm --filter @roadwisefleet/api test:router
 *
 * What this proves, and why it is the layer the dependency-free core test cannot
 * reach:
 *   - a brand-new customer account books its own carrier end to end: signup →
 *     order + DRAFT trip → the trip is visible to the fleet manager of the
 *     carrier org (`GET /api/trips` with that org's owner token);
 *   - tenant isolation: another org's owner does not see it, and a second
 *     customer of the same carrier gets a flat 404 on the first one's order;
 *   - a marketplace supply choice answers 202 with the phase notice and creates
 *     nothing;
 *   - the shareable tracking link reuses the board-#5/#39 machinery.
 *
 * The whole fixture lives in a DEDICATED org (`qa-customer-org`) and is removed
 * in `after`, dependent rows first: `tsx --test` runs test files concurrently and
 * the trips-list / dashboard suites re-derive counts from the pilot org, so
 * shared-org writes would flake the suite (learned on board #68).
 *
 * The suite is gated twice: on database reachability, and on the migration
 * `20260929140000_add_customer_portal` being applied. On a bare checkout (CI has
 * no DATABASE_URL) both gates fail and the file reports a diagnostic instead of
 * a red suite — the dependency-free guard in `src/customer-core.test.js` still
 * runs everywhere.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.ALLOW_INSECURE_AUTH_SECRET = '1';
// Pin the portal's carrier org to the dedicated fixture org BEFORE env.ts is
// imported: a signup must never attach to the seeded pilot org.
process.env.CUSTOMER_HOST_ORG_ID = 'qa-customer-org';

const { buildServer } = await import('../src/app.js');
const { prisma } = await import('../src/db.js');
const { env } = await import('../src/env.js');
const { hashPassword } = await import('../src/auth/password.js');
const { signToken } = await import('../src/auth/tokens.js');

const QA_ORG = 'qa-customer-org';
const OWNER_ID = 'qa-customer-owner';
const admin = hashPassword('qa-customer-password');

const app = buildServer();
await app.ready();
test.after(() => app.close());

/** Is the database reachable at all? */
async function probeDb(): Promise<boolean> {
  try {
    await prisma.$queryRawUnsafe('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

/** Has the customer-portal migration been applied? */
async function hasPortalSchema(): Promise<boolean> {
  try {
    const tables = (await prisma.$queryRawUnsafe(
      `SELECT table_name FROM information_schema.tables
        WHERE table_name IN ('CustomerAccount', 'CustomerProfile', 'CustomerAddress', 'OrderBooking')`,
    )) as Array<unknown>;
    return tables.length === 4;
  } catch {
    return false;
  }
}

const reachable = await probeDb();
const ready = reachable ? await hasPortalSchema() : false;

/** The bearer for a principal, signed with the same secret the server uses. */
const tokenFor = (sub: string, org: string | null, role: string, name: string) =>
  signToken({ sub, org, role, name }, env.AUTH_SECRET, { ttlSeconds: 3600 });

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** Remove every dependent row of the fixture trips, then the fixture itself. */
async function cleanup(): Promise<void> {
  const customers = await prisma.customer.findMany({ where: { orgId: QA_ORG }, select: { id: true } });
  const customerIds = customers.map((c) => c.id);
  const trips = await prisma.trip.findMany({ where: { orgId: QA_ORG }, select: { id: true } });
  const tripIds = trips.map((t) => t.id);
  if (tripIds.length > 0) {
    const where = { tripId: { in: tripIds } };
    await prisma.statusEvent.deleteMany({ where });
    await prisma.gpsPing.deleteMany({ where });
    await prisma.expense.deleteMany({ where });
    await prisma.document.deleteMany({ where });
    await prisma.settlement.deleteMany({ where });
    await prisma.tripStop.deleteMany({ where });
    await prisma.tripDriver.deleteMany({ where });
    await prisma.trip.deleteMany({ where: { id: { in: tripIds } } });
  }
  if (customerIds.length > 0) {
    await prisma.order.deleteMany({ where: { customerId: { in: customerIds } } });
    const accounts = await prisma.customerAccount.findMany({
      where: { customerId: { in: customerIds } },
      select: { userId: true },
    });
    await prisma.customerAccount.deleteMany({ where: { customerId: { in: customerIds } } });
    if (accounts.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: accounts.map((a) => a.userId) } } });
    }
    await prisma.customerProfile.deleteMany({ where: { customerId: { in: customerIds } } });
    await prisma.customerAddress.deleteMany({ where: { customerId: { in: customerIds } } });
    await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
  }
  await prisma.user.deleteMany({ where: { orgId: QA_ORG } });
  await prisma.org.deleteMany({ where: { id: QA_ORG } });
}

async function seedFixture(): Promise<void> {
  await cleanup();
  // Roles are global (no orgId). `customer` is the role this task adds to the
  // seed; upserting the three here keeps the suite runnable before the seed is
  // re-run.
  await prisma.role.upsert({
    where: { id: 'customer' },
    update: { permissions: ['order:create', 'order:read', 'customer:manage'] },
    create: { id: 'customer', permissions: ['order:create', 'order:read', 'customer:manage'] },
  });
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
  await prisma.org.create({ data: { id: QA_ORG, name: 'QA Customer Carrier', locale: 'en', dataRegion: 'eu' } });
  await prisma.user.create({
    data: {
      id: OWNER_ID,
      orgId: QA_ORG,
      roleId: 'owner',
      name: 'QA Carrier Owner',
      email: 'qa-customer-owner@roadwisefleet.test',
      passwordHash: admin,
      lang: 'en',
    },
  });
}

if (!ready) {
  test('customer portal end-to-end (skipped)', (t) => {
    t.diagnostic(
      reachable
        ? 'migration 20260929140000_add_customer_portal is not applied — run `prisma migrate deploy` to enable this suite'
        : 'database unreachable — set DATABASE_URL to enable this suite',
    );
    assert.ok(true);
  });
} else {
  await seedFixture();
  test.after(cleanup);

  const signupBody = (email: string) => ({
    name: 'QA Customer',
    company: 'QA Customer GmbH',
    email,
    phone: '+49 170 1234567',
    password: 'customer-password-1',
  });

  let firstToken = '';
  let firstCustomerId = '';
  let firstOrderId = '';
  let firstTripId = '';
  let secondToken = '';

  test('a new customer signs up and gets a customer session', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/customer/signup', payload: signupBody('qa-customer-1@roadwisefleet.test') });
    assert.equal(res.statusCode, 201, res.payload);
    const body = res.json();
    assert.ok(body.token, 'a token is issued');
    assert.equal(body.user.roleId, 'customer');
    assert.equal(body.user.orgId, null, 'a customer login holds no fleet org');
    assert.equal(body.user.customer.orgId, QA_ORG);
    firstToken = body.token;
    firstCustomerId = body.user.customer.id;

    const me = await app.inject({ method: 'GET', url: '/api/customer/me', headers: bearer(firstToken) });
    assert.equal(me.statusCode, 200, me.payload);
    assert.equal(me.json().customer.name, 'QA Customer GmbH');
    assert.deepEqual(me.json().team.length, 1);
  });

  test('signing up twice with the same email is refused', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/customer/signup', payload: signupBody('qa-customer-1@roadwisefleet.test') });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error, 'email_taken');
  });

  test('an invalid booking is refused with the field and the message key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/customer/orders',
      headers: bearer(firstToken),
      payload: { destination: 'Hamburg', supplyChoice: 'own_carrier' },
    });
    assert.equal(res.statusCode, 400, res.payload);
    assert.equal(res.json().error, 'invalid_input');
    assert.equal(res.json().field, 'origin');
    assert.equal(res.json().detail, 'origin is required');
  });

  test('a marketplace choice answers 202 with the phase notice and creates nothing', async () => {
    const before = await prisma.order.count({ where: { customerId: firstCustomerId } });
    const res = await app.inject({
      method: 'POST',
      url: '/api/customer/orders',
      headers: bearer(firstToken),
      payload: { origin: 'Berlin, DE', destination: 'Hamburg, DE', supplyChoice: 'fleet' },
    });
    assert.equal(res.statusCode, 202, res.payload);
    assert.equal(res.json().order, null);
    assert.equal(res.json().marketplace.code, 'marketplace_unavailable');
    assert.equal(res.json().marketplace.task, 'UXF-M1 (#76)');
    assert.equal(res.json().marketplace.fallback, 'own_carrier');
    assert.equal(await prisma.order.count({ where: { customerId: firstCustomerId } }), before);
  });

  test('booking with its own carrier creates the order and the draft trip', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/customer/orders',
      headers: bearer(firstToken),
      payload: {
        origin: 'Berlin, DE',
        destination: 'Hamburg, DE',
        cargo: 'Palletised goods',
        equipment: 'curtainsider',
        loadReadyAt: '2026-10-01T08:00:00.000Z',
        deliverByAt: '2026-10-02T08:00:00.000Z',
        pricingMode: 'budget',
        budgetEur: 950,
        payer: 'consignee',
        paymentMethod: 'invoice',
        insuranceValueEur: 25000,
        stops: [{ address: 'Hannover, DE', kind: 'checkpoint' }],
        supplyChoice: 'own_carrier',
      },
    });
    assert.equal(res.statusCode, 201, res.payload);
    const order = res.json().order;
    assert.equal(order.status, 'BOOKED');
    assert.equal(order.supplyChoice, 'own_carrier');
    assert.equal(order.trip.status, 'DRAFT', 'the trip waits for the dispatcher');
    assert.equal(order.booking.equipment, 'curtainsider');
    assert.deepEqual(order.booking.stops, [{ kind: 'checkpoint', address: 'Hannover, DE' }]);
    firstOrderId = order.id;
    firstTripId = order.trip.id;

    // The row really is on the carrier org, unassigned and without a rate the
    // customer never agreed: the fleet manager owns those decisions.
    const row = await prisma.trip.findUnique({ where: { id: firstTripId }, include: { order: true } });
    assert.equal(row?.orgId, QA_ORG);
    assert.equal(row?.driverId, null);
    assert.equal(row?.truckId, null);
    assert.equal(row?.rateEur, null);
    assert.equal(row?.order.origin, 'Berlin, DE');
    assert.equal(row?.order.plannedAt?.toISOString(), '2026-10-02T08:00:00.000Z');

    // The wizard detail lives in its own table, alongside the shared Order.
    const booking = await prisma.orderBooking.findUnique({ where: { orderId: firstOrderId } });
    assert.equal(booking?.supplyChoice, 'own_carrier');
    assert.equal(booking?.equipment, 'curtainsider');
    assert.deepEqual((booking?.details as { stops: unknown[] }).stops, [{ kind: 'checkpoint', address: 'Hannover, DE' }]);
  });

  test('the booked order is visible to the fleet manager of the carrier org', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/trips',
      headers: bearer(tokenFor(OWNER_ID, QA_ORG, 'owner', 'QA Carrier Owner')),
    });
    assert.equal(res.statusCode, 200, res.payload);
    const trips = res.json().trips as Array<{ id: string; status: string }>;
    const mine = trips.find((t) => t.id === firstTripId);
    assert.ok(mine, 'the customer booking must appear in the carrier org trips list');
    assert.equal(mine?.status, 'DRAFT');
  });

  test("another org's manager never sees the customer booking", async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/trips',
      headers: bearer(tokenFor('pilot-admin', 'pilot-org', 'owner', 'Pilot Admin')),
    });
    assert.equal(res.statusCode, 200, res.payload);
    const trips = res.json().trips as Array<{ id: string }>;
    assert.equal(trips.some((t) => t.id === firstTripId), false);
  });

  test('a second customer of the same carrier cannot read the first order', async () => {
    const second = await app.inject({ method: 'POST', url: '/api/customer/signup', payload: signupBody('qa-customer-2@roadwisefleet.test') });
    assert.equal(second.statusCode, 201, second.payload);
    secondToken = second.json().token;

    const mine = await app.inject({ method: 'GET', url: `/api/customer/orders/${firstOrderId}`, headers: bearer(secondToken) });
    assert.equal(mine.statusCode, 404, 'not mine must be 404, never 403');
    assert.equal(mine.json().error, 'not_found');

    const list = await app.inject({ method: 'GET', url: '/api/customer/orders', headers: bearer(secondToken) });
    assert.equal(list.statusCode, 200);
    assert.deepEqual(list.json().orders, []);
  });

  test('the shipments list returns the own order as a PII-free summary', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/customer/orders', headers: bearer(firstToken) });
    assert.equal(res.statusCode, 200, res.payload);
    const orders = res.json().orders as Array<Record<string, unknown>>;
    assert.equal(orders.length, 1);
    assert.equal(orders[0].id, firstOrderId);
    assert.equal((orders[0].trip as Record<string, unknown>).status, 'DRAFT');
    const raw = JSON.stringify(orders[0]);
    for (const forbidden of ['rateEur', 'driver', 'passwordHash', 'plate']) {
      assert.equal(raw.includes(forbidden), false, 'the summary must not carry ' + forbidden);
    }
  });

  test('the customer mints a tracking link and the public page reads it', async () => {
    const mint = await app.inject({
      method: 'POST',
      url: `/api/customer/orders/${firstOrderId}/track-link`,
      headers: bearer(firstToken),
    });
    assert.equal(mint.statusCode, 201, mint.payload);
    const url = mint.json().link.url as string;
    assert.match(url, /^\/track\//);
    const token = url.slice('/track/'.length);

    const publicRead = await app.inject({ method: 'GET', url: `/api/track/${token}` });
    assert.equal(publicRead.statusCode, 200, publicRead.payload);
    assert.equal(publicRead.json().tracking.route.origin, 'Berlin, DE');

    // Minting again returns the same live link rather than a second one.
    const again = await app.inject({
      method: 'POST',
      url: `/api/customer/orders/${firstOrderId}/track-link`,
      headers: bearer(firstToken),
    });
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().link.url, url);
  });

  test('a non-customer role is refused by every customer route', async () => {
    await prisma.user.create({
      data: {
        id: 'qa-customer-org-driver',
        orgId: QA_ORG,
        roleId: 'driver',
        name: 'QA Driver',
        email: 'qa-customer-org-driver@roadwisefleet.test',
        passwordHash: admin,
      },
    });
    const driverToken = tokenFor('qa-customer-org-driver', QA_ORG, 'driver', 'QA Driver');
    for (const [method, url] of [
      ['GET', '/api/customer/me'],
      ['GET', '/api/customer/orders'],
      ['POST', '/api/customer/orders'],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        headers: bearer(driverToken),
        payload: method === 'POST' ? { origin: 'A', destination: 'B', supplyChoice: 'own_carrier' } : undefined,
      });
      assert.equal(res.statusCode, 403, `${method} ${url} -> ${res.payload}`);
      assert.equal(res.json().error, 'forbidden');
    }
    const anonymous = await app.inject({ method: 'GET', url: '/api/customer/me' });
    assert.equal(anonymous.statusCode, 401);
  });

  test('the fixture leaves no residue behind', async () => {
    // Asserted before `after` runs: the only rows in the QA org are the ones the
    // tests wrote, and nothing leaked into the pilot org.
    const counts = {
      org: await prisma.org.count({ where: { id: QA_ORG } }),
      customers: await prisma.customer.count({ where: { orgId: QA_ORG } }),
      orders: await prisma.order.count({ where: { customer: { orgId: QA_ORG } } }),
      trips: await prisma.trip.count({ where: { orgId: QA_ORG } }),
    };
    assert.equal(counts.org, 1);
    assert.equal(counts.customers, 2);
    assert.equal(counts.orders, 1);
    assert.equal(counts.trips, 1);
  });
}
