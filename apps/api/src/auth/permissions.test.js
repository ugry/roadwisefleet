import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canCreateTrip,
  canTransitionTrip,
  hasPermission,
  loadRolePermissions,
} from './permissions.js';

// The seeded roles (apps/api/scripts/seed-pilot.ts).
const OWNER = ['org:manage', 'user:manage', 'trip:*', 'invoice:*', 'settlement:*', 'reports:read'];
const DISPATCHER = ['trip:*', 'user:read', 'reports:read'];
const ACCOUNTANT = ['invoice:*', 'settlement:*', 'reports:read'];
const DRIVER = ['trip:read', 'trip:status', 'pod:upload', 'expense:create'];

test('hasPermission matches exact, resource-wildcard and global grants', () => {
  assert.equal(hasPermission(DRIVER, 'trip:read'), true);
  assert.equal(hasPermission(DISPATCHER, 'trip:create'), true, 'trip:* covers trip:create');
  assert.equal(hasPermission(DISPATCHER, 'trip:status'), true);
  assert.equal(hasPermission(OWNER, 'invoice:void'), true);
  assert.equal(hasPermission(['*'], 'anything:goes'), true);
  assert.equal(hasPermission(DRIVER, 'trip:create'), false);
  assert.equal(hasPermission(ACCOUNTANT, 'trip:read'), false);
  assert.equal(hasPermission([], 'trip:read'), false);
  assert.equal(hasPermission(undefined, 'trip:read'), false);
  assert.equal(hasPermission('trip:read', 'trip:read'), false, 'a string is not a permission list');
});

test('canCreateTrip allows owner/dispatcher and denies driver/accountant', () => {
  assert.equal(canCreateTrip(OWNER), true);
  assert.equal(canCreateTrip(DISPATCHER), true);
  assert.equal(canCreateTrip(DRIVER), false);
  assert.equal(canCreateTrip(ACCOUNTANT), false);
  assert.equal(canCreateTrip(undefined), false);
});

test('canTransitionTrip lets trip:* roles move any trip in the org', () => {
  assert.equal(canTransitionTrip({ granted: OWNER, userId: 'admin', tripDriverId: 'd9' }), true);
  assert.equal(canTransitionTrip({ granted: DISPATCHER, userId: 'disp', tripDriverId: null }), true);
});

test('canTransitionTrip lets a driver move only their own trip', () => {
  assert.equal(canTransitionTrip({ granted: DRIVER, userId: 'd1', tripDriverId: 'd1' }), true);
  assert.equal(canTransitionTrip({ granted: DRIVER, userId: 'd1', tripDriverId: 'd2' }), false);
  assert.equal(canTransitionTrip({ granted: DRIVER, userId: 'd1', tripDriverId: null }), false);
  assert.equal(canTransitionTrip({ granted: DRIVER, userId: null, tripDriverId: null }), false);
  assert.equal(canTransitionTrip({ granted: DRIVER, userId: 'd1', tripDriverId: 'd1' }), true);
});

test('canTransitionTrip denies roles without trip:status and empty input', () => {
  assert.equal(canTransitionTrip({ granted: ACCOUNTANT, userId: 'a1', tripDriverId: 'a1' }), false);
  assert.equal(canTransitionTrip({ granted: ['trip:read'], userId: 'd1', tripDriverId: 'd1' }), false);
  assert.equal(canTransitionTrip({}), false);
  assert.equal(canTransitionTrip(), false);
});

test('loadRolePermissions resolves a role from the DB, denying missing data', async () => {
  const seen = [];
  const prisma = {
    role: {
      findUnique: async ({ where }) => {
        seen.push(where.id);
        if (where.id === 'driver') return { id: 'driver', permissions: DRIVER };
        if (where.id === 'broken') return { id: 'broken' };
        return null;
      },
    },
  };

  assert.deepEqual(await loadRolePermissions(prisma, 'driver'), DRIVER);
  assert.deepEqual(await loadRolePermissions(prisma, 'ghost'), []);
  assert.deepEqual(await loadRolePermissions(prisma, 'broken'), []);
  assert.deepEqual(await loadRolePermissions(prisma, null), []);
  assert.deepEqual(await loadRolePermissions(prisma, undefined), []);
  assert.deepEqual(seen, ['driver', 'ghost', 'broken'], 'a missing roleId never hits the DB');
});
