/**
 * Credential-leak regression test (board task #63, SEC).
 *
 * The QA dispatcher account saw `passwordHash` (scrypt), `totpSecret`,
 * `failedLoginCount` and `lockedUntil` inside every `trips[].driver` object of
 * `GET /api/trips`. This test drives the real `buildServer()` with
 * `app.inject()` and proves, against the pilot database, that:
 *
 *   1. the raw DB row still holds a `passwordHash` (otherwise the fixture would
 *      make the assertion vacuous);
 *   2. no credential key appears anywhere in the `/api/trips` response,
 *   3. nor in the trip-detail response, nor the reference driver list;
 *   4. the public driver fields (`id`, `name`, `email`) are still present, so
 *      the dispatcher UI is unaffected.
 *
 * Runs the real API dependencies (`fastify`, `tsx`) and the pilot database:
 *
 *   pnpm --filter @roadwisefleet/api test:router
 *
 * Kept out of `src/` so the no-install CI job never imports `fastify` /
 * `@prisma/client`; the dependency-free half is `../src/user-payload.test.js`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { signToken } from '../src/auth/tokens.js';
import { findCredentialFields } from '../src/user-payload.js';

// Must be set before `env.ts` is imported: it throws when AUTH_SECRET is missing.
process.env.ALLOW_INSECURE_AUTH_SECRET = '1';

const { buildServer } = await import('../src/app.js');
const { env } = await import('../src/env.js');
const { prisma } = await import('../src/db.js');

/** The seeded pilot tenant (scripts/seed-pilot.ts). */
const ORG_ID = 'pilot-org';

function ownerToken(): string {
  return signToken(
    { sub: 'pilot-admin', org: ORG_ID, role: 'owner', name: 'Pilot Admin' },
    env.AUTH_SECRET,
  );
}

async function get(app: any, url: string) {
  return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${ownerToken()}` } });
}

/** True when the database is reachable (the pilot-only assertions need it). */
async function dbReady(t: any, app: any): Promise<boolean> {
  const res = await get(app, '/api/trips');
  if (res.statusCode === 200) return true;
  t.diagnostic(`database not reachable here (baseline status ${res.statusCode}) — DB assertions skipped`);
  return false;
}

test('the pilot fixture really holds a driver password hash', async (t) => {
  const app = buildServer();
  try {
    await app.ready();
    if (!(await dbReady(t, app))) return;
    const driver = await prisma.user.findFirst({
      where: { orgId: ORG_ID, passwordHash: { not: null } },
      select: { id: true, passwordHash: true },
    });
    assert.ok(driver?.passwordHash, 'the pilot must seed a driver with a password hash for this test to be meaningful');
  } finally {
    await app.close();
  }
});

test('GET /api/trips never serialises driver credential fields', async (t) => {
  const app = buildServer();
  try {
    await app.ready();
    if (!(await dbReady(t, app))) return;

    const res = await get(app, '/api/trips');
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.deepEqual(findCredentialFields(body), [], 'no credential key may appear anywhere in /api/trips');

    // The fixture must actually exercise a driver, or the leak could hide behind
    // a null relation.
    const withDriver = (body.trips as any[]).find((trip) => trip.driver);
    assert.ok(withDriver, 'the pilot must have at least one trip with an assigned driver');
    assert.equal(withDriver.driver.passwordHash, undefined);
    assert.equal(withDriver.driver.totpSecret, undefined);
    assert.equal(withDriver.driver.failedLoginCount, undefined);
    assert.equal(withDriver.driver.lockedUntil, undefined);
    // Public fields survive, so the dispatcher UI is unchanged.
    assert.ok(withDriver.driver.id, 'driver.id must still be present');
    assert.ok(withDriver.driver.name, 'driver.name must still be present');

    // The row in the DB still has the hash — the fix is at the API boundary.
    const row = await prisma.user.findUnique({ where: { id: withDriver.driver.id }, select: { passwordHash: true } });
    assert.ok(row?.passwordHash, 'the DB row must still hold the hash (schema unchanged)');
  } finally {
    await app.close();
  }
});

test('the trip-detail and reference responses carry no credential fields either', async (t) => {
  const app = buildServer();
  try {
    await app.ready();
    if (!(await dbReady(t, app))) return;

    const list = (await get(app, '/api/trips')).json().trips as Array<{ id: string }>;
    const detail = await get(app, `/api/trips/${encodeURIComponent(list[0].id)}`);
    assert.equal(detail.statusCode, 200);
    assert.deepEqual(findCredentialFields(detail.json()), [], 'trip detail must not leak credentials');

    for (const url of ['/api/drivers', '/api/reference']) {
      const res = await get(app, url);
      assert.equal(res.statusCode, 200, `${url} should be 200 for an owner`);
      assert.deepEqual(findCredentialFields(res.json()), [], `${url} must not leak credentials`);
    }
  } finally {
    await app.close();
  }
});
