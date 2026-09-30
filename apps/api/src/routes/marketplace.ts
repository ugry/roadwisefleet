import type { FastifyInstance, FastifyRequest } from 'fastify';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { requireAuth } from '../auth/guard.js';
import { hasPermission, loadRolePermissions } from '../auth/permissions.js';
import { statusForError } from '../http-errors.js';
import { stripCredentialFields } from '../user-payload.js';
import { sweepExpired } from '../marketplace-sweep.js';
import * as market from '../marketplace.js';
import { canBid, SOLO_ROLE } from '../../../../solo/lib/solo-core.js';

/*
 * Connect marketplace API (board task #76, UXF-M1).
 *
 *   POST   /api/marketplace/loads                 post a load (shipper side)
 *   GET    /api/marketplace/loads                 the carrier feed (lane/date/equipment match)
 *   GET    /api/marketplace/loads/mine            own postings + offer counts
 *   GET    /api/marketplace/loads/:id             one load (poster: all offers, carrier: own)
 *   POST   /api/marketplace/loads/:id/offers      make a structured offer
 *   POST   /api/marketplace/loads/:id/award       award → creates the Trip (invoice-first)
 *   POST   /api/marketplace/loads/:id/cancel      cancel an open posting
 *   GET    /api/marketplace/matches?loadId=       ranked capacity beacons for a load
 *   POST   /api/marketplace/offers/:id/counter    counter-offer (new structured card)
 *   POST   /api/marketplace/offers/:id/decline    shipper declines an offer
 *   POST   /api/marketplace/offers/:id/withdraw   carrier withdraws its own offer
 *   GET    /api/marketplace/offers/mine           the carrier's own offers
 *   POST   /api/marketplace/beacons               publish/replace the capacity beacon
 *   GET    /api/marketplace/beacons               active capacity (filters)
 *   DELETE /api/marketplace/beacons/:id           deactivate an own beacon
 *
 * Security model (designed in, not tested in):
 *   - shipper side = the load's owner: a customer login (`order:create` via the
 *     CustomerAccount link) or a fleet org (`trip:create`, posting a load it
 *     cannot cover). The tenant id is resolved from the token, never a query.
 *   - carrier side = an org-scoped login holding `trip:create`; its org is the
 *     offer's carrier and the home of the Trip an award creates.
 *   - "not mine" is a flat 404 for a load/offer outside the caller's tenancy;
 *     a third tenant acting on an object it may see but not own is a 403.
 *   - every response is passed through `stripCredentialFields`.
 *
 * The domain rules live in `src/marketplace.js` (pure, `node --test`-covered);
 * this file only does auth, tenancy, persistence and HTTP mapping.
 */

interface Principal {
  userId: string;
  orgId: string | null;
  roleId: string | null;
  name: string;
  permissions: string[];
  customerId: string | null;
}

/**
 * Resolve the authenticated user into a principal with capabilities and, for a
 * customer login, the customer tenant behind it. Nothing here trusts a request
 * parameter.
 */
async function resolvePrincipal(req: FastifyRequest): Promise<Principal> {
  const user = req.user!;
  const permissions = await loadRolePermissions(prisma, user.roleId);
  let customerId: string | null = null;
  if (hasPermission(permissions, 'customer:manage')) {
    const row = await prisma.user.findUnique({
      where: { id: user.id },
      select: { customerAccount: { select: { customerId: true } } },
    });
    customerId = row?.customerAccount?.customerId ?? null;
  }
  return {
    userId: user.id,
    orgId: user.orgId ?? null,
    roleId: user.roleId ?? null,
    name: user.name ?? '',
    permissions,
    customerId,
  };
}

/** The load columns the marketplace exposes. Never a relation dump. */
const LOAD_SELECT = {
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

/** The offer columns the marketplace exposes (`side` is the offer's author side). */
const OFFER_SELECT = {
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

const OPEN_LOADS = ['POSTED', 'OFFERS'];
const OPEN_OFFERS = ['SENT', 'VIEWED'];

/** The tenant filter for "loads this principal posted". */
function ownLoadWhere(principal: Principal): Record<string, unknown> {
  if (principal.customerId) return { customerId: principal.customerId };
  if (principal.orgId) return { orgId: principal.orgId };
  return { id: '__none__' };
}

/** The tenant filter for "offers this principal's carrier made". */
function ownOfferWhere(principal: Principal): Record<string, unknown> {
  if (principal.orgId) return { carrierOrgId: principal.orgId };
  return { carrierUserId: principal.userId };
}

/** Map a raw query object into the validated match filter. */
function matchFilter(query: unknown) {
  return market.parseMatchFilter(query);
}

export async function marketplaceRoutes(app: FastifyInstance) {
  const auth = requireAuth(env.AUTH_SECRET);

  const refuse = (reply: any, error: string, status?: number) =>
    reply.code(status ?? statusForError(error)).send({ error });

  /* ------------------------------------------------------------ shipper --- */

  app.post('/marketplace/loads', { preHandler: auth }, async (req, reply) => {
    const principal = await resolvePrincipal(req);
    if (!market.canPostLoad(principal.permissions)) return refuse(reply, 'forbidden');
    if (!principal.customerId && !principal.orgId) return refuse(reply, 'no_org');

    const body = (req.body ?? {}) as Record<string, unknown>;
    const orderId = typeof body.orderId === 'string' ? body.orderId.trim() : '';

    // A load posted from an order inherits its lane, so the shipper never
    // re-types the load (diagram 05). The order is scoped to the caller.
    const defaults: Record<string, unknown> = {};
    if (orderId) {
      const order =
        principal.customerId !== null
          ? await prisma.order.findFirst({
              where: { id: orderId, customerId: principal.customerId },
              include: { booking: true },
            })
          : await prisma.order.findFirst({
              where: { id: orderId, customer: { orgId: principal.orgId! } },
              include: { booking: true },
            });
      if (!order) return refuse(reply, 'order_not_found');
      defaults.origin = order.origin;
      defaults.destination = order.destination;
      defaults.cargo = order.cargo ?? undefined;
      defaults.equipment = (order.booking as { equipment?: string | null } | null)?.equipment ?? undefined;
    } else if (principal.orgId && !principal.customerId) {
      // A fleet posting an uncovered load must name the order it cannot cover:
      // the award creates the Trip against it, and nobody re-enters the load.
      return reply.code(400).send({ error: 'invalid_input', field: 'orderId', detail: 'orderId is required for a fleet posting' });
    }

    const merged: Record<string, unknown> = { ...body };
    for (const [key, value] of Object.entries(defaults)) {
      if (merged[key] === undefined || merged[key] === null || merged[key] === '') merged[key] = value;
    }

    const normalized = market.normalizeLoadPosting(merged);
    if (!normalized.ok) {
      return reply
        .code(400)
        .send({ error: normalized.error, field: normalized.field, detail: normalized.detail });
    }
    const value = normalized.value;
    const now = new Date();
    const expiresAt =
      value.expiresAt ?? new Date(now.getTime() + market.DEFAULT_LOAD_TTL_SECONDS * 1000);

    const load = await prisma.loadPosting.create({
      data: {
        customerId: principal.customerId,
        orgId: principal.customerId ? null : principal.orgId,
        orderId: value.orderId ?? (orderId || null),
        origin: value.origin,
        destination: value.destination,
        cargo: value.cargo,
        equipment: value.equipment,
        loadReadyAt: value.loadReadyAt,
        deliverByAt: value.deliverByAt,
        pricingMode: value.pricingMode,
        priceEur: value.priceEur,
        status: 'POSTED',
        postedById: principal.userId,
        expiresAt,
      },
      select: LOAD_SELECT,
    });
    return reply.code(201).send({ load: market.loadCard(load) });
  });

  app.get('/marketplace/loads/mine', { preHandler: auth }, async (req, reply) => {
    const principal = await resolvePrincipal(req);
    if (!market.canPostLoad(principal.permissions)) return refuse(reply, 'forbidden');
    const where = ownLoadWhere(principal);
    const ids = await prisma.loadPosting.findMany({ where, select: { id: true } });
    await sweepExpired(prisma, ids.map((row) => row.id));
    const loads = await prisma.loadPosting.findMany({
      where,
      select: { ...LOAD_SELECT, _count: { select: { offers: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return reply.send(
      stripCredentialFields({
        loads: loads.map((load: any) => ({
          ...market.loadCard(load),
          offerCount: load._count?.offers ?? 0,
        })),
      }),
    );
  });

  app.get('/marketplace/loads', { preHandler: auth }, async (req, reply) => {
    const principal = await resolvePrincipal(req);
    if (!market.canSupply(principal.permissions)) return refuse(reply, 'forbidden');
    const filter = matchFilter(req.query);
    const now = new Date();

    // The matching query: open, not own, not expired, then lane / date /
    // equipment — applied in the database so the feed page never filters a
    // wrong set client-side. The expiry and the "not own" rules are separate
    // ANDed clauses: a customer-posted load has `orgId = null`, and a bare
    // `{ orgId: { not } }` would exclude it (SQL NULL comparison).
    const and: unknown[] = [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }];
    if (principal.orgId) {
      and.push({ OR: [{ orgId: null }, { orgId: { not: principal.orgId } }] });
    }
    const where: Record<string, unknown> = { status: { in: OPEN_LOADS }, AND: and };
    if (filter.origin) where.origin = { contains: filter.origin, mode: 'insensitive' };
    if (filter.destination) where.destination = { contains: filter.destination, mode: 'insensitive' };
    if (filter.equipment) where.equipment = filter.equipment;
    if (filter.readyFrom || filter.readyTo) {
      where.loadReadyAt = {
        ...(filter.readyFrom ? { gte: new Date(filter.readyFrom) } : {}),
        ...(filter.readyTo ? { lte: new Date(filter.readyTo) } : {}),
      };
    }

    // A beacon ranks the feed instead of filtering it (diagram 05: beacons
    // before browsing) — only the caller's own beacon may be used.
    const beaconId = typeof (req.query as any)?.beaconId === 'string' ? (req.query as any).beaconId : '';
    const loads = await prisma.loadPosting.findMany({
      where,
      select: LOAD_SELECT,
      orderBy: { loadReadyAt: 'asc' },
      take: 100,
    });

    if (beaconId) {
      const beacon = await prisma.capacityBeacon.findFirst({
        where: { id: beaconId, ...(principal.orgId ? { orgId: principal.orgId } : { driverId: principal.userId }) },
      });
      if (!beacon) return refuse(reply, 'not_found');
      const ranked = market.rankLoadsForBeacon(beacon, loads);
      return reply.send(
        stripCredentialFields({
          loads: ranked.map((row: any) => market.loadCard(row.load)),
          matches: ranked.map((row: any) => ({ loadId: row.load.id, score: row.score, reasons: row.reasons })),
          filters: filter,
        }),
      );
    }

    return reply.send(stripCredentialFields({ loads: loads.map((load) => market.loadCard(load)), filters: filter }));
  });

  app.get('/marketplace/loads/:id', { preHandler: auth }, async (req, reply) => {
    const principal = await resolvePrincipal(req);
    const { id } = req.params as { id: string };
    const load = await prisma.loadPosting.findUnique({ where: { id }, select: LOAD_SELECT });
    if (!load) return refuse(reply, 'load_not_found');
    await sweepExpired(prisma, [load.id]);
    const fresh = await prisma.loadPosting.findUnique({ where: { id }, select: LOAD_SELECT });
    if (!market.canReadLoad({ load: fresh, principal, permissions: principal.permissions })) {
      return refuse(reply, 'forbidden');
    }
    const isPoster = market.isLoadPoster(fresh, principal);
    const offers = await prisma.marketplaceOffer.findMany({
      where: isPoster ? { loadId: id } : { loadId: id, ...ownOfferWhere(principal) },
      select: OFFER_SELECT,
      orderBy: { createdAt: 'asc' },
    });
    return reply.send(
      stripCredentialFields({
        load: market.loadCard(fresh),
        offers: market.offerCards(offers),
        viewer: isPoster ? 'shipper' : 'carrier',
      }),
    );
  });

  app.post('/marketplace/loads/:id/offers', { preHandler: auth }, async (req, reply) => {
    const principal = await resolvePrincipal(req);
    if (!market.canSupply(principal.permissions)) return refuse(reply, 'forbidden');
    // Solo driver gate (board task #77): an unverified solo driver may browse
    // the board (GET /marketplace/loads is untouched) but may not bid. Applied
    // only to solo principals, so fleet carriers are unaffected. Denies by
    // default: a `solo` token without a profile row cannot bid.
    let soloProfile: { verificationStatus: string; truckPlate: string | null } | null = null;
    if (principal.roleId === SOLO_ROLE) {
      soloProfile = await prisma.soloDriverProfile.findUnique({
        where: { userId: principal.userId },
        select: { verificationStatus: true, truckPlate: true },
      });
      const gate = canBid(soloProfile);
      if (!gate.allowed) {
        return reply.code(403).send({ error: gate.error, messageKey: gate.messageKey });
      }
    }
    if (!principal.orgId) {
      return reply.code(400).send({ error: 'org_required', detail: 'a carrier org is required to make an offer' });
    }
    const { id } = req.params as { id: string };
    const load = await prisma.loadPosting.findUnique({ where: { id }, select: LOAD_SELECT });
    if (!load) return refuse(reply, 'load_not_found');
    if (market.isLoadPoster(load, principal)) return refuse(reply, 'own_load');

    const now = new Date();
    if (!market.isLoadOpen(load.status)) {
      return refuse(reply, market.isExpired(load.expiresAt, now) ? 'load_expired' : 'load_closed');
    }
    if (market.isExpired(load.expiresAt, now)) return refuse(reply, 'load_expired');

    const normalized = market.normalizeOffer(req.body, { requirePrice: true });
    if (!normalized.ok) {
      return reply
        .code(400)
        .send({ error: normalized.error, field: normalized.field, detail: normalized.detail });
    }
    const value = normalized.value;
    const org = await prisma.org.findUnique({ where: { id: principal.orgId }, select: { name: true } });
    const expiresAt = value.expiresAt ?? new Date(now.getTime() + market.DEFAULT_OFFER_TTL_SECONDS * 1000);

    // The compare-screen facets (#78) are derived from the carrier's OWN rows
    // here — the fleet's first truck, the solo driver's truck and verification
    // state — so a client body can never spoof them.
    let carrierTruck: string | null = null;
    let carrierVerified = false;
    if (principal.roleId === SOLO_ROLE) {
      carrierTruck = soloProfile?.truckPlate ?? null;
      carrierVerified = soloProfile?.verificationStatus === 'VERIFIED';
    } else {
      const truck = await prisma.truck.findFirst({
        where: { orgId: principal.orgId },
        orderBy: { createdAt: 'asc' },
        select: { plate: true },
      });
      carrierTruck = truck?.plate ?? null;
    }

    const offer = await prisma.$transaction(async (tx) => {
      const created = await tx.marketplaceOffer.create({
        data: {
          loadId: id,
          carrierOrgId: principal.orgId!,
          carrierUserId: principal.roleId === 'driver' || principal.roleId === SOLO_ROLE ? principal.userId : null,
          carrierName: org?.name ?? principal.name,
          priceEur: value.priceEur,
          pickupEtaAt: value.pickupEtaAt,
          deliveryEtaAt: value.deliveryEtaAt,
          note: value.note,
          carrierTruck,
          carrierVerified,
          cancellationTerms: value.cancellationTerms,
          side: 'carrier',
          status: 'SENT',
          createdById: principal.userId,
          expiresAt,
        },
        select: OFFER_SELECT,
      });
      if (load.status === 'POSTED') {
        await tx.loadPosting.update({ where: { id }, data: { status: 'OFFERS' } });
      }
      return created;
    });
    return reply.code(201).send({ offer: market.offerCard(offer) });
  });

  app.post('/marketplace/loads/:id/award', { preHandler: auth }, async (req, reply) => {
    const principal = await resolvePrincipal(req);
    const { id } = req.params as { id: string };
    const load = await prisma.loadPosting.findUnique({ where: { id }, select: LOAD_SELECT });
    if (!load) return refuse(reply, 'load_not_found');
    if (!market.isLoadPoster(load, principal)) return refuse(reply, 'forbidden');

    const body = (req.body ?? {}) as Record<string, unknown>;
    const award = market.normalizeAward(body);
    if (!award.ok) {
      return reply.code(400).send({ error: award.error, field: award.field, detail: award.detail });
    }

    const offers = await prisma.marketplaceOffer.findMany({ where: { loadId: id }, select: OFFER_SELECT });
    const plan = market.awardPlan({ load, offers, offerId: body.offerId, now: new Date() });
    if (!plan.ok) return refuse(reply, plan.error);

    const winner = offers.find((offer) => offer.id === plan.winnerId)!;
    const now = new Date();
    const trip = await prisma.$transaction(async (tx) => {
      // The award becomes the SAME trip object the carrier executes (diagram
      // 05), created in the carrier's org against the load's order.
      const createdTrip = await tx.trip.create({
        data: market.buildAwardTripData({ load, offer: winner }),
      });
      await tx.loadPosting.update({
        where: { id },
        data: { status: 'AWARDED', awardedOfferId: winner.id, awardedAt: now, tripId: createdTrip.id },
      });
      await tx.marketplaceOffer.update({
        where: { id: winner.id },
        data: { status: 'ACCEPTED', decidedAt: now },
      });
      if (plan.declinedIds.length > 0) {
        await tx.marketplaceOffer.updateMany({
          where: { id: { in: plan.declinedIds } },
          data: { status: 'DECLINED', decidedAt: now },
        });
      }
      return createdTrip;
    });

    const fresh = await prisma.loadPosting.findUnique({ where: { id }, select: LOAD_SELECT });
    // Both sides are notified (#78): the shipper that the load is awarded, the
    // winning carrier that the trip exists, and each declined rival. The notice
    // is the durable award state above — this is its client-readable projection.
    const declinedOffers = offers.filter((offer) => plan.declinedIds.includes(offer.id));
    const notifications = market.awardOutcomeNotifications({ load: fresh, offer: winner, trip, declinedOffers });
    return reply.code(201).send(
      stripCredentialFields({
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
      }),
    );
  });

  app.post('/marketplace/loads/:id/cancel', { preHandler: auth }, async (req, reply) => {
    const principal = await resolvePrincipal(req);
    const { id } = req.params as { id: string };
    const load = await prisma.loadPosting.findUnique({ where: { id }, select: LOAD_SELECT });
    if (!load) return refuse(reply, 'load_not_found');
    if (!market.isLoadPoster(load, principal)) return refuse(reply, 'forbidden');
    if (!market.isLoadOpen(load.status)) return refuse(reply, 'load_closed');

    const now = new Date();
    await prisma.$transaction(async (tx) => {
      await tx.loadPosting.update({ where: { id }, data: { status: 'CANCELLED' } });
      await tx.marketplaceOffer.updateMany({
        where: { loadId: id, status: { in: OPEN_OFFERS } },
        data: { status: 'DECLINED', decidedAt: now },
      });
    });
    const fresh = await prisma.loadPosting.findUnique({ where: { id }, select: LOAD_SELECT });
    return reply.send({ load: market.loadCard(fresh) });
  });

  /* ------------------------------------------------------------- offers --- */

  app.get('/marketplace/offers/mine', { preHandler: auth }, async (req, reply) => {
    const principal = await resolvePrincipal(req);
    if (!market.canSupply(principal.permissions)) return refuse(reply, 'forbidden');
    const offers = await prisma.marketplaceOffer.findMany({
      where: ownOfferWhere(principal),
      select: OFFER_SELECT,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const loadIds = [...new Set(offers.map((offer) => offer.loadId))];
    await sweepExpired(prisma, loadIds);
    const loads = await prisma.loadPosting.findMany({ where: { id: { in: loadIds } }, select: LOAD_SELECT });
    const byId = new Map(loads.map((load) => [load.id, market.loadCard(load)]));
    return reply.send(
      stripCredentialFields({
        offers: market.offerCards(offers).map((card) => ({ ...card, load: byId.get(card.loadId) ?? null })),
        // The carrier is notified of an award on its own offers (#78): the win
        // (with the trip) or the decline. Read-only projection of durable state.
        notifications: market.carrierOutcomeNotifications(offers),
      }),
    );
  });

  app.post('/marketplace/offers/:id/counter', { preHandler: auth }, async (req, reply) => {
    const principal = await resolvePrincipal(req);
    const { id } = req.params as { id: string };
    const parent = await prisma.marketplaceOffer.findUnique({ where: { id }, select: OFFER_SELECT });
    if (!parent) return refuse(reply, 'offer_not_found');
    const load = await prisma.loadPosting.findUnique({ where: { id: parent.loadId }, select: LOAD_SELECT });
    if (!load) return refuse(reply, 'load_not_found');
    if (!market.canCounter({ offer: parent, load, principal })) return refuse(reply, 'forbidden');

    const normalized = market.normalizeOffer(req.body, { requirePrice: false });
    if (!normalized.ok) {
      return reply
        .code(400)
        .send({ error: normalized.error, field: normalized.field, detail: normalized.detail });
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
          // A counter inherits the offer's compare facets: the truck and the
          // verification badge belong to the CARRIER, and the terms carry over
          // from the card being answered (the shipper may still name new terms).
          carrierTruck: parent.carrierTruck ?? null,
          carrierVerified: parent.carrierVerified ?? false,
          cancellationTerms: typeof (req.body as any)?.cancellationTerms === 'string' ? value.cancellationTerms : parent.cancellationTerms,
          side: parent.side === 'carrier' ? 'shipper' : 'carrier',
          status: 'SENT',
          parentOfferId: parent.id,
          createdById: principal.userId,
          expiresAt,
        },
        select: OFFER_SELECT,
      });
      await tx.marketplaceOffer.update({
        where: { id: parent.id },
        data: { status: 'COUNTERED', decidedAt: now },
      });
      return created;
    });
    return reply.code(201).send({ offer: market.offerCard(counter) });
  });

  app.post('/marketplace/offers/:id/decline', { preHandler: auth }, async (req, reply) => {
    const principal = await resolvePrincipal(req);
    const { id } = req.params as { id: string };
    const offer = await prisma.marketplaceOffer.findUnique({ where: { id }, select: OFFER_SELECT });
    if (!offer) return refuse(reply, 'offer_not_found');
    const load = await prisma.loadPosting.findUnique({ where: { id: offer.loadId }, select: LOAD_SELECT });
    if (!load) return refuse(reply, 'load_not_found');
    if (!market.canDecideOffer({ offer, load, principal })) return refuse(reply, 'forbidden');
    if (!market.isOfferOpen(offer.status)) {
      return refuse(reply, market.isExpired(offer.expiresAt, new Date()) ? 'offer_expired' : 'offer_closed');
    }
    const updated = await prisma.marketplaceOffer.update({
      where: { id },
      data: { status: 'DECLINED', decidedAt: new Date() },
      select: OFFER_SELECT,
    });
    return reply.send({ offer: market.offerCard(updated) });
  });

  app.post('/marketplace/offers/:id/withdraw', { preHandler: auth }, async (req, reply) => {
    const principal = await resolvePrincipal(req);
    const { id } = req.params as { id: string };
    const offer = await prisma.marketplaceOffer.findUnique({ where: { id }, select: OFFER_SELECT });
    if (!offer) return refuse(reply, 'offer_not_found');
    if (!market.canWithdrawOffer({ offer, principal })) return refuse(reply, 'forbidden');
    const updated = await prisma.marketplaceOffer.update({
      where: { id },
      data: { status: 'WITHDRAWN', decidedAt: new Date() },
      select: OFFER_SELECT,
    });
    return reply.send({ offer: market.offerCard(updated) });
  });

  /* ------------------------------------------------------------ beacons --- */

  app.post('/marketplace/beacons', { preHandler: auth }, async (req, reply) => {
    const principal = await resolvePrincipal(req);
    if (!market.canSupply(principal.permissions)) return refuse(reply, 'forbidden');
    if (!principal.orgId && !principal.userId) return refuse(reply, 'no_org');

    const normalized = market.normalizeBeacon(req.body);
    if (!normalized.ok) {
      return reply
        .code(400)
        .send({ error: normalized.error, field: normalized.field, detail: normalized.detail });
    }
    const value = normalized.value;
    const now = new Date();
    const expiresAt = value.expiresAt ?? new Date(now.getTime() + market.DEFAULT_LOAD_TTL_SECONDS * 1000);
    const owner = principal.orgId ? { orgId: principal.orgId } : { driverId: principal.userId };

    const beacon = await prisma.$transaction(async (tx) => {
      // One active beacon per owner: a new one replaces the previous (the UI
      // toggle, diagram 05/04).
      await tx.capacityBeacon.updateMany({ where: { ...owner, active: true }, data: { active: false } });
      return tx.capacityBeacon.create({
        data: {
          orgId: principal.orgId,
          driverId: principal.orgId ? null : principal.userId,
          location: value.location,
          heading: value.heading,
          availableFrom: value.availableFrom,
          equipment: value.equipment,
          minRateEur: value.minRateEur,
          active: true,
          expiresAt,
        },
      });
    });
    return reply.code(201).send({ beacon });
  });

  app.get('/marketplace/beacons', { preHandler: auth }, async (req, reply) => {
    const principal = await resolvePrincipal(req);
    if (!market.canSupply(principal.permissions) && !market.canPostLoad(principal.permissions)) {
      return refuse(reply, 'forbidden');
    }
    const query = (req.query ?? {}) as Record<string, unknown>;
    const now = new Date();
    // ANDed clauses, so an availability filter cannot widen the expiry rule.
    const and: unknown[] = [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }];
    const where: Record<string, unknown> = { active: true, AND: and };
    if (typeof query.equipment === 'string' && market.EQUIPMENT_OPTIONS.includes(query.equipment)) {
      where.equipment = query.equipment;
    }
    if (typeof query.location === 'string' && query.location.trim()) {
      where.location = { contains: query.location.trim(), mode: 'insensitive' };
    }
    if (typeof query.availableBefore === 'string' && query.availableBefore.trim()) {
      const before = new Date(query.availableBefore);
      if (!Number.isNaN(before.getTime())) {
        and.push({ OR: [{ availableFrom: null }, { availableFrom: { lte: before } }] });
      }
    }
    const beacons = await prisma.capacityBeacon.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return reply.send(stripCredentialFields({ beacons }));
  });

  app.delete('/marketplace/beacons/:id', { preHandler: auth }, async (req, reply) => {
    const principal = await resolvePrincipal(req);
    const { id } = req.params as { id: string };
    const beacon = await prisma.capacityBeacon.findUnique({ where: { id } });
    if (!beacon) return reply.code(404).send({ error: 'not_found' });
    const owned = principal.orgId ? beacon.orgId === principal.orgId : beacon.driverId === principal.userId;
    if (!owned) return reply.code(404).send({ error: 'not_found' });
    const updated = await prisma.capacityBeacon.update({ where: { id }, data: { active: false } });
    return reply.send({ beacon: updated });
  });

  /* ------------------------------------------------------------ matches --- */

  app.get('/marketplace/matches', { preHandler: auth }, async (req, reply) => {
    const principal = await resolvePrincipal(req);
    const loadId = typeof (req.query as any)?.loadId === 'string' ? (req.query as any).loadId : '';
    if (!loadId) return reply.code(400).send({ error: 'invalid_input', field: 'loadId', detail: 'loadId is required' });
    const load = await prisma.loadPosting.findUnique({ where: { id: loadId }, select: LOAD_SELECT });
    if (!load) return refuse(reply, 'load_not_found');
    if (!market.canReadLoad({ load, principal, permissions: principal.permissions })) return refuse(reply, 'forbidden');

    const now = new Date();
    const beacons = await prisma.capacityBeacon.findMany({
      where: { active: true, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      take: 200,
    });
    const ranked = market.rankBeacons(load, beacons);
    return reply.send(
      stripCredentialFields({
        load: market.loadCard(load),
        matches: ranked.map((row: any) => ({ beacon: row.beacon, score: row.score, reasons: row.reasons })),
      }),
    );
  });
}
