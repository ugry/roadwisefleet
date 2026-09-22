/**
 * Pilot smoke test — proves the API boots, serves /health over real HTTP, and
 * that the seeded auth + core trip loop work against the pilot Postgres.
 *
 * Requires the DB to be migrated and seeded. Credentials come from
 * `--password=<value>` / `SEED_PASSWORD` (same source as the seed script).
 *
 *   pnpm --filter @roadwisefleet/api smoke -- --password=...
 */
import { buildServer } from '../src/app.js';
import { prisma } from '../src/db.js';

const ADMIN_EMAIL = process.env.SMOKE_ADMIN_EMAIL || 'admin@pilot.roadwisefleet.test';
const DRIVER_EMAIL = process.env.SMOKE_DRIVER_EMAIL || 'driver2@pilot.roadwisefleet.test';
const OTHER_DRIVER_EMAIL = process.env.SMOKE_OTHER_DRIVER_EMAIL || 'driver1@pilot.roadwisefleet.test';
const PASSWORD_ARG = process.argv.find((a) => a.startsWith('--password='))?.slice('--password='.length);
const password = PASSWORD_ARG || process.env.SEED_PASSWORD || '';

const app = buildServer();
const results: Record<string, unknown> = {};

async function call(base: string, method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function main() {
  const base = await app.listen({ port: 0, host: '127.0.0.1' });
  results.health = await call(base, 'GET', '/health');

  const adminLogin = await call(base, 'POST', '/api/auth/login', undefined, {
    email: ADMIN_EMAIL,
    password,
  });
  results.adminLogin = { status: adminLogin.status, role: adminLogin.json?.user?.roleId };
  const adminToken = adminLogin.json?.token as string;

  results.dashboardBefore = {
    status: (await call(base, 'GET', '/api/trips', adminToken)).status,
    count: (await call(base, 'GET', '/api/trips', adminToken)).json?.trips?.length,
  };

  const created = await call(base, 'POST', '/api/trips', adminToken, {
    orderId: 'pilot-order-1',
    driverId: 'pilot-driver-2',
    rateEur: 990,
  });
  const tripId = created.json?.trip?.id as string;
  results.createTrip = { status: created.status, id: tripId, tripStatus: created.json?.trip?.status };

  const transitions: Record<string, unknown> = {};
  for (const to of ['ASSIGNED', 'LOADED', 'IN_TRANSIT']) {
    const r = await call(base, 'POST', `/api/trips/${tripId}/status`, adminToken, { status: to });
    transitions[to] = { status: r.status, tripStatus: r.json?.trip?.status };
  }
  const illegal = await call(base, 'POST', `/api/trips/${tripId}/status`, adminToken, { status: 'SETTLED' });
  transitions['IN_TRANSIT->SETTLED (must be 400)'] = { status: illegal.status, body: illegal.json };
  results.transitions = transitions;

  const unauth = await call(base, 'GET', '/api/trips');
  results.unauthenticated = { status: unauth.status, body: unauth.json };

  // RBAC (issue #6): a driver token must not create trips or move another
  // driver's trip; the assigned driver may still advance their own trip.
  const otherDriverLogin = await call(base, 'POST', '/api/auth/login', undefined, {
    email: OTHER_DRIVER_EMAIL,
    password,
  });
  const otherDriverToken = otherDriverLogin.json?.token as string;
  results.otherDriverLogin = {
    status: otherDriverLogin.status,
    role: otherDriverLogin.json?.user?.roleId,
  };

  const driverCreate = await call(base, 'POST', '/api/trips', otherDriverToken, {
    orderId: 'pilot-order-1',
    rateEur: 1,
  });
  results.driverCreateTrip = { expected: 403, status: driverCreate.status, body: driverCreate.json };

  const driverOtherTrip = await call(base, 'POST', `/api/trips/${tripId}/status`, otherDriverToken, {
    status: 'DELIVERED',
  });
  results.driverTransitionOtherTrip = {
    expected: 403,
    status: driverOtherTrip.status,
    body: driverOtherTrip.json,
  };

  const driverLogin = await call(base, 'POST', '/api/auth/login', undefined, {
    email: DRIVER_EMAIL,
    password,
  });
  results.driverLogin = { status: driverLogin.status, role: driverLogin.json?.user?.roleId };
  const driverToken = driverLogin.json?.token as string;

  const driverOwnTrip = await call(base, 'POST', `/api/trips/${tripId}/status`, driverToken, {
    status: 'DELIVERED',
  });
  results.driverTransitionOwnTrip = {
    expected: 200,
    status: driverOwnTrip.status,
    tripStatus: driverOwnTrip.json?.trip?.status,
  };

  const driverTrips = await call(base, 'GET', '/api/driver/trips', driverToken);
  results.driverView = {
    status: driverTrips.status,
    count: driverTrips.json?.trips?.length,
    statuses: driverTrips.json?.trips?.map((t: { status: string }) => t.status),
  };

  // Reference data (board task #1): owner/dispatcher read the create-trip
  // option lists; a driver token is denied on every one of them.
  const referencePaths = ['/api/reference', '/api/orders', '/api/drivers', '/api/trucks', '/api/customers'];
  const adminReference: Record<string, number> = {};
  const driverReference: Record<string, number> = {};
  for (const path of referencePaths) {
    adminReference[path] = (await call(base, 'GET', path, adminToken)).status;
    driverReference[path] = (await call(base, 'GET', path, driverToken)).status;
  }
  results.reference = {
    expected: { admin: 200, driver: 403 },
    admin: adminReference,
    driver: driverReference,
  };

  // End-to-end create with dropdown picks only (no hand-typed ids).
  const reference = await call(base, 'GET', '/api/reference', adminToken);
  const orderPick = reference.json?.reference?.orders?.[0]?.id;
  const driverPick = reference.json?.reference?.drivers?.[0]?.id;
  const truckPick = reference.json?.reference?.trucks?.[0]?.id;
  const formTrip = await call(base, 'POST', '/api/trips', adminToken, {
    orderId: orderPick,
    driverId: driverPick,
    truckId: truckPick,
    rateEur: 777,
  });
  results.createTripFromReference = {
    expected: 201,
    status: formTrip.status,
    picks: { orderPick, driverPick, truckPick },
    tripStatus: formTrip.json?.trip?.status,
  };

  console.log(JSON.stringify(results, null, 2));
}

main()
  .catch((err) => {
    console.error('Smoke failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await app.close();
    await prisma.$disconnect();
  });
