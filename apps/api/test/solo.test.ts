/**
 * Solo driver Connect MVP (board task #77, UXF-M2) — HTTP + database end-to-end
 * checks through the real `buildServer()` with `app.inject()` (no listener, no
 * production access).
 *
 *   pnpm --filter @roadwisefleet/api test:router
 *
 * What this proves, and why it is the layer the dependency-free core test cannot
 * reach — it is the acceptance criteria of the task, in order:
 *   - signup creates the one-person carrier org, the `solo` role and the profile;
 *   - an UNVERIFIED driver browses the board AND bids (owner #73 q5: optional);
 *   - phone OTP completes (dev-echo opt-in) and a wrong code is refused;
 *   - once VERIFIED, the driver bids, the shipper awards, and the award creates
 *     the Trip in the driver's org with the driver assigned;
 *   - the driver executes the statuses, uploads a POD and the wallet shows the
 *     payment status;
 *   - a quick job for the driver's OWN customer (no shipper account, no login)
 *     creates an Order + Trip and mints a WORKING public tracking link;
 *   - the beacon, the saved searches and the scoping boundaries hold.
 *
 * The fixture lives in DEDICATED orgs (`qa-solo-*`) and is removed in `after`,
 * dependent rows first: `tsx --test` runs test files concurrently and other
 * suites re-derive counts from the pilot org, so shared-org writes would flake.
 *
 * The suite is gated twice: on database reachability, and on the solo migration
 * being applied. On a bare checkout (CI has no DATABASE_URL) both gates fail and
 * the file reports a diagnostic instead of a red suite — the dependency-free
 * guards in `src/solo-core.test.js` / `src/solo-shell.test.js` still run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.ALLOW_INSECURE_AUTH_SECRET = '1';
// The pilot has no SMS sender: opt into the dev echo so the OTP flow is
// exercisable end to end. Set BEFORE the app import, which reads env once.
process.env.SOLO_OTP_RETURN_CODE = '1';

const { buildServer } = await import('../src/app.js');
const { prisma } = await import('../src/db.js');
const { env } = await import('../src/env.js');
const { hashPassword } = await import('../src/auth/password.js');
const { signToken } = await import('../src/auth/tokens.js');
const { removeDocumentFile } = await import('../src/documents.js');
const { CUSTOMER_PERMISSIONS, CUSTOMER_ROLE } = await import('../../../customer/lib/customer-core.js');
const { SOLO_PERMISSIONS, SOLO_ROLE } = await import('../../../solo/lib/solo-core.js');

const SHIPPER_ORG = 'qa-solo-shipper-org';
const CUSTOMER_ID = 'qa-solo-customer';
const BUYER_ID = 'qa-solo-buyer';
const SOLO_EMAIL = 'qa-solo-driver@roadwisefleet.test';
const admin = hashPassword('qa-solo-password');
const POD_BYTES = Buffer.from('fake-pod-image-bytes');

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

async function hasSoloSchema(): Promise<boolean> {
  try {
    const tables = (await prisma.$queryRawUnsafe(
      `SELECT table_name FROM information_schema.tables
        WHERE table_name IN ('SoloDriverProfile', 'SoloVerificationDoc', 'SoloSavedSearch', 'LoadPosting', 'MarketplaceOffer')`,
    )) as Array<unknown>;
    return tables.length === 5;
  } catch {
    return false;
  }
}

const reachable = await probeDb();
const ready = reachable ? await hasSoloSchema() : false;

const tokenFor = (sub: string, org: string | null, role: string, name: string) =>
  signToken({ sub, org, role, name }, env.AUTH_SECRET, { ttlSeconds: 3600 });

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** State the fixture created at runtime (the solo signup mints org/user ids). */
let soloOrgId = '';
let soloUserId = '';
let soloToken = '';
let loadId = '';
let orderId = '';
let awardedTripId = '';
let quickJobTripId = '';
let quickJobOrderId = '';
const uploadedKeys: string[] = [];

/** Remove every dependent row of the fixture, then the fixture itself. */
async function cleanup(): Promise<void> {
  const orgs = [SHIPPER_ORG, soloOrgId].filter(Boolean);
  const loads = await prisma.loadPosting.findMany({
    where: { OR: [{ orgId: { in: orgs } }, { customerId: CUSTOMER_ID }] },
    select: { id: true },
  });
  const loadIds = loads.map((l) => l.id);
  if (loadIds.length > 0) await prisma.marketplaceOffer.deleteMany({ where: { loadId: { in: loadIds } } });
  if (orgs.length > 0) await prisma.marketplaceOffer.deleteMany({ where: { carrierOrgId: { in: orgs } } });
  await prisma.loadPosting.deleteMany({ where: { id: { in: loadIds } } });
  if (orgs.length > 0) await prisma.capacityBeacon.deleteMany({ where: { orgId: { in: orgs } } });

  const trips = await prisma.trip.findMany({ where: { orgId: { in: orgs } }, select: { id: true } });
  const tripIds = trips.map((t) => t.id);
  if (tripIds.length > 0) {
    const docs = await prisma.document.findMany({ where: { tripId: { in: tripIds } }, select: { storageKey: true } });
    for (const doc of docs) await removeDocumentFile(env.UPLOAD_DIR, doc.storageKey);
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
  const orders = await prisma.order.findMany({ where: { customerId: { in: [CUSTOMER_ID, ...(soloOrgId ? [] : [])] } }, select: { id: true } });
  await prisma.orderBooking.deleteMany({ where: { orderId: { in: orders.map((o) => o.id) } } });
  await prisma.order.deleteMany({ where: { id: { in: orders.map((o) => o.id) } } });

  if (soloUserId) {
    const soloDocs = await prisma.soloVerificationDoc.findMany({ where: { driverId: soloUserId }, select: { storageKey: true } });
    for (const doc of soloDocs) await removeDocumentFile(env.UPLOAD_DIR, doc.storageKey);
    await prisma.soloVerificationDoc.deleteMany({ where: { driverId: soloUserId } });
    await prisma.soloSavedSearch.deleteMany({ where: { driverId: soloUserId } });
    await prisma.soloDriverProfile.deleteMany({ where: { userId: soloUserId } });
  }
  // The driver's own customers are Customer rows in his org with no account.
  if (soloOrgId) {
    const ownCustomers = await prisma.customer.findMany({ where: { orgId: soloOrgId }, select: { id: true } });
    const ownIds = ownCustomers.map((c) => c.id);
    const ownOrders = await prisma.order.findMany({ where: { customerId: { in: ownIds } }, select: { id: true } });
    await prisma.orderBooking.deleteMany({ where: { orderId: { in: ownOrders.map((o) => o.id) } } });
    await prisma.order.deleteMany({ where: { id: { in: ownOrders.map((o) => o.id) } } });
    await prisma.customerAccount.deleteMany({ where: { customerId: { in: ownIds } } });
    await prisma.customerProfile.deleteMany({ where: { customerId: { in: ownIds } } });
    await prisma.customerAddress.deleteMany({ where: { customerId: { in: ownIds } } });
    await prisma.customer.deleteMany({ where: { id: { in: ownIds } } });
  }
  await prisma.customerAccount.deleteMany({ where: { customerId: CUSTOMER_ID } });
  await prisma.customerProfile.deleteMany({ where: { customerId: CUSTOMER_ID } });
  await prisma.customerAddress.deleteMany({ where: { customerId: CUSTOMER_ID } });
  await prisma.customer.deleteMany({ where: { id: CUSTOMER_ID } });
  await prisma.user.deleteMany({ where: { id: { in: [BUYER_ID, ...(soloUserId ? [soloUserId] : [])] } } });
  if (orgs.length > 0) await prisma.org.deleteMany({ where: { id: { in: orgs } } });
  // Role rows belong to the deploy path; restore them if a failing test removed any.
  await prisma.role.upsert({
    where: { id: CUSTOMER_ROLE },
    update: {},
    create: { id: CUSTOMER_ROLE, permissions: [...CUSTOMER_PERMISSIONS] },
  });
  await prisma.role.upsert({
    where: { id: SOLO_ROLE },
    update: {},
    create: { id: SOLO_ROLE, permissions: [...SOLO_PERMISSIONS] },
  });
}

async function seedFixture(): Promise<void> {
  await cleanup();
  await prisma.org.create({ data: { id: SHIPPER_ORG, name: 'QA Solo Shipper', locale: 'en', dataRegion: 'eu' } });
  await prisma.customer.create({
    data: { id: CUSTOMER_ID, orgId: SHIPPER_ORG, name: 'QA Solo Shipper GmbH', email: 'qa-solo-customer@roadwisefleet.test', lang: 'en' },
  });
  await prisma.user.create({
    data: { id: BUYER_ID, orgId: null, roleId: CUSTOMER_ROLE, name: 'QA Solo Buyer', email: 'qa-solo-buyer@roadwisefleet.test', passwordHash: admin, lang: 'en' },
  });
  await prisma.customerAccount.create({ data: { userId: BUYER_ID, customerId: CUSTOMER_ID } });
  const order = await prisma.order.create({
    data: {
      customerId: CUSTOMER_ID,
      origin: 'Berlin, DE',
      destination: 'Warsaw, PL',
      cargo: 'Palletised goods',
      status: 'BOOKED',
      plannedAt: new Date('2026-10-03T08:00:00.000Z'),
      booking: { create: { supplyChoice: 'solo', equipment: 'curtainsider' } },
    },
  });
  orderId = order.id;
}

if (!ready) {
  test('solo driver end-to-end (skipped)', (t) => {
    t.diagnostic(
      reachable
        ? 'migration 20260930120000_add_solo_driver is not applied — run `prisma migrate deploy` to enable this suite'
        : 'database unreachable — set DATABASE_URL to enable this suite',
    );
    assert.ok(true);
  });
} else {
  await seedFixture();
  test.after(cleanup);

  const shipper = tokenFor(BUYER_ID, null, CUSTOMER_ROLE, 'QA Solo Buyer');

  test('the shipper posts a load from its order for the solo driver to find', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/marketplace/loads',
      headers: bearer(shipper),
      payload: { orderId, loadReadyAt: '2026-10-02T08:00:00.000Z', deliverByAt: '2026-10-03T08:00:00.000Z' },
    });
    assert.equal(res.statusCode, 201, res.payload);
    loadId = res.json().load.id;
    const row = await prisma.loadPosting.findUnique({ where: { id: loadId } });
    assert.equal(row?.equipment, 'curtainsider', 'the equipment comes from the booking');
  });

  test('signup creates the one-person carrier org, the solo role and the profile', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/solo/signup',
      payload: {
        name: 'Piotr Kowalski',
        email: SOLO_EMAIL,
        password: 'longenough1',
        phone: '+48 600 100 200',
        truckPlate: 'WX 1234A',
        truckEquipment: 'curtainsider',
        truckCapacityKg: 24000,
      },
    });
    assert.equal(res.statusCode, 201, res.payload);
    const body = res.json();
    soloToken = body.token;
    soloUserId = body.user.id;
    soloOrgId = body.user.orgId;
    assert.ok(soloOrgId, 'the driver owns a carrier org');
    assert.equal(body.user.roleId, SOLO_ROLE);
    assert.equal(body.driver.verificationStatus, 'NONE');

    const profile = await prisma.soloDriverProfile.findUnique({ where: { userId: soloUserId } });
    assert.equal(profile?.orgId, soloOrgId);
    assert.equal(profile?.truckPlate, 'WX 1234A');
    const role = await prisma.role.findUnique({ where: { id: SOLO_ROLE } });
    assert.ok(role, 'the solo role exists (signup re-asserts the deploy-path row)');
  });

  test('a duplicate signup email is refused with 409', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/solo/signup',
      payload: { name: 'Someone Else', email: SOLO_EMAIL, password: 'longenough1', phone: '+48 600 100 201' },
    });
    assert.equal(res.statusCode, 409, res.payload);
    assert.equal(res.json().error, 'email_taken');
  });

  test('an UNVERIFIED driver may browse AND bid — verification is optional (owner #73 q5)', async () => {
    const feed = await app.inject({ method: 'GET', url: '/api/marketplace/loads', headers: bearer(soloToken) });
    assert.equal(feed.statusCode, 200, feed.payload);
    assert.ok((feed.json().loads as Array<{ id: string }>).some((l) => l.id === loadId), 'the load is visible');

    // No `verification_required` refusal on the offer path any more.
    const bid = await app.inject({
      method: 'POST',
      url: `/api/marketplace/loads/${loadId}/offers`,
      headers: bearer(soloToken),
      payload: { priceEur: 1400 },
    });
    assert.equal(bid.statusCode, 201, bid.payload);
    assert.equal(Number(bid.json().offer.priceEur), 1400, 'the offer carries the typed price (Decimal → string)');
    assert.equal(bid.json().offer.carrierVerified, false, 'the compare facet stays truthful: not verified');
    assert.equal(await prisma.marketplaceOffer.count({ where: { loadId, carrierUserId: soloUserId } }), 1, 'the offer is written');

    // The profile shows no check marks yet: no paper is supplied.
    const me = await app.inject({ method: 'GET', url: '/api/solo/me', headers: bearer(soloToken) });
    assert.equal(me.statusCode, 200, me.payload);
    const badges = (me.json().driver.verification.badges as Array<{ supplied: boolean; verified: boolean }>) || [];
    assert.equal(badges.length, 3, 'the three check-mark papers');
    for (const badge of badges) {
      assert.equal(badge.supplied, false, 'nothing supplied yet');
      assert.equal(badge.verified, false, 'no fake verified badge');
    }
  });

  test('the phone OTP completes and a wrong code is refused', async () => {
    const start = await app.inject({ method: 'POST', url: '/api/solo/otp', headers: bearer(soloToken), payload: { phone: '+48 600 100 200' } });
    assert.equal(start.statusCode, 200, start.payload);
    assert.match(start.json().to, /^••/, 'the response masks the number');
    const devCode = start.json().devCode as string;
    assert.match(devCode, /^\d{6}$/, 'the dev echo is only on because SOLO_OTP_RETURN_CODE is set');

    const wrong = await app.inject({ method: 'POST', url: '/api/solo/otp/verify', headers: bearer(soloToken), payload: { code: devCode === '000000' ? '111111' : '000000' } });
    assert.equal(wrong.statusCode, 400, wrong.payload);
    assert.equal(wrong.json().error, 'otp_invalid');

    const ok = await app.inject({ method: 'POST', url: '/api/solo/otp/verify', headers: bearer(soloToken), payload: { code: devCode } });
    assert.equal(ok.statusCode, 200, ok.payload);
    const profile = await prisma.soloDriverProfile.findUnique({ where: { userId: soloUserId } });
    assert.ok(profile?.phoneVerifiedAt, 'the phone is verified');
    assert.equal(profile?.otpHash, null, 'the code hash is cleared after use');
  });

  test('uploading all four papers moves the profile to PENDING and the trust marks stay truthful', async () => {
    for (const docType of ['id', 'licence', 'vehicle_registration', 'insurance']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/solo/verification',
        headers: bearer(soloToken),
        payload: { docType, filename: docType + '.jpg', mimeType: 'image/jpeg', dataBase64: POD_BYTES.toString('base64') },
      });
      assert.equal(res.statusCode, 201, res.payload);
      uploadedKeys.push(res.json().document.id);
    }
    const state = await app.inject({ method: 'GET', url: '/api/solo/verification', headers: bearer(soloToken) });
    assert.equal(state.statusCode, 200, state.payload);
    assert.equal(state.json().verification.complete, true);
    assert.equal(state.json().verification.status, 'PENDING');
    assert.equal(state.json().bidGate.allowed, true, 'verification is optional, so bidding stays open');
    const badges = state.json().verification.badges as Array<{ docType: string; supplied: boolean; mark: string; verified: boolean }>;
    assert.deepEqual(badges.map((b) => b.docType), ['id', 'licence', 'vehicle_registration']);
    for (const badge of badges) {
      assert.equal(badge.supplied, true, `${badge.docType} is supplied`);
      assert.equal(badge.mark, 'pending', `${badge.docType} is in review — not faked as verified`);
      assert.equal(badge.verified, false);
    }

    // A non-document is refused (fail-fast, one field).
    const bad = await app.inject({
      method: 'POST',
      url: '/api/solo/verification',
      headers: bearer(soloToken),
      payload: { docType: 'passport', filename: 'x.jpg', mimeType: 'image/jpeg', dataBase64: 'AAAA' },
    });
    assert.equal(bad.statusCode, 400, bad.payload);
    assert.equal(bad.json().field, 'docType');
  });

  test('once VERIFIED the driver bids; the award creates the Trip in his org with him assigned', async () => {
    // The operator/owner approves the papers (no self-service verify endpoint on
    // purpose: a driver can never approve himself). A real review marks the
    // profile AND each paper, so the check marks become `verified`.
    await prisma.soloDriverProfile.update({ where: { userId: soloUserId }, data: { verificationStatus: 'VERIFIED' } });
    await prisma.soloVerificationDoc.updateMany({ where: { driverId: soloUserId }, data: { status: 'VERIFIED' } });
    const approved = await app.inject({ method: 'GET', url: '/api/solo/verification', headers: bearer(soloToken) });
    for (const badge of approved.json().verification.badges as Array<{ docType: string; mark: string; verified: boolean }>) {
      assert.equal(badge.mark, 'verified', `${badge.docType} shows a verified check mark`);
      assert.equal(badge.verified, true);
    }

    const bid = await app.inject({
      method: 'POST',
      url: `/api/marketplace/loads/${loadId}/offers`,
      headers: bearer(soloToken),
      payload: { priceEur: 1450, pickupEtaAt: '2026-10-02T08:00:00.000Z', deliveryEtaAt: '2026-10-03T06:00:00.000Z', note: 'Curtainsider, ready.' },
    });
    assert.equal(bid.statusCode, 201, bid.payload);
    assert.equal(bid.json().offer.carrierUserId, soloUserId, 'the one-person org names the driver on the offer');

    const award = await app.inject({
      method: 'POST',
      url: `/api/marketplace/loads/${loadId}/award`,
      headers: bearer(shipper),
      payload: { offerId: bid.json().offer.id, paymentMethod: 'invoice' },
    });
    assert.equal(award.statusCode, 201, award.payload);
    awardedTripId = award.json().trip.id;
    assert.equal(award.json().trip.orgId, soloOrgId, 'the trip lands in the solo org');
    const trip = await prisma.trip.findUnique({ where: { id: awardedTripId } });
    assert.equal(trip?.driverId, soloUserId, 'the solo driver is the trip driver');
  });

  test('the driver executes the statuses, uploads a POD and the wallet shows payment', async () => {
    for (const status of ['ASSIGNED', 'LOADED', 'IN_TRANSIT', 'DELIVERED']) {
      const res = await app.inject({ method: 'POST', url: `/api/trips/${awardedTripId}/status`, headers: bearer(soloToken), payload: { status } });
      assert.equal(res.statusCode, 200, `${status}: ${res.payload}`);
    }
    const delivered = await prisma.trip.findUnique({ where: { id: awardedTripId } });
    assert.ok(delivered?.deliveredAt, 'the delivery time is recorded');

    // POD_UPLOADED is gated on a real POD document.
    const tooEarly = await app.inject({ method: 'POST', url: `/api/trips/${awardedTripId}/status`, headers: bearer(soloToken), payload: { status: 'POD_UPLOADED' } });
    assert.equal(tooEarly.statusCode, 400, tooEarly.payload);
    assert.equal(tooEarly.json().error, 'pod_required');

    const pod = await app.inject({
      method: 'POST',
      url: `/api/trips/${awardedTripId}/documents`,
      headers: bearer(soloToken),
      payload: { docType: 'pod', filename: 'pod.jpg', mimeType: 'image/jpeg', dataBase64: POD_BYTES.toString('base64') },
    });
    assert.equal(pod.statusCode, 201, pod.payload);

    const done = await app.inject({ method: 'POST', url: `/api/trips/${awardedTripId}/status`, headers: bearer(soloToken), payload: { status: 'POD_UPLOADED' } });
    assert.equal(done.statusCode, 200, done.payload);

    // Payment status: a manual settlement (free phase), then the wallet-lite read.
    await prisma.settlement.create({ data: { tripId: awardedTripId, amountEur: 1450, status: 'PAID' } });
    const jobs = await app.inject({ method: 'GET', url: '/api/solo/jobs', headers: bearer(soloToken) });
    assert.equal(jobs.statusCode, 200, jobs.payload);
    const row = (jobs.json().jobs as Array<{ id: string; status: string; settlement: { status: string } | null }>).find((j) => j.id === awardedTripId);
    assert.equal(row?.status, 'POD_UPLOADED');
    assert.equal(row?.settlement?.status, 'PAID');
    assert.equal(jobs.json().wallet.paidEur, 1450);
    assert.equal(jobs.json().wallet.outstandingEur, 0);
  });

  test('an own-customer quick job creates the work and mints a WORKING public tracking link', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/solo/jobs',
      headers: bearer(soloToken),
      payload: { customerName: 'Bäcker Schmidt', origin: 'Berlin, DE', destination: 'Dresden, DE', cargo: 'Flour', rateEur: 480 },
    });
    assert.equal(res.statusCode, 201, res.payload);
    quickJobTripId = res.json().tripId;
    quickJobOrderId = res.json().orderId;
    assert.equal(res.json().job.status, 'ASSIGNED');

    const customer = await prisma.customer.findFirst({ where: { orgId: soloOrgId, name: 'Bäcker Schmidt' } });
    assert.ok(customer, 'the own customer exists in the driver org');
    assert.equal(await prisma.customerAccount.count({ where: { customerId: customer!.id } }), 0, 'the own customer needs NO shipper account');
    const trip = await prisma.trip.findUnique({ where: { id: quickJobTripId } });
    assert.equal(trip?.driverId, soloUserId);

    const link = await app.inject({ method: 'POST', url: `/api/trips/${quickJobTripId}/track-link`, headers: bearer(soloToken) });
    assert.equal(link.statusCode, 201, link.payload);
    const token = link.json().link.token as string;
    assert.ok(token && token.length > 0);

    // The link works with NO account at all: the public tracking read, which
    // returns the PII-free read model (no trip id, no driver) by design.
    const publicRead = await app.inject({ method: 'GET', url: `/api/track/${token}` });
    assert.equal(publicRead.statusCode, 200, publicRead.payload);
    assert.equal(publicRead.json().tracking.route.destination, 'Dresden, DE');
    assert.equal(publicRead.json().tracking.status, 'ASSIGNED');
    assert.match(publicRead.headers['x-robots-tag'] as string, /noindex/);
  });

  test('the beacon and the saved searches are org/driver scoped', async () => {
    const published = await app.inject({
      method: 'POST',
      url: '/api/marketplace/beacons',
      headers: bearer(soloToken),
      payload: { location: 'Berlin, DE', heading: 'Dresden', equipment: 'curtainsider', minRateEur: 400 },
    });
    assert.equal(published.statusCode, 201, published.payload);
    const beaconId = published.json().beacon.id;
    const listed = await app.inject({ method: 'GET', url: '/api/marketplace/beacons?equipment=curtainsider', headers: bearer(soloToken) });
    assert.ok((listed.json().beacons as Array<{ id: string }>).some((b) => b.id === beaconId));

    const saved = await app.inject({ method: 'POST', url: '/api/solo/searches', headers: bearer(soloToken), payload: { name: 'Berlin → PL', origin: 'Berlin', destination: 'Warsaw' } });
    assert.equal(saved.statusCode, 201, saved.payload);
    const list = await app.inject({ method: 'GET', url: '/api/solo/searches', headers: bearer(soloToken) });
    assert.equal((list.json().searches as unknown[]).length, 1);

    const foreign = await app.inject({ method: 'DELETE', url: '/api/solo/searches/does-not-exist', headers: bearer(soloToken) });
    assert.equal(foreign.statusCode, 404, 'a foreign/unknown saved search is a flat 404');

    const removed = await app.inject({ method: 'DELETE', url: `/api/solo/searches/${saved.json().search.id}`, headers: bearer(soloToken) });
    assert.equal(removed.statusCode, 200, removed.payload);
    const after = await app.inject({ method: 'GET', url: '/api/solo/searches', headers: bearer(soloToken) });
    assert.equal((after.json().searches as unknown[]).length, 0);
  });

  test('a non-solo token cannot use the solo API', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/solo/me', headers: bearer(shipper) });
    assert.equal(res.statusCode, 403, res.payload);
    assert.equal(res.json().error, 'not_a_solo_driver');
  });

  test('no response ever leaks a credential field', async () => {
    const me = await app.inject({ method: 'GET', url: '/api/solo/me', headers: bearer(soloToken) });
    assert.equal(me.statusCode, 200, me.payload);
    const raw = JSON.stringify(me.json());
    for (const field of ['passwordHash', 'otpHash', 'totpSecret']) {
      assert.equal(raw.includes(field), false, `${field} must never travel`);
    }
  });

  test('the fixture leaves no residue behind', async () => {
    const loads = await prisma.loadPosting.count({ where: { customerId: CUSTOMER_ID } });
    assert.ok(loads >= 1, 'the fixture load exists while the suite runs');
    assert.equal(uploadedKeys.length, 4, 'four verification papers were uploaded');
  });
}
