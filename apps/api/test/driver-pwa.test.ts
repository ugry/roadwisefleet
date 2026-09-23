/**
 * Driver PWA v1 (board task #4) — HTTP-level checks on the asset surface, run
 * through the real `buildServer()` with `app.inject()` (no listener, no
 * production access). Requires the API dependencies:
 *
 *   pnpm --filter @roadwisefleet/api test:router
 *
 * This is the layer the dependency-free guard (`../src/driver-pwa.test.js`)
 * cannot cover: the content types, the service-worker scope and the static root
 * that a browser — and an install prompt — actually depend on. Kept out of
 * `src/` so the no-install CI job (`node --test apps/api/src/`) never imports
 * `fastify`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// Must be set before `env.ts` is imported (it throws without AUTH_SECRET).
process.env.ALLOW_INSECURE_AUTH_SECRET = '1';

const { buildServer } = await import('../src/app.js');

/** One server for all the static reads: cheaper, and they share no state. */
const app = buildServer();
await app.ready();
test.after(() => app.close());

test('GET /pilot/driver.html serves the mobile app shell', async () => {
  const res = await app.inject({ method: 'GET', url: '/pilot/driver.html' });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type']), /text\/html/);
  assert.match(res.payload, /name="viewport" content="width=device-width/);
  assert.match(res.payload, /<link rel="manifest" href="manifest\.webmanifest">/);
  assert.match(res.payload, /<script src="lib\/driver-core\.js"><\/script>/);
  assert.match(res.payload, /capture="environment"/);
});

test('GET /pilot/manifest.webmanifest is served as an installable manifest', async () => {
  const res = await app.inject({ method: 'GET', url: '/pilot/manifest.webmanifest' });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type']), /application\/manifest\+json/);
  const manifest = res.json();
  assert.equal(manifest.start_url, '/pilot/driver.html');
  assert.equal(manifest.scope, '/pilot/');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.icons.length, 3);
});

test('GET /pilot/sw.js is served as JavaScript (a service worker needs a JS MIME)', async () => {
  const res = await app.inject({ method: 'GET', url: '/pilot/sw.js' });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type']), /javascript/);
  assert.match(res.payload, /rwf-driver-shell-v1/);
  assert.match(res.payload, /addEventListener\('fetch'/);
});

test('GET /pilot/lib/driver-core.js is served as JavaScript and defines the browser global', async () => {
  const res = await app.inject({ method: 'GET', url: '/pilot/lib/driver-core.js' });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type']), /javascript/);
  assert.match(res.payload, /RoadwiseDriverCore/);
});

test('the manifest icons are served as PNG with the right bytes', async () => {
  const icons: Array<[string, number]> = [
    ['/pilot/icons/icon-192.png', 192],
    ['/pilot/icons/icon-512.png', 512],
    ['/pilot/icons/icon-maskable-512.png', 512],
  ];
  for (const [url, size] of icons) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 200, `${url} must be served`);
    assert.match(String(res.headers['content-type']), /image\/png/);
    const body = res.rawPayload;
    assert.equal(body.subarray(0, 4).toString('hex'), '89504e47', `${url} must be a PNG`);
    assert.equal(body.readUInt32BE(16), size);
  }
});

test('the static root cannot be walked out of', async () => {
  const probes = ['/pilot/../package.json', '/pilot/%2e%2e/package.json', '/pilot/..%2fpackage.json'];
  for (const url of probes) {
    const res = await app.inject({ method: 'GET', url });
    // 404 for a route that does not exist, 403 when the static layer refuses the
    // traversal (@fastify/send) — never a 200 with the repo root's file.
    assert.ok([400, 403, 404].includes(res.statusCode), `${url} must be refused (got ${res.statusCode})`);
    assert.ok(!res.payload.includes('"name": "roadwisefleet"'), `${url} must not leak the repo root`);
  }
});

test('the driver PWA creates no public route of its own', async () => {
  // /pilot/* is static only; the API surface under /api still needs a token.
  const anonymous = await app.inject({
    method: 'POST',
    url: '/api/trips/pilot-trip-2/status',
    payload: { status: 'LOADED' },
  });
  assert.equal(anonymous.statusCode, 401);
  const noTokenDocs = await app.inject({
    method: 'POST',
    url: '/api/trips/pilot-trip-2/documents',
    payload: { docType: 'pod', filename: 'pod.jpg', mimeType: 'image/jpeg', dataBase64: 'AAAA' },
  });
  assert.equal(noTokenDocs.statusCode, 401);
});
