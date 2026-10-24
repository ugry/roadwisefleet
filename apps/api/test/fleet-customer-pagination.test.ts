/**
 * Fleet self-serve customer list — paging end-to-end (board task #126).
 *
 *   pnpm --filter @roadwisefleet/api test:router
 *
 * The defect: `GET /api/fleet/customers` used a fixed 200-row query with no
 * cursor and no truncation flag, so a fleet with more than 200 customers saw a
 * list that silently stopped — and the rows past 200 could not be selected for
 * an order or an invite from `/app/customers`.
 *
 * What this proves:
 *   - a 201-customer fleet gets 200 rows + a `nextCursor` + `total: 201` on the
 *     first page, and the 201st customer on the second page;
 *   - walking the pages yields every customer exactly once (keyset, not offset:
 *     equal names must not be skipped or duplicated);
 *   - a bad `limit`/`cursor` is a 400, never a silently different page;
 *   - another fleet's customer id is not a usable cursor (flat 400, no leak);
 *   - `total` counts only the caller's org.
 *
 * The fixture lives in dedicated orgs and is removed in `after`: `tsx --test`
 * runs test FILES concurrently and other suites re-derive counts from the pilot
 * org. The suite is DB-gated (diagnostic + skip on a bare checkout); the pure
 * paging rules run in `src/fleet-customers.test.js` with no install.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.ALLOW_INSECURE_AUTH_SECRET = '1';

const { buildServer } = await import('../src/app.js');
const { prisma } = await import('../src/db.js');
const { env } = await import('../src/env.js');
const { hashPassword } = await import('../src/auth/password.js');
const { signToken } = await import('../src/auth/tokens.js');

const ORG_A = 'qa-fc-page-org-a';
const ORG_B = 'qa-fc-page-org-b';
const OWNER_A = 'qa-fc-page-owner-a';
const OWNER_B = 'qa-fc-page-owner-b';
const ROWS = 201;
// Two customers share a name on purpose: a naive `name > last` cursor would
// drop the twin from page 2.
const SHARED_NAME = 'Doppel Name GmbH';
const admin = hashPassword('qa-fc-page-password');

const app = buildServer();
await app.ready();
test.after(() => app.close());

async function probeDb(): Promise<boolean> {
  try {
    await prisma.$queryRawUnsafe('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

async function ready(): Promise<boolean> {
  if (!(await probeDb())) return false;
  try {
    await prisma.customer.findFirst({ where: { orgId: ORG_A }, select: { id: true } });
    return true;
  } catch {
    return false;
  }
}

const tokenFor = (sub: string, org: string, role: string, name: string) =>
  signToken({ sub, org, role, name }, env.AUTH_SECRET, { ttlSeconds: 3600 });
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function cleanup(): Promise<void> {
  const orgs = [ORG_A, ORG_B];
  const customers = await prisma.customer.findMany({ where: { orgId: { in: orgs } }, select: { id: true } });
  const customerIds = customers.map((c) => c.id);
  const orders = await prisma.order.findMany({ where: { customerId: { in: customerIds } }, select: { id: true } });
  await prisma.orderBooking.deleteMany({ where: { orderId: { in: orders.map((o) => o.id) } } });
  await prisma.order.deleteMany({ where: { id: { in: orders.map((o) => o.id) } } });
  await prisma.customerAccount.deleteMany({ where: { customerId: { in: customerIds } } });
  await prisma.customerProfile.deleteMany({ where: { customerId: { in: customerIds } } });
  await prisma.customerAddress.deleteMany({ where: { customerId: { in: customerIds } } });
  await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
  await prisma.auditLog.deleteMany({ where: { orgId: { in: orgs } } });
  await prisma.user.deleteMany({ where: { id: { in: [OWNER_A, OWNER_B] } } });
  await prisma.org.deleteMany({ where: { id: { in: orgs } } });
}

async function seedFixture(): Promise<void> {
  await cleanup();
  await prisma.role.upsert({
    where: { id: 'owner' },
    update: {},
    create: { id: 'owner', permissions: ['org:manage', 'user:manage', 'trip:*', 'invoice:*', 'reports:read'] },
  });
  await prisma.org.create({ data: { id: ORG_A, name: 'QA Fleet Page A', locale: 'en', dataRegion: 'eu' } });
  await prisma.org.create({ data: { id: ORG_B, name: 'QA Fleet Page B', locale: 'en', dataRegion: 'eu' } });
  await prisma.user.create({
    data: { id: OWNER_A, orgId: ORG_A, roleId: 'owner', name: 'QA Page A Owner', email: 'qa-fc-page-a@roadwisefleet.test', passwordHash: admin, lang: 'en' },
  });
  await prisma.user.create({
    data: { id: OWNER_B, orgId: ORG_B, roleId: 'owner', name: 'QA Page B Owner', email: 'qa-fc-page-b@roadwisefleet.test', passwordHash: admin, lang: 'en' },
  });
  // 201 customers: 199 unique names, then a twin pair, then one more.
  const rows = [];
  for (let i = 0; i < ROWS - 2; i++) {
    rows.push({ orgId: ORG_A, name: 'Customer ' + String(i).padStart(3, '0'), lang: 'en' });
  }
  rows.push({ orgId: ORG_A, name: SHARED_NAME, lang: 'en' });
  rows.push({ orgId: ORG_A, name: SHARED_NAME, lang: 'en' });
  await prisma.customer.createMany({ data: rows });
  // Fleet B's rows prove `total` and the cursor are org-scoped.
  await prisma.customer.createMany({
    data: [0, 1, 2].map((i) => ({ orgId: ORG_B, name: 'B Customer ' + i, lang: 'en' })),
  });
}

const isReady = await ready();

if (!isReady) {
  test('fleet customer pagination end-to-end (skipped)', (t) => {
    t.diagnostic('database unreachable — set DATABASE_URL to enable this suite');
    assert.ok(true);
  });
} else {
  await seedFixture();
  test.after(cleanup);

  const ownerA = tokenFor(OWNER_A, ORG_A, 'owner', 'QA Page A Owner');
  const ownerB = tokenFor(OWNER_B, ORG_B, 'owner', 'QA Page B Owner');

  const list = async (token: string, querystring = '') => {
    const res = await app.inject({ method: 'GET', url: '/api/fleet/customers' + querystring, headers: bearer(token) });
    return res;
  };

  test('the first page is 200 rows and says there is more', async () => {
    const res = await list(ownerA);
    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json() as { customers: Array<{ id: string; name: string }>; nextCursor: string | null; total: number; limit: number };
    assert.equal(body.customers.length, 200, 'the historical page size is unchanged');
    assert.equal(body.limit, 200);
    assert.equal(body.total, ROWS, 'the client can always say "showing 200 of 201"');
    assert.ok(body.nextCursor, 'a truncated list must advertise the next page');
    assert.equal(body.nextCursor, body.customers[body.customers.length - 1].id, 'the cursor is the last row RETURNED');
    assert.equal(body.customers[0].name, 'Customer 000', 'ordering is stable: name asc');
    assert.equal(body.customers[198].name, 'Customer 198');
  });

  test('the second page reaches the 201st customer', async () => {
    const first = (await list(ownerA)).json() as { nextCursor: string };
    const res = await list(ownerA, '?cursor=' + encodeURIComponent(first.nextCursor));
    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json() as { customers: Array<{ id: string; name: string }>; nextCursor: string | null; total: number };
    // Rows 200 and 201 share a name: BOTH must be reachable, not just the first
    // (this is what a `skip`-based or non-unique-sorted cursor gets wrong).
    assert.equal(body.customers.length, 1);
    assert.equal(body.customers[0].name, SHARED_NAME);
    assert.equal(body.nextCursor, null, 'the last page says so — no infinite "load more"');
    assert.equal(body.total, ROWS);
  });

  test('walking every page yields each customer exactly once', async () => {
    const expected = (await prisma.customer.findMany({
      where: { orgId: ORG_A },
      select: { id: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    })).map((c) => c.id);
    assert.equal(expected.length, ROWS);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await list(ownerA, '?limit=50' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
      assert.equal(res.statusCode, 200, res.payload);
      const body = res.json() as { customers: Array<{ id: string }>; nextCursor: string | null; limit: number };
      assert.equal(body.limit, 50);
      assert.ok(body.customers.length <= 50);
      seen.push(...body.customers.map((c) => c.id));
      cursor = body.nextCursor;
      pages += 1;
      assert.ok(pages <= 10, 'paging terminates');
    } while (cursor);

    assert.equal(seen.length, ROWS, 'every row is reachable, none duplicated');
    assert.deepEqual([...seen].sort(), [...expected].sort());
    assert.equal(new Set(seen).size, ROWS);
  });

  test('a bad limit or cursor is a 400, never a silently different page', async () => {
    for (const query of ['?limit=0', '?limit=201', '?limit=abc', '?limit=-1']) {
      const res = await list(ownerA, query);
      assert.equal(res.statusCode, 400, `${query}: ${res.payload}`);
      assert.equal((res.json() as { error: string }).error, 'invalid_limit', query);
      assert.equal((res.json() as { field: string }).field, 'limit', query);
    }
    const bad = await list(ownerA, '?cursor=' + encodeURIComponent('not-a-customer'));
    assert.equal(bad.statusCode, 400, bad.payload);
    assert.equal((bad.json() as { error: string }).error, 'invalid_cursor');
  });

  test("another fleet's customer id is not a usable cursor (flat 400, no leak)", async () => {
    const foreign = await prisma.customer.findFirst({ where: { orgId: ORG_B }, select: { id: true } });
    assert.ok(foreign);
    const res = await list(ownerA, '?cursor=' + encodeURIComponent(foreign!.id));
    assert.equal(res.statusCode, 400, 'never a page of another tenant');
    assert.equal((res.json() as { error: string }).error, 'invalid_cursor');
    assert.doesNotMatch(res.payload, /B Customer/);

    // And `total` is the caller's org, not the whole table.
    const own = (await list(ownerB)).json() as { customers: Array<{ name: string }>; total: number; nextCursor: string | null };
    assert.equal(own.total, 3);
    assert.equal(own.customers.length, 3);
    assert.equal(own.nextCursor, null);
  });
}
