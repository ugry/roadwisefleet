import type { FastifyInstance, FastifyRequest } from 'fastify';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { requireAuth } from '../auth/guard.js';
import { hasPermission, loadRolePermissions } from '../auth/permissions.js';
import { statusForError } from '../http-errors.js';
import { isSubjectType, listPrompts, submitReview, summarizeSubject } from '../reviews.js';

/*
 * Two-sided review / feedback API (board task #98, owner decision #73 q3).
 *
 *   GET  /api/reviews/prompts                          my open review prompts
 *   POST /api/reviews                                  submit one review (immutable)
 *   GET  /api/reviews/summary/:subjectType/:subjectId  read-only aggregate rating
 *
 * The sampling itself is not an endpoint: it runs when a trip reaches DELIVERED
 * (`recordCompletedAction` from `routes/trips.ts`), so a client can never
 * manufacture a prompt. The rules (cap + random draw + one-per-action + reveal)
 * live in `reviews.js` and are unit-tested with the native runner.
 *
 * A caller is resolved to exactly one review participant: a customer portal
 * login (`customer:manage` + a CustomerAccount) acts as its Customer, and an org
 * user acts as its Org. The rater identity is derived from the token, never from
 * the request body, so a client cannot review as somebody else.
 */

interface Participant {
  raterType: 'customer' | 'org';
  raterId: string;
  name: string;
}

type ParticipantResult =
  | { ok: true; participant: Participant }
  | { ok: false; status: number; error: string };

async function resolveParticipant(req: FastifyRequest): Promise<ParticipantResult> {
  const user = req.user;
  if (!user) return { ok: false, status: 401, error: 'unauthorized' };
  const permissions = await loadRolePermissions(prisma, user.roleId);
  if (hasPermission(permissions, 'customer:manage')) {
    const row = await prisma.user.findUnique({
      where: { id: user.id },
      select: { id: true, name: true, customerAccount: { select: { customerId: true } } },
    });
    const customerId = row?.customerAccount?.customerId;
    if (!customerId) return { ok: false, status: 403, error: 'forbidden' };
    return {
      ok: true,
      participant: { raterType: 'customer', raterId: customerId, name: row?.name ?? '' },
    };
  }
  if (user.orgId) {
    return { ok: true, participant: { raterType: 'org', raterId: user.orgId, name: user.name ?? '' } };
  }
  return { ok: false, status: 403, error: 'forbidden' };
}

export async function reviewRoutes(app: FastifyInstance) {
  const auth = requireAuth(env.AUTH_SECRET);

  app.get('/reviews/prompts', { preHandler: auth }, async (req, reply) => {
    const resolved = await resolveParticipant(req);
    if (!resolved.ok) return reply.code(resolved.status).send({ error: resolved.error });
    const prompts = await listPrompts(prisma, {
      raterType: resolved.participant.raterType,
      raterId: resolved.participant.raterId,
    });
    return reply.send({ prompts });
  });

  app.post('/reviews', { preHandler: auth }, async (req, reply) => {
    const resolved = await resolveParticipant(req);
    if (!resolved.ok) return reply.code(resolved.status).send({ error: resolved.error });
    const result = await submitReview(prisma, {
      raterType: resolved.participant.raterType,
      raterId: resolved.participant.raterId,
      body: req.body,
    });
    if (!result.ok) {
      return reply
        .code(statusForError(result.error))
        .send({ error: result.error, ...(result.detail ? { detail: result.detail } : {}) });
    }
    return reply.code(201).send({ review: result.review });
  });

  app.get('/reviews/summary/:subjectType/:subjectId', { preHandler: auth }, async (req, reply) => {
    const resolved = await resolveParticipant(req);
    if (!resolved.ok) return reply.code(resolved.status).send({ error: resolved.error });
    const { subjectType, subjectId } = req.params as { subjectType: string; subjectId: string };
    if (!isSubjectType(subjectType)) return reply.code(400).send({ error: 'invalid_subject' });
    const summary = await summarizeSubject(prisma, { subjectType, subjectId });
    return reply.send({ summary });
  });
}
