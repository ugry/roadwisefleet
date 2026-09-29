/**
 * Connect marketplace (board task #76, UXF-M1) — HTTP + database end-to-end
 * checks through the real `buildServer()` with `app.inject()` (no listener, no
 * production access).
 *
 *   pnpm --filter @roadwisefleet/api test:router
 *
 * What this proves, and why it is the layer the dependency-free core test cannot
 * reach:
 *   - two accounts (a customer shipper and a fleet carrier) complete
 *     post → offer → counter → counter → award over real HTTP, and the awarded
 *     load appears as a Trip **in the carrier's org**, against the same order
 *     (nobody re-enters the load);
 *   - a third tenant gets 403 on every object it may see but not own, and can
 *     still browse an open load (the board is public by design);
 *   - an offer can expire: a swept offer reads EXPIRED and can no longer be
 *     awarded (409);
 *   - invoice-first: an escrow award is refused with the UXF-OWN1 reason;
 *   - a driver without `trip:create` is refused the supply side.
 *
 * The whole fixture lives in DEDICATED orgs (`qa-market-*`) and is removed in
 * `after`, dependent rows first: `tsx --test` runs test files concurrently and
 * the trips-list / dashboard suites re-derive counts from the pilot org, so
 * shared-org writes would flake the suite (learned on board #68).
 *
 * The suite is gated twice: on database reachability, and on the marketplace
 * migration being applied. On a bare checkout (CI has no DATABASE_URL) both
 * gates fail and the file reports a diagnostic instead of a red suite — the
 * dependency-free core guards in `src/marketplace.test.js` still run everywhere.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.ALLOW_INSECURE_AUTH_SECRET = '1';

const { buildServer } = await import('../src/app.js');
const { prisma } = await import('../src/db.js');
const { env } = await import('../src/env.js');
const { hashPassword } = await import('../src/auth/password.js');
const { signToken } = await import('../src/auth/tokens.js');
const { CUSTOMER_PERMISSIONS, CUSTOMER_ROLE } = await import('../../../customer/lib/customer-core.js');

const CARRIER_ORG = 'qa-market-carrier';
const CARRIER2_ORG = 'qa-market-carrier2';
const CUST_ORG = 'qa-market-cust-org';
const OWNER_ID = 'qa-market-owner';
const OWNER2_ID = 'qa-market-owner2';
const CUSTOMER_USER_ID = 'qa-market-customer-user';
const CUSTOMER_ID = 'qa-market-customer';
const CUSTOMER2_ID = 'qa-market-customer-carrier';
const DRIVER_ID = 'qa-market-driver';
const admin = hashPassword('qa-market-password');

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

async function hasMarketSchema(): Promise<boolean> {
  try {
    const tables = (await prisma.$queryRawUnsafe(
      `SELECT table_name FROM information_schema.tables
        WHERE table_name IN ('LoadPosting', 'CapacityBeacon', 'MarketplaceOffer')`,
    )) as Array<unknown>;
    return tables.length === 3;
  } catch {
    return false;
  }
}

const reachable = await probeDb();
const ready = reachable ? await hasMarketSchema() : false;

const tokenFor = (sub: string, org: string | null, role: string, name: string) =>
  signToken({ sub, org, role, name }, env.AUTH_SECRET, { ttlSeconds: 3600 });

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** Remove every dependent row of the fixture, then the fixture itself. */
async function cleanup(): Promise<void> {
  const orgs = [CARRIER_ORG, CARRIER2_ORG, CUST_ORG];
  const customerIds = [CUSTOMER_ID, CUSTOMER2_ID];
  const loads = await prisma.loadPosting.findMany({
    where: { OR: [{ orgId: { in: orgs } }, { customerId: { in: customerIds } }] },
    select: { id: true },
  });
  const loadIds = loads.map((l) => l.id);
  if (loadIds.length > 0) {
    await prisma.marketplaceOffer.deleteMany({ where: { loadId: { in: loadIds } } });
  }
  await prisma.marketplaceOffer.deleteMany({ where: { carrierOrgId: { in: orgs } } });
  await prisma.loadPosting.deleteMany({ where: { id: { in: loadIds } } });
  await prisma.capacityBeacon.deleteMany({ where: { OR: [{ orgId: { in: orgs } }, { driverId: DRIVER_ID }] } });

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
  await prisma.user.deleteMany({ where: { id: { in: [OWNER_ID, OWNER2_ID, CUSTOMER_USER_ID, DRIVER_ID] } } });
  await prisma.org.deleteMany({ where: { id: { in: orgs } } });
  // The `customer` Role row belongs to the deploy path (migration
  // 20260929230000_add_customer_role); restore it if a failing test left it gone.
  await prisma.role.upsert({
    where: { id: CUSTOMER_ROLE },
    update: {},
    create: { id: CUSTOMER_ROLE, permissions: [...CUSTOMER_PERMISSIONS] },
  });
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
  await prisma.org.create({ data: { id: CARRIER_ORG, name: 'QA Market Carrier', locale: 'en', dataRegion: 'eu' } });
  await prisma.org.create({ data: { id: CARRIER2_ORG, name: 'QA Market Carrier 2', locale: 'en', dataRegion: 'eu' } });
  await prisma.org.create({ data: { id: CUST_ORG, name: 'QA Market Shipper', locale: 'en', dataRegion: 'eu' } });
  await prisma.user.create({
    data: { id: OWNER_ID, orgId: CARRIER_ORG, roleId: 'owner', name: 'QA Carrier Owner', email: 'qa-market-owner@roadwisefleet.test', passwordHash: admin, lang: 'en' },
  });
  await prisma.user.create({
    data: { id: OWNER2_ID, orgId: CARRIER2_ORG, roleId: 'owner', name: 'QA Third Tenant', email: 'qa-market-owner2@roadwisefleet.test', passwordHash: admin, lang: 'en' },
  });
  await prisma.user.create({
    data: { id: DRIVER_ID, orgId: CARRIER_ORG, roleId: 'driver', name: 'QA Market Driver', email: 'qa-market-driver@roadwisefleet.test', passwordHash: admin, lang: 'en' },
  });
  // The shipper: a customer login attached to a Customer in the shipper org.
  await prisma.customer.create({
    data: { id: CUSTOMER_ID, orgId: CUST_ORG, name: 'QA Market Shipper GmbH', email: 'qa-market-customer@roadwisefleet.test', lang: 'en' },
  });
  // A customer of the CARRIER org, so the fleet can post a load of its own
  // (and then be refused a bid on it).
  await prisma.customer.create({
    data: { id: CUSTOMER2_ID, orgId: CARRIER_ORG, name: 'QA Carrier Own Customer', email: 'qa-market-customer2@roadwisefleet.test', lang: 'en' },
  });
  await prisma.user.create({
    data: { id: CUSTOMER_USER_ID, orgId: null, roleId: CUSTOMER_ROLE, name: 'QA Market Buyer', email: 'qa-market-buyer@roadwisefleet.test', passwordHash: admin, lang: 'en' },
  });
  await prisma.customerAccount.create({ data: { userId: CUSTOMER_USER_ID, customerId: CUSTOMER_ID } });
}

if (!ready) {
  test('connect marketplace end-to-end (skipped)', (t) => {
    t.diagnostic(
      reachable
        ? 'migration 20260929233000_add_marketplace is not applied — run `prisma migrate deploy` to enable this suite'
        : 'database unreachable — set DATABASE_URL to enable this suite',
    );
    assert.ok(true);
  });
} else {
  await seedFixture();
  test.after(cleanup);

  const shipper = tokenFor(CUSTOMER_USER_ID, null, CUSTOMER_ROLE, 'QA Market Buyer');
  const carrier = tokenFor(OWNER_ID, CARRIER_ORG, 'owner', 'QA Carrier Owner');
  const third = tokenFor(OWNER2_ID, CARRIER2_ORG, 'owner', 'QA Third Tenant');
  const driver = tokenFor(DRIVER_ID, CARRIER_ORG, 'driver', 'QA Market Driver');

  let orderId = '';
  let loadId = '';
  let firstOfferId = '';
  let shipperCounterId = '';
  let carrierCounterId = '';
  let awardedTripId = '';

  test('the fixture order exists for the shipper to post', async () => {
    const order = await prisma.order.create({
      data: {
        customerId: CUSTOMER_ID,
        origin: 'Berlin, DE',
        destination: 'Hamburg, DE',
        cargo: 'Palletised goods',
        status: 'BOOKED',
        plannedAt: new Date('2026-10-02T08:00:00.000Z'),
        booking: { create: { supplyChoice: 'fleet', equipment: 'curtainsider' } },
      },
    });
    orderId = order.id;
    assert.ok(orderId);
  });

  test('the shipper posts a load from its order (lane inherited, no re-entry)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/marketplace/loads',
      headers: bearer(shipper),
      payload: { orderId, loadReadyAt: '2026-10-01T08:00:00.000Z', deliverByAt: '2026-10-02T08:00:00.000Z' },
    });
    assert.equal(res.statusCode, 201, res.payload);
    const load = res.json().load;
    assert.equal(load.origin, 'Berlin, DE', 'the lane comes from the order');
    assert.equal(load.destination, 'Hamburg, DE');
    assert.equal(load.equipment, 'curtainsider', 'the equipment comes from the booking');
    assert.equal(load.status, 'POSTED');
    loadId = load.id;

    const row = await prisma.loadPosting.findUnique({ where: { id: loadId } });
    assert.equal(row?.customerId, CUSTOMER_ID, 'the tenant is the customer, never a client value');
    assert.equal(row?.orgId, null);
    assert.equal(row?.orderId, orderId);
  });

  test('an invalid load posting is refused with the field', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/marketplace/loads',
      headers: bearer(shipper),
      payload: {},
    });
    assert.equal(res.statusCode, 400, res.payload);
    assert.equal(res.json().error, 'invalid_input');
    assert.equal(res.json().field, 'origin');
  });

  test('a driver without trip:create cannot use the supply side', async () => {
    for (const [method, url, payload] of [
      ['GET', '/api/marketplace/loads', undefined],
      ['POST', `/api/marketplace/loads/${loadId}/offers`, { priceEur: 100 }],
      ['GET', '/api/marketplace/beacons', undefined],
    ] as const) {
      const res = await app.inject({ method, url, headers: bearer(driver), payload });
      assert.equal(res.statusCode, 403, `${method} ${url} -> ${res.payload}`);
    }
  });

  test('a third tenant can see an open load (the board is public by design)', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/marketplace/loads/${loadId}`, headers: bearer(third) });
    assert.equal(res.statusCode, 200, res.payload);
    assert.equal(res.json().viewer, 'carrier');
    assert.deepEqual(res.json().offers, [], 'it sees no offers it does not own');
  });

  test('the carrier makes the first structured offer and the load opens for offers', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/marketplace/loads/${loadId}/offers`,
      headers: bearer(carrier),
      payload: {
        priceEur: 1250,
        pickupEtaAt: '2026-10-01T08:00:00.000Z',
        deliveryEtaAt: '2026-10-02T06:00:00.000Z',
        note: 'Curtainsider, two pallet spaces free.',
      },
    });
    assert.equal(res.statusCode, 201, res.payload);
    const offer = res.json().offer;
    assert.equal(offer.side, 'carrier');
    assert.equal(offer.status, 'SENT');
    assert.equal(offer.carrierOrgId, CARRIER_ORG);
    firstOfferId = offer.id;

    const load = await prisma.loadPosting.findUnique({ where: { id: loadId } });
    assert.equal(load?.status, 'OFFERS', 'the first offer moves the load to OFFERS');
  });

  test('the carrier cannot bid on its own load', async () => {
    // A fleet may post a load it cannot cover — from one of ITS own customers'
    // orders — but it may not then offer for it.
    const ownOrder = await prisma.order.create({
      data: { customerId: CUSTOMER2_ID, origin: 'Berlin, DE', destination: 'Munich, DE', cargo: 'Machinery', status: 'BOOKED' },
    });
    const ownLoad = await app.inject({
      method: 'POST',
      url: '/api/marketplace/loads',
      headers: bearer(carrier),
      payload: { orderId: ownOrder.id, pricingMode: 'quotes' },
    });
    assert.equal(ownLoad.statusCode, 201, ownLoad.payload);
    assert.equal(ownLoad.json().load.status, 'POSTED');
    const auctionOff = await prisma.loadPosting.findUnique({ where: { id: ownLoad.json().load.id } });
    assert.equal(auctionOff?.orgId, CARRIER_ORG, 'a fleet load is scoped to the posting org');
    assert.equal(auctionOff?.customerId, null);

    const bid = await app.inject({
      method: 'POST',
      url: `/api/marketplace/loads/${ownLoad.json().load.id}/offers`,
      headers: bearer(carrier),
      payload: { priceEur: 500 },
    });
    assert.equal(bid.statusCode, 403, bid.payload);
    assert.equal(bid.json().error, 'own_load');
  });

  test('the shipper counters the offer with a structured card', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/marketplace/offers/${firstOfferId}/counter`,
      headers: bearer(shipper),
      payload: { priceEur: 1050, note: 'Can we do 1050?' },
    });
    assert.equal(res.statusCode, 201, res.payload);
    const counter = res.json().offer;
    assert.equal(counter.side, 'shipper', 'the shipper answered');
    assert.equal(counter.parentOfferId, firstOfferId);
    assert.equal(counter.priceEur, '1050');
    shipperCounterId = counter.id;

    const parent = await prisma.marketplaceOffer.findUnique({ where: { id: firstOfferId } });
    assert.equal(parent?.status, 'COUNTERED', 'the answered offer is COUNTERED, not deleted');
  });

  test('the carrier counters back and the shipper sees the whole auditable chain', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/marketplace/offers/${shipperCounterId}/counter`,
      headers: bearer(carrier),
      payload: { priceEur: 1150, note: '1150, and I cover the tolls.' },
    });
    assert.equal(res.statusCode, 201, res.payload);
    const counter = res.json().offer;
    assert.equal(counter.side, 'carrier');
    carrierCounterId = counter.id;

    const detail = await app.inject({ method: 'GET', url: `/api/marketplace/loads/${loadId}`, headers: bearer(shipper) });
    assert.equal(detail.statusCode, 200, detail.payload);
    const chain = detail.json().offers as Array<{ id: string; status: string; parentOfferId: string | null }>;
    assert.equal(chain.length, 3, 'three structured cards, nothing verbal-only');
    assert.equal(chain.find((o) => o.id === firstOfferId)?.status, 'COUNTERED');
    assert.equal(chain.find((o) => o.id === shipperCounterId)?.status, 'COUNTERED');
    assert.equal(chain.find((o) => o.id === carrierCounterId)?.status, 'SENT');
  });

  test('a third tenant gets 403 on every object it may not own', async () => {
    const calls: Array<[string, string, unknown]> = [
      ['POST', `/api/marketplace/loads/${loadId}/award`, { offerId: carrierCounterId }],
      ['POST', `/api/marketplace/loads/${loadId}/cancel`, {}],
      ['POST', `/api/marketplace/offers/${carrierCounterId}/decline`, {}],
      ['POST', `/api/marketplace/offers/${carrierCounterId}/withdraw`, {}],
      ['POST', `/api/marketplace/offers/${carrierCounterId}/counter`, { priceEur: 100 }],
    ];
    for (const [method, url, payload] of calls) {
      const res = await app.inject({ method: method as 'POST', url, headers: bearer(third), payload: payload as object });
      assert.equal(res.statusCode, 403, `${method} ${url} -> ${res.payload}`);
    }
    const unknown = await app.inject({ method: 'GET', url: '/api/marketplace/loads/does-not-exist', headers: bearer(third) });
    assert.equal(unknown.statusCode, 404, 'an unknown object is a 404, never a leak');
  });

  test('an escrow award is refused with the UXF-OWN1 reason (invoice-first)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/marketplace/loads/${loadId}/award`,
      headers: bearer(shipper),
      payload: { offerId: carrierCounterId, paymentMethod: 'escrow' },
    });
    assert.equal(res.statusCode, 400, res.payload);
    assert.equal(res.json().field, 'paymentMethod');
    assert.equal(res.json().detail, 'escrow_deferred_uxf_own1');
  });

  test('the shipper awards: the trip is created in the carrier org against the order', async () => {
    // A competing carrier joins before the award, so the award must decline a
    // real open rival (and it proves the board is open to other tenants).
    const competing = await app.inject({
      method: 'POST',
      url: `/api/marketplace/loads/${loadId}/offers`,
      headers: bearer(third),
      payload: { priceEur: 1400, note: 'We can also cover it.' },
    });
    assert.equal(competing.statusCode, 201, competing.payload);
    const competingId = competing.json().offer.id;

    const res = await app.inject({
      method: 'POST',
      url: `/api/marketplace/loads/${loadId}/award`,
      headers: bearer(shipper),
      payload: { offerId: carrierCounterId, paymentMethod: 'invoice' },
    });
    assert.equal(res.statusCode, 201, res.payload);
    const body = res.json();
    assert.equal(body.load.status, 'AWARDED');
    assert.equal(body.offer.status, 'ACCEPTED');
    assert.equal(body.paymentMethod, 'invoice');
    assert.deepEqual(body.declined, [competingId], 'the open rival is declined, never left dangling');
    assert.equal(body.trip.orgId, CARRIER_ORG, 'the trip lands in the carrier org');
    assert.equal(body.trip.orderId, orderId);
    assert.equal(body.trip.status, 'DRAFT');
    assert.equal(Number(body.trip.rateEur), 1150, 'the awarded price is the winning counter');
    awardedTripId = body.trip.id;

    const trip = await prisma.trip.findUnique({ where: { id: awardedTripId } });
    assert.equal(trip?.orgId, CARRIER_ORG);
    const winner = await prisma.marketplaceOffer.findUnique({ where: { id: carrierCounterId } });
    assert.equal(winner?.status, 'ACCEPTED');
    assert.ok(winner?.decidedAt);
    // The countered parents stay COUNTERED (already superseded), not declined.
    const parent = await prisma.marketplaceOffer.findUnique({ where: { id: firstOfferId } });
    assert.equal(parent?.status, 'COUNTERED');
  });

  test('the awarded load appears in the carrier fleet-manager trips list', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/trips', headers: bearer(carrier) });
    assert.equal(res.statusCode, 200, res.payload);
    const trips = res.json().trips as Array<{ id: string; status: string }>;
    const mine = trips.find((t) => t.id === awardedTripId);
    assert.ok(mine, 'the awarded load must be a trip for the carrier');
    assert.equal(mine?.status, 'DRAFT');

    const detail = await app.inject({ method: 'GET', url: `/api/trips/${awardedTripId}`, headers: bearer(carrier) });
    assert.equal(detail.statusCode, 200, detail.payload);
    assert.equal(detail.json().trip.order.origin, 'Berlin, DE', 'same order, no re-entry');
  });

  test('a second award is refused (the load is awarded once)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/marketplace/loads/${loadId}/award`,
      headers: bearer(shipper),
      payload: { offerId: carrierCounterId },
    });
    assert.equal(res.statusCode, 409, res.payload);
    assert.equal(res.json().error, 'load_awarded');
  });

  test('after the award a third tenant gets 403 reading the load', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/marketplace/loads/${loadId}`, headers: bearer(third) });
    assert.equal(res.statusCode, 403, res.payload);
  });

  test('an offer can expire: a swept offer reads EXPIRED and cannot be awarded', async () => {
    const load = await app.inject({
      method: 'POST',
      url: '/api/marketplace/loads',
      headers: bearer(shipper),
      payload: {
        orderId,
        origin: 'Berlin, DE',
        destination: 'Hamburg, DE',
        equipment: 'curtainsider',
        loadReadyAt: '2026-10-05T08:00:00.000Z',
        deliverByAt: '2026-10-06T08:00:00.000Z',
      },
    });
    assert.equal(load.statusCode, 201, load.payload);
    const expLoadId = load.json().load.id;

    const offerRes = await app.inject({
      method: 'POST',
      url: `/api/marketplace/loads/${expLoadId}/offers`,
      headers: bearer(carrier),
      payload: { priceEur: 900 },
    });
    assert.equal(offerRes.statusCode, 201, offerRes.payload);
    const expOfferId = offerRes.json().offer.id;

    // Simulate time passing: the offer's expiry is now in the past. The lazy
    // sweep on the next read must make it EXPIRED state, not a render illusion.
    await prisma.marketplaceOffer.update({ where: { id: expOfferId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const detail = await app.inject({ method: 'GET', url: `/api/marketplace/loads/${expLoadId}`, headers: bearer(shipper) });
    assert.equal(detail.statusCode, 200, detail.payload);
    assert.equal(detail.json().offers[0].status, 'EXPIRED');
    assert.equal((await prisma.marketplaceOffer.findUnique({ where: { id: expOfferId } }))?.status, 'EXPIRED');

    const award = await app.inject({
      method: 'POST',
      url: `/api/marketplace/loads/${expLoadId}/award`,
      headers: bearer(shipper),
      payload: { offerId: expOfferId },
    });
    assert.equal(award.statusCode, 409, award.payload);
    assert.equal(award.json().error, 'offer_expired');
  });

  test('a declined offer does not block the load', async () => {
    const load = await app.inject({
      method: 'POST',
      url: '/api/marketplace/loads',
      headers: bearer(shipper),
      payload: { orderId, origin: 'Berlin, DE', destination: 'Warsaw, PL', pricingMode: 'quotes' },
    });
    const id = load.json().load.id;
    const offerRes = await app.inject({
      method: 'POST',
      url: `/api/marketplace/loads/${id}/offers`,
      headers: bearer(carrier),
      payload: { priceEur: 700 },
    });
    const offerId = offerRes.json().offer.id;
    const decline = await app.inject({
      method: 'POST',
      url: `/api/marketplace/offers/${offerId}/decline`,
      headers: bearer(shipper),
      payload: {},
    });
    assert.equal(decline.statusCode, 200, decline.payload);
    assert.equal(decline.json().offer.status, 'DECLINED');

    const stillOpen = await prisma.loadPosting.findUnique({ where: { id } });
    assert.equal(stillOpen?.status, 'OFFERS', 'a declined offer does not close the load');

    // The carrier may withdraw its own offer too.
    const second = await app.inject({
      method: 'POST',
      url: `/api/marketplace/loads/${id}/offers`,
      headers: bearer(carrier),
      payload: { priceEur: 750 },
    });
    const withdraw = await app.inject({
      method: 'POST',
      url: `/api/marketplace/offers/${second.json().offer.id}/withdraw`,
      headers: bearer(carrier),
      payload: {},
    });
    assert.equal(withdraw.statusCode, 200, withdraw.payload);
    assert.equal(withdraw.json().offer.status, 'WITHDRAWN');
  });

  test('the beacon flow: publish, browse, match and scope', async () => {
    const published = await app.inject({
      method: 'POST',
      url: '/api/marketplace/beacons',
      headers: bearer(carrier),
      payload: {
        location: 'Berlin, DE',
        heading: 'Hamburg',
        availableFrom: '2026-10-01T06:00:00.000Z',
        equipment: 'curtainsider',
        minRateEur: 600,
      },
    });
    assert.equal(published.statusCode, 201, published.payload);
    const beaconId = published.json().beacon.id;

    // The shipper may browse capacity (diagram 05: DEM4).
    const browse = await app.inject({ method: 'GET', url: '/api/marketplace/beacons?equipment=curtainsider', headers: bearer(shipper) });
    assert.equal(browse.statusCode, 200, browse.payload);
    assert.ok((browse.json().beacons as Array<{ id: string }>).some((b) => b.id === beaconId));
    const raw = JSON.stringify(browse.json());
    assert.equal(raw.includes('passwordHash'), false, 'beacons never leak credentials');

    // Matching a load against the capacity, ranked.
    const match = await app.inject({ method: 'GET', url: `/api/marketplace/matches?loadId=${loadId}`, headers: bearer(shipper) });
    assert.equal(match.statusCode, 200, match.payload);
    const matches = match.json().matches as Array<{ beacon: { id: string }, score: number, reasons: string[] }>;
    const mine = matches.find((m) => m.beacon.id === beaconId);
    assert.ok(mine, 'the beacon is ranked for the load');
    assert.ok(mine!.score > 0);
    assert.ok(mine!.reasons.includes('lane_origin'));

    // A third tenant cannot deactivate another owner's beacon: 404, no leak.
    const stolen = await app.inject({ method: 'DELETE', url: `/api/marketplace/beacons/${beaconId}`, headers: bearer(third) });
    assert.equal(stolen.statusCode, 404, stolen.payload);
    // The owner can.
    const off = await app.inject({ method: 'DELETE', url: `/api/marketplace/beacons/${beaconId}`, headers: bearer(carrier) });
    assert.equal(off.statusCode, 200, off.payload);
    assert.equal(off.json().beacon.active, false);
  });

  test('a carrier feed filter matches lane, date and equipment in the database', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/marketplace/loads?origin=Berlin&destination=Warsaw&equipment=curtainsider',
      headers: bearer(third),
    });
    assert.equal(res.statusCode, 200, res.payload);
    const loads = res.json().loads as Array<{ id: string; origin: string; destination: string }>;
    assert.ok(loads.some((l) => l.destination === 'Warsaw, PL'), 'the Warsaw load matches');
    assert.equal(loads.some((l) => l.destination === 'Hamburg, DE'), false, 'the lane filter really filters');

    const narrow = await app.inject({ method: 'GET', url: '/api/marketplace/loads?equipment=reefer', headers: bearer(third) });
    assert.deepEqual(narrow.json().loads, [], 'no reefer load was posted');
  });

  test('the fixture leaves no residue behind', async () => {
    const counts = {
      loads: await prisma.loadPosting.count({ where: { OR: [{ orgId: { in: [CARRIER_ORG, CARRIER2_ORG, CUST_ORG] } }, { customerId: { in: [CUSTOMER_ID, CUSTOMER2_ID] } }] } }),
      activeBeacons: await prisma.capacityBeacon.count({ where: { active: true, OR: [{ orgId: { in: [CARRIER_ORG, CARRIER2_ORG, CUST_ORG] } }, { driverId: DRIVER_ID }] } }),
    };
    assert.equal(counts.activeBeacons, 0, 'the fixture beacon was deactivated');
    assert.ok(counts.loads >= 3, 'the fixture loads exist while the suite runs');
  });
}
