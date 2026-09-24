/**
 * User / driver payload discipline (board task #63, SEC).
 *
 * `GET /api/trips` listed whole `User` rows by including the driver relation
 * without a `select`, so every trip carried the driver's `passwordHash`
 * (scrypt), `totpSecret`, `failedLoginCount` and `lockedUntil`. Credential
 * material must never be serialised to a client, whatever the caller's role.
 *
 * This module is the single place that decides which `User` fields are public
 * and that enforces the rule, in two layers:
 *
 *   1. `publicUserSelect()` — a Prisma `select` used by the trip list, so the
 *      credential columns are never read out of the database in the first place;
 *   2. `stripCredentialFields()` — a route-boundary serialiser that removes the
 *      credential keys from any JSON-ish payload, so a future `include` cannot
 *      silently reintroduce the leak.
 *
 * Pure and dependency-free: covered by `node --test apps/api/src/` with no
 * install (see `user-payload.test.js`); the DB-backed response assertion lives
 * in `apps/api/test/user-payload.test.ts`.
 */

/**
 * Fields that are credential material or authentication state and must never
 * appear in an API response (board task #63).
 * @type {readonly string[]}
 */
export const CREDENTIAL_FIELDS = Object.freeze([
  'passwordHash',
  'totpSecret',
  'failedLoginCount',
  'lockedUntil',
]);

/**
 * The `User` fields a driver/user object may expose — `prisma/schema.prisma`
 * minus `CREDENTIAL_FIELDS`.
 * @type {readonly string[]}
 */
export const PUBLIC_USER_FIELDS = Object.freeze([
  'id',
  'orgId',
  'roleId',
  'name',
  'phone',
  'email',
  'lang',
  'emailVerifiedAt',
  'phoneVerifiedAt',
  'createdAt',
]);

/**
 * Prisma `select` returning exactly the public `User` fields. Use it instead of
 * `include: { driver: true }` wherever a user relation is loaded.
 * @returns {Record<string, true>}
 */
export function publicUserSelect() {
  const select = {};
  for (const field of PUBLIC_USER_FIELDS) select[field] = true;
  return select;
}

/**
 * @param {unknown} key
 * @returns {boolean}
 */
export function isCredentialField(key) {
  return typeof key === 'string' && CREDENTIAL_FIELDS.includes(key);
}

/**
 * Plain objects only: class instances (Date, Prisma Decimal, …) are never
 * cloned, so the sanitiser cannot damage a response value.
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Deep-copy a JSON-ish value without its credential fields. Class instances
 * (Date, Decimal, …) are returned unchanged and the input is never mutated.
 * @param {unknown} value
 * @returns {unknown}
 */
export function stripCredentialFields(value) {
  if (Array.isArray(value)) return value.map((item) => stripCredentialFields(item));
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value)) {
      if (isCredentialField(key)) continue;
      out[key] = stripCredentialFields(value[key]);
    }
    return out;
  }
  return value;
}

/**
 * Every credential-field key found anywhere in a JSON-ish value, as dotted
 * paths (e.g. `trips[0].driver.passwordHash`). Empty means the payload is
 * clean. Used by the tests and the source guard.
 * @param {unknown} value
 * @param {string} [prefix]
 * @returns {string[]}
 */
export function findCredentialFields(value, prefix = '') {
  const hits = [];
  if (Array.isArray(value)) {
    value.forEach((item, i) => hits.push(...findCredentialFields(item, `${prefix}[${i}]`)));
    return hits;
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (isCredentialField(key)) hits.push(path);
      hits.push(...findCredentialFields(value[key], path));
    }
  }
  return hits;
}
