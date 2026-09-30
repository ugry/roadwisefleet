/**
 * Demo reset — pure planning for the pilot demo dataset.
 *
 * The pilot seed (`scripts/seed-pilot.ts`) owns exactly two trips for the
 * pilot org. QA/acceptance runs create extra trips, and the public demo then
 * shows a stale, growing list (GitHub issue #12). The DB writes live in the
 * seed script (`--reset`); the decision logic lives here so it is
 * dependency-free and runs on the Node native test runner.
 *
 * No Prisma, no I/O — pure functions only.
 */

/** Pilot org id — mirrors `scripts/seed-pilot.ts`. */
export const PILOT_ORG_ID = 'pilot-org';

/** Trip ids the seed owns; these must survive a reset. */
export const PILOT_TRIP_IDS = Object.freeze(['pilot-trip-1', 'pilot-trip-2']);

/**
 * @typedef {{ id?: unknown }} TripIdLike
 * @typedef {{ keep: string[], remove: string[] }} DemoResetPlan
 */

/**
 * Split the pilot org's trips into seed-owned ("keep") and residual ("remove").
 *
 * Pure and deterministic: output order follows input order, and a repeated id
 * is reported once. Entries without a usable non-empty string id are ignored —
 * a reset must never delete a row it cannot identify.
 *
 * @param {readonly TripIdLike[]} trips
 * @param {readonly string[]} [keepIds]
 * @returns {DemoResetPlan}
 */
export function planDemoReset(trips, keepIds = PILOT_TRIP_IDS) {
  const keepSet = new Set(keepIds);
  const seen = new Set();
  const keep = [];
  const remove = [];

  for (const trip of trips ?? []) {
    const id = trip && typeof trip.id === 'string' ? trip.id : '';
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    if (keepSet.has(id)) keep.push(id);
    else remove.push(id);
  }

  return { keep, remove };
}
