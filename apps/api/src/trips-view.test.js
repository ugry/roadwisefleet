/**
 * Trips view model + routing (board task #34, FAv1-F3) — dependency-free
 * coverage that runs under the no-install CI job (`node --test apps/api/src/`):
 * `app/lib/trips.js` (filters, query, CSV) and the new dynamic trip-detail
 * route in `app/lib/app-core.js`.
 *
 * The acceptance criteria this file protects:
 *   - "filters combine correctly" — the query carries every filter, encoded;
 *   - "CSV row-for-row matches the filtered list" — the CSV is built from the
 *     exact rows the list rendered, via the shared `tripRow`;
 *   - a trip with no documents/expenses renders an empty state, not a crash —
 *     the shaper never throws on missing relations;
 *   - `/app/trips/<id>` is a real route for dispatch roles only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import trips from '../../../app/lib/trips.js';
import appCore from '../../../app/lib/app-core.js';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '../../../app');
const readApp = (name) => readFileSync(join(appDir, name), 'utf8');
const APP_JS = readApp('app.js');
const PAGE = readApp('index.html');
const CATALOGUE = JSON.parse(readApp('locales/en.json'));

// --- filters ----------------------------------------------------------------

test('normalizeFilters trims, drops empty values and ignores unknown keys', () => {
  assert.deepEqual(trips.normalizeFilters({ status: ' DRAFT ', q: '', foo: 'bar' }), { status: 'DRAFT' });
  assert.deepEqual(trips.normalizeFilters(undefined), {});
  assert.deepEqual(trips.normalizeFilters({ driverId: '   ' }), {});
});

test('buildQuery sends only present filters, in a fixed order, encoded', () => {
  assert.equal(trips.buildQuery({}), '');
  assert.equal(trips.buildQuery({ q: 'a b&c', status: 'DRAFT' }), '?status=DRAFT&q=a%20b%26c');
  assert.equal(trips.tripsPath({ status: 'DRAFT,ASSIGNED' }), '/api/trips?status=DRAFT%2CASSIGNED');
  assert.equal(trips.tripsPath({}), '/api/trips');
});

// --- the CSV ---------------------------------------------------------------

test('the CSV header is stable and the file ends with a newline', () => {
  const csv = trips.toCsv([]);
  assert.equal(csv, trips.CSV_COLUMNS.join(',') + '\r\n');
});

test('the CSV is row-for-row the rows the list rendered', () => {
  const raw = [
    {
      id: 't1', status: 'IN_TRANSIT', rateEur: '1450.5', createdAt: '2026-09-20T08:00:00.000Z',
      order: { origin: 'Berlin', destination: 'Wien', customer: { name: 'ACME, GmbH' } },
      driver: { name: 'Ada' }, truck: { plate: 'B-AB 123' },
    },
    {
      id: 't2', status: 'DRAFT', rateEur: null, createdAt: '2026-09-21T09:30:00.000Z',
      order: { origin: 'Praha', destination: 'Kraków' }, driver: null, truck: null,
    },
  ];
  const rows = raw.map(trips.tripRow);
  const lines = trips.toCsv(raw).split('\r\n').filter((line) => line !== '');
  assert.equal(lines.length, raw.length + 1, 'one header + one line per row');
  // Each data line starts with the same id the list row used.
  assert.match(lines[1], /^t1,/);
  assert.match(lines[2], /^t2,/);
  // Customer with a comma is quoted; the quote character is doubled.
  assert.match(lines[1], /"ACME, GmbH"/);
  // A null rate is an empty cell, never the string "null".
  assert.equal(rows[1].rate_eur, '');
  assert.doesNotMatch(lines[2], /null/);
});

test('CSV escaping handles quotes and newlines', () => {
  const csv = trips.toCsv([{
    id: 't"1', status: 'DRAFT', createdAt: '', rateEur: 1,
    order: { origin: 'A\nB', destination: 'C' },
  }]);
  assert.match(csv, /"t""1"/);
  assert.match(csv, /"A\nB"/);
});

test('the export file name is UTC-dated', () => {
  assert.equal(trips.csvFileName(new Date('2026-09-24T22:10:00.000Z')), 'roadwisefleet-trips-2026-09-24.csv');
});

test('an empty list reads differently with filters than without', () => {
  assert.equal(trips.emptyStateKey({}), 'trips.empty');
  assert.equal(trips.emptyStateKey({ status: 'DRAFT' }), 'trips.emptyFiltered');
  assert.equal(trips.emptyStateKey(undefined), 'trips.empty');
});

test('a missing relation never throws — the shaper degrades to empty cells', () => {
  const row = trips.tripRow({ id: 'x' });
  assert.equal(row.origin, '');
  assert.equal(row.driver, '');
  assert.equal(row.rate_eur, '');
});

// --- routing (app-core) ----------------------------------------------------

test('the trips route is a real view and the detail route is dynamic', () => {
  const list = appCore.routeForPath('/app/trips');
  assert.equal(list.id, 'trips');
  assert.equal(list.view, 'trips');
  const detail = appCore.routeForPath('/app/trips/trip-42');
  assert.equal(detail.id, 'trip-detail');
  assert.equal(detail.view, 'trip-detail');
  assert.equal(detail.params.id, 'trip-42');
  // A trailing slash and an encoded id normalize the same way.
  assert.equal(appCore.routeForPath('/app/trips/trip-42/').params.id, 'trip-42');
  assert.equal(appCore.routeForPath('/app/trips/a%2Fb').params.id, 'a/b');
});

test('the detail route is not in the navigation and follows the list roles', () => {
  const ownerNav = appCore.navFor('owner').map((r) => r.id);
  assert.ok(ownerNav.includes('trips'));
  assert.ok(!ownerNav.includes('trip-detail'));
  assert.equal(appCore.canOpen('owner', '/app/trips/trip-42'), true);
  assert.equal(appCore.canOpen('dispatcher', '/app/trips/trip-42'), true);
  assert.equal(appCore.canOpen('driver', '/app/trips/trip-42'), false);
  assert.equal(appCore.canOpen('accountant', '/app/trips/trip-42'), false);
});

test('a driver deep-linking to a trip detail is redirected to their own trips', () => {
  const decision = appCore.guardDecision({ path: '/app/trips/trip-42', hasToken: true, role: 'driver' });
  assert.equal(decision.action, 'redirect');
  assert.equal(decision.to, '/app/my-trips');
});

test('an unknown /app path still renders not-found, not the detail route', () => {
  assert.equal(appCore.routeForPath('/app/trips/x/y').id, 'not-found');
});

// --- wiring / catalogue drift ----------------------------------------------

test('the shell loads trips.js before app.js', () => {
  const tripsTag = PAGE.indexOf('<script src="/app/lib/trips.js"></script>');
  const appTag = PAGE.indexOf('<script src="/app/app.js"></script>');
  assert.ok(tripsTag !== -1, 'trips.js must be loaded');
  assert.ok(tripsTag < appTag, 'trips.js must load before app.js');
});

test('dynamic filter/table ids are resolved from the outlet, never with the $ helper', () => {
  for (const id of ['filterStatus', 'filterDriver', 'filterFrom', 'filterTo', 'filterQ', 'tripsTableWrap', 'exportCsv']) {
    assert.match(APP_JS, new RegExp(`querySelector\\('#${id}'\\)`), `#${id} must be resolved from its container`);
    assert.doesNotMatch(APP_JS, new RegExp(`\\bel\\('${id}'\\)`), `#${id} must not be looked up with el()`);
  }
  // The static container still exists in the shell.
  assert.match(PAGE, /id="outlet"/);
});

test('every status and doctype the UI can name has a catalogue entry', () => {
  for (const status of trips.TRIP_STATUSES) {
    assert.ok(trips.statusKey(status) in CATALOGUE, `${trips.statusKey(status)} missing`);
  }
  for (const key of ['trips.docType', 'trips.docStatus', 'trips.noDocuments', 'trips.noExpenses', 'trips.timeline', 'trips.pnl']) {
    assert.ok(key in CATALOGUE, `${key} missing`);
  }
});
