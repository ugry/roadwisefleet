/**
 * Driver PWA v1 (board task #4) — dependency-free coverage for the shared
 * driver core (`pilot/lib/driver-core.js`), the PWA assets and the page wiring.
 *
 * Runs under the no-install CI job (`node --test apps/api/src/`), so it imports
 * only `node:*` builtins plus the CJS driver core and the ESM state machine.
 * The HTTP-level assertions on the same assets live in
 * `apps/api/test/driver-pwa.test.ts` (`pnpm test:router`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import driverCore from '../../../pilot/lib/driver-core.js';
import { TRANSITIONS, TRIP_STATUSES, nextStatuses } from './trip-status.js';
import { DOC_TYPES, POD_DOC_TYPES } from './documents.js';

const here = dirname(fileURLToPath(import.meta.url));
const pilotDir = resolve(here, '../../../pilot');
const readPilot = (name) => readFileSync(resolve(pilotDir, name), 'utf8');

const MANIFEST = JSON.parse(readPilot('manifest.webmanifest'));
const PAGE = readPilot('driver.html');
const SW = readPilot('sw.js');
const CORE = readPilot('lib/driver-core.js');

// --- the page's script and the service worker must at least parse -----------

test('the driver page inline script parses as JavaScript', () => {
  const blocks = PAGE.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g) || [];
  assert.equal(blocks.length, 1, 'exactly one inline script expected');
  const body = /** @type {RegExpMatchArray} */ (blocks[0].match(/<script[^>]*>([\s\S]*?)<\/script>/))[1];
  assert.doesNotThrow(() => new Function(body)); // compiles = no syntax error
});

test('the service worker parses as JavaScript', () => {
  assert.doesNotThrow(() => new Function(SW));
});

test('the shared driver core parses and exposes its API in a browser global', () => {
  assert.match(CORE, /root\.RoadwiseDriverCore = api/);
  assert.match(CORE, /typeof module === 'object' && module\.exports/);
});

// --- state machine parity with the API (the API stays authoritative) --------

test('the mirrored transition table is identical to the server state machine', () => {
  assert.deepEqual(Object.keys(driverCore.TRANSITIONS).sort(), [...TRIP_STATUSES].sort());
  for (const status of TRIP_STATUSES) {
    assert.deepEqual(
      driverCore.nextLegalStatuses(status),
      [...nextStatuses(status)],
      `next statuses for ${status} must match the API`,
    );
    assert.deepEqual([...TRANSITIONS[status]], [...nextStatuses(status)]);
  }
});

test('the mirrored document lists match documents.js', () => {
  assert.deepEqual([...driverCore.DOC_TYPES].sort(), [...DOC_TYPES].sort());
  assert.deepEqual([...driverCore.POD_DOC_TYPES].sort(), [...POD_DOC_TYPES].sort());
});

test('nextLegalStatuses never hands back a mutable internal list', () => {
  const next = driverCore.nextLegalStatuses('DRAFT');
  next.push('SETTLED');
  assert.deepEqual(driverCore.nextLegalStatuses('DRAFT'), ['ASSIGNED', 'CANCELLED']);
  assert.deepEqual(driverCore.nextLegalStatuses('nonsense'), []);
  assert.equal(driverCore.isTerminal('SETTLED'), true);
  assert.equal(driverCore.isTerminal('DELIVERED'), false);
});

test('only DELIVERED asks the driver for an explicit confirmation', () => {
  assert.equal(driverCore.requiresConfirmation('DELIVERED'), true);
  for (const status of TRIP_STATUSES.filter((s) => s !== 'DELIVERED')) {
    assert.equal(driverCore.requiresConfirmation(status), false, `${status} must not prompt`);
  }
});

// --- tour card, checklist and the POD gate ---------------------------------

const ORDER = { origin: 'Munich, DE', destination: 'Vienna, AT', cargo: 'Refrigerated goods' };
const TRUCK = { plate: 'RW-001', euroClass: 'Euro 6' };
const EVENTS = [
  { fromStatus: 'DRAFT', toStatus: 'ASSIGNED', happenedAt: new Date('2026-09-22T08:00:00Z') },
];

/** A trip shaped like `GET /api/driver/trips` (Prisma Decimal → string). */
const trip = (extra = {}) => ({
  id: 'pilot-trip-2',
  status: 'DELIVERED',
  rateEur: '1450',
  order: ORDER,
  truck: TRUCK,
  stops: [],
  statusEvents: EVENTS,
  documents: [],
  ...extra,
});

test('buildTourCard shapes route, cargo, truck, rate and the ETA placeholder', () => {
  const card = driverCore.buildTourCard(trip());
  assert.equal(card.id, 'pilot-trip-2');
  assert.deepEqual(card.route, { origin: 'Munich, DE', destination: 'Vienna, AT' });
  assert.equal(card.cargo, 'Refrigerated goods');
  assert.deepEqual(card.truck, { plate: 'RW-001', euroClass: 'Euro 6' });
  assert.equal(card.rateEur, 1450);
  assert.equal(card.eta, null);
  assert.equal(card.etaKey, 'driver.etaUnavailable', 'the pilot must not invent an ETA');
  assert.deepEqual(card.nextStatuses, ['POD_UPLOADED']);
  assert.equal(card.requiredMissing, 1, 'the POD gate is one requirement, not two');
  assert.equal(card.podSatisfied, false);
  assert.deepEqual(card.updatedAt, EVENTS[0].happenedAt);
});

test('buildTourCard survives a bare trip with no relations', () => {
  const card = driverCore.buildTourCard({ id: 't', status: 'DRAFT' });
  assert.deepEqual(card.route, { origin: null, destination: null });
  assert.equal(card.rateEur, null);
  assert.equal(card.truck.plate, null);
  assert.equal(card.updatedAt, null);
  assert.deepEqual(card.nextStatuses, ['ASSIGNED', 'CANCELLED']);
});

test('the checklist marks only uploaded/verified documents as present', () => {
  const docs = [
    { id: 'd1', docType: 'pod', status: 'PENDING' },
    { id: 'd2', docType: 'e_irsaliye', status: 'UPLOADED' },
  ];
  const rows = driverCore.documentChecklist(docs);
  const byType = Object.fromEntries(rows.map((r) => [r.docType, r]));
  assert.equal(byType.pod.present, false, 'PENDING is not an attached document');
  assert.equal(byType.pod.required, true);
  assert.equal(byType.pod.alternative, false);
  assert.equal(byType.ecmr.alternative, true, 'an eCMR is the alternative to a POD, not a second requirement');
  assert.equal(byType.e_irsaliye.present, true);
  assert.equal(byType.e_irsaliye.required, false);
  assert.equal(byType.pod.documentId, 'd1');
  assert.equal(byType.ecmr.documentId, null);
  assert.equal(driverCore.requiredMissing(docs), 1, 'neither a pod nor an ecmr is attached yet');
  assert.equal(driverCore.requiredMissing([{ docType: 'ecmr', status: 'UPLOADED' }]), 0);
  assert.equal(driverCore.hasPresentDocument(docs, 'pod'), false);
  assert.equal(driverCore.hasPresentDocument(docs, 'e_irsaliye'), true);
});

test('podSatisfied needs an uploaded/verified pod or ecmr', () => {
  assert.equal(driverCore.podSatisfied([]), false);
  assert.equal(driverCore.podSatisfied([{ docType: 'invoice', status: 'UPLOADED' }]), false);
  assert.equal(driverCore.podSatisfied([{ docType: 'pod', status: 'PENDING' }]), false);
  assert.equal(driverCore.podSatisfied([{ docType: 'pod', status: 'UPLOADED' }]), true);
  assert.equal(driverCore.podSatisfied([{ docType: 'ecmr', status: 'VERIFIED' }]), true);
});

test('canMarkPodUploaded mirrors the server pod_required gate', () => {
  assert.equal(driverCore.canMarkPodUploaded('DELIVERED', [{ docType: 'pod', status: 'UPLOADED' }]), true);
  assert.equal(driverCore.canMarkPodUploaded('DELIVERED', []), false);
  assert.equal(driverCore.canMarkPodUploaded('IN_TRANSIT', [{ docType: 'pod', status: 'UPLOADED' }]), false);
});

test('pickCurrentTrip prefers the trip still in play', () => {
  const settled = { id: 'old', status: 'SETTLED' };
  const active = { id: 'new', status: 'ASSIGNED' };
  assert.equal(driverCore.pickCurrentTrip([settled, active]).id, 'new');
  assert.equal(driverCore.pickCurrentTrip([settled]).id, 'old');
  assert.equal(driverCore.pickCurrentTrip([]), null);
  assert.equal(driverCore.pickCurrentTrip(undefined), null);
});

// --- capture metadata (mirrors documents.js#normalizeCapture) --------------

test('normalizeCapture keeps a valid fix and a valid timestamp', () => {
  const now = Date.parse('2026-09-23T12:00:00Z');
  const result = driverCore.normalizeCapture({ capturedAt: '2026-09-23T11:59:00Z', geo: { lat: 52.52, lng: 13.405, accuracy: 11.4 }, now });
  assert.equal(result.ok, true);
  assert.equal(result.value.capturedAt, '2026-09-23T11:59:00.000Z');
  assert.equal(result.value.lat, 52.52);
  assert.equal(result.value.lng, 13.405);
  assert.equal(result.value.accuracyM, 11);
});

test('normalizeCapture allows a missing GPS fix but not a malformed one', () => {
  const now = Date.parse('2026-09-23T12:00:00Z');
  const noFix = driverCore.normalizeCapture({ capturedAt: '2026-09-23T11:00:00Z', geo: null, now });
  assert.equal(noFix.ok, true);
  assert.equal(noFix.value.lat, null);
  assert.equal(noFix.value.accuracyM, null);
  assert.equal(driverCore.normalizeCapture({ geo: { lat: 200, lng: 0 }, now }).error, 'invalid_capture');
  assert.equal(driverCore.normalizeCapture({ geo: { lat: 1 }, now }).error, 'invalid_capture');
  assert.equal(driverCore.normalizeCapture({ capturedAt: 'soon', now }).error, 'invalid_capture');
  assert.equal(driverCore.normalizeCapture({ capturedAt: new Date(now + 72 * 3600 * 1000).toISOString(), now }).error, 'invalid_capture');
});

test('captureCoords hands the page numbers, never a sentence', () => {
  assert.deepEqual(driverCore.captureCoords({ lat: 52.5200, lng: 13.4050, accuracyM: 12 }), { lat: '52.5200', lng: '13.4050', accuracyM: 12 });
  assert.deepEqual(driverCore.captureCoords({ lat: 1, lng: 2, accuracyM: null }), { lat: '1.0000', lng: '2.0000', accuracyM: null });
  assert.equal(driverCore.captureCoords({ lat: null, lng: null }), null);
  assert.equal(driverCore.captureCoords(null), null);
});

test('isUsableFix rejects a uselessly coarse or absent position', () => {
  assert.equal(driverCore.isUsableFix({ coords: { accuracy: 25 } }), true);
  assert.equal(driverCore.isUsableFix({ coords: { accuracy: 999999 } }), false);
  assert.equal(driverCore.isUsableFix({ coords: {} }), false);
  assert.equal(driverCore.isUsableFix(null), false);
});

// --- offline queue ---------------------------------------------------------

const statusItem = (id, at) => driverCore.makeQueueItem({ id, kind: 'status', tripId: 't1', at, payload: { status: 'LOADED' } });
const docItem = (id, at) =>
  driverCore.makeQueueItem({ id, kind: 'document', tripId: 't1', at, payload: { docType: 'pod' }, photo: { name: 'pod.jpg' } });

test('makeQueueItem refuses items the sync engine could not replay', () => {
  assert.throws(() => driverCore.makeQueueItem({ id: 'a', kind: 'teleport', tripId: 't1' }), /kind/);
  assert.throws(() => driverCore.makeQueueItem({ kind: 'status', tripId: 't1' }), /id/);
  assert.throws(() => driverCore.makeQueueItem({ id: 'a', kind: 'status' }), /tripId/);
  const item = statusItem('a', 5);
  assert.equal(item.attempts, 0);
  assert.equal(item.photo, null);
});

test('the queue replays oldest first so a trip’s changes keep their order', () => {
  const sorted = driverCore.sortQueue([docItem('late', 2000), statusItem('early', 1000)]);
  assert.deepEqual(sorted.map((i) => i.id), ['early', 'late']);
});

test('planQueueSync sends nothing while offline and everything when online', () => {
  const items = [docItem('b', 2000), statusItem('a', 1000)];
  const offline = driverCore.planQueueSync(items, { online: false });
  assert.deepEqual(offline.send, []);
  assert.deepEqual(offline.deferred.map((i) => i.id), ['a', 'b']);
  assert.equal(offline.reason, 'offline');

  const online = driverCore.planQueueSync(items, { online: true });
  assert.deepEqual(online.send.map((i) => i.id), ['a', 'b']);
  assert.deepEqual(online.deferred, []);
});

test('a capture is sent before the status change that depends on it', () => {
  const items = [statusItem('after', 2000), docItem('photo', 1000)];
  assert.deepEqual(driverCore.planQueueSync(items, { online: true }).send.map((i) => i.id), ['photo', 'after']);
  assert.equal(driverCore.isCaptureItem(items[1]), true);
  assert.equal(driverCore.isCaptureItem(items[0]), false);
});

test('classifyFailure retries what can succeed and drops what cannot', () => {
  assert.equal(driverCore.classifyFailure(0), 'retry', 'network failure');
  assert.equal(driverCore.classifyFailure(undefined), 'retry');
  assert.equal(driverCore.classifyFailure(500), 'retry');
  assert.equal(driverCore.classifyFailure(503), 'retry');
  assert.equal(driverCore.classifyFailure(429), 'retry');
  assert.equal(driverCore.classifyFailure(408), 'retry');
  assert.equal(driverCore.classifyFailure(400), 'drop');
  assert.equal(driverCore.classifyFailure(401), 'drop');
  assert.equal(driverCore.classifyFailure(403), 'drop');
  assert.equal(driverCore.classifyFailure(413), 'drop');
});

test('applySyncResults removes sent items, drops rejected ones and retries the rest', () => {
  const queue = [statusItem('ok', 1), statusItem('bad', 2), statusItem('later', 3)];
  const applied = driverCore.applySyncResults(queue, [
    { id: 'ok', ok: true, status: 200 },
    { id: 'bad', ok: false, status: 400, error: 'invalid_transition' },
  ]);
  assert.deepEqual(applied.sent, ['ok']);
  assert.deepEqual(applied.dropped, [{ id: 'bad', status: 400, error: 'invalid_transition' }]);
  assert.deepEqual(applied.retried, []);
  assert.deepEqual(applied.queue.map((i) => i.id), ['later']);
  assert.equal(queue.length, 3, 'the input array is never mutated');
});

test('applySyncResults keeps a network failure queued with its attempt bumped', () => {
  const applied = driverCore.applySyncResults([statusItem('net', 1)], [{ id: 'net', ok: false, status: 0, error: 'network' }]);
  assert.deepEqual(applied.sent, []);
  assert.deepEqual(applied.dropped, []);
  assert.deepEqual(applied.retried, ['net']);
  assert.equal(applied.queue.length, 1);
  assert.equal(applied.queue[0].attempts, 1);
  assert.equal(applied.queue[0].payload.status, 'LOADED', 'the payload survives the retry');
});

test('syncIndicator reports one clear state for the header chip', () => {
  const items = [statusItem('a', 1)];
  assert.equal(driverCore.syncIndicator([], { online: true }).state, 'synced');
  assert.equal(driverCore.syncIndicator(items, { online: false }).state, 'offline');
  assert.equal(driverCore.syncIndicator(items, { online: false }).labelKey, 'driver.sync.offline');
  assert.equal(driverCore.syncIndicator(items, { online: false }).pending, 1);
  assert.equal(driverCore.syncIndicator(items, { online: true, syncing: true }).state, 'syncing');
  assert.equal(driverCore.syncIndicator(items, { online: true, lastError: 'boom' }).state, 'error');
  const pending = driverCore.syncIndicator(items, { online: true });
  assert.equal(pending.state, 'pending');
  assert.equal(pending.pending, 1);
  assert.equal(pending.labelKey, 'driver.sync.pending');
  assert.equal(driverCore.syncIndicator([], { online: true }).labelKey, 'driver.sync.synced');
});

test('queueItemUrl/Method map a queued item onto the documents and status APIs', () => {
  assert.equal(driverCore.queueItemUrl(statusItem('a', 1)), '/api/trips/t1/status');
  assert.equal(driverCore.queueItemUrl(docItem('b', 2)), '/api/trips/t1/documents');
  assert.equal(driverCore.queueItemUrl({ kind: 'x', tripId: 't1' }), null);
  assert.equal(driverCore.queueItemMethod(), 'POST');
  assert.equal(driverCore.queueItemUrl(driverCore.makeQueueItem({ id: 'c', kind: 'status', tripId: 'a/b', at: 1 })), '/api/trips/a%2Fb/status');
});

// --- PWA wiring: manifest, service worker, page ----------------------------

test('the manifest is installable and scoped to the pilot surface', () => {
  assert.equal(MANIFEST.name, 'RoadwiseFleet Driver');
  assert.equal(MANIFEST.display, 'standalone');
  assert.equal(MANIFEST.start_url, '/pilot/driver.html');
  assert.equal(MANIFEST.scope, '/pilot/');
  assert.ok(MANIFEST.background_color && MANIFEST.theme_color, 'installability needs both colours');
  const sizes = MANIFEST.icons.map((i) => i.sizes);
  assert.ok(sizes.includes('192x192'), 'Chrome requires a 192px icon');
  assert.ok(sizes.includes('512x512'), 'Chrome requires a 512px icon');
  assert.ok(MANIFEST.icons.some((i) => i.purpose === 'maskable'), 'a maskable icon keeps Android from cropping it');
});

test('every manifest icon exists and is a PNG of the declared size', () => {
  for (const icon of MANIFEST.icons) {
    const path = resolve(pilotDir, icon.src);
    assert.ok(existsSync(path), `${icon.src} must exist`);
    const buf = readFileSync(path);
    assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${icon.src} must be a PNG`);
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    assert.equal(`${width}x${height}`, icon.sizes, `${icon.src} must be ${icon.sizes}`);
  }
});

test('the service worker caches the shell (i18n included) and never caches API data', () => {
  assert.match(SW, /var CACHE_NAME = 'rwf-driver-shell-v2'/);
  assert.match(SW, /\.\/driver\.html/);
  assert.match(SW, /\.\/lib\/driver-core\.js/);
  assert.match(SW, /\.\/lib\/i18n\.js/);
  assert.match(SW, /\.\/locales\/de\.json/, 'a driver must be able to switch language offline');
  assert.match(SW, /caches\.delete/, 'old caches must be dropped on activate');
  assert.match(SW, /url\.pathname\.indexOf\('\/api\/'\) === 0/, 'API requests must be excluded from the shell cache');
});

test('the page declares a mobile viewport, the manifest and a camera input', () => {
  assert.match(PAGE, /<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">/);
  assert.match(PAGE, /<link rel="manifest" href="manifest\.webmanifest">/);
  assert.match(PAGE, /<meta name="theme-color"/);
  assert.match(PAGE, /capture="environment"/, 'POD capture must open the rear camera');
  assert.match(PAGE, /<script src="lib\/driver-core\.js"><\/script>/);
  assert.match(PAGE, /navigator\.serviceWorker\.register\('sw\.js'/);
  assert.match(PAGE, /beforeinstallprompt/);
});

test('the page drives every next legal status through the shared core', () => {
  assert.match(PAGE, /core\.nextLegalStatuses\(/);
  assert.match(PAGE, /core\.requiresConfirmation\(/);
  assert.match(PAGE, /core\.buildTourCard\(/);
  assert.match(PAGE, /card\.checklist\.forEach/, 'the checklist comes from the shared core card');
  assert.match(PAGE, /core\.CHECKLIST/, 'the capture type list is the shared checklist, not a second copy');
  assert.match(PAGE, /core\.normalizeCapture\(/);
  assert.match(PAGE, /core\.planQueueSync\(/);
  assert.match(PAGE, /core\.applySyncResults\(/);
  assert.match(PAGE, /core\.syncIndicator\(/);
  // The old page mirrored its own transition table; it must not come back.
  assert.ok(!/var TRANSITIONS = \{/.test(PAGE), 'the page must use the shared core, not a private copy');
});

test('the page only ever reads the driver’s own trips from /api/driver/trips', () => {
  assert.match(PAGE, /'\/api\/driver\/trips'/);
  assert.ok(!/'\/api\/trips\?/.test(PAGE), 'the driver page must not list all org trips');
  assert.match(PAGE, /window\.confirm\(t\('driver\.confirmStatus'/, 'the confirmation text is translated');
});

test('the driver page renders every string from the locale catalogues', () => {
  // Board task #6: no English literal is rendered directly — text nodes and
  // placeholders carry a data-i18n binding, and the dynamic strings come from
  // the translator. `i18n.test.js` owns the full-page scan; this keeps the PWA
  // suite honest about its own page.
  assert.match(PAGE, /<script src="lib\/i18n\.js"><\/script>/);
  assert.match(PAGE, /<script src="lib\/i18n-ui\.js"><\/script>/);
  assert.match(PAGE, /window\.RoadwiseI18nUI\.init\(/);
  assert.match(PAGE, /t\('driver\.updateStatus'\)/);
  assert.match(PAGE, /statusLabel\(/);
  assert.match(PAGE, /actionLabel\(/);
  assert.ok(!/var ACTION_LABELS = \{/.test(PAGE), 'the action labels moved into the catalogues');
});

test('offline captures are queued, not dropped, and the browser storage degrades safely', () => {
  assert.match(PAGE, /window\.indexedDB\.open\(DB_NAME, DB_VERSION\)/);
  assert.match(PAGE, /memoryQueue/, 'a WebView without IndexedDB still queues in memory');
  assert.match(PAGE, /window\.addEventListener\('online'/);
  assert.match(PAGE, /window\.addEventListener\('offline'/);
  assert.match(PAGE, /navigator\.onLine/);
  assert.match(PAGE, /data-discard/, 'a driver must be able to discard a bad queued item');
});

test('every element the page looks up by id is actually rendered', () => {
  // The cheapest guard against a runtime TypeError (and a console error, which
  // the acceptance criteria forbid): ids come from the static markup *or* from
  // the card template, so both count.
  const ids = new Set([...PAGE.matchAll(/byId\('([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]));
  assert.ok(ids.size >= 8, `expected several id lookups, found ${ids.size}`);
  for (const id of ids) {
    assert.match(PAGE, new RegExp(`id="${id}"`), `#${id} is looked up but never rendered`);
  }
});

test('no secret is baked into the driver surface', () => {
  for (const [name, source] of [['driver.html', PAGE], ['sw.js', SW], ['driver-core.js', CORE], ['manifest.webmanifest', JSON.stringify(MANIFEST)]]) {
    assert.ok(!/AUTH_SECRET|TRACK_LINK_SECRET|Bearer\s+[A-Za-z0-9._-]{20,}|passwordHash/.test(source), `${name} must not contain a secret`);
  }
});
