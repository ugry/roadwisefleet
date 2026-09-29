/**
 * Regression guard for the PR #25 review finding: a **real** customer tracking
 * token (~203 chars, `header.payload.signature`) exceeded Fastify's default
 * `maxParamLength` (100), so `/track/:token` and `/api/track/:token` answered
 * `414 FST_ERR_MAX_PARAM_LENGTH` before the handler ran. The original PR
 * evidence used short literals under 100 chars, which is exactly why the
 * harness could not catch it.
 *
 * This file must stay **dependency-free** (no `fastify` import) so the
 * no-install CI job `node --test apps/api/src/` runs it. The HTTP-level proof —
 * minting a real token and calling the real `buildServer()` through
 * `app.inject()` — lives in `../test/track-router.test.ts` and runs via
 * `pnpm --filter @roadwisefleet/api test:router`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { signTrackLink } from './track-link.js';
import { MAX_PARAM_LENGTH, serverOptions } from './server-options.js';

const AUTH_SECRET = 'unit-test-auth-secret';
const TRIP_ID = 'pilot-trip-2';

/** Fastify's historical default — the value that broke the route. */
const FASTIFY_DEFAULT_MAX_PARAM_LENGTH = 100;

test('a real tracking token is longer than the old Fastify default (100)', () => {
  const { token } = signTrackLink({ tripId: TRIP_ID, authSecret: AUTH_SECRET });
  assert.ok(
    token.length > FASTIFY_DEFAULT_MAX_PARAM_LENGTH,
    `a real token (${token.length} chars) must exceed the default cap ` +
      `(${FASTIFY_DEFAULT_MAX_PARAM_LENGTH}) — otherwise this guard would not ` +
      'reproduce the 414 defect',
  );
  assert.ok(
    token.length <= MAX_PARAM_LENGTH,
    `a real token (${token.length} chars) must fit maxParamLength (${MAX_PARAM_LENGTH})`,
  );
  // Explicit upper bound requested in review; guards runaway token growth too.
  assert.ok(token.length < 500, `token length ${token.length} must stay under 500`);
});

test('the server is configured with maxParamLength above a real token', () => {
  const opts = serverOptions();
  assert.equal(opts.routerOptions.maxParamLength, MAX_PARAM_LENGTH);
  assert.ok(
    opts.routerOptions.maxParamLength > FASTIFY_DEFAULT_MAX_PARAM_LENGTH,
    'maxParamLength must be raised above the Fastify default',
  );
  const { token } = signTrackLink({ tripId: TRIP_ID, authSecret: AUTH_SECRET });
  assert.ok(
    opts.routerOptions.maxParamLength >= token.length,
    `maxParamLength (${opts.routerOptions.maxParamLength}) must fit a real token (${token.length})`,
  );
});

test('app.ts wires the shared options into Fastify (no dependency needed)', () => {
  // The authoritative wiring proof is the app.inject() test in
  // `../test/track-router.test.ts`. This source guard keeps the *wiring* itself
  // covered by the dependency-free CI job, so a revert to `Fastify({ logger:
  // true })` fails here even without fastify installed.
  const src = readFileSync(new URL('./app.ts', import.meta.url), 'utf8');
  assert.match(
    src,
    /Fastify\(\s*serverOptions\(/,
    'buildServer() must call Fastify(serverOptions()) with the shared router options',
  );
});
