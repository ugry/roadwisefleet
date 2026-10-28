/**
 * Account deletion — pure rules (board task #142, AND1-A3). Runs on the native
 * runner with no install: `node --test apps/api/src/`.
 *
 * These pin the policy the endpoint may not drift from:
 *
 *   - the tombstone address is deterministic, unique per user and on a reserved
 *     domain that can never receive mail;
 *   - every personal/credential `User` column is scrubbed, and the original
 *     values never appear in the write plan (non-vacuous: an untouched plan would
 *     still contain the e-mail);
 *   - the plan touches NO trip, document or delivery record — anonymise the
 *     actor only, because the retention period is the owner decision on #46;
 *   - a second deletion is a no-op, so the endpoint is idempotent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SCRUBBED_SOLO_FIELDS,
  SCRUBBED_USER_FIELDS,
  TOMBSTONE_EMAIL_DOMAIN,
  TOMBSTONE_NAME,
  isDeletedAccount,
  planAccountDeletion,
  retainedRecords,
  retentionNotice,
  soloProfileScrub,
  tombstoneEmail,
} from './account-deletion.js';

const NOW = new Date('2026-10-28T09:00:00.000Z');

function liveUser(overrides = {}) {
  return {
    id: 'usr_142_live',
    orgId: 'qa-142-org',
    roleId: 'solo',
    name: 'Anna Kowalska',
    phone: '+48 600 100 200',
    email: 'anna.kowalska@example.com',
    passwordHash: 'scrypt$not-a-real-hash',
    totpSecret: 'JBSWY3DPEHPK3PXP',
    emailVerifiedAt: NOW,
    phoneVerifiedAt: NOW,
    failedLoginCount: 3,
    lockedUntil: NOW,
    deletedAt: null,
    ...overrides,
  };
}

test('the tombstone address is deterministic, unique and can never receive mail', () => {
  assert.equal(tombstoneEmail('user-a'), `deleted+user-a@${TOMBSTONE_EMAIL_DOMAIN}`);
  assert.equal(tombstoneEmail('user-a'), tombstoneEmail('user-a'));
  assert.notEqual(tombstoneEmail('user-a'), tombstoneEmail('user-b'));
  // `.invalid` is reserved by RFC 2606: it never resolves, so no mail is sent.
  assert.match(tombstoneEmail('user-a'), /@deleted\.invalid$/);
});

test('a tombstone address without a user id is refused, never guessed', () => {
  assert.throws(() => tombstoneEmail(''), TypeError);
  assert.throws(() => tombstoneEmail(undefined), TypeError);
});

test('deleting a live account scrubs every personal and credential column', () => {
  const plan = planAccountDeletion(liveUser(), { now: NOW });
  assert.equal(plan.alreadyDeleted, false);
  assert.equal(plan.anonymizedAt, NOW);

  const update = plan.userUpdate;
  assert.equal(update.name, TOMBSTONE_NAME);
  assert.equal(update.email, tombstoneEmail('usr_142_live'));
  assert.equal(update.phone, null);
  assert.equal(update.passwordHash, null);
  assert.equal(update.totpSecret, null);
  assert.equal(update.emailVerifiedAt, null);
  assert.equal(update.phoneVerifiedAt, null);
  assert.equal(update.failedLoginCount, 0);
  assert.equal(update.lockedUntil, null);
  assert.equal(update.deletedAt, NOW);

  // The exported list is the contract: a new PII column must fail a test.
  for (const field of SCRUBBED_USER_FIELDS) {
    assert.ok(field in update, `${field} must be written by the plan`);
  }
  assert.deepEqual(Object.keys(update).sort(), [...SCRUBBED_USER_FIELDS, 'deletedAt'].sort());
});

test('the write plan carries no original personal data (non-vacuous)', () => {
  const user = liveUser();
  const serialised = JSON.stringify(planAccountDeletion(user, { now: NOW }));
  // Non-vacuous: the untouched fixture really does contain these values.
  assert.match(JSON.stringify(user), /anna\.kowalska@example\.com/);
  assert.ok(!serialised.includes('anna.kowalska@example.com'));
  assert.ok(!serialised.includes('Anna Kowalska'));
  assert.ok(!serialised.includes('+48 600 100 200'));
  assert.ok(!serialised.includes('scrypt$not-a-real-hash'));
  assert.ok(!serialised.includes('JBSWY3DPEHPK3PXP'));
  assert.ok(!serialised.includes('qa-142-org'), 'the plan carries no tenant id');
});

test('device credentials are always revoked; links are cleared only when present', () => {
  const bare = planAccountDeletion(liveUser(), { now: NOW });
  assert.equal(bare.revokeDeviceCredentials, true);
  assert.equal(bare.deleteCustomerAccount, false);
  assert.equal(bare.scrubSoloProfile, false);

  const linked = planAccountDeletion(
    liveUser({ customerAccount: { id: 'ca-1' }, soloProfile: { id: 'sp-1' } }),
    { now: NOW },
  );
  assert.equal(linked.deleteCustomerAccount, true);
  assert.equal(linked.scrubSoloProfile, true);
});

test('outstanding e-mail one-time codes die with the old address', () => {
  const plan = planAccountDeletion(liveUser(), { now: NOW });
  // A boolean, never the address: the plan carries no personal data, and the
  // route already holds the row it read.
  assert.equal(plan.clearEmailCodes, true);
  // A row read without an address cannot delete another account's codes.
  const anonymous = planAccountDeletion(liveUser({ email: null }), { now: NOW });
  assert.equal(anonymous.clearEmailCodes, false);
});

test('a second deletion is a clean no-op (idempotent endpoint)', () => {
  const plan = planAccountDeletion(liveUser({ deletedAt: NOW, email: tombstoneEmail('usr_142_live') }), { now: NOW });
  assert.equal(plan.alreadyDeleted, true);
  assert.equal(plan.userUpdate, null);
  assert.equal(plan.revokeDeviceCredentials, false);
  assert.equal(plan.deleteCustomerAccount, false);
  assert.equal(plan.scrubSoloProfile, false);
  assert.equal(plan.clearEmailCodes, false);
});

test('a tombstone address with no password also reads as deleted', () => {
  assert.equal(isDeletedAccount({ email: tombstoneEmail('usr_1'), passwordHash: null }), true);
  assert.equal(isDeletedAccount({ deletedAt: NOW }), true);
  assert.equal(isDeletedAccount({ email: 'anna@example.com', passwordHash: 'hash' }), false);
  assert.equal(isDeletedAccount({ email: tombstoneEmail('usr_1'), passwordHash: 'still-there' }), false);
  assert.equal(isDeletedAccount(null), false);
});

test('the solo profile scrub clears identifying fields and nothing else', () => {
  const scrub = soloProfileScrub();
  assert.deepEqual(Object.keys(scrub).sort(), [...SCRUBBED_SOLO_FIELDS].sort());
  assert.equal(scrub.truckPlate, null);
  assert.equal(scrub.phone, null);
});

test('the retention notice states what remains and invents no period', () => {
  const notice = retentionNotice({ anonymizedAt: NOW.toISOString() });
  assert.equal(notice.anonymized, true);
  assert.equal(notice.anonymizedAt, NOW.toISOString());
  assert.deepEqual(
    notice.retained.map((entry) => entry.type),
    ['trips', 'documents', 'reviews'],
  );
  assert.equal(notice.retentionPolicy, 'owner_decision_pending');
  assert.equal(notice.messageKey, 'account.delete.done');
  // No guessed retention window anywhere in the statement or the copy.
  const text = JSON.stringify(notice);
  assert.ok(!/\b\d+\s*(day|days|month|months|year|years)\b/i.test(text));
  assert.equal(retainedRecords().length, notice.retained.length);
});

test('the deletion plan never touches a trip, document or delivery record', () => {
  const plan = planAccountDeletion(liveUser(), { now: NOW });
  const text = JSON.stringify(plan).toLowerCase();
  for (const forbidden of ['trip', 'document', 'statusEvent', 'invoice', 'settlement']) {
    assert.ok(!text.includes(forbidden.toLowerCase()), `plan must not mention ${forbidden}`);
  }
});
