/**
 * Solo driver Connect MVP (board task #77, UXF-M2) — dependency-free unit
 * suite for the shared core (`solo/lib/solo-core.js`).
 *
 * Runs on the Node 20 native test runner with NO install
 * (`node --test apps/api/src/`), so CI covers the domain rules even on a bare
 * checkout with no database. The HTTP + database end-to-end proof lives in
 * `apps/api/test/solo.test.ts` (`pnpm --filter @roadwisefleet/api test:router`).
 *
 * No npm import here on purpose: the no-install CI job runs this directory.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as solo from '../../../solo/lib/solo-core.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

/* ----------------------------------------------------------------- signup --- */

test('validateSoloSignup requires name, email, password and phone, fail-fast', () => {
  assert.equal(solo.validateSoloSignup({}).field, 'name');
  assert.equal(solo.validateSoloSignup({ name: 'Piotr' }).field, 'email');
  assert.equal(solo.validateSoloSignup({ name: 'Piotr', email: 'nope' }).field, 'email');
  assert.equal(solo.validateSoloSignup({ name: 'Piotr', email: 'p@x.de' }).field, 'password');
  assert.equal(solo.validateSoloSignup({ name: 'Piotr', email: 'p@x.de', password: 'short' }).field, 'password');
  assert.equal(solo.validateSoloSignup({ name: 'Piotr', email: 'p@x.de', password: 'longenough1' }).field, 'phone');
  const badPhone = solo.validateSoloSignup({ name: 'Piotr', email: 'p@x.de', password: 'longenough1', phone: 'abc' });
  assert.equal(badPhone.field, 'phone');
});

test('validateSoloSignup returns a normalised, lower-cased signup', () => {
  const res = solo.validateSoloSignup({
    name: '  Piotr Kowalski ',
    email: ' PIOTR@Example.DE ',
    password: 'longenough1',
    phone: '+48 600 100 200',
    truckPlate: 'WX 1234A',
    truckEquipment: 'curtainsider',
    truckCapacityKg: '24000',
  });
  assert.equal(res.ok, true);
  assert.equal(res.value.email, 'piotr@example.de');
  assert.equal(res.value.name, 'Piotr Kowalski');
  assert.deepEqual(res.value.truck, {
    truckPlate: 'WX 1234A',
    truckEquipment: 'curtainsider',
    truckCapacityKg: 24000,
  });
});

test('normalizeTruck rejects unknown equipment and a fractional capacity', () => {
  assert.equal(solo.normalizeTruck({ truckEquipment: 'hovercraft' }).field, 'truckEquipment');
  assert.equal(solo.normalizeTruck({ truckCapacityKg: 12.5 }).field, 'truckCapacityKg');
  assert.deepEqual(solo.normalizeTruck({}).value, {}, 'an empty truck stays empty (filled after signup)');
});

/* -------------------------------------------------------------------- OTP --- */

test('generateOtpCode is a zero-padded 6-digit code, deterministic under a stub RNG', () => {
  const code = solo.generateOtpCode(() => 0);
  assert.equal(code, '000000');
  assert.match(code, /^\d{6}$/);
  let n = 0;
  const seq = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6];
  const code2 = solo.generateOtpCode(() => seq[n++]);
  assert.equal(code2.length, 6);
  assert.match(code2, /^\d{6}$/);
});

test('otpGate: not started, expired, locked, then ok', () => {
  const now = new Date('2026-09-30T12:00:00.000Z');
  assert.equal(solo.otpGate({ now }).error, 'otp_not_started');
  assert.equal(solo.otpGate({ hash: 'abc', attempts: 0, now }).error, 'otp_expired');
  assert.equal(
    solo.otpGate({ hash: 'abc', expiresAt: '2026-09-30T11:59:00.000Z', attempts: 0, now }).error,
    'otp_expired',
  );
  assert.equal(
    solo.otpGate({ hash: 'abc', expiresAt: '2026-09-30T12:10:00.000Z', attempts: solo.OTP_MAX_ATTEMPTS, now }).error,
    'otp_locked',
  );
  assert.equal(solo.otpGate({ hash: 'abc', expiresAt: '2026-09-30T12:10:00.000Z', attempts: 1, now }).ok, true);
});

test('otpExpiry adds the TTL', () => {
  const at = solo.otpExpiry(new Date('2026-09-30T12:00:00.000Z'));
  assert.equal(at.toISOString(), '2026-09-30T12:10:00.000Z');
});

test('normalizeOtpCode keeps only digits and caps the length', () => {
  assert.equal(solo.normalizeOtpCode(' 12-34 56 '), '123456');
  assert.equal(solo.normalizeOtpCode('1234567890'), '123456');
  assert.equal(solo.normalizeOtpCode('abc'), '');
});

/* -------------------------------------------------────────────── bid gate --- */

test('canBid is open by default: verification is optional (owner #73 q5)', () => {
  for (const status of ['NONE', 'PENDING', 'REJECTED', 'VERIFIED', undefined]) {
    const gate = solo.canBid(status ? { verificationStatus: status } : null);
    assert.equal(gate.allowed, true, `status ${status} may bid`);
    assert.equal(gate.error, null);
    assert.equal(gate.messageKey, null);
  }
});

test('canBid can still be re-armed for the historical strict rule, which stays tested', () => {
  assert.equal(solo.canBid({ verificationStatus: 'VERIFIED' }, { enforce: true }).allowed, true);
  for (const status of ['NONE', 'PENDING', 'REJECTED', undefined]) {
    const gate = solo.canBid(status ? { verificationStatus: status } : null, { enforce: true });
    assert.equal(gate.allowed, false, `status ${status} must not bid when enforced`);
    assert.equal(gate.error, 'verification_required');
  }
  assert.equal(solo.canBid({ verificationStatus: 'PENDING' }, { enforce: true }).messageKey, 'solo.bid.pending');
  assert.equal(solo.canBid(null, { enforce: true }).messageKey, 'solo.bid.unverified');
});

test('the bid gate is a real constant and ships open (owner #73 q5)', () => {
  assert.equal(solo.BID_REQUIRES_VERIFICATION, false);
});

/* -------------------------------------------------───────── verification --- */

test('verificationState lists the four papers, the missing ones and completeness', () => {
  const empty = solo.verificationState({ verificationStatus: 'NONE' }, []);
  assert.deepEqual(empty.missing, ['id', 'licence', 'vehicle_registration', 'insurance']);
  assert.equal(empty.complete, false);
  assert.equal(empty.papers.length, 4);

  const docs = [
    { docType: 'id', status: 'PENDING' },
    { docType: 'licence', status: 'PENDING' },
    { docType: 'vehicle_registration', status: 'PENDING' },
    { docType: 'insurance', status: 'PENDING' },
  ];
  const complete = solo.verificationState({ verificationStatus: 'PENDING' }, docs);
  assert.equal(complete.complete, true);
  assert.deepEqual(complete.missing, []);
  assert.equal(complete.papers.find((p) => p.docType === 'insurance').status, 'PENDING');
});

test('verificationState badges are truthful per paper (no fake check mark)', () => {
  // Nothing supplied: the three check-mark papers are `missing`, not checked.
  const none = solo.verificationState({ verificationStatus: 'NONE' }, []);
  assert.deepEqual(none.badges.map((b) => b.docType), ['id', 'licence', 'vehicle_registration']);
  for (const badge of none.badges) {
    assert.equal(badge.supplied, false);
    assert.equal(badge.verified, false);
    assert.equal(badge.mark, 'missing');
  }

  const docs = [
    { docType: 'id', status: 'VERIFIED' },
    { docType: 'licence', status: 'PENDING' },
    { docType: 'vehicle_registration', status: 'REJECTED' },
  ];
  const mixed = solo.verificationState({ verificationStatus: 'PENDING' }, docs);
  const byType = Object.fromEntries(mixed.badges.map((b) => [b.docType, b]));
  assert.deepEqual(
    { id: byType.id.mark, licence: byType.licence.mark, reg: byType.vehicle_registration.mark },
    { id: 'verified', licence: 'pending', reg: 'rejected' },
  );
  assert.equal(byType.id.verified, true);
  assert.equal(byType.licence.verified, false, 'a PENDING paper never renders as verified');
  // A supplied paper is a check-mark row even when review is not finished.
  assert.equal(byType.licence.supplied, true);
  assert.equal(byType.vehicle_registration.supplied, true);
});

test('normalizeVerificationUpload validates the paper type, mime and base64 size', () => {
  assert.equal(solo.normalizeVerificationUpload({}).field, 'docType');
  assert.equal(solo.normalizeVerificationUpload({ docType: 'passport' }).field, 'docType');
  assert.equal(solo.normalizeVerificationUpload({ docType: 'id' }).field, 'filename');
  assert.equal(solo.normalizeVerificationUpload({ docType: 'id', filename: 'a.jpg' }).field, 'mimeType');
  assert.equal(
    solo.normalizeVerificationUpload({ docType: 'id', filename: 'a.jpg', mimeType: 'image/gif' }).field,
    'mimeType',
  );
  assert.equal(
    solo.normalizeVerificationUpload({ docType: 'id', filename: 'a.jpg', mimeType: 'image/jpeg' }).field,
    'dataBase64',
  );
  const ok = solo.normalizeVerificationUpload({
    docType: 'id',
    filename: 'a.jpg',
    mimeType: 'image/jpeg',
    dataBase64: 'aGVsbG8=', // "hello"
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.bytes, 5);
  const tooBig = solo.normalizeVerificationUpload({
    docType: 'id',
    filename: 'a.jpg',
    mimeType: 'image/jpeg',
    dataBase64: 'A'.repeat(Math.ceil((solo.MAX_VERIFICATION_BYTES + 4) / 3) * 4),
  });
  assert.equal(tooBig.field, 'dataBase64');
  assert.match(tooBig.detail, /exceeds/);
});

/* ---------------------------------------------------------- own customers --- */

test('normalizeSoloCustomer needs a name; email/phone are optional but validated', () => {
  assert.equal(solo.normalizeSoloCustomer({}).field, 'name');
  assert.equal(solo.normalizeSoloCustomer({ name: 'Jan' }).ok, true);
  assert.equal(solo.normalizeSoloCustomer({ name: 'Jan', email: 'bad' }).field, 'email');
  assert.equal(solo.normalizeSoloCustomer({ name: 'Jan', phone: 'x' }).field, 'phone');
});

test('normalizeQuickJob: customer, route, rate and window are validated fail-fast', () => {
  assert.equal(solo.normalizeQuickJob({}).field, 'customerName');
  assert.equal(solo.normalizeQuickJob({ customerName: 'Jan' }).field, 'origin');
  assert.equal(solo.normalizeQuickJob({ customerName: 'Jan', origin: 'A' }).field, 'destination');
  assert.equal(solo.normalizeQuickJob({ customerName: 'Jan', origin: 'A', destination: 'A' }).field, 'destination');
  assert.equal(
    solo.normalizeQuickJob({ customerName: 'Jan', origin: 'A', destination: 'B', rateEur: '-5' }).field,
    'rateEur',
  );
  assert.equal(
    solo.normalizeQuickJob({
      customerName: 'Jan',
      origin: 'A',
      destination: 'B',
      loadReadyAt: '2026-10-02T00:00:00.000Z',
      deliverByAt: '2026-10-01T00:00:00.000Z',
    }).field,
    'deliverByAt',
  );
  const ok = solo.normalizeQuickJob({
    customerName: 'Jan',
    origin: 'Berlin',
    destination: 'Wien',
    rateEur: '1200',
    equipment: 'reefer',
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.rateEur, 1200);
  assert.equal(ok.value.equipment, 'reefer');
});

test('buildQuickJobRows creates the shared Order + Trip pair, self-assigned', () => {
  const rows = solo.buildQuickJobRows(
    { origin: 'Berlin', destination: 'Wien', cargo: null, rateEur: 1200, loadReadyAt: null, deliverByAt: null, equipment: null },
    { orgId: 'org-1', driverId: 'u1', customerId: 'c1' },
  );
  assert.equal(rows.order.customerId, 'c1');
  assert.equal(rows.order.status, 'BOOKED');
  assert.equal(rows.trip.orgId, 'org-1');
  assert.equal(rows.trip.driverId, 'u1');
  assert.equal(rows.trip.status, 'ASSIGNED');
  assert.equal(rows.trip.rateEur, 1200);
  assert.equal(rows.booking.supplyChoice, 'solo');
});

/* --------------------------------------------------------- saved searches --- */

test('normalizeSavedSearch drops unknown filter keys and unknown equipment', () => {
  const res = solo.normalizeSavedSearch({
    name: 'Berlin → PL',
    origin: 'Berlin',
    destination: 'Warszawa',
    equipment: 'hovercraft',
    evil: 'drop table',
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.value.filter, { origin: 'Berlin', destination: 'Warszawa' });
  assert.equal(solo.normalizeSavedSearch({}).field, 'name');
});

test('searchQueryString builds a deterministic query for the feed', () => {
  assert.equal(solo.searchQueryString({ origin: 'Berlin', destination: 'Wien' }), '?origin=Berlin&destination=Wien');
  assert.equal(solo.searchQueryString({ origin: 'a b', equipment: 'box' }), '?origin=a%20b&equipment=box');
  assert.equal(solo.searchQueryString({}), '');
});

/* ---------------------------------------------------------- wallet-lite --- */

test('jobRow shapes a trip + settlement, tolerating Decimal strings', () => {
  const row = solo.jobRow({
    id: 't1',
    status: 'DELIVERED',
    rateEur: '1200.50',
    order: { origin: 'Berlin', destination: 'Wien', customer: { name: 'Jan' } },
    settlement: { status: 'PAID', amountEur: '1200.50' },
  });
  assert.equal(row.rateEur, 1200.5);
  assert.equal(row.customer, 'Jan');
  assert.equal(row.settlement.status, 'PAID');
  assert.equal(solo.jobRow(null), null);
});

test('walletSummary counts jobs, earned/paid/outstanding', () => {
  const summary = solo.walletSummary([
    { id: 'a', status: 'DELIVERED', rateEur: 1000, order: {}, settlement: { status: 'PAID', amountEur: 1000 } },
    { id: 'b', status: 'POD_UPLOADED', rateEur: 500, order: {}, settlement: { status: 'PENDING', amountEur: 500 } },
    { id: 'c', status: 'IN_TRANSIT', rateEur: 800, order: {}, settlement: null },
    { id: 'd', status: 'ASSIGNED', rateEur: 300, order: {}, settlement: null },
  ]);
  assert.equal(summary.jobs, 4);
  assert.equal(summary.delivered, 2);
  assert.equal(summary.earnedEur, 1500);
  assert.equal(summary.paidEur, 1000);
  assert.equal(summary.outstandingEur, 500);
  assert.equal(summary.unpaid, 1);
});

/* ------------------------------------------------------------ read model --- */

test('nextStatusAfter walks the display chain and stops at the end', () => {
  assert.equal(solo.nextStatusAfter('DRAFT'), 'ASSIGNED');
  assert.equal(solo.nextStatusAfter('ASSIGNED'), 'LOADED');
  assert.equal(solo.nextStatusAfter('DELIVERED'), 'POD_UPLOADED');
  assert.equal(solo.nextStatusAfter('POD_UPLOADED'), null);
  assert.equal(solo.nextStatusAfter('BOGUS'), null);
});

test('the role and permission constants are the ones the deploy path and signup share', () => {
  assert.equal(solo.SOLO_ROLE, 'solo');
  assert.ok(solo.SOLO_PERMISSIONS.includes('trip:*'));
  assert.ok(solo.SOLO_PERMISSIONS.includes('order:create'));
  assert.ok(solo.SOLO_PERMISSIONS.includes('pod:upload'));
  assert.equal(solo.SOLO_PERMISSIONS.includes('customer:manage'), false, 'a solo login must never resolve to a customer tenant');
});

/* --------------------------------------------------------- source guards --- */

test('the solo surface is registered, served and reaches the API', () => {
  const app = readFileSync(resolve(here, 'app.ts'), 'utf8');
  assert.match(app, /soloRoutes/, 'the solo API routes are registered');
  assert.match(app, /soloAppRoutes/, 'the /s/ surface is served');
  const shell = readFileSync(resolve(here, 'solo-shell.js'), 'utf8');
  assert.match(shell, /SOLO_PREFIX = '\/s\/'/, 'the mount point is /s/');
  assert.match(shell, /package\.json/, 'the module manifest is refused before resolution');
  const routes = readFileSync(resolve(here, 'routes/solo.ts'), 'utf8');
  for (const path of ['/solo/signup', '/solo/me', '/solo/otp', '/solo/verification', '/solo/searches', '/solo/customers', '/solo/jobs']) {
    assert.ok(routes.includes(path), `the route table includes ${path}`);
  }
});

test('the marketplace offer path no longer refuses unverified solo drivers (owner #73 q5)', () => {
  const market = readFileSync(resolve(here, 'routes/marketplace.ts'), 'utf8');
  assert.match(market, /SOLO_ROLE/, 'the offer path still knows the solo role');
  assert.equal(/canBid\(/.test(market), false, 'the hard verification gate is gone from the offer path');
  const offerBlock = market.slice(
    market.indexOf("app.post('/marketplace/loads/:id/offers'"),
    market.indexOf("app.post('/marketplace/loads/:id/award'"),
  );
  assert.ok(offerBlock.length > 0, 'the offer block is found');
  assert.equal(offerBlock.includes('verification_required'), false, 'no refusal by verification status');
  // The profile is still read from the caller's OWN row (never the body), for
  // the compare facets.
  assert.match(offerBlock, /soloDriverProfile\.findUnique/, 'the profile is read from the DB, not the body');
  // The feed read was never gated and still is not.
  const feedBlock = market.slice(market.indexOf("app.get('/marketplace/loads'"), market.indexOf("app.get('/marketplace/loads/:id'"));
  assert.equal(feedBlock.includes('canBid('), false, 'the feed is not gated');
});

test('the solo core is a plain ES module importable without npm', () => {
  const source = readFileSync(resolve(repoRoot, 'solo/lib/solo-core.js'), 'utf8');
  assert.equal(/require\(/.test(source), false, 'no CommonJS require');
  assert.equal(/from 'node:/.test(source), false, 'no node: import (the browser loads this file too)');
});
