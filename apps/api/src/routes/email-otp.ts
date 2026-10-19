import type { FastifyInstance } from 'fastify';
import { randomInt } from 'node:crypto';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { requireAuth } from '../auth/guard.js';
import { signToken } from '../auth/tokens.js';
import { localePayload } from '../i18n.js';
import { createRateLimiter } from '../rate-limit.js';
import { resolveClientIp } from '../client-ip.js';
import { createEmailSender } from '../auth/email-transport.js';
import {
  OTP_MAX_ATTEMPTS,
  OTP_TTL_SECONDS,
  PURPOSE_LOGIN,
  PURPOSE_VERIFY,
  codeMatches,
  expiryFor,
  gate,
  generateCode,
  hashCode,
  isValidEmail,
  nextAttempt,
  normalizeEmail,
  resendWaitSeconds,
} from '../email-otp.js';

/*
 * Email one-time codes (board task #125).
 *
 *   POST /api/auth/otp/email/request   (public) email -> generic acknowledgement
 *   POST /api/auth/otp/email/verify    (public) email + code -> session token
 *   POST /api/auth/email/confirm/request (bearer) send a confirmation code
 *   POST /api/auth/email/confirm/verify  (bearer) redeem it -> emailVerifiedAt
 *
 * What the endpoints guarantee:
 *   - NO account enumeration: `request` answers the same body for a known and an
 *     unknown address (and the same 429 for either when the address bucket is
 *     full); `verify` answers 401 `invalid_code` for every failure — unknown
 *     address, no code, expired, used, locked, wrong code.
 *   - the code is never stored or logged, only its HMAC;
 *   - one code per (address, purpose): requesting again replaces the previous
 *     row, so an old code stops working the moment a new one is sent;
 *   - delivery is bounded (per-email send gap + in-process windows) and the
 *     sender is fail-closed when the #124 credential is absent.
 *
 * Delivery is injected (see `auth/email-transport.js`) so the DB-backed router
 * test can assert "one message, to this address, with a live code" without a
 * real SMTP server.
 */

const ipLimiter = createRateLimiter({
  windowMs: env.EMAIL_OTP_RATE_LIMIT_WINDOW_SECONDS * 1000,
  max: env.EMAIL_OTP_IP_RATE_LIMIT_MAX,
});
const addressLimiter = createRateLimiter({
  windowMs: env.EMAIL_OTP_RATE_LIMIT_WINDOW_SECONDS * 1000,
  max: env.EMAIL_OTP_ADDRESS_RATE_LIMIT_MAX,
});
const verifyLimiter = createRateLimiter({
  windowMs: env.EMAIL_OTP_RATE_LIMIT_WINDOW_SECONDS * 1000,
  max: env.EMAIL_OTP_VERIFY_RATE_LIMIT_MAX,
});

export interface EmailOtpRouteOptions {
  /** Override the sender (tests). Defaults to the env-configured SMTP sender. */
  sender?: { configured: boolean; sendCode: (args: { to: string; code: string; purpose: string }) => Promise<{ sent: boolean; reason?: string }> };
  /** Defaults to `console.warn`; never receives an address or a code. */
  log?: (event: string, detail?: Record<string, unknown>) => void;
}

/**
 * The only body a code request can ever return. Constant by design: a body that
 * differs between "sent", "throttled" and "no such account" is an enumeration
 * oracle, so the fields are fixed and the resend timer is the app's own.
 */
const GENERIC_SENT = {
  ok: true,
  expiresInSeconds: OTP_TTL_SECONDS,
  resendAfterSeconds: env.EMAIL_OTP_RESEND_SECONDS,
} as const;

export async function emailOtpRoutes(app: FastifyInstance, options: EmailOtpRouteOptions = {}) {
  const sender = options.sender ?? createEmailSender();
  const log = options.log ?? ((event: string, detail?: Record<string, unknown>) => {
    // Never a recipient, never a code, never a credential.
    console.warn(`[${event}]`, detail ?? {});
  });
  const auth = requireAuth(env.AUTH_SECRET);

  /**
   * Bound one address + one client before any database work. Returns the reply
   * already sent when refused, else `null`.
   */
  function limit(req: any, reply: any, key: string, limiter = addressLimiter): any {
    const byIp = ipLimiter.check(resolveClientIp(req));
    if (!byIp.allowed) {
      reply.header('retry-after', String(byIp.retryAfterSeconds));
      return reply.code(429).send({ error: 'rate_limited', retryAfterSeconds: byIp.retryAfterSeconds });
    }
    const byKey = limiter.check(key);
    if (!byKey.allowed) {
      reply.header('retry-after', String(byKey.retryAfterSeconds));
      return reply.code(429).send({ error: 'rate_limited', retryAfterSeconds: byKey.retryAfterSeconds });
    }
    return null;
  }

  /**
   * Mint + deliver one code. The response NEVER varies with what happened here
   * (sent, throttled, or an address with no account): every caller gets the same
   * `GENERIC_SENT` body, so the endpoint cannot be used to enumerate accounts.
   * The app runs a fixed resend timer; the server enforces the real gap.
   */
  async function issueCode(email: string, purpose: string): Promise<void> {
    // Fail closed: with no sender configured the address cannot receive a code,
    // so no redeemable row is created at all.
    if (!sender.configured) {
      log('auth.email.not_configured', { purpose });
      return;
    }

    const now = new Date();
    const latest = await prisma.emailOtp.findFirst({
      where: { email, purpose },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    const wait = resendWaitSeconds({ createdAt: latest?.createdAt, now });
    if (wait > 0) return;

    const code = generateCode({ randomInt });
    await prisma.emailOtp.deleteMany({ where: { email, purpose } });
    const created = await prisma.emailOtp.create({
      data: {
        email,
        purpose,
        hash: hashCode({ code, email, purpose, secret: env.AUTH_SECRET }),
        expiresAt: expiryFor(now),
      },
      select: { id: true },
    });
    const delivered = await sender.sendCode({ to: email, code, purpose });
    if (!delivered.sent) {
      // Nothing arrived, so nothing may be redeemed: drop the row and let the
      // caller retry once the delivery path works.
      await prisma.emailOtp.deleteMany({ where: { id: created.id } });
    }
  }

  /**
   * Redeem a code. `null` on success, else the HTTP error to send. Every
   * failure collapses into `invalid_code` (no oracle), except a locked account,
   * which is reported only AFTER a correct code proves the caller owns it.
   */
  async function redeem(
    email: string,
    purpose: string,
    code: string,
  ): Promise<{ error: string; status: number } | null> {
    const now = new Date();
    const row = await prisma.emailOtp.findFirst({
      where: { email, purpose },
      orderBy: { createdAt: 'desc' },
    });
    if (!row || row.usedAt) return { error: 'invalid_code', status: 401 };

    const state = gate({ hash: row.hash, expiresAt: row.expiresAt, attempts: row.attempts, now });
    if (!state.ok) return { error: 'invalid_code', status: 401 };

    if (!codeMatches({ code, email, purpose, hash: row.hash, secret: env.AUTH_SECRET })) {
      const next = nextAttempt(row.attempts);
      await prisma.emailOtp.update({
        where: { id: row.id },
        data: {
          attempts: next.attempts,
          // The cap burns the code: after the last wrong guess nothing can
          // redeem it, not even the right value.
          ...(next.exhausted ? { hash: '' } : {}),
        },
      });
      return { error: 'invalid_code', status: 401 };
    }

    // Single use, atomically: a concurrent second verify of the same code loses
    // the conditional update and is treated exactly like a used code.
    const burned = await prisma.emailOtp.updateMany({
      where: { id: row.id, usedAt: null },
      data: { usedAt: now },
    });
    if (burned.count !== 1) return { error: 'invalid_code', status: 401 };
    return null;
  }

  /* ------------------------------------------------------------ sign-in --- */

  app.post('/auth/otp/email/request', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const email = normalizeEmail(body.email);
    const refused = limit(req, reply, email || 'invalid');
    if (refused) return refused;

    if (!isValidEmail(email)) {
      // A malformed address is a caller mistake, not an account probe: no
      // lookup happens and the app can point at the field.
      return reply.code(400).send({ error: 'invalid_email', field: 'email', messageKey: 'auth.otp.error.email' });
    }

    const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (user) await issueCode(email, PURPOSE_LOGIN);
    // Known and unknown addresses get byte-identical bodies and statuses.
    return reply.send({ ...GENERIC_SENT });
  });

  app.post('/auth/otp/email/verify', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const email = normalizeEmail(body.email);
    const code = String(body.code ?? '').replace(/\s+/g, '');
    const refused = limit(req, reply, email || 'invalid', verifyLimiter);
    if (refused) return refused;
    if (!isValidEmail(email) || !/^\d{6}$/.test(code)) {
      return reply.code(401).send({ error: 'invalid_code', messageKey: 'auth.otp.error.code' });
    }

    const failure = await redeem(email, PURPOSE_LOGIN, code);
    if (failure) {
      return reply.code(failure.status).send({ error: failure.error, messageKey: 'auth.otp.error.code' });
    }

    const user = await prisma.user.findUnique({
      where: { email },
      include: { org: { select: { locale: true } } },
    });
    if (!user) {
      // The code was consumed; an address without an account can never sign in.
      return reply.code(401).send({ error: 'invalid_code', messageKey: 'auth.otp.error.code' });
    }
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      return reply.code(423).send({ error: 'account_locked' });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null },
    });
    if (user.orgId) {
      await prisma.auditLog
        .create({ data: { orgId: user.orgId, actorId: user.id, action: 'auth.login.otp' } })
        .catch(() => undefined);
    }

    const token = signToken(
      { sub: user.id, org: user.orgId, role: user.roleId, name: user.name },
      env.AUTH_SECRET,
      { ttlSeconds: env.TOKEN_TTL_SECONDS },
    );
    const locale = localePayload({ orgLocale: user.org?.locale, userLang: user.lang });
    // Identical shape to `POST /api/auth/login`: the app treats both alike and
    // registers the device key afterwards.
    return reply.send({
      token,
      user: {
        id: user.id,
        name: user.name,
        roleId: user.roleId,
        orgId: user.orgId,
        locale: locale.locale,
        lang: locale.lang,
        locales: locale.supported,
      },
    });
  });

  /* ------------------------------------------------- email confirmation --- */

  app.post('/auth/email/confirm/request', { preHandler: auth }, async (req, reply) => {
    const user = req.user!;
    const refused = limit(req, reply, `user:${user.id}`);
    if (refused) return refused;

    const record = await prisma.user.findUnique({ where: { id: user.id }, select: { email: true } });
    const email = normalizeEmail(record?.email);
    if (!record || !isValidEmail(email)) return reply.code(400).send({ error: 'no_email' });

    await issueCode(email, PURPOSE_VERIFY);
    return reply.send({ ...GENERIC_SENT });
  });

  app.post('/auth/email/confirm/verify', { preHandler: auth }, async (req, reply) => {
    const user = req.user!;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const code = String(body.code ?? '').replace(/\s+/g, '');
    const refused = limit(req, reply, `user:${user.id}`, verifyLimiter);
    if (refused) return refused;
    if (!/^\d{6}$/.test(code)) {
      return reply.code(401).send({ error: 'invalid_code', messageKey: 'auth.otp.error.code' });
    }

    const record = await prisma.user.findUnique({ where: { id: user.id }, select: { email: true } });
    const email = normalizeEmail(record?.email);
    if (!record || !isValidEmail(email)) return reply.code(400).send({ error: 'no_email' });

    const failure = await redeem(email, PURPOSE_VERIFY, code);
    if (failure) {
      return reply.code(failure.status).send({ error: failure.error, messageKey: 'auth.otp.error.code' });
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { emailVerifiedAt: new Date() },
      select: { emailVerifiedAt: true },
    });
    if (user.orgId) {
      await prisma.auditLog
        .create({ data: { orgId: user.orgId, actorId: user.id, action: 'auth.email.confirmed' } })
        .catch(() => undefined);
    }
    return reply.send({ ok: true, emailVerifiedAt: updated.emailVerifiedAt });
  });

  // Exposed for the router test and for an operator diagnostic; never a secret.
  app.get('/auth/otp/email/status', async (_req, reply) => {
    return reply.send({
      configured: Boolean(sender.configured),
      ttlSeconds: OTP_TTL_SECONDS,
      resendSeconds: env.EMAIL_OTP_RESEND_SECONDS,
      maxAttempts: OTP_MAX_ATTEMPTS,
    });
  });
}
