/**
 * Trip read visibility (board task #68, UG#38 read isolation).
 *
 * Every seeded role that can reach the trips API holds `trip:read`, but only
 * the owner and dispatcher roles hold `trip:*` — the org-wide capability.
 * Drivers hold `trip:read`/`trip:status` and must therefore see **only their
 * own trips**: `listOrgTrips` and `getTripDetail` are org-scoped, so without
 * this rule a driver token listed every trip in the org and read any other
 * driver's trip (customer and driver email included). Writes were already
 * correctly refused; reads were not.
 *
 * The rule mirrors `canTransitionTrip` in `auth/permissions.js`: a role with
 * `trip:*` acts org-wide; everyone else is scoped to the trip they are assigned
 * to. Reads disagree in one deliberate way: a non-assigned trip is reported as
 * **not found (404)**, never `forbidden (403)`, so the scoped reader cannot
 * probe the org for the existence of a trip it may not see. That is the same
 * rule the org boundary already uses ("a trip in another org is a 404, never a
 * 403 leak").
 *
 * Pure and dependency-free (only the permission matcher), so it is unit-testable
 * with the Node.js native test runner. The route layer (`routes/trips.ts`) is
 * the only caller: it turns the scope into either the org-wide query or the
 * driver-narrowed one and never sees an unscoped read path.
 */

import { hasPermission } from './auth/permissions.js';

/** The capability that grants org-wide trip visibility (owner/dispatcher). */
export const ORG_WIDE_TRIP_PERMISSION = 'trip:*';

/**
 * Does this role see every trip in its org? Only `trip:*` does; a driver
 * (`trip:read`, `trip:status`, ...) does not.
 * @param {unknown} granted
 * @returns {boolean}
 */
export function isOrgWideTripReader(granted) {
  return hasPermission(granted, ORG_WIDE_TRIP_PERMISSION);
}

/**
 * May this caller read this trip? Org-wide readers may read any trip in their
 * org; everyone else may read only the trip assigned to them. Denies by default
 * (missing permission, missing user, missing driver).
 * @param {{ granted?: unknown, userId?: string | null, tripDriverId?: string | null }} args
 * @returns {boolean}
 */
export function canReadTrip({ granted, userId, tripDriverId } = {}) {
  if (isOrgWideTripReader(granted)) return true;
  if (hasPermission(granted, 'trip:read') === false) return false;
  return typeof userId === 'string' && userId.length > 0 && userId === tripDriverId;
}

/**
 * The read scope the route must apply for this caller.
 *
 * `orgWide: true` — the caller sees the whole org (owner/dispatcher), unchanged.
 * `orgWide: false` with a `driverId` — the caller is a scoped reader and the
 * query MUST be narrowed to that driver id.
 * `orgWide: false` with `driverId: null` — the caller has no usable identity to
 * scope by, so there is nothing it may see; the route refuses it rather than
 * falling back to an unscoped query.
 * @param {{ granted?: unknown, userId?: string | null }} args
 * @returns {{ orgWide: boolean, driverId: string | null }}
 */
export function tripReadScope({ granted, userId } = {}) {
  if (isOrgWideTripReader(granted)) return { orgWide: true, driverId: null };
  const id = typeof userId === 'string' && userId.length > 0 ? userId : null;
  return { orgWide: false, driverId: id };
}
