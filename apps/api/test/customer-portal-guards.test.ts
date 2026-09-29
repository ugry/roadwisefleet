/**
 * Customer portal API guards (board task #74, UXF-C1) — the checks that run
 * WITHOUT a database and WITHOUT the portal migration.
 *
 * Why they exist: on 2026-09-29 the deployed portal answered HTTP 500 to every
 * request. `apps/api/src/routes/customer.ts` imports the shared ES module
 * `customer/lib/customer-core.js`, but that directory did not declare
 * `"type": "module"`, so Node/tsx loaded it as CommonJS and the route saw
 * `{ default: … }` — every handler threw `customerCore.<fn> is not a function`.
 * No test caught it: the DB-backed suite needs the migration (and skipped
 * everywhere), and the dependency-free suite imports the core directly, so it
 * never runs the API's own import chain.
 *
 * These tests boot the REAL server under tsx (the production invocation, see
 * `"start": "tsx src/server.ts"`) and only exercise paths that are decided
 * before the database is touched, so they run on a bare checkout: no
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

test('the portal is served from /c/ and its module manifest is never served', async () => {
  // The mount really is wired (an asset and the SPA shell answer 200) …
  const asset = await app.inject({ method: 'GET', url: '/c/locales/en.json' });
  assert.equal(asset.statusCode, 200, asset.payload);
  assert.match(asset.headers['content-type'] as string, /application\/json/);
  const shell = await app.inject({ method: 'GET', url: '/c/login' });
  assert.equal(shell.statusCode, 200, shell.payload);
  assert.match(shell.headers['content-type'] as string, /text\/html/);

  // … and `customer/package.json` — the marker that declares the shared modules
  // as ESM — is a directory manifest, not a portal asset: it must 404 even
  // though it is a real file on disk.
  const manifest = await app.inject({ method: 'GET', url: '/c/package.json' });
  assert.equal(manifest.statusCode, 404, manifest.payload);
});
