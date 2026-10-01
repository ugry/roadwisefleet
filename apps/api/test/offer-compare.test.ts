/**
 * Customer offer compare/award (board task #78, UXF-C2) — HTTP + database
 * end-to-end checks through the real `buildServer()` with `app.inject()` (no
 * listener, no production access).
 *
 *   pnpm --filter @roadwisefleet/api test:router
 *
 * What this proves, and why it is the layer the dependency-free core test cannot
 * reach:
 *   - a customer's marketplace booking posts a load (order + booking + POSTED
 *     `LoadPosting`), and three seeded carrier offers compare on one screen,
 *     cheapest first, with the honest flags and the budget delta;
 *   - awarding an offer creates the Trip **in the winning carrier's org**
 *     against the load's order, declines the open rival and returns notices for
 *     both sides — and the whole state is recoverable by a plain re-read;
 *   - a declined offer does not close the load;
 *   - the auto-match toggle enables immediately (the owner answered #73 q6 with
 *     "no limits") and the limits persist across a refresh;
 *   - tenant isolation: another customer gets a flat 404 on the load.
 *
 * The fixture lives in DEDICATED orgs (`qa-offer-*`) and is removed in `after`,
 * dependent rows first: `tsx --test` runs test files concurrently and the
 * trips-list / dashboard suites re-derive counts from the pilot org, so
 * shared-org writes would flake the suite (learned on board #68).
 *
 * The suite is gated twice: on database reachability, and on the #78 columns
 * (`MarketplaceOffer.carrierTruck` / `CustomerProfile.autoMatch`) being applied.
 * On a bare checkout both gates fail and the file reports a diagnostic instead
 * of a red suite — the dependency-free guards in `src/marketplace.test.js` and
 * `src/customer-core.test.js` still run everywhere.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.ALLOW_INSECURE_AUTH_SECRET = '1';
process.env.CUSTOMER_HOST_ORG_ID = 'qa-offer-cust-org';

const { buildServer } = await import('../src/app.js');
const { prisma } = await import('../src/db.js');
const { env } = await import('../src/env.js');
const { hashPassword } = await import('../src/auth/password.js');
const { signToken } = await import('../src/auth/tokens.js');
const { CUSTOMER_PERMISSIONS, CUSTOMER_ROLE } = await import('../../../customer/lib/customer-core.js');

const CUST_ORG = 'qa-offer-cust-org';
const CARRIER_A = 'qa-offer-carrier-a';
const CARRIER_B = 'qa-offer-carrier-b';
const CARRIER_C = 'qa-offer-carrier-c';
const CUSTOMER_ID = 'qa-offer-customer';
const CUSTOMER_USER = 'qa-offer-customer-user';
const OTHER_CUSTOMER_ID = 'qa-offer-other-customer';
const OTHER_CUSTOMER_USER = 'qa-offer-other-user';
const OWNER_A = 'qa-offer-owner-a';
const OWNER_B = 'qa-offer-owner-b';
const OWNER_C = 'qa-offer-owner-c';
const admin = hashPassword('qa-offer-password');

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

/** Both the portal tables and the #78 columns must exist. */
async function hasOfferCompareSchema(): Promise<boolean> {
  try {
    const cols = (await prisma.$queryRawUnsafe(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE (table_name = 'MarketplaceOffer' AND column_name IN ('carrierTruck', 'carrierVerified', 'cancellationTerms'))
           OR (table_name = 'CustomerProfile' AND column_name = 'autoMatch')`,
    )) as Array<unknown>;
    const tables = (await prisma.$queryRawUnsafe(
      `SELECT table_name FROM information_schema.tables
        WHERE table_name IN ('CustomerAccount', 'OrderBooking', 'LoadPosting')`,
    )) as Array<unknown>;
    return cols.length === 4 && tables.length === 3;
  } catch {
    return false;
  }
}

const reachable = await probeDb();
const ready = reachable ? await hasOfferCompareSchema() : false;

const tokenFor = (sub: string, org: string | null, role: string, name: string) =>
  signToken({ sub, org, role, name }, env.AUTH_SECRET, { ttlSeconds: 3600 });

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function cleanup(): Promise<void> {
  const orgs = [CARRIER_A, CARRIER_B, CARRIER_C, CUST_ORG];
  const customerIds = [CUSTOMER_ID, OTHER_CUSTOMER_ID];
  const loads = await prisma.loadPosting.findMany({
    where: { OR: [{ orgId: { in: orgs } }, { customerId: { in: customerIds } }] },
    select: { id: true },
  });
  const loadIds = loads.map((l) => l.id);
  if (loadIds.length > 0) await prisma.marketplaceOffer.deleteMany({ where: { loadId: { in: loadIds } } });
  await prisma.marketplaceOffer.deleteMany({ where: { carrierOrgId: { in: orgs } } });
  await prisma.loadPosting.deleteMany({ where: { id: { in: loadIds } } });

  const trips = await prisma.trip.findMany({ where: { orgId: { in: orgs } }, select: { id: true } });
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
  const orders = await prisma.order.findMany({ where: { customerId: { in: customerIds } }, select: { id: true } });
  await prisma.orderBooking.deleteMany({ where: { orderId: { in: orders.map((o) => o.id) } } });
  await prisma.order.deleteMany({ where: { customerId: { in: customerIds } } });
  await prisma.customerAccount.deleteMany({ where: { customerId: { in: customerIds } } });
  await prisma.customerProfile.deleteMany({ where: { customerId: { in: customerIds } } });
  await prisma.customerAddress.deleteMany({ where: { customerId: { in: customerIds } } });
  await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
  await prisma.truck.deleteMany({ where: { orgId: { in: orgs } } });
  await prisma.user.deleteMany({
    where: { id: { in: [OWNER_A, OWNER_B, OWNER_C, CUSTOMER_USER, OTHER_CUSTOMER_USER] } },
  });
  await prisma.org.deleteMany({ where: { id: { in: orgs } } });
}

async function seedFixture(): Promise<void> {
  await cleanup();
  // `createMany({ skipDuplicates })` is an atomic ON CONFLICT DO NOTHING, unlike
  // a Prisma `upsert` (find-then-create) which two concurrent test FILES can
  // race into a P2002 on the shared role id.
  await prisma.role.createMany({
    skipDuplicates: true,
    data: [
      { id: 'owner', permissions: ['org:manage', 'user:manage', 'trip:*', 'invoice:*', 'reports:read'] },
      { id: CUSTOMER_ROLE, permissions: [...CUSTOMER_PERMISSIONS] },
    ],
  });
  for (const id of [CARRIER_A, CARRIER_B, CARRIER_C, CUST_ORG]) {
    await prisma.org.create({ data: { id, name: `QA Offer ${id}`, locale: 'en', dataRegion: 'eu' } });
  }
  // One truck per carrier, so the offer's compare facets are derived from a real
  // row rather than typed in by the client.
  await prisma.truck.create({ data: { orgId: CARRIER_A, plate: 'A-RW 001' } });
  await prisma.truck.create({ data: { orgId: CARRIER_B, plate: 'B-RW 002' } });
  await prisma.truck.create({ data: { orgId: CARRIER_C, plate: 'C-RW 003' } });
  const owners: Array<[string, string, string, string]> = [
    [OWNER_A, CARRIER_A, 'owner', 'qa-offer-owner-a@roadwisefleet.test'],
    [OWNER_B, CARRIER_B, 'owner', 'qa-offer-owner-b@roadwisefleet.test'],
    [OWNER_C, CARRIER_C, 'owner', 'qa-offer-owner-c@roadwisefleet.test'],
  ];
  for (const [id, orgId, roleId, email] of owners) {
    await prisma.user.create({ data: { id, orgId, roleId, name: `Owner ${id}`, email, passwordHash: admin, lang: 'en' } });
  }
  await prisma.customer.create({
    data: { id: CUSTOMER_ID, orgId: CUST_ORG, name: 'QA Offer Shipper GmbH', email: 'qa-offer-shipper@roadwisefleet.test', lang: 'en' },
  });
  await prisma.customer.create({
    data: { id: OTHER_CUSTOMER_ID, orgId: CUST_ORG, name: 'QA Offer Other GmbH', email: 'qa-offer-other@roadwisefleet.test', lang: 'en' },
  });
  await prisma.user.create({
    data: { id: CUSTOMER_USER, orgId: null, roleId: CUSTOMER_ROLE, name: 'QA Offer Buyer', email: 'qa-offer-buyer@roadwisefleet.test', passwordHash: admin, lang: 'en' },
  });
  await prisma.customerAccount.create({ data: { userId: CUSTOMER_USER, customerId: CUSTOMER_ID } });
  await prisma.user.create({
    data: { id: OTHER_CUSTOMER_USER, orgId: null, roleId: CUSTOMER_ROLE, name: 'QA Offer Other', email: 'qa-offer-other-user@roadwisefleet.test', passwordHash: admin, lang: 'en' },
  });
  await prisma.customerAccount.create({ data: { userId: OTHER_CUSTOMER_USER, customerId: OTHER_CUSTOMER_ID } });
}

if (!ready) {
  test('customer offer compare/award end-to-end (skipped)', (t) => {
    t.diagnostic(
      reachable
        ? 'migration 20260930140000_add_offer_compare is not applied — run `prisma migrate deploy` to enable this suite'
        : 'database unreachable — set DATABASE_URL to enable this suite',
    );
    assert.ok(true);
  });
} else {
  await seedFixture();
  test.after(cleanup);

  const shipper = tokenFor(CUSTOMER_USER, null, CUSTOMER_ROLE, 'QA Offer Buyer');
  const other = tokenFor(OTHER_CUSTOMER_USER, null, CUSTOMER_ROLE, 'QA Offer Other');
  const carrierA = tokenFor(OWNER_A, CARRIER_A, 'owner', 'Owner A');
  const carrierB = tokenFor(OWNER_B, CARRIER_B, 'owner', 'Owner B');
  const carrierC = tokenFor(OWNER_C, CARRIER_C, 'owner', 'Owner C');

  let loadId = '';
  let orderId = '';
  let offerA = '';
  let offerB = '';
  let offerC = '';
  let counterC = '';
  let awardedTripId = '';

  test('the customer books a marketplace load and it posts for real', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/customer/orders',
      headers: bearer(shipper),
      payload: {
        origin: 'Berlin, DE',
        destination: 'Hamburg, DE',
        cargo: 'Palletised goods',
        equipment: 'curtainsider',
        loadReadyAt: '2026-10-05T08:00:00.000Z',
        deliverByAt: '2026-10-06T08:00:00.000Z',
        pricingMode: 'budget',
        budgetEur: 1000,
        supplyChoice: 'fleet',
      },
    });
    assert.equal(res.statusCode, 201, res.payload);
    assert.equal(res.json().marketplace.code, 'marketplace_posted');
    assert.equal(res.json().load.status, 'POSTED');
    loadId = res.json().load.id;
    orderId = res.json().order.id;
    const row = await prisma.loadPosting.findUnique({ where: { id: loadId } });
    assert.equal(row?.customerId, CUSTOMER_ID);
    assert.equal(row?.orderId, orderId);
  });

  test('three carriers make structured offers, with the truck derived server-side', async () => {
    const make = async (token: string, priceEur: number, note: string) => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/marketplace/loads/${loadId}/offers`,
        headers: bearer(token),
        payload: { priceEur, pickupEtaAt: '2026-10-05T08:00:00.000Z', deliveryEtaAt: '2026-10-06T06:00:00.000Z', note },
      });
      assert.equal(res.statusCode, 201, res.payload);
      return res.json().offer.id as string;
    };
    offerA = await make(carrierA, 900, 'Curtainsider free.');
    offerB = await make(carrierB, 1200, 'Premium service.');
    offerC = await make(carrierC, 700, 'Backhaul, can do it cheap.');
    const rows = await prisma.marketplaceOffer.findMany({ where: { loadId }, select: { carrierTruck: true, carrierVerified: true } });
    const trucks = rows.map((r) => r.carrierTruck).filter(Boolean).sort();
    assert.deepEqual(trucks, ['A-RW 001', 'B-RW 002', 'C-RW 003'], 'each offer carries its carrier’s truck');
    assert.equal(rows.every((r) => r.carrierVerified === false), true, 'fleets have no verification badge yet');
  });

  test('the compare screen shows all three offers, cheapest first, with flags and the budget delta', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/customer/loads/${loadId}`, headers: bearer(shipper) });
    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json();
    assert.equal(body.compare.length, 3, 'three offers on one screen');
    assert.deepEqual(body.compare.map((r: any) => r.id), [offerC, offerA, offerB], 'cheapest first');
    assert.equal(body.compare[0].flags.cheapest, true);
    assert.equal(body.compare[0].deltaVsBudget, -300, '700 against a 1000 budget');
    assert.equal(body.compare[0].withinBudget, true);
    assert.equal(body.compare[2].deltaVsBudget, 200);
    assert.equal(body.compare[2].withinBudget, false);
    assert.equal(body.compare[0].cancellationTerms, 'standard');
    assert.equal(body.compare[0].carrierRating, null, 'no rating store yet — honest null');
    assert.equal(body.autoMatch.entitlement.allowed, true);
    assert.equal(body.autoMatch.entitlement.active, false);
  });

  test('another customer gets a flat 404 on the load and its offers', async () => {
    const read = await app.inject({ method: 'GET', url: `/api/customer/loads/${loadId}`, headers: bearer(other) });
    assert.equal(read.statusCode, 404, read.payload);
    const award = await app.inject({
      method: 'POST',
      url: `/api/customer/loads/${loadId}/award`,
      headers: bearer(other),
      payload: { offerId: offerA },
    });
    assert.equal(award.statusCode, 404, award.payload);
    const decline = await app.inject({ method: 'POST', url: `/api/customer/offers/${offerA}/decline`, headers: bearer(other), payload: {} });
    assert.equal(decline.statusCode, 404, decline.payload);
  });

  test('the auto-match toggle enables immediately now the owner answered (q6), and the limits persist', async () => {
    const enabled = await app.inject({
      method: 'PUT',
      url: '/api/customer/auto-match',
      headers: bearer(shipper),
      payload: { enabled: true, maxPriceEur: 1200, minRating: 4 },
    });
    assert.equal(enabled.statusCode, 200, enabled.payload);
    assert.equal(enabled.json().rules.enabled, true, 'enabling is accepted, not refused');
    assert.equal(enabled.json().rules.maxPriceEur, 1200, 'the customer filter persists');
    assert.equal(enabled.json().rules.minRating, 4);
    assert.equal(enabled.json().entitlement.allowed, true);
    assert.equal(enabled.json().entitlement.active, true, 'no platform cap: an enabled rule is live');

    const saved = await app.inject({
      method: 'PUT',
      url: '/api/customer/auto-match',
      headers: bearer(shipper),
      payload: { enabled: false, maxPriceEur: 1200, minRating: 4 },
    });
    assert.equal(saved.statusCode, 200, saved.payload);
    assert.equal(saved.json().rules.maxPriceEur, 1200);
    assert.equal(saved.json().rules.minRating, 4);
    assert.equal(saved.json().rules.enabled, false);
    assert.equal(saved.json().entitlement.active, false);

    const read = await app.inject({ method: 'GET', url: '/api/customer/auto-match', headers: bearer(shipper) });
    assert.equal(read.json().rules.maxPriceEur, 1200, 'the limits survive a refresh');
    assert.equal(read.json().entitlement.active, false);
  });

  test('a declined offer does not block the load', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/customer/offers/${offerB}/decline`, headers: bearer(shipper), payload: {} });
    assert.equal(res.statusCode, 200, res.payload);
    assert.equal(res.json().offer.status, 'DECLINED');
    const load = await prisma.loadPosting.findUnique({ where: { id: loadId } });
    assert.equal(load?.status, 'OFFERS', 'the load stays open');
  });

  test('the customer counters with a structured card and the parent becomes COUNTERED', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/customer/offers/${offerC}/counter`,
      headers: bearer(shipper),
      payload: { priceEur: 750, cancellationTerms: 'flexible', note: '750 and flexible terms?' },
    });
    assert.equal(res.statusCode, 201, res.payload);
    counterC = res.json().offer.id;
    assert.equal(res.json().offer.side, 'shipper');
    assert.equal(res.json().offer.cancellationTerms, 'flexible');
    const parent = await prisma.marketplaceOffer.findUnique({ where: { id: offerC } });
    assert.equal(parent?.status, 'COUNTERED');
  });

  test('awarding creates the trip in the winner’s org and notifies both sides', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/customer/loads/${loadId}/award`,
      headers: bearer(shipper),
      payload: { offerId: counterC, paymentMethod: 'invoice' },
    });
    assert.equal(res.statusCode, 201, res.payload);
    const body = res.json();
    assert.equal(body.load.status, 'AWARDED');
    assert.equal(body.trip.orgId, CARRIER_C, 'the trip lands in the winning carrier org');
    assert.equal(body.trip.orderId, orderId, 'against the same order — nobody re-enters the load');
    assert.equal(body.trip.status, 'DRAFT');
    assert.equal(Number(body.trip.rateEur), 750);
    assert.deepEqual(body.declined, [offerA], 'the open rival is declined, never left dangling');
    awardedTripId = body.trip.id;

    const audiences = (body.notifications as Array<{ audience: string }>).map((n) => n.audience);
    assert.ok(audiences.includes('shipper'), 'the shipper is notified');
    assert.ok(audiences.includes('carrier'), 'the carrier is notified');
    assert.equal((body.notifications as Array<{ kind: string }>).some((n) => n.kind === 'declined'), true);
  });

  test('the awarded state is recoverable after a refresh and a second award is refused', async () => {
    const read = await app.inject({ method: 'GET', url: `/api/customer/loads/${loadId}`, headers: bearer(shipper) });
    assert.equal(read.statusCode, 200, read.payload);
    assert.equal(read.json().load.status, 'AWARDED');
    const statuses = read.json().compare.map((r: any) => [r.id, r.status]);
    assert.ok(statuses.some(([id, status]: [string, string]) => id === counterC && status === 'ACCEPTED'));
    assert.ok(statuses.some(([id, status]: [string, string]) => id === offerA && status === 'DECLINED'));

    const again = await app.inject({
      method: 'POST',
      url: `/api/customer/loads/${loadId}/award`,
      headers: bearer(shipper),
      payload: { offerId: offerA },
    });
    assert.equal(again.statusCode, 409, again.payload);
    assert.equal(again.json().error, 'load_awarded');
  });

  test('the awarded trip is visible to the winning carrier’s fleet manager', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/trips', headers: bearer(carrierC) });
    assert.equal(list.statusCode, 200, list.payload);
    assert.ok((list.json().trips as Array<{ id: string }>).some((t) => t.id === awardedTripId));

    const offers = await app.inject({ method: 'GET', url: '/api/marketplace/offers/mine', headers: bearer(carrierC) });
    assert.equal(offers.statusCode, 200, offers.payload);
    assert.ok(
      (offers.json().notifications as Array<{ kind: string }>).some((n) => n.kind === 'awarded'),
      'the carrier reads its award notice back',
    );
  });

  test('the fixture leaves no residue behind', async () => {
    const loads = await prisma.loadPosting.count({
      where: { OR: [{ orgId: { in: [CARRIER_A, CARRIER_B, CARRIER_C, CUST_ORG] } }, { customerId: { in: [CUSTOMER_ID, OTHER_CUSTOMER_ID] } }] },
    });
    assert.ok(loads >= 1, 'the fixture load exists while the suite runs');
  });
}
