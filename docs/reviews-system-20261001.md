# Two-sided review / feedback — design note (board task #98)

Owner decision (eila/tasks#73 q3, Matrix @ugur 2026-10-01): *"there should be also
feedback system works randomly, 1 review per 10 actions, find working strategies
to satisfy both sides."*

This note is the "working strategy that satisfies both sides". It describes what
shipped in the PR for board task #98; the rules are implemented once in
`apps/api/src/reviews.js` and unit-tested with the Node.js native runner.

## The problem with a plain review system

A rating shown immediately after a one-sided review invites retaliation: the
first side to rate can punish the second, who then rates defensively. And asking
after *every* delivery is noise — participants stop answering. So the design has
two independent constraints: ask rarely, and never reveal a one-sided rating.

## The strategy

### 1. Ask rarely — a hard cap plus a random draw

- The unit of an "action" is one **completed delivery**: a trip that reaches
  `DELIVERED`. The transition hook in `routes/trips.ts` calls
  `recordCompletedAction`, best-effort, so a sampling failure can never break a
  delivery.
- Each participant (a `Customer` or a carrier `Org`) has a counter in
  `ReviewSampling`. Every completed action increments it.
- A prompt is only **eligible** once more than `REVIEW_MIN_ACTIONS` (10) actions
  have happened since the last prompt, and is then drawn at
  `REVIEW_SAMPLE_PROBABILITY` (0.25). So a participant is asked at most once per
  10+ actions — the 10th action may not prompt, the 11th may — and not on every
  eligible action. The cap and the draw are pure functions
  (`sampleDecision`), with the RNG injected so both branches are provable.

Why a draw on top of the cap rather than "every 10th": a fixed cadence lets a
party predict the review and game it; a random pick inside an eligible window
keeps the cap while removing the pattern.

### 2. Both sides, in both directions

One completed action can produce two prompts:

| rater | subject | where it is answered |
| --- | --- | --- |
| the customer | the carrier `Org` | customer portal **Reviews** (`/c/`) |
| the carrier `Org` | the `Customer` | Fleet Manager **Reviews** (`/app/reviews`) |

The customer side is only asked when a portal login exists to answer it (an
unregistered customer has no review surface). Ratings aggregate onto the
counterpart's profile (the *subject*) and are read-only.

### 3. Abuse controls

- **One review per participant per action.** A unique key on
  `(actionType, actionId, raterType, raterId)` plus a create-only write path
  (there is no update route) makes a review immutable; a second submit answers
  `409 already_reviewed`.
- **No self-review.** The rater/subject identities can never be equal.
- **No retaliation.** A review is hidden until **both** sides have reviewed the
  same action, or `REVIEW_DISCLOSE_DAYS` (14) have passed. The aggregate counts
  only revealed reviews and reports the hidden ones as `pending`, so the system
  never pretends a rating does not exist — it is simply not shown yet. A
  one-sided review can neither punish nor be used as leverage; if the counterpart
  stays silent, it counts when the window lapses.

### 4. Read model

`GET /api/reviews/summary/:subjectType/:subjectId` returns
`{ subjectType, subjectId, count, average, pending }`; `average` is `null` until
at least one review is revealed. A caller is resolved to exactly one participant
from its token: a customer login (`customer:manage` + a `CustomerAccount`) acts
as its `Customer`, an org user as its `Org`. The rater identity is never taken
from the request body.

## Data model (additive)

| table | purpose |
| --- | --- |
| `ReviewPrompt` | a sampled "rate this delivery" request; unique per action + rater |
| `Review` | a submitted, immutable rating (1–5) + optional comment |
| `ReviewSampling` | the per-participant counter that enforces the cap |

Migration `20261001120000_add_reviews` creates three new tables and their
indexes only. No column, constraint or index on a pre-existing table is touched,
so the running pilot is unaffected.

## Out of scope (named, not hidden)

- The **solo driver** surface has no review view yet; the API is
  participant-generic, so adding `/s/` is a follow-up.
- Reviews on actions other than a delivery (e.g. an offer award) would need
  another `actionType`; the schema already keys on `actionType`.
- Notification/email prompting is not part of v1; the prompt appears in the
  surfaces above.

## Verification

- `node --test apps/api/src/` — the pure rules, including the cap
  (10th may not, 11th may) and the reveal rule, against a fake client.
- `pnpm --filter @roadwisefleet/api test:router` — `test/reviews.test.ts` drives
  the real routes against the real schema and proves both directions, the
  immutable second submit, the foreign-prompt refusal and the pending/revealed
  aggregate.
