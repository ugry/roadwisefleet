/**
 * Tracking-link UI (board task #39, FAv1-F8) — dependency-free coverage for the
 * control's pure half (`app/lib/tracking.js`) and the markup/script drift it
 * depends on.
 *
 * Runs under the no-install CI job (`node --test apps/api/src/`): `node:*`
 * builtins only, no Fastify, no Prisma. The HTTP-level acceptance lives in
 * `apps/api/test/tracking-link.test.ts` (`pnpm test:router`).
 *
 * The point of the control is that the UI never paraphrases the server's rules:
 * the `trip:*` gate is asserted equal to `app-core.js`, the request path is
 * built from one helper, and the token is never composed client-side — only the
 * server's `url` is rendered.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import tracking from '../../../app/lib/tracking.js';
import appCore from '../../../app/lib/app-core.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const appDir = join(repoRoot, 'app');
const readApp = (name) => readFileSync(join(appDir, name), 'utf8');

const APP_JS = readApp('app.js');
const PAGE = readApp('index.html');
const CATALOGUE = JSON.parse(readApp('locales/en.json'));

const NOW = Date.parse('2026-09-25T12:00:00.000Z'); // fixed epoch ms

// --- the shared rules are shared, not restated ------------------------------

test('the managing roles mirror app-core and deny by default', () => {
  assert.deepEqual(tracking.MANAGE_ROLES.slice().sort(), appCore.TRIP_MANAGE_ROLES.slice().sort());
  assert.equal(tracking.TRACK_LINK_PERMISSION, 'trip:*');
  assert.equal(tracking.canManageTracking('owner'), true);
  assert.equal(tracking.canManageTracking('dispatcher'), true);
  assert.equal(tracking.canManageTracking('driver'), false);
  assert.equal(tracking.canManageTracking('accountant'), false);
  assert.equal(tracking.canManageTracking(undefined), false);
  assert.equal(tracking.canManageTracking(' owner '), true);
});

test('the tracking path encodes the id so it can never change the request path', () => {
  assert.equal(tracking.trackingPath('t1'), '/api/trips/t1/track-link');
  assert.equal(tracking.trackingPath('a/b?c'), '/api/trips/a%2Fb%3Fc/track-link');
});

// --- link state -------------------------------------------------------------

test('linkFrom only accepts a real link with a url, and treats null as "none"', () => {
  assert.equal(tracking.linkFrom(null), null);
  assert.equal(tracking.linkFrom({}), null);
  assert.equal(tracking.linkFrom({ link: null }), null);
  assert.equal(tracking.linkFrom({ link: {} }), null);
  assert.equal(tracking.linkFrom({ link: { url: '' } }), null);
  const link = { url: '/track/abc', expiresAt: '2026-10-25T00:00:00.000Z' };
  assert.deepEqual(tracking.linkFrom({ link }), link);
});

test('linkState is none, active or expired — and never invents an active link', () => {
  assert.equal(tracking.linkState(null, NOW), 'none');
  assert.equal(tracking.linkState({}, NOW), 'none');
  assert.equal(tracking.linkState({ url: '/track/abc' }, NOW), 'active');
  assert.equal(tracking.linkState({ url: '/track/abc', expiresAt: '2026-10-25T00:00:00.000Z' }, NOW), 'active');
  assert.equal(tracking.linkState({ url: '/track/abc', expiresAt: '2026-01-01T00:00:00.000Z' }, NOW), 'expired');
  // Exactly at the expiry instant the link is already expired.
  const at = new Date(NOW).toISOString();
  assert.equal(tracking.linkState({ url: '/track/abc', expiresAt: at }, NOW), 'expired');
});

test('stateKey maps every state to a catalogue key and unknown states to none', () => {
  assert.equal(tracking.stateKey('active'), 'tracking.state.active');
  assert.equal(tracking.stateKey('expired'), 'tracking.state.expired');
  assert.equal(tracking.stateKey('none'), 'tracking.state.none');
  assert.equal(tracking.stateKey('anything-else'), 'tracking.state.none');
  assert.equal(tracking.stateKey(undefined), 'tracking.state.none');
});

test('copyTarget is the full shareable URL, never a bare token', () => {
  assert.equal(tracking.copyTarget({ token: 'abc' }), '');
  assert.equal(tracking.copyTarget({ url: 'https://example.test/track/abc' }), 'https://example.test/track/abc');
  assert.equal(tracking.copyTarget(null), '');
});

// --- error mapping ----------------------------------------------------------

test('API failures map to catalogue keys that say what to do', () => {
  assert.equal(tracking.errorKey({ status: 401 }), 'error.sessionExpired');
  assert.equal(tracking.errorKey({ status: 429 }), 'error.rateLimited');
  assert.equal(tracking.errorKey({ status: 0, data: { error: 'network' } }), 'error.network');
  assert.equal(tracking.errorKey(null), 'error.network');
  assert.equal(tracking.errorKey({ status: 403, data: { error: 'forbidden' } }), 'error.forbidden');
  assert.equal(tracking.errorKey({ status: 404, data: { error: 'not_found' } }), 'tracking.error.notFound');
  assert.equal(tracking.errorKey({ status: 400, data: { error: 'invalid_token' } }), 'tracking.error.invalid');
  assert.equal(tracking.errorKey({ status: 400, data: {} }), 'error.badRequest');
  assert.equal(tracking.errorKey({ status: 500, data: null }), 'error.unexpected');
  assert.equal(tracking.errorDetail({ data: { detail: 'not in your company' } }), 'not in your company');
  assert.equal(tracking.errorDetail({ data: {} }), '');
  assert.equal(tracking.errorDetail(null), '');
});

// --- catalogue / wiring drift -----------------------------------------------

test('every tracking.* key the UI can show exists in the catalogue', () => {
  const sources = APP_JS + '\n' + readApp('lib/tracking.js');
  const keys = new Set();
  for (const m of sources.matchAll(/'([a-zA-Z]+\.[a-zA-Z0-9_.]+)'/g)) {
    if (m[1].startsWith('tracking.')) keys.add(m[1]);
  }
  assert.ok(keys.size >= 15, `expected many tracking.* keys, saw ${keys.size}`);
  const missing = [...keys].filter((key) => !(key in CATALOGUE));
  assert.deepEqual(missing, [], `missing catalogue keys: ${missing.join(', ')}`);
});

test('the copy-in-one-action and the revoke confirm read as what they do', () => {
  assert.match(CATALOGUE['tracking.copy'], /copy/i);
  assert.match(CATALOGUE['tracking.confirmRevoke'], /revoke/i);
  assert.match(CATALOGUE['tracking.revoked'], /no longer works/i);
  // The revoke is destructive and confirms before it acts.
  assert.match(APP_JS, /win\.confirm\(T\('tracking\.confirmRevoke'\)\)/);
});

test('the app loads the tracking module before app.js and the route is implemented', () => {
  assert.match(PAGE, /<script src="\/app\/lib\/tracking\.js"><\/script>/);
  assert.ok(PAGE.indexOf('/app/lib/tracking.js') < PAGE.indexOf('/app/app.js'), 'tracking.js loads before app.js');
  assert.ok(existsSync(join(appDir, 'lib/tracking.js')));

  const route = appCore.routeForPath('/app/tracking');
  assert.equal(route.view, 'tracking');
  assert.equal(route.task, null);
  const panel = appCore.panelFor(route, (key) => key);
  assert.equal(panel.body, 'common.loading');
  assert.equal(panel.task, null);
});

test('the control uses the pure module and never composes a token client-side', () => {
  // One helper builds the path; the control never string-concatenates one.
  assert.match(APP_JS, /TRACK\.trackingPath\(/);
  assert.match(APP_JS, /TRACK\.linkFrom\(/);
  assert.match(APP_JS, /TRACK\.copyTarget\(/);
  assert.match(APP_JS, /TRACK\.canManageTracking/);
  assert.match(APP_JS, /TRACK\.stateKey/);
  assert.match(APP_JS, /TRACK\.errorKey/);
  // The rendered URL is always the server's `link.url`; the control never reads
  // `link.token` (the token's only authenticated surface is the acting trip's
  // own detail/list response, and even there the UI shows the URL).
  assert.doesNotMatch(APP_JS, /link\.token/);
  // The workspace list renders state only — its markup never mentions a token.
  const worklist = APP_JS.slice(
    APP_JS.indexOf('function trackingWorklistHtml'),
    APP_JS.indexOf('function bindTrackingWorklist'),
  );
  assert.ok(worklist.length > 0, 'the workspace list renderer is present');
  assert.doesNotMatch(worklist, /token/i);
  // Dynamic ids are resolved from the outlet, never with the shell el() helper.
  assert.doesNotMatch(APP_JS, /el\('track/);
  assert.match(APP_JS, /data-track-action="copy"/);
  assert.match(APP_JS, /data-track-mint/);
  assert.match(APP_JS, /data-track-revoke/);
});
