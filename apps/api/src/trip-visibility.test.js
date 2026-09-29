/**
 * Trip read visibility (board task #68, UG#38 read isolation) — unit tests.
 *
 * Dependency-free: only `node:*` builtins and the two source modules. It runs in
 * the no-install CI job (`node --test apps/api/src/`).
 *
 * The DB-backed half — a real driver token against the real routes — is
 * `../test/trip-driver-scope.test.ts` (`pnpm --filter @roadwisefleet/api
 * test:router`), which needs `fastify` and the database.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ORG_WIDE_TRIP_PERMISSION,
  canReadTrip,
  isOrgWideTripReader,
  tripReadScope,
} from './trip-visibility.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(resolve(here, name), 'utf8');

/** The seeded role capabilities (scripts/seed-pilot.ts). */
const OWNER = ['org:manage', 'user:manage', 'trip:*', 'invoice:*', 'settlement:*', 'reports:read'];
const DISPATCHER = ['trip:*', 'user:read', 'reports:read'];
const ACCOUNTANT = ['invoice:*', 'settlement:*', 'reports:read'];
const DRIVER = ['trip:read', 'trip:status', 'pod:upload', 'expense:create'];

test('only owner and dispatcher are org-wide trip readers', () => {
  assert.equal(isOrgWideTripReader(OWNER), true);
  assert.equal(isOrgWideTripReader(DISPATCHER), true);
  assert.equal(isOrgWideTripReader(DRIVER), false);
  assert.equal(isOrgWideTripReader(ACCOUNTANT), false, 'an accountant holds no trip:* (and no trip:read)');
  assert.equal(isOrgWideTripReader([]), false);
  assert.equal(isOrgWideTripReader(null), false);
  assert.equal(ORG_WIDE_TRIP_PERMISSION, 'trip:*');
});

test('tripReadScope leaves the org-wide roles unchanged and narrows a driver', () => {
  assert.deepEqual(tripReadScope({ granted: OWNER, userId: 'pilot-admin' }), { orgWide: true, driverId: null });
  assert.deepEqual(tripReadScope({ granted: DISPATCHER, userId: 'd' }), { orgWide: true, driverId: null });
  assert.deepEqual(tripReadScope({ granted: DRIVER, userId: 'pilot-driver-1' }), {
    orgWide: false,
    driverId: 'pilot-driver-1',
  });
});

test('a scoped reader without a usable id is not silently widened', () => {
  // A driver with no id must NOT fall through to an unscoped query — the route
  // refuses this shape (403), so the scope exposes driverId: null.
  assert.deepEqual(tripReadScope({ granted: DRIVER, userId: null }), { orgWide: false, driverId: null });
  assert.deepEqual(tripReadScope({ granted: DRIVER, userId: '' }), { orgWide: false, driverId: null });
});

test('canReadTrip: org-wide readers read anything, a driver only their own trip', () => {
  assert.equal(canReadTrip({ granted: OWNER, userId: 'admin', tripDriverId: 'pilot-driver-1' }), true);
  assert.equal(canReadTrip({ granted: DISPATCHER, userId: 'd', tripDriverId: null }), true);
  assert.equal(canReadTrip({ granted: DRIVER, userId: 'pilot-driver-1', tripDriverId: 'pilot-driver-1' }), true);
  assert.equal(canReadTrip({ granted: DRIVER, userId: 'pilot-driver-2', tripDriverId: 'pilot-driver-1' }), false);
  assert.equal(canReadTrip({ granted: DRIVER, userId: 'pilot-driver-1', tripDriverId: null }), false);
  assert.equal(canReadTrip({ granted: ACCOUNTANT, userId: 'a', tripDriverId: 'a' }), false);
  assert.equal(canReadTrip({}), false);
});

test('the trips route scopes BOTH reads through tripReadScope', () => {
  const route = read('routes/trips.ts');
  // The list and the detail must both consume the shared scope helper…
  assert.match(route, /tripReadScope\(\{ granted: permissions, userId: user\.id \}\)/);
  // …and the detail must pass the narrowed driver id into the read model.
  assert.match(route, /getTripDetail\(prisma, \{\s*orgId: user\.orgId,\s*tripId: id,\s*driverId:/);
  // The old unscoped detail call must be gone.
  assert.ok(
    !/getTripDetail\(prisma, \{ orgId: user\.orgId, tripId: id \}\)/.test(route),
    'the detail route must not read a trip without the visibility scope',
  );
});

test('the trip detail read model narrows on the scoped driver id', () => {
  const detail = read('trip-detail.js');
  assert.match(detail, /typeof driverId === 'string' && driverId\.length > 0/);
  assert.match(detail, /where\.driverId = driverId/);
});
