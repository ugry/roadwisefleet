/**
 * Public signup validation (board task #74, UXF-C1) — the guard that runs
 * WITHOUT a database and WITHOUT the portal migration.
 *
 * Why it exists: on 2026-09-29 the portal answered HTTP 500 to every request.
 * `apps/api/src/routes/customer.ts` imports the shared ES module
 * `customer/lib/customer-core.js`, but that directory did not declare
 * `"type": "module"`, so Node/tsx loaded it as CommonJS and the route saw
 * `{ default: … }` — every handler threw `customerCore.<fn> is not a function`.
 * No test caught it: the DB-backed suite needs the migration (and skipped
 * everywhere), and the dependency-free suite imports the core directly, so it
 * never runs the API's own import chain.
 *
 * This file boots the REAL server under tsx (the production invocation, see
 * `"start": "tsx src/server.ts"`) and asserts the validation layer answers
 * before the database is touched, so it runs on a bare checkout: no
 * `DATABASE_URL`, no migration, no fixtures.
 *
 *   pnpm --filter @roadwisefleet/api test:router
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.ALLOW_INSECURE_AUTH_SECRET = '1';

const { buildServer } = await import('../src/app.js');

const app = buildServer();
await app.ready();
test.after(() => app.close());

test('the API route can call the shared customer core (no interop default)', async () => {
  // A body the shared core refuses. The route must answer the field-level 400
  // produced by `validateSignup`, never a 500 — a 500 here is what
  // "customerCore.validateSignup is not a function" looked like on the pilot.
  const res = await app.inject({
    method: 'POST',
    url: '/api/customer/signup',
    payload: { name: 'QA Customer' },
  });
  assert.equal(res.statusCode, 400, res.payload);
  assert.equal(res.json().error, 'invalid_input');
  assert.equal(res.json().field, 'email');
  assert.equal(res.json().detail, 'email is required');
});

test('an invalid email (with an otherwise complete form) is refused before the database', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/customer/signup',
    payload: { name: 'QA Customer', email: 'not-an-email', password: 'customer-password-1' },
  });
  assert.equal(res.statusCode, 400, res.payload);
  assert.equal(res.json().error, 'invalid_input');
  assert.equal(res.json().field, 'email');
  assert.equal(res.json().detail, 'email is not valid');
});

test('a short password is refused with its own field', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/customer/signup',
    payload: { name: 'QA Customer', email: 'qa@roadwisefleet.test', password: 'short' },
  });
  assert.equal(res.statusCode, 400, res.payload);
  assert.equal(res.json().field, 'password');
});
