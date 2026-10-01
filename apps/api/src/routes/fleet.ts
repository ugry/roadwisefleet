import type { FastifyInstance } from 'fastify';
import { env } from '../env.js';
import { prisma } from '../db.js';
import { requireAuth } from '../auth/guard.js';
import { hasPermission, loadRolePermissions } from '../auth/permissions.js';
import { hashPassword } from '../auth/password.js';
import { DRIVER_ROLE, createFleetDriver } from '../registration-accounts.js';
// The base name/email/password rules are shared with the browser signup form.
import signupRules from '../../../../app/lib/signup.js';

/*
 * Fleet-managed driver accounts (board task #111, AND2-REG1).
 *
 * A fleet manager (owner) creates a driver account inside their own org: the
 * driver logs in with the fleet-owned account and lands in the fleet driver
 * menu set, and is NOT billed individually (the fleet owns the plan). The role
 * is derived server-side here; the request cannot set it.
 *
 *   POST /api/fleet/drivers   bearer, `user:manage` — create a driver in the
 *                             caller's org; 403 without the capability or
 *                             without an org; 409 `email_taken`.
 *
 * Tenancy comes from the token's `org` claim, never a client body field.
 */
const MANAGE_PERMISSION = 'user:manage';

export async function fleetRoutes(app: FastifyInstance) {
  const auth = requireAuth(env.AUTH_SECRET);

  app.post('/fleet/drivers', { preHandler: auth }, async (req, reply) => {
    const user = req.user;
    if (!user?.orgId) {
      return reply.code(403).send({ error: 'no_org' });
    }
    const permissions = await loadRolePermissions(prisma, user.roleId);
    if (!hasPermission(permissions, MANAGE_PERMISSION)) {
      return reply.code(403).send({ error: 'forbidden' });
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const normalized = signupRules.validateRegistration(body);
    if (!normalized.ok) {
      return reply.code(400).send({
        error: normalized.error,
        field: normalized.field,
        messageKey: normalized.messageKey,
        detail: normalized.detail,
      });
    }
    const { name, email, password } = normalized.value;
    const phone = typeof body.phone === 'string' && body.phone.trim() ? body.phone.trim() : null;

    let created: { userId: string; orgId: string };
    try {
      created = await prisma.$transaction((tx) =>
        createFleetDriver(tx as any, {
          orgId: user.orgId as string,
          name,
          email,
          phone,
          passwordHash: hashPassword(password),
        }),
      );
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        return reply.code(409).send({ error: 'email_taken', field: 'email' });
      }
      throw err;
    }

    await prisma.auditLog
      .create({ data: { orgId: user.orgId, actorId: user.id, action: 'fleet.driver.create' } })
      .catch(() => undefined);

    return reply.code(201).send({
      driver: { id: created.userId, name, email, roleId: DRIVER_ROLE, orgId: created.orgId, phone },
    });
  });
}
