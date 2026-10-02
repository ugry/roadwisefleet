/**
 * Self-service registration — server-side rules (board task #86).
 *
 * `src/registration.js` holds what must not drift: the role a new fleet owner
 * gets and its capability list (mirrored from the seed), and the company name a
 * new `Org` gets. Dependency-free so it runs in the no-install CI job; a source
 * guard keeps the seed and the endpoint honest.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  OWNER_PERMISSIONS,
  OWNER_ROLE,
  REGISTER_AUDIT_ACTION,
  defaultOrgName,
} from './registration.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

test('a new fleet owner gets the owner role', () => {
  assert.equal(OWNER_ROLE, 'owner');
  assert.equal(REGISTER_AUDIT_ACTION, 'auth.register');
});

test('the owner capability list is the documented one', () => {
  assert.deepEqual([...OWNER_PERMISSIONS].sort(), [
    'invoice:*',
    'org:manage',
    'reports:read',
    'settlement:*',
    'trip:*',
    'user:manage',
  ]);
});

test('the owner capability list matches the seed (drift guard)', () => {
  const seed = read('apps/api/scripts/seed-pilot.ts');
  const match = /\[\s*'owner'\s*,\s*\[([^\]]*)\]/.exec(seed);
  assert.ok(match, 'the seed must define the owner role');
  const seeded = match[1]
    .split(',')
    .map((part) => part.trim().replace(/^'|'$/g, ''))
    .filter(Boolean);
  assert.deepEqual([...OWNER_PERMISSIONS].sort(), [...seeded].sort());
});

test('defaultOrgName prefers the company, then names the fleet after the owner', () => {
  assert.equal(defaultOrgName({ name: 'Ada', company: 'Ada Haulage GmbH' }), 'Ada Haulage GmbH');
  assert.equal(defaultOrgName({ name: 'Ada', company: '   ' }), "Ada's fleet");
  assert.equal(defaultOrgName({ name: '  Ada  ' }), "Ada's fleet");
  assert.equal(defaultOrgName({ name: '', company: '' }), 'New fleet');
  assert.equal(defaultOrgName({}), 'New fleet');
  assert.equal(defaultOrgName(), 'New fleet');
  // Never a broken name: numbers or non-strings fall back.
  assert.equal(defaultOrgName({ name: 42 }), 'New fleet');
});

test('the register endpoint wires the shared rules, the role and the rate limit (drift guard)', () => {
  const route = read('apps/api/src/routes/auth.ts');
  assert.match(route, /app\.post\('\/auth\/register'/);
  // The limiter is keyed on the REAL client, not `req.ip`: behind nginx on
  // loopback `req.ip` is one shared bucket for every visitor (PR #78 review).
  assert.match(route, /import \{ resolveClientIp \} from '\.\.\/client-ip\.js'/);
  assert.match(route, /registrationLimiter\.check\(resolveClientIp\(req\)\)/);
  assert.doesNotMatch(route, /registrationLimiter\.check\(req\.ip/);
  assert.match(route, /reply\.code\(429\)/);
  assert.match(route, /error: 'rate_limited'/);
  assert.match(route, /OWNER_ROLE/);
  assert.match(route, /error: 'email_taken'/);
  assert.match(route, /reply\.code\(409\)/);
  assert.match(route, /REGISTER_AUDIT_ACTION/);
  // Board task #111: the endpoint dispatches to the three per-type creators; the
  // fleet row creation (org, owner, role re-assertion) lives in the helper now.
  assert.match(route, /import \{ createCustomerAccount, createFleetAccount, createSoloAccount \}/);
  assert.match(route, /createFleetAccount\(/);
  assert.match(route, /createCustomerAccount\(/);
  assert.match(route, /createSoloAccount\(/);
  assert.doesNotMatch(route, /tx\.role\.upsert\(/);

  const helper = read('apps/api/src/registration-accounts.ts');
  assert.match(helper, /OWNER_PERMISSIONS/);
  assert.match(helper, /defaultOrgName\(/);
  assert.match(helper, /tx\.role\.upsert\(/);
});

test('the env exposes the limiter bounds the route reads', () => {
  const env = read('apps/api/src/env.ts');
  assert.match(env, /REGISTER_RATE_LIMIT_MAX/);
  assert.match(env, /REGISTER_RATE_LIMIT_WINDOW_SECONDS/);
});
