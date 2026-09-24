/**
 * Trip detail (board task #2) — the read model behind `GET /api/trips/:id` and
 * the dashboard trip drawer.
 *
 * The trips list only shows five columns; this module turns one org-scoped trip
 * into the full detail payload: order/customer, driver, truck, the chronological
 * status-event timeline, documents, expenses and settlement, plus the P&L
 * (`rateEur - sum(expenses)`).
 *
 * Decoupled from Fastify and from Prisma's concrete client so it can be
 * unit-tested against a fake client with the Node.js native test runner
 * (`node --test`, zero install). The route layer (`routes/trips.ts`) only does
 * auth, HTTP mapping and calls in here.
 *
 * Tenancy is always the caller's `orgId` (from the signed token, never the
 * client): the lookup filters on `{ id, orgId }`, so a trip in another org is
 * indistinguishable from an unknown id — both are `not_found` (404).
 *
 * Read-only: nothing in this module writes.
 */

/** Permission a caller must hold to read a trip's detail. */
export const TRIP_DETAIL_PERMISSION = 'trip:read';

/**
 * @typedef {Object} TripDetailClient
 * @property {{ findFirst: (args: any) => Promise<any> }} trip
 */

/**
 * The relations the detail query needs. Kept in one place so the route and the
 * tests cannot drift. `statusEvents` are oldest-first (the timeline order) and
 * carry the actor who performed the transition (nullable: rows written before
 * the actor column existed, and seeded history).
 * @returns {any}
 */
export function tripDetailInclude() {
  return {
    order: { include: { customer: { select: { id: true, name: true, email: true } } } },
    driver: { select: { id: true, name: true, email: true, phone: true } },
    truck: { select: { id: true, plate: true, euroClass: true, dimensions: true } },
    statusEvents: {
      orderBy: { happenedAt: 'asc' },
      include: { actor: { select: { id: true, name: true } } },
    },
    documents: { orderBy: { createdAt: 'asc' } },
    expenses: { orderBy: { createdAt: 'asc' } },
    settlement: true,
  };
}

/**
 * Coerce a Prisma `Decimal | number | string | null` to a finite number (or
 * null). Prisma serialises Decimal as an object with `toNumber()`.
 * @param {unknown} value
 * @returns {number | null}
 */
function toNumber(value) {
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
function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Shape a raw Prisma trip (with the detail relations loaded) into the stable
 * API payload. Pure and dependency-free so the mapping — especially the P&L —
 * is unit-testable without a database.
 * @param {any} trip
 * @returns {any}
 */
export function shapeTripDetail(trip) {
  const rateEur = toNumber(trip?.rateEur);

  const order = trip?.order
    ? {
        id: trip.order.id,
        origin: trip.order.origin,
        destination: trip.order.destination,
        cargo: trip.order.cargo ?? null,
        status: trip.order.status,
        // Planned delivery time (board task #40): the promise the on-time KPI
        // needs (board task #33). Null when it was never recorded.
        plannedAt: trip.order.plannedAt ?? null,
        customer: trip.order.customer
          ? {
              id: trip.order.customer.id,
              name: trip.order.customer.name,
              email: trip.order.customer.email ?? null,
            }
          : null,
      }
    : null;

  const driver = trip?.driver
    ? {
        id: trip.driver.id,
        name: trip.driver.name,
        email: trip.driver.email ?? null,
        phone: trip.driver.phone ?? null,
      }
    : null;

  const truck = trip?.truck
    ? {
        id: trip.truck.id,
        plate: trip.truck.plate,
        euroClass: trip.truck.euroClass ?? null,
        dimensions: trip.truck.dimensions ?? null,
      }
    : null;

  const statusEvents = (trip?.statusEvents ?? []).map((ev) => ({
    id: ev.id,
    from: ev.fromStatus,
    to: ev.toStatus,
    at: ev.happenedAt,
    actor: ev.actor ? { id: ev.actor.id, name: ev.actor.name } : null,
  }));

  // Document has no dedicated `uploadedAt` column; the row is created at upload
  // time, so `uploadedAt` mirrors `createdAt` (schema unchanged).
  const documents = (trip?.documents ?? []).map((d) => ({
    id: d.id,
    docType: d.docType,
    status: d.status,
    uploadedAt: d.createdAt,
    expiresAt: d.expiresAt ?? null,
  }));

  const expenses = (trip?.expenses ?? []).map((e) => ({
    id: e.id,
    category: e.category,
    amountEur: toNumber(e.amountEur),
    createdAt: e.createdAt,
  }));

  const settlement = trip?.settlement
    ? {
        id: trip.settlement.id,
        amountEur: toNumber(trip.settlement.amountEur),
        status: trip.settlement.status,
        createdAt: trip.settlement.createdAt,
      }
    : null;

  const expensesEur = round2(expenses.reduce((sum, e) => sum + (e.amountEur ?? 0), 0));
  const pnlEur = rateEur === null ? null : round2(rateEur - expensesEur);

  return {
    id: trip?.id,
    status: trip?.status,
    rateEur,
    createdAt: trip?.createdAt,
    // Actual delivery time (board task #40). Null when the trip has not been
    // delivered (or was delivered before the column existed).
    deliveredAt: trip?.deliveredAt ?? null,
    order,
    driver,
    truck,
    statusEvents,
    documents,
    expenses,
    settlement,
    totals: { expensesEur, pnlEur },
  };
}

/**
 * Load one trip in the caller's org and shape it for the API. A trip in another
 * org (or an unknown id) returns `{ ok: false, error: 'not_found' }` — never a
 * leak of existence.
 * @param {TripDetailClient} prisma
 * @param {{ orgId?: string | null, tripId?: string | null }} args
 * @returns {Promise<{ ok: true, trip: any } | { ok: false, error: 'no_org' | 'not_found' }>}
 */
export async function getTripDetail(prisma, { orgId, tripId }) {
  if (!orgId) return { ok: false, error: 'no_org' };
  const id = typeof tripId === 'string' ? tripId.trim() : '';
  if (!id) return { ok: false, error: 'not_found' };

  const trip = await prisma.trip.findFirst({
    where: { id, orgId },
    include: tripDetailInclude(),
  });
  if (!trip) return { ok: false, error: 'not_found' };
  return { ok: true, trip: shapeTripDetail(trip) };
}
