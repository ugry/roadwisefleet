import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { requireAuth } from '../auth/guard.js';
import { verifyPassword } from '../auth/password.js';
import { signToken } from '../auth/tokens.js';

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

/*
 * Minimal auth for pre-created pilot accounts only: email + password login
 * against the seeded `User` rows. There is deliberately no signup, no email
 * verification and no password reset — email at the domain is not live, so
 * the core loop must not depend on it. Sessions are stateless HMAC tokens
 * (see auth/tokens.js).
 */
export async function authRoutes(app: FastifyInstance) {
  app.post('/auth/login', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const email = String(body.email ?? '').trim().toLowerCase();
    const password = String(body.password ?? '');
    if (!email || !password) {
      return reply.code(400).send({ error: 'invalid_credentials' });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    // Same response for unknown user and bad password (no account enumeration).
    if (!user || !user.passwordHash) {
      return reply.code(401).send({ error: 'invalid_credentials' });
    }
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      return reply.code(423).send({ error: 'account_locked' });
    }
    if (!verifyPassword(password, user.passwordHash)) {
      const failed = user.failedLoginCount + 1;
      await prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginCount: failed,
          lockedUntil: failed >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCKOUT_MS) : null,
        },
      });
      return reply.code(401).send({ error: 'invalid_credentials' });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null },
    });
    if (user.orgId) {
      await prisma.auditLog
        .create({ data: { orgId: user.orgId, actorId: user.id, action: 'auth.login' } })
        .catch(() => undefined);
    }

    const token = signToken(
      { sub: user.id, org: user.orgId, role: user.roleId, name: user.name },
      env.AUTH_SECRET,
      { ttlSeconds: env.TOKEN_TTL_SECONDS },
    );
    return reply.send({
      token,
      user: { id: user.id, name: user.name, roleId: user.roleId, orgId: user.orgId },
    });
  });

  app.get('/auth/me', { preHandler: requireAuth(env.AUTH_SECRET) }, async (req, reply) => {
    return reply.send({ user: req.user });
  });
}
