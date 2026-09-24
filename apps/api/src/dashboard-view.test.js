/**
 * Dashboard view model (board task #33, FAv1-F2) — dependency-free coverage for
 * `app/lib/dashboard.js`, the pure shaping the Fleet Manager home renders.
 *
 * Runs under the no-install CI job (`node --test apps/api/src/`), so it imports
 * only `node:*` builtins plus the CJS view model. The end-to-end render (the
 * real `app.js` against a stub DOM + `GET /api/dashboard`) is exercised by
 * `scratch/verify-dashboard.js`; the API side by `dashboard.test.js` and
 * `test/dashboard.test.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import dash from '../../../app/lib/dashboard.js';

/** The real catalogue keys, so a missing key is a failure, not an empty label. */
const t = (key, params) => {
  if (params) return `${key}(${Object.keys(params).sort().join(',')})`;
  return key;
};

const EMPTY = { kpis: {}, alerts: [], activity: [] };

const FIXTURE = {
  kpis: {
    activeTrips: { value: 7, link: '/app/trips?status=DRAFT' },
    onTimePct: { value: 66.7, onTime: 2, sample: 3, link: '/app/trips?status=DELIVERED' },
    pendingPayEur: { value: 1450, count: 2, link: '/app/trips?status=INVOICED' },
  },
  alerts: [
    { id: 'unassigned:t9', kind: 'trip_unassigned', severity: 'high', tripId: 't9', route: 'Berlin → Hamburg', link: '/app/trips/t9' },
    { id: 'document:d1', kind: 'document_expired', severity: 'high', tripId: 't2', docType: 'insurance', expiresAt: '2026-09-20T00:00:00.000Z', link: '/app/trips/t2' },
    { id: 'document:d2', kind: 'document_expiring', severity: 'medium', tripId: 't3', docType: 'cpc', expiresAt: '2026-10-01T00:00:00.000Z', link: '/app/trips/t3' },
    { id: 'settlement:s1', kind: 'settlement_pending', severity: 'medium', tripId: 't4', amountEur: 320, link: '/app/trips/t4' },
  ],
  activity: [
    { id: 'ev1', tripId: 't1', from: 'LOADED', to: 'IN_TRANSIT', at: '2026-09-24T09:00:00.000Z', actor: { id: 'u1', name: 'Olive' }, link: '/app/trips/t1' },
    { id: 'ev2', tripId: 't2', from: 'DRAFT', to: 'ASSIGNED', at: '2026-09-24T08:00:00.000Z', actor: null, link: '/app/trips/t2' },
  ],
};

test('kpiCards renders the three KPIs in order, each with its drill-down link', () => {
  const cards = dash.kpiCards(FIXTURE, t);
  assert.deepEqual(cards.map((c) => c.id), ['activeTrips', 'onTimePct', 'pendingPayEur']);
  assert.equal(cards[0].label, 'dashboard.kpi.activeTrips');
  assert.equal(cards[0].value, '7');
  assert.equal(cards[0].link, '/app/trips?status=DRAFT');
  assert.equal(cards[0].empty, false);
  assert.equal(cards[1].value, '66.7%');
  assert.equal(cards[1].note, 'dashboard.kpi.onTimeNote(onTime,sample)');
  assert.equal(cards[2].value, '1450 €');
  assert.equal(cards[2].note, 'dashboard.kpi.pendingPayNote(count)');
});

test('an unknown KPI value renders the placeholder, never a fabricated 0', () => {
  const cards = dash.kpiCards({ kpis: { onTimePct: { value: null, sample: 0 } } }, t);
  const onTime = cards.find((c) => c.id === 'onTimePct');
  assert.equal(onTime.value, 'trips.none');
  assert.equal(onTime.empty, true);
  assert.equal(onTime.note, null);
  // A genuinely empty payload still produces the three labelled cards.
  assert.equal(dash.kpiCards(EMPTY, t).length, 3);
  assert.equal(dash.kpiCards(EMPTY, t)[0].value, '0');
});

test('kpiCards uses the i18n formatters when they are present', () => {
  const i18n = {
    percent: (n) => `${Math.round(n * 1000) / 10} pct`,
    currency: (n) => `€${n}`,
  };
  const cards = dash.kpiCards(FIXTURE, t, i18n);
  assert.equal(cards[1].value, '66.7 pct');
  assert.equal(cards[2].value, '€1450');
});

test('alertItems labels each alert from its own fields and links to its trip', () => {
  const items = dash.alertItems(FIXTURE, t);
  assert.equal(items.length, 4);
  assert.equal(items[0].text, 'dashboard.alert.unassigned(amount,date,docType,route,trip)');
  assert.equal(items[0].link, '/app/trips/t9');
  assert.equal(items[1].text, 'dashboard.alert.documentExpired(amount,date,docType,route,trip)');
  assert.equal(items[2].text, 'dashboard.alert.documentExpiring(amount,date,docType,route,trip)');
  assert.equal(items[3].text, 'dashboard.alert.settlementPending(amount,date,docType,route,trip)');
  for (const item of items) assert.match(item.link, /^\/app\/trips\//);
});

test('alertItems translates the document type through the catalogue', () => {
  const withTypes = (key, params) => {
    if (key === 'trips.doctype.insurance') return 'Insurance';
    return params ? `${key}${JSON.stringify(params)}` : key;
  };
  const items = dash.alertItems(FIXTURE, withTypes);
  const expired = items.find((i) => i.kind === 'document_expired');
  assert.ok(expired.text.includes('"docType":"Insurance"'), 'the type key is resolved, not printed raw');
});

test('activityItems names the transition, the actor and the trip link', () => {
  const items = dash.activityItems(FIXTURE, t);
  assert.equal(items.length, 2);
  assert.equal(items[0].text, 'trips.status.LOADED → trips.status.IN_TRANSIT');
  assert.equal(items[0].actor, 'Olive');
  assert.equal(items[0].link, '/app/trips/t1');
  // No actor recorded: the system label, never an empty string.
  assert.equal(items[1].actor, 'trips.actorSystem');
});

test('statusKey mirrors the trips-list catalogue keys', () => {
  assert.equal(dash.statusKey('IN_TRANSIT'), 'trips.status.IN_TRANSIT');
  assert.equal(dash.statusKey(null), 'trips.status.');
});

test('hasContent reports which strips have real data', () => {
  assert.deepEqual(dash.hasContent(EMPTY), { kpis: false, alerts: false, activity: false, anywhere: false });
  const full = dash.hasContent(FIXTURE);
  assert.equal(full.kpis, true);
  assert.equal(full.alerts, true);
  assert.equal(full.activity, true);
  assert.equal(full.anywhere, true);
});

test('the view model never invents a number and never reads a clock', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../../../app/lib/dashboard.js', import.meta.url), 'utf8');
  assert.ok(!/Date\.now|new Date\(/.test(source), 'the payload carries its timestamps; the view model must not read the clock');
  assert.ok(!/Math\.random/.test(source));
  assert.ok(!/innerHTML|document\.|fetch\(/.test(source), 'the view model is DOM- and network-free');
});
