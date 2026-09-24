import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../env.js';
import { prisma } from '../db.js';
import { requireAuth } from '../auth/guard.js';
import { hasPermission, loadRolePermissions } from '../auth/permissions.js';
import {
  REFERENCE_PERMISSION,
  listCustomers,
  listDrivers,
  listOrders,
  listTrucks,
  loadReferenceData,
} from '../reference-data.js';
import { stripCredentialFields } from '../user-payload.js';

/*
 * Reference-data API for the dispatch create-trip form (board task #1).
 *
 * The old form asked the dispatcher to type raw `orderId`/`driverId` strings;
 * these read-only endpoints return the org-scoped option lists the dashboard
 * turns into dropdowns. `GET /api/reference` returns all four in one call so
 * the form needs a single round-trip.
 *
 * Tenancy comes from the signed token's `org` claim — never a client header —
 * and every query is scoped by that org. The lists expose org-wide data
 * (customers, other drivers' phone numbers), so they are gated on
 * `trip:create` (`REFERENCE_PERMISSION`): owner/dispatcher (`trip:*`) pass,
 * drivers get `403 forbidden`, exactly like `POST /api/trips`.
 */
export async function referenceRoutes(app: FastifyInstance) {
  const auth = requireAuth(env.AUTH_SECRET);

  /**
   * Resolve the caller's org, or send the denial and return null. Shared by
   * every reference route so the gate can never drift between them.
   */
  async function authorize(req: FastifyRequest, reply: FastifyReply): Promise<string | null> {
    const user = req.user;
    if (!user?.orgId) {
      reply.code(403).send({ error: 'no_org' });
      return null;
    }
    const permissions = await loadRolePermissions(prisma, user.roleId);
    if (!hasPermission(permissions, REFERENCE_PERMISSION)) {
      reply.code(403).send({ error: 'forbidden' });
      return null;
    }
    return user.orgId;
  }

  app.get('/reference', { preHandler: auth }, async (req, reply) => {
    const orgId = await authorize(req, reply);
    if (!orgId) return;
    // Board task #63: the drivers list is a user payload — strip credential
    // fields at the boundary even though the loader already selects safely.
    return reply.send(stripCredentialFields({ reference: await loadReferenceData(prisma, { orgId }) }));
  });

  app.get('/orders', { preHandler: auth }, async (req, reply) => {
    const orgId = await authorize(req, reply);
    if (!orgId) return;
    return reply.send({ orders: await listOrders(prisma, { orgId }) });
  });

  app.get('/drivers', { preHandler: auth }, async (req, reply) => {
    const orgId = await authorize(req, reply);
    if (!orgId) return;
    return reply.send(stripCredentialFields({ drivers: await listDrivers(prisma, { orgId }) }));
  });

  app.get('/trucks', { preHandler: auth }, async (req, reply) => {
    const orgId = await authorize(req, reply);
    if (!orgId) return;
    return reply.send({ trucks: await listTrucks(prisma, { orgId }) });
  });

  app.get('/customers', { preHandler: auth }, async (req, reply) => {
    const orgId = await authorize(req, reply);
    if (!orgId) return;
    return reply.send({ customers: await listCustomers(prisma, { orgId }) });
  });
}
