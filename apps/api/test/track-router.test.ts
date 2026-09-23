/**
 * HTTP-level regression test for the PR #25 review finding: a **real** customer
 * tracking token (~203 chars) must be accepted by the router. Fastify's default
 * `maxParamLength` (100) made `/track/:token` and `/api/track/:token` answer
 * `414 FST_ERR_MAX_PARAM_LENGTH` before the handler ran, which short-literal
 * evidence could not catch.
 *
 * Runs the real `buildServer()` through `app.inject()` — no listener, no
 * production access. Requires the API dependencies (`fastify`, `tsx`):
 *
 *   pnpm --filter @roadwisefleet/api test:router
 *
 * Kept out of `src/` so the no-install CI job `node --test apps/api/src/` never
 * tries to import `fastify`; the dependency-free guard that mirrors this is
 * `../src/track-router.test.js`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_PARAM_LENGTH } from '../src/server-options.js';
import { signTrackLink } from '../src/track-link.js';

// Must be set before `env.ts` is imported: it throws when AUTH_SECRET is
// missing. `NODE_ENV=test` does the same, but this keeps the script portable.
process.env.ALLOW_INSECURE_AUTH_SECRET = '1';

const { buildServer } = await import('../src/app.js');
const { env } = await import('../src/env.js');

const TRIP_ID = 'pilot-trip-2';
const FASTIFY_DEFAULT_MAX_PARAM_LENGTH = 100;

function mintRealToken(): string {
  return signTrackLink({ tripId: TRIP_ID, authSecret: env.AUTH_SECRET }).token;
}

test('a real tracking token is longer than the old default (the 414 cause)', () => {
  const token = mintRealToken();
  assert.ok(
    token.length > FASTIFY_DEFAULT_MAX_PARAM_LENGTH,
    `token length ${token.length} must exceed Fastify's default ${FASTIFY_DEFAULT_MAX_PARAM_LENGTH}`,
  );
  assert.ok(
    token.length <= MAX_PARAM_LENGTH,
    `token length ${token.length} must fit maxParamLength ${MAX_PARAM_LENGTH}`,
  );
});

test('GET /track/<real token> is served (was 414 before the fix)', async () => {
  const app = buildServer();
  try {
    await app.ready();
    const token = mintRealToken();
    const res = await app.inject({ method: 'GET', url: `/track/${token}` });
    assert.notEqual(res.statusCode, 414, 'router must accept the real token length');
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-type']), /text\/html/);
    assert.equal(res.headers['x-robots-tag'], 'noindex, nofollow');
    assert.equal(res.payload.includes('noindex'), true);
  } finally {
    await app.close();
  }
});

test('GET /api/track/<real token> reaches the handler, never 414', async (t) => {
  const app = buildServer();
  try {
    await app.ready();
    const token = mintRealToken();
    const res = await app.inject({ method: 'GET', url: `/api/track/${token}` });
    assert.notEqual(res.statusCode, 414, 'router must accept the real token length');
    if (res.statusCode !== 200) {
      // No database reachable in this environment: the router accepted the
      // token and the handler ran (which is what this regression guards). The
      // 200 + PII-free payload assertion runs on the pilot (`pnpm smoke`).
      t.diagnostic(`database not reachable here (status ${res.statusCode})`);
      return;
    }
    assert.equal(res.headers['x-robots-tag'], 'noindex, nofollow');
    const body = res.json();
    assert.ok(body.tracking, 'tracking payload expected');
    assert.equal(typeof body.expiresAt, 'string');
  } finally {
    await app.close();
  }
});

test('a long tampered token is a flat 404, not 414', async () => {
  const app = buildServer();
  try {
    await app.ready();
    const token = mintRealToken();
    const tampered = `${token.slice(0, -2)}xy`;
    assert.equal(tampered.length, token.length, 'tampering must not change the length');
    const res = await app.inject({ method: 'GET', url: `/api/track/${tampered}` });
    assert.notEqual(res.statusCode, 414);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.json(), { error: 'invalid_token' });
  } finally {
    await app.close();
  }
});
