import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { requireAuth } from '../auth/guard.js';
import {
  isDeletedAccount,
  planAccountDeletion,
  retentionNotice,
  soloProfileScrub,
} from '../account-deletion.js';

/*
 * Account deletion (board task #142, AND1-A3 — Play release blocker).
 *
 *   DELETE /api/account   (bearer)  anonymise the signed-in account
 *
 * Google Play requires an app that lets people create accounts to offer an
 * in-app deletion path AND a web deletion-request URL; `infra/play-data-safety.md`
 * §5 B-P2 records that neither existed. The web half is `web/delete-account/`
 * (same route, called from the browser); the Android app calls it from the More
 * tab. Both speak this one endpoint, so the two Play requirements cannot drift.
 *
 * The rules live in `account-deletion.js` (pure, unit-tested); this route is the
 * single place that performs the writes. Nothing here deletes a trip, a
 * document or delivery evidence: the retention question is the open owner +
 * legal decision on #13/#46, so the endpoint anonymises the ACTOR and states in
 * its response what remains and why — the statement the Play flow must show.
 *
 * Idempotency: a second call is a clean 200 `{ deleted: true, alreadyDeleted:
 * true }` with no writes, so a retried/duplicated request from the app or the
 * web page can never fail or double-anonymise.
 */
export async function accountRoutes(app: FastifyInstance) {
  const auth = requireAuth(env.AUTH_SECRET);

  app.delete('/account', { preHandler: auth }, async (req, reply) => {
    const principal = req.user!;

    const user = await prisma.user.findUnique({
      where: { id: principal.id },
      include: { customerAccount: { select: { id: true } }, soloProfile: { select: { id: true } } },
    });
    // The token is valid but its row is gone: same answer as a bad token, never
    // a hint about which account ids exist.
    if (!user) return reply.code(401).send({ error: 'unauthorized' });

    const plan = planAccountDeletion(user);
    if (plan.alreadyDeleted) {
      const anonymizedAt = user.deletedAt ? user.deletedAt.toISOString() : undefined;
      const notice = retentionNotice({ anonymizedAt });
      return reply.send({ deleted: true, alreadyDeleted: true, ...notice });
    }

    const now = plan.anonymizedAt as Date;

    await prisma.$transaction(async (tx) => {
      // 1. Every device credential dies, together with its unused challenges.
      //    A signed-in phone can therefore never re-authenticate (device auth is
      //    the passwordless path; the password is cleared below).
      await tx.deviceCredential.updateMany({
        where: { driverId: user.id, revokedAt: null },
        data: { revokedAt: now },
      });
      await tx.deviceChallenge.deleteMany({ where: { credential: { driverId: user.id } } });

      // 2. The customer-portal link is deleted (the FK lives on that table), and
      //    the solo profile's identifying fields are scrubbed in place. Neither
      //    removes a trip or a document: those hang off the tenant.
      if (plan.deleteCustomerAccount) {
        await tx.customerAccount.deleteMany({ where: { userId: user.id } });
      }
      if (plan.scrubSoloProfile) {
        await tx.soloDriverProfile.updateMany({ where: { userId: user.id }, data: soloProfileScrub() });
      }

      // 3. Any outstanding e-mail one-time code for the old address dies with
      //    it — codes are keyed by address, not by user.
      if (plan.clearEmailCodes && user.email) {
        // Case-folded on both sides: `/auth/login` lowercases the address but a
        // registration body may not have, and a leftover code must not survive.
        await tx.emailOtp.deleteMany({
          where: { email: { in: [user.email, user.email.toLowerCase()] } },
        });
      }

      // 4. Tombstone the user row itself.
      await tx.user.update({ where: { id: user.id }, data: plan.userUpdate as any });
    });

    // Audit after the commit: a failed audit write must never roll back a
    // deletion the person already saw confirmed (same rule as login).
    if (user.orgId) {
      await prisma.auditLog
        .create({ data: { orgId: user.orgId, actorId: user.id, action: 'account.deleted' } })
        .catch(() => undefined);
    }

    return reply.send({ deleted: true, alreadyDeleted: false, ...retentionNotice({ anonymizedAt: now.toISOString() }) });
  });
}

/**
 * True when the account behind a bearer token has been deleted. Exported so the
 * identity surfaces that would otherwise hand a live session to a tombstoned
 * account (`/api/auth/me`, device registration) can refuse it.
 */
export function isTombstoned(user: { deletedAt?: unknown; email?: unknown; passwordHash?: unknown } | null): boolean {
  return isDeletedAccount(user);
}
