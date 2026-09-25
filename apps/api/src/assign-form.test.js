/**
 * Assign/reassign driver control (board task #36, FAv1-F5) — dependency-free
 * coverage for the pure half and the wiring.
 *
 * Runs under the no-install CI job (`node --test apps/api/src/`): `node:*`
 * builtins only, no Fastify, no Prisma, no browser. The HTTP-level acceptance
 * lives in `apps/api/test/trip-assign.test.ts` (`pnpm test:router`).
 *
 * What is proven here:
 *   - the option list marks the current driver and never shows a raw id as label;
 *   - validation refuses an empty/unknown/unchanged choice and a closed trip
 *     BEFORE a request is sent;
 *   - every API refusal maps to a catalogue key that exists in `en.json`;
 *   - only owner/dispatcher may assign, and a driver can never open the detail;
 *   - the shell loads `lib/assign.js` between the core and app.js, and app.js
 *     resolves the dynamic controls with `querySelector`, not the `el()` helper.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import assign from '../../../app/lib/assign.js';
import appCore from '../../../app/lib/app-core.js';
import dash from '../../../app/lib/dashboard.js';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '../../../app');
const readApp = (name) => readFileSync(join(appDir, name), 'utf8');

const APP_JS = readApp('app.js');
const PAGE = readApp('index.html');
const CATALOGUE = JSON.parse(readApp('locales/en.json'));

/** A realistic `GET /api/reference` driver list (seeded pilot shape). */
const DRIVERS = [
  { id: 'usr_d1', name: 'Dana Driver', phone: '+31612345678' },
  { id: 'usr_d2', name: 'Sam Second', phone: null }
];

const TRIP = { id: 't1', status: 'ASSIGNED', driver: { id: 'usr_d1', name: 'Dana Driver' } };

// --- paths and small predicates --------------------------------------------

test('assignPath encodes the trip id and never lets it change the path', () => {
  assert.equal(assign.assignPath('t1'), '/api/trips/t1/assign');
  assert.equal(assign.assignPath('a/b?c'), '/api/trips/a%2Fb%3Fc/assign');
  assert.equal(assign.assignPath(null), '/api/trips//assign');
});

test('isClosed covers exactly the terminal statuses', () => {
  for (const status of ['SETTLED', 'CANCELLED']) assert.equal(assign.isClosed(status), true, status);
  for (const status of ['DRAFT', 'ASSIGNED', 'IN_TRANSIT', 'DELIVERED', 'POD_UPLOADED']) {
    assert.equal(assign.isClosed(status), false, status);
  }
  assert.equal(assign.isClosed(undefined), false);
});

test('a same-status event is a reassignment; a lifecycle move is not', () => {
  assert.equal(assign.isReassignment({ from: 'ASSIGNED', to: 'ASSIGNED' }), true);
  assert.equal(assign.isReassignment({ from: 'DRAFT', to: 'ASSIGNED' }), false);
  assert.equal(assign.isReassignment({ from: '', to: '' }), false);
  assert.equal(assign.isReassignment(null), false);
});

// --- the option list --------------------------------------------------------

test('driverEntries marks the current driver and never labels with an id', () => {
  const entries = assign.driverEntries(DRIVERS, 'usr_d1');
  assert.deepEqual(entries[0], { value: 'usr_d1', label: 'Dana Driver · +31612345678', selected: true });
  assert.deepEqual(entries[1], { value: 'usr_d2', label: 'Sam Second', selected: false });
  for (const entry of entries) {
    assert.notEqual(entry.label, entry.value, 'the label must be human, not the id');
    assert.match(entry.label, /\S/);
  }
  assert.deepEqual(assign.driverEntries(null, 'x'), []);
  // A driver with no name falls back to the email, then the id — never blank.
  assert.equal(assign.driverEntries([{ id: 'u', email: 'a@b.c' }], '')[0].label, 'a@b.c');
});

// --- validation -------------------------------------------------------------

test('an empty choice is refused with the required message', () => {
  const check = assign.validateAssign({ driverId: '' }, TRIP, DRIVERS);
  assert.equal(check.ok, false);
  assert.equal(check.errors.driverId, 'assign.error.required');
});

test('a driver not in the loaded list is refused', () => {
  const check = assign.validateAssign({ driverId: 'usr_ghost' }, TRIP, DRIVERS);
  assert.equal(check.errors.driverId, 'assign.error.unknownDriver');
});

test('choosing the driver already on the trip is refused', () => {
  assert.equal(
    assign.validateAssign({ driverId: 'usr_d1' }, TRIP, DRIVERS).errors.driverId,
    'assign.error.alreadyAssigned'
  );
  // The id may arrive as `trip.driverId` rather than the nested relation.
  assert.equal(
    assign.validateAssign({ driverId: 'usr_d1' }, { id: 't1', status: 'ASSIGNED', driverId: 'usr_d1' }, DRIVERS).errors.driverId,
    'assign.error.alreadyAssigned'
  );
});

test('a closed trip is refused before the request', () => {
  const check = assign.validateAssign({ driverId: 'usr_d2' }, { id: 't1', status: 'SETTLED', driver: { id: 'usr_d1' } }, DRIVERS);
  assert.equal(check.errors.driverId, 'assign.error.tripClosed');
});

test('a valid choice yields exactly the assignment payload', () => {
  const check = assign.validateAssign({ driverId: 'usr_d2' }, TRIP, DRIVERS);
  assert.equal(check.ok, true);
  assert.deepEqual(check.payload, { driverId: 'usr_d2' });
});

// --- error mapping ----------------------------------------------------------

test('every assignment failure maps to a readable catalogue key, never a raw status', () => {
  const cases = [
    [{ status: 400, data: { error: 'invalid_input', detail: 'driverId is required' } }, 'assign.error.invalidInput'],
    [{ status: 404, data: { error: 'not_found' } }, 'assign.error.tripNotFound'],
    [{ status: 404, data: { error: 'driver_not_found' } }, 'assign.error.driverNotFound'],
    [{ status: 409, data: { error: 'driver_unavailable' } }, 'assign.error.driverUnavailable'],
    [{ status: 409, data: { error: 'already_assigned' } }, 'assign.error.alreadyAssigned'],
    [{ status: 409, data: { error: 'trip_closed' } }, 'assign.error.tripClosed'],
    [{ status: 409, data: { error: 'something_else' } }, 'assign.error.conflict'],
    [{ status: 403, data: { error: 'forbidden' } }, 'error.forbidden'],
    [{ status: 403, data: { error: 'no_org' } }, 'error.noOrg'],
    [{ status: 401, data: null }, 'error.sessionExpired'],
    [{ status: 429, data: null }, 'error.rateLimited'],
    [{ status: 0, data: { error: 'network' } }, 'error.network'],
    [{ status: 500, data: null }, 'error.unexpected']
  ];
  for (const [res, key] of cases) {
    assert.equal(assign.assignErrorKey(res), key, JSON.stringify(res));
  }
  assert.equal(assign.assignErrorDetail({ data: { detail: 'driverId is required' } }), 'driverId is required');
  assert.equal(assign.assignErrorDetail({}), '');
});

test('every assign catalogue key used by the module and app.js exists in en.json', () => {
  const sources = readApp('lib/assign.js') + '\n' + APP_JS;
  const keys = new Set();
  for (const m of sources.matchAll(/'((?:assign|error)\.[a-zA-Z0-9_.]+)'/g)) keys.add(m[1]);
  assert.ok(keys.size >= 15, `expected many assign/error keys, saw ${keys.size}`);
  const missing = [...keys].filter((key) => !(key in CATALOGUE));
  assert.deepEqual(missing, [], `missing catalogue keys: ${missing.join(', ')}`);
  assert.match(CATALOGUE['assign.assigned'], /\{name\}/);
});

// --- the role model ---------------------------------------------------------

test('only owner and dispatcher hold trip management (trip:*)', () => {
  assert.equal(appCore.canManageTrips('owner'), true);
  assert.equal(appCore.canManageTrips('dispatcher'), true);
  assert.equal(appCore.canManageTrips('driver'), false, 'a driver can never assign');
  assert.equal(appCore.canManageTrips('accountant'), false);
  assert.equal(appCore.canManageTrips('unknown'), false);
  assert.deepEqual(appCore.TRIP_MANAGE_ROLES, ['owner', 'dispatcher']);
  // The detail screen itself is owner/dispatcher only, so a driver never sees it.
  assert.equal(appCore.canOpen('driver', '/app/trips/t1'), false);
  assert.equal(appCore.canOpen('dispatcher', '/app/trips/t1'), true);
});

// --- the timeline / activity labels ----------------------------------------

test('the trip timeline names a reassignment instead of a no-op transition', () => {
  assert.match(APP_JS, /ASSIGN\.isReassignment/);
  assert.match(APP_JS, /trips\.reassigned/);
  assert.match(CATALOGUE['trips.reassigned'], /\{status\}/);
});

test('the dashboard activity labels a same-status event as a reassignment', () => {
  const t = (key, params) => (params ? key + '(' + Object.keys(params).join(',') + ')' : key);
  const items = dash.activityItems(
    {
      activity: [
        { id: 'ev1', from: 'ASSIGNED', to: 'ASSIGNED', at: '2026-09-24T09:00:00.000Z', actor: { id: 'u1', name: 'Olive' }, link: '/app/trips/t1' },
        { id: 'ev2', from: 'DRAFT', to: 'ASSIGNED', at: '2026-09-24T08:00:00.000Z', actor: null, link: '/app/trips/t2' }
      ]
    },
    t
  );
  assert.equal(items[0].text, 'dashboard.activity.reassigned(status)');
  assert.equal(items[0].actor, 'Olive');
  assert.equal(items[1].text, 'trips.status.DRAFT → trips.status.ASSIGNED', 'a lifecycle move is unchanged');
  assert.ok('dashboard.activity.reassigned' in CATALOGUE);
});

// --- wiring -----------------------------------------------------------------

test('the shell loads the assign module between the core and app.js', () => {
  assert.match(PAGE, /<script src="\/app\/lib\/assign\.js"><\/script>/);
  const core = PAGE.indexOf('/app/lib/app-core.js');
  const assignTag = PAGE.indexOf('/app/lib/assign.js');
  const app = PAGE.indexOf('/app/app.js');
  assert.ok(core !== -1 && assignTag !== -1 && app !== -1);
  assert.ok(core < assignTag && assignTag < app, 'assign.js must load between the core and app.js');
  assert.match(APP_JS, /RoadwiseAssign/);
  assert.match(APP_JS, /ASSIGN\.validateAssign/);
  assert.match(APP_JS, /ASSIGN\.assignPath/);
  assert.match(APP_JS, /APP\.canManageTrips/);
});

test('the dynamic assign controls are resolved with querySelector, not the shell el() helper', () => {
  // The shell test asserts every id passed to el/setText/setHidden/show/hide
  // exists in index.html; the assign control is injected into the detail panel,
  // so it must never use those helpers.
  assert.doesNotMatch(APP_JS, /\b(?:el|setText|setHidden|show|hide)\(\s*'assign/);
  assert.match(APP_JS, /assignNode\(outlet/);
});
