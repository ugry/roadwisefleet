import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { requireAuth } from '../auth/guard.js';
import {
  activeAdminWhere,
  lastOwnerRefusal,
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
 *
 * Last administrator (board task #144, AND1-A3b): the deletion anonymises the
 * caller, and for a fleet owner that would leave the org with no administrator —
 * nobody to manage it, invite users or hand it over, and no address left that
 * could recover it. So a deletion that would remove the org's ONLY live `owner`
 * is refused with `409 { error: 'last_owner', messageKey: … }` and no write.
 * The count is read inside the same transaction as the tombstone, so the check
 * and the write are one unit of work. A simultaneous deletion by two owners is
 * not serialised by READ COMMITTED — that needs SERIALIZABLE + retry and is
 * out of this task's scope (documented in the README, not hidden).
 */

/** Thrown inside the transaction to roll back before any write happens. */
class LastOwnerOnOrg extends Error {
  constructor(readonly payload: { error: string; messageKey: string }) {
    super('last_owner');
    this.name = 'LastOwnerOnOrg';
  }
}

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

    try {
      await prisma.$transaction(async (tx) => {
        // 0. Board #144: never orphan the fleet. The DB row (not the token) owns
        //    the role, and the count is taken inside the transaction so the
        //    decision and the tombstone are one unit of work.
        const activeAdminCount = user.orgId
          ? await tx.user.count({ where: activeAdminWhere(user.orgId) })
          : 0;
        const refusal = lastOwnerRefusal({
          roleId: user.roleId,
          orgId: user.orgId,
          activeAdminCount,
        });
        if (refusal) throw new LastOwnerOnOrg(refusal);

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
    } catch (err) {
      // The transaction rolled back, so the row is untouched.
      if (err instanceof LastOwnerOnOrg) return reply.code(409).send(err.payload);
      throw err;
    }

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
