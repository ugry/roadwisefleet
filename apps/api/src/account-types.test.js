/**
 * Account types (board task #111, AND2-REG1) — dependency-free coverage.
 *
 * Runs under the no-install CI job (`node --test apps/api/src/`), so it imports
 * only `node:*` builtins plus the two CJS modules the browser and the API share.
 * The DB-backed registration paths live in `apps/api/test/registration.test.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import accountTypes from '../../../app/lib/account-types.js';
import signupRules from '../../../app/lib/signup.js';

const here = dirname(fileURLToPath(import.meta.url));

test('the three signup choices on the page are exactly the catalogue ids', () => {
  const page = readFileSync(resolve(here, '../../../app/index.html'), 'utf8');
  const values = [...page.matchAll(/name="accountType"\s+value="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(values, accountTypes.ids());
});

test('the three account types are exactly customer / fleet / solo driver, form order', () => {
  assert.deepEqual(accountTypes.ids(), ['customer', 'fleet', 'solo_driver']);
  assert.deepEqual(
    accountTypes.ACCOUNT_TYPES.map((t) => t.id),
    ['customer', 'fleet', 'solo_driver'],
  );
});

test('the role is derived from the type, never taken from the request', () => {
  assert.equal(accountTypes.roleFor('customer'), 'customer');
  assert.equal(accountTypes.roleFor('fleet'), 'owner');
  assert.equal(accountTypes.roleFor('solo_driver'), 'solo');
  // Unknown types resolve to null (a caller must refuse, never guess a role).
  assert.equal(accountTypes.roleFor('admin'), null);
  assert.equal(accountTypes.roleFor(null), null);
  assert.equal(accountTypes.roleFor(undefined), null);
});

test('customer and solo driver are free; a fleet bills after a one-month trial', () => {
  assert.equal(accountTypes.isFree('customer'), true);
  assert.equal(accountTypes.isFree('solo_driver'), true);
  assert.equal(accountTypes.isFree('fleet'), false);
  // Unknown is NOT free (deny by default).
  assert.equal(accountTypes.isFree('admin'), false);

  const fleet = accountTypes.type('fleet');
  assert.equal(fleet.trialMonths, 1);
  assert.equal(fleet.priceEur, 20);
  const solo = accountTypes.type('solo_driver');
  assert.equal(solo.priceEur, 0);
});

test('isAccountType is strict: only the three ids, nothing else', () => {
  for (const id of accountTypes.ids()) assert.equal(accountTypes.isAccountType(id), true);
  for (const bad of ['admin', 'FLEET', '', ' fleet', null, undefined, 1, {}]) {
    assert.equal(accountTypes.isAccountType(bad), false, `${String(bad)} must not be a type`);
  }
});

test('normalize defaults a missing choice to fleet and passes valid ids through', () => {
  assert.equal(accountTypes.normalize('customer'), 'customer');
  assert.equal(accountTypes.normalize('solo_driver'), 'solo_driver');
  assert.equal(accountTypes.normalize('fleet'), 'fleet');
  assert.equal(accountTypes.normalize(undefined), 'fleet');
  assert.equal(accountTypes.normalize(null), 'fleet');
  assert.equal(accountTypes.normalize(''), 'fleet');
  assert.equal(accountTypes.normalize('admin'), 'fleet');
  assert.equal(accountTypes.DEFAULT_ACCOUNT_TYPE, 'fleet');
});

test('accountTypeForUser recovers the type from the persisted role + org', () => {
  assert.equal(accountTypes.accountTypeForUser({ roleId: 'customer' }), 'customer');
  assert.equal(accountTypes.accountTypeForUser({ roleId: 'solo' }), 'solo_driver');
  assert.equal(accountTypes.accountTypeForUser({ roleId: 'driver', orgId: 'org-1' }), 'fleet');
  assert.equal(accountTypes.accountTypeForUser({ roleId: 'driver', orgId: null }), 'solo_driver');
  for (const roleId of ['owner', 'dispatcher', 'accountant']) {
    assert.equal(accountTypes.accountTypeForUser({ roleId, orgId: 'org-1' }), 'fleet');
  }
  assert.equal(accountTypes.accountTypeForUser({ roleId: 'admin' }), null);
  assert.equal(accountTypes.accountTypeForUser({}), null);
  assert.equal(accountTypes.accountTypeForUser(null), null);
});

test('the shared signup rules carry and validate the chosen account type', () => {
  const base = { name: 'Ada', email: 'ada@example.com', password: 'password1' };

  // Legacy body: no type → fleet, exactly as before #111.
  const fleet = signupRules.validateRegistration(base);
  assert.equal(fleet.ok, true);
  assert.equal(fleet.value.accountType, 'fleet');

  for (const id of accountTypes.ids()) {
    const out = signupRules.validateRegistration({ ...base, accountType: id });
    assert.equal(out.ok, true);
    assert.equal(out.value.accountType, id);
  }

  // An unknown type is a 400 field error the form can focus.
  const bad = signupRules.validateRegistration({ ...base, accountType: 'admin' });
  assert.equal(bad.ok, false);
  assert.equal(bad.field, 'accountType');
  assert.equal(bad.messageKey, 'signup.error.accountTypeInvalid');

  // A client-supplied role/roleId is not part of the contract at all.
  const withRole = signupRules.validateRegistration({ ...base, accountType: 'solo_driver', role: 'owner', roleId: 'owner' });
  assert.equal(withRole.ok, true);
  assert.equal(withRole.value.accountType, 'solo_driver');
  assert.equal('role' in withRole.value, false);
  assert.equal('roleId' in withRole.value, false);
});
