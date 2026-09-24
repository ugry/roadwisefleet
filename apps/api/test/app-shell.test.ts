/**
 * Fleet Manager app shell (board task #32, FAv1-F1) — HTTP-level checks on the
 * `/app/` surface, through the real `buildServer()` with `app.inject()` (no
 * listener, no production access, no database).
 *
 *   pnpm --filter @roadwisefleet/api test:router
 *
 * This is the layer the dependency-free guard (`../src/app-shell.test.js`)
 * cannot cover: the routing, the SPA fallback through Fastify, the response
 * headers and the real static files. Kept out of `src/` so the no-install CI
 * job (`node --test apps/api/src/`) never imports `fastify`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// Must be set before `env.ts` is imported (it throws without AUTH_SECRET).
process.env.ALLOW_INSECURE_AUTH_SECRET = '1';

const { buildServer } = await import('../src/app.js');

/** One server for all the reads: cheaper, and they share no state. */
const app = buildServer();
await app.ready();
test.after(() => app.close());

test('GET /app redirects to the mounted prefix', async () => {
  const res = await app.inject({ method: 'GET', url: '/app' });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, '/app/');
});

test('GET /app/ serves the shell as HTML and is never indexed or cached', async () => {
  const res = await app.inject({ method: 'GET', url: '/app/' });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type']), /text\/html/);
  assert.equal(res.headers['x-robots-tag'], 'noindex, nofollow');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.match(res.payload, /id="loginView"/);
  assert.match(res.payload, /id="appView"/);
  assert.match(res.payload, /<script src="\/app\/app\.js"><\/script>/);
  assert.match(res.payload, /<script src="\/pilot\/lib\/i18n\.js"><\/script>/);
});

test('a deep link under /app/ returns the shell so the client guard can run', async () => {
  for (const url of ['/app/trips', '/app/my-trips', '/app/nowhere', '/app/trips?status=DELIVERED']) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 200, url);
    assert.match(String(res.headers['content-type']), /text\/html/, url);
    assert.match(res.payload, /id="appView"/, url);
  }
});

test('the app assets are served with their real content types', async () => {
  const cases: Array<[string, RegExp]> = [
    ['/app/app.css', /text\/css/],
    ['/app/app.js', /javascript/],
    ['/app/lib/app-core.js', /javascript/],
    ['/app/lib/dispatch.js', /javascript/],
    ['/app/locales/en.json', /application\/json/],
    ['/app/index.html', /text\/html/],
  ];
  for (const [url, type] of cases) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 200, url);
    assert.match(String(res.headers['content-type']), type, url);
  }
  const css = await app.inject({ method: 'GET', url: '/app/app.css' });
  assert.match(css.payload, /\.topbar/);
  const core = await app.inject({ method: 'GET', url: '/app/lib/app-core.js' });
  assert.match(core.payload, /RoadwiseAppCore/);
  const dispatch = await app.inject({ method: 'GET', url: '/app/lib/dispatch.js' });
  assert.match(dispatch.payload, /RoadwiseDispatch/);
});

test('a missing asset 404s as JSON — HTML is never served as JavaScript', async () => {
  for (const url of ['/app/missing.js', '/app/missing.css', '/app/locales/fr.json']) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 404, url);
    assert.match(String(res.headers['content-type']), /application\/json/, url);
    assert.deepEqual(JSON.parse(res.payload), { error: 'not_found' });
  }
});

test('traversal and dotfiles never escape the app root', async () => {
  for (const url of [
    '/app/../package.json',
    '/app/%2e%2e%2fpackage.json',
    '/app/%2e%2e%2f%2e%2e%2fpackage.json',
    '/app/lib/../../package.json',
    '/app/.env',
    '/app/lib/app-core.ts',
  ]) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 404, `${url} should not be served`);
    // No file contents, whichever 404 path was taken (the client normalises some
    // of these before routing, so the payload is Fastify's route-not-found JSON).
    assert.ok(!/AUTH_SECRET|"dependencies"|roadwisefleet-app/.test(res.payload), `${url} must not leak file contents`);
  }
  const env = await app.inject({ method: 'GET', url: '/app/.env' });
  assert.ok(!env.payload.includes('AUTH_SECRET'));
});

test('the API surface is unaffected: an unknown API route stays a 404 JSON', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/does-not-exist' });
  assert.equal(res.statusCode, 404);
  assert.ok(!/id="appView"/.test(res.payload));
});

test('the pilot surface is untouched', async () => {
  const res = await app.inject({ method: 'GET', url: '/pilot/index.html' });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type']), /text\/html/);
  assert.match(res.payload, /pilot/);
  assert.ok(!/id="appView"/.test(res.payload));
});
