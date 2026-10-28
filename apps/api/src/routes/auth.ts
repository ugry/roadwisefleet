import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { requireAuth } from '../auth/guard.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { signToken } from '../auth/tokens.js';
import { localePayload } from '../i18n.js';
import { createRateLimiter } from '../rate-limit.js';
import { createLoginLimiter } from '../login-limit.js';
import { resolveClientIp } from '../client-ip.js';
import { OWNER_ROLE, REGISTER_AUDIT_ACTION } from '../registration.js';
import { createCustomerAccount, createFleetAccount, createSoloAccount } from '../registration-accounts.js';
import { isDeletedAccount } from '../account-deletion.js';
// The account-type catalogue is shared with the browser (board task #111).
import accountTypes from '../../../../app/lib/account-types.js';
// The signup validation is shared with the browser. The file is UMD (a classic
// script for the page), so it is imported as a CommonJS default export.
import signupRules from '../../../../app/lib/signup.js';
// Each account type reuses its own shared rule set (customer portal / solo).
import * as customerCore from '../../../../customer/lib/customer-core.js';
import * as solo from '../../../../solo/lib/solo-core.js';

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
 *   POST /api/auth/login     email + password against the `User` rows. Bounded
 *                            per (address, real client IP) before the lookup
 *                            (board task #130), and still locked per account
 *                            after 5 failures (`423`).
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

/**
 * `POST /auth/login` bound (board task #130, QA #128 finding O1).
 *
 * The edge zone already caps requests per IP, but password spraying across many
 * addresses was bounded only there, and the per-account lockout is remotely
 * triggerable for any known address. This window is keyed on the address being
 * tried PLUS the real client (`login-limit.js`): one client gets `max` attempts
 * per address per window, every other address keeps its own budget, and the
 * lockout stays exactly as it was — this only refuses before the lookup.
 */
const loginLimiter = createLoginLimiter({
  windowMs: env.LOGIN_RATE_LIMIT_WINDOW_SECONDS * 1000,
  max: env.LOGIN_RATE_LIMIT_MAX,
});

export async function authRoutes(app: FastifyInstance) {
  /**
   * Self-service registration (board task #86; three account types added by
   * board task #111): the public entry point. The body carries the chosen
   * `accountType` — `customer`, `fleet` or `solo_driver` — and the server
   * creates the matching rows and derives the role from it (a client can never
   * self-upgrade). A body without a type still registers a fleet, so the
   * existing `/signup` path keeps working.
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

    const body = (req.body ?? {}) as Record<string, unknown>;
    // The account type is chosen at the registration entry (board task #111). A
    // legacy body without one registers a fleet, exactly as before.
    const requested =
      body.accountType === undefined || body.accountType === null || body.accountType === ''
        ? accountTypes.DEFAULT_ACCOUNT_TYPE
        : body.accountType;
    if (!accountTypes.isAccountType(requested)) {
      return reply.code(400).send({
        error: 'invalid_input',
        field: 'accountType',
        messageKey: 'signup.error.accountTypeInvalid',
        detail: 'unknown account type',
      });
    }
    const accountType = requested as 'customer' | 'fleet' | 'solo_driver';

    // Reuse each type's own shared rule set, so the server is never more
    // permissive than the form. The role is derived SERVER-SIDE from the chosen
    // type; a client-supplied `role`/`roleId` is ignored.
    const normalized =
      accountType === 'customer'
        ? customerCore.validateSignup(body)
        : accountType === 'solo_driver'
          ? solo.validateSoloSignup(body)
          : signupRules.validateRegistration(body);
    if (!normalized.ok) {
      return reply.code(400).send({
        error: normalized.error,
        field: normalized.field,
        messageKey: normalized.messageKey,
        detail: normalized.detail,
      });
    }
    const value = normalized.value as Record<string, any>;
    const name = String(value.name);
    const email = String(value.email);
    const passwordHash = hashPassword(String(value.password));

    try {
      if (accountType === 'customer') {
        // The pilot has one host carrier org; CUSTOMER_HOST_ORG_ID pins it in a
        // multi-fleet deployment (same rule as POST /api/customer/signup).
        const hostOrg = env.CUSTOMER_HOST_ORG_ID
          ? await prisma.org.findUnique({ where: { id: env.CUSTOMER_HOST_ORG_ID } })
          : await prisma.org.findFirst({ orderBy: { createdAt: 'asc' } });
        if (!hostOrg) return reply.code(503).send({ error: 'no_carrier_org' });

        const created = await prisma.$transaction((tx) =>
          createCustomerAccount(tx as any, {
            hostOrgId: hostOrg.id,
            name,
            company: value.company,
            email,
            phone: value.phone,
            passwordHash,
            notifyPrefs: value.notifyPrefs,
          }),
        );
        // Same audit trail as the solo/fleet branches (board #111 review): the
        // customer's `User` has no org, so the entry is filed in the host
        // carrier org. A failure to record it never fails the signup.
        await prisma.auditLog
          .create({ data: { orgId: created.hostOrgId, actorId: created.userId, action: REGISTER_AUDIT_ACTION } })
          .catch(() => undefined);
        const token = signToken(
          { sub: created.userId, org: null, role: customerCore.CUSTOMER_ROLE, name },
          env.AUTH_SECRET,
          { ttlSeconds: env.TOKEN_TTL_SECONDS },
        );
        const customerLocale = localePayload({ orgLocale: 'en', userLang: null });
        return reply.code(201).send({
          accountType: 'customer',
          token,
          user: {
            id: created.userId,
            name,
            roleId: customerCore.CUSTOMER_ROLE,
            email,
            orgId: null,
            locale: customerLocale.locale,
            lang: customerLocale.lang,
            locales: customerLocale.supported,
            customer: { id: created.customerId, name: created.customerName, orgId: hostOrg.id },
          },
        });
      }

      if (accountType === 'solo_driver') {
        const created = await prisma.$transaction((tx) =>
          createSoloAccount(tx as any, {
            name,
            company: value.company,
            email,
            phone: value.phone,
            passwordHash,
            truck: value.truck,
          }),
        );
        await prisma.auditLog
          .create({ data: { orgId: created.orgId, actorId: created.userId, action: REGISTER_AUDIT_ACTION } })
          .catch(() => undefined);
        const token = signToken(
          { sub: created.userId, org: created.orgId, role: solo.SOLO_ROLE, name },
          env.AUTH_SECRET,
          { ttlSeconds: env.TOKEN_TTL_SECONDS },
        );
        const locale = localePayload({ orgLocale: 'en', userLang: null });
        return reply.code(201).send({
          accountType: 'solo_driver',
          token,
          user: {
            id: created.userId,
            name,
            roleId: solo.SOLO_ROLE,
            email,
            orgId: created.orgId,
            locale: locale.locale,
            lang: locale.lang,
            locales: locale.supported,
          },
          driver: { id: created.profileId, verificationStatus: 'NONE', phoneVerifiedAt: null },
        });
      }

      // fleet (the default): an `Org` plus its `owner` (fleet manager).
      const created = await prisma.$transaction((tx) =>
        createFleetAccount(tx as any, { name, company: value.company, email, passwordHash }),
      );
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
        accountType: 'fleet',
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
    } catch (err) {
      // `User.email` is unique: the same address cannot register twice.
      if ((err as { code?: string }).code === 'P2002') {
        return reply.code(409).send({ error: 'email_taken', field: 'email' });
      }
      throw err;
    }
  });

  app.post('/auth/login', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const email = String(body.email ?? '').trim().toLowerCase();
    const password = String(body.password ?? '');
    // Bound the attempt BEFORE validation and the database lookup (board task
    // #130, same shape as `register`): a spent budget is a 429 with the existing
    // `rate_limited` body, so the Android client's `auth.error.rateLimited`
    // mapping is reached with real traffic. Keyed on this address AND the real
    // client, so another person's address is never spent by someone else's
    // spray; the 423 lockout below is unchanged.
    const gate = loginLimiter.check(email, resolveClientIp(req));
    if (!gate.allowed) {
      reply.header('retry-after', String(gate.retryAfterSeconds));
      return reply.code(429).send({ error: 'rate_limited', retryAfterSeconds: gate.retryAfterSeconds });
    }
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
    // A deleted account keeps no session (board #142): the stateless bearer
    // token stays signature-valid until it expires, so the tombstone is checked
    // wherever the account itself is read back. The app clears its stored token
    // on a 401 and returns to the login screen.
    const row = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { deletedAt: true, email: true, passwordHash: true },
    });
    if (!row || isDeletedAccount(row)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    return reply.send({ user: req.user });
  });
}
