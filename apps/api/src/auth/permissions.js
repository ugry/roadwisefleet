/**
 * Role-based access control (RBAC) — capability checks against the seeded
 * `Role.permissions` list, plus the one helper the trip routes use to resolve
 * a token's `roleId` into capabilities.
 *
 * Permissions are `resource:action` strings. The seeded roles are:
 *   owner       org:manage user:manage trip:* invoice:* settlement:* reports:read
 *   dispatcher  trip:* user:read reports:read
 *   accountant  invoice:* settlement:* reports:read
 *   driver      trip:read trip:status pod:upload expense:create
 *
 * `resource:*` grants every action on that resource, and the global `*` grants
 * everything. Nothing here touches the transport layer, so it is unit-testable
 * with the Node.js native test runner (no install, no build step).
 */

/**
 * @param {unknown} granted
 * @param {string} required e.g. `trip:create`
 * @returns {boolean}
 */
export function hasPermission(granted, required) {
  if (!Array.isArray(granted) || typeof required !== 'string' || required.length === 0) {
    return false;
  }
  const resource = required.split(':')[0];
  return granted.some((p) => p === required || p === `${resource}:*` || p === '*');
}

/**
 * Creating a trip requires `trip:create` (or `trip:*`). A driver has neither.
 * @param {unknown} granted
 * @returns {boolean}
 */
export function canCreateTrip(granted) {
  return hasPermission(granted, 'trip:create');
}

/**
 * Changing a trip's status requires `trip:status` (or `trip:*`) **and** an
 * ownership rule: a role with `trip:*` (owner/dispatcher) may transition any
 * trip in its org, while everyone else (drivers) may transition only a trip
 * assigned to them. Denies by default.
 * @param {{ granted?: unknown, userId?: string | null, tripDriverId?: string | null }} args
 * @returns {boolean}
 */
export function canTransitionTrip({ granted, userId, tripDriverId } = {}) {
  if (hasPermission(granted, 'trip:*')) return true;
  if (!hasPermission(granted, 'trip:status')) return false;
  return typeof userId === 'string' && userId.length > 0 && userId === tripDriverId;
}

/**
 * Resolve the capabilities of a token's role from the database. A missing role
 * (or missing `permissions`) resolves to `[]` — deny, never throw.
 * @param {{ role: { findUnique: (args: { where: { id: string } }) => Promise<any> } }} prisma
 * @param {string | null | undefined} roleId
 * @returns {Promise<string[]>}
 */
export async function loadRolePermissions(prisma, roleId) {
  if (!roleId) return [];
  const role = await prisma.role.findUnique({ where: { id: roleId } });
  return Array.isArray(role?.permissions) ? role.permissions : [];
}
