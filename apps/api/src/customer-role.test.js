/**
 * Customer role on the deploy path (board task #74, PR #67 review, 2026-09-29) —
 * dependency-free guards.
 *
 * The defect these guards exist for: `POST /api/customer/signup` creates
 * `User(roleId = 'customer')`, but the deployer runs exactly one DB step,
 * `prisma migrate deploy`, and never the seeder. On the deployed pilot the
 * `Role` row was therefore missing and the insert failed with a foreign-key
 * violation (Prisma P2003) → HTTP 500 before a customer could sign in. The
 * DB-backed end-to-end suite did not see it because its fixture upserted the
 * role itself — green CI is not evidence that the deploy path works.
 *
 * These checks need no database and no install (the no-install CI job runs
 * `node --test apps/api/src/`), so deleting or weakening the migration turns CI
 * red instead of silently restoring the 500. The behavioural half lives in
 * `apps/api/test/customer-portal.test.ts`:
 *   - the `customer` Role row exists after the migrations, with the exact
 *     permission set, WITHOUT the fixture creating it;
 *   - a signup against a database where the row has been removed still returns
 *     201 and leaves the row in place.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CUSTOMER_PERMISSIONS, CUSTOMER_ROLE } from '../../../customer/lib/customer-core.js';

const SRC = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_ROOT = resolve(SRC, '../../../prisma/migrations');

/**
 * Drop block and line comments, so a source guard tests the CODE and not the
 * doc comment next to it (learned on board #63: a guard matched its own
 * docstring).
 */
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

/** Every migration directory, in the order Prisma applies them. */
const migrations = readdirSync(MIGRATIONS_ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()
  .map((name) => ({
    name,
    sql: readFileSync(join(MIGRATIONS_ROOT, name, 'migration.sql'), 'utf8'),
  }));

/** The statements that INSERT a Role row, per migration. */
const roleInserts = migrations.map(({ name, sql }) => ({
  name,
  statements: sql
    .split(/;\s*(?:\r?\n|$)/)
    .filter((statement) => statement.includes('INSERT INTO "Role"')),
}));

/** The migration that inserts the customer role. */
const customerRoleMigrations = roleInserts.filter(({ statements }) =>
  statements.some((statement) => statement.includes(`'${CUSTOMER_ROLE}'`)),
);

test('a migration creates the customer Role row (the deploy path never seeds)', () => {
  assert.equal(
    customerRoleMigrations.length,
    1,
    'exactly one migration must INSERT the customer role — found: ' +
      (customerRoleMigrations.map((m) => m.name).join(', ') || '(none)'),
  );
  const [migration] = customerRoleMigrations;
  // It must be a real migration directory, so `prisma migrate deploy` runs it on
  // every deploy (the deployer has no seed step).
  assert.match(migration.name, /^20\d{12}_/, migration.name + ' must be a Prisma migration directory');
  // The portal tables must still ship in their own migration.
  assert.ok(
    migrations.some((m) => m.name.includes('add_customer_portal')),
    'the portal migration must still be present',
  );
});

test('the role migration is idempotent and carries the exact permission set', () => {
  const [migration] = customerRoleMigrations;
  const insert = migration.statements.find((statement) =>
    statement.includes(`'${CUSTOMER_ROLE}'`),
  );
  assert.ok(insert, 'the migration must contain the INSERT statement');

  assert.match(insert, new RegExp(`VALUES \\('${CUSTOMER_ROLE}'`), 'the INSERT must target the customer role');
  assert.match(
    insert,
    /ON CONFLICT \(id\) DO UPDATE SET permissions = EXCLUDED\.permissions/,
    're-applying the migration must be a no-op that restores the permission set',
  );

  const array = insert.match(/ARRAY\[([^\]]*)\]/);
  assert.ok(array, 'the permission set must be a literal ARRAY[...]');
  const fromSql = [...array[1].matchAll(/'([^']+)'/g)].map((match) => match[1]).sort();
  assert.deepEqual(
    fromSql,
    [...CUSTOMER_PERMISSIONS].sort(),
    'the migration permissions must match CUSTOMER_PERMISSIONS in customer/lib/customer-core.js',
  );
});

test('signup re-asserts the role idempotently before the User insert', () => {
  const route = stripComments(readFileSync(resolve(SRC, 'routes/customer.ts'), 'utf8'));
  // Board task #111: the creation moved into the shared registration helper, so
  // the route delegates instead of restating the transaction.
  assert.match(route, /createCustomerAccount\(/);
  assert.doesNotMatch(route, /tx\.role\.upsert\(/);

  const helper = stripComments(readFileSync(resolve(SRC, 'registration-accounts.ts'), 'utf8'));
  const start = helper.indexOf('export async function createCustomerAccount');
  const next = helper.indexOf('export async function', start + 10);
  assert.ok(start > 0, 'the helper must own the customer creation');
  const fn = helper.slice(start, next > 0 ? next : undefined);
  const ensureAt = fn.indexOf('ensureRole(tx, customerCore.CUSTOMER_ROLE');
  const userAt = fn.indexOf('tx.user.create(');
  assert.ok(ensureAt > 0, 'the customer signup must ensure the customer role');
  assert.ok(userAt > ensureAt, 'the role must be ensured BEFORE the User row is inserted');
  // The role helper writes the row itself, idempotently.
  assert.match(helper, /tx\.role\.upsert\(/);
});

test('the role constants are the ones the portal documents', () => {
  assert.equal(CUSTOMER_ROLE, 'customer');
  assert.deepEqual([...CUSTOMER_PERMISSIONS].sort(), ['customer:manage', 'order:create', 'order:read']);
  // No org-wide or trip capability: a customer token must not reach an
  // org-scoped route (the review's security model).
  for (const permission of CUSTOMER_PERMISSIONS) {
    assert.equal(/^(trip|org):/.test(permission), false, permission + ' would widen the customer token');
  }
});
