/**
 * Connect marketplace core (board task #76, UXF-M1) — dependency-free unit
 * tests for `marketplace.js`, run by the no-install CI job:
 *
 *   node --test apps/api/src/
 *
 * They cover the two state machines (load + offer), expiry, the validators, the
 * matching rules, the award plan and the tenancy predicates — the rules the HTTP
 * end-to-end suite (`apps/api/test/marketplace.test.ts`) exercises against a
 * real database. Nothing here imports npm packages, `fastify` or
 * `@prisma/client`, so it runs on a bare checkout.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EQUIPMENT } from '../../../customer/lib/customer-core.js';
import * as market from './marketplace.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

const NOW = new Date('2026-09-30T12:00:00.000Z');
const past = (h) => new Date(NOW.getTime() - h * 3600 * 1000);
const future = (h) => new Date(NOW.getTime() + h * 3600 * 1000);

/* ------------------------------------------------------------ state: load --- */

test('load state machine: posted → offers → awarded, and the exits', () => {
  assert.deepEqual([...market.LOAD_STATUSES].sort(), ['AWARDED', 'CANCELLED', 'EXPIRED', 'OFFERS', 'POSTED']);
  assert.equal(market.canTransitionLoad('POSTED', 'OFFERS'), true);
  assert.equal(market.canTransitionLoad('POSTED', 'AWARDED'), true);
  assert.equal(market.canTransitionLoad('OFFERS', 'AWARDED'), true);
  assert.equal(market.canTransitionLoad('OFFERS', 'EXPIRED'), true);
  assert.equal(market.canTransitionLoad('AWARDED', 'OFFERS'), false, 'an awarded load is terminal');
  assert.equal(market.canTransitionLoad('EXPIRED', 'POSTED'), false);
  assert.equal(market.canTransitionLoad('NOPE', 'POSTED'), false);
});

test('load open/terminal predicates', () => {
  assert.equal(market.isLoadOpen('POSTED'), true);
  assert.equal(market.isLoadOpen('OFFERS'), true);
  assert.equal(market.isLoadOpen('AWARDED'), false);
  assert.equal(market.isLoadTerminal('AWARDED'), true);
  assert.equal(market.isLoadTerminal('EXPIRED'), true);
  assert.equal(market.isLoadTerminal('CANCELLED'), true);
  assert.equal(market.isLoadTerminal('POSTED'), false);
});

/* ----------------------------------------------------------- state: offer --- */

test('offer state machine matches diagram 05 exactly', () => {
  assert.deepEqual(
    [...market.OFFER_STATUSES].sort(),
    ['ACCEPTED', 'COUNTERED', 'DECLINED', 'EXPIRED', 'SENT', 'VIEWED', 'WITHDRAWN'],
  );
  for (const to of ['VIEWED', 'COUNTERED', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'WITHDRAWN']) {
    assert.equal(market.canTransitionOffer('SENT', to), true, `SENT → ${to}`);
  }
  assert.equal(market.canTransitionOffer('VIEWED', 'COUNTERED'), true);
  assert.equal(market.canTransitionOffer('VIEWED', 'WITHDRAWN'), true);
  // Decided offers are terminal: a counter/accept/decline cannot be re-decided.
  for (const from of ['COUNTERED', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'WITHDRAWN']) {
    assert.equal(market.canTransitionOffer(from, 'ACCEPTED'), false, `${from} → ACCEPTED`);
  }
  assert.equal(market.isOfferOpen('SENT'), true);
  assert.equal(market.isOfferOpen('VIEWED'), true);
  assert.equal(market.isOfferOpen('COUNTERED'), false);
});

/* ---------------------------------------------------------------- expiry --- */

test('isExpired: past is expired, future and absent are not', () => {
  assert.equal(market.isExpired(past(1), NOW), true);
  assert.equal(market.isExpired(future(1), NOW), false);
  assert.equal(market.isExpired(null, NOW), false, 'no expiry never expires');
  assert.equal(market.isExpired('not-a-date', NOW), false);
  assert.equal(market.isExpired(future(1), 'not-a-date'), false);
});

test('expiredOfferIds only picks open, past rows', () => {
  const offers = [
    { id: 'a', status: 'SENT', expiresAt: past(1) },
    { id: 'b', status: 'SENT', expiresAt: future(1) },
    { id: 'c', status: 'ACCEPTED', expiresAt: past(1) },
    { id: 'd', status: 'VIEWED', expiresAt: null },
    { id: 'e', status: 'VIEWED', expiresAt: past(2) },
  ];
  assert.deepEqual(market.expiredOfferIds(offers, NOW), ['a', 'e']);
});

test('expiredLoadIds only picks open, past rows', () => {
  const loads = [
    { id: 'l1', status: 'POSTED', expiresAt: past(1) },
    { id: 'l2', status: 'OFFERS', expiresAt: past(1) },
    { id: 'l3', status: 'CANCELLED', expiresAt: past(1) },
  ];
  assert.deepEqual(market.expiredLoadIds(loads, NOW), ['l1', 'l2']);
});

/* -------------------------------------------------------- load validation --- */

test('normalizeLoadPosting: a minimal lane is valid', () => {
  const res = market.normalizeLoadPosting({ origin: 'Berlin, DE', destination: 'Hamburg, DE' });
  assert.equal(res.ok, true);
  assert.equal(res.value.origin, 'Berlin, DE');
  assert.equal(res.value.pricingMode, 'quotes');
  assert.equal(res.value.priceEur, null);
  assert.equal(res.value.equipment, null);
});

test('normalizeLoadPosting: fail-fast field errors (exactly one)', () => {
  assert.equal(market.normalizeLoadPosting({}).field, 'origin');
  assert.equal(market.normalizeLoadPosting({ origin: 'A' }).field, 'destination');
  assert.equal(
    market.normalizeLoadPosting({ origin: 'A', destination: 'A' }).field,
    'destination',
    'same route is refused',
  );
  assert.equal(
    market.normalizeLoadPosting({ origin: 'A', destination: 'B', equipment: 'hovercraft' }).field,
    'equipment',
  );
  assert.equal(
    market.normalizeLoadPosting({ origin: 'A', destination: 'B', pricingMode: 'escrow' }).field,
    'pricingMode',
  );
});

test('normalizeLoadPosting: an instant-rate load needs a positive price', () => {
  const missing = market.normalizeLoadPosting({ origin: 'A', destination: 'B', pricingMode: 'instant' });
  assert.equal(missing.field, 'priceEur');
  const zero = market.normalizeLoadPosting({ origin: 'A', destination: 'B', pricingMode: 'instant', priceEur: 0 });
  assert.equal(zero.field, 'priceEur');
  const ok = market.normalizeLoadPosting({ origin: 'A', destination: 'B', pricingMode: 'instant', priceEur: 900 });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.priceEur, 900);
});

test('normalizeLoadPosting: the delivery window may not invert', () => {
  const res = market.normalizeLoadPosting({
    origin: 'A',
    destination: 'B',
    loadReadyAt: '2026-10-02T08:00:00.000Z',
    deliverByAt: '2026-10-01T08:00:00.000Z',
  });
  assert.equal(res.field, 'deliverByAt');
  const bad = market.normalizeLoadPosting({ origin: 'A', destination: 'B', loadReadyAt: 'tomorrow-ish' });
  assert.equal(bad.field, 'loadReadyAt');
});

test('the equipment vocabulary is the book-a-load wizard vocabulary, not a copy', () => {
  assert.deepEqual([...market.EQUIPMENT_OPTIONS], [...EQUIPMENT]);
  const res = market.normalizeLoadPosting({ origin: 'A', destination: 'B', equipment: EQUIPMENT[0] });
  assert.equal(res.ok, true);
  assert.equal(res.value.equipment, EQUIPMENT[0]);
});

/* ------------------------------------------------------ beacon validation --- */

test('normalizeBeacon: location required, equipment from the shared list', () => {
  assert.equal(market.normalizeBeacon({}).field, 'location');
  assert.equal(market.normalizeBeacon({ location: 'Gdansk, PL', equipment: 'rocket' }).field, 'equipment');
  const res = market.normalizeBeacon({ location: 'Gdansk, PL', equipment: 'curtainsider', minRateEur: 0.9 });
  assert.equal(res.ok, true);
  assert.equal(res.value.minRateEur, 0.9);
  assert.equal(res.value.availableFrom, null);
});

/* ------------------------------------------------------- offer validation --- */

test('normalizeOffer: a carrier offer needs a price > 0', () => {
  assert.equal(market.normalizeOffer({}).field, 'priceEur');
  assert.equal(market.normalizeOffer({ priceEur: 0 }).field, 'priceEur');
  assert.equal(market.normalizeOffer({ priceEur: -5 }).field, 'priceEur');
  const ok = market.normalizeOffer({ priceEur: '1250,50', pickupEtaAt: '2026-10-01T06:00:00.000Z' });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.priceEur, 1250.5, 'a comma decimal is accepted');
});

test('normalizeOffer: a counter may omit the price (terms carried from the parent)', () => {
  const res = market.normalizeOffer({ note: 'Can do it for 1100' }, { requirePrice: false });
  assert.equal(res.ok, true);
  assert.equal(res.value.priceEur, null);
  assert.equal(res.value.note, 'Can do it for 1100');
});

test('normalizeOffer: delivery ETA may not precede pickup ETA', () => {
  const res = market.normalizeOffer({
    priceEur: 800,
    pickupEtaAt: '2026-10-02T08:00:00.000Z',
    deliveryEtaAt: '2026-10-01T08:00:00.000Z',
  });
  assert.equal(res.field, 'deliveryEtaAt');
});

/* ------------------------------------------------------------- award rules --- */

test('normalizeAward: invoice is accepted, escrow is refused with the UXF-OWN1 reason', () => {
  assert.equal(market.normalizeAward({}).value.paymentMethod, 'invoice');
  const escrow = market.normalizeAward({ paymentMethod: 'escrow' });
  assert.equal(escrow.ok, false);
  assert.equal(escrow.field, 'paymentMethod');
  assert.equal(escrow.detail, 'escrow_deferred_uxf_own1');
  assert.equal(market.normalizeAward({ paymentMethod: 'bitcoin' }).field, 'paymentMethod');
});

const baseLoad = (over = {}) => ({
  id: 'load-1',
  orderId: 'order-1',
  status: 'OFFERS',
  expiresAt: future(48),
  ...over,
});

const baseOffer = (over = {}) => ({
  id: 'offer-1',
  loadId: 'load-1',
  side: 'carrier',
  status: 'SENT',
  expiresAt: future(12),
  carrierOrgId: 'org-carrier',
  priceEur: 1000,
  ...over,
});

test('awardPlan: the winner is accepted, every other open offer is declined', () => {
  const offers = [baseOffer({ id: 'o1' }), baseOffer({ id: 'o2', carrierOrgId: 'org-2' }), baseOffer({ id: 'o3', status: 'DECLINED' })];
  const plan = market.awardPlan({ load: baseLoad(), offers, offerId: 'o1', now: NOW });
  assert.equal(plan.ok, true);
  assert.equal(plan.winnerId, 'o1');
  assert.deepEqual(plan.declinedIds.sort(), ['o2'], 'only the open sibling is declined');
});

test('awardPlan: only an open load can be awarded', () => {
  assert.equal(market.awardPlan({ load: baseLoad({ status: 'AWARDED' }), offers: [], offerId: 'o1', now: NOW }).error, 'load_awarded');
  assert.equal(market.awardPlan({ load: baseLoad({ status: 'CANCELLED' }), offers: [], offerId: 'o1', now: NOW }).error, 'load_closed');
  assert.equal(
    market.awardPlan({ load: baseLoad({ expiresAt: past(1) }), offers: [baseOffer()], offerId: 'o1', now: NOW }).error,
    'load_expired',
  );
});

test('awardPlan: the load must carry an order (nobody re-enters the load)', () => {
  const plan = market.awardPlan({ load: baseLoad({ orderId: null }), offers: [baseOffer()], offerId: 'o1', now: NOW });
  assert.equal(plan.error, 'order_required');
});

test('awardPlan: an unknown, closed or expired offer cannot win', () => {
  assert.equal(market.awardPlan({ load: baseLoad(), offers: [baseOffer()], offerId: 'nope', now: NOW }).error, 'offer_not_found');
  assert.equal(
    market.awardPlan({ load: baseLoad(), offers: [baseOffer({ status: 'DECLINED' })], offerId: 'offer-1', now: NOW }).error,
    'offer_closed',
  );
  assert.equal(
    market.awardPlan({ load: baseLoad(), offers: [baseOffer({ expiresAt: past(1) })], offerId: 'offer-1', now: NOW }).error,
    'offer_expired',
  );
  assert.equal(
    market.awardPlan({ load: baseLoad(), offers: [baseOffer({ status: 'EXPIRED' })], offerId: 'offer-1', now: NOW }).error,
    'offer_expired',
  );
});

test('buildAwardTripData: the trip lands in the carrier org, against the load order', () => {
  const load = baseLoad();
  const offer = baseOffer({ carrierUserId: 'driver-9', priceEur: 1250 });
  const trip = market.buildAwardTripData({ load, offer });
  assert.equal(trip.orgId, 'org-carrier');
  assert.equal(trip.orderId, 'order-1', 'the same demand object — no re-entry');
  assert.equal(trip.driverId, 'driver-9');
  assert.equal(trip.truckId, null);
  assert.equal(trip.rateEur, 1250);
  assert.equal(trip.status, 'DRAFT');
});

/* --------------------------------------------------------------- matching --- */

test('laneMatches is a case-insensitive substring both ways', () => {
  const load = { origin: 'Berlin, DE', destination: 'Hamburg, DE' };
  assert.equal(market.laneMatches(load, {}), true);
  assert.equal(market.laneMatches(load, { origin: 'berlin' }), true);
  assert.equal(market.laneMatches(load, { destination: 'HAMBURG' }), true);
  assert.equal(market.laneMatches(load, { origin: 'Munich' }), false);
});

test('dateFits: an absent ready time is date-agnostic; bounds are inclusive', () => {
  assert.equal(market.dateFits({ loadReadyAt: null }, { readyFrom: '2026-10-01T00:00:00Z' }), true);
  const load = { loadReadyAt: '2026-10-02T08:00:00.000Z' };
  assert.equal(market.dateFits(load, { readyFrom: '2026-10-01T00:00:00Z' }), true);
  assert.equal(market.dateFits(load, { readyTo: '2026-10-01T00:00:00Z' }), false);
  assert.equal(market.dateFits(load, { readyFrom: '2026-10-02T08:00:00Z' }), true);
});

test('equipmentFits: empty wanted equipment fits anything', () => {
  assert.equal(market.equipmentFits({ equipment: 'reefer' }, ''), true);
  assert.equal(market.equipmentFits({ equipment: 'reefer' }, 'reefer'), true);
  assert.equal(market.equipmentFits({ equipment: 'reefer' }, 'flatbed'), false);
});

test('filterLoads applies lane + date + equipment together', () => {
  const loads = [
    { id: 'a', origin: 'Berlin, DE', destination: 'Hamburg, DE', equipment: 'reefer', loadReadyAt: '2026-10-02T08:00:00Z' },
    { id: 'b', origin: 'Berlin, DE', destination: 'Warsaw, PL', equipment: 'reefer', loadReadyAt: '2026-10-02T08:00:00Z' },
    { id: 'c', origin: 'Berlin, DE', destination: 'Hamburg, DE', equipment: 'flatbed', loadReadyAt: '2026-10-02T08:00:00Z' },
  ];
  const filtered = market.filterLoads(loads, { origin: 'Berlin', destination: 'Hamburg', equipment: 'reefer' });
  assert.deepEqual(filtered.map((l) => l.id), ['a']);
});

test('parseMatchFilter drops a bogus equipment and keeps the known vocabulary', () => {
  assert.deepEqual(market.parseMatchFilter({ equipment: 'rocket' }), {});
  assert.deepEqual(market.parseMatchFilter({ origin: ' Berlin ', equipment: 'reefer', nope: 'x' }), {
    origin: 'Berlin',
    equipment: 'reefer',
  });
});

test('scorePairing / rankBeacons prefer lane, date and equipment fit', () => {
  const load = { origin: 'Berlin, DE', destination: 'Hamburg, DE', equipment: 'reefer', loadReadyAt: '2026-10-02T08:00:00Z' };
  const good = { id: 'b1', location: 'Berlin, DE', equipment: 'reefer', availableFrom: '2026-10-01T08:00:00Z' };
  const headingOnly = { id: 'b2', location: 'Gdansk, PL', heading: 'Hamburg', equipment: 'reefer', availableFrom: '2026-10-01T08:00:00Z' };
  const late = { id: 'b3', location: 'Gdansk, PL', equipment: 'flatbed', availableFrom: '2026-11-01T08:00:00Z' };
  const ranked = market.rankBeacons(load, [late, headingOnly, good]);
  assert.deepEqual(ranked.map((r) => r.beacon.id), ['b1', 'b2', 'b3']);
  assert.ok(ranked[0].score > ranked[1].score);
  assert.deepEqual(market.scorePairing(load, good).reasons, ['lane_origin', 'date_fit', 'equipment_fit']);
});

test('rankLoadsForBeacon is the same score seen from the supply side', () => {
  const beacon = { location: 'Berlin, DE', equipment: 'reefer', availableFrom: '2026-10-01T08:00:00Z' };
  const loads = [
    { id: 'far', origin: 'Madrid, ES', destination: 'Lisbon, PT', equipment: 'flatbed' },
    { id: 'near', origin: 'Berlin, DE', destination: 'Hamburg, DE', equipment: 'reefer', loadReadyAt: '2026-10-02T08:00:00Z' },
  ];
  const ranked = market.rankLoadsForBeacon(beacon, loads);
  assert.equal(ranked[0].load.id, 'near');
});

/* ------------------------------------------------------------- isolation --- */

const CUSTOMER_PERMISSIONS = ['order:create', 'order:read', 'customer:manage'];
const CARRIER_PERMISSIONS = ['trip:*', 'user:read', 'reports:read'];
const DRIVER_PERMISSIONS = ['trip:read', 'trip:status'];

test('capabilities: shipper vs carrier vs driver', () => {
  assert.equal(market.canPostLoad(CUSTOMER_PERMISSIONS), true);
  assert.equal(market.canPostLoad(CARRIER_PERMISSIONS), true, 'a fleet may post an uncovered load');
  assert.equal(market.canPostLoad(DRIVER_PERMISSIONS), false);
  assert.equal(market.canSupply(CARRIER_PERMISSIONS), true);
  assert.equal(market.canSupply(DRIVER_PERMISSIONS), false);
  assert.equal(market.canSupply(CUSTOMER_PERMISSIONS), false);
});

test('isLoadPoster matches the tenant that posted, and nobody else', () => {
  const customerLoad = { customerId: 'cust-1', orgId: null };
  const fleetLoad = { customerId: null, orgId: 'org-1' };
  assert.equal(market.isLoadPoster(customerLoad, { customerId: 'cust-1', orgId: null }), true);
  assert.equal(market.isLoadPoster(customerLoad, { customerId: 'cust-2', orgId: null }), false);
  assert.equal(market.isLoadPoster(fleetLoad, { customerId: null, orgId: 'org-1' }), true);
  assert.equal(market.isLoadPoster(fleetLoad, { customerId: null, orgId: 'org-2' }), false);
  assert.equal(market.isLoadPoster(customerLoad, {}), false, 'denies by default');
  assert.equal(market.isLoadPoster(null, { orgId: 'org-1' }), false);
});

test('canReadLoad: poster always, carrier while the load is open, nobody after award', () => {
  const load = { customerId: 'cust-1', orgId: null, status: 'POSTED' };
  assert.equal(market.canReadLoad({ load, principal: { customerId: 'cust-1' } }), true);
  assert.equal(market.canReadLoad({ load, principal: { orgId: 'org-1' }, permissions: CARRIER_PERMISSIONS }), true);
  assert.equal(market.canReadLoad({ load, principal: { orgId: 'org-1' }, permissions: DRIVER_PERMISSIONS }), false);
  const awarded = { ...load, status: 'AWARDED' };
  assert.equal(market.canReadLoad({ load: awarded, principal: { orgId: 'org-1' }, permissions: CARRIER_PERMISSIONS }), false);
  assert.equal(market.canReadLoad({ load: awarded, principal: { customerId: 'cust-1' } }), true);
});

test('canCounter: the shipper answers a carrier offer, the carrier answers a shipper counter', () => {
  const load = { customerId: 'cust-1', orgId: null, status: 'OFFERS' };
  const carrierOffer = baseOffer({ side: 'carrier', carrierOrgId: 'org-carrier' });
  const shipperCounter = baseOffer({ side: 'shipper', carrierOrgId: 'org-carrier' });
  assert.equal(market.canCounter({ offer: carrierOffer, load, principal: { customerId: 'cust-1' } }), true);
  assert.equal(market.canCounter({ offer: carrierOffer, load, principal: { orgId: 'org-carrier' } }), false);
  assert.equal(market.canCounter({ offer: shipperCounter, load, principal: { orgId: 'org-carrier' } }), true);
  assert.equal(market.canCounter({ offer: shipperCounter, load, principal: { orgId: 'org-other' } }), false);
  // A closed offer can never be countered again.
  assert.equal(
    market.canCounter({ offer: { ...carrierOffer, status: 'COUNTERED' }, load, principal: { customerId: 'cust-1' } }),
    false,
  );
});

test('canDecideOffer / canWithdrawOffer: owner decides, carrier withdraws its own', () => {
  const load = { customerId: 'cust-1', orgId: null };
  const carrierOffer = baseOffer({ side: 'carrier', carrierOrgId: 'org-carrier' });
  assert.equal(market.canDecideOffer({ offer: carrierOffer, load, principal: { customerId: 'cust-1' } }), true);
  assert.equal(market.canDecideOffer({ offer: carrierOffer, load, principal: { customerId: 'cust-2' } }), false);
  assert.equal(market.canWithdrawOffer({ offer: carrierOffer, principal: { orgId: 'org-carrier' } }), true);
  assert.equal(market.canWithdrawOffer({ offer: carrierOffer, principal: { orgId: 'org-other' } }), false);
  assert.equal(
    market.canWithdrawOffer({ offer: { ...carrierOffer, side: 'shipper' }, principal: { orgId: 'org-carrier' } }),
    false,
    'a shipper counter is not the carrier’s to withdraw',
  );
});

/* ------------------------------------------------------------ read model --- */

test('offerCards sorts cheapest first and never leaks a raw row', () => {
  const cards = market.offerCards([
    { id: 'o1', loadId: 'l1', priceEur: 1200, carrierName: 'Fleet A' },
    { id: 'o2', loadId: 'l1', priceEur: 900, carrierName: 'Fleet B', passwordHash: 'nope' },
  ]);
  assert.deepEqual(cards.map((c) => c.id), ['o2', 'o1']);
  assert.equal(cards[0].side, 'carrier', 'a missing side defaults to carrier');
  assert.equal('passwordHash' in cards[0], false);
});

test('loadCard carries the demand and the price, never the poster internals', () => {
  const card = market.loadCard({ id: 'l1', origin: 'A', destination: 'B', postedById: 'user-1', customerId: 'cust-1' });
  assert.deepEqual(Object.keys(card).sort(), [
    'cargo',
    'createdAt',
    'deliverByAt',
    'destination',
    'equipment',
    'expiresAt',
    'id',
    'loadReadyAt',
    'origin',
    'priceEur',
    'pricingMode',
    'status',
  ]);
  assert.equal(market.loadCard(null), null);
});

/* ---------------------------------------------------- source/migration guards --- */

test('the award route goes through the pure plan, never a hand-rolled transition', () => {
  const route = readFileSync(resolve(repoRoot, 'apps/api/src/routes/marketplace.ts'), 'utf8');
  assert.match(route, /market\.awardPlan\(/, 'the award must use awardPlan()');
  assert.match(route, /market\.buildAwardTripData\(/, 'the trip data must come from buildAwardTripData()');
  assert.match(route, /stripCredentialFields\(/, 'every marketplace response is credential-stripped');
});

test('the marketplace migration is additive: three new tables, no column on a shared model', () => {
  const dir = resolve(repoRoot, 'prisma/migrations');
  const name = readdirSync(dir).find((entry) => entry.endsWith('_add_marketplace'));
  assert.ok(name, 'a *_add_marketplace migration must exist');
  const sql = readFileSync(resolve(dir, name, 'migration.sql'), 'utf8');
  for (const table of ['LoadPosting', 'CapacityBeacon', 'MarketplaceOffer']) {
    assert.match(sql, new RegExp(`CREATE TABLE "${table}"`), `${table} is created`);
  }
  assert.match(sql, /"side" TEXT NOT NULL DEFAULT 'carrier'/);
  const alters = sql.match(/ALTER TABLE "[A-Za-z]+"/g) ?? [];
  for (const alter of alters) {
    assert.match(alter, /ALTER TABLE "(LoadPosting|CapacityBeacon|MarketplaceOffer)"/, `additive only, got ${alter}`);
  }
  assert.equal(
    /ADD COLUMN/.test(sql),
    false,
    'no existing table may gain a scalar column (the pilot reads it without a select)',
  );
});
