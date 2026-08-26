import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';

/*
 * Trips CRUD — skeleton implementing the ER model from
 * docs/diagrams-data-menu-flow.md. Tenancy: every write is scoped to the
 * org in the x-org-id header; the real auth middleware (JWT + RBAC) replaces
 * this trust-the-header stub before anything ships.
 */

function orgIdOf(req: { headers: Record<string, unknown> }): string | null {
  const v = req.headers['x-org-id'];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export async function tripRoutes(app: FastifyInstance) {
  app.get('/trips', async (req, reply) => {
    const orgId = orgIdOf(req);
    if (!orgId) return reply.code(401).send({ error: 'missing_org' });
    const trips = await prisma.trip.findMany({
      where: { orgId },
      include: { driver: true, truck: true, order: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return reply.send({ trips });
  });

  app.post('/trips', async (req, reply) => {
    const orgId = orgIdOf(req);
    if (!orgId) return reply.code(401).send({ error: 'missing_org' });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const trip = await prisma.trip.create({
      data: {
        orgId,
        orderId: String(body.orderId ?? ''),
        driverId: body.driverId ? String(body.driverId) : null,
        truckId: body.truckId ? String(body.truckId) : null,
        status: 'DRAFT',
      },
    });
    return reply.code(201).send({ trip });
  });

  app.post('/trips/:id/status', async (req, reply) => {
    const orgId = orgIdOf(req);
    if (!orgId) return reply.code(401).send({ error: 'missing_org' });
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const from = await prisma.trip.findFirst({ where: { id, orgId } });
    if (!from) return reply.code(404).send({ error: 'not_found' });
    const to = String(body.status ?? '');
    // State machine: DRAFT → ASSIGNED → LOADED → IN_TRANSIT → DELIVERED →
    // POD_UPLOADED → INVOICED → SETTLED, with CANCELLED exits.
    const allowed = ['ASSIGNED', 'LOADED', 'IN_TRANSIT', 'DELIVERED', 'POD_UPLOADED', 'INVOICED', 'SETTLED', 'CANCELLED'];
    if (!allowed.includes(to)) return reply.code(400).send({ error: 'invalid_status' });
    const [trip] = await prisma.$transaction([
      prisma.trip.update({ where: { id }, data: { status: to } }),
      prisma.statusEvent.create({
        data: { tripId: id, fromStatus: from.status, toStatus: to },
      }),
    ]);
    return reply.send({ trip });
  });
}
