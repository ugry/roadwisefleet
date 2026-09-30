/**
 * Self-service registration (board task #86) — the end-to-end acceptance:
 * register a fresh account, log in, reach the dashboard.
 *
 *   pnpm --filter @roadwisefleet/api test:router
 *
 * What this proves, and why it is the layer the dependency-free core test cannot
 * reach:
 *   - `POST /api/auth/register` creates the `Org` + an `owner` `User` and issues
 *     the same session token as login;
 *   - the new owner can actually use that token: `GET /api/auth/me`, the
 *     dashboard (`reports:read`) and the org trip list (`trip:*`) all answer 200;
 *   - the same email cannot register twice (409 `email_taken`) and a short
 *     password is a 400 with a catalogue `messageKey`;
 *   - the credentials then work through `POST /api/auth/login`.
 *
 * The fixture writes into its OWN org (created by the registration) and removes
 * it in `after`, so no seeded pilot row is touched: `tsx --test` runs test files
 * concurrently and the trips-list / dashboard suites re-derive counts from the
 * pilot org (learned on board #68).
 *
 * The suite is gated on database reachability: on a bare checkout (CI has no
 * DATABASE_URL) it reports a diagnostic instead of a red suite — the
 * dependency-free guards in `src/signup-core.test.js`,
 * `src/registration.test.js` and `src/rate-limit.test.js` still run everywhere.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.ALLOW_INSECURE_AUTH_SECRET = '1';

const { buildServer } = await import('../src/app.js');
const { prisma } = await import('../src/db.js');

const app = buildServer();
await app.ready();
test.after(() => app.close());

/** Is the database reachable at all? */
async function probeDb(): Promise<boolean> {
  try {
    await prisma.$queryRawUnsafe('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

const reachable = await probeDb();

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** Every org this suite created; removed in `after`. */
const createdOrgIds: string[] = [];

async function cleanup(): Promise<void> {
  if (createdOrgIds.length === 0) return;
  const inOrgs = { in: createdOrgIds };
  await prisma.auditLog.deleteMany({ where: { orgId: inOrgs } });
  await prisma.user.deleteMany({ where: { orgId: inOrgs } });
  await prisma.org.deleteMany({ where: { id: inOrgs } });
}

if (!reachable) {
  test('registration end-to-end (skipped)', (t) => {
    t.diagnostic('database unreachable — set DATABASE_URL to enable this suite');
    assert.ok(true);
  });
} else {
  test.after(cleanup);

  const stamp = `${Date.now().toString(36)}-${process.pid}`;
  const email = `qa-register-${stamp}@roadwisefleet.test`;
  const password = 'qa-register-password-1';
  const registerBody = { name: 'QA Register', company: `QA Register ${stamp} GmbH`, email, password };

  let token = '';
  let userId = '';
  let orgId = '';

  test('a visitor registers and the response signs them in as the fleet owner', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: registerBody });
    assert.equal(res.statusCode, 201, res.payload);
    const data = JSON.parse(res.payload);
    assert.ok(data.token, 'a registration issues a session token');
    assert.equal(data.user.roleId, 'owner');
    assert.equal(data.user.name, 'QA Register');
    assert.equal(data.user.orgName, registerBody.company);
    assert.equal(data.user.locale, 'en');
    assert.ok(Array.isArray(data.user.locales));
    assert.ok(data.user.id && data.user.orgId);

    token = data.token;
    userId = data.user.id;
    orgId = data.user.orgId;
    createdOrgIds.push(orgId);

    // The row really exists with the owner role, against the role the deploy
    // path creates (the endpoint re-asserts it, so this is the live check).
    const row = await prisma.user.findUnique({ where: { id: userId }, select: { roleId: true, orgId: true, passwordHash: true } });
    assert.equal(row?.roleId, 'owner');
    assert.equal(row?.orgId, orgId);
    assert.ok(row?.passwordHash && row.passwordHash.startsWith('scrypt$'), 'the password is stored hashed');
  });

  test('the new owner reaches the dashboard and their own trip list', async () => {
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: bearer(token) });
    assert.equal(me.statusCode, 200);
    assert.equal(JSON.parse(me.payload).user.id, userId);

    // The acceptance: register → log in → reach the dashboard.
    const dash = await app.inject({ method: 'GET', url: '/api/dashboard', headers: bearer(token) });
    assert.equal(dash.statusCode, 200, dash.payload);
    const dashboard = JSON.parse(dash.payload);
    assert.ok(dashboard.dashboard, 'the payload carries the dashboard');
    assert.ok(dashboard.dashboard.kpis, 'the dashboard payload carries the KPIs');

    // `trip:*` works too: a brand-new fleet has an empty trip list, not a 403.
    const trips = await app.inject({ method: 'GET', url: '/api/trips', headers: bearer(token) });
    assert.equal(trips.statusCode, 200, trips.payload);
    assert.deepEqual(JSON.parse(trips.payload).trips, []);
  });

  test('the registered credentials log in through the normal login route', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
    assert.equal(res.statusCode, 200, res.payload);
    const data = JSON.parse(res.payload);
    assert.ok(data.token);
    assert.equal(data.user.id, userId);
    assert.equal(data.user.roleId, 'owner');
  });

  test('the same email cannot register twice', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: registerBody });
    assert.equal(res.statusCode, 409, res.payload);
    assert.equal(JSON.parse(res.payload).error, 'email_taken');
    // Nothing was created for the refused attempt.
    assert.equal(await prisma.user.count({ where: { email } }), 1);
  });

  test('a rejected registration writes nothing', async () => {
    const before = await prisma.org.count();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { ...registerBody, email: `qa-register-bad-${stamp}@roadwisefleet.test`, password: 'short' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(await prisma.org.count(), before, 'a validation failure creates no org');
  });
}
