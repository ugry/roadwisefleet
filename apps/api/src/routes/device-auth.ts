import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { requireAuth } from '../auth/guard.js';
import { hasPermission, loadRolePermissions } from '../auth/permissions.js';
import { signToken } from '../auth/tokens.js';
import { localePayload } from '../i18n.js';
import { createRateLimiter } from '../rate-limit.js';
import { resolveClientIp } from '../client-ip.js';
import {
  createChallenge,
  challengeUsable,
  normalizeRegistration,
  verifyDeviceSignature,
} from '../device-auth.js';

/*
 * Passwordless Android device auth (board task #104, AND1-A2).
 *
 *   POST /api/auth/device/register   (bearer)  bind a device public key
 *   POST /api/auth/device/challenge  (public)  issue a single-use nonce
 *   POST /api/auth/device/verify     (public)  signature -> session token
 *   POST /api/auth/device/revoke     (bearer)  lost-phone / logout revoke
 *
 * The private key is generated in the Android Keystore and never leaves the
 * device; the server stores the SPKI public key only (`device-auth.js`).
 *
 * `challenge`/`verify` are public (that is the point — no password), so they
 * are bounded per REAL client IP before any database work, exactly like
 * `/api/auth/register` (the API sits behind nginx on loopback, so `req.ip`
 * alone would be one shared bucket).
 */
const deviceLimiter = createRateLimiter({
  windowMs: env.DEVICE_AUTH_RATE_LIMIT_WINDOW_SECONDS * 1000,
  max: env.DEVICE_AUTH_RATE_LIMIT_MAX,
});

/** An audit write must never fail the request it describes (same as login). */
async function audit(orgId: string | null, actorId: string, action: string): Promise<void> {
  if (!orgId) return;
  await prisma.auditLog.create({ data: { orgId, actorId, action } }).catch(() => undefined);
}

export async function deviceAuthRoutes(app: FastifyInstance) {
  const auth = requireAuth(env.AUTH_SECRET);

  // Bind a device to the signed-in account. Called once, right after the first
  // password/OTP login. The credential is bound to `req.user.id` — the caller
  // can only ever bind their OWN device, never somebody else's.
  app.post('/auth/device/register', { preHandler: auth }, async (req, reply) => {
    const user = req.user!;
    const normalized = normalizeRegistration(req.body ?? {});
    if (!normalized.ok) {
      return reply
        .code(400)
        .send({ error: normalized.error, ...(normalized.detail ? { detail: normalized.detail } : {}) });
    }
    const { algorithm, publicKey, deviceLabel } = normalized.value;
    const credential = await prisma.deviceCredential.create({
      data: { driverId: user.id, publicKey, algorithm, deviceLabel },
      select: { id: true, algorithm: true, deviceLabel: true, createdAt: true },
    });
    await audit(user.orgId, user.id, 'auth.device.register');
    return reply.code(201).send({ credential });
  });

  // Public: the device names the credential it holds and receives a nonce to
  // sign. A revoked credential is refused before a challenge is created.
  app.post('/auth/device/challenge', async (req, reply) => {
    const gate = deviceLimiter.check(resolveClientIp(req));
    if (!gate.allowed) {
      reply.header('retry-after', String(gate.retryAfterSeconds));
      return reply.code(429).send({ error: 'rate_limited', retryAfterSeconds: gate.retryAfterSeconds });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const credentialId = typeof body.credentialId === 'string' ? body.credentialId.trim() : '';
    if (!credentialId) return reply.code(400).send({ error: 'invalid_input', detail: 'credentialId is required' });

    const credential = await prisma.deviceCredential.findUnique({ where: { id: credentialId } });
    if (!credential) return reply.code(404).send({ error: 'credential_not_found' });
    if (credential.revokedAt) return reply.code(403).send({ error: 'credential_revoked' });

    const { nonce, expiresAt } = createChallenge({ ttlSeconds: env.DEVICE_CHALLENGE_TTL_SECONDS });
    const challenge = await prisma.deviceChallenge.create({
      data: { credentialId: credential.id, nonce, expiresAt },
      select: { id: true, expiresAt: true },
    });
    return reply.send({
      challengeId: challenge.id,
      nonce,
      algorithm: credential.algorithm,
      expiresAt: challenge.expiresAt.toISOString(),
    });
  });

  // Public: verify the detached signature over the nonce and issue a session
  // token identical in shape to a password login. A failure is a flat 401 with
  // a machine code — never which check failed beyond the code itself.
  app.post('/auth/device/verify', async (req, reply) => {
    const gate = deviceLimiter.check(resolveClientIp(req));
    if (!gate.allowed) {
      reply.header('retry-after', String(gate.retryAfterSeconds));
      return reply.code(429).send({ error: 'rate_limited', retryAfterSeconds: gate.retryAfterSeconds });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const challengeId = typeof body.challengeId === 'string' ? body.challengeId.trim() : '';
    const signature = typeof body.signature === 'string' ? body.signature : '';
    if (!challengeId || !signature) {
      return reply.code(400).send({ error: 'invalid_input', detail: 'challengeId and signature are required' });
    }

    const challenge = await prisma.deviceChallenge.findUnique({
      where: { id: challengeId },
      include: { credential: true },
    });
    if (!challenge) return reply.code(404).send({ error: 'challenge_not_found' });
    if (challenge.credential.revokedAt) return reply.code(403).send({ error: 'credential_revoked' });
    if (challenge.usedAt) return reply.code(401).send({ error: 'challenge_used' });
    if (!challengeUsable(challenge)) return reply.code(401).send({ error: 'challenge_expired' });

    const ok = verifyDeviceSignature({
      publicKey: challenge.credential.publicKey,
      algorithm: challenge.credential.algorithm,
      nonce: challenge.nonce,
      signature,
    });
    if (!ok) return reply.code(401).send({ error: 'invalid_signature' });

    // Deliberate: unlike `/auth/login`, this path does NOT enforce
    // `user.lockedUntil`. A password is guessable and needs that lockout; the
    // device private key is not guessable, and locking a phone out of its own
    // key would strand the legitimate owner. The lost-phone remedy is revoking
    // the credential, not locking the account.
    const user = await prisma.user.findUnique({
      where: { id: challenge.credential.driverId },
      include: { org: { select: { locale: true } } },
    });
    if (!user) return reply.code(401).send({ error: 'invalid_signature' });

    // Single-use, atomically. The pre-check above is only the fast path: two
    // concurrent verifies of the same (challengeId, signature) can both pass
    // it. Burn the challenge only while it is still unused — exactly one caller
    // wins that conditional update and mints a token; a lost race is treated as
    // an already-used challenge.
    const now = new Date();
    const burned = await prisma.deviceChallenge.updateMany({
      where: { id: challenge.id, usedAt: null },
      data: { usedAt: now },
    });
    if (burned.count !== 1) return reply.code(401).send({ error: 'challenge_used' });
    await prisma.deviceCredential.update({ where: { id: challenge.credential.id }, data: { lastUsedAt: now } });

    const token = signToken(
      { sub: user.id, org: user.orgId, role: user.roleId, name: user.name },
      env.AUTH_SECRET,
      { ttlSeconds: env.TOKEN_TTL_SECONDS },
    );
    const locale = localePayload({ orgLocale: user.org?.locale, userLang: user.lang });
    await audit(user.orgId, user.id, 'auth.device.verify');
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
        deviceCredentialId: challenge.credential.id,
      },
    });
  });

  // Revoke a device: the credential's own driver, or an admin (`user:manage` /
  // `trip:*`). Idempotent — revoking an already-revoked credential is a 200, so
  // the lost-phone path can be retried safely.
  app.post('/auth/device/revoke', { preHandler: auth }, async (req, reply) => {
    const user = req.user!;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const credentialId = typeof body.credentialId === 'string' ? body.credentialId.trim() : '';
    if (!credentialId) return reply.code(400).send({ error: 'invalid_input', detail: 'credentialId is required' });

    const credential = await prisma.deviceCredential.findUnique({ where: { id: credentialId } });
    if (!credential) return reply.code(404).send({ error: 'credential_not_found' });
    if (credential.driverId !== user.id) {
      // Roles are global (`Role.id` = owner/dispatcher/...), so the permission
      // check alone would let an admin in org A revoke a device in org B if
      // they know the credential id. Cross-org is never-allowed in this API:
      // require the credential's driver to share the caller's non-null org
      // first, then check the permission.
      if (!user.orgId) return reply.code(403).send({ error: 'forbidden' });
      const credentialDriver = await prisma.user.findUnique({
        where: { id: credential.driverId },
        select: { orgId: true },
      });
      if (!credentialDriver || credentialDriver.orgId !== user.orgId) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      const permissions = await loadRolePermissions(prisma, user.roleId);
      if (!hasPermission(permissions, 'user:manage') && !hasPermission(permissions, 'trip:*')) {
        return reply.code(403).send({ error: 'forbidden' });
      }
    }
    const revokedAt = credential.revokedAt ?? new Date();
    if (!credential.revokedAt) {
      await prisma.deviceCredential.update({ where: { id: credential.id }, data: { revokedAt } });
      await audit(user.orgId, user.id, 'auth.device.revoke');
    }
    return reply.send({ credential: { id: credential.id, revokedAt: revokedAt.toISOString() } });
  });
}
