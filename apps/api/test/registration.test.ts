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
/** Every user row created here (customer logins have no org, board #111). */
const createdUserIds: string[] = [];
/** Every customer row created here (board #111). */
const createdCustomerIds: string[] = [];

async function cleanup(): Promise<void> {
  const inOrgs = { in: createdOrgIds };
  const inUsers = { in: createdUserIds };
  const inCustomers = { in: createdCustomerIds };
  // Dependent rows first: this schema carries no onDelete cascade.
  await prisma.auditLog.deleteMany({ where: { OR: [{ orgId: inOrgs }, { actorId: inUsers }] } });
  await prisma.customerAccount.deleteMany({ where: { userId: inUsers } });
  await prisma.customerProfile.deleteMany({ where: { customerId: inCustomers } });
  await prisma.customer.deleteMany({ where: { id: inCustomers } });
  await prisma.soloDriverProfile.deleteMany({ where: { userId: inUsers } });
  await prisma.user.deleteMany({ where: { OR: [{ id: inUsers }, { orgId: inOrgs }] } });
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

  // --- board task #111: the three account types + fleet-managed drivers ------

  test('a customer registration derives the customer role server-side', async () => {
    const customerEmail = `qa-customer-${stamp}@roadwisefleet.test`;
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { accountType: 'customer', name: 'QA Customer', company: `QA Customer ${stamp}`, email: customerEmail, password },
    });
    assert.equal(res.statusCode, 201, res.payload);
    const data = JSON.parse(res.payload);
    assert.equal(data.accountType, 'customer');
    assert.equal(data.user.roleId, 'customer');
    assert.equal(data.user.orgId, null, 'a customer token never carries a fleet org');
    assert.ok(data.user.customer && data.user.customer.id, 'the response links the customer record');
    // Same locale contract as the solo/fleet branches (board #111 review).
    assert.equal(data.user.locale, 'en');
    assert.ok(Array.isArray(data.user.locales));
    createdUserIds.push(data.user.id);
    createdCustomerIds.push(data.user.customer.id);

    const row = await prisma.user.findUnique({ where: { id: data.user.id }, select: { roleId: true, orgId: true } });
    assert.equal(row?.roleId, 'customer');
    assert.equal(row?.orgId, null);
    const link = await prisma.customerAccount.findUnique({ where: { userId: data.user.id } });
    assert.equal(link?.customerId, data.user.customer.id, 'the login ↔ customer link exists');
    // The registration is audited like the solo/fleet branches (board #111 review):
    // the customer has no org, so the entry is filed in the host carrier org.
    const audit = await prisma.auditLog.findFirst({
      where: { actorId: data.user.id, action: 'auth.register' },
    });
    assert.ok(audit, 'the customer registration writes the register audit row');

    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: customerEmail, password } });
    assert.equal(login.statusCode, 200, login.payload);
    assert.equal(JSON.parse(login.payload).user.roleId, 'customer');
  });

  test('a solo driver registration derives the solo role and creates the profile', async () => {
    const soloEmail = `qa-solo-${stamp}@roadwisefleet.test`;
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { accountType: 'solo_driver', name: 'QA Solo', company: `QA Solo ${stamp}`, email: soloEmail, phone: '+4915112345678', password },
    });
    assert.equal(res.statusCode, 201, res.payload);
    const data = JSON.parse(res.payload);
    assert.equal(data.accountType, 'solo_driver');
    assert.equal(data.user.roleId, 'solo');
    assert.ok(data.user.orgId, 'a solo driver gets a one-person carrier org');
    assert.ok(data.driver && data.driver.id);
    createdUserIds.push(data.user.id);
    createdOrgIds.push(data.user.orgId);

    const profile = await prisma.soloDriverProfile.findUnique({ where: { userId: data.user.id } });
    assert.ok(profile, 'the solo driver profile exists');
    assert.equal(profile?.orgId, data.user.orgId);

    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: soloEmail, password } });
    assert.equal(login.statusCode, 200, login.payload);
  });

  test('a client cannot self-upgrade: the role comes from the chosen type only', async () => {
    const upgradeEmail = `qa-upgrade-${stamp}@roadwisefleet.test`;
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { accountType: 'solo_driver', name: 'QA Upgrade', email: upgradeEmail, phone: '+4915112345679', password, role: 'owner', roleId: 'owner' },
    });
    assert.equal(res.statusCode, 201, res.payload);
    const data = JSON.parse(res.payload);
    assert.equal(data.user.roleId, 'solo', 'the claimed owner role is ignored');
    createdUserIds.push(data.user.id);
    createdOrgIds.push(data.user.orgId);
    const row = await prisma.user.findUnique({ where: { id: data.user.id }, select: { roleId: true } });
    assert.equal(row?.roleId, 'solo');
  });

  test('an unknown account type is refused before any row is written', async () => {
    const before = await prisma.org.count();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { accountType: 'admin', name: 'QA Bad', email: `qa-bad-type-${stamp}@roadwisefleet.test`, password },
    });
    assert.equal(res.statusCode, 400, res.payload);
    const data = JSON.parse(res.payload);
    assert.equal(data.field, 'accountType');
    assert.equal(data.messageKey, 'signup.error.accountTypeInvalid');
    assert.equal(await prisma.org.count(), before);
  });

  test('the fleet owner creates a driver account inside the fleet org', async () => {
    const driverEmail = `qa-fleet-driver-${stamp}@roadwisefleet.test`;
    const res = await app.inject({
      method: 'POST',
      url: '/api/fleet/drivers',
      headers: bearer(token),
      payload: { name: 'QA Fleet Driver', email: driverEmail, password },
    });
    assert.equal(res.statusCode, 201, res.payload);
    const data = JSON.parse(res.payload);
    assert.equal(data.driver.roleId, 'driver', 'the role is derived, not supplied');
    assert.equal(data.driver.orgId, orgId, 'the driver belongs to the manager fleet org');
    createdUserIds.push(data.driver.id);

    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: driverEmail, password } });
    assert.equal(login.statusCode, 200, login.payload);
    const driverToken = JSON.parse(login.payload).token;
    const me = JSON.parse((await app.inject({ method: 'GET', url: '/api/auth/me', headers: bearer(driverToken) })).payload);
    assert.equal(me.user.roleId, 'driver');
    assert.equal(me.user.orgId, orgId);

    // A driver holds no `user:manage`: creating accounts is refused.
    const forbidden = await app.inject({
      method: 'POST',
      url: '/api/fleet/drivers',
      headers: bearer(driverToken),
      payload: { name: 'Nope', email: `qa-nope-${stamp}@roadwisefleet.test`, password },
    });
    assert.equal(forbidden.statusCode, 403, forbidden.payload);

    // The email is unique: the same driver cannot be created twice.
    const dup = await app.inject({
      method: 'POST',
      url: '/api/fleet/drivers',
      headers: bearer(token),
      payload: { name: 'QA Fleet Driver', email: driverEmail, password },
    });
    assert.equal(dup.statusCode, 409, dup.payload);
  });
}
