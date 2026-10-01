/**
 * DB-backed end-to-end coverage for the two-sided review system (board task #98).
 *
 * The dependency-free half (`../src/reviews.test.js`) proves the pure rules; this
 * file proves they hold against the real schema, through the real HTTP routes:
 *
 *   1. the sampling cap: 10 completed actions create no prompt, the 11th does;
 *   2. both directions are stored (the customer rates the carrier, the carrier
 *      rates the customer) and each prompt is addressed to its own participant;
 *   3. a second review for the same action is refused (immutable), and a foreign
 *      prompt is invisible;
 *   4. the aggregate is read-only and hides a one-sided review until the
 *      counterpart has reviewed or the disclosure window has passed.
 *
 * The fixture lives in its **own org** (`qa-reviews-org`), never the seeded pilot
 * org, so it cannot race the concurrent DB-backed suites; it is removed in the
 * `after` hook and the test early-returns when no database is reachable.
 *
 *   pnpm --filter @roadwisefleet/api test:router
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { signToken } from '../src/auth/tokens.js';

// Must be set before `env.ts` is imported: it throws when AUTH_SECRET is missing.
process.env.ALLOW_INSECURE_AUTH_SECRET = '1';

const { buildServer } = await import('../src/app.js');
const { env } = await import('../src/env.js');
const { prisma } = await import('../src/db.js');

const ORG_ID = 'qa-reviews-org';
const OWNER = 'qa-reviews-owner';
const CUSTOMER_USER = 'qa-reviews-customer-user';
const CUSTOMER_ID = 'qa-reviews-customer';
const ORDER_ID = 'qa-reviews-order';
const TRIP_A = 'qa-reviews-trip-a';
const TRIP_B = 'qa-reviews-trip-b';
const USER_IDS = [OWNER, CUSTOMER_USER];
const TRIP_IDS = [TRIP_A, TRIP_B];

let dbReachable = false;
let app: any;

const orgToken = () => signToken({ sub: OWNER, org: ORG_ID, role: 'owner', name: 'QA Reviews Owner' }, env.AUTH_SECRET);
const customerToken = () =>
  signToken({ sub: CUSTOMER_USER, org: null, role: 'customer', name: 'QA Reviews Customer' }, env.AUTH_SECRET);

async function removeFixture(): Promise<void> {
  try {
    await prisma.review.deleteMany({ where: { actionId: { in: TRIP_IDS } } });
    await prisma.reviewPrompt.deleteMany({ where: { actionId: { in: TRIP_IDS } } });
    await prisma.reviewSampling.deleteMany({
      where: {
        OR: [
          { participantType: 'org', participantId: ORG_ID },
          { participantType: 'customer', participantId: CUSTOMER_ID },
        ],
      },
    });
    const where = { tripId: { in: TRIP_IDS } };
    await prisma.$transaction([
      prisma.statusEvent.deleteMany({ where }),
      prisma.gpsPing.deleteMany({ where }),
      prisma.expense.deleteMany({ where }),
      prisma.document.deleteMany({ where }),
      prisma.settlement.deleteMany({ where }),
      prisma.tripStop.deleteMany({ where }),
      prisma.tripDriver.deleteMany({ where }),
      prisma.trip.deleteMany({ where: { id: { in: TRIP_IDS } } }),
      prisma.order.deleteMany({ where: { id: ORDER_ID } }),
      prisma.customerAccount.deleteMany({ where: { userId: CUSTOMER_USER } }),
      prisma.customer.deleteMany({ where: { id: CUSTOMER_ID } }),
      prisma.user.deleteMany({ where: { id: { in: USER_IDS } } }),
      prisma.org.deleteMany({ where: { id: ORG_ID } }),
    ]);
  } catch {
    /* best-effort cleanup: never fail the suite on teardown */
  }
}

before(async () => {
  try {
    await prisma.org.findFirst({ where: { id: 'pilot-org' } });
    await removeFixture();

    // The `customer` role ships with the customer-portal migration; re-assert it
    // idempotently (empty update) so the fixture does not depend on migration order.
    await prisma.role.upsert({
      where: { id: 'customer' },
      create: { id: 'customer', permissions: ['order:create', 'order:read', 'customer:manage'] },
      update: {},
    });

    await prisma.org.create({ data: { id: ORG_ID, name: 'QA Reviews Org', locale: 'en', dataRegion: 'eu', plan: 'free' } });
    await prisma.user.create({
      data: { id: OWNER, orgId: ORG_ID, roleId: 'owner', name: 'QA Reviews Owner', email: 'qa-reviews-owner@roadwisefleet.test', lang: 'en' },
    });
    await prisma.user.create({
      data: { id: CUSTOMER_USER, orgId: null, roleId: 'customer', name: 'QA Reviews Customer', email: 'qa-reviews-customer@roadwisefleet.test', lang: 'en' },
    });
    await prisma.customer.create({ data: { id: CUSTOMER_ID, orgId: ORG_ID, name: 'QA Reviews Customer Co' } });
    await prisma.customerAccount.create({ data: { userId: CUSTOMER_USER, customerId: CUSTOMER_ID } });
    await prisma.order.create({
      data: { id: ORDER_ID, customerId: CUSTOMER_ID, origin: 'Berlin', destination: 'Warsaw' },
    });
    await prisma.trip.create({ data: { id: TRIP_A, orgId: ORG_ID, orderId: ORDER_ID, driverId: null, status: 'DELIVERED' } });
    await prisma.trip.create({ data: { id: TRIP_B, orgId: ORG_ID, orderId: ORDER_ID, driverId: null, status: 'DELIVERED' } });

    app = buildServer();
    await app.ready();
    dbReachable = true;
  } catch (err) {
    console.error('fixture setup failed — DB assertions will be skipped:', (err as Error).message);
  }
});

after(async () => {
  await removeFixture();
  if (app) await app.close();
  await prisma.$disconnect();
});

function get(bearer: string, url: string) {
  return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${bearer}` } });
}

function post(bearer: string, url: string, payload: unknown) {
  return app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${bearer}` }, payload });
}

test('prompts are sampled once per 11 actions and addressed to each side', async (t) => {
  if (!dbReachable) return t.diagnostic('database not reachable here — assertions skipped');

  const { recordCompletedAction } = await import('../src/reviews.js');

  // 10 completed actions: nobody is asked (the cap).
  for (let i = 1; i <= 10; i += 1) {
    await recordCompletedAction(prisma, { actionId: TRIP_A, rng: () => 0 });
  }
  assert.deepEqual((await get(orgToken(), '/api/reviews/prompts')).json().prompts, []);
  assert.deepEqual((await get(customerToken(), '/api/reviews/prompts')).json().prompts, []);

  // The 11th: both sides get exactly one prompt, each rating the other.
  const eleventh = await recordCompletedAction(prisma, { actionId: TRIP_A, rng: () => 0 });
  if (!eleventh.ok) throw new Error(`recordCompletedAction failed: ${eleventh.error}`);
  assert.equal(eleventh.prompted.length, 2);

  const carrier = (await get(orgToken(), '/api/reviews/prompts')).json().prompts as Array<any>;
  const customer = (await get(customerToken(), '/api/reviews/prompts')).json().prompts as Array<any>;
  assert.equal(carrier.length, 1);
  assert.equal(customer.length, 1);
  assert.equal(carrier[0].subjectType, 'customer');
  assert.equal(carrier[0].subjectId, CUSTOMER_ID);
  assert.equal(carrier[0].counterpartyName, 'QA Reviews Customer Co');
  assert.equal(carrier[0].actionRef, 'Berlin → Warsaw');
  assert.equal(customer[0].subjectType, 'org');
  assert.equal(customer[0].subjectId, ORG_ID);
  assert.equal(customer[0].counterpartyName, 'QA Reviews Org');

  // Cross-rating, then immutable.
  const carrierReview = await post(orgToken(), '/api/reviews', { promptId: carrier[0].id, rating: 5, comment: 'On time.' });
  assert.equal(carrierReview.statusCode, 201);
  const customerReview = await post(customerToken(), '/api/reviews', { promptId: customer[0].id, rating: 4 });
  assert.equal(customerReview.statusCode, 201);

  // The prompt is consumed: nobody is asked twice for the same action.
  assert.deepEqual((await get(orgToken(), '/api/reviews/prompts')).json().prompts, []);
  const again = await post(orgToken(), '/api/reviews', { promptId: carrier[0].id, rating: 1 });
  assert.equal(again.statusCode, 409);
  assert.deepEqual(again.json(), { error: 'already_reviewed' });

  // Both directions are stored and, since each side reviewed, both aggregates
  // reveal exactly the counterpart's rating.
  const customerSummary = (await get(orgToken(), `/api/reviews/summary/customer/${CUSTOMER_ID}`)).json().summary;
  assert.deepEqual(customerSummary, { subjectType: 'customer', subjectId: CUSTOMER_ID, count: 1, pending: 0, average: 5 });
  const orgSummary = (await get(customerToken(), `/api/reviews/summary/org/${ORG_ID}`)).json().summary;
  assert.deepEqual(orgSummary, { subjectType: 'org', subjectId: ORG_ID, count: 1, pending: 0, average: 4 });

  // A foreign prompt cannot be reviewed (the rater is derived from the token).
  const foreign = await post(orgToken(), '/api/reviews', { promptId: customer[0].id, rating: 3 });
  assert.equal(foreign.statusCode, 404);
});

test('a one-sided review stays hidden until the counterpart reviews or the window passes', async (t) => {
  if (!dbReachable) return t.diagnostic('database not reachable here — assertions skipped');

  const { recordCompletedAction, summarizeSubject } = await import('../src/reviews.js');

  // The counter for TRIP_A was reset; 11 more completed actions re-prompt.
  for (let i = 1; i <= 10; i += 1) {
    await recordCompletedAction(prisma, { actionId: TRIP_B, rng: () => 0 });
  }
  await recordCompletedAction(prisma, { actionId: TRIP_B, rng: () => 0 });

  const carrier = (await get(orgToken(), '/api/reviews/prompts')).json().prompts as Array<any>;
  assert.equal(carrier.length, 1);

  // Baseline: the action-A review is revealed (both sides reviewed then).
  const baseline = (await get(orgToken(), `/api/reviews/summary/customer/${CUSTOMER_ID}`)).json().summary;
  assert.equal(baseline.count, 1);
  assert.equal(baseline.pending, 0);
  assert.equal(baseline.average, 5);

  const submitted = await post(orgToken(), '/api/reviews', { promptId: carrier[0].id, rating: 2, comment: 'Late.' });
  assert.equal(submitted.statusCode, 201);

  // Only the carrier has reviewed action B: its rating stays hidden (pending),
  // and the aggregate does not move.
  const hidden = (await get(orgToken(), `/api/reviews/summary/customer/${CUSTOMER_ID}`)).json().summary;
  assert.equal(hidden.count, 1);
  assert.equal(hidden.pending, 1);
  assert.equal(hidden.average, 5);

  // After the disclosure window the same review is revealed (the counterpart
  // stayed silent), so a one-sided rating can never disappear — nor retaliate.
  const late = await summarizeSubject(prisma, {
    subjectType: 'customer',
    subjectId: CUSTOMER_ID,
    now: new Date(new Date(submitted.json().review.discloseAt).getTime() + 1000),
  });
  assert.equal(late.count, 2);
  assert.equal(late.pending, 0);
  assert.equal(late.average, 3.5);
});

test('invalid submissions and unknown subjects are refused', async (t) => {
  if (!dbReachable) return t.diagnostic('database not reachable here — assertions skipped');

  const badRating = await post(orgToken(), '/api/reviews', { promptId: 'nope', rating: 9 });
  assert.equal(badRating.statusCode, 400);
  assert.equal(badRating.json().error, 'invalid_input');
  assert.match(badRating.json().detail, /rating/);

  const unknownPrompt = await post(orgToken(), '/api/reviews', { promptId: 'nope', rating: 4 });
  assert.equal(unknownPrompt.statusCode, 404);
  assert.deepEqual(unknownPrompt.json(), { error: 'prompt_not_found' });

  const badSubject = await get(orgToken(), '/api/reviews/summary/person/x');
  assert.equal(badSubject.statusCode, 400);
  assert.deepEqual(badSubject.json(), { error: 'invalid_subject' });
});
