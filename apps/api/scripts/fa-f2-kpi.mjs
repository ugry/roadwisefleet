/**
 * F2 KPI reconciliation — the pure matchers behind the FAv1 F2 criterion.
 * Board task eila/tasks#145 (FAv1-QA1c).
 *
 * Why this is a module and not inline code: F2's first revision was a stub. It
 * read `r.json.kpis || r.json` against a route that answers `{ dashboard: { … } }`
 * (so it reconciled the wrapper), and its last two sub-checks were hardcoded
 * `nb(...)` rows that never probed anything. The suite therefore reported
 * NOT_BUILT against a built F2 — a gate that can never go green hides a real
 * regression later. Keeping the matchers pure makes them testable, and
 * `selfTest()` lets the suite prove ON EVERY RUN that each matcher can still go
 * RED: a matcher that always returns true is the same defect in another shape.
 *
 * Independence rule: this module never imports `apps/api/src/dashboard.js`. The
 * expected value is re-derived from the database by the caller, so a wrong
 * definition on either side shows up as a mismatch instead of cancelling out.
 *
 * Definitions re-derived here come from the shipped payload contract
 * (`apps/api/src/dashboard.js`, FAv1 §3 F2 "every KPI equals a direct DB query"):
 *   activeTrips    trips whose status is not terminal — SETTLED, CANCELLED
 *   onTimePct      share of delivered trips (DELIVERED, POD_UPLOADED, INVOICED,
 *                  SETTLED) with BOTH Trip.deliveredAt and Order.plannedAt set
 *                  that were delivered at or before the planned time; `null`
 *                  (never 0/100) when nothing is comparable
 *   pendingPayEur  SUM(Trip.rateEur) over INVOICED trips
 */

/** Trips in these statuses are done — excluded from the active-trips KPI. */
export const TERMINAL_STATUSES = ['SETTLED', 'CANCELLED'];

/** Statuses that count as delivered for the on-time KPI. */
export const DELIVERED_STATUSES = ['DELIVERED', 'POD_UPLOADED', 'INVOICED', 'SETTLED'];

/** Status a trip must hold to be part of the pending-pay KPI. */
export const INVOICED_STATUS = 'INVOICED';

/** A trip in one of these statuses with no driver is a `trip_unassigned` alert. */
export const UNASSIGNED_STATUSES = ['ASSIGNED', 'LOADED', 'IN_TRANSIT'];

/** @param {number} n @returns {number} */
export function round1(n) {
  return Math.round(n * 10) / 10;
}

/** @param {number} n @returns {number} */
export function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * The route answers `{ dashboard: { … } }`; older/other surfaces answer the
 * payload bare. Both are accepted, the wrapper is unwrapped exactly once.
 * @param {unknown} body
 * @returns {any}
 */
export function unwrapDashboard(body) {
  if (!body || typeof body !== 'object') return {};
  const wrapped = /** @type {any} */ (body).dashboard;
  const payload = wrapped && typeof wrapped === 'object' ? wrapped : body;
  return payload && typeof payload === 'object' ? payload : {};
}

/** @param {any} dashboard @param {string} key @returns {any|null} */
export function kpiOf(dashboard, key) {
  const kpis = dashboard && dashboard.kpis;
  if (!kpis || typeof kpis !== 'object') return null;
  const kpi = kpis[key];
  return kpi && typeof kpi === 'object' ? kpi : null;
}

/**
 * The on-time share the way §3 defines it, computed from timestamps only.
 * Rows missing either timestamp are excluded from numerator AND denominator;
 * an empty denominator is `null` (unknown), never 0.
 * @param {Array<{ deliveredAt?: unknown, plannedAt?: unknown }>} rows
 * @returns {{ value: number|null, onTime: number, sample: number }}
 */
export function onTimeFromRows(rows) {
  const comparable = (rows || []).filter((r) => r && r.deliveredAt != null && r.plannedAt != null);
  const onTime = comparable.filter(
    (r) => new Date(/** @type {any} */ (r.deliveredAt)).getTime() <= new Date(/** @type {any} */ (r.plannedAt)).getTime(),
  ).length;
  const sample = comparable.length;
  return { value: sample === 0 ? null : round1((onTime / sample) * 100), onTime, sample };
}

/**
 * `kpis.activeTrips.value` must equal the count of non-terminal trips.
 * @param {any} kpi @param {number} expected
 */
export function reconcileActiveTrips(kpi, expected) {
  const raw = kpi ? kpi.value : undefined;
  const value = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
  const ok = Number.isFinite(value) && value === expected;
  return {
    ok,
    evidence: `kpis.activeTrips.value=${raw === undefined ? 'missing' : raw} vs DB count(status not in [${TERMINAL_STATUSES.join(',')}])=${expected}`,
  };
}

/**
 * `kpis.pendingPayEur` must equal SUM(rateEur) over INVOICED trips. Prisma
 * `Decimal` reaches JSON as a string, so the comparison is numeric and the raw
 * value (with its type) is kept in the evidence.
 * @param {any} kpi @param {{ value: number, count: number }} expected
 */
export function reconcilePendingPay(kpi, expected) {
  const rawValue = kpi ? kpi.value : undefined;
  const rawCount = kpi ? kpi.count : undefined;
  const value = rawValue === null || rawValue === undefined || rawValue === '' ? NaN : Number(rawValue);
  const count = rawCount === undefined ? NaN : Number(rawCount);
  const ok = Number.isFinite(value) && value === expected.value && count === expected.count;
  return {
    ok,
    evidence: `kpis.pendingPayEur.value=${rawValue === undefined ? 'missing' : `${JSON.stringify(rawValue)} (${typeof rawValue})`} count=${rawCount} vs DB sum(rateEur where status=${INVOICED_STATUS})=${expected.value} count=${expected.count}`,
  };
}

/**
 * `kpis.onTimePct` must equal the timestamp-derived share, including the honest
 * null when nothing is comparable.
 * @param {any} kpi @param {{ value: number|null, onTime: number, sample: number }} expected
 */
export function reconcileOnTime(kpi, expected) {
  const rawValue = kpi ? kpi.value : undefined;
  const rawOnTime = kpi ? kpi.onTime : undefined;
  const rawSample = kpi ? kpi.sample : undefined;
  const valueMatches =
    expected.value === null
      ? rawValue === null
      : typeof rawValue === 'number' && Number.isFinite(rawValue) && round1(rawValue) === expected.value;
  const ok = valueMatches && Number(rawOnTime) === expected.onTime && Number(rawSample) === expected.sample;
  const asText = (v) => (v === undefined ? 'missing' : JSON.stringify(v));
  return {
    ok,
    evidence: `kpis.onTimePct={value:${asText(rawValue)},onTime:${asText(rawOnTime)},sample:${asText(rawSample)}} vs timestamps deliveredAt<=order.plannedAt over delivered trips -> {value:${JSON.stringify(expected.value)},onTime:${expected.onTime},sample:${expected.sample}}`,
  };
}

/**
 * "Each alert links to the entity it names" (FAv1 §3 F2), checked structurally:
 * every alert carries an id and a kind, it names a trip id, its link is a trips
 * route, the link carries THAT id, the trip exists in this org, and — when the
 * caller probed it over HTTP — the route answered 200.
 * @param {any[]} alerts
 * @param {{ tripIds?: string[], linkStatus?: Record<string, number>, orgId?: string }} opts
 * @returns {{ ok: boolean, evidence: string, problems: string[] }}
 */
export function checkAlertLinks(alerts, opts) {
  const options = opts || {};
  const known = new Set((options.tripIds || []).map(String));
  const probed = options.linkStatus || null;
  const problems = [];
  const list = Array.isArray(alerts) ? alerts : [];
  for (const a of list) {
    const label = a && a.id ? String(a.id) : JSON.stringify(a).slice(0, 80);
    const tripId = a && a.tripId != null ? String(a.tripId) : '';
    const link = a && a.link != null ? String(a.link) : '';
    if (!a || !a.id || !a.kind) problems.push(`${label}: alert without id/kind`);
    else if (!tripId) problems.push(`${label}: no tripId to name`);
    else if (!link.startsWith('/app/trips/')) problems.push(`${label}: link "${link}" is not a trips route`);
    else if (!link.slice('/app/trips/'.length).startsWith(encodeURIComponent(tripId)) && !link.slice('/app/trips/'.length).startsWith(tripId))
      problems.push(`${label}: link "${link}" does not name trip ${tripId}`);
    else if (!known.has(tripId)) problems.push(`${label}: names trip ${tripId}, which is not in org ${options.orgId || '(unknown)'}`);
    else if (probed && probed[link] !== undefined && probed[link] !== 200) problems.push(`${label}: link ${link} -> ${probed[link]}`);
    else if (probed && probed[link] === undefined) problems.push(`${label}: link ${link} was not probed over HTTP`);
  }
  const kinds = [...new Set(list.map((a) => (a && a.kind ? String(a.kind) : '?')))];
  const evidence = list.length
    ? `${list.length} alert(s) kinds=[${kinds.join(',')}]${probed ? `, ${Object.keys(probed).length} link(s) probed` : ''}${options.orgId ? `, org ${options.orgId}` : ''}`
    : 'no alert returned';
  return { ok: problems.length === 0 && list.length > 0, evidence: problems.length ? `${problems.length} problem(s): ${problems.slice(0, 3).join(' | ')}` : evidence, problems };
}

/**
 * Every matcher above is proven against a payload it must ACCEPT and one it must
 * REJECT. The reject cases are the shapes this criterion has actually been
 * wrong about before (the wrapper read as the KPI payload; active trips compared
 * against all trips; a 0-sample rendered as 0 instead of null; an alert linking
 * somewhere that is not its entity).
 * @returns {{ ok: boolean, rows: Array<{ name: string, ok: boolean, evidence: string }> }}
 */
export function selfTest() {
  const rows = [];
  const t = (name, ok, evidence) => rows.push({ name, ok: Boolean(ok), evidence: String(evidence) });

  const wrapped = unwrapDashboard({ dashboard: { kpis: { activeTrips: { value: 49 } } } });
  t('unwrap the {dashboard} wrapper', kpiOf(wrapped, 'activeTrips')?.value === 49, `keys=${Object.keys(wrapped).join(',')}`);
  const bare = unwrapDashboard({ kpis: { activeTrips: { value: 3 } } });
  t('accept a bare payload', kpiOf(bare, 'activeTrips')?.value === 3, `keys=${Object.keys(bare).join(',')}`);
  t('an empty body is an empty payload', Object.keys(unwrapDashboard(undefined)).length === 0, `keys=${Object.keys(unwrapDashboard(undefined)).join(',')}`);

  const green = reconcileActiveTrips({ value: 49 }, 49);
  t('activeTrips matching the DB -> ok', green.ok === true, green.evidence);
  const redAll = reconcileActiveTrips({ value: 49 }, 50);
  t('activeTrips compared against ALL trips -> not ok', redAll.ok === false, redAll.evidence);
  t('activeTrips missing -> not ok', reconcileActiveTrips(null, 49).ok === false, reconcileActiveTrips(null, 49).evidence);

  const onTimeGreen = reconcileOnTime({ value: 25, onTime: 1, sample: 4 }, { value: 25, onTime: 1, sample: 4 });
  t('on-time 1/4 = 25% -> ok', onTimeGreen.ok === true, onTimeGreen.evidence);
  const onTimeNull = onTimeFromRows([]);
  t('an empty sample derives null, not 0', onTimeNull.value === null, JSON.stringify(onTimeNull));
  const zeroInsteadOfNull = reconcileOnTime({ value: 0, onTime: 0, sample: 0 }, onTimeNull);
  t('a fabricated 0 for an empty sample -> not ok', zeroInsteadOfNull.ok === false, zeroInsteadOfNull.evidence);
  const onTimeOff = reconcileOnTime({ value: 24.9, onTime: 1, sample: 4 }, { value: 25, onTime: 1, sample: 4 });
  t('on-time off by one tenth -> not ok', onTimeOff.ok === false, onTimeOff.evidence);
  t(
    'late deliveries are not on time',
    onTimeFromRows([
      { deliveredAt: '2026-01-01T10:00:00Z', plannedAt: '2026-01-01T09:00:00Z' },
      { deliveredAt: '2026-01-01T08:00:00Z', plannedAt: '2026-01-01T09:00:00Z' },
    ]).value === 50,
    JSON.stringify(onTimeFromRows([{ deliveredAt: '2026-01-01T10:00:00Z', plannedAt: '2026-01-01T09:00:00Z' }, { deliveredAt: '2026-01-01T08:00:00Z', plannedAt: '2026-01-01T09:00:00Z' }])),
  );

  const payGreen = reconcilePendingPay({ value: '512.5', count: 2 }, { value: 512.5, count: 2 });
  t('a Prisma Decimal string reconciles numerically', payGreen.ok === true, payGreen.evidence);
  const payRed = reconcilePendingPay({ value: '512.5', count: 2 }, { value: 512.5, count: 3 });
  t('pending-pay count mismatch -> not ok', payRed.ok === false, payRed.evidence);

  const links = [{ id: 'unassigned:t1', kind: 'trip_unassigned', tripId: 't1', link: '/app/trips/t1' }];
  const linksGreen = checkAlertLinks(links, { tripIds: ['t1'], linkStatus: { '/app/trips/t1': 200 }, orgId: 'qa-org' });
  t('an alert linking to its own trip -> ok', linksGreen.ok === true, linksGreen.evidence);
  const linksWrongTrip = checkAlertLinks([{ id: 'x', kind: 'trip_unassigned', tripId: 't1', link: '/app/trips/t2' }], { tripIds: ['t1', 't2'] });
  t('an alert linking to another trip -> not ok', linksWrongTrip.ok === false, linksWrongTrip.evidence);
  const linksDead = checkAlertLinks(links, { tripIds: ['t1'], linkStatus: { '/app/trips/t1': 404 } });
  t('an alert link that 404s -> not ok', linksDead.ok === false, linksDead.evidence);
  const linksUnprobed = checkAlertLinks(links, { tripIds: ['t1'], linkStatus: {} });
  t('an alert link that was never probed -> not ok', linksUnprobed.ok === false, linksUnprobed.evidence);
  const noAlerts = checkAlertLinks([], { tripIds: [] });
  t('an empty alert list does not pass vacuously', noAlerts.ok === false, noAlerts.evidence);

  // Board #146: the payload can hold ALERT_LIMIT = 20 alerts, so a probe that
  // walks a fixed prefix of 8 must be distinguishable from one that walks them
  // all. Both rows below use the same 9-alert payload; only the probe map differs.
  const nineTrips = Array.from({ length: 9 }, (_, i) => `t${i + 1}`);
  const nineAlerts = nineTrips.map((tripId, i) => ({ id: `alert-${i + 1}`, kind: 'trip_unassigned', tripId, link: `/app/trips/${tripId}` }));
  const linkFor = (tripId) => ({ [`/app/trips/${tripId}`]: 200 });
  const nineProbed = checkAlertLinks(nineAlerts, { tripIds: nineTrips, linkStatus: Object.assign({}, ...nineTrips.map(linkFor)), orgId: 'qa-org' });
  t('9 alerts with every link probed -> ok', nineProbed.ok === true, nineProbed.evidence);
  const eightProbed = checkAlertLinks(nineAlerts, { tripIds: nineTrips, linkStatus: Object.assign({}, ...nineTrips.slice(0, 8).map(linkFor)), orgId: 'qa-org' });
  t('9 alerts with the 9th link unprobed -> not ok', eightProbed.ok === false, eightProbed.evidence);

  return { ok: rows.every((r) => r.ok), rows };
}
