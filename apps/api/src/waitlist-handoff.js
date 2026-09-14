/**
 * Waitlist → account handoff — pure parsing and planning logic.
 *
 * The waitlist microservice (`services/waitlist/server.js`) appends one JSON
 * object per line to `waitlist.jsonl`:
 *
 *   {"email":"ops@acme.test","lang":"en","source":"landing",
 *    "ip_hash":"…","created_at":"2026-09-01T10:00:00.000Z"}
 *
 * This module turns that text into validated entries and decides which leads
 * become pilot accounts. It is deliberately dependency-free ESM (typed via
 * JSDoc) so it can be unit-tested with the Node.js native test runner
 * (`node --test`) without a build step or any install. The CLI
 * (`scripts/waitlist-handoff.ts`) owns file I/O, Prisma and password printing.
 *
 * No email is ever sent by this flow.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_EMAIL_LENGTH = 254;

/**
 * @typedef {Object} WaitlistEntry
 * @property {string} email       normalised (trimmed, lower-cased)
 * @property {string | null} lang
 * @property {string | null} source
 * @property {string | null} createdAt ISO-8601 string, or null when absent/invalid
 */

/**
 * @typedef {Object} HandoffAccount
 * @property {string} email
 * @property {string} name        display name derived from the address
 * @property {string} orgName     org to create/find for this lead
 * @property {string | null} lang
 * @property {string | null} source
 * @property {string | null} createdAt
 */

/**
 * @typedef {Object} HandoffPlan
 * @property {string | null} orgName  the requested org name, if any
 * @property {HandoffAccount[]} accounts entries selected to become accounts
 * @property {string[]} skipped          requested emails with no waitlist entry
 */

/**
 * Normalise an address for comparison: trim and lower-case.
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * True when `value` looks like a deliverable address (same rule as the
 * waitlist endpoints).
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidEmail(value) {
  const email = normalizeEmail(value);
  return email.length > 0 && email.length <= MAX_EMAIL_LENGTH && EMAIL_RE.test(email);
}

/**
 * Turn an address into a human display name: `jane.doe@acme.test` →
 * `Jane Doe`. Falls back to the local part, then to the whole address.
 * @param {string} email
 * @returns {string}
 */
export function displayNameFromEmail(email) {
  const local = normalizeEmail(email).split('@')[0] || '';
  const words = local.split(/[._\-+]+/).filter(Boolean);
  if (words.length === 0) return normalizeEmail(email);
  return words
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Derive a default org name from the address domain: `ops@acme.test` →
 * `Acme.test`. Used when the caller passes no explicit `--org`.
 * @param {string} email
 * @returns {string}
 */
export function orgNameFromEmail(email) {
  const domain = normalizeEmail(email).split('@')[1] || normalizeEmail(email);
  return domain ? domain.charAt(0).toUpperCase() + domain.slice(1) : normalizeEmail(email);
}

/**
 * Parse waitlist JSONL text into validated, de-duplicated entries.
 *
 * Blank lines, malformed JSON, non-objects and invalid addresses are dropped.
 * Duplicate addresses keep the last occurrence (the newest append wins) and
 * the result is sorted by email so callers get a deterministic order.
 * @param {unknown} text
 * @returns {WaitlistEntry[]}
 */
export function parseWaitlistJsonl(text) {
  if (typeof text !== 'string' || text.length === 0) return [];

  /** @type {Map<string, WaitlistEntry>} */
  const byEmail = new Map();

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // malformed line
    }
    if (record === null || typeof record !== 'object' || Array.isArray(record)) continue;

    const email = normalizeEmail(record.email);
    if (!isValidEmail(email)) continue;

    let createdAt = null;
    if (typeof record.created_at === 'string') {
      const parsed = new Date(record.created_at);
      if (!Number.isNaN(parsed.getTime())) createdAt = parsed.toISOString();
    }

    byEmail.set(email, {
      email,
      lang: record.lang === undefined || record.lang === null ? null : String(record.lang).slice(0, 10),
      source:
        record.source === undefined || record.source === null ? null : String(record.source).slice(0, 60),
      createdAt,
    });
  }

  return [...byEmail.values()].sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0));
}

/**
 * Build a deterministic handoff plan.
 *
 * `emails` is the explicit selection (the CLI passes `--email=` values, or
 * every parsed address for `--all`); addresses are normalised, de-duplicated
 * and sorted. Only requested addresses that exist in `entries` become
 * accounts; the rest are reported in `skipped` so the operator sees typos.
 *
 * @param {WaitlistEntry[]} entries
 * @param {{ emails?: unknown, orgName?: unknown }} [options]
 * @returns {HandoffPlan}
 */
export function planHandoff(entries, options = {}) {
  const list = Array.isArray(entries) ? entries : [];

  const requested = [
    ...new Set(
      (Array.isArray(options.emails) ? options.emails : [])
        .map(normalizeEmail)
        .filter(isValidEmail),
    ),
  ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  /** @type {Map<string, WaitlistEntry>} */
  const byEmail = new Map();
  for (const entry of list) {
    if (!entry || !isValidEmail(entry.email)) continue;
    byEmail.set(normalizeEmail(entry.email), entry); // last wins
  }

  const explicitOrg =
    typeof options.orgName === 'string' && options.orgName.trim() ? options.orgName.trim() : null;

  /** @type {HandoffAccount[]} */
  const accounts = [];
  /** @type {string[]} */
  const skipped = [];

  for (const email of requested) {
    const entry = byEmail.get(email);
    if (!entry) {
      skipped.push(email);
      continue;
    }
    accounts.push({
      email,
      name: displayNameFromEmail(email),
      orgName: explicitOrg || orgNameFromEmail(email),
      lang: entry.lang ?? null,
      source: entry.source ?? null,
      createdAt: entry.createdAt ?? null,
    });
  }

  return { orgName: explicitOrg, accounts, skipped };
}
