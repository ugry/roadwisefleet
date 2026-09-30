/**
 * Tests for the pure waitlist → account handoff module.
 * Runs on the Node.js native test runner with no dependencies:
 *   node --test apps/api/src/
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  displayNameFromEmail,
  isValidEmail,
  normalizeEmail,
  orgNameFromEmail,
  parseWaitlistJsonl,
  planHandoff,
} from './waitlist-handoff.js';

/** Sort emails the same way the module does, so expectations are explicit. */
function sortedEmails(entries) {
  return entries.map((e) => e.email).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

test('normalizeEmail trims and lower-cases; isValidEmail rejects junk', () => {
  assert.equal(normalizeEmail('  Ops@Acme.Test '), 'ops@acme.test');
  assert.equal(isValidEmail('ops@acme.test'), true);
  assert.equal(isValidEmail('not-an-email'), false);
  assert.equal(isValidEmail('a@b'), false);
  assert.equal(isValidEmail(''), false);
  assert.equal(isValidEmail(null), false);
});

test('displayNameFromEmail and orgNameFromEmail derive readable labels', () => {
  assert.equal(displayNameFromEmail('jane.doe@acme.test'), 'Jane Doe');
  assert.equal(displayNameFromEmail('ops@acme.test'), 'Ops');
  assert.equal(orgNameFromEmail('ops@acme.test'), 'Acme.test');
});

test('parseWaitlistJsonl returns validated, normalised entries', () => {
  const text = [
    '{"email":"Ops@Acme.Test","lang":"en","source":"landing","created_at":"2026-09-01T10:00:00.000Z"}',
    '{"email":"driver@fleet.test","lang":"de","source":"referral"}',
  ].join('\n');

  const entries = parseWaitlistJsonl(text);
  assert.deepEqual(sortedEmails(entries), ['driver@fleet.test', 'ops@acme.test']);
  const ops = entries.find((e) => e.email === 'ops@acme.test');
  assert.equal(ops.lang, 'en');
  assert.equal(ops.source, 'landing');
  assert.equal(ops.createdAt, '2026-09-01T10:00:00.000Z');
  const driver = entries.find((e) => e.email === 'driver@fleet.test');
  assert.equal(driver.createdAt, null);
});

test('parseWaitlistJsonl drops blank lines, malformed JSON, non-objects and bad emails', () => {
  const text = [
    '',
    '   ',
    'not json',
    '"just a string"',
    '[1,2,3]',
    '{"email":"no-at-sign"}',
    '{"email":"missing@tld"}',
    '{"nope":true}',
    '{"email":"good@acme.test","lang":"en"}',
  ].join('\n');

  const entries = parseWaitlistJsonl(text);
  assert.deepEqual(sortedEmails(entries), ['good@acme.test']);
});

test('parseWaitlistJsonl de-duplicates by email, keeping the last append', () => {
  const text = [
    '{"email":"ops@acme.test","lang":"en","source":"first"}',
    '{"email":"ops@acme.test","lang":"de","source":"second"}',
    '{"email":"ops@acme.test","lang":"tr","source":"third"}',
  ].join('\n');

  const entries = parseWaitlistJsonl(text);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].lang, 'tr');
  assert.equal(entries[0].source, 'third');
});

test('parseWaitlistJsonl tolerates empty and non-string input', () => {
  assert.deepEqual(parseWaitlistJsonl(''), []);
  assert.deepEqual(parseWaitlistJsonl(null), []);
  assert.deepEqual(parseWaitlistJsonl(undefined), []);
});

test('planHandoff selects only requested leads that exist and reports skips', () => {
  const entries = parseWaitlistJsonl(
    [
      '{"email":"ops@acme.test","lang":"en","source":"landing"}',
      '{"email":"driver@fleet.test","lang":"de","source":"referral"}',
    ].join('\n'),
  );

  const plan = planHandoff(entries, {
    emails: ['driver@fleet.test', 'typo@nowhere.test'],
    orgName: 'Acme Logistics',
  });

  assert.equal(plan.orgName, 'Acme Logistics');
  assert.deepEqual(plan.accounts.map((a) => a.email), ['driver@fleet.test']);
  assert.deepEqual(plan.skipped, ['typo@nowhere.test']);
  assert.equal(plan.accounts[0].name, 'Driver');
  assert.equal(plan.accounts[0].orgName, 'Acme Logistics');
  assert.equal(plan.accounts[0].lang, 'de');
});

test('planHandoff normalises and de-duplicates the requested list', () => {
  const entries = parseWaitlistJsonl('{"email":"ops@acme.test","lang":"en"}');
  const plan = planHandoff(entries, { emails: [' OPS@Acme.Test ', 'ops@acme.test'] });

  assert.equal(plan.accounts.length, 1);
  assert.equal(plan.accounts[0].email, 'ops@acme.test');
  // No explicit org -> derived from the domain.
  assert.equal(plan.accounts[0].orgName, 'Acme.test');
  assert.deepEqual(plan.skipped, []);
});

test('planHandoff returns an empty plan for no selection or empty entries', () => {
  const entries = parseWaitlistJsonl('{"email":"ops@acme.test"}');
  assert.deepEqual(planHandoff(entries, {}), { orgName: null, accounts: [], skipped: [] });
  assert.deepEqual(planHandoff(entries, { emails: [] }), { orgName: null, accounts: [], skipped: [] });
  assert.deepEqual(planHandoff([], { emails: ['ops@acme.test'] }), {
    orgName: null,
    accounts: [],
    skipped: ['ops@acme.test'],
  });
});
