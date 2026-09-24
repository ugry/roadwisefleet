/**
 * Dashboard KPIs (board task #33, FAv1-F2).
 *
 * The app home is a dashboard, not a mockup: a KPI strip (active trips, on-time
 * %, pending pay), an alerts strip and today's activity feed (from status
 * events). Every number in the payload is the result of a database query
 * against the caller's org — there is no sample or hardcoded value anywhere.
 *
 * Decoupled from Fastify and from Prisma's concrete client so it is covered by
 * the no-install CI job (`node --test apps/api/src/`) against a fake client,
 * with no database. The route layer (`routes/dashboard.ts`) only does auth, the
 * `reports:read` capability check and the HTTP mapping.
 *
 * Tenancy is always the caller's `orgId` (from the signed token, never the
 * client) and every query filters on it, either directly (`Trip.orgId`) or
 * through the trip relation (`Document.trip.orgId`).
 *
 * Definitions (the tester re-derives each of these with a direct SQL/Prisma
 * query — the exact aggregate is named in `kpis.*.query`):
 *
 *   activeTrips    COUNT(*) trips in the org whose status is not terminal
 *                  (TERMINAL_STATUSES = SETTLED, CANCELLED).
 *   onTimePct      among trips with a delivery status AND both `Trip.deliveredAt`
 *                  and `Order.plannedAt` recorded, the share delivered at or
 *                  before the planned time. `null` when there is no comparable
 *                  trip (never a fabricated 0/100).
 *   pendingPayEur  SUM(rateEur) over the org's INVOICED trips — work invoiced
 *                  but not yet settled. (F10 will extend this to the settlement
 *                  ledger; until then it is one trip aggregate and drills into
 *                  exactly those rows.)
 *
 * Time is always evaluated in UTC: "today" is the current UTC calendar day.
 */

/** Trips in these statuses are done — excluded from the active-trips KPI. */
export const TERMINAL_STATUSES = ['SETTLED', 'CANCELLED'];

/** The complement of TERMINAL_STATUSES: what "active trips" counts. */
export const ACTIVE_STATUSES = ['DRAFT', 'ASSIGNED', 'LOADED', 'IN_TRANSIT', 'DELIVERED', 'POD_UPLOADED', 'INVOICED'];

/** Trips in these statuses count as delivered for the on-time KPI. */
export const DELIVERED_STATUSES = ['DELIVERED', 'POD_UPLOADED', 'INVOICED', 'SETTLED'];

/** Status a trip must hold to be part of the pending-pay KPI. */
export const INVOICED_STATUS = 'INVOICED';

/** A trip in one of these statuses must have a driver — otherwise it is an alert. */
export const UNASSIGNED_STATUSES = ['ASSIGNED', 'LOADED', 'IN_TRANSIT'];

/** Compliance documents expiring within this window raise an alert. */
export const EXPIRY_WINDOW_DAYS = 30;

/** Caps, so one busy org cannot turn the home screen into an endless list. */
export const ACTIVITY_LIMIT = 20;
export const ALERT_LIMIT = 20;

/** The trips-list URL a KPI drills into (board task #34 filters). */
export const TRIPS_PATH = '/app/trips';

/**
 * @typedef {Object} DashboardClient
 * @property {any} trip
 * @property {any} statusEvent
 * @property {any} document
 * @property {any} settlement
 */

/** @param {Date|string|number} value @returns {Date} */
function asDate(value) {
  return value instanceof Date ? value : new Date(value);
}

/** Coerce a Prisma `Decimal | number | string | null` to a number (or null). */
export function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof value === 'object' && typeof (/** @type {any} */ (value).toNumber) === 'function') {
    const n = /** @type {any} */ (value).toNumber();
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** @param {number} n @returns {number} */
function round1(n) {
  return Math.round(n * 10) / 10;
}

/** @param {number} n @returns {number} */
function round2(n) {
  return Math.round(n * 100) / 100;
}

/** @param {unknown} value @returns {string|null} */
function toIso(value) {
  if (value === null || value === undefined) return null;
  const date = asDate(/** @type {any} */ (value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * The start of the current UTC calendar day — "today" for the activity feed.
 * @param {Date|string|number} [now]
 * @returns {Date}
 */
export function startOfUtcDay(now) {
  const date = now === undefined ? new Date() : asDate(now);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * The on-time share for a list of `{ deliveredAt, plannedAt }` pairs. Rows
 * missing either timestamp are excluded from BOTH the numerator and the
 * denominator; with an empty denominator the result is `null` (unknown, not 0).
 * Pure, so the arithmetic is unit-tested without a database.
 * @param {Array<{ deliveredAt?: unknown, plannedAt?: unknown }>} rows
 * @returns {{ value: number|null, onTime: number, sample: number }}
 */
export function onTimeShare(rows) {
  const comparable = (rows || []).filter((row) => row && row.deliveredAt != null && row.plannedAt != null);
  const onTime = comparable.filter(
    (row) => asDate(/** @type {any} */ (row.deliveredAt)).getTime() <= asDate(/** @type {any} */ (row.plannedAt)).getTime(),
  ).length;
  const sample = comparable.length;
  return { value: sample === 0 ? null : round1((onTime / sample) * 100), onTime, sample };
}

/** The drill-down link for a trip. */
function tripLink(tripId) {
  return TRIPS_PATH + '/' + encodeURIComponent(String(tripId));
}

/** The trips-list link for a set of statuses. */
function statusLink(statuses) {
  return TRIPS_PATH + '?status=' + statuses.map(encodeURIComponent).join(',');
}

/**
 * Shape the raw query results into the dashboard payload. Pure: the queries are
 * in `loadDashboard`, so the KPI arithmetic and the alert shaping can be tested
 * with plain objects and a fixed `now`.
 * @param {{ activeTrips: number, delivered: any[], pendingPay: any, activity: any[], unassigned: any[], expiring: any[], settlements: any[] }} raw
 * @param {{ now?: Date|string|number }} [options]
 * @returns {any}
 */
export function shapeDashboard(raw, options) {
  const now = options && options.now !== undefined ? asDate(options.now) : new Date();
  const todayStart = startOfUtcDay(now);

  const delivered = (raw.delivered || []).map((trip) => ({
    deliveredAt: trip && trip.deliveredAt,
    plannedAt: trip && trip.order ? trip.order.plannedAt : null,
  }));
  const onTime = onTimeShare(delivered);

  const pendingSum = raw.pendingPay && raw.pendingPay._sum ? toNumber(raw.pendingPay._sum.rateEur) : null;
  const pendingCount = raw.pendingPay && typeof raw.pendingPay._count === 'number' ? raw.pendingPay._count : 0;

  /** @type {any[]} */
  const alerts = [];

  for (const trip of raw.unassigned || []) {
    alerts.push({
      id: 'unassigned:' + String(trip.id),
      kind: 'trip_unassigned',
      severity: 'high',
      tripId: String(trip.id),
      status: trip.status,
      route: trip.order ? [trip.order.origin, trip.order.destination].filter(Boolean).join(' → ') : null,
      at: toIso(trip.createdAt),
      link: tripLink(trip.id),
    });
  }

  for (const doc of raw.expiring || []) {
    const expiresAt = toIso(doc.expiresAt);
    const expired = expiresAt !== null && asDate(expiresAt).getTime() < now.getTime();
    alerts.push({
      id: 'document:' + String(doc.id),
      kind: expired ? 'document_expired' : 'document_expiring',
      severity: expired ? 'high' : 'medium',
      tripId: String(doc.tripId),
      docType: doc.docType,
      status: doc.status,
      expiresAt,
      link: tripLink(doc.tripId),
    });
  }

  for (const settlement of raw.settlements || []) {
    alerts.push({
      id: 'settlement:' + String(settlement.id),
      kind: 'settlement_pending',
      severity: 'medium',
      tripId: String(settlement.tripId),
      amountEur: toNumber(settlement.amountEur),
      at: toIso(settlement.createdAt),
      link: tripLink(settlement.tripId),
    });
  }

  // Highest severity first, then most recent — a stable order for the UI.
  const rank = { high: 0, medium: 1, low: 2 };
  alerts.sort((a, b) => {
    const bySeverity = (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9);
    if (bySeverity !== 0) return bySeverity;
    return String(b.at || b.expiresAt || '').localeCompare(String(a.at || a.expiresAt || ''));
  });

  const activity = (raw.activity || []).map((event) => ({
    id: event.id,
    tripId: event.tripId,
    from: event.fromStatus,
    to: event.toStatus,
    at: toIso(event.happenedAt),
    actor: event.actor ? { id: event.actor.id, name: event.actor.name } : null,
    link: tripLink(event.tripId),
  }));

  return {
    generatedAt: now.toISOString(),
    today: todayStart.toISOString(),
    kpis: {
      activeTrips: {
        value: Number(raw.activeTrips || 0),
        link: statusLink(ACTIVE_STATUSES),
        query: 'count(trip where orgId and status not in [SETTLED, CANCELLED])',
      },
      onTimePct: {
        value: onTime.value,
        onTime: onTime.onTime,
        sample: onTime.sample,
        link: statusLink(DELIVERED_STATUSES),
        query: 'count(deliveredAt <= order.plannedAt) / count(deliveredAt and order.plannedAt both set) among delivered trips',
      },
      pendingPayEur: {
        value: pendingSum === null ? 0 : round2(pendingSum),
        count: pendingCount,
        link: statusLink([INVOICED_STATUS]),
        query: 'sum(trip.rateEur where orgId and status = INVOICED)',
      },
    },
    alerts: alerts.slice(0, ALERT_LIMIT),
    alertCounts: {
      unassigned: (raw.unassigned || []).length,
      documents: (raw.expiring || []).length,
      settlements: (raw.settlements || []).length,
      total: alerts.length,
    },
    activity,
  };
}

/**
 * Run the dashboard queries for one org and shape the result. All queries are
 * org-scoped and read-only; the four reads run in parallel so the home screen
 * stays inside the cold-cache budget.
 * @param {DashboardClient} prisma
 * @param {{ orgId?: string|null, now?: Date|string|number }} [args]
 * @returns {Promise<{ ok: true, dashboard: any } | { ok: false, error: 'no_org' }>}
 */
export async function loadDashboard(prisma, args) {
  const input = args || {};
  if (!input.orgId) return { ok: false, error: 'no_org' };
  const orgId = input.orgId;
  const now = input.now !== undefined ? asDate(input.now) : new Date();
  const expiryLimit = new Date(now.getTime() + EXPIRY_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const [activeTrips, delivered, pendingPay, activity, unassigned, expiring, settlements] = await Promise.all([
    prisma.trip.count({ where: { orgId, status: { notIn: TERMINAL_STATUSES } } }),
    prisma.trip.findMany({
      where: { orgId, status: { in: DELIVERED_STATUSES }, deliveredAt: { not: null } },
      select: { deliveredAt: true, order: { select: { plannedAt: true } } },
    }),
    prisma.trip.aggregate({
      where: { orgId, status: INVOICED_STATUS },
      _sum: { rateEur: true },
      _count: true,
    }),
    prisma.statusEvent.findMany({
      where: { trip: { orgId }, happenedAt: { gte: startOfUtcDay(now) } },
      select: {
        id: true,
        tripId: true,
        fromStatus: true,
        toStatus: true,
        happenedAt: true,
        actor: { select: { id: true, name: true } },
      },
      orderBy: { happenedAt: 'desc' },
      take: ACTIVITY_LIMIT,
    }),
    prisma.trip.findMany({
      where: { orgId, status: { in: UNASSIGNED_STATUSES }, driverId: null },
      select: { id: true, status: true, createdAt: true, order: { select: { origin: true, destination: true } } },
      orderBy: { createdAt: 'asc' },
      take: ALERT_LIMIT,
    }),
    prisma.document.findMany({
      where: { trip: { orgId }, status: { not: 'REJECTED' }, expiresAt: { not: null, lte: expiryLimit } },
      select: { id: true, tripId: true, docType: true, status: true, expiresAt: true },
      orderBy: { expiresAt: 'asc' },
      take: ALERT_LIMIT,
    }),
    prisma.settlement.findMany({
      where: { status: 'PENDING', trip: { orgId } },
      select: { id: true, tripId: true, amountEur: true, status: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: ALERT_LIMIT,
    }),
  ]);

  return {
    ok: true,
    dashboard: shapeDashboard({ activeTrips, delivered, pendingPay, activity, unassigned, expiring, settlements }, { now }),
  };
}
