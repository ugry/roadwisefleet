/**
 * Two-sided review / feedback system — domain core (board task #98).
 *
 * Owner decision (eila/tasks#73 q3, Matrix @ugur 2026-10-01): *"there should be
 * also feedback system works randomly, 1 review per 10 actions, find working
 * strategies to satisfy both sides."*
 *
 * The "working strategy that satisfies both sides" implemented here:
 *
 *   1. RANDOM SAMPLING, HARD CAPPED. Every completed action (a trip that reaches
 *      DELIVERED) bumps a per-participant counter. A prompt is only *eligible*
 *      once more than `REVIEW_MIN_ACTIONS` (10) actions have happened since the
 *      last prompt — the 10th may not prompt, the 11th may — and is then drawn
 *      at `REVIEW_SAMPLE_PROBABILITY`. So a participant is asked at most once
 *      per 10+ actions, never on every delivery, and the sample is random.
 *   2. TWO-SIDED. The same action produces a prompt for the customer side and
 *      for the carrier org; each rates the other. Ratings aggregate onto the
 *      counterpart's profile (subject), read-only.
 *   3. ABUSE CONTROLS. One review per participant per action (enforced by a
 *      unique key and an immutable write path), no self-review, and a review is
 *      only revealed after the counterpart has had the same chance to review or
 *      the disclosure window (`REVIEW_DISCLOSE_DAYS`) has passed — so a one-sided
 *      rating cannot be used for retaliation.
 *
 * Like `trips-core.js` this file is dependency-free ESM (JSDoc types, no Prisma
 * import) so it runs under `node --test apps/api/src/` with zero install. Every
 * DB function takes a `prisma`-like object and an injectable clock / RNG, which
 * is what makes the sampling cap provable in a test.
 */

/** The only action type in v1: one completed delivery. */
export const REVIEW_ACTION_TYPE = 'delivery';

/** No prompt until MORE than this many completed actions since the last one. */
export const REVIEW_MIN_ACTIONS = 10;

/** Probability that an eligible action actually prompts (random sampling). */
export const REVIEW_SAMPLE_PROBABILITY = 0.25;

/** A hidden review is revealed after this many days even if the other side stays silent. */
export const REVIEW_DISCLOSE_DAYS = 14;

export const RATING_MIN = 1;
export const RATING_MAX = 5;
export const MAX_COMMENT_LENGTH = 1000;

/** A review is about an `org` (carrier) or a `customer`. */
export const SUBJECT_TYPES = ['org', 'customer'];

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidRating(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= RATING_MIN && value <= RATING_MAX;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSubjectType(value) {
  return typeof value === 'string' && SUBJECT_TYPES.indexOf(value) !== -1;
}

/**
 * The random-sampling decision for one participant on one completed action.
 *
 * Cap first: `actionsSinceLastPrompt <= 10` never prompts (the 10th may not;
 * the 11th is eligible). Only then does the random draw decide. `rng` is
 * injectable so a test can pin both branches.
 *
 * @param {{ actionsSinceLastPrompt?: unknown, rng?: () => number, probability?: number, minActions?: number }} [input]
 * @returns {{ prompt: boolean, reason: 'below_cap' | 'not_sampled' | 'sampled' }}
 */
export function sampleDecision(input) {
  const b = input || {};
  const count = Number(b.actionsSinceLastPrompt);
  const min = typeof b.minActions === 'number' ? b.minActions : REVIEW_MIN_ACTIONS;
  const probability = typeof b.probability === 'number' ? b.probability : REVIEW_SAMPLE_PROBABILITY;
  const roll = typeof b.rng === 'function' ? Number(b.rng()) : 0;
  if (!Number.isFinite(count) || count <= min) return { prompt: false, reason: 'below_cap' };
  if (!(roll < probability)) return { prompt: false, reason: 'not_sampled' };
  return { prompt: true, reason: 'sampled' };
}

/**
 * Validate and normalise a review submission.
 * @param {unknown} body
 * @returns {{ ok: true, value: { promptId: string, rating: number, comment: string|null } } | { ok: false, error: string, detail?: string }}
 */
export function normalizeReviewInput(body) {
  if (body === null || typeof body !== 'object') {
    return { ok: false, error: 'invalid_input', detail: 'body must be an object' };
  }
  const b = /** @type {Record<string, unknown>} */ (body);
  const promptId = typeof b.promptId === 'string' ? b.promptId.trim() : '';
  if (!promptId) return { ok: false, error: 'invalid_input', detail: 'promptId is required' };
  const rating = typeof b.rating === 'string' ? Number(b.rating) : b.rating;
  if (!isValidRating(rating)) {
    return { ok: false, error: 'invalid_input', detail: 'rating must be an integer between 1 and 5' };
  }
  let comment = null;
  if (b.comment !== undefined && b.comment !== null && b.comment !== '') {
    if (typeof b.comment !== 'string') {
      return { ok: false, error: 'invalid_input', detail: 'comment must be a string' };
    }
    const trimmed = b.comment.trim();
    if (trimmed.length > MAX_COMMENT_LENGTH) {
      return { ok: false, error: 'invalid_input', detail: `comment must be at most ${MAX_COMMENT_LENGTH} characters` };
    }
    comment = trimmed || null;
  }
  return { ok: true, value: { promptId, rating, comment } };
}

/**
 * A participant can never review itself.
 * @param {unknown} raterType
 * @param {unknown} raterId
 * @param {unknown} subjectType
 * @param {unknown} subjectId
 * @returns {boolean}
 */
export function isSelfReview(raterType, raterId, subjectType, subjectId) {
  return raterType === subjectType && raterId === subjectId;
}

/**
 * When a hidden review becomes visible even without a counterpart.
 * @param {Date|string|number} now
 * @param {number} [days]
 * @returns {Date}
 */
export function disclosureDate(now, days) {
  const base = now instanceof Date ? now : new Date(now === undefined ? Date.now() : now);
  const span = typeof days === 'number' ? days : REVIEW_DISCLOSE_DAYS;
  return new Date(base.getTime() + span * 24 * 60 * 60 * 1000);
}

/**
 * A short, PII-free display label for the action ("Origin → Destination").
 * @param {{ origin?: unknown, destination?: unknown }|null|undefined} order
 * @returns {string|null}
 */
export function actionRefFor(order) {
  if (!order) return null;
  const origin = order.origin === null || order.origin === undefined ? '' : String(order.origin);
  const destination = order.destination === null || order.destination === undefined ? '' : String(order.destination);
  if (!origin && !destination) return null;
  return `${origin} → ${destination}`.trim();
}

/**
 * Plan the prompts for one completed action. The customer side is only asked
 * when a portal login exists to answer it (an unregistered customer has no
 * review surface — the read-only link is not a review surface).
 *
 * @param {{ actionId?: unknown, orgId?: unknown, customerId?: unknown, customerHasLogin?: unknown, now?: Date|string|number, actionRef?: string|null, orgName?: unknown, customerName?: unknown }} [input]
 * @returns {Array<Record<string, unknown>>}
 */
export function planReviewPrompts(input) {
  const b = input || {};
  const actionId = b.actionId === null || b.actionId === undefined ? null : String(b.actionId);
  const orgId = b.orgId === null || b.orgId === undefined ? null : String(b.orgId);
  const customerId = b.customerId === null || b.customerId === undefined ? null : String(b.customerId);
  const discloseAt = disclosureDate(b.now === undefined ? new Date() : b.now);
  const actionRef = b.actionRef === undefined ? null : b.actionRef;
  const prompts = [];

  if (actionId && orgId && customerId && b.customerHasLogin) {
    prompts.push({
      actionType: REVIEW_ACTION_TYPE,
      actionId,
      raterType: 'customer',
      raterId: customerId,
      subjectType: 'org',
      subjectId: orgId,
      actionRef,
      counterpartyName: b.orgName === undefined || b.orgName === null ? null : String(b.orgName),
      discloseAt
    });
  }
  if (actionId && orgId && customerId) {
    prompts.push({
      actionType: REVIEW_ACTION_TYPE,
      actionId,
      raterType: 'org',
      raterId: orgId,
      subjectType: 'customer',
      subjectId: customerId,
      actionRef,
      counterpartyName: b.customerName === undefined || b.customerName === null ? null : String(b.customerName),
      discloseAt
    });
  }
  return prompts;
}

/**
 * Is a review visible? It is revealed as soon as the action has reviews from
 * both sides, or once its disclosure deadline has passed.
 * @param {{ actionId?: unknown, discloseAt?: Date|string|null }} review
 * @param {{ bothSides?: Set<string>, now?: Date|string|number }} [ctx]
 * @returns {boolean}
 */
export function isRevealed(review, ctx) {
  if (!review) return false;
  const c = ctx || {};
  if (c.bothSides && typeof c.bothSides.has === 'function' && c.bothSides.has(String(review.actionId))) {
    return true;
  }
  if (review.discloseAt) {
    const deadline = review.discloseAt instanceof Date ? review.discloseAt : new Date(review.discloseAt);
    const at = c.now instanceof Date ? c.now : new Date(c.now === undefined ? Date.now() : c.now);
    if (!Number.isNaN(deadline.getTime()) && at.getTime() >= deadline.getTime()) return true;
  }
  return false;
}

/**
 * Aggregate the revealed reviews of one subject. `pending` counts reviews that
 * exist but are still hidden (one-sided, inside the disclosure window), so the
 * response never pretends a rating exists that must stay private.
 * @param {Array<{ rating?: unknown, actionId?: unknown, discloseAt?: unknown }>} reviews
 * @param {{ bothSides?: Set<string>, now?: Date|string|number }} [ctx]
 * @returns {{ count: number, pending: number, average: number|null }}
 */
export function summarize(reviews, ctx) {
  const rows = Array.isArray(reviews) ? reviews : [];
  let count = 0;
  let sum = 0;
  let pending = 0;
  for (const review of rows) {
    if (isRevealed(review, ctx)) {
      count += 1;
      sum += Number(review.rating) || 0;
    } else {
      pending += 1;
    }
  }
  return { count, pending, average: count ? Math.round((sum / count) * 100) / 100 : null };
}

/** @typedef {any} ReviewsClient */

/**
 * Increment one participant's completed-action counter and return the new value.
 * @param {ReviewsClient} prisma
 * @param {string} participantType
 * @param {string} participantId
 * @returns {Promise<any>}
 */
function bumpSampling(prisma, participantType, participantId) {
  return prisma.reviewSampling.upsert({
    where: { participantType_participantId: { participantType, participantId } },
    create: { participantType, participantId, actionsSinceRequest: 1 },
    update: { actionsSinceRequest: { increment: 1 } }
  });
}

/**
 * Record one completed action: for each side that can be asked, bump its counter
 * and, when the capped random draw says so, create a review prompt. Best-effort
 * by design — a missing order/customer simply asks nobody.
 *
 * @param {ReviewsClient} prisma
 * @param {{ actionId?: unknown, now?: Date|string|number, rng?: () => number }} args
 * @returns {Promise<{ ok: true, prompted: Array<Record<string, unknown>> } | { ok: false, error: string }>}
 */
export async function recordCompletedAction(prisma, args) {
  const a = args || {};
  const actionId = a.actionId === null || a.actionId === undefined ? '' : String(a.actionId);
  if (!actionId) return { ok: false, error: 'invalid_action' };

  const trip = await prisma.trip.findFirst({
    where: { id: actionId },
    include: { org: true, order: { include: { customer: { include: { accounts: true } } } } }
  });
  if (!trip) return { ok: false, error: 'not_found' };

  const order = trip.order || null;
  const customer = order ? order.customer || null : null;
  const customerHasLogin = Boolean(customer && Array.isArray(customer.accounts) && customer.accounts.length > 0);
  const prompts = planReviewPrompts({
    actionId,
    orgId: trip.orgId,
    customerId: order ? order.customerId : null,
    customerHasLogin,
    now: a.now === undefined ? new Date() : a.now,
    actionRef: actionRefFor(order),
    orgName: trip.org ? trip.org.name : null,
    customerName: customer ? customer.name : null
  });

  const rng = typeof a.rng === 'function' ? a.rng : Math.random;
  const created = [];
  for (const prompt of prompts) {
    const state = await bumpSampling(prisma, String(prompt.raterType), String(prompt.raterId));
    const decision = sampleDecision({ actionsSinceLastPrompt: state && state.actionsSinceRequest, rng });
    if (!decision.prompt) continue;
    try {
      await prisma.reviewPrompt.create({ data: prompt });
    } catch (err) {
      // A concurrent delivery already prompted this participant for this action.
      if (err && /** @type {any} */ (err).code === 'P2002') continue;
      throw err;
    }
    await prisma.reviewSampling.update({
      where: { participantType_participantId: { participantType: prompt.raterType, participantId: prompt.raterId } },
      data: { actionsSinceRequest: 0, lastRequestedAt: a.now === undefined ? new Date() : a.now }
    });
    created.push(prompt);
  }
  return { ok: true, prompted: created };
}

/**
 * The open prompts for one participant (never a submitted one).
 * @param {ReviewsClient} prisma
 * @param {{ raterType: string, raterId: string }} args
 * @returns {Promise<any[]>}
 */
export function listPrompts(prisma, { raterType, raterId }) {
  return prisma.reviewPrompt.findMany({
    where: { raterType, raterId, submittedAt: null },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: {
      id: true,
      actionType: true,
      actionId: true,
      subjectType: true,
      subjectId: true,
      actionRef: true,
      counterpartyName: true,
      discloseAt: true,
      createdAt: true
    }
  });
}

/**
 * Submit one review against a prompt the caller owns. Immutable: the write is a
 * create + a prompt stamp, and the unique key turns a double submit into
 * `already_reviewed` rather than an overwrite.
 * @param {ReviewsClient} prisma
 * @param {{ raterType: string, raterId: string, body?: unknown, now?: Date|string|number }} args
 * @returns {Promise<{ ok: true, review: any } | { ok: false, error: string, detail?: string }>}
 */
export async function submitReview(prisma, args) {
  const a = args || {};
  const normalized = normalizeReviewInput(a.body);
  if (!normalized.ok) return normalized;
  const { promptId, rating, comment } = normalized.value;

  const prompt = await prisma.reviewPrompt.findFirst({ where: { id: promptId, raterType: a.raterType, raterId: a.raterId } });
  if (!prompt) return { ok: false, error: 'prompt_not_found' };
  if (prompt.submittedAt) return { ok: false, error: 'already_reviewed' };
  if (isSelfReview(prompt.raterType, prompt.raterId, prompt.subjectType, prompt.subjectId)) {
    return { ok: false, error: 'self_review' };
  }

  try {
    const [review] = await prisma.$transaction([
      prisma.review.create({
        data: {
          actionType: prompt.actionType,
          actionId: prompt.actionId,
          raterType: prompt.raterType,
          raterId: prompt.raterId,
          subjectType: prompt.subjectType,
          subjectId: prompt.subjectId,
          rating,
          comment,
          discloseAt: prompt.discloseAt
        }
      }),
      prisma.reviewPrompt.update({
        where: { id: prompt.id },
        data: { submittedAt: a.now === undefined ? new Date() : a.now }
      })
    ]);
    return { ok: true, review };
  } catch (err) {
    if (err && /** @type {any} */ (err).code === 'P2002') return { ok: false, error: 'already_reviewed' };
    throw err;
  }
}

/**
 * Read-only aggregate for one subject. A review is counted only once it is
 * revealed (both sides reviewed, or the disclosure window passed).
 * @param {ReviewsClient} prisma
 * @param {{ subjectType: string, subjectId: string, now?: Date|string|number }} args
 * @returns {Promise<{ subjectType: string, subjectId: string, count: number, pending: number, average: number|null }>}
 */
export async function summarizeSubject(prisma, { subjectType, subjectId, now }) {
  const reviews = await prisma.review.findMany({
    where: { subjectType, subjectId },
    orderBy: { createdAt: 'desc' },
    take: 500,
    select: { id: true, actionType: true, actionId: true, raterType: true, rating: true, discloseAt: true }
  });
  if (reviews.length === 0) {
    return { subjectType, subjectId, count: 0, pending: 0, average: null };
  }
  const actionIds = Array.from(new Set(reviews.map((row) => row.actionId)));
  const all = await prisma.review.findMany({
    where: { actionId: { in: actionIds } },
    select: { actionId: true, raterType: true }
  });
  /** @type {Map<string, Set<string>>} */
  const parties = new Map();
  for (const row of all) {
    const set = parties.get(row.actionId) || new Set();
    set.add(row.raterType);
    parties.set(row.actionId, set);
  }
  const bothSides = new Set();
  for (const [actionId, set] of parties) if (set.size >= 2) bothSides.add(actionId);
  const summary = summarize(reviews, { bothSides, now: now === undefined ? new Date() : now });
  return { subjectType, subjectId, ...summary };
}
