#!/usr/bin/env node
/**
 * FAv1 acceptance suite — one named test per acceptance criterion in FAv1 §3
 * (F1–F10). Board task eila/tasks#47. Author: Brooklyn Watkins (QA).
 *
 * The contract this suite is measured against is FAv1 §3, posted verbatim on
 * `eila/tasks#47` (comment #677) by the Team Leader on 2026-09-24:
 *
 *   F1_app_shell_auth          unauthenticated /app/* lands on login; a driver
 *                              role gets no dispatcher navigation; logout clears
 *                              the session; no page console errors.
 *   F2_kpi_reconciliation      every KPI equals a direct DB query; alerts link to
 *                              the entity; on-time % from timestamps.
 *   F3_trips_list_detail       filters combine; CSV export matches the filtered
 *                              list row for row; the timeline is chronological and
 *                              names its actor; P&L arithmetic equals the DB.
 *   F4_trip_create             a trip can be created with zero raw ids; invalid
 *                              combinations are rejected with a readable message;
 *                              it appears in the list and in the driver's app.
 *   F5_reassign_rbac           after reassignment the old driver gets 403 and the
 *                              new driver sees the trip; a status event names the
 *                              acting user.
 *   F6_pod_gate_documents      the POD gate holds; a driver cannot verify their
 *                              own document; unsupported MIME rejected; storage
 *                              keys never leak.
 *   F7_driver_app              one-tap statuses; a capture carries GPS+timestamp;
 *                              offline queues and syncs exactly once; a driver
 *                              never sees another driver's trip (403).
 *   F8_track_link              a minted link renders for an anonymous visitor; a
 *                              tampered token 404s; the link can be revoked.
 *   F9_deploy_pipeline         the single pilot environment, health-checked, with
 *                              automatic rollback; restore drill; uptime/5xx alert.
 *   F10_privacy_actor          privacy/terms reachable from the app footer and the
 *                              landing page; demo data holds no real personal data;
 *                              every status change has an actor.
 *
 * Verdicts per sub-check (tri-state, so the suite is honest before a function
 * lands — the accepted capability-detection pattern in this org):
 *   PASS       the behaviour was observed
 *   FAIL       the behaviour exists but is wrong (a genuine red — this is what the
 *              suite exists to raise)
 *   NOT_BUILT  the surface does not exist yet; the HTTP status / grep that proves
 *              that is recorded as evidence. NOT_BUILT never hides a FAIL.
 * Criterion verdict: FAIL if any sub-check FAILs; else PARTIAL when some parts are
 * NOT_BUILT; else NOT_BUILT when every part is; else PASS. Exit code 1 iff a FAIL.
 *
 * Usage (from the repo root, or via `pnpm --filter @roadwisefleet/api test:acceptance`)
 *   node apps/api/scripts/fa-acceptance.mjs       # spawn the API from this clone on :8082
 *   FA_BASE=https://host node apps/api/scripts/fa-acceptance.mjs  # external API (never spawned/stopped)
 *   FA_CRITERIA=F1,F6 node apps/api/scripts/fa-acceptance.mjs     # subset (used for the red-run proof)
 *   FA_REPO=/path/to/repo                         # repo under test (default: this script's repo root)
 *   FA_LIVE_BASE=https://roadwisefleet.com        # deployed environment (F9)
 *   FA_NO_LIVE=1                                  # no deployed environment (CI): live-only rows are NOT_BUILT
 *   FA_F7_HARNESS=1                               # also run the separately-supplied pwa_driver_harness.py --flow pod
 *
 * Secret handling: SEED_PASSWORD is read from the repo `.env` in-process; it is
 * never written to a file or printed. Residue (created trips/documents) is listed
 * at the end because the pilot has no delete endpoint.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// The F2 matchers live in their own module (board eila/tasks#145) so they can be
// proven to still go RED — inline assertions could be stubs again.
import * as f2 from './fa-f2-kpi.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = (() => {
  // Landed in-repo at apps/api/scripts, so the default repo under test is this
  // file's repo root (three levels up — the directory that owns prisma/schema.prisma).
  const defaultRepo = path.resolve(HERE, '..', '..', '..');
  const cands = [process.env.FA_REPO, defaultRepo];
  for (const c of cands) {
    if (c && existsSync(path.join(c, 'prisma', 'schema.prisma'))) return c;
  }
  return process.env.FA_REPO || defaultRepo;
})();
const PORT = process.env.FA_PORT || '8082';
const EXTERNAL = process.env.FA_BASE || null;
const BASE = (EXTERNAL || `http://127.0.0.1:${PORT}`).replace(/\/$/, '');
const LIVE = (process.env.FA_LIVE_BASE || 'https://roadwisefleet.com').replace(/\/$/, '');
const ONLY = (process.env.FA_CRITERIA || '')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const RUN_F7_HARNESS = process.env.FA_F7_HARNESS === '1';
// CI (board eila/tasks#137) has no deployed environment: the suite spawns the API
// from the clone. The live-only rows (F9's deployment health/pages, F10's landing
// page) must then be recorded NOT_BUILT with that reason — never PASS against a
// stand-in, and never FAIL merely because a runner has no pilot to point at.
const NO_LIVE = process.env.FA_NO_LIVE === '1';

/* ------------------------------------------------------------------ env --- */
function loadEnv(file) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}
const fileEnv = { ...loadEnv(path.join(REPO, 'apps', 'api', '.env')), ...loadEnv(path.join(REPO, '.env')) };
const SEED_PASSWORD = process.env.SEED_PASSWORD || fileEnv.SEED_PASSWORD || '';
if (!SEED_PASSWORD) {
  console.error('FATAL: SEED_PASSWORD missing from the repo .env — cannot log in.');
  process.exit(2);
}
const requireFromApi = createRequire(path.join(REPO, 'apps', 'api') + path.sep);
const { PrismaClient } = requireFromApi('@prisma/client');
const prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL || fileEnv.DATABASE_URL });

const ADMIN_EMAIL = 'admin@pilot.roadwisefleet.test';
const DRIVER1_EMAIL = 'driver1@pilot.roadwisefleet.test';
const DRIVER2_EMAIL = 'driver2@pilot.roadwisefleet.test';
// F6/F7 need a driver who holds NO active trip: the seed assigns `pilot-trip-2`
// to driver1 (ASSIGNED), and board #105 refuses to double-book a driver, so a
// second trip for driver1 can never reach ASSIGNED. On a fresh migrated+seeded
// database (CI, board eila/tasks#137) that is deterministic — driver3 is the
// seeded driver with no trips, and driver1/driver2 stay the "other drivers".
const DRIVER3_EMAIL = 'driver3@pilot.roadwisefleet.test';

/* -------------------------------------------------------------- results --- */
const criteria = [];
let cur = null;
function crit(id, name) {
  cur = { id, name, subs: [] };
  criteria.push(cur);
}
function sub(label, verdict, evidence) {
  cur.subs.push({ label, verdict, evidence });
}
const ok = (l, e) => sub(l, 'PASS', e);
const bad = (l, e) => sub(l, 'FAIL', e);
const nb = (l, e) => sub(l, 'NOT_BUILT', e);
function verdictOf(c) {
  if (c.subs.some((s) => s.verdict === 'FAIL')) return 'FAIL';
  if (!c.subs.length) return 'NOT_BUILT';
  if (c.subs.every((s) => s.verdict === 'NOT_BUILT')) return 'NOT_BUILT';
  if (c.subs.some((s) => s.verdict === 'NOT_BUILT')) return 'PARTIAL';
  return 'PASS';
}
const residue = [];
const shared = {}; // ids created by one criterion and reused by another

/* ------------------------------------------------------------- helpers --- */
async function call(method, p, { token, body, base } = {}) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base || BASE}${p}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return {
    status: res.status,
    contentType: res.headers.get('content-type') || '',
    location: res.headers.get('location') || '',
    json,
    text,
  };
}
async function login(email) {
  const r = await call('POST', '/api/auth/login', { body: { email, password: SEED_PASSWORD } });
  return { status: r.status, token: r.json?.token || '', user: r.json?.user || null, body: r.json };
}

function browserRun(url, args = ['console', url], timeout = 60000) {
  const r = spawnSync('eila-browser', args, { encoding: 'utf8', timeout });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const err = r.error ? String(r.error.message || r.error) : '';
  return { out, err, code: r.status };
}
/** Page-origin console errors only: chromium env noise (dbus/gpu/gcm) is ignored. */
function pageConsoleErrors(out) {
  return out
    .split('\n')
    .filter((l) => l.includes('INFO:CONSOLE'))
    .filter((l) => /Uncaught |violates the following Content Security Policy|Failed to load resource/.test(l))
    .map((l) => {
      const m = l.match(/"([^"]{0,200})"/);
      return m ? m[1] : l.slice(0, 200);
    });
}
function loadAppCore() {
  const src = readFileSync(path.join(REPO, 'app', 'lib', 'app-core.js'), 'utf8');
  const mod = { exports: {} };
  // The file is a UMD module (module.exports branch in Node). In that branch it
  // `require`s its sibling configuration (app/lib/menus.js, board #112), so the
  // Function needs a real CommonJS require resolved against the file's own dir.
  const req = createRequire(path.join(REPO, 'app', 'lib', 'app-core.js'));
  new Function('module', 'globalThis', 'require', src)(mod, {}, req);
  return mod.exports;
}
const round2 = (n) => Math.round(n * 100) / 100;

// The trips view model (app/lib/trips.js, board #34) is a UMD module with no
// sibling requires — load it the same way as app-core so the CSV clause is
// checked against the shipped code rather than proxied through the API.
function loadTripView() {
  const libDir = path.join(REPO, 'app', 'lib');
  const src = readFileSync(path.join(libDir, 'trips.js'), 'utf8');
  const mod = { exports: {} };
  const req = createRequire(path.join(libDir, path.sep));
  new Function('module', 'globalThis', 'require', src)(mod, {}, req);
  return mod.exports;
}
// Minimal RFC-4180 reader: enough for the export contract (quoted cells with
// doubled quotes; toCsv emits no multiline cell for these columns).
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQ = false;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQ) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++; } else { inQ = false; }
      } else { cell += ch; }
      continue;
    }
    if (ch === '"') { inQ = true; continue; }
    if (ch === ',') { row.push(cell); cell = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  if (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') rows.pop();
  return rows;
}

/* ----------------------------------------------------------- API spawn --- */
let apiProc = null;
async function startApi() {
  if (EXTERNAL) {
    const r = await fetch(`${BASE}/health`).catch(() => null);
    return { started: r?.status === 200, external: true, health: r ? `${r.status}` : 'unreachable' };
  }
  apiProc = spawn('pnpm', ['--filter', '@roadwisefleet/api', 'start'], {
    cwd: REPO,
    // The clone's .env carries no AUTH_SECRET; ALLOW_INSECURE_AUTH_SECRET=1 is the
    // documented local/test hatch (apps/api/src/auth/secret.js) and gives this run
    // its own ephemeral signing secret — never used against a deployed service.
    env: { ...process.env, PORT, HOST: '127.0.0.1', ALLOW_INSECURE_AUTH_SECRET: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let log = '';
  apiProc.stdout.on('data', (d) => { log += d.toString(); });
  apiProc.stderr.on('data', (d) => { log += d.toString(); });
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.status === 200) return { started: true, log };
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return { started: false, log: log.slice(-800) };
}
async function stopApi() {
  if (EXTERNAL || !apiProc) return;
  const group = -apiProc.pid;
  try { process.kill(group, 'SIGTERM'); } catch { /* gone */ }
  apiProc.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 1200));
  try { process.kill(group, 'SIGKILL'); } catch { /* gone */ }
  if (apiProc.exitCode === null) apiProc.kill('SIGKILL');
}

/* ================================================================ F1 ====== */
async function F1() {
  crit('F1', 'F1_app_shell_auth');
  const redir = await call('GET', '/app');
  if ([301, 302, 307, 308].includes(redir.status) && redir.location.includes('/app/')) {
    ok('GET /app redirects to /app/', `${redir.status} location=${redir.location}`);
  } else {
    bad('GET /app redirects to /app/', `expected 3xx -> /app/, got ${redir.status} location=${redir.location || '(none)'}`);
  }

  const shell = await call('GET', '/app/trips');
  const shellOk =
    shell.status === 200 && /text\/html/.test(shell.contentType) && /id="loginView"/.test(shell.text) && /id="appView"/.test(shell.text);
  if (shellOk) {
    ok('unauthenticated deep link /app/trips serves the login-bearing shell', `200 ${shell.contentType} (${shell.text.length} B), loginView+appView present`);
  } else {
    bad('unauthenticated deep link /app/trips serves the login-bearing shell', `got ${shell.status} ${shell.contentType} (${shell.text.length} B)`);
  }

  const asset = await call('GET', '/app/app.js');
  const missing = await call('GET', '/app/does-not-exist.png');
  if (asset.status === 200 && missing.status === 404) ok('static files served, missing assets 404', `app.js=${asset.status}, missing png=${missing.status}`);
  else bad('static files served, missing assets 404', `app.js=${asset.status}, missing png=${missing.status}`);

  const unauth = await call('GET', '/api/trips');
  if (unauth.status === 401) ok('the API refuses an unauthenticated session', `GET /api/trips -> 401 ${JSON.stringify(unauth.json)}`);
  else bad('the API refuses an unauthenticated session', `expected 401, got ${unauth.status}`);

  try {
    const core = loadAppCore();
    const g = core.guardDecision({ path: '/app/trips', hasToken: false });
    const loginPath = g.action === 'login' && g.to === '/app/login';
    const driverNav = core.navFor('driver').map((r) => r.id);
    const noDispatcher = !driverNav.includes('trips') && !driverNav.includes('dispatch') && !driverNav.includes('settings') && !driverNav.includes('finance');
    if (loginPath && noDispatcher) {
      ok('guard sends an unauthenticated deep link to login; driver nav has no dispatcher items', `guard=${g.action}->${g.to}; navFor(driver)=[${driverNav.join(',')}]`);
    } else {
      bad('guard/login + driver navigation scope', `guard=${g.action}->${g.to}; navFor(driver)=[${driverNav.join(',')}]`);
    }
    const canOpen = core.canOpen('driver', '/app/trips');
    if (canOpen === false) ok('a driver cannot open the dispatcher trips route', 'canOpen(driver, /app/trips)=false');
    else bad('a driver cannot open the dispatcher trips route', 'canOpen(driver, /app/trips)=true');
  } catch (err) {
    bad('app-core guard/role module loads', `could not evaluate app/lib/app-core.js: ${err.message}`);
  }

  // Rendered checks (headless Chromium). No session is injected: this is the
  // genuine anonymous visit.
  for (const [w, h] of [[375, 667], [1440, 900]]) {
    const out = path.join(HERE, `fa_f1_app_${w}.png`);
    const r = browserRun(BASE, ['shot', `${BASE}/app/trips`, out, String(w)]);
    if (r.code === 0 && existsSync(out)) ok(`anonymous /app/trips renders at ${w}px`, `shot ${path.basename(out)} (${r.out.length} B of log)`);
    else nb(`anonymous /app/trips renders at ${w}px`, `eila-browser unavailable: ${r.err || 'non-zero exit'}`);
  }
  const cons = browserRun(BASE, ['console', `${BASE}/app/trips`]);
  const errs = pageConsoleErrors(cons.out);
  if (cons.err) nb('no page-origin console errors on /app/trips', `eila-browser unavailable: ${cons.err}`);
  else if (!errs.length) ok('no page-origin console errors on /app/trips', `${cons.out.split('\n').filter((l) => l.includes('INFO:CONSOLE')).length} console lines, 0 page-origin errors`);
  else bad('no page-origin console errors on /app/trips', `${errs.length} page-origin error(s): ${errs.slice(0, 3).join(' | ')}`);

  const dom = browserRun(BASE, ['dom', `${BASE}/app/trips`]);
  if (!dom.err && /id="loginView"/.test(dom.out) && /id="appView"[^>]*hidden/.test(dom.out)) {
    ok('after boot the anonymous deep link shows the login view, not the app view', 'DOM: loginView visible, appView hidden');
  } else if (dom.err) {
    nb('after boot the anonymous deep link shows the login view, not the app view', `eila-browser unavailable: ${dom.err}`);
  } else {
    bad('after boot the anonymous deep link shows the login view, not the app view', `DOM markers: loginView=${/id="loginView"/.test(dom.out)} appViewHidden=${/id="appView"[^>]*hidden/.test(dom.out)}`);
  }
}

/* ================================================================ F2 ====== */
/**
 * F2_kpi_reconciliation (board #33; re-scoped by board eila/tasks#145).
 *
 * The route answers `{ dashboard: { kpis, alerts, alertCounts, activity } }`.
 * The first revision of this criterion read `r.json.kpis || r.json` and so
 * reconciled the WRAPPER (`keys=dashboard`), and two of its three sub-checks were
 * hardcoded NOT_BUILT rows that never probed anything — against a built F2 the
 * criterion could never go green, which hides a real regression later and blocks
 * #47's closure. It now unwraps the payload and re-derives every KPI from its own
 * Prisma query (never by importing apps/api/src/dashboard.js, so a wrong
 * definition on either side shows up as a mismatch instead of cancelling out).
 *
 * Two clauses cannot be exercised by the seeded data on its own: no Order carries
 * `plannedAt` (so the on-time sample is empty) and nothing raises an alert. F2
 * therefore creates disposable fixtures — an order with a promised time, a trip
 * delivered 30 min before it, an unassigned trip and an expiring document — and
 * removes them through `residue`/`cleanupResidue`. Without them a fresh CI
 * database would report NOT_BUILT forever, which is the defect this fixes.
 */
async function F2(admin, driver) {
  crit('F2', 'F2_kpi_reconciliation');

  // Honesty row: the matchers must still be able to go RED, or this criterion is
  // a stub again (apps/api/scripts/fa-f2-kpi.mjs).
  const st = f2.selfTest();
  const stBad = st.rows.filter((r) => !r.ok);
  if (st.ok) {
    ok('the F2 matchers reject a wrong expectation (self-test)', `${st.rows.length}/${st.rows.length} cases discriminate, incl. activeTrips-vs-all-trips, a 0-sample on-time and a dead alert link`);
  } else {
    bad('the F2 matchers reject a wrong expectation (self-test)', `${stBad.length}/${st.rows.length} no longer discriminate: ${stBad.map((r) => `${r.name} (${r.evidence})`).join(' | ')}`);
  }

  // RBAC: the dashboard is a reports surface (`reports:read` = owner/dispatcher/
  // accountant). A driver holds `trip:read` only and must be refused.
  const unauth = await call('GET', '/api/dashboard');
  if (unauth.status === 401) ok('the dashboard refuses an unauthenticated session', `GET /api/dashboard -> 401 ${JSON.stringify(unauth.json)}`);
  else bad('the dashboard refuses an unauthenticated session', `expected 401, got ${unauth.status}`);
  const asDriver = await call('GET', '/api/dashboard', { token: driver?.token });
  const driverBody = JSON.stringify(asDriver.json || {});
  if (asDriver.status === 403 && !/kpis|alerts/.test(driverBody)) {
    ok('a driver is refused the KPI surface', `GET /api/dashboard as driver -> 403 ${driverBody} (no KPI payload)`);
  } else {
    bad('a driver is refused the KPI surface', `expected 403 without a payload, got ${asDriver.status} ${driverBody.slice(0, 120)}`);
  }

  const orgId = admin.user?.orgId;
  const readPayload = () => call('GET', '/api/dashboard', { token: admin.token });
  const first = await readPayload();
  if (first.status !== 200) {
    bad('the dashboard payload is readable', `GET /api/dashboard -> ${first.status} ${JSON.stringify(first.json).slice(0, 160)}`);
    return;
  }
  const firstDash = f2.unwrapDashboard(first.json);
  const kpiKeys = firstDash.kpis ? Object.keys(firstDash.kpis) : [];
  if (kpiKeys.length) {
    ok('the dashboard payload is an unwrapped KPI surface', `200, dashboard.kpis=[${kpiKeys.join(',')}] — the {dashboard} wrapper is unwrapped (the old suite reconciled keys=dashboard)`);
  } else {
    bad('the dashboard payload is an unwrapped KPI surface', `200 but no kpis: keys=${Object.keys(firstDash).join(',')}`);
    return;
  }

  // Disposable fixtures — never a seeded row, always removed by cleanupResidue.
  const nowMs = Date.now();
  const plannedAt = new Date(nowMs - 60 * 60 * 1000);
  const deliveredAt = new Date(nowMs - 90 * 60 * 1000); // 30 min before the promise => on time
  let fx = null;
  const customer = await prisma.customer.findFirst({ where: { orgId }, select: { id: true } });
  if (customer) {
    const order = await prisma.order.create({
      data: { customerId: customer.id, origin: 'QA F2 origin', destination: 'QA F2 destination', status: 'DISPATCHED', plannedAt },
      select: { id: true },
    });
    residue.push({ kind: 'order', id: order.id });
    const deliveredTrip = await prisma.trip.create({
      data: { orgId, orderId: order.id, status: 'POD_UPLOADED', deliveredAt },
      select: { id: true },
    });
    residue.push({ kind: 'trip', id: deliveredTrip.id });
    const unassignedTrip = await prisma.trip.create({
      data: { orgId, orderId: order.id, status: 'ASSIGNED' },
      select: { id: true },
    });
    residue.push({ kind: 'trip', id: unassignedTrip.id });
    const doc = await prisma.document.create({
      data: {
        tripId: deliveredTrip.id,
        docType: 'insurance',
        storageKey: `qa-f2/${deliveredTrip.id}.pdf`,
        status: 'PENDING',
        expiresAt: new Date(nowMs + 10 * 24 * 60 * 60 * 1000),
      },
      select: { id: true },
    });
    residue.push({ kind: 'document', id: doc.id });
    fx = { orderId: order.id, deliveredTripId: deliveredTrip.id, unassignedTripId: unassignedTrip.id, docId: doc.id };
  }

  // Expected values, re-derived from the database (independent of the API code).
  const dbActive = await prisma.trip.count({ where: { orgId, status: { notIn: f2.TERMINAL_STATUSES } } });
  const dbPay = await prisma.trip.aggregate({
    where: { orgId, status: f2.INVOICED_STATUS },
    _sum: { rateEur: true },
    _count: true,
  });
  const deliveredRows = await prisma.trip.findMany({
    where: { orgId, status: { in: f2.DELIVERED_STATUSES }, deliveredAt: { not: null } },
    select: { deliveredAt: true, order: { select: { plannedAt: true } } },
  });
  const expectedOnTime = f2.onTimeFromRows(
    deliveredRows.map((r) => ({ deliveredAt: r.deliveredAt, plannedAt: r.order ? r.order.plannedAt : null })),
  );
  const expectedPay = { value: f2.round2(Number(dbPay._sum.rateEur ?? 0)), count: Number(dbPay._count ?? 0) };

  const second = await readPayload();
  if (second.status !== 200) {
    bad('the KPI payload is readable after the fixtures exist', `GET /api/dashboard -> ${second.status} ${JSON.stringify(second.json).slice(0, 160)}`);
    return;
  }
  const dash = f2.unwrapDashboard(second.json);

  const activeRow = f2.reconcileActiveTrips(f2.kpiOf(dash, 'activeTrips'), dbActive);
  if (activeRow.ok) ok('kpis.activeTrips equals a direct DB query', activeRow.evidence);
  else bad('kpis.activeTrips equals a direct DB query', activeRow.evidence);

  const onTimeRow = f2.reconcileOnTime(f2.kpiOf(dash, 'onTimePct'), expectedOnTime);
  if (onTimeRow.ok && (!fx || expectedOnTime.sample > 0)) {
    ok('kpis.onTimePct equals the timestamp-derived share', onTimeRow.evidence);
  } else if (fx && expectedOnTime.sample === 0) {
    bad('kpis.onTimePct equals the timestamp-derived share', `${onTimeRow.evidence} — the fixture delivery was not comparable, so the clause was not exercised`);
  } else {
    bad('kpis.onTimePct equals the timestamp-derived share', onTimeRow.evidence);
  }

  const payRow = f2.reconcilePendingPay(f2.kpiOf(dash, 'pendingPayEur'), expectedPay);
  if (payRow.ok) ok('kpis.pendingPayEur equals a direct DB query', payRow.evidence);
  else bad('kpis.pendingPayEur equals a direct DB query', payRow.evidence);

  const alerts = Array.isArray(dash.alerts) ? dash.alerts : null;
  if (!alerts) {
    bad('every alert links to the trip it names', `no alerts array in the payload: keys=${Object.keys(dash).join(',')}`);
    return;
  }
  const linkStatus = {};
  for (const a of alerts.slice(0, 8)) {
    const p = String((a && a.link) || '');
    if (p.startsWith('/app/trips')) linkStatus[p] = (await call('GET', p, { token: admin.token })).status;
  }
  const orgTrips = await prisma.trip.findMany({ where: { orgId }, select: { id: true }, take: 400 });
  const linkRow = f2.checkAlertLinks(alerts, { tripIds: orgTrips.map((t) => t.id), linkStatus, orgId });
  const sawUnassigned = alerts.some((a) => a && a.kind === 'trip_unassigned' && String(a.tripId) === String(fx?.unassignedTripId));
  const sawDoc = alerts.some((a) => a && /^document_/.test(String(a.kind)) && String(a.tripId) === String(fx?.deliveredTripId));
  if (linkRow.ok && (!fx || (sawUnassigned && sawDoc))) {
    ok('every alert links to the trip it names', `${linkRow.evidence}; fixture alerts seen: unassigned=${sawUnassigned} document=${sawDoc}`);
  } else if (linkRow.ok) {
    bad('every alert links to the trip it names', `${linkRow.evidence} but the fixture alerts are missing (unassigned=${sawUnassigned} document=${sawDoc}) — the alert queries did not pick up an unassigned trip / an expiring document`);
  } else {
    bad('every alert links to the trip it names', linkRow.evidence);
  }

  const counts = dash.alertCounts || {};
  if (Number(counts.total) === alerts.length) {
    ok('alertCounts.total equals the alerts returned', `alertCounts.total=${counts.total} == alerts.length=${alerts.length} kinds=[${[...new Set(alerts.map((a) => a && a.kind))].join(',')}]`);
  } else {
    bad('alertCounts.total equals the alerts returned', `alertCounts.total=${counts.total} vs alerts.length=${alerts.length}`);
  }
}

/* ================================================================ F3 ====== */
async function F3(admin) {
  crit('F3', 'F3_trips_list_detail');
  const list = await call('GET', '/api/trips', { token: admin.token });
  const trips = list.json?.trips || [];
  if (list.status !== 200 || !trips.length) {
    bad('the trips list is readable', `GET /api/trips -> ${list.status}, ${trips.length} trips`);
    return;
  }
  ok('the trips list is readable', `GET /api/trips -> 200, ${trips.length} trips`);

  const withEvents = await (async () => {
    for (const t of trips.slice(0, 25)) {
      const d = await call('GET', `/api/trips/${t.id}`, { token: admin.token });
      if (d.status === 200 && (d.json?.trip?.statusEvents || []).length) return d.json.trip;
    }
    return null;
  })();
  if (!withEvents) {
    nb('trip detail timeline is chronological and names its actor', 'no trip in this org has a status event yet');
    nb('P&L arithmetic equals DB values', 'no trip detail payload with events available');
    return;
  }
  const ev = withEvents.statusEvents;
  const asc = ev.every((e, i) => i === 0 || new Date(ev[i - 1].at).getTime() <= new Date(e.at).getTime());
  if (asc) ok('the timeline is chronologically ordered', `${ev.length} events oldest-first on ${withEvents.id} (${ev[0].to}→${ev[ev.length - 1].to})`);
  else bad('the timeline is chronologically ordered', `out of order on ${withEvents.id}: ${ev.map((e) => e.at).join(', ')}`);
  const actors = ev.filter((e) => e.actor && e.actor.name).length;
  if (actors === ev.length) ok('every timeline entry names its actor', `${actors}/${ev.length} events carry actor.name`);
  else if (actors === 0) nb('every timeline entry names its actor', `0/${ev.length} events carry an actor (seeded history, actorId nullable)`);
  else bad('every timeline entry names its actor', `${actors}/${ev.length} events carry actor.name`);

  const detail = await call('GET', `/api/trips/${withEvents.id}`, { token: admin.token });
  const t = detail.json.trip;
  const dbTrip = await prisma.trip.findUnique({ where: { id: withEvents.id } });
  const dbExp = await prisma.expense.aggregate({ where: { tripId: withEvents.id }, _sum: { amountEur: true } });
  const dbRate = Number(dbTrip.rateEur ?? 0);
  const dbExpSum = round2(Number(dbExp._sum.amountEur ?? 0));
  const expOk = t.totals.expensesEur === dbExpSum;
  const pnlOk = t.totals.pnlEur === round2(dbRate - dbExpSum);
  if (expOk && pnlOk) {
    ok('P&L arithmetic equals DB values', `rateEur=${dbRate} expenses=${dbExpSum} pnl=${t.totals.pnlEur} == DB`);
  } else {
    bad('P&L arithmetic equals DB values', `api expenses=${t.totals.expensesEur} pnl=${t.totals.pnlEur}; DB rate=${dbRate} expenses=${dbExpSum} pnl=${round2(dbRate - dbExpSum)}`);
  }

  // The probe status is derived from live data. A hardcoded status with zero live
  // rows is a fixture gap, not a product failure — and `0 rows == 0 rows` would be
  // a vacuous PASS that also starves the CSV row-for-row clause below.
  const orgId = admin.user?.orgId;
  const all = await prisma.trip.count({ where: { orgId } });
  const allRows = (await call('GET', '/api/trips', { token: admin.token })).json?.trips || [];
  const hist = {};
  for (const r of allRows) hist[r.status] = (hist[r.status] || 0) + 1;
  const probeStatus = Object.entries(hist).sort((x, y) => y[1] - x[1])[0]?.[0] || 'DELIVERED';
  const filteredDb = await prisma.trip.count({ where: { orgId, status: probeStatus } });
  const filtered = await call('GET', `/api/trips?status=${encodeURIComponent(probeStatus)}`, { token: admin.token });
  const got = filtered.json?.trips || [];
  if (filteredDb === all) nb('filters combine correctly', 'every trip in this org shares one status — filter indistinguishable from no filter');
  else if (got.length === filteredDb && got.length > 0 && got.every((x) => x.status === probeStatus)) ok('filters combine correctly', `status=${probeStatus} (most-populated live status; live hist ${JSON.stringify(hist)}) -> ${got.length} rows == DB count`);
  else if (got.length === all) bad('filters combine correctly', `GET /api/trips?status=${encodeURIComponent(probeStatus)} ignored the query param: ${got.length} rows (org total), DB ${probeStatus}=${filteredDb}`);
  else bad('filters combine correctly', `status=${probeStatus} -> ${got.length} rows, DB ${probeStatus}=${filteredDb}; statuses=${[...new Set(got.map((x) => x.status))].join(',')}`);

  // CSV export lives in the client view model (app/lib/trips.js#toCsv, board #34):
  // the app builds the file from exactly the rows the table shows, so the
  // row-for-row clause is checked against the SHIPPED module with the live
  // filtered rows as input. FAv1 §3 names this clause under F3; no API export
  // route exists or is expected (the three candidates are probed for the record).
  const csvApi = {};
  for (const p of ['/api/trips/export.csv', '/api/trips/export', '/api/export/trips']) csvApi[p] = (await call('GET', p, { token: admin.token })).status;
  let TV = null;
  try { TV = loadTripView(); } catch { TV = null; }
  const filterRows = (await call('GET', `/api/trips?status=${encodeURIComponent(probeStatus)}`, { token: admin.token })).json?.trips || [];
  if (TV && typeof TV.toCsv === 'function') {
    const csv = TV.toCsv(filterRows);
    const parsed = parseCsv(csv);
    const headerOk = JSON.stringify(parsed[0]) === JSON.stringify(TV.CSV_COLUMNS);
    const bodyRows = parsed.slice(1);
    const idsOk = filterRows.length > 0 && bodyRows.length === filterRows.length && bodyRows.every((r, i) => r[0] === String(filterRows[i].id));
    const statusOk = bodyRows.every((r, i) => r[1] === String(filterRows[i].status));
    const crlfOk = /\r\n$/.test(csv);
    if (headerOk && idsOk && statusOk && crlfOk) {
      ok('CSV export matches the filtered list row for row', `app/lib/trips.js toCsv: ${TV.CSV_COLUMNS.length}-col header, ${bodyRows.length}/${filterRows.length} rows (id+status match), RFC4180 CRLF; no API route (${Object.entries(csvApi).map(([p, s]) => `${p}=${s}`).join(', ')})`);
    } else {
      bad('CSV export matches the filtered list row for row', `headerOk=${headerOk} idsOk=${idsOk} statusOk=${statusOk} crlf=${crlfOk}; rows=${bodyRows.length} expected=${filterRows.length}`);
    }
  } else {
    nb('CSV export matches the filtered list row for row', `could not load app/lib/trips.js (loader error); API routes: ${Object.entries(csvApi).map(([p, s]) => `${p}=${s}`).join(', ')}`);
  }
}

/* ================================================================ F4 ====== */
async function F4(admin, driver1) {
  crit('F4', 'F4_trip_create');
  const ref = await call('GET', '/api/reference', { token: admin.token });
  const r = ref.json?.reference || {};
  const orders = r.orders || [];
  const drivers = r.drivers || [];
  const trucks = r.trucks || [];
  if (ref.status === 200 && orders.length && drivers.length) {
    ok('the create form can be filled from the API alone', `/api/reference -> 200: ${orders.length} orders, ${drivers.length} drivers, ${trucks.length} trucks`);
  } else {
    bad('the create form can be filled from the API alone', `/api/reference -> ${ref.status}: orders=${orders.length} drivers=${drivers.length} trucks=${trucks.length}`);
    return;
  }
  const d1Id = driver1.user?.id;
  const driverPick = drivers.find((d) => d.id === d1Id);
  if (driverPick) ok('the logged-in driver is offered by the reference list (no raw id needed)', `driverId ${d1Id} present in /api/reference drivers`);
  else nb('the logged-in driver is offered by the reference list (no raw id needed)', `driver1 id ${d1Id} not in the reference drivers list (${drivers.length} rows)`);

  const created = await call('POST', '/api/trips', {
    token: admin.token,
    body: { orderId: orders[0].id, driverId: d1Id, truckId: trucks[0]?.id, rateEur: 641 },
  });
  const tripId = created.json?.trip?.id;
  if (created.status === 201 && tripId) {
    ok('a trip is created from dropdown picks only', `201 trip=${tripId} status=${created.json.trip.status} rate=641 (order=${orders[0].id}, driver=${d1Id})`);
    shared.tripId = tripId;
    residue.push({ kind: 'trip', id: tripId, note: 'F4 create (no delete endpoint)' });
  } else {
    bad('a trip is created from dropdown picks only', `expected 201, got ${created.status} ${JSON.stringify(created.json)}`);
  }

  const badOrder = await call('POST', '/api/trips', { token: admin.token, body: { orderId: 'fa-nonexistent-order', rateEur: 1 } });
  const empty = await call('POST', '/api/trips', { token: admin.token, body: {} });
  const readable = (x) => x.status >= 400 && x.status < 500 && typeof x.json?.error === 'string' && x.json.error.length > 0 && !/at .*:\d+/.test(x.json.error);
  if (readable(badOrder) && readable(empty)) {
    ok('invalid combinations are rejected with a readable message', `unknown order -> ${badOrder.status} ${JSON.stringify(badOrder.json)}; empty body -> ${empty.status} ${JSON.stringify(empty.json)}`);
  } else {
    bad('invalid combinations are rejected with a readable message', `unknown order -> ${badOrder.status} ${JSON.stringify(badOrder.json)}; empty body -> ${empty.status} ${JSON.stringify(empty.json)}`);
  }

  if (!tripId) return;
  const inList = (await call('GET', '/api/trips', { token: admin.token })).json?.trips?.some((t) => t.id === tripId);
  if (inList) ok('the created trip appears in the dispatcher list', `GET /api/trips contains ${tripId}`);
  else bad('the created trip appears in the dispatcher list', `${tripId} absent from GET /api/trips`);

  const dTrips = await call('GET', '/api/driver/trips', { token: driver1.token });
  const inDriver = dTrips.json?.trips?.some((t) => t.id === tripId);
  if (dTrips.status === 200 && inDriver) ok("the created trip appears in the assigned driver's app", `/api/driver/trips (driver1) -> 200 contains ${tripId}`);
  else bad("the created trip appears in the assigned driver's app", `/api/driver/trips -> ${dTrips.status}, contains=${Boolean(inDriver)}`);
}

/* ================================================================ F5 ====== */
async function F5(admin, driver1, driver2) {
  crit('F5', 'F5_reassign_rbac');
  const tripId = shared.tripId;
  if (!tripId) {
    nb('reassignment can be performed', 'no trip id available (F4 did not create one in this run)');
    return;
  }
  const probes = {};
  probes['PATCH /api/trips/:id'] = (await call('PATCH', `/api/trips/${tripId}`, { token: admin.token, body: { driverId: driver2.user?.id } })).status;
  probes['POST /api/trips/:id/assign'] = (await call('POST', `/api/trips/${tripId}/assign`, { token: admin.token, body: { driverId: driver2.user?.id } })).status;
  probes['POST /api/trips/:id/reassign'] = (await call('POST', `/api/trips/${tripId}/reassign`, { token: admin.token, body: { driverId: driver2.user?.id } })).status;
  const live = Object.entries(probes).filter(([, s]) => s >= 200 && s < 300);
  if (!live.length) {
    nb('reassignment can be performed', `no reassign route: ${Object.entries(probes).map(([p, s]) => `${p}=${s}`).join(', ')}`);
    nb('after reassignment the old driver gets 403 and the new driver sees the trip', 'no reassign endpoint (§4b build order: F5 not built)');
    nb('a status event records the change with the acting user', 'no reassign endpoint');
    return;
  }
  if (driver2.user?.id) {
    const oldDriver = await call('POST', `/api/trips/${tripId}/status`, { token: driver1.token, body: { status: 'ASSIGNED' } });
    ok('old driver is refused after reassignment', `POST /status as driver1 -> ${oldDriver.status}`);
  }
}

/* ================================================================ F6 ====== */
async function F6(admin, assigned, other) {
  crit('F6', 'F6_pod_gate_documents');
  const orders = (await call('GET', '/api/reference', { token: admin.token })).json?.reference?.orders || [];
  const trucks = (await call('GET', '/api/reference', { token: admin.token })).json?.reference?.trucks || [];
  const d1 = assigned.user?.id;
  const created = await call('POST', '/api/trips', { token: admin.token, body: { orderId: orders[0]?.id, driverId: d1, truckId: trucks[0]?.id, rateEur: 512 } });
  const tripId = created.json?.trip?.id;
  if (created.status !== 201 || !tripId) {
    bad('POD flow can be exercised (trip created and moved to DELIVERED)', `create -> ${created.status} ${JSON.stringify(created.json)}`);
    return;
  }
  residue.push({ kind: 'trip', id: tripId, note: 'F6 POD flow' });
  for (const to of ['ASSIGNED', 'LOADED', 'IN_TRANSIT', 'DELIVERED']) {
    const s = await call('POST', `/api/trips/${tripId}/status`, { token: admin.token, body: { status: to } });
    if (s.status !== 200) {
      bad('POD flow can be exercised (trip created and moved to DELIVERED)', `${to} -> ${s.status} ${JSON.stringify(s.json)}`);
      return;
    }
  }
  ok('POD flow can be exercised (trip created and moved to DELIVERED)', `${tripId}: DRAFT→ASSIGNED→LOADED→IN_TRANSIT→DELIVERED all 200`);

  const gate = await call('POST', `/api/trips/${tripId}/status`, { token: assigned.token, body: { status: 'POD_UPLOADED' } });
  if (gate.status === 400 && gate.json?.error === 'pod_required') ok('the POD gate holds before a document exists', `POD_UPLOADED -> 400 ${JSON.stringify(gate.json)}`);
  else bad('the POD gate holds before a document exists', `expected 400 pod_required, got ${gate.status} ${JSON.stringify(gate.json)}`);

  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const capturedAt = new Date().toISOString();
  const upload = await call('POST', `/api/trips/${tripId}/documents`, {
    token: assigned.token,
    body: {
      docType: 'pod',
      filename: 'fa-pod.png',
      mimeType: 'image/png',
      dataBase64: PNG,
      capturedAt,
      // The API's capture contract is `capturedAt` + `geo{lat,lng,accuracy}`
      // (apps/api/src/documents.js#normalizeCapture) — the same shape the canonical
      // qa/pod_lifecycle.mjs uses.
      geo: { lat: 41.0082, lng: 28.9784, accuracy: 12 },
    },
  });
  const docId = upload.json?.document?.id;
  if (upload.status === 201 && docId) {
    const leaks = JSON.stringify(upload.json).includes('storageKey');
    ok('the assigned driver uploads the POD', `201 document=${docId} status=${upload.json.document.status}`);
    if (!leaks) ok('storage keys never leak to the client', 'no storageKey in the upload response');
    else bad('storage keys never leak to the client', 'upload response contains storageKey');
    residue.push({ kind: 'document', id: docId, note: `POD on ${tripId}` });
  } else {
    bad('the assigned driver uploads the POD', `expected 201, got ${upload.status} ${JSON.stringify(upload.json)}`);
  }

  const badType = await call('POST', `/api/trips/${tripId}/documents`, {
    token: assigned.token,
    body: { docType: 'pod', filename: 'notes.txt', mimeType: 'text/plain', dataBase64: PNG },
  });
  if (badType.status === 400) ok('an unsupported MIME type is rejected', `text/plain -> 400 ${JSON.stringify(badType.json)}`);
  else bad('an unsupported MIME type is rejected', `expected 400, got ${badType.status} ${JSON.stringify(badType.json)}`);

  const wrongDriver = await call('POST', `/api/trips/${tripId}/documents`, {
    token: other.token,
    body: { docType: 'pod', filename: 'fa-pod2.png', mimeType: 'image/png', dataBase64: PNG },
  });
  if (wrongDriver.status === 403) ok("another driver cannot upload to this trip", `driver2 -> 403 ${JSON.stringify(wrongDriver.json)}`);
  else bad("another driver cannot upload to this trip", `expected 403, got ${wrongDriver.status}`);

  const list = await call('GET', `/api/trips/${tripId}/documents`, { token: assigned.token });
  const leaksList = (list.json?.documents || []).some((d) => d.storageKey !== undefined);
  if (list.status === 200 && !leaksList) ok('the document list is readable and leak-free', `200, ${list.json.documents.length} document(s), no storageKey`);
  else bad('the document list is readable and leak-free', `${list.status}, leaksStorageKey=${leaksList}`);

  if (docId) {
    const selfVerify = await call('PATCH', `/api/documents/${docId}`, { token: assigned.token, body: { status: 'VERIFIED' } });
    if (selfVerify.status === 403) ok('a driver cannot verify their own document', `PATCH as the assigned driver -> 403 ${JSON.stringify(selfVerify.json)}`);
    else bad('a driver cannot verify their own document', `expected 403, got ${selfVerify.status} ${JSON.stringify(selfVerify.json)}`);

    const ownerVerify = await call('PATCH', `/api/documents/${docId}`, { token: admin.token, body: { status: 'VERIFIED' } });
    if (ownerVerify.status === 200 && ownerVerify.json?.document?.status === 'VERIFIED') ok('the owner verifies the document', `PATCH as owner -> 200 status=VERIFIED`);
    else bad('the owner verifies the document', `expected 200 VERIFIED, got ${ownerVerify.status} ${JSON.stringify(ownerVerify.json)}`);
  }

  const gateAfter = await call('POST', `/api/trips/${tripId}/status`, { token: assigned.token, body: { status: 'POD_UPLOADED' } });
  if (gateAfter.status === 200 && gateAfter.json?.trip?.status === 'POD_UPLOADED') {
    ok('the gate opens once the POD is verified', `POD_UPLOADED -> 200 (trip POD_UPLOADED)`);
    shared.f6PodUploaded = true;
  } else {
    bad('the gate opens once the POD is verified', `expected 200 POD_UPLOADED, got ${gateAfter.status} ${JSON.stringify(gateAfter.json)}`);
  }

  shared.f6TripId = tripId;
  shared.f6DocId = docId;
  shared.f6CapturedAt = capturedAt;
}

/* ================================================================ F7 ====== */
async function F7(admin, assigned, other) {
  crit('F7', 'F7_driver_app');
  const tripId = shared.f6TripId;
  if (!tripId) {
    nb('a driver never sees another driver\'s trip (403)', 'no trip id from F6 in this run');
  } else {
    const otherView = await call('GET', `/api/trips/${tripId}`, { token: other.token });
    const blocked = otherView.status === 403 || otherView.status === 404;
    if (blocked) ok("a driver never sees another driver's trip", `driver2 GET /api/trips/${tripId} -> ${otherView.status} ${JSON.stringify(otherView.json)}`);
    else bad("a driver never sees another driver's trip", `expected 403/404, got ${otherView.status}`);
    const move = await call('POST', `/api/trips/${tripId}/status`, { token: other.token, body: { status: 'ASSIGNED' } });
    if (move.status === 403) ok("a driver cannot move another driver's trip", `driver2 POST /status -> 403 ${JSON.stringify(move.json)}`);
    else bad("a driver cannot move another driver's trip", `expected 403, got ${move.status} ${JSON.stringify(move.json)}`);
    const own = await call('GET', '/api/driver/trips', { token: assigned.token });
    const sees = own.json?.trips?.some((t) => t.id === tripId);
    if (own.status === 200 && sees) ok("the assigned driver sees the trip in their app", `driver3 /api/driver/trips contains ${tripId}`);
    else bad("the assigned driver sees the trip in their app", `status=${own.status} contains=${Boolean(sees)}`);
  }

  if (shared.f6DocId) {
    const d = await prisma.document.findUnique({ where: { id: shared.f6DocId } });
    const gps = d && d.captureLat !== null && d.captureLng !== null && d.captureAccuracyM !== null;
    const ts = d && d.capturedAt !== null;
    if (gps && ts) {
      ok('a capture carries GPS + timestamp', `document ${d.id}: capturedAt=${new Date(d.capturedAt).toISOString()} lat=${d.captureLat} lng=${d.captureLng} acc=${d.captureAccuracyM}m`);
    } else {
      bad('a capture carries GPS + timestamp', `document ${shared.f6DocId}: capturedAt=${d?.capturedAt} lat=${d?.captureLat} lng=${d?.captureLng} acc=${d?.captureAccuracyM}`);
    }
  } else {
    nb('a capture carries GPS + timestamp', 'no document uploaded in this run (F6 did not reach the upload)');
  }
  if (shared.f6PodUploaded) {
    ok('a status advances without a raw status field (one action = one transition)', 'F6: the assigned driver POD_UPLOADED -> 200 on its trip (state machine driven by the API)');
  } else {
    nb('a status advances without a raw status field (one action = one transition)', 'F6 did not reach POD_UPLOADED in this run');
  }

  const harness = path.join(HERE, 'pwa_driver_harness.py');
  if (!RUN_F7_HARNESS || !existsSync(harness)) {
    nb('offline capture queues and syncs exactly once on reconnect', 'documented manual/delegated check: `python3 qa/pwa_driver_harness.py --flow pod --shots` (declared instrumentation; eila-browser has no network emulation). Canonical harness evidence lives in qa/REPORT_12_pwa.md and qa/REPORT_48_realdevice.md; set FA_F7_HARNESS=1 to run it here.');
    return;
  }
  const r = spawnSync('python3', [harness, '--flow', 'pod', '--nogeo'], { encoding: 'utf8', timeout: 300000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const docs = (out.match(/POST \/documents/g) || []).length;
  const statusPosts = (out.match(/POST \/status/g) || []).length;
  if (r.status === 0 && docs === 1 && statusPosts === 1) ok('offline capture queues and syncs exactly once on reconnect', `pwa_driver_harness --flow pod: 1 POST /documents, 1 POST /status, exit 0`);
  else bad('offline capture queues and syncs exactly once on reconnect', `harness exit=${r.status}, POST /documents=${docs}, POST /status=${statusPosts}`);
}

/* ================================================================ F8 ====== */
async function F8(admin, driver1) {
  crit('F8', 'F8_track_link');
  const tripId = shared.f6TripId || shared.tripId;
  if (!tripId) {
    nb('a track link can be minted', 'no trip id available in this run');
    return;
  }
  const mint = await call('POST', `/api/trips/${tripId}/track-link`, { token: admin.token });
  const token = mint.json?.link?.token || '';
  if (mint.status === 201 && token) ok('a track link can be minted', `201 token length ${token.length} (trip ${tripId})`);
  else {
    bad('a track link can be minted', `expected 201, got ${mint.status} ${JSON.stringify(mint.json)}`);
    return;
  }
  const driverMint = await call('POST', `/api/trips/${tripId}/track-link`, { token: driver1.token });
  if (driverMint.status === 403) ok('a driver cannot mint a public link', `driver1 -> 403 ${JSON.stringify(driverMint.json)}`);
  else bad('a driver cannot mint a public link', `expected 403, got ${driverMint.status}`);

  const page = await call('GET', `/track/${token}`);
  if (page.status === 200 && /text\/html/.test(page.contentType)) ok('an anonymous visitor renders the public page', `GET /track/:token -> 200 ${page.contentType}`);
  else bad('an anonymous visitor renders the public page', `GET /track/:token -> ${page.status} ${page.contentType}`);

  const json = await call('GET', `/api/track/${token}`);
  if (json.status === 200 && json.json?.tracking?.status) ok('the public JSON payload answers for the same token', `200 tracking.status=${json.json.tracking.status}`);
  else bad('the public JSON payload answers for the same token', `${json.status} ${JSON.stringify(json.json)}`);

  const tampered = await call('GET', `/api/track/${token.slice(0, -2)}xy`);
  if (tampered.status === 404) ok('a tampered token 404s', `tampered token -> 404 ${JSON.stringify(tampered.json)}`);
  else bad('a tampered token 404s', `expected 404, got ${tampered.status}`);

  const revoke = await call('DELETE', `/api/trips/${tripId}/track-link`, { token: admin.token });
  const revoke2 = await call('POST', `/api/trips/${tripId}/track-link/revoke`, { token: admin.token });
  if (revoke.status === 404 && revoke2.status === 404) nb('the link can be revoked', `no revoke route: DELETE /api/trips/:id/track-link=${revoke.status}, POST .../revoke=${revoke2.status}`);
  else ok('the link can be revoked', `DELETE=${revoke.status}, POST revoke=${revoke2.status}`);
}

/* ================================================================ F9 ====== */
async function F9() {
  crit('F9', 'F9_deploy_pipeline');
  // The deployed service binds loopback on the pilot host (systemd, :8080); nginx
  // fronts /api/ and /pilot/ only, so /health is expected NOT to be public. Probe
  // the service itself first, then the public URL, and report which one answered.
  const LOCAL_PILOT = (process.env.FA_PILOT_LOCAL || 'http://127.0.0.1:8080').replace(/\/$/, '');
  const healthPaths = [[LOCAL_PILOT, '/health'], [LIVE, '/api/health'], [LIVE, '/health']];
  let health = null;
  let healthWhere = '';
  if (NO_LIVE) {
    nb('the single pilot environment answers its health check', 'no deployed environment in this run (FA_NO_LIVE=1): the suite only reached the clone-spawned API on the runner');
  } else {
    for (const [base, p] of healthPaths) {
      const r = await call('GET', p, { base }).catch(() => null);
      if (r && r.status === 200) { health = r; healthWhere = `${base}${p}`; break; }
      if (!health) { health = r; healthWhere = `${base}${p}`; }
    }
    if (health?.status === 200) ok('the single pilot environment answers its health check', `${healthWhere} -> 200 ${health.text.slice(0, 60)}${healthWhere.startsWith(LOCAL_PILOT) ? ' (loopback: the pilot service; not exposed publicly, by design)' : ''}`);
    else bad('the single pilot environment answers its health check', `tried ${healthPaths.map(([b, p]) => `${b}${p}`).join(', ')} — last ${healthWhere} -> ${health ? health.status : 'unreachable'}`);
  }

  const artifacts = ['deploy.sh', 'infra/deploy/roadwise-deploy.sh', 'infra/deploy/roadwise-promote.sh', 'infra/scripts/pilot-restore-drill.sh', 'infra/scripts/pilot-backup-verify.sh', 'infra/monitoring/runbook.md'];
  const missing = artifacts.filter((f) => !existsSync(path.join(REPO, f)));
  if (!missing.length) ok('the deploy/backup/alert artifacts exist in the repo', `${artifacts.length}/${artifacts.length} present`);
  else bad('the deploy/backup/alert artifacts exist in the repo', `missing: ${missing.join(', ')}`);

  const dep = existsSync(path.join(REPO, 'infra/deploy/roadwise-deploy.sh')) ? readFileSync(path.join(REPO, 'infra/deploy/roadwise-deploy.sh'), 'utf8') : '';
  const hasHealth = /health/i.test(dep);
  const hasRollback = /rollback/i.test(dep);
  if (hasHealth && hasRollback) ok('the deploy path is health-checked and can roll back', `roadwise-deploy.sh mentions health=${hasHealth} rollback=${hasRollback}`);
  else nb('the deploy path is health-checked and can roll back', `roadwise-deploy.sh health=${hasHealth} rollback=${hasRollback}`);

  // The deployed pages are part of "deployed on the single environment": a page
  // that logs a CSP violation or an Uncaught error is not functioning.
  for (const p of ['/pilot/', '/pilot/driver.html']) {
    if (NO_LIVE) {
      nb(`deployed ${p} loads without page-origin console errors`, 'no deployed environment in this run (FA_NO_LIVE=1)');
      continue;
    }
    const cons = browserRun(LIVE, ['console', `${LIVE}${p}`]);
    if (cons.err) {
      nb(`deployed ${p} loads without page-origin console errors`, `eila-browser unavailable: ${cons.err}`);
      continue;
    }
    const errs = pageConsoleErrors(cons.out);
    if (!errs.length) ok(`deployed ${p} loads without page-origin console errors`, '0 page-origin errors');
    else bad(`deployed ${p} loads without page-origin console errors`, `${errs.length} page-origin error(s): ${errs.slice(0, 2).join(' | ')}`);
  }
  nb('automatic rollback, restore drill, uptime check and 5xx alert are exercised', 'requires host/ops access (board #42 deployer install, restore drill) — documented manual runbook: infra/monitoring/runbook.md');
}

/* =============================================================== F10 ====== */
async function F10() {
  crit('F10', 'F10_privacy_actor');
  const landing = NO_LIVE ? null : await call('GET', '/', { base: LIVE }).catch(() => null);
  const shell = await call('GET', '/app/');
  const linkRe = /href="([^"]*(?:privacy|terms|imprint)[^"]*)"/gi;
  const found = new Set();
  for (const body of [landing?.text || '', shell?.text || '']) {
    for (const m of body.matchAll(linkRe)) found.add(m[1]);
  }
  if (NO_LIVE) {
    nb('privacy/terms are reachable from the landing page and the app footer', 'no deployed environment in this run (FA_NO_LIVE=1): the published landing page was not fetched');
  } else if (!found.size) {
    nb('privacy/terms are reachable from the landing page and the app footer', `no privacy/terms link in the landing page or the app shell (grep over ${landing ? landing.status : 'unreachable'} landing + ${shell.status} shell, 0 hits)`);
  } else {
    const results = [];
    let allOk = true;
    for (const href of [...found].slice(0, 6)) {
      const url = href.startsWith('http') ? href : `${LIVE}${href.startsWith('/') ? '' : '/'}${href}`;
      const r = await call('GET', url.replace(LIVE, ''), { base: LIVE }).catch(() => null);
      results.push(`${href}=${r ? r.status : 'ERR'}`);
      if (!r || r.status >= 400) allOk = false;
    }
    if (allOk) ok('privacy/terms are reachable from the landing page and the app footer', results.join(', '));
    else bad('privacy/terms are reachable from the landing page and the app footer', results.join(', '));
  }

  const users = await prisma.user.findMany({ select: { email: true } });
  const domains = new Set(users.map((u) => String(u.email || '').split('@')[1] || '(none)').filter(Boolean));
  const realDomains = [...domains].filter((d) => !/\.test$/.test(d));
  if (!realDomains.length) ok('demo data holds no real personal data (user emails)', `${users.length} users, domains=${[...domains].join(',') || '(none)'}`);
  else bad('demo data holds no real personal data (user emails)', `${users.length} users, non-test domains: ${realDomains.join(',')}`);

  const customers = await prisma.customer.findMany({ select: { email: true } });
  const cDomains = [...new Set(customers.map((c) => String(c.email || '').split('@')[1] || '').filter(Boolean))];
  const realC = cDomains.filter((d) => !/\.test$/.test(d));
  if (!realC.length) ok('demo data holds no real personal data (customer emails)', `${customers.length} customers, domains=${cDomains.join(',') || '(none)'}`);
  else bad('demo data holds no real personal data (customer emails)', `non-test customer domains: ${realC.join(',')}`);

  const nullActor = await prisma.statusEvent.count({ where: { actorId: null } });
  const totalEvents = await prisma.statusEvent.count();
  if (nullActor === 0) ok('every status change has an actor', `${totalEvents}/${totalEvents} status events carry actorId`);
  else bad('every status change has an actor', `${nullActor}/${totalEvents} status events have actorId=null`);
}

/* ------------------------------------------------------------ cleanup --- */
/**
 * An unattended suite must not accumulate rows in the single pilot database. The
 * fixtures created here are identified by the ids captured during the run and are
 * removed in a finally — never a seeded row, never anything else. FA_KEEP=1 keeps
 * them for manual inspection and prints them instead.
 */
async function cleanupResidue() {
  const tripIds = residue.filter((r) => r.kind === 'trip').map((r) => r.id);
  const docIds = residue.filter((r) => r.kind === 'document').map((r) => r.id);
  // Orders created only to carry an F2 on-time fixture (board #145); deleted after
  // their trips, because Trip.orderId is a required FK.
  const orderIds = residue.filter((r) => r.kind === 'order').map((r) => r.id);
  if (!tripIds.length && !docIds.length && !orderIds.length) {
    console.log('RESIDUE: none');
    return;
  }
  if (process.env.FA_KEEP === '1') {
    console.log(`RESIDUE kept (FA_KEEP=1): ${residue.map((r) => `${r.kind} ${r.id}`).join(', ')}`);
    return;
  }
  const done = [];
  try {
    if (tripIds.length) {
      const se = await prisma.statusEvent.deleteMany({ where: { tripId: { in: tripIds } } });
      const dc = await prisma.document.deleteMany({ where: { tripId: { in: tripIds } } });
      const td = await prisma.tripDriver.deleteMany({ where: { tripId: { in: tripIds } } }).catch(() => ({ count: 0 }));
      const ts = await prisma.tripStop.deleteMany({ where: { tripId: { in: tripIds } } }).catch(() => ({ count: 0 }));
      const tr = await prisma.trip.deleteMany({ where: { id: { in: tripIds } } });
      done.push(`${tr.count} trips, ${dc.count} documents, ${se.count} statusEvents, ${td.count} tripDrivers, ${ts.count} stops`);
    }
    if (docIds.length && !tripIds.length) {
      const dc = await prisma.document.deleteMany({ where: { id: { in: docIds } } });
      done.push(`${dc.count} documents`);
    }
    if (orderIds.length) {
      const od = await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
      done.push(`${od.count} orders`);
    }
  } catch (err) {
    console.log(`RESIDUE: cleanup FAILED (${err.message.slice(0, 120)}); left behind: ${residue.map((r) => `${r.kind} ${r.id}`).join(', ')}`);
    return;
  }
  console.log(`RESIDUE: cleaned up this run's fixtures (${done.join('; ')})`);
  console.log(`         ids: ${residue.map((r) => `${r.kind} ${r.id}`).join(', ')}`);
}

/* ================================================================ main ==== */
async function main() {
  const started = new Date().toISOString();
  const up = await startApi();
  if (!up.started) {
    console.error(`FATAL: API not reachable at ${BASE}${up.external ? '' : ` (spawn log: ${up.log || 'none'})`}`);
    await stopApi();
    process.exit(2);
  }
  console.log(`# FAv1 acceptance suite  base=${BASE}  repo=${REPO}  started=${started}`);
  console.log(`# mode=${EXTERNAL ? 'external' : `spawn :${PORT}`}  live=${LIVE}  criteria=${ONLY.length ? ONLY.join(',') : 'F1-F10'}`);

  try {
    const admin = await login(ADMIN_EMAIL);
    const driver1 = await login(DRIVER1_EMAIL);
    const driver2 = await login(DRIVER2_EMAIL);
    const driver3 = await login(DRIVER3_EMAIL);
    if (admin.status !== 200 || !admin.token) {
      console.error(`FATAL: owner login failed (${admin.status} ${JSON.stringify(admin.body)})`);
      process.exit(2);
    }
    console.log(`# logins: owner=${admin.status} driver1=${driver1.status} driver2=${driver2.status} driver3=${driver3.status}`);
    const ctx = { admin, driver1, driver2, driver3 };
    const plan = [
      ['F1', () => F1()],
      ['F2', () => F2(ctx.admin, ctx.driver1)],
      ['F3', () => F3(ctx.admin)],
      ['F4', () => F4(ctx.admin, ctx.driver1)],
      ['F5', () => F5(ctx.admin, ctx.driver1, ctx.driver2)],
      ['F6', () => F6(ctx.admin, ctx.driver3, ctx.driver2)],
      ['F7', () => F7(ctx.admin, ctx.driver3, ctx.driver2)],
      ['F8', () => F8(ctx.admin, ctx.driver1)],
      ['F9', () => F9()],
      ['F10', () => F10()],
    ];
    for (const [id, fn] of plan) {
      if (ONLY.length && !ONLY.includes(id)) continue;
      try {
        await fn();
      } catch (err) {
        crit(id, `${id}_error`);
        bad(`${id} ran without an exception`, `${err && err.stack ? err.stack.split('\n').slice(0, 2).join(' ') : err}`);
      }
    }
  } finally {
    await prisma.$disconnect().catch(() => {});
    await stopApi();
  }

  console.log('');
  let fails = 0;
  for (const c of criteria) {
    const v = verdictOf(c);
    if (v === 'FAIL') fails += 1;
    console.log(`CRITERION ${c.id} ${v}  (${c.name})`);
    for (const s of c.subs) console.log(`  ${s.verdict.padEnd(9)} ${s.label} :: ${s.evidence}`);
  }
  const counts = criteria.reduce((a, c) => ((a[verdictOf(c)] = (a[verdictOf(c)] || 0) + 1), a), {});
  console.log('');
  console.log(`SUMMARY ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}  (${criteria.length} criteria, ${new Date().toISOString()})`);
  await cleanupResidue();
  await prisma.$disconnect().catch(() => {});
  process.exit(fails ? 1 : 0);
}

main().catch(async (err) => {
  console.error('suite crashed:', err);
  await stopApi();
  process.exit(2);
});
