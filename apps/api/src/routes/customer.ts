import type { FastifyInstance, FastifyRequest } from 'fastify';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { requireAuth } from '../auth/guard.js';
import { hashPassword } from '../auth/password.js';
import { signToken } from '../auth/tokens.js';
import { hasPermission, loadRolePermissions } from '../auth/permissions.js';
import { publicTrackUrl, reconstructTrackLink, signTrackLink } from '../track-link.js';
import { sweepExpired } from '../marketplace-sweep.js';
import * as market from '../marketplace.js';
import { createCustomerAccount } from '../registration-accounts.js';
import * as customerCore from '../../../../customer/lib/customer-core.js';

/*
 * Customer portal API (board task #74, UXF-C1).
 *
 *   POST   /api/customer/signup                 public — creates a customer login
 *   GET    /api/customer/me                     profile + prefs + team + addresses
 *   PATCH  /api/customer/me                     company profile + notification prefs
 *   GET    /api/customer/addresses              the address book
 *   POST   /api/customer/addresses              add one
 *   DELETE /api/customer/addresses/:id          remove one (scoped)
 *   POST   /api/customer/team                   invite a teammate (same customer)
 *   POST   /api/customer/orders                 the book-a-load wizard
 *   GET    /api/customer/orders                 own shipments (scoped)
 *   GET    /api/customer/orders/:id             one shipment + booking detail
 *   POST   /api/customer/orders/:id/track-link  a shareable link for its trip
 *
 * Security model (designed in, not tested in):
 *   - a customer login holds the `customer` role (`order:create`, `order:read`,
 *     `customer:manage`) and **no** `org:*`/`trip:*`; the token's `org` is `null`.
 *   - every read is scoped by the `customerId` resolved from the authenticated
 *     user, never from a request parameter. "Not mine" is a flat 404 — the tenant
 *     boundary never leaks existence.
 *   - the payload rules live in `customer/lib/customer-core.js`, shared with the
 *     browser, so the client can never be more permissive than the server.
 *   - user rows are selected explicitly (never `passwordHash`/`totpSecret`).
 *
 * The database work is intentionally thin: the pure half is unit-tested with
 * `node --test apps/api/src/`, and the end-to-end flow with `test:router`.
 */

/** What a resolved customer principal is. */
interface CustomerPrincipal {
  userId: string;
  name: string;
  customerId: string;
  customer: { id: string; orgId: string; name: string; email: string | null };
}

type PrincipalResult =
  | { ok: true; principal: CustomerPrincipal }
  | { ok: false; status: number; error: string };

/**
 * Resolve the authenticated user into a customer principal, or a refusal.
 * `customer:manage` is the RBAC gate (granted only to the `customer` role,
 * created by migration 20260929230000_add_customer_role and re-asserted by the
 * signup transaction); the `CustomerAccount` row supplies the tenant id — the
 * query is explicit so no credential column can leak into the response.
 */
async function resolveCustomer(req: FastifyRequest): Promise<PrincipalResult> {
  const user = req.user;
  if (!user) return { ok: false, status: 401, error: 'unauthorized' };
  const permissions = await loadRolePermissions(prisma, user.roleId);
  if (!hasPermission(permissions, 'customer:manage')) {
    return { ok: false, status: 403, error: 'forbidden' };
  }
  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      id: true,
      name: true,
      customerAccount: {
        select: { customer: { select: { id: true, orgId: true, name: true, email: true } } },
      },
    },
  });
  const customer = row?.customerAccount?.customer;
  if (!row || !customer) return { ok: false, status: 403, error: 'forbidden' };
  return {
    ok: true,
    principal: {
      userId: row.id,
      name: row.name,
      customerId: customer.id,
      customer: {
        id: customer.id,
        orgId: customer.orgId,
        name: customer.name,
        email: customer.email,
      },
    },
  };
}

/** The fields of a customer account the portal reads back. Never a hash. */
const PROFILE_SELECT = {
  id: true,
  name: true,
  email: true,
  lang: true,
  orgId: true,
  profile: { select: { vatId: true, address: true, notifyPrefs: true } },
} as const;

/**
 * Flatten the profile relation into the one object the portal renders — the
 * account screen must not care that the portal data lives in its own table.
 */
function shapeProfile(row: Record<string, any> | null) {
  if (!row) return null;
  const profile = (row.profile ?? {}) as Record<string, unknown>;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    lang: row.lang,
    orgId: row.orgId,
    vatId: profile.vatId ?? null,
    address: profile.address ?? null,
    notifyPrefs: profile.notifyPrefs ?? null,
  };
}

const MEMBER_SELECT = { id: true, name: true, email: true, createdAt: true } as const;

const ADDRESS_SELECT = {
  id: true,
  label: true,
  line1: true,
  city: true,
  postalCode: true,
  country: true,
  isDefault: true,
} as const;

/** The trip columns the customer surface may read. Never a driver/truck/rate. */
const TRIP_SELECT = {
  id: true,
  status: true,
  deliveredAt: true,
  trackLinkVersion: true,
  trackLinkIssuedAt: true,
  trackLinkExpiresAt: true,
  createdAt: true,
} as const;

/** The order read every customer endpoint uses: own tenant, booking, first trip. */
const ORDER_INCLUDE = {
  booking: true,
  trips: { select: TRIP_SELECT, orderBy: { createdAt: 'asc' }, take: 1 },
} as const;

export async function customerRoutes(app: FastifyInstance) {
  const auth = requireAuth(env.AUTH_SECRET);

  const trackOptions = () => ({ authSecret: env.AUTH_SECRET, secret: env.TRACK_LINK_SECRET });

  /** The tracking link state for one trip, token included when a live one exists. */
  const linkFor = (trip: { trackLinkVersion?: number | null; trackLinkIssuedAt?: Date | null; trackLinkExpiresAt?: Date | null; id?: string } | null) => {
    if (!trip) return null;
    const link = reconstructTrackLink(trip, trackOptions());
    if (!link) return null;
    return { url: publicTrackUrl(env.PUBLIC_BASE_URL, link.token), expiresAt: link.expiresAt };
  };

  // --------------------------------------------------------------- auth ---

  // Public signup: one customer account, attached to the hosting carrier org.
  // The pilot has one fleet; CUSTOMER_HOST_ORG_ID pins it in a multi-fleet
  // deployment until the marketplace (#76) offers carrier choice in the portal.
  app.post('/customer/signup', async (req, reply) => {
    const normalized = customerCore.validateSignup(req.body ?? {});
    if (!normalized.ok) {
      return reply.code(400).send({ error: normalized.error, field: normalized.field, detail: normalized.detail });
    }
    const { name, company, email, phone, password, notifyPrefs } = normalized.value;

    const org = env.CUSTOMER_HOST_ORG_ID
      ? await prisma.org.findUnique({ where: { id: env.CUSTOMER_HOST_ORG_ID } })
      : await prisma.org.findFirst({ orderBy: { createdAt: 'asc' } });
    if (!org) return reply.code(503).send({ error: 'no_carrier_org' });

    const passwordHash = hashPassword(password);
    let created: { customerId: string; userId: string; customerName: string };
    try {
      // One creation path for every account type (board task #111): the shared
      // helper re-asserts the `customer` role row idempotently with fixed
      // values, so an anonymous caller can never influence the permission set.
      created = await prisma.$transaction((tx) =>
        createCustomerAccount(tx as any, {
          hostOrgId: org.id,
          name,
          company,
          email,
          phone,
          passwordHash,
          notifyPrefs,
        }),
      );
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        return reply.code(409).send({ error: 'email_taken' });
      }
      throw err;
    }

    const token = signToken(
      { sub: created.userId, org: null, role: customerCore.CUSTOMER_ROLE, name },
      env.AUTH_SECRET,
      { ttlSeconds: env.TOKEN_TTL_SECONDS },
    );
    return reply.code(201).send({
      token,
      user: {
        id: created.userId,
        name,
        roleId: customerCore.CUSTOMER_ROLE,
        email,
        orgId: null,
        customer: { id: created.customerId, name: created.customerName, orgId: org.id },
        // Email/phone verification needs a delivery provider (no mail at the
        // domain in the pilot); the portal shows the state honestly.
        emailVerifiedAt: null,
        phoneVerifiedAt: null,
      },
    });
  });

  // ------------------------------------------------------------ account ---

  app.get('/customer/me', { preHandler: auth }, async (req, reply) => {
    const resolved = await resolveCustomer(req);
    if (!resolved.ok) return reply.code(resolved.status).send({ error: resolved.error });
    const { customerId, customer } = resolved.principal;
    const [profile, accounts, addresses] = await Promise.all([
      prisma.customer.findUnique({ where: { id: customerId }, select: PROFILE_SELECT }),
      prisma.customerAccount.findMany({
        where: { customerId },
        select: { createdAt: true, user: { select: MEMBER_SELECT } },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.customerAddress.findMany({ where: { customerId }, select: ADDRESS_SELECT, orderBy: { createdAt: 'asc' } }),
    ]);
    return reply.send({
      customer: shapeProfile(profile),
      carrierOrgId: customer.orgId,
      team: accounts.map((account) => account.user),
      addresses,
      verification: { email: false, phone: false, note: 'verification_sender_not_configured' },
    });
  });

  app.patch('/customer/me', { preHandler: auth }, async (req, reply) => {
    const resolved = await resolveCustomer(req);
    if (!resolved.ok) return reply.code(resolved.status).send({ error: resolved.error });
    const normalized = customerCore.normalizeProfile(req.body ?? {});
    if (!normalized.ok) {
      return reply.code(400).send({ error: normalized.error, field: normalized.field, detail: normalized.detail });
    }
    const value = normalized.value;
    if (value.name !== undefined) {
      await prisma.user.update({ where: { id: resolved.principal.userId }, data: { name: value.name } });
    }
    const profileData: Record<string, unknown> = {};
    if (value.vatId !== undefined) profileData.vatId = value.vatId || null;
    if (value.address !== undefined) profileData.address = value.address || null;
    if (value.notifyPrefs !== undefined) profileData.notifyPrefs = value.notifyPrefs;
    if (value.company !== undefined || Object.keys(profileData).length > 0) {
      // Upsert in one write: the profile row is created on first save, never
      // required before it.
      await prisma.customerProfile.upsert({
        where: { customerId: resolved.principal.customerId },
        update: profileData,
        create: { customerId: resolved.principal.customerId, ...profileData },
      });
    }
    if (value.company !== undefined) {
      await prisma.customer.update({
        where: { id: resolved.principal.customerId },
        data: { name: value.company || resolved.principal.name },
      });
    }
    const updated = await prisma.customer.findUnique({
      where: { id: resolved.principal.customerId },
      select: PROFILE_SELECT,
    });
    return reply.send({ customer: shapeProfile(updated) });
  });

  app.get('/customer/addresses', { preHandler: auth }, async (req, reply) => {
    const resolved = await resolveCustomer(req);
    if (!resolved.ok) return reply.code(resolved.status).send({ error: resolved.error });
    const addresses = await prisma.customerAddress.findMany({
      where: { customerId: resolved.principal.customerId },
      select: ADDRESS_SELECT,
      orderBy: { createdAt: 'asc' },
    });
    return reply.send({ addresses });
  });

  app.post('/customer/addresses', { preHandler: auth }, async (req, reply) => {
    const resolved = await resolveCustomer(req);
    if (!resolved.ok) return reply.code(resolved.status).send({ error: resolved.error });
    const normalized = customerCore.normalizeAddress(req.body ?? {});
    if (!normalized.ok) {
      return reply.code(400).send({ error: normalized.error, field: normalized.field, detail: normalized.detail });
    }
    const address = await prisma.customerAddress.create({
      data: { customerId: resolved.principal.customerId, ...normalized.value },
      select: ADDRESS_SELECT,
    });
    return reply.code(201).send({ address });
  });

  // Scoped delete: a foreign id is a 404, exactly like a missing one.
  app.delete('/customer/addresses/:id', { preHandler: auth }, async (req, reply) => {
    const resolved = await resolveCustomer(req);
    if (!resolved.ok) return reply.code(resolved.status).send({ error: resolved.error });
    const { id } = req.params as { id: string };
    const existing = await prisma.customerAddress.findFirst({
      where: { id, customerId: resolved.principal.customerId },
      select: { id: true },
    });
    if (!existing) return reply.code(404).send({ error: 'not_found' });
    await prisma.customerAddress.delete({ where: { id: existing.id } });
    return reply.send({ deleted: true });
  });

  // Invite a teammate into this customer account. The inviter sets a temporary
  // password (min 8 chars) — no server-generated secret travels in a response.
  app.post('/customer/team', { preHandler: auth }, async (req, reply) => {
    const resolved = await resolveCustomer(req);
    if (!resolved.ok) return reply.code(resolved.status).send({ error: resolved.error });
    const normalized = customerCore.validateSignup(req.body ?? {});
    if (!normalized.ok) {
      return reply.code(400).send({ error: normalized.error, field: normalized.field, detail: normalized.detail });
    }
    const { name, email, password } = normalized.value;
    try {
      const member = await prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            roleId: customerCore.CUSTOMER_ROLE,
            name,
            email,
            orgId: null,
            passwordHash: hashPassword(password),
            lang: 'en',
          },
          select: MEMBER_SELECT,
        });
        await tx.customerAccount.create({ data: { userId: user.id, customerId: resolved.principal.customerId } });
        return user;
      });
      return reply.code(201).send({ member });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        return reply.code(409).send({ error: 'email_taken' });
      }
      throw err;
    }
  });

  // ------------------------------------------------------------- orders ---

  /**
   * The book-a-load wizard. A bookable supply choice creates the Order **and**
   * the DRAFT Trip in the carrier org (diagram 01 confirms the trip on award, so
   * the fleet manager can dispatch immediately); a marketplace choice answers
   * with the honest phase notice and creates nothing.
   */
  app.post('/customer/orders', { preHandler: auth }, async (req, reply) => {
    const resolved = await resolveCustomer(req);
    if (!resolved.ok) return reply.code(resolved.status).send({ error: resolved.error });
    const normalized = customerCore.normalizeBooking(req.body ?? {});
    if (!normalized.ok) {
      return reply.code(400).send({ error: normalized.error, field: normalized.field, detail: normalized.detail });
    }
    const value = normalized.value;
    const rows = customerCore.buildOrderData(value, { customerId: resolved.principal.customerId });

    if (value.marketplace) {
      // Board task #78 (UXF-C2): a marketplace path now POSTS the load for real
      // — the order + booking are created exactly as a direct booking, plus a
      // LoadPosting the carriers bid on. The award creates the trip (in the
      // carrier org), so nothing is lost and nobody re-enters the load.
      const result = await prisma.$transaction(async (tx) => {
        const order = await tx.order.create({ data: rows.order });
        await tx.orderBooking.create({ data: { ...rows.booking, orderId: order.id } });
        const load = await tx.loadPosting.create({
          data: {
            ...market.buildLoadPostingData(value, {
              orderId: order.id,
              customerId: resolved.principal.customerId,
              postedById: resolved.principal.userId,
            }),
            expiresAt: market.defaultLoadExpiry(new Date()),
          },
        });
        return { orderId: order.id, load };
      });
      const created = await prisma.order.findFirst({
        where: { id: result.orderId, customerId: resolved.principal.customerId },
        include: ORDER_INCLUDE,
      });
      return reply.code(201).send({
        order: customerCore.orderDetail(created),
        load: market.loadCard(result.load),
        marketplace: { code: 'marketplace_posted', supplyChoice: value.supplyChoice, task: null },
      });
    }

    const orderId = await prisma.$transaction(async (tx) => {
      const order = await tx.order.create({ data: rows.order });
      await tx.orderBooking.create({ data: { ...rows.booking, orderId: order.id } });
      await tx.trip.create({
        data: customerCore.buildTripData({ orgId: resolved.principal.customer.orgId, orderId: order.id }),
      });
      return order.id;
    });
    const created = await prisma.order.findFirst({
      where: { id: orderId, customerId: resolved.principal.customerId },
      include: ORDER_INCLUDE,
    });
    return reply.code(201).send({ order: customerCore.orderDetail(created) });
  });

  /** Own shipments only — the scope comes from the token, not the query. */
  app.get('/customer/orders', { preHandler: auth }, async (req, reply) => {
    const resolved = await resolveCustomer(req);
    if (!resolved.ok) return reply.code(resolved.status).send({ error: resolved.error });
    const orders = await prisma.order.findMany({
      where: customerCore.customerOrderWhere(resolved.principal.customerId),
      include: ORDER_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return reply.send({ orders: orders.map((order) => customerCore.orderSummary(order)) });
  });

  app.get('/customer/orders/:id', { preHandler: auth }, async (req, reply) => {
    const resolved = await resolveCustomer(req);
    if (!resolved.ok) return reply.code(resolved.status).send({ error: resolved.error });
    const { id } = req.params as { id: string };
    const order = await prisma.order.findFirst({
      where: { id, customerId: resolved.principal.customerId },
      include: ORDER_INCLUDE,
    });
    if (!order) return reply.code(404).send({ error: 'not_found' });
    const detail = customerCore.orderDetail(order);
    return reply.send({ order: detail, trackLink: linkFor(order.trips?.[0] ?? null) });
  });

  /**
   * Mint (or re-read) the shareable tracking link for one own order. Reuses the
   * board-#5/#39 link machinery unchanged; the customer is allowed to share
   * their own shipment, which is the whole point of a tracking link.
   */
  app.post('/customer/orders/:id/track-link', { preHandler: auth }, async (req, reply) => {
    const resolved = await resolveCustomer(req);
    if (!resolved.ok) return reply.code(resolved.status).send({ error: resolved.error });
    const { id } = req.params as { id: string };
    const order = await prisma.order.findFirst({
      where: { id, customerId: resolved.principal.customerId },
      include: ORDER_INCLUDE,
    });
    if (!order) return reply.code(404).send({ error: 'not_found' });

    const trip = order.trips?.[0] ?? null;
    if (!trip) return reply.code(404).send({ error: 'no_trip' });

    const existing = linkFor(trip);
    if (existing) return reply.send({ link: existing });

    const issuedAtSec = Math.floor(Date.now() / 1000);
    const minted = signTrackLink({
      tripId: trip.id,
      version: trip.trackLinkVersion,
      authSecret: env.AUTH_SECRET,
      secret: env.TRACK_LINK_SECRET,
      ttlSeconds: env.TRACK_LINK_TTL_SECONDS,
      now: issuedAtSec,
    });
    await prisma.trip.update({
      where: { id: trip.id },
      data: {
        trackLinkIssuedAt: new Date(issuedAtSec * 1000),
        trackLinkExpiresAt: new Date((issuedAtSec + minted.ttlSeconds) * 1000),
      },
    });
    return reply.code(201).send({
      link: { url: publicTrackUrl(env.PUBLIC_BASE_URL, minted.token), expiresAt: minted.expiresAt },
    });
  });

  // --------------------------------------------------------- marketplace ---
  // Board task #78 (UXF-C2): the customer compares the structured offers on
  // their own posted load, counters, declines and awards. The domain rules
  // (state machines, award plan, compare rows, auto-match) live in
  // `marketplace.js` — the SAME module the fleet/solo side uses — so the two
  // surfaces cannot drift. These routes only add the customer tenancy: the load
  // must be the caller's own, and "not mine" is a flat 404, never a 403.

  /** One load posting, as the compare screen reads it. */
  const CUSTOMER_LOAD_SELECT = {
    id: true,
    customerId: true,
    orgId: true,
    orderId: true,
    origin: true,
    destination: true,
    cargo: true,
    equipment: true,
    loadReadyAt: true,
    deliverByAt: true,
    pricingMode: true,
    priceEur: true,
    status: true,
    expiresAt: true,
    awardedOfferId: true,
    awardedAt: true,
    tripId: true,
    createdAt: true,
  } as const;

  /** One offer card, compare facets included. Never a relation dump. */
  const CUSTOMER_OFFER_SELECT = {
    id: true,
    loadId: true,
    carrierOrgId: true,
    carrierUserId: true,
    carrierName: true,
    priceEur: true,
    pickupEtaAt: true,
    deliveryEtaAt: true,
    note: true,
    carrierTruck: true,
    carrierVerified: true,
    cancellationTerms: true,
    side: true,
    status: true,
    parentOfferId: true,
    expiresAt: true,
    createdAt: true,
  } as const;

  /** `awardPlan`'s failures mapped to the HTTP the customer surface answers. */
  const AWARD_STATUS: Record<string, number> = {
    load_not_found: 404,
    offer_not_found: 404,
    load_awarded: 409,
    load_closed: 409,
    load_expired: 409,
    offer_expired: 409,
    offer_closed: 409,
    order_required: 409,
  };

  /** The caller's own load, or null. There is no org-wide path here. */
  async function ownLoad(customerId: string, loadId: string) {
    return prisma.loadPosting.findFirst({
      where: { id: loadId, customerId },
      select: CUSTOMER_LOAD_SELECT,
    });
  }

  /** The auto-match rules + their entitlement, read back from the profile. */
  async function autoMatchState(customerId: string) {
    const row = await prisma.customerProfile.findUnique({
      where: { customerId },
      select: { autoMatch: true },
    });
    const stored = (row?.autoMatch ?? null) as Record<string, unknown> | null;
    const rules = market.normalizeAutoMatch(stored ?? {});
    const value = rules.ok ? rules.value : market.autoMatchDefaults();
    return { rules: value, entitlement: market.autoMatchEntitlement(value), ownerGate: market.AUTO_MATCH_OWNER_GATE };
  }

  /** Own load postings with their offer counts — the compare screen's index. */
  app.get('/customer/loads', { preHandler: auth }, async (req, reply) => {
    const resolved = await resolveCustomer(req);
    if (!resolved.ok) return reply.code(resolved.status).send({ error: resolved.error });
    const where = { customerId: resolved.principal.customerId };
    const ids = await prisma.loadPosting.findMany({ where, select: { id: true } });
    await sweepExpired(prisma, ids.map((row) => row.id));
    const loads = await prisma.loadPosting.findMany({
      where,
      select: { ...CUSTOMER_LOAD_SELECT, _count: { select: { offers: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return reply.send({
      loads: loads.map((load: any) => ({
        ...market.loadCard(load),
        offerCount: load._count?.offers ?? 0,
      })),
    });
  });

  /**
   * The compare screen for ONE own load: the demand, every structured offer —
   * cheapest first, with the honest flags (cheapest / fastest / verified) and
   * the delta against the named budget — plus the auto-match rules state. The
   * whole screen is derived from this one read, so a refresh restores it.
   */
  app.get('/customer/loads/:id', { preHandler: auth }, async (req, reply) => {
    const resolved = await resolveCustomer(req);
    if (!resolved.ok) return reply.code(resolved.status).send({ error: resolved.error });
    const { id } = req.params as { id: string };
    const load = await ownLoad(resolved.principal.customerId, id);
    if (!load) return reply.code(404).send({ error: 'not_found' });
    await sweepExpired(prisma, [id]);
    const fresh = await ownLoad(resolved.principal.customerId, id);
    if (!fresh) return reply.code(404).send({ error: 'not_found' });

    const offers = await prisma.marketplaceOffer.findMany({
      where: { loadId: id },
      select: CUSTOMER_OFFER_SELECT,
      orderBy: { createdAt: 'asc' },
    });
    const autoMatch = await autoMatchState(resolved.principal.customerId);
    return reply.send({
      load: market.loadCard(fresh),
      compare: market.compareRows(offers, fresh),
      offerCount: offers.length,
      autoMatch,
    });
  });

  /**
   * Award one open offer: creates the carrier's Trip against the load's order,
   * declines the open rivals and returns the notification for both sides — the
   * same pure `awardPlan` / `buildAwardTripData` the marketplace route uses.
   */
  app.post('/customer/loads/:id/award', { preHandler: auth }, async (req, reply) => {
    const resolved = await resolveCustomer(req);
    if (!resolved.ok) return reply.code(resolved.status).send({ error: resolved.error });
    const { id } = req.params as { id: string };
    const load = await ownLoad(resolved.principal.customerId, id);
    if (!load) return reply.code(404).send({ error: 'not_found' });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const award = market.normalizeAward(body);
    if (!award.ok) {
      return reply.code(400).send({ error: award.error, field: award.field, detail: award.detail });
    }

    const offers = await prisma.marketplaceOffer.findMany({ where: { loadId: id }, select: CUSTOMER_OFFER_SELECT });
    const plan = market.awardPlan({ load, offers, offerId: body.offerId, now: new Date() });
    if (!plan.ok) return reply.code(AWARD_STATUS[plan.error] ?? 409).send({ error: plan.error });

    const winner = offers.find((offer) => offer.id === plan.winnerId)!;
    const now = new Date();
    const trip = await prisma.$transaction(async (tx) => {
      const createdTrip = await tx.trip.create({ data: market.buildAwardTripData({ load, offer: winner }) });
      await tx.loadPosting.update({
        where: { id },
        data: { status: 'AWARDED', awardedOfferId: winner.id, awardedAt: now, tripId: createdTrip.id },
      });
      await tx.marketplaceOffer.update({ where: { id: winner.id }, data: { status: 'ACCEPTED', decidedAt: now } });
      if (plan.declinedIds.length > 0) {
        await tx.marketplaceOffer.updateMany({
          where: { id: { in: plan.declinedIds } },
          data: { status: 'DECLINED', decidedAt: now },
        });
      }
      return createdTrip;
    });

    const fresh = await ownLoad(resolved.principal.customerId, id);
    const declinedOffers = offers.filter((offer) => plan.declinedIds.includes(offer.id));
    const notifications = market.awardOutcomeNotifications({ load: fresh, offer: winner, trip, declinedOffers });
    return reply.code(201).send({
      load: market.loadCard(fresh),
      trip: {
        id: trip.id,
        orgId: trip.orgId,
        orderId: trip.orderId,
        driverId: trip.driverId,
        status: trip.status,
        rateEur: trip.rateEur,
      },
      offer: market.offerCard({ ...winner, status: 'ACCEPTED' }),
      declined: plan.declinedIds,
      notifications,
      paymentMethod: award.value.paymentMethod,
    });
  });

  /** Counter an offer with a structured card (the parent becomes COUNTERED). */
  app.post('/customer/offers/:id/counter', { preHandler: auth }, async (req, reply) => {
    const resolved = await resolveCustomer(req);
    if (!resolved.ok) return reply.code(resolved.status).send({ error: resolved.error });
    const { id } = req.params as { id: string };
    const parent = await prisma.marketplaceOffer.findUnique({ where: { id }, select: CUSTOMER_OFFER_SELECT });
    if (!parent) return reply.code(404).send({ error: 'not_found' });
    const load = await ownLoad(resolved.principal.customerId, parent.loadId);
    if (!load) return reply.code(404).send({ error: 'not_found' });
    if (!market.canCounter({ offer: parent, load, principal: { customerId: resolved.principal.customerId } })) {
      return reply.code(409).send({ error: market.isOfferOpen(parent.status) ? 'forbidden' : 'offer_closed' });
    }
    const normalized = market.normalizeOffer(req.body, { requirePrice: false });
    if (!normalized.ok) {
      return reply.code(400).send({ error: normalized.error, field: normalized.field, detail: normalized.detail });
    }
    const value = normalized.value;
    const now = new Date();
    const expiresAt = value.expiresAt ?? new Date(now.getTime() + market.DEFAULT_OFFER_TTL_SECONDS * 1000);
    const counter = await prisma.$transaction(async (tx) => {
      const created = await tx.marketplaceOffer.create({
        data: {
          loadId: parent.loadId,
          carrierOrgId: parent.carrierOrgId,
          carrierUserId: parent.carrierUserId,
          carrierName: parent.carrierName,
          priceEur: value.priceEur ?? parent.priceEur,
          pickupEtaAt: value.pickupEtaAt ?? parent.pickupEtaAt,
          deliveryEtaAt: value.deliveryEtaAt ?? parent.deliveryEtaAt,
          note: value.note,
          carrierTruck: parent.carrierTruck ?? null,
          carrierVerified: parent.carrierVerified ?? false,
          cancellationTerms: typeof (req.body as any)?.cancellationTerms === 'string' ? value.cancellationTerms : parent.cancellationTerms,
          side: parent.side === 'carrier' ? 'shipper' : 'carrier',
          status: 'SENT',
          parentOfferId: parent.id,
          createdById: resolved.principal.userId,
          expiresAt,
        },
        select: CUSTOMER_OFFER_SELECT,
      });
      await tx.marketplaceOffer.update({ where: { id: parent.id }, data: { status: 'COUNTERED', decidedAt: now } });
      return created;
    });
    return reply.code(201).send({ offer: market.offerCard(counter) });
  });

  /** Decline an offer. A declined offer never closes the load. */
  app.post('/customer/offers/:id/decline', { preHandler: auth }, async (req, reply) => {
    const resolved = await resolveCustomer(req);
    if (!resolved.ok) return reply.code(resolved.status).send({ error: resolved.error });
    const { id } = req.params as { id: string };
    const offer = await prisma.marketplaceOffer.findUnique({ where: { id }, select: CUSTOMER_OFFER_SELECT });
    if (!offer) return reply.code(404).send({ error: 'not_found' });
    const load = await ownLoad(resolved.principal.customerId, offer.loadId);
    if (!load) return reply.code(404).send({ error: 'not_found' });
    if (!market.isOfferOpen(offer.status)) {
      return reply.code(409).send({ error: market.isExpired(offer.expiresAt, new Date()) ? 'offer_expired' : 'offer_closed' });
    }
    const updated = await prisma.marketplaceOffer.update({
      where: { id },
      data: { status: 'DECLINED', decidedAt: new Date() },
      select: CUSTOMER_OFFER_SELECT,
    });
    return reply.send({ offer: market.offerCard(updated) });
  });

  /** The auto-match rules screen's read: the stored rules + their live entitlement. */
  app.get('/customer/auto-match', { preHandler: auth }, async (req, reply) => {
    const resolved = await resolveCustomer(req);
    if (!resolved.ok) return reply.code(resolved.status).send({ error: resolved.error });
    return reply.send(await autoMatchState(resolved.principal.customerId));
  });

  /**
   * Save the rules. The owner answered the matching limits on 2026-10-01 (#73
   * q6: "no limits"), so an `enabled: true` rule is accepted and live at once.
   * The entitlement guard stays as a defensive assertion — it can only fire if
   * `marketplace.js#AUTO_MATCH_OWNER_APPROVED` is flipped back to `false`.
   */
  app.put('/customer/auto-match', { preHandler: auth }, async (req, reply) => {
    const resolved = await resolveCustomer(req);
    if (!resolved.ok) return reply.code(resolved.status).send({ error: resolved.error });
    const normalized = market.normalizeAutoMatch(req.body ?? {});
    if (!normalized.ok) {
      return reply.code(400).send({ error: normalized.error, field: normalized.field, detail: normalized.detail });
    }
    const entitlement = market.autoMatchEntitlement(normalized.value);
    if (!entitlement.allowed) {
      return reply
        .code(403)
        .send({ error: entitlement.error, detail: entitlement.ownerGate, ownerGate: entitlement.ownerGate });
    }
    await prisma.customerProfile.upsert({
      where: { customerId: resolved.principal.customerId },
      update: { autoMatch: normalized.value },
      create: { customerId: resolved.principal.customerId, autoMatch: normalized.value },
    });
    return reply.send(await autoMatchState(resolved.principal.customerId));
  });
}
