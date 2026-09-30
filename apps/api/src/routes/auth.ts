import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { requireAuth } from '../auth/guard.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { signToken } from '../auth/tokens.js';
import { localePayload } from '../i18n.js';
import { createRateLimiter } from '../rate-limit.js';
import { resolveClientIp } from '../client-ip.js';
import { OWNER_PERMISSIONS, OWNER_ROLE, REGISTER_AUDIT_ACTION, defaultOrgName } from '../registration.js';
// The signup validation is shared with the browser. The file is UMD (a classic
// script for the page), so it is imported as a CommonJS default export.
import signupRules from '../../../../app/lib/signup.js';

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

/*
 * Auth for the pilot.
 *
 *   POST /api/auth/register  public — self-service fleet-owner signup (board
 *                            task #86, owner directive 2026-09-30): creates the
 *                            Org + an `owner` User and issues the same session
 *                            token as login. Rate-limited per REAL client IP
 *                            (`client-ip.js`): the API sits behind nginx on
 *                            loopback, so `req.ip` alone would be one shared
 *                            bucket for every visitor (PR #78 review, P1).
 *   POST /api/auth/login     email + password against the `User` rows.
 *   GET  /api/auth/me        the signed-in principal.
 *
 * `register` is the public entry point the marketing site links to (the
 * waitlist gate is gone); email verification and password reset are NOT live
 * (the domain cannot send mail yet — email verification stays gated on the
 * owner's task #29). Sessions are stateless HMAC tokens (see auth/tokens.js).
 *
 * The validation rules are shared with the browser (`app/lib/signup.js`), so
 * the form and the endpoint agree by construction; the rate limiter keeps the
 * public endpoint from being used to mass-create rows.
 */
const registrationLimiter = createRateLimiter({
  windowMs: env.REGISTER_RATE_LIMIT_WINDOW_SECONDS * 1000,
  max: env.REGISTER_RATE_LIMIT_MAX,
});

export async function authRoutes(app: FastifyInstance) {
  /**
   * Self-service registration (board task #86): the public entry point. A new
   * person registers a fleet — an `Org` plus an `owner` `User` — and is signed
   * in immediately (the login response shape, so the app has one session path).
   *
   * Bounded per client IP before anything else happens: a refused request never
   * reaches validation or the database.
   */
  app.post('/auth/register', async (req, reply) => {
    // Key on the REAL client, never the shared loopback peer (PR #78 review):
    // nginx forwards with `X-Real-IP: $remote_addr`, and `resolveClientIp()`
    // only trusts that header when the immediate peer is loopback.
    const gate = registrationLimiter.check(resolveClientIp(req));
    if (!gate.allowed) {
      reply.header('retry-after', String(gate.retryAfterSeconds));
      return reply.code(429).send({ error: 'rate_limited', retryAfterSeconds: gate.retryAfterSeconds });
    }

    const normalized = signupRules.validateRegistration(req.body ?? {});
    if (!normalized.ok) {
      return reply.code(400).send({
        error: normalized.error,
        field: normalized.field,
        messageKey: normalized.messageKey,
        detail: normalized.detail,
      });
    }
    const { name, company, email, password } = normalized.value;
    const passwordHash = hashPassword(password);

    let created: { userId: string; orgId: string; orgName: string };
    try {
      created = await prisma.$transaction(async (tx) => {
        // The `owner` Role row belongs to the seeded data, but the deploy path
        // only ever runs `migrate deploy` (no seed), and a missing row would
        // make the `User` insert fail on its `roleId` foreign key (Prisma
        // P2003). Re-assert it idempotently with fixed values, exactly like the
        // customer portal does for its role: an anonymous caller never
        // influences the permission set.
        await tx.role.upsert({
          where: { id: OWNER_ROLE },
          update: { permissions: [...OWNER_PERMISSIONS] },
          create: { id: OWNER_ROLE, permissions: [...OWNER_PERMISSIONS] },
        });
        const org = await tx.org.create({
          data: {
            name: defaultOrgName({ name, company }),
            locale: 'en',
            dataRegion: 'eu',
            plan: 'free',
          },
        });
        const user = await tx.user.create({
          data: {
            roleId: OWNER_ROLE,
            name,
            email,
            orgId: org.id,
            passwordHash,
            lang: 'en',
          },
        });
        return { userId: user.id, orgId: org.id, orgName: org.name };
      });
    } catch (err) {
      // `User.email` is unique: the same address cannot register twice.
      if ((err as { code?: string }).code === 'P2002') {
        return reply.code(409).send({ error: 'email_taken', field: 'email' });
      }
      throw err;
    }

    // Same audit trail as a login; a failure to record it never fails the signup.
    await prisma.auditLog
      .create({ data: { orgId: created.orgId, actorId: created.userId, action: REGISTER_AUDIT_ACTION } })
      .catch(() => undefined);

    const token = signToken(
      { sub: created.userId, org: created.orgId, role: OWNER_ROLE, name },
      env.AUTH_SECRET,
      { ttlSeconds: env.TOKEN_TTL_SECONDS },
    );
    const locale = localePayload({ orgLocale: 'en', userLang: null });
    return reply.code(201).send({
      token,
      user: {
        id: created.userId,
        name,
        roleId: OWNER_ROLE,
        orgId: created.orgId,
        orgName: created.orgName,
        locale: locale.locale,
        lang: locale.lang,
        locales: locale.supported,
      },
    });
  });

  app.post('/auth/login', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const email = String(body.email ?? '').trim().toLowerCase();
    const password = String(body.password ?? '');
    if (!email || !password) {
      return reply.code(400).send({ error: 'invalid_credentials' });
    }

    const user = await prisma.user.findUnique({
      where: { email },
      // The org's default locale travels with the login response (board task #6):
      // the pilot opens in the tenant's language unless the person chose another.
      include: { org: { select: { locale: true } } },
    });
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
    const locale = localePayload({ orgLocale: user.org?.locale, userLang: user.lang });
    return reply.send({
      token,
      user: {
        id: user.id,
        name: user.name,
        roleId: user.roleId,
        orgId: user.orgId,
        // `locale` is the org default the client should use; `lang` is the
        // person's own preference (null when they have none / an unsupported one).
        locale: locale.locale,
        lang: locale.lang,
        locales: locale.supported,
      },
    });
  });

  app.get('/auth/me', { preHandler: requireAuth(env.AUTH_SECRET) }, async (req, reply) => {
    return reply.send({ user: req.user });
  });
}
