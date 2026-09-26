import type { FastifyInstance } from 'fastify';
import { env } from '../env.js';
import { prisma } from '../db.js';
import { requireAuth } from '../auth/guard.js';
import { hasPermission, loadRolePermissions } from '../auth/permissions.js';
import { statusForError } from '../http-errors.js';
import { trackPageHtml } from '../track-page.js';
import {
  TRACK_LINK_PERMISSION,
  loadTrackedTrip,
  publicTrackUrl,
  reconstructTrackLink,
  signTrackLink,
  verifyTrackLink,
} from '../track-link.js';

/*
 * Customer tracking link (board task #5, UI + per-trip revoke in #39/F8).
 *
 *   POST   /api/trips/:id/track-link   bearer, trip:*  -> mint a signed link
 *   GET    /api/trips/:id/track-link   bearer, trip:*  -> the current link (or null)
 *   DELETE /api/trips/:id/track-link   bearer, trip:*  -> revoke this trip's link
 *   GET    /api/track/:token           no auth         -> public JSON payload
 *   GET    /track/:token               no auth         -> public HTML page
 *
 * The token is an HMAC-SHA256 token bound to one trip id, a per-trip revocation
 * version and an expiry (`track-link.js`). It is signed with a key derived from
 * `AUTH_SECRET`, so it cannot be replayed as a session token; it is
 * org-agnostic by design — the signed trip id *is* the capability, and a token
 * minted for another trip (or another org's trip) simply does not verify for
 * this one.
 *
 * Board task #39 (F8): the mint parameters are persisted on the trip, so the
 * identical token can be recomputed for GET (HMAC is deterministic) and a
 * per-trip `DELETE` can bump `trackLinkVersion`, which invalidates every token
 * already handed out for this trip without touching any other trip.
 *
 * The public responses are PII-free (route/status/timeline/position/POD flag)
 * and carry `x-robots-tag: noindex, nofollow` so a shared link is never indexed.
 *
 * NOTE (infra): production nginx currently proxies only `/api/` and `/pilot/`
 * to the API, so `/track/:token` needs a `location /track/` block before the
 * link works off-host — tracked as an infra request, not done from here.
 */
export async function trackRoutes(app: FastifyInstance) {
  const auth = requireAuth(env.AUTH_SECRET);

  const trackOptions = () => ({
    authSecret: env.AUTH_SECRET,
    secret: env.TRACK_LINK_SECRET,
  });

  /** Resolve the caller's permissions; null when they may not manage links. */
  const managePermissions = async (roleId: string | null | undefined) => {
    const permissions = await loadRolePermissions(prisma, roleId);
    return hasPermission(permissions, TRACK_LINK_PERMISSION) ? permissions : null;
  };

  // Mint a link. Owner/dispatcher only: it exposes a trip to anyone holding it.
  app.post('/trips/:id/track-link', { preHandler: auth }, async (req, reply) => {
    const user = req.user;
    if (!user?.orgId) return reply.code(403).send({ error: 'no_org' });
    if (!(await managePermissions(user.roleId))) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const { id } = req.params as { id: string };

    // Org-scoped existence check: never mint a link for another org's trip.
    const trip = await prisma.trip.findFirst({
      where: { id, orgId: user.orgId },
      select: { id: true, trackLinkVersion: true },
    });
    if (!trip) return reply.code(404).send({ error: 'not_found' });

    const issuedAtSec = Math.floor(Date.now() / 1000);
    const link = signTrackLink({
      tripId: trip.id,
      version: trip.trackLinkVersion,
      authSecret: env.AUTH_SECRET,
      secret: env.TRACK_LINK_SECRET,
      ttlSeconds: env.TRACK_LINK_TTL_SECONDS,
      now: issuedAtSec,
    });
    // Persist the mint parameters (never the token): the trip detail can then
    // show the same link, and DELETE can revoke it by moving the version on.
    await prisma.trip.update({
      where: { id: trip.id },
      data: {
        trackLinkIssuedAt: new Date(issuedAtSec * 1000),
        trackLinkExpiresAt: new Date((issuedAtSec + link.ttlSeconds) * 1000),
      },
    });
    return reply.code(201).send({
      link: {
        token: link.token,
        url: publicTrackUrl(env.PUBLIC_BASE_URL, link.token),
        expiresAt: link.expiresAt,
        ttlSeconds: link.ttlSeconds,
      },
    });
  });

  // The current link for this trip (board task #39). The token is recomputed
  // from the persisted mint parameters; `link: null` when none is live. Only
  // `trip:*` holders may read it — the token is a capability for this one trip.
  app.get('/trips/:id/track-link', { preHandler: auth }, async (req, reply) => {
    const user = req.user;
    if (!user?.orgId) return reply.code(403).send({ error: 'no_org' });
    if (!(await managePermissions(user.roleId))) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const { id } = req.params as { id: string };
    const trip = await prisma.trip.findFirst({
      where: { id, orgId: user.orgId },
      select: {
        id: true,
        trackLinkVersion: true,
        trackLinkIssuedAt: true,
        trackLinkExpiresAt: true,
      },
    });
    if (!trip) return reply.code(404).send({ error: 'not_found' });

    const link = reconstructTrackLink(trip, trackOptions());
    if (!link) return reply.send({ link: null });
    return reply.send({
      link: {
        token: link.token,
        url: publicTrackUrl(env.PUBLIC_BASE_URL, link.token),
        expiresAt: link.expiresAt,
        ttlSeconds: link.ttlSeconds,
      },
    });
  });

  // Revoke this trip's link (board task #39): bump the version so every token
  // signed for the old one stops verifying, and clear the mint state. Other
  // trips are untouched.
  app.delete('/trips/:id/track-link', { preHandler: auth }, async (req, reply) => {
    const user = req.user;
    if (!user?.orgId) return reply.code(403).send({ error: 'no_org' });
    if (!(await managePermissions(user.roleId))) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const { id } = req.params as { id: string };
    const trip = await prisma.trip.findFirst({
      where: { id, orgId: user.orgId },
      select: { id: true },
    });
    if (!trip) return reply.code(404).send({ error: 'not_found' });

    await prisma.trip.update({
      where: { id: trip.id },
      data: {
        trackLinkVersion: { increment: 1 },
        trackLinkIssuedAt: null,
        trackLinkExpiresAt: null,
      },
    });
    return reply.send({ revoked: true, link: null });
  });

  // Public JSON payload for the tracking page. Invalid/expired/rotated/revoked
  // tokens are a flat 404 with a stable error code — no existence leak.
  app.get('/track/:token', async (req, reply) => {
    reply.header('x-robots-tag', 'noindex, nofollow');
    const { token } = req.params as { token: string };
    const verified = verifyTrackLink(token, trackOptions());
    if (!verified) return reply.code(404).send({ error: 'invalid_token' });

    const result = await loadTrackedTrip(prisma, {
      tripId: verified.tripId,
      version: verified.version,
    });
    if (!result.ok) {
      return reply.code(statusForError(result.error)).send({ error: 'invalid_token' });
    }
    return reply.send({
      tracking: result.trip,
      expiresAt: new Date(verified.exp * 1000).toISOString(),
    });
  });
}

/**
 * The public HTML shell. Registered at the root (no prefix) so the shareable
 * path is `/track/:token`, and served with the same noindex header as the JSON.
 * The page itself contains no data: it fetches `/api/track/:token`.
 */
export async function trackPageRoutes(app: FastifyInstance) {
  app.get('/track/:token', async (req, reply) => {
    reply.header('x-robots-tag', 'noindex, nofollow');
    return reply.type('text/html; charset=utf-8').send(trackPageHtml());
  });
}
