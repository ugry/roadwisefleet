/**
 * Account deletion (board task #142, AND1-A3 — Play release blocker).
 *
 * Google Play requires an app that lets people create accounts to offer BOTH
 *
 *   1. an in-app deletion path, and
 *   2. a web deletion-request URL reachable without the app,
 *
 * and the Data Safety form cannot answer "you can request that data be
 * deleted" until the mechanism exists (`infra/play-data-safety.md` §5 B-P2).
 *
 * WHAT THIS DOES — ANONYMISE, NEVER DELETE BUSINESS RECORDS
 *
 *   - The `User` row is tombstoned in place: name, e-mail, phone, password
 *     hash, TOTP secret, verification timestamps and lockout counters are
 *     scrubbed and `deletedAt` is stamped. The row itself stays because trip
 *     drivers, status events and documents reference it.
 *   - The address is replaced by a reserved-domain tombstone
 *     (`deleted+<userId>@deleted.invalid`) so it is no longer personal data and
 *     the person may register the same address again (the column is unique).
 *   - Every `DeviceCredential` is revoked and its outstanding single-use
 *     challenges are removed, so a lost/old phone can never sign in again.
 *   - The `CustomerAccount` link is deleted (the schema puts that FK on the
 *     link table) and the solo profile's identifying fields are scrubbed.
 *   - Trips, documents and delivery evidence, invoices, reviews and
 *     marketplace records are NOT touched, and no retention period is invented:
 *     what has to outlive the account is the owner + legal decision on #13/#46.
 *     The response therefore STATES what remains and why (`retentionNotice()`),
 *     which is exactly what the Play flow has to show.
 *
 * Pure ESM + JSDoc types, dependency-free: unit-tested by
 * `node --test apps/api/src/` with no install (`account-deletion.test.js`). The
 * DB-backed assertions live in `apps/api/test/account-deletion.test.ts`.
 */

/**
 * The name every tombstoned account carries. Deliberately not a placeholder
 * that could be mistaken for a real person's name.
 * @type {string}
 */
export const TOMBSTONE_NAME = 'Deleted account';

/**
 * RFC 2606 reserved TLD: `.invalid` can never resolve, so a tombstone address
 * can never receive mail even if something still tries to send to it.
 * @type {string}
 */
export const TOMBSTONE_EMAIL_DOMAIN = 'deleted.invalid';

/**
 * `User` columns that carry personal data or credential material and are
 * cleared on deletion. Exported so a test can pin the set (a new PII column
 * must fail a test, not silently survive).
 * @type {readonly string[]}
 */
export const SCRUBBED_USER_FIELDS = Object.freeze([
  'name',
  'email',
  'phone',
  'passwordHash',
  'totpSecret',
  'emailVerifiedAt',
  'phoneVerifiedAt',
  'failedLoginCount',
  'lockedUntil',
]);

/**
 * `SoloDriverProfile` columns that identify the person or their vehicle. The
 * row stays (documents/trips point at the tenant); only these are cleared.
 * @type {readonly string[]}
 */
export const SCRUBBED_SOLO_FIELDS = Object.freeze([
  'phone',
  'phoneVerifiedAt',
  'otpHash',
  'otpExpiresAt',
  'otpAttempts',
  'truckPlate',
]);

/**
 * What survives an account deletion, in the words the in-app flow and the web
 * page show. `type` is a stable key; `description` is user-facing English (the
 * clients localise their own copy — see `account.delete.retains.*`).
 * @returns {readonly { type: string, description: string }[]}
 */
export function retainedRecords() {
  return Object.freeze([
    Object.freeze({
      type: 'trips',
      description: 'Trip records (routes, stops, status history, rates) are kept as the carrier’s operational and accounting record.',
    }),
    Object.freeze({
      type: 'documents',
      description: 'Delivery evidence — proof of delivery, eCMR, invoice scans and photos — is kept because it documents work already performed.',
    }),
    Object.freeze({
      type: 'reviews',
      description: 'Ratings and reviews already given or received are kept; they are shown against the carrier, not against your name.',
    }),
  ]);
}

/**
 * The machine-readable half of the deletion response: what was anonymised and
 * what remains. `retentionPolicy: 'owner_decision_pending'` is deliberate — the
 * retention period is an open owner + legal decision (#13, #46); this code must
 * not guess one.
 * @param {{ anonymizedAt?: string }} [opts]
 * @returns {{ anonymized: true, anonymizedAt: string | null, retained: { type: string, description: string }[], retentionPolicy: string, messageKey: string }}
 */
export function retentionNotice(opts = {}) {
  return {
    anonymized: true,
    anonymizedAt: opts.anonymizedAt ?? null,
    retained: retainedRecords().map((entry) => ({ type: entry.type, description: entry.description })),
    retentionPolicy: 'owner_decision_pending',
    messageKey: 'account.delete.done',
  };
}

/**
 * The tombstone address for a user id. Deterministic (so a retried deletion
 * produces the same value) and unique per user (`User.email` is `@unique`).
 * @param {unknown} userId
 * @returns {string}
 */
export function tombstoneEmail(userId) {
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new TypeError('userId is required');
  }
  return `deleted+${userId}@${TOMBSTONE_EMAIL_DOMAIN}`;
}

/**
 * Whether a user row is already deleted. Accepts either the stamped column or
 * (for a row read with a partial `select`) a tombstone address with no
 * password, so a second `DELETE /api/account` is a clean no-op even if the
 * `deletedAt` column was not selected.
 * @param {{ deletedAt?: unknown, email?: unknown, passwordHash?: unknown } | null | undefined} user
 * @returns {boolean}
 */
export function isDeletedAccount(user) {
  if (!user || typeof user !== 'object') return false;
  if (user.deletedAt != null) return true;
  return (
    typeof user.email === 'string' &&
    user.email.startsWith('deleted+') &&
    user.email.endsWith(`@${TOMBSTONE_EMAIL_DOMAIN}`) &&
    (user.passwordHash == null || user.passwordHash === '')
  );
}

/**
 * Build the whole write plan for one account deletion. Pure: the route executes
 * it inside one transaction, so the rules are testable without a database.
 *
 * Already-deleted accounts return `alreadyDeleted: true` and NO writes — the
 * endpoint stays idempotent.
 * @param {{ id: string, email?: string | null, deletedAt?: unknown, customerAccount?: unknown, soloProfile?: unknown }} user
 * @param {{ now?: Date }} [opts]
 * @returns {{
 *   alreadyDeleted: boolean,
 *   userId: string,
 *   anonymizedAt: Date | null,
 *   userUpdate: Record<string, unknown> | null,
 *   deleteCustomerAccount: boolean,
 *   scrubSoloProfile: boolean,
 *   clearEmailCodes: boolean,
 *   revokeDeviceCredentials: boolean,
 * }}
 */
export function planAccountDeletion(user, opts = {}) {
  if (!user || typeof user.id !== 'string' || user.id.length === 0) {
    throw new TypeError('user.id is required');
  }
  if (isDeletedAccount(user)) {
    return {
      alreadyDeleted: true,
      userId: user.id,
      anonymizedAt: null,
      userUpdate: null,
      deleteCustomerAccount: false,
      scrubSoloProfile: false,
      clearEmailCodes: false,
      revokeDeviceCredentials: false,
    };
  }

  const now = opts.now ?? new Date();
  const previousEmail = typeof user.email === 'string' && user.email.length > 0 ? user.email : null;

  return {
    alreadyDeleted: false,
    userId: user.id,
    anonymizedAt: now,
    userUpdate: {
      name: TOMBSTONE_NAME,
      email: tombstoneEmail(user.id),
      phone: null,
      passwordHash: null,
      totpSecret: null,
      emailVerifiedAt: null,
      phoneVerifiedAt: null,
      // A deleted account is never locked out: there is nothing left to lock.
      failedLoginCount: 0,
      lockedUntil: null,
      deletedAt: now,
    },
    // The FK lives on `CustomerAccount`, so removing the link is a row delete.
    deleteCustomerAccount: Boolean(user.customerAccount),
    scrubSoloProfile: Boolean(user.soloProfile),
    // One-time codes are keyed by address, not by user: they must die with it.
    // The address itself stays OUT of the plan — the route already holds the
    // row it read, so the plan can stay free of personal data.
    clearEmailCodes: previousEmail !== null,
    // Always: a deletion must never leave a usable device credential behind,
    // even when this user had none (the update is then a no-op count of 0).
    revokeDeviceCredentials: true,
  };
}

/**
 * The solo-profile scrub payload (kept separate so the plan stays a plain
 * description of intent).
 * @returns {Record<string, unknown>}
 */
export function soloProfileScrub() {
  return {
    phone: null,
    phoneVerifiedAt: null,
    otpHash: null,
    otpExpiresAt: null,
    otpAttempts: 0,
    truckPlate: null,
  };
}
