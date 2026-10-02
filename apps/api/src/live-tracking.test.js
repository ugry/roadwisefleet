/**
 * Live tracking (board task #107, AND1-A5) — dependency-free coverage for the
 * shared view model (`app/lib/live-tracking.js`) used by BOTH live surfaces
 * (customer portal `customer/`, fleet web app `app/`).
 *
 * Runs under the no-install CI job (`node --test apps/api/src/`): `node:*`
 * builtins only, no Fastify, no Prisma. The HTTP/DB acceptance (scoping,
 * realtime, the `tracking` flag) lives in `apps/api/test/live-tracking.test.ts`
 * (`pnpm test:router`).
 *
 * The point of the module is that the two surfaces cannot disagree: this suite
 * asserts the phase chain is the SAME list as the API's `DRIVER_PHASES`, that
 * both surfaces actually load the module, and that the four states are derived
 * (not restated) from `tracking` + `status`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import live from '../../../pilot/lib/live-tracking.js';
import { DRIVER_PHASES } from './trip-status.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const appDir = join(repoRoot, 'app');
const customerDir = join(repoRoot, 'customer');
const readApp = (name) => readFileSync(join(appDir, name), 'utf8');
const readCustomer = (name) => readFileSync(join(customerDir, name), 'utf8');

const APP_JS = readApp('app.js');
const APP_PAGE = readApp('index.html');
const CUSTOMER_JS = readCustomer('customer.js');
const CUSTOMER_PAGE = readCustomer('index.html');

// --- the shared config is shared, not restated ------------------------------

test('the milestone chain is the API driver phase chain (subset, same order)', () => {
  // Every live milestone is a real driver phase, in the same relative order.
  let last = -1;
  for (const id of live.MILESTONES) {
    const index = DRIVER_PHASES.indexOf(id);
    assert.notEqual(index, -1, `${id} is not a driver phase`);
    assert.ok(index > last, `${id} is out of order`);
    last = index;
  }
  assert.deepEqual(live.MILESTONES, ['ASSIGNED', 'EN_ROUTE', 'AT_PICKUP', 'LOADED', 'IN_TRANSIT', 'AT_DELIVERY', 'DELIVERED']);
});

test('both live surfaces load the one module', () => {
  assert.match(APP_PAGE, /\/pilot\/lib\/live-tracking\.js/);
  // The customer portal is an ES module page: the UMD module loads before it and
  // exposes the global both surfaces read. It lives under the shared `/pilot/`
  // route because the portal never references the dispatcher app (guard in
  // `customer-shell.test.js`).
  assert.match(CUSTOMER_PAGE, /\/pilot\/lib\/live-tracking\.js/);
  assert.match(APP_JS, /RoadwiseLiveTracking/);
  assert.match(CUSTOMER_JS, /RoadwiseLiveTracking/);
});

test('the two live surfaces call the shared state/milestone helpers', () => {
  for (const source of [APP_JS, CUSTOMER_JS]) {
    assert.match(source, /LIVE\.liveState/);
    assert.match(source, /LIVE\.milestoneRows/);
  }
});

// --- the four states ---------------------------------------------------------

test('liveState: not started until tracking is on, completed at delivery', () => {
  assert.equal(live.liveState({ tracking: false, status: 'ASSIGNED' }), 'not_started');
  assert.equal(live.liveState({ tracking: true, status: 'ASSIGNED' }), 'live');
  assert.equal(live.liveState({ tracking: true, status: 'EN_ROUTE' }), 'live');
  assert.equal(live.liveState({ tracking: true, status: 'IN_TRANSIT' }), 'live');
  // Delivery ends live tracking even if a stale flag were still set (board #105).
  assert.equal(live.liveState({ tracking: true, status: 'DELIVERED' }), 'completed');
  assert.equal(live.liveState({ tracking: false, status: 'POD_UPLOADED' }), 'completed');
  assert.equal(live.liveState({ tracking: false, status: 'SETTLED' }), 'completed');
  assert.equal(live.liveState({ tracking: false, status: 'CANCELLED' }), 'cancelled');
  // Missing/unknown input is honest: no tracking, not started.
  assert.equal(live.liveState({}), 'not_started');
  assert.equal(live.liveState({ tracking: 'true', status: 'EN_ROUTE' }), 'not_started');
});

test('stateKey never returns a raw state to the screen', () => {
  assert.equal(live.stateKey('not_started'), 'live.state.notStarted');
  assert.equal(live.stateKey('live'), 'live.state.live');
  assert.equal(live.stateKey('completed'), 'live.state.completed');
  assert.equal(live.stateKey('cancelled'), 'live.state.cancelled');
  assert.equal(live.stateKey('bogus'), 'live.state.notStarted');
});

test('isTrackableStatus: historical and cancelled cargo are never live', () => {
  assert.equal(live.isTrackableStatus('EN_ROUTE'), true);
  assert.equal(live.isTrackableStatus('in_transit'), true);
  assert.equal(live.isTrackableStatus('DELIVERED'), false);
  assert.equal(live.isTrackableStatus('INVOICED'), false);
  assert.equal(live.isTrackableStatus('CANCELLED'), false);
  assert.equal(live.isTrackableStatus(''), false);
});

// --- milestones --------------------------------------------------------------

test('milestoneRows marks reached/current/upcoming', () => {
  const rows = live.milestoneRows('IN_TRANSIT');
  const byId = Object.fromEntries(rows.map((r) => [r.id, r.state]));
  assert.equal(byId.ASSIGNED, 'done');
  assert.equal(byId.EN_ROUTE, 'done');
  assert.equal(byId.AT_PICKUP, 'done');
  assert.equal(byId.LOADED, 'done');
  assert.equal(byId.IN_TRANSIT, 'current');
  assert.equal(byId.AT_DELIVERY, 'todo');
  assert.equal(byId.DELIVERED, 'todo');
  assert.equal(rows.length, live.MILESTONES.length);
});

test('milestoneRows: everything done at/after delivery, nothing current when cancelled', () => {
  const done = live.milestoneRows('SETTLED');
  assert.ok(done.every((r) => r.state === 'done'));
  const cancelled = live.milestoneRows('CANCELLED');
  assert.ok(cancelled.every((r) => r.state !== 'current'));
  // A not-started trip (ASSIGNED, no tracking) still shows ASSIGNED as the
  // current phase — the card exists, tracking simply has not begun.
  const assigned = live.milestoneRows('ASSIGNED');
  assert.equal(assigned[0].state, 'current');
  assert.equal(assigned[1].state, 'todo');
});

test('phaseIndex is -1 for unknown/draft and the end of the chain for back office', () => {
  assert.equal(live.phaseIndex('EN_ROUTE'), 1);
  assert.equal(live.phaseIndex('DELIVERED'), live.MILESTONES.length - 1);
  assert.equal(live.phaseIndex('INVOICED'), live.MILESTONES.length - 1);
  assert.equal(live.phaseIndex('DRAFT'), -1);
  assert.equal(live.phaseIndex('NOPE'), -1);
  assert.equal(live.phaseIndex(''), -1);
});

// --- position ----------------------------------------------------------------

test('normalizePoint rejects unusable positions and coerces numbers', () => {
  assert.equal(live.normalizePoint(null), null);
  assert.equal(live.normalizePoint({ lat: 999, lng: 0, at: 'x' }), null);
  assert.equal(live.normalizePoint({ lat: 'nope', lng: 3 }), null);
  const point = live.normalizePoint({ lat: '52.5', lng: '13.4', accuracyM: '9' });
  assert.deepEqual(point, { lat: 52.5, lng: 13.4, at: null, accuracyM: 9 });
});

test('applyPoint never moves the map backwards (offline replay / out of order)', () => {
  const t1 = '2026-10-01T10:00:00.000Z';
  const t2 = '2026-10-01T10:10:00.000Z';
  let state = live.applyPoint({}, { lat: 52.5, lng: 13.4, at: t2 });
  assert.equal(state.lastPosition.at, t2);
  // An older point from a replayed queue is ignored.
  const after = live.applyPoint(state, { lat: 52.6, lng: 13.5, at: t1 });
  assert.equal(after.lastPosition.at, t2);
  assert.equal(after.lastPosition.lat, 52.5);
  // A newer point wins.
  const newer = live.applyPoint(after, { lat: 52.6, lng: 13.5, at: '2026-10-01T10:20:00.000Z' });
  assert.equal(newer.lastPosition.lat, 52.6);
  // A malformed frame leaves the state untouched.
  assert.equal(live.applyPoint(newer, { lat: 1 }).lastPosition.lat, 52.6);
});

// --- SSE parsing -------------------------------------------------------------

test('parseSseChunk: frames, keep-alive comments, split chunks and bad JSON', () => {
  const first = live.parseSseChunk('', 'event: ready\ndata: {"tripId":"t1"}\n\n: keep-alive\n\nevent: gps\ndata: {"lat":52.5');
  assert.equal(first.events.length, 1);
  assert.deepEqual(first.events[0], { event: 'ready', data: { tripId: 't1' } });
  const second = live.parseSseChunk(first.rest, ',"lng":13.4,"at":"2026-10-01T10:00:00.000Z"}\n\n');
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0].event, 'gps');
  assert.equal(second.events[0].data.lat, 52.5);
  assert.equal(second.rest, '');
  // Malformed JSON is surfaced raw, not thrown.
  const bad = live.parseSseChunk('', 'data: not-json\n\n');
  assert.equal(bad.events[0].data, 'not-json');
});

// --- stream paths ------------------------------------------------------------

test('streamPathForTrip encodes the id', () => {
  assert.equal(live.streamPathForTrip('abc'), '/api/trips/abc/stream');
  assert.equal(live.streamPathForTrip('a/b'), '/api/trips/a%2Fb/stream');
});

test('streamPathForTrackUrl reads the token out of relative and absolute links', () => {
  assert.equal(live.trackTokenFromUrl('/track/tok123'), 'tok123');
  assert.equal(live.trackTokenFromUrl('https://roadwisefleet.com/track/tok123'), 'tok123');
  assert.equal(live.trackTokenFromUrl(''), '');
  assert.equal(live.streamPathForTrackUrl('/track/tok123'), '/api/track/tok123/stream');
  assert.equal(live.streamPathForTrackUrl('https://roadwisefleet.com/track/tok%2F1'), '/api/track/tok%2F1/stream');
  assert.equal(live.streamPathForTrackUrl('/nope'), '');
});
