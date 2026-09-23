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

  // Trip detail (board task #2): the drawer payload. Auth is required, the org
  // comes from the token, and an unknown/foreign id is a 404 (never a leak).
  const detail = await call(base, 'GET', `/api/trips/${tripId}`, adminToken);
  results.tripDetail = {
    expected: 200,
    status: detail.status,
    hasOrder: Boolean(detail.json?.trip?.order),
    events: detail.json?.trip?.statusEvents?.length,
    actors: detail.json?.trip?.statusEvents?.map((e: { actor: { name: string } | null }) => e.actor?.name ?? null),
    pnlEur: detail.json?.trip?.totals?.pnlEur,
  };

  const detailUnauth = await call(base, 'GET', `/api/trips/${tripId}`);
  results.tripDetailUnauthenticated = { expected: 401, status: detailUnauth.status };

  const detailMissing = await call(base, 'GET', '/api/trips/does-not-exist', adminToken);
  results.tripDetailMissing = { expected: 404, status: detailMissing.status, body: detailMissing.json };

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

  // Documents / POD (board task #3). The trip is DELIVERED; POD_UPLOADED must be
  // refused until a POD/eCMR document exists, the assigned driver uploads one,
  // the owner verifies it, and the gate then opens.
  const POD_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  const gateBefore = await call(base, 'POST', `/api/trips/${tripId}/status`, driverToken, { status: 'POD_UPLOADED' });
  results.podGateBeforeUpload = { expected: 400, status: gateBefore.status, body: gateBefore.json };

  const driverUpload = await call(base, 'POST', `/api/trips/${tripId}/documents`, driverToken, {
    docType: 'pod',
    filename: 'pod-photo.png',
    mimeType: 'image/png',
    dataBase64: POD_PNG,
  });
  const documentId = driverUpload.json?.document?.id as string;
  results.driverUploadPod = {
    expected: 201,
    status: driverUpload.status,
    docStatus: driverUpload.json?.document?.status,
    leaksStorageKey: Boolean(driverUpload.json?.document?.storageKey),
  };

  const badType = await call(base, 'POST', `/api/trips/${tripId}/documents`, driverToken, {
    docType: 'pod',
    filename: 'notes.txt',
    mimeType: 'text/plain',
    dataBase64: POD_PNG,
  });
  results.uploadUnsupportedType = { expected: 400, status: badType.status, body: badType.json };

  const wrongDriverUpload = await call(base, 'POST', `/api/trips/${tripId}/documents`, otherDriverToken, {
    docType: 'pod',
    filename: 'pod-photo.png',
    mimeType: 'image/png',
    dataBase64: POD_PNG,
  });
  results.uploadWrongDriver = { expected: 403, status: wrongDriverUpload.status, body: wrongDriverUpload.json };

  const docList = await call(base, 'GET', `/api/trips/${tripId}/documents`, driverToken);
  results.documentList = {
    expected: 200,
    status: docList.status,
    count: docList.json?.documents?.length,
    leaksStorageKey: (docList.json?.documents ?? []).some((d: { storageKey?: unknown }) => d.storageKey !== undefined),
  };

  const docListUnauth = await call(base, 'GET', `/api/trips/${tripId}/documents`);
  results.documentListUnauthenticated = { expected: 401, status: docListUnauth.status };

  const ownerVerify = await call(base, 'PATCH', `/api/documents/${documentId}`, adminToken, { status: 'VERIFIED' });
  results.ownerVerifyDocument = {
    expected: 200,
    status: ownerVerify.status,
    docStatus: ownerVerify.json?.document?.status,
  };

  const driverVerify = await call(base, 'PATCH', `/api/documents/${documentId}`, driverToken, { status: 'VERIFIED' });
  results.driverVerifyDocument = { expected: 403, status: driverVerify.status, body: driverVerify.json };

  const gateAfter = await call(base, 'POST', `/api/trips/${tripId}/status`, driverToken, { status: 'POD_UPLOADED' });
  results.podGateAfterUpload = {
    expected: 200,
    status: gateAfter.status,
    tripStatus: gateAfter.json?.trip?.status,
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
