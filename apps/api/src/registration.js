/**
 * Self-service registration — the server-side half of board task #86.
 *
 * The validation rules a signup must pass live in `app/lib/signup.js`, shared
 * with the browser (one rule set, so the client can never be more permissive
 * than the server). This module holds what is server-only and must not drift:
 *
 *   - the role a new fleet owner gets and its capability list (mirrored from
 *     `scripts/seed-pilot.ts`, re-asserted idempotently at signup exactly like
 *     the customer portal does for its role — the deploy path only ever runs
 *     `prisma migrate deploy`, and a missing role row must not 500 a signup);
 *   - the company name a new `Org` gets when the form leaves it empty.
 *
 * Pure ESM + JSDoc types: unit-testable with `node --test`, no install, no DB.
 */

/** The role of the person who registers a fleet. Mirrors the seeded role. */
export const OWNER_ROLE = 'owner';

/**
 * The owner capability list, byte-for-byte the seeded one in
 * `apps/api/scripts/seed-pilot.ts` and documented in `auth/permissions.js`. A
 * new owner must be able to reach the dashboard (`reports:read`) and dispatch
 * (`trip:*`) — the register → login → dashboard acceptance depends on it.
 */
export const OWNER_PERMISSIONS = Object.freeze([
  'org:manage',
  'user:manage',
  'trip:*',
  'invoice:*',
  'settlement:*',
  'reports:read',
]);

/** The audit action recorded for a registration (see `routes/auth.ts`). */
export const REGISTER_AUDIT_ACTION = 'auth.register';

/**
 * The name of the `Org` created for a new fleet owner: the company when given,
 * otherwise "<owner>'s fleet", so a fleet is never nameless in the UI.
 * @param {{ name?: unknown, company?: unknown }} [input]
 * @returns {string}
 */
export function defaultOrgName(input = {}) {
  const company = typeof input.company === 'string' ? input.company.trim() : '';
  if (company) return company;
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  return name ? `${name}'s fleet` : 'New fleet';
}
