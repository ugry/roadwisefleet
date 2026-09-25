/**
 * User / driver payload discipline (board task #63, SEC) — dependency-free
 * coverage for `src/user-payload.js` and a source guard on the leak site.
 *
 * Runs under the no-install CI job (`node --test apps/api/src/`): no Fastify,
 * no Prisma, no database. The DB-backed assertion on the live responses lives
 * in `apps/api/test/user-payload.test.ts` (`pnpm test:router`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CREDENTIAL_FIELDS,
  PUBLIC_USER_FIELDS,
  findCredentialFields,
  isCredentialField,
  publicUserSelect,
  stripCredentialFields,
} from './user-payload.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(resolve(here, name), 'utf8');

const TRIPS_CORE = read('trips-core.js');
const TRIPS_ROUTE = read('routes/trips.ts');
const REFERENCE_ROUTE = read('routes/reference.ts');

test('the credential field list covers the fields the review named', () => {
  for (const field of ['passwordHash', 'totpSecret', 'failedLoginCount', 'lockedUntil']) {
    assert.ok(CREDENTIAL_FIELDS.includes(field), `${field} must be classified as credential`);
    assert.ok(isCredentialField(field));
  }
  assert.ok(!isCredentialField('name'));
  assert.ok(!isCredentialField(undefined));
});

test('the public field list and the Prisma select expose no credential field', () => {
  for (const field of CREDENTIAL_FIELDS) {
    assert.ok(!PUBLIC_USER_FIELDS.includes(field), `${field} must not be public`);
  }
  const select = publicUserSelect();
  assert.deepEqual(Object.keys(select).sort(), [...PUBLIC_USER_FIELDS].sort());
  for (const field of CREDENTIAL_FIELDS) {
    assert.ok(!(field in select), `select must not request ${field}`);
  }
  assert.equal(select.id, true);
  assert.equal(select.name, true);
});

test('stripCredentialFields removes nested credential keys without mutating the input', () => {
  const trip = {
    id: 't1',
    createdAt: new Date('2026-09-24T00:00:00.000Z'),
    driver: {
      id: 'd1',
      name: 'Ada',
      email: 'ada@example.com',
      passwordHash: 'scrypt$...',
      totpSecret: 'JBSWY3DPEHPK3PXP',
      failedLoginCount: 3,
      lockedUntil: new Date('2999-01-01'),
    },
  };
  const clean = stripCredentialFields({ trips: [trip] });

  assert.deepEqual(findCredentialFields(clean), []);
  assert.equal(clean.trips[0].driver.name, 'Ada');
  assert.equal(clean.trips[0].driver.email, 'ada@example.com');
  assert.equal(clean.trips[0].id, 't1');
  // The input is untouched (the sanitiser is pure).
  assert.equal(trip.driver.passwordHash, 'scrypt$...');
  assert.equal(trip.driver.failedLoginCount, 3);
});

test('stripCredentialFields preserves class instances such as Date', () => {
  const when = new Date('2026-09-24T12:00:00.000Z');
  const clean = /** @type {any} */ (stripCredentialFields({ createdAt: when, nested: { at: when } }));
  assert.ok(clean.createdAt instanceof Date, 'a Date must survive the sanitiser');
  assert.equal(clean.createdAt.getTime(), when.getTime());
  assert.ok(clean.nested.at instanceof Date);
});

test('findCredentialFields reports dotted paths and an empty list for a clean payload', () => {
  const hits = findCredentialFields({
    trips: [{ id: 't1', driver: { name: 'Ada', passwordHash: 'x', totpSecret: null } }],
  });
  assert.deepEqual(hits.sort(), ['trips[0].driver.passwordHash', 'trips[0].driver.totpSecret']);
  assert.deepEqual(findCredentialFields({ trips: [{ driver: { name: 'Ada' } }] }), []);
  assert.deepEqual(findCredentialFields(null), []);
});

// --- the leak site: a bare driver include must not come back ------------------

test('trips-core loads the driver relation with the public select, never a bare include', () => {
  assert.match(TRIPS_CORE, /driver:\s*\{\s*select:\s*publicUserSelect\(\)\s*\}/);
  assert.ok(
    !/include:\s*\{[^}]*\bdriver:\s*true/.test(TRIPS_CORE),
    'a bare `driver: true` include returns the whole User row (board task #63)',
  );
  assert.match(TRIPS_CORE, /import\s*\{\s*publicUserSelect\s*\}\s*from\s*'\.\/user-payload\.js'/);
});

test('the trip routes strip credential fields at the response boundary', () => {
  // GET /trips and GET /trips/:id are the two surfaces the review named.
  assert.match(TRIPS_ROUTE, /stripCredentialFields\(\{\s*trips(?::\s*\w+)?,\s*filters:/);
  assert.match(TRIPS_ROUTE, /stripCredentialFields\(\{\s*trip:\s*result\.trip\s*\}\)/);
  assert.match(TRIPS_ROUTE, /import\s*\{\s*stripCredentialFields\s*\}\s*from\s*'\.\.\/user-payload\.js'/);
});

test('the reference data routes strip credential fields at the response boundary', () => {
  assert.match(REFERENCE_ROUTE, /stripCredentialFields\(\{\s*reference:/);
  assert.match(REFERENCE_ROUTE, /stripCredentialFields\(\{\s*drivers:/);
});
