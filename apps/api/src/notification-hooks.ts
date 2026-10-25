/**
 * Prisma-backed wiring for the notification emitter (board #135).
 *
 * `notifications.js` owns the provider-independent contract (envelope, spool,
 * preferences, refusal). This file owns the one thing that needs the database:
 * turning the object a route just changed into the eight lifecycle events, and
 * resolving the recipient + capability link from `Customer` / `Trip`.
 *
 * Every function here is BEST-EFFORT and safe by default:
 *
 *   * `RWF_NOTIFY_SPOOL` unset ⇒ it returns before touching the database, so the
 *     existing trip/order behaviour is byte-for-byte unchanged (acceptance 3).
 *   * A notification failure NEVER fails the business request that caused it: the
 *     hook catches everything and returns a result object. A trip transition must
 *     not roll back because a spool directory is unwritable.
 *   * No send happens here and none can: the envelope is a file; the transport
 *     (`infra/scripts/pilot-notify-deliver.sh`) is what sends, and it exits 3
 *     until the owner configures a sender (#29) and a provider (#24).
 *
 * The route layer calls these hooks and ignores the return value except for
 * logging; the tests cover the pure module and the acceptance script drives these
 * hooks against a temp spool.
 */

import { env } from './env.js';
import * as notify from './notifications.js';

/** Prisma client (kept loose: the hooks read only the models they need). */
type Db = any;

/** Log sink: Fastify's `req.log.warn` in the routes, silent by default. */
type LogFn = (line: string) => void;

/** Result of one emit attempt (see `EmitResult` in `notifications.js`). */
type EmitResult = {
  ok: boolean;
  skipped?: string;
  file?: string;
  error?: string;
  missing?: string[];
};

/** Status changes that are lifecycle events, and the event each one is. */
export const STATUS_EVENTS: Readonly<Record<string, string>> = Object.freeze({
  AT_PICKUP: 'at_pickup',
  IN_TRANSIT: 'in_transit',
  DELIVERED: 'delivered',
});

/** Document types that mean "the proof of delivery is ready". */
export const POD_READY_DOC_TYPES: readonly string[] = Object.freeze(['pod', 'ecmr']);

/**
 * Is the spool installed? Unset (or blank) means the emitter is a no-op — the
 * only switch the ops install needs (§4), and the reason nothing changes on the
 * live pilot today.
 * @returns {boolean}
 */
export function spoolConfigured(): boolean {
  return typeof env.RWF_NOTIFY_SPOOL === 'string' && env.RWF_NOTIFY_SPOOL.trim() !== '';
}

/** The trip columns every event needs (order lane/customer/ETA, driver, truck, share window). */
const TRIP_SELECT = {
  id: true,
  orgId: true,
  orderId: true,
  rateEur: true,
  status: true,
  trackLinkVersion: true,
  trackLinkIssuedAt: true,
  trackLinkExpiresAt: true,
  order: { select: { id: true, customerId: true, origin: true, destination: true, plannedAt: true } },
  driver: { select: { name: true } },
  truck: { select: { plate: true } },
} as const;

/** The customer columns a notification needs (contact + preferences). */
const CUSTOMER_SELECT = {
  id: true,
  name: true,
  email: true,
  whatsappId: true,
  profile: { select: { notifyPrefs: true } },
  accounts: { select: { user: { select: { phone: true } } }, take: 1 },
} as const;

/**
 * The customer behind the change. The id always comes from a row the request just
 * read or wrote (a load, an order, a trip), never from the client, so the lookup
 * needs no org filter — and must not use one: a marketplace award creates the
 * trip in the CARRIER's org while the customer belongs to the shipper's org.
 * @param {Db} prisma
 * @param {{ customerId?: string|null, order?: any, load?: any, trip?: any }} ctx
 * @returns {Promise<string|null>}
 */
async function resolveCustomerId(prisma: Db, ctx: any): Promise<string | null> {
  if (ctx.customerId) return ctx.customerId;
  if (ctx.order?.customerId) return ctx.order.customerId;
  if (ctx.load?.customerId) return ctx.load.customerId;
  if (ctx.trip?.order?.customerId) return ctx.trip.order.customerId;
  if (ctx.load?.orderId) {
    const order = await prisma.order.findUnique({
      where: { id: ctx.load.orderId },
      select: { customerId: true },
    });
    return order?.customerId ?? null;
  }
  return null;
}

/**
 * The `{{link}}` capability URL for the events that carry one. It is always an
 * EXISTING token: the trip's tracking link, or the guest share of the POD /
 * invoice document. No link exists ⇒ the event is refused upstream (a template
 * with an unresolved `{{link}}` must never be queued).
 * @param {string} event
 * @param {any} trip
 * @param {any} ctx
 * @returns {string|null}
 */
function resolveLink(event: string, trip: any, ctx: any): string | null {
  const signing = {
    authSecret: env.AUTH_SECRET,
    secret: env.TRACK_LINK_SECRET,
    baseUrl: env.PUBLIC_BASE_URL,
  };
  if (event === 'delivered') return notify.tripLinkFor(trip, signing);
  if (event === 'pod_ready') return notify.documentLinkFor(trip, ctx.document, { ...signing, scope: 'document' });
  if (event === 'invoice_issued') return notify.documentLinkFor(trip, ctx.document, { ...signing, scope: 'invoice' });
  return null;
}

/**
 * Emit one event for a customer: resolve the recipient and preferences, build the
 * template variables and write at most one envelope.
 * @param {Db} prisma
 * @param {string} event
 * @param {any} ctx
 * @returns {Promise<EmitResult>}
 */
async function deliver(prisma: Db, event: string, ctx: any): Promise<EmitResult> {
  // Safe by default, and before any database work: an install that has not
  // created the spool must not pay a query for a notification (acceptance 3).
  if (!spoolConfigured()) return { ok: true, skipped: 'no_spool' };

  const log: LogFn | undefined = typeof ctx.log === 'function' ? ctx.log : undefined;
  try {
    const tripId = ctx.tripId ?? ctx.trip?.id ?? null;
    const trip = tripId ? await prisma.trip.findUnique({ where: { id: tripId }, select: TRIP_SELECT }) : null;
    if (!trip && (event === 'driver_assigned' || event === 'at_pickup' || event === 'in_transit' || event === 'delivered' || event === 'pod_ready' || event === 'invoice_issued')) {
      return { ok: false, error: 'trip_not_found' };
    }

    const customerId = await resolveCustomerId(prisma, { ...ctx, trip });
    if (!customerId) return { ok: false, error: 'no_customer' };
    const customer = await prisma.customer.findUnique({ where: { id: customerId }, select: CUSTOMER_SELECT });
    if (!customer) return { ok: false, error: 'no_customer' };

    // Preferences decide the CHANNEL here, at emit time: a channel the customer
    // switched off produces no envelope at all (§3.3). The transport's own
    // preferences file is a second, ops-level gate — not a substitute.
    const prefs = notify.normalizePrefs(customer.profile?.notifyPrefs);
    const phone = customer.accounts?.[0]?.user?.phone ?? '';
    const channel = notify.chooseChannel({
      prefs,
      email: customer.email,
      whatsapp: customer.whatsappId,
      sms: phone,
    });
    if (!channel) return { ok: true, skipped: 'suppressed' };

    const recipient =
      channel === 'email' ? customer.email : channel === 'whatsapp' ? customer.whatsappId : phone;

    const link = resolveLink(event, trip, ctx);
    const built = notify.lifecycleVars({ ...ctx, event, trip, customer, link });
    if (!built.ok) {
      log?.(notify.logLine({ event, result: `refused_${built.error}`, recipient }));
      return { ok: false, error: built.error, missing: built.missing };
    }

    return notify.emitEvent({
      spoolDir: env.RWF_NOTIFY_SPOOL,
      event,
      channel,
      recipient,
      vars: built.vars,
      prefs,
      now: ctx.now,
      log,
    });
  } catch {
    // A notification must never fail the request that caused it.
    return { ok: false, error: 'emit_failed' };
  }
}

/**
 * `offer_received` — a carrier answered the customer's posted load. Fires once per
 * created offer (marketplace `POST /loads/:id/offers`).
 * @param {Db} prisma
 * @param {{ orgId?: string|null, load: any, log?: LogFn }} args
 * @returns {Promise<EmitResult>}
 */
export async function notifyOfferReceived(prisma: Db, { load, log }: any): Promise<EmitResult> {
  return deliver(prisma, 'offer_received', {
    customerId: load?.customerId ?? null,
    load,
    log,
  });
}

/**
 * `awarded` — the customer's load was awarded to a carrier, which created the
 * trip. Fires once per award (marketplace `POST /loads/:id/award`).
 * @param {Db} prisma
 * @param {{ load: any, offer: any, trip: any, log?: LogFn }} args
 * @returns {Promise<EmitResult>}
 */
export async function notifyAwarded(prisma: Db, { load, offer, trip, log }: any): Promise<EmitResult> {
  return deliver(prisma, 'awarded', {
    customerId: load?.customerId ?? null,
    load,
    offer,
    tripId: trip?.id ?? null,
    log,
  });
}

/**
 * `driver_assigned` — a driver was put on the trip, either at creation
 * (`POST /trips` with a driverId) or by assignment/reassignment
 * (`POST /trips/:id/assign`). Exactly one envelope per assignment change.
 * @param {Db} prisma
 * @param {{ tripId: string, log?: LogFn }} args
 * @returns {Promise<EmitResult>}
 */
export async function notifyDriverAssigned(prisma: Db, { tripId, log }: any): Promise<EmitResult> {
  return deliver(prisma, 'driver_assigned', { tripId, log });
}

/**
 * The milestone events that are trip status changes: `AT_PICKUP`, `IN_TRANSIT`
 * and `DELIVERED`. Any other status (including the disruption endings) is not a
 * customer notification and is skipped without a query beyond the spool check.
 * @param {Db} prisma
 * @param {{ tripId?: string, trip?: any, to: string, log?: LogFn }} args
 * @returns {Promise<EmitResult>}
 */
export async function notifyStatusChange(prisma: Db, { tripId, trip, to, log }: any): Promise<EmitResult> {
  const event = STATUS_EVENTS[String(to ?? '')];
  if (!event) return { ok: true, skipped: 'not_notifiable' };
  return deliver(prisma, event, { tripId: tripId ?? trip?.id, log });
}

/**
 * `pod_ready` / `invoice_issued` — a document upload completed. In this product an
 * invoice is a `Document` row with `docType = 'invoice'` (§2), so the single
 * upload route is the creation point for both events; every other document type
 * notifies nobody.
 * @param {Db} prisma
 * @param {{ tripId: string, document: any, log?: LogFn }} args
 * @returns {Promise<EmitResult>}
 */
export async function notifyDocumentUploaded(prisma: Db, { tripId, document, log }: any): Promise<EmitResult> {
  const docType = String(document?.docType ?? '');
  const status = String(document?.status ?? '');
  if (status !== 'UPLOADED' && status !== 'VERIFIED') return { ok: true, skipped: 'not_notifiable' };
  const event = docType === 'invoice' ? 'invoice_issued' : POD_READY_DOC_TYPES.includes(docType) ? 'pod_ready' : null;
  if (!event) return { ok: true, skipped: 'not_notifiable' };
  return deliver(prisma, event, { tripId, document, log });
}
