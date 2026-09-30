/**
 * Customer portal serving (board task #74, UXF-C1) — dependency-free coverage
 * for `src/customer-shell.js` (the `/c/` static root and SPA fallback) and for
 * the portal's own files: the client module, the shell markup and the English
 * catalogue.
 *
 * It runs under the no-install CI job (`node --test apps/api/src/`): `node:fs`,
 * `node:path` and the shared `app-shell.js` rules only. The HTTP-level checks
 * (Fastify, `app.inject()`) live in `apps/api/test/customer-portal.test.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { extname, resolve } from 'node:path';

import { contentTypeFor, resolveFileIn, servesShell } from './app-shell.js';
import {
  CUSTOMER_PREFIX,
  CUSTOMER_ROOT,
  customerShellHtml,
  resolveCustomerFile,
} from './customer-shell.js';
import { TRIP_STATUSES } from './trip-status.js';
import * as core from '../../../customer/lib/customer-core.js';

const read = (rel) => readFileSync(resolve(CUSTOMER_ROOT, rel), 'utf8');

/**
 * Drop block and line comments, so a source guard tests the CODE and not the
 * doc comment next to it (learned on board #63: a guard matched its own
 * docstring).
 */
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

test('the portal root is the repo customer/ directory and holds the served files', () => {
  assert.equal(CUSTOMER_PREFIX, '/c/');
  assert.ok(CUSTOMER_ROOT.endsWith('/customer'), CUSTOMER_ROOT);
  for (const file of ['index.html', 'customer.css', 'customer.js', 'lib/customer-core.js', 'locales/en.json']) {
    assert.ok(existsSync(resolve(CUSTOMER_ROOT, file)), file + ' must exist');
    assert.ok(resolveCustomerFile(file) !== null, file + ' must be servable');
  }
});

test('the file rules are the app shell rules, reused and not re-implemented', () => {
  // The same extension allow-list and traversal guard as `/app/`: a path may
  // never escape the portal root, dotfiles are never served, and a missing asset
  // is a 404 rather than the shell.
  assert.equal(resolveCustomerFile('../package.json'), null);
  assert.equal(resolveCustomerFile('..%2Fpackage.json'), null);
  assert.equal(resolveCustomerFile('%2e%2e/package.json'), null);
  assert.equal(resolveCustomerFile('.env'), null);
  assert.equal(resolveCustomerFile('lib/.hidden.js'), null);
  assert.equal(resolveCustomerFile('../../etc/passwd'), null);
  assert.equal(resolveCustomerFile('index.txt'), null);
  assert.equal(resolveCustomerFile('lib/missing.js'), null);
  assert.equal(resolveFileIn(CUSTOMER_ROOT, 'lib/customer-core.js'), resolveCustomerFile('lib/customer-core.js'));
  // `customer/package.json` declares the ES module type the API depends on; it is
  // a directory manifest, so it is never served (it exists as a real file, which
  // is why this is asserted separately from the missing-file cases).
  assert.ok(existsSync(resolve(CUSTOMER_ROOT, 'package.json')), 'customer/package.json must exist');
  assert.equal(resolveCustomerFile('package.json'), null, 'package.json must never be served');
  assert.equal(resolveCustomerFile('lib/package.json'), null);
  assert.equal(resolveFileIn(CUSTOMER_ROOT, 'package.json') !== null, true, 'app-shell itself would serve it');

  assert.equal(servesShell('login', false), true);
  assert.equal(servesShell('shipments/123', false), true);
  assert.equal(servesShell('lib/missing.js', false), false);
  assert.equal(servesShell('index.html', false), true);
  assert.equal(contentTypeFor('customer.js'), 'text/javascript; charset=utf-8');
  assert.equal(contentTypeFor('locales/en.json'), 'application/json; charset=utf-8');

  const shellSource = readFileSync(resolve(CUSTOMER_ROOT, '../apps/api/src/customer-shell.js'), 'utf8');
  assert.match(shellSource, /resolveFileIn/, 'customer-shell must delegate to app-shell#resolveFileIn');
  assert.ok(!/realpathSync|decodeURIComponent/.test(shellSource), 'customer-shell must not duplicate the path rules');
});

test('the shell serves the portal, never the dispatcher app', () => {
  const html = customerShellHtml();
  assert.match(html, /id="authView"/);
  assert.match(html, /id="signupView"/);
  assert.match(html, /id="appView"/);
  assert.match(html, /<script type="module" src="\/c\/customer\.js"><\/script>/);
  assert.match(html, /href="\/c\/customer\.css"/);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(html, /lang="en"/);
  assert.match(html, /rel="noindex, nofollow"|name="robots" content="noindex, nofollow"/);
  assert.ok(!/\/app\//.test(html), 'the customer surface must not link the dispatcher app');
});

test('the portal route serves /c/ through the shared resolver', () => {
  const route = readFileSync(resolve(CUSTOMER_ROOT, '../apps/api/src/routes/customer-app.ts'), 'utf8');
  assert.match(route, /resolveCustomerFile/);
  assert.match(route, /customerShellHtml/);
  assert.match(route, /servesShell/);
  assert.match(route, /x-robots-tag/);
  assert.match(route, /redirect\(CUSTOMER_PREFIX, 302\)/);
});

test('every key the portal uses exists in the English catalogue', () => {
  const catalogue = JSON.parse(read('locales/en.json'));
  const keys = new Set(Object.keys(catalogue));

  const html = read('index.html');
  for (const match of html.matchAll(/data-i18n="([^"]+)"/g)) {
    assert.ok(keys.has(match[1]), 'index.html uses missing key ' + match[1]);
  }
  const js = stripComments(read('customer.js'));
  for (const match of js.matchAll(/\bt\('([^']+)'/g)) {
    // A key ending in '.' is a dynamic prefix (`t('equipment.' + id)`); the
    // concrete ids are asserted below.
    if (match[1].endsWith('.')) continue;
    assert.ok(keys.has(match[1]), 'customer.js uses missing key ' + match[1]);
  }

  // The core owns these keys; the catalogue must carry every one of them.
  for (const choice of core.SUPPLY_CHOICES.concat([core.OFF_PLATFORM_CHOICE])) {
    assert.ok(keys.has(choice.i18n), 'missing ' + choice.i18n);
    assert.ok(keys.has(choice.descI18n), 'missing ' + choice.descI18n);
  }
  for (const id of core.EQUIPMENT) assert.ok(keys.has('equipment.' + id), 'missing equipment.' + id);
  for (const id of core.PRICING_MODES) assert.ok(keys.has('book.pricing.' + id), 'missing book.pricing.' + id);
  for (const id of core.PAYERS) assert.ok(keys.has('book.payer.' + id), 'missing book.payer.' + id);
  for (const id of core.PAYMENT_METHODS) assert.ok(keys.has('book.pay.' + id), 'missing book.pay.' + id);
  for (const status of TRIP_STATUSES) assert.ok(keys.has(core.statusKey(status)), 'missing ' + core.statusKey(status));
  assert.ok(keys.has('status.BOOKED'), 'order status status.BOOKED is missing');
  for (const kind of ['checkpoint', 'pickup', 'delivery']) assert.ok(keys.has('book.kind.' + kind));

  // And every error key a validation can emit has copy.
  const errorKeys = [
    'book.error.formInvalid', 'book.error.originRequired', 'book.error.destinationRequired',
    'book.error.sameRoute', 'book.error.supplyRequired', 'book.error.supplyUnknown',
    'book.error.stopsInvalid', 'book.error.tooManyStops', 'book.error.stopAddressRequired',
    'book.error.equipmentUnknown', 'book.error.dateInvalid', 'book.error.windowOrder',
    'book.error.pricingUnknown', 'book.error.amountInvalid', 'book.error.payerUnknown',
    'book.error.escrowUnavailable', 'book.error.paymentUnknown',
    'signup.error.nameRequired', 'signup.error.emailRequired', 'signup.error.emailInvalid',
    'signup.error.passwordShort', 'signup.error.passwordLong', 'signup.error.phoneInvalid',
    'account.error.nameRequired', 'account.error.addressRequired',
    'error.badRequest', 'error.forbidden', 'error.notFound', 'error.unexpected', 'error.network',
    'error.emailTaken', 'error.noCarrierOrg', 'error.sessionExpired'
  ];
  for (const key of errorKeys) assert.ok(keys.has(key), 'missing error copy ' + key);
});

test('the client module has no console output, no inline handlers and no template injection', () => {
  const js = stripComments(read('customer.js'));
  assert.ok(!/console\./.test(js), 'the portal must not write to the console');
  assert.ok(!/document\.write/.test(js), 'document.write is never acceptable here');
  // No template literals: every dynamic value is concatenated through esc(), so
  // there is no `${}` path that can bypass escaping.
  assert.ok(js.indexOf('`') === -1, 'customer.js must not use template literals');
  assert.ok(!/\$\{/.test(js));
  assert.match(js, /function esc\(/, 'the escaping helper must exist');
  // The wizard/account ids are rendered by this module, so they are resolved
  // from the container, never with the static id helper.
  for (const prefix of ['bk-', 'ad-', 'ac-', 'tm-']) {
    assert.ok(!js.includes("$('" + prefix), "a rendered id must be resolved from its container, not $('" + prefix + "...')");
  }
  assert.match(js, /querySelector\('#bookingForm'\)/);

  const html = read('index.html');
  assert.ok(!/\son(click|submit|change|load|error)=/.test(html), 'no inline event handlers');
  assert.match(html, /role="status"/, 'alerts must be live regions');
  assert.match(html, /class="skip-link"/, 'a skip link is required');
});

test('the stylesheet keeps the accessibility affordances the audit required', () => {
  const css = read('customer.css');
  assert.match(css, /:focus-visible/);
  assert.match(css, /@media \(pointer: coarse\)/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /min-height: 44px/, 'coarse pointers get 44px targets');
  // Mobile-first: the base layout is the phone one, so no max-width queries.
  assert.ok(!/@media \(max-width/.test(css), 'use mobile-first min-width queries');
});
