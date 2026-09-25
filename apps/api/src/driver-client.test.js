/**
 * Driver client (board task #38, FAv1-F7a) — dependency-free guards.
 *
 * Runs in the no-install CI job (`node --test apps/api/src/`), so it imports
 * only pure JS and `node:*` builtins. It loads the SAME `app/lib/driver.js` the
 * browser loads and hands it the SAME `pilot/lib/driver-core.js` and
 * `app/lib/documents.js` the shell hands it, so there is no second copy of a
 * transition table, a size cap or a POD rule to drift.
 *
 * What this covers (the parts a browser is not needed for):
 *   - the role gate, the own-only trip path, and that the screen reuses the
 *     shared rules instead of restating them;
 *   - one-tap actions: every next legal status, the DELIVERED confirm, and the
 *     POD gate shown as a disabled action with a reason;
 *   - the owner directive for issue #41: an over-limit photo is refused BEFORE
 *     any request with a message that names the limit and the remedy, and a
 *     server/proxy rejection is mapped to a driver sentence too;
 *   - the offline queue: dedupe on enqueue, and a sync that removes what it
 *     sent so a reconnect cannot send the same change twice.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
const require = createRequire(import.meta.url);

const DRIVER = require(join(root, 'app', 'lib', 'driver.js'));
const CORE = require(join(root, 'pilot', 'lib', 'driver-core.js'));
const DOCS = require(join(root, 'app', 'lib', 'documents.js'));

const read = (rel) => readFileSync(join(root, rel), 'utf8');
const APP_JS = read(join('app', 'app.js'));
const APP_CORE_JS = read(join('app', 'lib', 'app-core.js'));
const PAGE = read(join('app', 'index.html'));
const CATALOGUE = JSON.parse(read(join('app', 'locales', 'en.json')));

const TRIP = {
  id: 'trip-1',
  status: 'IN_TRANSIT',
  documents: [],
  order: { origin: 'Berlin', destination: 'Warsaw' },
};

test('only a driver may open the driver view', () => {
  assert.equal(DRIVER.canUseDriverView({ roleId: 'driver' }), true);
  for (const role of ['owner', 'dispatcher', 'accountant', '']) {
    assert.equal(DRIVER.canUseDriverView({ roleId: role }), false, role);
  }
  assert.equal(DRIVER.canUseDriverView(null), false);
  assert.equal(DRIVER.canUseDriverView(undefined), false);
});

test('the driver screen reads the own-only endpoint and nothing else', () => {
  assert.equal(DRIVER.myTripsPath(), '/api/driver/trips');
  assert.match(APP_JS, /request\(DRIVER\.myTripsPath\(\)/, 'app.js uses the shared path');
  // A driver read must never be widened to the org list from this screen.
  assert.ok(
    !/renderMyTrips[\s\S]*?request\('\/api\/trips'/.test(APP_JS.slice(APP_JS.indexOf('function renderMyTrips'))),
    'the driver screen never calls /api/trips'
  );
});

test('the shell loads driver.js before app.js and the route is implemented', () => {
  const driverAt = PAGE.indexOf('/app/lib/driver.js');
  const appAt = PAGE.indexOf('/app/app.js');
  assert.ok(driverAt > -1, 'index.html loads lib/driver.js');
  assert.ok(driverAt < appAt, 'driver.js is loaded before app.js');
  assert.match(APP_CORE_JS, /view: 'driver'/, 'the my-trips route carries a real view');
  assert.ok(!/task: 'F7/.test(APP_CORE_JS), 'the F7 placeholder is gone');
});

test('statusActions mirrors the shared core and marks the irreversible + gated ones', () => {
  const actions = DRIVER.statusActions(CORE, TRIP);
  assert.deepEqual(actions.map((a) => a.status), CORE.nextLegalStatuses(TRIP.status));
  const delivered = actions.find((a) => a.status === 'DELIVERED');
  assert.equal(delivered.confirm, true);
  assert.equal(delivered.confirmKey, 'driver.confirm.DELIVERED');
  assert.equal(delivered.blocked, false);

  const gated = DRIVER.statusActions(CORE, { id: 'trip-2', status: 'DELIVERED', documents: [] })
    .find((a) => a.status === 'POD_UPLOADED');
  assert.ok(gated, 'DELIVERED → POD_UPLOADED is offered');
  assert.equal(gated.blocked, true, 'without a POD the action is gated');
  assert.equal(gated.blockedKey, 'driver.podGate');

  const ready = DRIVER.statusActions(CORE, {
    status: 'DELIVERED',
    documents: [{ docType: 'ecmr', status: 'VERIFIED' }],
  }).find((a) => a.status === 'POD_UPLOADED');
  assert.equal(ready.blocked, false, 'a verified eCMR satisfies the gate');
});

test('checklist, POD gate and capture rules come from the shared modules', () => {
  const docs = [{ id: 'd1', docType: 'pod', status: 'UPLOADED' }];
  assert.deepEqual(DRIVER.checklist(CORE, docs), CORE.documentChecklist(docs));
  assert.equal(DRIVER.requiredMissing(CORE, docs), CORE.requiredMissing(docs));
  assert.equal(DRIVER.podReady(CORE, 'DELIVERED', docs), CORE.canMarkPodUploaded('DELIVERED', docs));

  const meta = DRIVER.captureMeta(CORE, { capturedAt: '2026-09-25T10:00:00Z', geo: { lat: 52.5, lng: 13.4, accuracy: 12 } });
  assert.equal(meta.ok, true);
  assert.equal(meta.value.lat, 52.5);
  const bad = DRIVER.captureMeta(CORE, { capturedAt: '2999-01-01T00:00:00Z' });
  assert.equal(bad.ok, false);
  assert.equal(bad.key, 'capture.futureTimestamp');
});

test('an over-limit photo is refused before any request, naming the limit and the remedy', () => {
  const overLimit = DRIVER.photoCheck(DOCS, { docType: 'pod', mimeType: 'image/jpeg', size: 31 * 1024 * 1024 });
  assert.equal(overLimit.ok, false);
  assert.equal(overLimit.field, 'file');
  assert.equal(overLimit.key, 'docs.error.tooLarge');
  assert.equal(overLimit.params.size, '31 MB');
  assert.equal(overLimit.params.max, '10 MB');
  const message = CATALOGUE[overLimit.key];
  assert.match(message, /\{size\}/);
  assert.match(message, /\{max\}/);
  assert.match(message, /smaller/i);

  const atLimit = DRIVER.photoCheck(DOCS, { docType: 'pod', mimeType: 'image/jpeg', size: 10 * 1024 * 1024 });
  assert.equal(atLimit.ok, true, 'exactly the cap is allowed');

  const wrongType = DRIVER.photoCheck(DOCS, { docType: 'pod', mimeType: 'image/gif', size: 1024 });
  assert.equal(wrongType.ok, false);
  assert.equal(wrongType.key, 'docs.error.mime');
});

test('a server or proxy rejection is a driver sentence, never a raw code', () => {
  const api = DRIVER.uploadError(DOCS, { status: 400, data: { error: 'file_too_large' } });
  assert.equal(api.key, 'driver.photo.tooLargeServer');
  assert.equal(api.params.max, '10 MB');
  assert.match(CATALOGUE[api.key], /smaller/i);

  const proxy = DRIVER.uploadError(DOCS, { status: 413, data: null });
  assert.equal(proxy.key, 'driver.photo.tooLargeServer');

  const forbidden = DRIVER.uploadError(DOCS, { status: 403, data: { error: 'forbidden' } });
  assert.equal(forbidden.key, 'error.forbidden');
  const network = DRIVER.uploadError(DOCS, { status: 0 });
  assert.equal(network.key, 'error.network');
});

test('the queue dedupes on enqueue and a sync removes what it sent (no duplication)', () => {
  const at = 1000;
  const item = CORE.makeQueueItem({ kind: 'status', id: DRIVER.queueId('status', 'trip-1', at), tripId: 'trip-1', at, payload: { status: 'DELIVERED' } });
  const first = DRIVER.enqueue(CORE, [], item);
  assert.equal(first.added, true);
  assert.equal(first.queue.length, 1);

  const again = DRIVER.enqueue(CORE, first.queue, item);
  assert.equal(again.added, false);
  assert.equal(again.reason, 'duplicate');
  assert.equal(again.queue.length, 1, 'a double tap cannot queue twice');

  const plan = DRIVER.syncPlan(CORE, again.queue, true);
  assert.equal(plan.send.length, 1);
  const folded = DRIVER.syncResults(CORE, again.queue, [{ id: item.id, ok: true, status: 200 }]);
  assert.deepEqual(folded.sent, [item.id]);
  assert.equal(folded.queue.length, 0, 'the sent item leaves the queue');

  const reconnect = DRIVER.syncPlan(CORE, folded.queue, true);
  assert.equal(reconnect.send.length, 0, 'a second reconnect sends nothing');
  assert.deepEqual(DRIVER.syncPlan(CORE, again.queue, false).send, [], 'offline sends nothing');
});

test('a failed send is retried, a permanent one is dropped and reported', () => {
  const base = (id) => CORE.makeQueueItem({ kind: 'status', id: id, tripId: 'trip-1', at: 1, payload: { status: 'LOADED' } });
  const queue = [base('a'), base('b'), base('c')];
  const folded = DRIVER.syncResults(CORE, queue, [
    { id: 'a', ok: true, status: 200 },
    { id: 'b', ok: false, status: 400, error: 'invalid_transition' },
    { id: 'c', ok: false, status: 503, error: 'upstream' },
  ]);
  assert.deepEqual(folded.sent, ['a']);
  assert.deepEqual(folded.dropped.map((d) => d.id), ['b']);
  assert.deepEqual(folded.retried, ['c']);
  assert.equal(folded.queue.length, 1);
  assert.equal(folded.queue[0].attempts, 1);
});

test('the persisted queue degrades safely and refuses to grow past the storage cap', () => {
  assert.deepEqual(DRIVER.parseQueue('{not json'), []);
  assert.deepEqual(DRIVER.parseQueue(null), []);
  assert.deepEqual(DRIVER.parseQueue('[1,2]'), [1, 2]);
  const small = [{ id: 'a', kind: 'status', tripId: 't1', at: 1, payload: {} }];
  assert.equal(DRIVER.queueFits(small), true);
  assert.equal(DRIVER.queueFits([{ id: 'a', payload: { dataBase64: 'x'.repeat(200) } }], 50), false);
  assert.equal(DRIVER.indicator(CORE, [], { online: false }).labelKey, 'driver.sync.offline');
  assert.equal(DRIVER.indicator(CORE, small, { online: true }).state, 'pending');
  assert.equal(DRIVER.indicator(CORE, [], { online: true }).state, 'synced');
});

test('every driver catalogue key the screen can render exists in en.json', () => {
  const sources = APP_JS + read(join('app', 'lib', 'driver.js'));
  const keys = new Set();
  for (const m of sources.matchAll(/'((?:driver|docs|capture)\.[a-zA-Z0-9_.]+)'/g)) {
    // A trailing dot is a dynamic prefix (`'driver.action.' + status`); the
    // concrete keys are enumerated below.
    if (!m[1].endsWith('.')) keys.add(m[1]);
  }
  const missing = [...keys].filter((k) => !Object.prototype.hasOwnProperty.call(CATALOGUE, k));
  assert.deepEqual(missing, [], `missing catalogue keys: ${missing.join(', ')}`);

  for (const status of ['DRAFT', 'ASSIGNED', 'LOADED', 'IN_TRANSIT', 'DELIVERED', 'POD_UPLOADED', 'INVOICED', 'SETTLED', 'CANCELLED']) {
    assert.ok(CATALOGUE[DRIVER.statusKey(status)] || CATALOGUE['trips.status.' + status], `trips.status.${status}`);
  }
  for (const status of CORE.CONFIRM_STATUSES) {
    assert.ok(CATALOGUE[DRIVER.confirmKey(status)], `driver.confirm.${status}`);
  }
  for (const status of ['ASSIGNED', 'LOADED', 'IN_TRANSIT', 'DELIVERED', 'POD_UPLOADED', 'CANCELLED']) {
    assert.ok(CATALOGUE[DRIVER.actionKey(status)], `driver.action.${status}`);
  }
});

test('the driver screen resolves dynamic ids from the outlet, never the shell $ helper', () => {
  const start = APP_JS.indexOf('function renderMyTrips(');
  const end = APP_JS.indexOf('function showLogin(');
  assert.ok(start > -1 && end > start, 'the driver section is present');
  const section = APP_JS.slice(start, end);
  assert.match(section, /outlet\.querySelector\('#myTripsBody'\)/);
  assert.ok(!/\bel\('#my/.test(section), 'dynamic ids are not looked up globally');
  assert.ok(!/\$\('#my/.test(section), 'the shell $ helper is not used for dynamic ids');
});
