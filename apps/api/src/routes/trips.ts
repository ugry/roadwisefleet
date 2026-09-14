import type { FastifyInstance } from 'fastify';
import { env } from '../env.js';
import { prisma } from '../db.js';
import { requireAuth } from '../auth/guard.js';
import { hasPermission, loadRolePermissions } from '../auth/permissions.js';
import { statusForError } from '../http-errors.js';
import { createTrip, listDriverTrips, listOrgTrips, transitionTrip } from '../trips-core.js';

/*
 * Trips API — real auth (signed bearer token) replaces the former `x-org-id`
 * trust-the-header stub. Tenancy comes from the token's `org` claim, so a
 * client can never choose its own org.
 *
 * RBAC: every route resolves the token's `roleId` into the seeded
 * `Role.permissions` (one helper: `loadRolePermissions`) and checks
 * capabilities before touching data. Drivers hold `trip:read`/`trip:status`
 * but not `trip:create`, and `transitionTrip` additionally requires the actor
 * to be the trip's assigned driver unless the role holds `trip:*`
 * (owner/dispatcher). A denied action returns 403.
 *
 * Status legality lives in the merged state machine (`trip-status.js`);
 * persistence lives in `trips-core.js`.
 */
export async function tripRoutes(app: FastifyInstance) {
  const auth = requireAuth(env.AUTH_SECRET);

  app.get('/trips', { preHandler: auth }, async (req, reply) => {
    const user = req.user;
    if (!user?.orgId) return reply.code(403).send({ error: 'no_org' });
    const permissions = await loadRolePermissions(prisma, user.roleId);
    if (!hasPermission(permissions, 'trip:read')) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    return reply.send({ trips: await listOrgTrips(prisma, { orgId: user.orgId }) });
  });

  app.post('/trips', { preHandler: auth }, async (req, reply) => {
    const user = req.user;
    if (!user?.orgId) return reply.code(403).send({ error: 'no_org' });
    const permissions = await loadRolePermissions(prisma, user.roleId);
    const result = await createTrip(prisma, {
      orgId: user.orgId,
      body: req.body,
      actor: { userId: user.id, permissions },
    });
    if (!result.ok) {
      return reply.code(statusForError(result.error)).send({ error: result.error });
    }
    return reply.code(201).send({ trip: result.trip });
  });

  app.post('/trips/:id/status', { preHandler: auth }, async (req, reply) => {
    const user = req.user;
    if (!user?.orgId) return reply.code(403).send({ error: 'no_org' });
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const permissions = await loadRolePermissions(prisma, user.roleId);
    const result = await transitionTrip(prisma, {
      orgId: user.orgId,
      tripId: id,
      to: body.status,
      actor: { userId: user.id, permissions },
    });
    if (!result.ok) {
      if (result.error === 'invalid_transition') {
        return reply.code(400).send({ error: 'invalid_transition', from: result.from, to: result.to });
      }
      return reply.code(statusForError(result.error)).send({ error: result.error });
    }
    return reply.send({ trip: result.trip });
  });

  // Driver view: live trip state for the logged-in driver only.
  app.get('/driver/trips', { preHandler: auth }, async (req, reply) => {
    const user = req.user;
    if (!user?.orgId) return reply.code(403).send({ error: 'no_org' });
    const permissions = await loadRolePermissions(prisma, user.roleId);
    if (!hasPermission(permissions, 'trip:read')) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const trips = await listDriverTrips(prisma, { orgId: user.orgId, driverId: user.id });
    return reply.send({ trips });
  });
}
