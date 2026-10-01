/**
 * Unit tests for the two-sided review / feedback core (board task #98).
 *
 * Dependency-free: `node --test apps/api/src/` runs these with zero install (it
 * is the CI job's contract). The DB-shaped functions run against a small fake
 * client that implements the surface `reviews.js` uses, so the sampling cap and
 * the reveal rule are proven without a database.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REVIEW_MIN_ACTIONS,
  REVIEW_SAMPLE_PROBABILITY,
  actionRefFor,
  disclosureDate,
  isRevealed,
  isSelfReview,
  normalizeReviewInput,
  planReviewPrompts,
  recordCompletedAction,
  sampleDecision,
  submitReview,
  summarize,
  summarizeSubject,
} from './reviews.js';

test('sampling cap: the 10th action may not prompt, the 11th may', () => {
  // Even when the random draw always says yes, the cap holds at 10.
  assert.deepEqual(sampleDecision({ actionsSinceLastPrompt: 10, rng: () => 0 }), {
    prompt: false,
    reason: 'below_cap',
  });
  assert.deepEqual(sampleDecision({ actionsSinceLastPrompt: 11, rng: () => 0 }), {
    prompt: true,
    reason: 'sampled',
  });
  // And the draw decides once eligible.
  assert.deepEqual(sampleDecision({ actionsSinceLastPrompt: 11, rng: () => 0.99 }), {
    prompt: false,
    reason: 'not_sampled',
  });
  assert.equal(REVIEW_MIN_ACTIONS, 10);
  assert.ok(REVIEW_SAMPLE_PROBABILITY > 0 && REVIEW_SAMPLE_PROBABILITY < 1);
});

test('sampleDecision tolerates a missing/invalid counter', () => {
  assert.equal(sampleDecision({}).prompt, false);
  assert.equal(sampleDecision({ actionsSinceLastPrompt: 'nope', rng: () => 0 }).prompt, false);
});

test('normalizeReviewInput validates the rating and the comment', () => {
  const ok = normalizeReviewInput({ promptId: ' p1 ', rating: 5, comment: '  Great  ' });
  assert.deepEqual(ok, { ok: true, value: { promptId: 'p1', rating: 5, comment: 'Great' } });

  assert.equal(normalizeReviewInput({ rating: 4 }).ok, false);
  assert.equal(normalizeReviewInput({ promptId: 'p1', rating: 0 }).ok, false);
  assert.equal(normalizeReviewInput({ promptId: 'p1', rating: 6 }).ok, false);
  assert.equal(normalizeReviewInput({ promptId: 'p1', rating: 3.5 }).ok, false);
  assert.equal(normalizeReviewInput({ promptId: 'p1', rating: '4' }).value.rating, 4);
  assert.equal(normalizeReviewInput({ promptId: 'p1', rating: 4, comment: '' }).value.comment, null);
  assert.equal(normalizeReviewInput({ promptId: 'p1', rating: 4, comment: 'x'.repeat(1001) }).ok, false);
  assert.equal(normalizeReviewInput(null).ok, false);
});

test('no self-review, and the action label is derived from the order', () => {
  assert.equal(isSelfReview('org', 'o1', 'org', 'o1'), true);
  assert.equal(isSelfReview('org', 'o1', 'customer', 'c1'), false);
  assert.equal(actionRefFor({ origin: 'Berlin', destination: 'Warsaw' }), 'Berlin → Warsaw');
  assert.equal(actionRefFor(null), null);
});

test('planReviewPrompts asks both sides; the customer side needs a login', () => {
  const both = planReviewPrompts({
    actionId: 't1',
    orgId: 'o1',
    customerId: 'c1',
    customerHasLogin: true,
    now: new Date('2026-10-01T00:00:00Z'),
    actionRef: 'Berlin → Warsaw',
    orgName: 'Carrier GmbH',
    customerName: 'ACME',
  });
  assert.equal(both.length, 2);
  const customer = both.find((p) => p.raterType === 'customer');
  const carrier = both.find((p) => p.raterType === 'org');
  // cross-rating: each side reviews the other
  assert.deepEqual(
    { rater: [customer.raterType, customer.raterId], subject: [customer.subjectType, customer.subjectId] },
    { rater: ['customer', 'c1'], subject: ['org', 'o1'] },
  );
  assert.deepEqual(
    { rater: [carrier.raterType, carrier.raterId], subject: [carrier.subjectType, carrier.subjectId] },
    { rater: ['org', 'o1'], subject: ['customer', 'c1'] },
  );
  assert.equal(customer.counterpartyName, 'Carrier GmbH');
  assert.equal(carrier.counterpartyName, 'ACME');
  assert.equal(customer.discloseAt.toISOString(), '2026-10-15T00:00:00.000Z');

  const noLogin = planReviewPrompts({
    actionId: 't1',
    orgId: 'o1',
    customerId: 'c1',
    customerHasLogin: false,
  });
  assert.equal(noLogin.length, 1);
  assert.equal(noLogin[0].raterType, 'org');
});

test('disclosure window and reveal rule', () => {
  const now = new Date('2026-10-01T00:00:00Z');
  const deadline = disclosureDate(now, 14);
  assert.equal(deadline.toISOString(), '2026-10-15T00:00:00.000Z');

  const review = { actionId: 't1', rating: 4, discloseAt: deadline };
  // One-sided and inside the window: hidden.
  assert.equal(isRevealed(review, { bothSides: new Set(), now }), false);
  // Both sides reviewed: revealed immediately.
  assert.equal(isRevealed(review, { bothSides: new Set(['t1']), now }), true);
  // Still silent after the deadline: revealed.
  assert.equal(isRevealed(review, { bothSides: new Set(), now: new Date('2026-10-20T00:00:00Z') }), true);
});

test('summarize counts only revealed reviews and reports pending', () => {
  const now = new Date('2026-10-01T00:00:00Z');
  const rows = [
    { actionId: 't1', rating: 5, discloseAt: disclosureDate(now) },
    { actionId: 't2', rating: 3, discloseAt: disclosureDate(now) },
    { actionId: 't3', rating: 1, discloseAt: disclosureDate(now) },
  ];
  const s = summarize(rows, { bothSides: new Set(['t1', 't2']), now });
  assert.equal(s.count, 2);
  assert.equal(s.pending, 1);
  assert.equal(s.average, 4);
  assert.equal(summarize([], { now }).average, null);
});

/** A tiny fake of the Prisma surface `reviews.js` uses. */
function fakeClient({ trip = null, prompts = [], counters = {}, reviewsForSubject = [], reviewsForActions = [] } = {}) {
  const state = { prompts: [...prompts], counters, created: [], reviews: [], updates: [] };
  return {
    _state: state,
    trip: { findFirst: async () => trip },
    reviewPrompt: {
      create: async ({ data }) => {
        state.prompts.push(data);
        state.created.push(data);
        return data;
      },
      findFirst: async ({ where }) =>
        state.prompts.find((p) => p.id === where.id && p.raterType === where.raterType && p.raterId === where.raterId) || null,
      update: async ({ where, data }) => {
        state.updates.push({ where, data });
        return { ...where, ...data };
      },
      findMany: async ({ where }) => state.prompts.filter((p) => p.raterType === where.raterType && p.raterId === where.raterId && !p.submittedAt),
    },
    reviewSampling: {
      upsert: async ({ where, create, update }) => {
        const w = where.participantType_participantId;
        const key = `${w.participantType}:${w.participantId}`;
        if (state.counters[key] === undefined) state.counters[key] = create.actionsSinceRequest;
        else if (update && update.actionsSinceRequest && update.actionsSinceRequest.increment) {
          state.counters[key] += update.actionsSinceRequest.increment;
        }
        return { participantType: w.participantType, participantId: w.participantId, actionsSinceRequest: state.counters[key] };
      },
      update: async ({ where, data }) => {
        const w = where.participantType_participantId;
        const key = `${w.participantType}:${w.participantId}`;
        state.counters[key] = data.actionsSinceRequest;
        return { actionsSinceRequest: data.actionsSinceRequest };
      },
    },
    review: {
      create: async ({ data }) => {
        state.reviews.push(data);
        return data;
      },
      findMany: async ({ where }) => (where.actionId ? reviewsForActions : reviewsForSubject),
    },
    $transaction: async (ops) => Promise.all(ops),
  };
}

const tripFixture = {
  id: 't1',
  orgId: 'o1',
  org: { name: 'Carrier GmbH' },
  order: {
    id: 'ord1',
    customerId: 'c1',
    origin: 'Berlin',
    destination: 'Warsaw',
    customer: { id: 'c1', name: 'ACME', accounts: [{ id: 'ca1' }] },
  },
};

test('recordCompletedAction: nothing before the 11th action, a prompt on it', async () => {
  const client = fakeClient({ trip: tripFixture });
  for (let i = 1; i <= 10; i += 1) {
    const result = await recordCompletedAction(client, { actionId: 't1', rng: () => 0 });
    assert.equal(result.prompted.length, 0, `action ${i} must not prompt`);
  }
  assert.equal(client._state.created.length, 0);

  const eleventh = await recordCompletedAction(client, { actionId: 't1', rng: () => 0 });
  assert.equal(eleventh.prompted.length, 2, 'both sides are asked on the 11th action');
  const created = client._state.created;
  assert.equal(created.length, 2);
  // Both directions stored, each rating the other.
  assert.deepEqual(
    created.map((p) => `${p.raterType}:${p.raterId}->${p.subjectType}:${p.subjectId}`).sort(),
    ['customer:c1->org:o1', 'org:o1->customer:c1'].sort(),
  );
  // The counter reset, so the next prompt cannot come before 10 more actions.
  assert.equal(client._state.counters['customer:c1'], 0);
  assert.equal(client._state.counters['org:o1'], 0);
});

test('recordCompletedAction: an eligible action that is not sampled prompts nobody', async () => {
  const client = fakeClient({ trip: tripFixture });
  for (let i = 1; i <= 12; i += 1) {
    await recordCompletedAction(client, { actionId: 't1', rng: () => 0.99 });
  }
  assert.equal(client._state.created.length, 0);
  assert.equal(client._state.counters['org:o1'], 12);
});

test('submitReview writes once, then refuses a second review for the same action', async () => {
  const now = new Date('2026-10-01T00:00:00Z');
  const prompt = {
    id: 'p1',
    actionType: 'delivery',
    actionId: 't1',
    raterType: 'org',
    raterId: 'o1',
    subjectType: 'customer',
    subjectId: 'c1',
    discloseAt: disclosureDate(now),
    submittedAt: null,
  };
  const client = fakeClient({ prompts: [prompt] });

  const first = await submitReview(client, { raterType: 'org', raterId: 'o1', body: { promptId: 'p1', rating: 5, comment: 'ok' }, now });
  assert.equal(first.ok, true);
  assert.equal(first.review.rating, 5);
  assert.equal(first.review.subjectType, 'customer');
  assert.equal(client._state.reviews.length, 1);

  // The prompt was stamped, so a second submit cannot overwrite it.
  client._state.prompts[0].submittedAt = now;
  const second = await submitReview(client, { raterType: 'org', raterId: 'o1', body: { promptId: 'p1', rating: 1 } });
  assert.deepEqual(second, { ok: false, error: 'already_reviewed' });
  assert.equal(client._state.reviews.length, 1);

  // Somebody else's prompt is not visible at all.
  const foreign = await submitReview(client, { raterType: 'customer', raterId: 'c1', body: { promptId: 'p1', rating: 4 } });
  assert.deepEqual(foreign, { ok: false, error: 'prompt_not_found' });
});

test('submitReview refuses an invalid body before touching the DB', async () => {
  const client = fakeClient();
  const result = await submitReview(client, { raterType: 'org', raterId: 'o1', body: { promptId: 'p1', rating: 9 } });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid_input');
  assert.match(result.detail, /rating/);
  assert.equal(client._state.reviews.length, 0);
});

test('summarizeSubject reveals only the reviews both sides had a chance to write', async () => {
  const now = new Date('2026-10-01T00:00:00Z');
  const deadline = disclosureDate(now);
  const reviewsForSubject = [
    { id: 'r1', actionId: 't1', raterType: 'customer', rating: 5, discloseAt: deadline },
    { id: 'r2', actionId: 't2', raterType: 'customer', rating: 1, discloseAt: deadline },
  ];
  const reviewsForActions = [
    { actionId: 't1', raterType: 'customer' },
    { actionId: 't1', raterType: 'org' },
    { actionId: 't2', raterType: 'customer' },
  ];
  const client = fakeClient({ reviewsForSubject, reviewsForActions });
  const summary = await summarizeSubject(client, { subjectType: 'org', subjectId: 'o1', now });
  assert.deepEqual(summary, { subjectType: 'org', subjectId: 'o1', count: 1, pending: 1, average: 5 });
});
