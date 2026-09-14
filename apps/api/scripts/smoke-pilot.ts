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

  const driverLogin = await call(base, 'POST', '/api/auth/login', undefined, {
    email: DRIVER_EMAIL,
    password,
  });
  results.driverLogin = { status: driverLogin.status, role: driverLogin.json?.user?.roleId };
  const driverTrips = await call(base, 'GET', '/api/driver/trips', driverLogin.json?.token as string);
  results.driverView = {
    status: driverTrips.status,
    count: driverTrips.json?.trips?.length,
    statuses: driverTrips.json?.trips?.map((t: { status: string }) => t.status),
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
