/**
 * Customer portal core (board task #74, UXF-C1) — dependency-free coverage for
 * `customer/lib/customer-core.js`, the rule set the browser wizard and the API
 * share.
 *
 * Runs under the no-install CI job (`node --test apps/api/src/`): it imports
 * only `node:*` builtins plus the ES module core. The HTTP/DB-level assertions
 * on the same rules live in `apps/api/test/customer-portal.test.ts`
 * (`pnpm test:router`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as core from '../../../customer/lib/customer-core.js';

const validBooking = (over) =>
  Object.assign(
    {
      origin: 'Berlin, DE',
      destination: 'Hamburg, DE',
      supplyChoice: 'own_carrier'
    },
    over || {}
  );

test('the supply choice offers five paths plus the off-platform case', () => {
  assert.deepEqual(
    core.SUPPLY_CHOICES.map((c) => c.id),
    ['fleet', 'solo', 'auto', 'own_carrier', 'recurring']
  );
  assert.equal(core.OFF_PLATFORM_CHOICE.id, 'off_platform');
  assert.deepEqual(core.SUPPLY_CHOICE_IDS, ['fleet', 'solo', 'auto', 'own_carrier', 'recurring', 'off_platform']);
  // Every choice carries its own copy so no card can render a bare id.
  for (const choice of core.SUPPLY_CHOICES.concat([core.OFF_PLATFORM_CHOICE])) {
    assert.ok(choice.i18n.indexOf('book.supply.') === 0, choice.id + ' needs a label key');
    assert.ok(choice.descI18n.indexOf('book.supply.') === 0, choice.id + ' needs a description key');
  }
});

test('only own_carrier and off_platform are bookable today; the rest are marketplace', () => {
  assert.equal(core.isBookableChoice('own_carrier'), true);
  assert.equal(core.isBookableChoice('off_platform'), true);
  for (const id of ['fleet', 'solo', 'auto', 'recurring']) {
    assert.equal(core.isBookableChoice(id), false, id + ' must not be bookable yet');
    assert.equal(core.isMarketplaceChoice(id), true, id + ' must report the marketplace phase');
  }
  assert.equal(core.isMarketplaceChoice('own_carrier'), false);
  assert.equal(core.isKnownChoice('nonsense'), false);
  assert.equal(core.supplyChoiceInfo('nonsense'), null);
});

test('a marketplace path answers with an honest notice, never an error or a dead end', () => {
  const notice = core.marketplaceNotice('fleet');
  assert.equal(notice.code, 'marketplace_unavailable');
  assert.equal(notice.task, core.MARKETPLACE_TASK);
  assert.equal(notice.i18n, 'book.marketplacePending');
  assert.equal(notice.fallback, 'own_carrier');
  assert.equal(core.marketplaceNotice('own_carrier'), null);
  assert.equal(core.marketplaceNotice('nonsense'), null);
});

test('a minimal own-carrier booking validates and fills the documented defaults', () => {
  const result = core.normalizeBooking(validBooking());
  assert.equal(result.ok, true);
  assert.equal(result.value.supplyChoice, 'own_carrier');
  assert.deepEqual(result.value.stops, []);
  assert.equal(result.value.pricingMode, 'instant');
  assert.equal(result.value.payer, 'me');
  assert.equal(result.value.paymentMethod, 'invoice');
  assert.equal(result.value.marketplace, false);
  assert.equal(result.value.bookable, true);
  assert.equal(result.value.weightKg, null);
});

test('the route is required, and the two ends must differ', () => {
  const missingOrigin = core.normalizeBooking(validBooking({ origin: '   ' }));
  assert.equal(missingOrigin.ok, false);
  assert.equal(missingOrigin.field, 'origin');
  assert.equal(missingOrigin.messageKey, 'book.error.originRequired');

  const missingDestination = core.normalizeBooking(validBooking({ destination: '' }));
  assert.equal(missingDestination.ok, false);
  assert.equal(missingDestination.field, 'destination');

  const same = core.normalizeBooking(validBooking({ destination: ' Berlin, DE ' }));
  assert.equal(same.ok, false);
  assert.equal(same.field, 'destination');
  assert.equal(same.messageKey, 'book.error.sameRoute');
});

test('an unknown or missing supply choice is refused with a field-level message', () => {
  const missing = core.normalizeBooking(validBooking({ supplyChoice: '' }));
  assert.equal(missing.ok, false);
  assert.equal(missing.field, 'supplyChoice');
  assert.equal(missing.messageKey, 'book.error.supplyRequired');

  const unknown = core.normalizeBooking(validBooking({ supplyChoice: 'teleport' }));
  assert.equal(unknown.ok, false);
  assert.equal(unknown.messageKey, 'book.error.supplyUnknown');
});

test('stops are validated, capped and normalised', () => {
  const ok = core.normalizeBooking(
    validBooking({ stops: [{ address: ' Hannover ', kind: 'checkpoint' }, { address: 'Bremen' }] })
  );
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value.stops[0], { kind: 'checkpoint', address: 'Hannover' });
  assert.equal(ok.value.stops[1].kind, 'checkpoint', 'an unknown kind degrades to checkpoint, never a crash');

  const noAddress = core.normalizeBooking(validBooking({ stops: [{ address: '' }] }));
  assert.equal(noAddress.ok, false);
  assert.equal(noAddress.messageKey, 'book.error.stopAddressRequired');

  const notArray = core.normalizeBooking(validBooking({ stops: 'Hannover' }));
  assert.equal(notArray.ok, false);
  assert.equal(notArray.messageKey, 'book.error.stopsInvalid');

  const tooMany = core.normalizeBooking(
    validBooking({ stops: Array.from({ length: core.MAX_STOPS + 1 }, () => ({ address: 'X' })) })
  );
  assert.equal(tooMany.ok, false);
  assert.equal(tooMany.messageKey, 'book.error.tooManyStops');
});

test('equipment must come from the documented list', () => {
  assert.equal(core.normalizeBooking(validBooking({ equipment: 'reefer' })).ok, true);
  const bad = core.normalizeBooking(validBooking({ equipment: 'helicopter' }));
  assert.equal(bad.ok, false);
  assert.equal(bad.field, 'equipment');
  assert.equal(bad.messageKey, 'book.error.equipmentUnknown');
});

test('dates must parse, and the delivery window cannot run backwards', () => {
  const ok = core.normalizeBooking(
    validBooking({ loadReadyAt: '2026-10-01T08:00:00.000Z', deliverByAt: '2026-10-02T08:00:00.000Z' })
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.value.loadReadyAt.toISOString(), '2026-10-01T08:00:00.000Z');

  const bad = core.normalizeBooking(validBooking({ loadReadyAt: 'next tuesday' }));
  assert.equal(bad.ok, false);
  assert.equal(bad.field, 'loadReadyAt');
  assert.equal(bad.messageKey, 'book.error.dateInvalid');

  const backwards = core.normalizeBooking(
    validBooking({ loadReadyAt: '2026-10-02T08:00:00.000Z', deliverByAt: '2026-10-01T08:00:00.000Z' })
  );
  assert.equal(backwards.ok, false);
  assert.equal(backwards.field, 'deliverByAt');
  assert.equal(backwards.messageKey, 'book.error.windowOrder');
});

test('amounts must be non-negative numbers; pallets must be whole', () => {
  assert.equal(core.normalizeBooking(validBooking({ weightKg: '1200', pallets: '6', budgetEur: '950.5' })).ok, true);
  for (const bad of [{ weightKg: -1 }, { pallets: 2.5 }, { insuranceValueEur: 'lots' }, { budgetEur: -0.01 }]) {
    const result = core.normalizeBooking(validBooking(bad));
    assert.equal(result.ok, false, JSON.stringify(bad));
    assert.equal(result.messageKey, 'book.error.amountInvalid');
  }
});

test('escrow is refused with the UXF-OWN1 reason instead of being silently accepted', () => {
  const result = core.normalizeBooking(validBooking({ paymentMethod: 'escrow' }));
  assert.equal(result.ok, false);
  assert.equal(result.field, 'paymentMethod');
  assert.equal(result.messageKey, 'book.error.escrowUnavailable');
  assert.ok(core.PAYMENT_METHODS.indexOf('escrow') === -1);
  assert.equal(core.normalizeBooking(validBooking({ paymentMethod: 'sepa' })).ok, true);
});

test('payer and pricing mode are validated against the documented lists', () => {
  assert.deepEqual(core.PRICING_MODES, ['instant', 'quotes', 'budget']);
  assert.deepEqual(core.PAYERS, ['me', 'consignee', 'third_party']);
  assert.equal(core.normalizeBooking(validBooking({ payer: 'consignee', pricingMode: 'quotes' })).ok, true);
  assert.equal(core.normalizeBooking(validBooking({ payer: 'nobody' })).messageKey, 'book.error.payerUnknown');
  assert.equal(core.normalizeBooking(validBooking({ pricingMode: 'free' })).messageKey, 'book.error.pricingUnknown');
});

test('free text is trimmed and capped', () => {
  const long = 'x'.repeat(core.MAX_TEXT + 200);
  const result = core.normalizeBooking(validBooking({ specialRequirements: '  ' + long + '  ' }));
  assert.equal(result.ok, true);
  assert.equal(result.value.specialRequirements.length, core.MAX_TEXT);
});

test('a bookable order carries the booking and the unassigned draft trip', () => {
  const normalized = core.normalizeBooking(
    validBooking({
      cargo: 'Pallets',
      equipment: 'curtainsider',
      deliverByAt: '2026-10-02T08:00:00.000Z',
      stops: [{ address: 'Hannover', kind: 'checkpoint' }]
    })
  );
  const rows = core.buildOrderData(normalized.value, { customerId: 'cus-1' });
  assert.equal(rows.order.customerId, 'cus-1');
  assert.equal(rows.order.status, 'BOOKED');
  assert.equal(rows.order.plannedAt.toISOString(), '2026-10-02T08:00:00.000Z');
  // The wizard detail is a separate table, so the shared Order stays untouched.
  assert.equal(rows.booking.supplyChoice, 'own_carrier');
  assert.equal(rows.booking.equipment, 'curtainsider');
  assert.equal(rows.booking.deliverByAt.toISOString(), '2026-10-02T08:00:00.000Z');
  assert.equal(rows.booking.details.pricingMode, 'instant');
  assert.equal(rows.booking.details.paymentMethod, 'invoice');
  assert.deepEqual(rows.booking.details.stops, [{ kind: 'checkpoint', address: 'Hannover' }]);
  assert.equal(JSON.stringify(rows.order).includes('supplyChoice'), false, 'Order carries no portal column');

  const trip = core.buildTripData({ orgId: 'pilot-org', orderId: 'order-1' });
  assert.deepEqual(trip, {
    orgId: 'pilot-org',
    orderId: 'order-1',
    status: 'DRAFT',
    driverId: null,
    truckId: null,
    rateEur: null
  });
});

test('the customer read model never exposes a fleet internal', () => {
  const order = {
    id: 'order-1',
    customerId: 'cus-1',
    origin: 'Berlin',
    destination: 'Hamburg',
    cargo: 'Pallets',
    status: 'BOOKED',
    createdAt: new Date('2026-09-29T10:00:00.000Z'),
    plannedAt: null,
    rateEur: 1450,
    booking: {
      supplyChoice: 'own_carrier',
      equipment: 'reefer',
      details: { stops: [{ kind: 'checkpoint', address: 'Hannover' }], payer: 'me', paymentMethod: 'invoice' }
    },
    trips: [
      {
        id: 'trip-1',
        status: 'DRAFT',
        tracking: true,
        deliveredAt: null,
        driver: { name: 'Driver One', phone: '+49 1' },
        truck: { plate: 'RW-001' },
        rateEur: 1450
      }
    ]
  };
  const summary = core.orderSummary(order);
  assert.deepEqual(Object.keys(summary).sort(), [
    'cargo',
    'createdAt',
    'destination',
    'id',
    'origin',
    'plannedAt',
    'status',
    'supplyChoice',
    'trip'
  ]);
  assert.deepEqual(Object.keys(summary.trip).sort(), ['deliveredAt', 'id', 'status', 'tracking']);
  assert.equal(summary.trip.tracking, true);
  assert.equal(JSON.stringify(summary).includes('Driver One'), false);
  assert.equal(JSON.stringify(summary).includes('RW-001'), false);
  assert.equal(JSON.stringify(summary).includes('1450'), false);

  const detail = core.orderDetail(order);
  assert.equal(detail.booking.equipment, 'reefer');
  assert.deepEqual(detail.booking.stops, [{ kind: 'checkpoint', address: 'Hannover' }]);
  assert.equal(JSON.stringify(detail).includes('Driver One'), false);

  assert.equal(core.orderSummary(null), null);
  assert.equal(core.orderDetail(undefined), null);
});

test('statuses render through the catalogue, including the unknown case', () => {
  assert.equal(core.statusKey('BOOKED'), 'status.BOOKED');
  assert.equal(core.statusKey('in_transit'), 'status.IN_TRANSIT');
  assert.equal(core.statusKey(''), 'status.UNKNOWN');
  assert.equal(core.statusKey(null), 'status.UNKNOWN');
});

test('signup requires a name, a real email and an 8-character password', () => {
  const ok = core.validateSignup({ name: 'Ada', email: 'ADA@Example.com', password: 'secret12' });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.email, 'ada@example.com');
  assert.deepEqual(ok.value.notifyPrefs, { email: true, sms: false, whatsapp: false });
  assert.equal(ok.value.company, '');

  assert.equal(core.validateSignup({ name: '', email: 'a@b.co', password: 'secret12' }).field, 'name');
  assert.equal(core.validateSignup({ name: 'Ada', email: 'ada@', password: 'secret12' }).field, 'email');
  assert.equal(core.validateSignup({ name: 'Ada', email: 'a@b.co', password: 'short' }).field, 'password');
  assert.equal(core.validateSignup({ name: 'Ada', email: 'a@b.co', password: 'secret12', phone: '12' }).field, 'phone');
  assert.equal(core.validateSignup(null).ok, false);
});

test('profile and address updates are partial and validated', () => {
  const profile = core.normalizeProfile({ company: '  ACME  ', notifyPrefs: { sms: true } });
  assert.equal(profile.ok, true);
  assert.equal(profile.value.company, 'ACME');
  assert.deepEqual(profile.value.notifyPrefs, { email: true, sms: true, whatsapp: false });
  assert.equal(core.normalizeProfile({ name: '  ' }).ok, false);

  const address = core.normalizeAddress({ line1: ' Hauptstr. 1 ', city: 'Berlin' });
  assert.equal(address.ok, true);
  assert.equal(address.value.label, 'Address');
  assert.equal(address.value.line1, 'Hauptstr. 1');
  assert.equal(core.normalizeAddress({ line1: '' }).messageKey, 'account.error.addressRequired');
});

test('email and phone checks accept the real formats and refuse the obvious junk', () => {
  for (const good of ['a@b.co', 'ada.lovelace@example.co.uk']) assert.equal(core.isValidEmail(good), true, good);
  for (const bad of ['', 'ada', 'ada@', '@b.co', 'ada@b', null]) assert.equal(core.isValidEmail(bad), false, String(bad));
  assert.equal(core.isPlausiblePhone('+49 170 1234567'), true);
  assert.equal(core.isPlausiblePhone('123'), false);
});

test('an order is accessible only to the customer that owns it', () => {
  assert.equal(core.canAccessOrder('cus-1', { customerId: 'cus-1' }), true);
  assert.equal(core.canAccessOrder('cus-1', { customerId: 'cus-2' }), false);
  assert.equal(core.canAccessOrder('', { customerId: '' }), false);
  assert.equal(core.canAccessOrder('cus-1', null), false);
  assert.deepEqual(core.customerOrderWhere('cus-1'), { customerId: 'cus-1' });
  assert.equal(core.roleIsCustomer('customer'), true);
  assert.equal(core.roleIsCustomer('dispatcher'), false);
});

test('the empty wizard form starts from the documented defaults', () => {
  const form = core.initialBooking();
  assert.equal(form.pricingMode, 'instant');
  assert.equal(form.payer, 'me');
  assert.equal(form.paymentMethod, 'invoice');
  assert.deepEqual(form.stops, []);
  assert.equal(form.supplyChoice, '');
});

test('the shared core is declared an ES module (the API imports it under tsx)', () => {
  // Found on the pilot 2026-09-29 (PR #67 review): without `"type": "module"` in
  // <repo>/customer, tsx/Node load this file as CommonJS and
  // `import * as customerCore from '.../customer-core.js'` in the API yields
  // `{ default: … }`, so EVERY customer route 500s with
  // "customerCore.validateSignup is not a function". The behavioural guard runs
  // in `test/customer-signup-validation.test.ts` (under tsx); this one catches a
  // deleted/edited marker on the no-install CI job too.
  const pkg = JSON.parse(readFileSync(new URL('../../../customer/package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.type, 'module', 'customer/package.json must declare "type": "module"');
});
