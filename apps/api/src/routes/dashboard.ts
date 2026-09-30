import type { FastifyInstance } from 'fastify';
import { env } from '../env.js';
import { prisma } from '../db.js';
import { requireAuth } from '../auth/guard.js';
import { hasPermission, loadRolePermissions } from '../auth/permissions.js';
import { loadDashboard } from '../dashboard.js';
import { stripCredentialFields } from '../user-payload.js';

/*
 * Dashboard API (board task #33, FAv1-F2).
 *
 * `GET /api/dashboard` returns the app-home payload: the KPI strip (active
 * trips, on-time %, pending pay), the alerts strip and today's status-event
 * feed — all computed from the caller's org data, nothing sampled.
 *
 * RBAC: the dashboard is a reports surface, so it needs `reports:read`
 * (owner / dispatcher / accountant — the roles whose home is `/app/`). A driver
 * has `trip:read` but not `reports:read` and is refused with 403; their home is
 * `/app/my-trips`.
 *
 * The `stripCredentialFields` boundary guard is applied here too (board task
 * #63): the activity feed names the actor, and a future `include` on `actor`
 * must never be able to leak credential columns.
 */
export async function dashboardRoutes(app: FastifyInstance) {
  const auth = requireAuth(env.AUTH_SECRET);

  app.get('/dashboard', { preHandler: auth }, async (req, reply) => {
    const user = req.user;
    if (!user?.orgId) return reply.code(403).send({ error: 'no_org' });
    const permissions = await loadRolePermissions(prisma, user.roleId);
    if (!hasPermission(permissions, 'reports:read')) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const result = await loadDashboard(prisma, { orgId: user.orgId });
    if (!result.ok) return reply.code(403).send({ error: result.error });
    return reply.send(stripCredentialFields({ dashboard: result.dashboard }));
  });
}
