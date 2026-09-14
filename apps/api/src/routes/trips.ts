import type { FastifyInstance } from 'fastify';
import { env } from '../env.js';
import { prisma } from '../db.js';
import { requireAuth } from '../auth/guard.js';
import { createTrip, listDriverTrips, listOrgTrips, transitionTrip } from '../trips-core.js';

/*
 * Trips API — real auth (signed bearer token) replaces the former `x-org-id`
 * trust-the-header stub. Tenancy comes from the token's `org` claim, so a
 * client can never choose its own org. Status legality lives in the merged
 * state machine (`trip-status.js`); persistence lives in `trips-core.js`.
 */
export async function tripRoutes(app: FastifyInstance) {
  const auth = requireAuth(env.AUTH_SECRET);

  app.get('/trips', { preHandler: auth }, async (req, reply) => {
    const orgId = req.user?.orgId;
    if (!orgId) return reply.code(403).send({ error: 'no_org' });
    return reply.send({ trips: await listOrgTrips(prisma, { orgId }) });
  });

  app.post('/trips', { preHandler: auth }, async (req, reply) => {
    const orgId = req.user?.orgId;
    if (!orgId) return reply.code(403).send({ error: 'no_org' });
    const result = await createTrip(prisma, { orgId, body: req.body });
    if (!result.ok) {
      const code = result.error === 'order_not_found' ? 404 : 400;
      return reply.code(code).send({ error: result.error });
    }
    return reply.code(201).send({ trip: result.trip });
  });

  app.post('/trips/:id/status', { preHandler: auth }, async (req, reply) => {
    const orgId = req.user?.orgId;
    if (!orgId) return reply.code(403).send({ error: 'no_org' });
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await transitionTrip(prisma, { orgId, tripId: id, to: body.status });
    if (!result.ok) {
      if (result.error === 'not_found') return reply.code(404).send({ error: 'not_found' });
      if (result.error === 'invalid_transition') {
        return reply.code(400).send({ error: 'invalid_transition', from: result.from, to: result.to });
      }
      return reply.code(400).send({ error: result.error });
    }
    return reply.send({ trip: result.trip });
  });

  // Driver view: live trip state for the logged-in driver only.
  app.get('/driver/trips', { preHandler: auth }, async (req, reply) => {
    const user = req.user;
    if (!user?.orgId) return reply.code(403).send({ error: 'no_org' });
    const trips = await listDriverTrips(prisma, { orgId: user.orgId, driverId: user.id });
    return reply.send({ trips });
  });
}
