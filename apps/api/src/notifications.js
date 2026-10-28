/**
 * Customer notification emitter — the app-side half of UXF-O2 (board #135).
 *
 * The transport (`infra/notifications.md`, board #79) owns the safe DELIVERY of
 * an event: it renders a template, honours the recipient's preferences, retries
 * once and logs a redacted outcome. This module owns only WHAT happened: it
 * renders one **envelope** per lifecycle change into a spool directory, exactly
 * as `infra/notifications.md` §3.1 defines it:
 *
 *   event=delivered
 *   channel=email
 *   recipient=customer@example.com
 *   customer_name=Ada
 *   trip_ref=RWF-1042
 *   link=https://roadwisefleet.com/track/…
 *
 * Deliberately **provider-independent and safe by default**:
 *
 *   * `RWF_NOTIFY_SPOOL` unset ⇒ `emitEvent` is a no-op (`skipped: 'no_spool'`)
 *     — nothing on the pilot changes until ops installs the spool (§4).
 *   * No sender, no provider, no network: this module never sends anything and
 *     never invents an address. The transport does, once the owner answers #29
 *     (email sender/domain) and #24 (WhatsApp/SMS provider).
 *   * A channel the customer switched off in `Customer.profile.notifyPrefs`
 *     produces **no envelope at all** — the suppression is at emit time, not a
 *     send-time filter (§3.3).
 *   * An unknown event, a missing/empty template variable or an unusable
 *     recipient refuses that event and never writes a half-file or a
 *     `{{placeholder}}` (§3.1, exit 5 at delivery time).
 *
 * `{{link}}` is the capability token the customer already has: the trip's
 * tracking link (`track-link.js`) or a guest document/invoice share
 * (`guest-share.js`) — this module adds no token scheme of its own.
 *
 * Pure and dependency-free apart from Node builtins and the existing pure
 * modules, so the whole contract is covered by `node --test apps/api/src/`
 * with no install. The Prisma-backed wiring lives in `notification-hooks.ts`;
 * the route layer only calls those hooks.
 */

import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, openSync, renameSync, unlinkSync, writeSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { normalizeNotifyPrefs } from '../../../customer/lib/customer-core.js';
import { mintDocumentLink } from './guest-share.js';
import { publicGuestUrl, publicTrackUrl, reconstructTrackLink } from './track-link.js';

/* --------------------------------------------------------------- catalogue --- */

/**
 * The eight lifecycle events of UXF-O2, in lifecycle order. This is the same
 * list the transport asserts against (`EVENTS` in
 * `infra/scripts/pilot-notify-deliver.sh`); a new event needs a template on
 * both sides, and the CI catalogue check fails if either side drifts.
 * @type {readonly string[]}
 */
export const NOTIFY_EVENTS = Object.freeze([
  'offer_received',
  'awarded',
  'driver_assigned',
  'at_pickup',
  'in_transit',
  'delivered',
  'pod_ready',
  'invoice_issued',
]);

/** Channels the transport can deliver on (`infra/notifications.md` §3.2). */
export const NOTIFY_CHANNELS = Object.freeze(['email', 'whatsapp', 'sms']);

/**
 * The variables each template needs, from `infra/notifications.md` §2. The
 * envelope carries exactly `event`, `channel`, `recipient` plus these keys — no
 * more (a variable the template never reads is noise in a capability-bearing
 * file) and no fewer (an unresolved placeholder fails delivery).
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const EVENT_VARIABLES = Object.freeze({
  offer_received: Object.freeze(['customer_name', 'trip_ref', 'pickup', 'delivery']),
  awarded: Object.freeze(['customer_name', 'trip_ref', 'carrier_name', 'price']),
  driver_assigned: Object.freeze(['customer_name', 'trip_ref', 'driver_name', 'vehicle']),
  at_pickup: Object.freeze(['customer_name', 'trip_ref', 'pickup']),
  in_transit: Object.freeze(['customer_name', 'trip_ref', 'pickup', 'delivery', 'eta']),
  delivered: Object.freeze(['customer_name', 'trip_ref', 'delivery', 'link']),
  pod_ready: Object.freeze(['customer_name', 'trip_ref', 'link']),
  invoice_issued: Object.freeze(['customer_name', 'trip_ref', 'invoice_ref', 'amount', 'link']),
});

/** The envelope keys the transport itself reads (§3.1). */
export const ENVELOPE_KEYS = Object.freeze(['event', 'channel', 'recipient']);

/** Spool files are owner-only: they can carry a capability link (§2). */
export const ENVELOPE_FILE_MODE = 0o600;

/** Spool directory mode when the emitter has to create it. */
export const SPOOL_DIR_MODE = 0o750;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const E164_RE = /^\+[1-9]\d{6,14}$/;

/* ------------------------------------------------------------- primitives --- */

/** @param {unknown} value @returns {string} */
function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Coerce a Prisma `Decimal | number | string | null` to a finite number (or
 * null). Prisma serialises Decimal as an object with `toNumber()`.
 * @param {unknown} value
 * @returns {number|null}
 */
function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof value === 'object' && typeof (/** @type {any} */ (value).toNumber) === 'function') {
    const n = /** @type {any} */ (value).toNumber();
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Coerce a `Date | string | number | null` to a Date (or null).
 * @param {unknown} value
 * @returns {Date|null}
 */
function toDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(/** @type {any} */ (value));
  return Number.isNaN(date.getTime()) ? null : date;
}

/* --------------------------------------------------------------- redaction --- */

/**
 * The loggable form of a recipient, per §3.4: `customer@example.com` →
 * `c***@example.com`, `+15551234567` → `***4567`. The full contact and the
 * message body (which can carry a capability link) never reach a log line.
 * @param {unknown} contact
 * @returns {string}
 */
export function redactRecipient(contact) {
  const value = text(contact);
  if (!value) return '***';
  if (value.includes('@')) {
    const [local, domain] = value.split('@');
    return `${local.slice(0, 1)}***@${domain}`;
  }
  if (value.length >= 4) return `***${value.slice(-4)}`;
  return '***';
}

/**
 * One emitter log line: the event, the redacted recipient and the result —
 * never a variable, a link or a transport setting.
 * @param {{ event?: unknown, result?: unknown, recipient?: unknown }} args
 * @returns {string}
 */
export function logLine({ event, result, recipient }) {
  const name = text(event) || 'unknown';
  const outcome = text(result) || 'unknown';
  return `event=${name} to=${redactRecipient(recipient)} result=${outcome}`;
}

/* ------------------------------------------------------------- preferences --- */

/**
 * Normalize a customer's `notifyPrefs` with the portal's rule (the SAME helper
 * the account screen writes with): missing ⇒ email on, other channels off.
 * @param {unknown} prefs
 * @returns {Record<string, boolean>}
 */
export function normalizePrefs(prefs) {
  return normalizeNotifyPrefs(prefs);
}

/**
 * Is this channel switched on for the customer? A channel that is off may not
 * produce an envelope, whatever the transport would do later.
 * @param {unknown} prefs
 * @param {unknown} channel
 * @returns {boolean}
 */
export function channelEnabled(prefs, channel) {
  if (typeof channel !== 'string' || !NOTIFY_CHANNELS.includes(channel)) return false;
  return normalizePrefs(prefs)[channel] === true;
}

/**
 * Pick the one channel this customer should be notified on: the first switched-on
 * channel that actually has a usable contact. Returns null when every enabled
 * channel has no address — nothing is written (there is no recipient to write).
 *
 * Order is email → whatsapp → sms: email is the portal default and the only
 * channel the owner has approved a sender for (#29); the others stay inert until
 * their provider is decided (#24).
 * @param {{ prefs?: unknown, email?: unknown, whatsapp?: unknown, sms?: unknown }} args
 * @returns {'email'|'whatsapp'|'sms'|null}
 */
export function chooseChannel({ prefs, email, whatsapp, sms } = {}) {
  const normalized = normalizePrefs(prefs);
  if (normalized.email && isRecipient('email', email)) return 'email';
  if (normalized.whatsapp && isRecipient('whatsapp', whatsapp)) return 'whatsapp';
  if (normalized.sms && isRecipient('sms', sms)) return 'sms';
  return null;
}

/**
 * Can the transport address this contact on this channel? A malformed or absent
 * recipient is a refusal, never a guessed address.
 * @param {unknown} channel
 * @param {unknown} recipient
 * @returns {boolean}
 */
export function isRecipient(channel, recipient) {
  const value = text(recipient);
  if (!value) return false;
  if (channel === 'email') return EMAIL_RE.test(value);
  if (channel === 'whatsapp' || channel === 'sms') return E164_RE.test(value);
  return false;
}

/* ------------------------------------------------------------- assignment --- */

/**
 * Does this assignment actually change the driver? A re-assign that names the
 * driver the trip already has — and a "clear the driver" on a trip that has
 * none — is a no-op: nothing changed, so nothing is announced.
 *
 * This is the pure rule behind the `driver_assigned` hook (board #136): the
 * route already refuses a same-driver assign (`already_assigned`), but the
 * emitter must not depend on that refusal staying, because a retried assign
 * must never queue a second envelope for an unchanged state. `null` and
 * `undefined` both mean "no driver", so they compare equal.
 * @param {unknown} previousDriverId
 * @param {unknown} driverId
 * @returns {boolean}
 */
export function isAssignmentChange(previousDriverId, driverId) {
  return (previousDriverId ?? null) !== (driverId ?? null);
}

/* -------------------------------------------------------------- references --- */

/**
 * A stable human-readable reference for a shipment. The schema has no human
 * `ref` column, so it is derived from the order (the demand both the load and
 * the trip carry) or, failing that, the trip/load id. Deriving it from the
 * ORDER keeps the reference identical from `offer_received` through
 * `invoice_issued`, so a customer never sees the shipment renamed mid-flight.
 * @param {{ orderId?: unknown, tripId?: unknown, loadId?: unknown }} args
 * @returns {string}
 */
export function tripRef({ orderId, tripId, loadId } = {}) {
  const seed = text(orderId) || text(tripId) || text(loadId);
  if (!seed) return '';
  const compact = seed.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  // Strip the model-word prefix so `order_1042` reads `RWF-1042` (the shape the
  // contract example uses) while a bare cuid stays a short suffix.
  const bare = compact.replace(/^(?:ORDER|ORD|TRIP|LOAD)+/, '') || compact;
  return `RWF-${bare.slice(-8)}`;
}

/**
 * A stable invoice reference for a document row (the pilot stores invoices as
 * `Document` rows with `docType = 'invoice'`, and the model has no ref column).
 * @param {{ id?: unknown }} [document]
 * @returns {string}
 */
export function invoiceRefFor(document) {
  const id = text(document?.id).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return id ? `INV-${id.slice(-8)}` : '';
}

/**
 * Format a money amount the way the templates read it (`1200.00 EUR`). A null or
 * unusable amount is empty, so the envelope is refused rather than sent as
 * "undefined".
 * @param {unknown} value
 * @returns {string}
 */
export function formatMoney(value) {
  const n = toNumber(value);
  return n === null ? '' : `${n.toFixed(2)} EUR`;
}

/**
 * Format an instant for the `eta` variable (`2026-10-27 14:30 UTC`). Missing or
 * invalid ⇒ empty (refusal upstream), never a fabricated estimate.
 * @param {unknown} value
 * @returns {string}
 */
export function formatEta(value) {
  const date = toDate(value);
  if (!date) return '';
  const iso = date.toISOString(); // 2026-10-27T14:30:00.000Z
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/* ------------------------------------------------------------------- links --- */

/**
 * The customer's existing trip tracking link, recomputed from the mint
 * parameters persisted on the trip (deterministic HMAC — no new token scheme).
 * Null when the trip has no live link, which refuses the event.
 * @param {any} trip
 * @param {{ authSecret?: unknown, secret?: unknown, baseUrl?: unknown, now?: number }} [opts]
 * @returns {string|null}
 */
export function tripLinkFor(trip, { authSecret, secret, baseUrl, now } = {}) {
  const link = reconstructTrackLink(trip, { authSecret, secret, now });
  return link ? publicTrackUrl(baseUrl, link.token) : null;
}

/**
 * The customer's existing guest document / invoice share link
 * (`guest-share.js`), bound to the same trip share window. Null when the trip
 * has no live share window, which refuses the event rather than sending a link
 * that cannot work.
 * @param {any} trip
 * @param {any} document
 * @param {{ scope?: string, authSecret?: unknown, secret?: unknown, baseUrl?: unknown, now?: number }} [opts]
 * @returns {string|null}
 */
export function documentLinkFor(trip, document, { scope = 'document', authSecret, secret, baseUrl, now } = {}) {
  const atMs = typeof now === 'number' ? now : Date.now();
  const minted = mintDocumentLink(trip, document, {
    scope,
    authSecret,
    secret,
    now: Math.floor(atMs / 1000),
  });
  return minted ? publicGuestUrl(baseUrl, scope, minted.token) : null;
}

/* -------------------------------------------------------------------- vars --- */

/**
 * The template variables for one lifecycle event, from the context the route
 * already holds (or the hook loaded). Every value is a trimmed single-line
 * string; an absent or empty value makes the call fail with `missing_variable`,
 * which is what stops a half-rendered message reaching the transport.
 *
 * Context fields (all optional; the builder reads only what its event needs):
 *   customer  `{ name }`
 *   order     `{ origin, destination, plannedAt, customerId }`
 *   load      `{ origin, destination, orderId }`
 *   trip      `{ id, orderId, rateEur, order? }`
 *   offer     `{ carrierName, priceEur }`
 *   driver    `{ name }`            (or `trip.driver`)
 *   truck     `{ plate }`           (or `trip.truck`)
 *   document  `{ id }`              (invoice row)
 *   invoice   `{ ref, amountEur }`
 *   link      the capability URL, already resolved by the caller
 *   ref       an explicit trip reference (defaults to `tripRef(...)`)
 *
 * @param {any} ctx
 * @returns {{ ok: true, vars: Record<string, string> } | { ok: false, error: 'unknown_event'|'missing_variable', missing?: string[] }}
 */
export function lifecycleVars(ctx = {}) {
  const event = text(ctx.event);
  if (!NOTIFY_EVENTS.includes(event)) return { ok: false, error: 'unknown_event' };

  const trip = ctx.trip ?? null;
  const order = ctx.order ?? trip?.order ?? null;
  const load = ctx.load ?? null;
  const customer = ctx.customer ?? null;
  const driver = ctx.driver ?? trip?.driver ?? null;
  const truck = ctx.truck ?? trip?.truck ?? null;
  const ref = text(ctx.ref) || tripRef({ orderId: order?.orderId ?? order?.id ?? load?.orderId ?? trip?.orderId, tripId: trip?.id, loadId: load?.id });

  /** @type {Record<string, string>} */
  const vars = {
    customer_name: text(customer?.name),
    trip_ref: ref,
    pickup: text(order?.origin ?? load?.origin),
    delivery: text(order?.destination ?? load?.destination),
    carrier_name: text(ctx.offer?.carrierName),
    price: formatMoney(ctx.offer?.priceEur),
    driver_name: text(driver?.name),
    vehicle: text(truck?.plate),
    eta: formatEta(order?.plannedAt),
    link: text(ctx.link),
    invoice_ref: text(ctx.invoice?.ref) || invoiceRefFor(ctx.document),
    amount: formatMoney(ctx.invoice?.amountEur ?? trip?.rateEur),
  };

  // Only the catalogue's variables for THIS event: an extra key is not written
  // (the template never reads it) and a missing one refuses the event.
  /** @type {Record<string, string>} */
  const out = {};
  const missing = [];
  for (const key of EVENT_VARIABLES[event]) {
    const value = vars[key];
    if (!value) {
      missing.push(key);
      continue;
    }
    out[key] = value;
  }
  if (missing.length > 0) return { ok: false, error: 'missing_variable', missing };
  return { ok: true, vars: out };
}

/* ---------------------------------------------------------------- envelope --- */

/**
 * Render the §3.1 envelope text. The key set is exactly `event`, `channel`,
 * `recipient` and the event's catalogue variables — a value containing a newline
 * is refused, because it could forge a second key.
 * @param {unknown} event
 * @param {unknown} channel
 * @param {unknown} recipient
 * @param {Record<string, string>} [vars]
 * @returns {{ ok: true, text: string, keys: string[] } | { ok: false, error: string, missing?: string[] }}
 */
export function buildEnvelope(event, channel, recipient, vars = {}) {
  const name = text(event);
  if (!NOTIFY_EVENTS.includes(name)) return { ok: false, error: 'unknown_event' };
  if (typeof channel !== 'string' || !NOTIFY_CHANNELS.includes(channel)) {
    return { ok: false, error: 'unknown_channel' };
  }
  if (!isRecipient(channel, recipient)) return { ok: false, error: 'invalid_recipient' };

  /** @type {string[]} */
  const lines = [`event=${name}`, `channel=${channel}`, `recipient=${text(recipient)}`];
  /** @type {string[]} */
  const keys = [...ENVELOPE_KEYS];
  const missing = [];
  for (const key of EVENT_VARIABLES[name]) {
    const value = vars[key];
    if (typeof value !== 'string' || value.trim() === '') {
      missing.push(key);
      continue;
    }
    if (/[\r\n]/.test(value)) return { ok: false, error: 'invalid_variable', missing: [key] };
    lines.push(`${key}=${value.trim()}`);
    keys.push(key);
  }
  if (missing.length > 0) return { ok: false, error: 'missing_variable', missing };

  return { ok: true, text: `${lines.join('\n')}\n`, keys };
}

/* ------------------------------------------------------------------ spool --- */

/**
 * A spool file name: `<event>-<tripRef>-<timestamp>-<rand>.key`, with every
 * component reduced to `[A-Za-z0-9_-]` so a reference or an event can never
 * escape the spool directory.
 * @param {string} event
 * @param {string} ref
 * @param {Date} at
 * @param {string} rand
 * @returns {string}
 */
export function envelopeFileName(event, ref, at, rand) {
  const safeEvent = text(event).replace(/[^A-Za-z0-9_-]/g, '_') || 'event';
  const safeRef = text(ref).replace(/[^A-Za-z0-9_-]/g, '_') || 'trip';
  const stamp = at.toISOString().replace(/[-:.]/g, ''); // 20261025T101500123Z
  const safeRand = text(rand).replace(/[^A-Za-z0-9]/g, '') || '0';
  return `${safeEvent}-${safeRef}-${stamp}-${safeRand}.key`;
}

/**
 * Write one envelope ATOMICALLY: create the temp file `wx` with mode 0600, write
 * the whole text, then rename it into place. A failure unlinks the temp file, so
 * a reader never sees a partial `.key` and the spool never keeps a half-file.
 *
 * The directory is created (0750) when missing; the file mode is re-asserted
 * after creation because the process umask can only clear bits.
 * @param {string} spoolDir
 * @param {string} body
 * @param {{ now?: Date|string|number, random?: string, event?: string, ref?: string }} [opts]
 * @returns {{ ok: true, file: string } | { ok: false, error: string }}
 */
export function writeEnvelope(spoolDir, body, { now, random, event = 'event', ref = 'trip' } = {}) {
  const dir = typeof spoolDir === 'string' ? spoolDir.trim() : '';
  if (!dir) return { ok: false, error: 'no_spool' };
  const at = toDate(now) ?? new Date();
  let rand = text(random) || randomBytes(4).toString('hex');

  try {
    mkdirSync(dir, { recursive: true, mode: SPOOL_DIR_MODE });
  } catch {
    return { ok: false, error: 'spool_unavailable' };
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const name = envelopeFileName(event, ref, at, rand);
    const finalPath = join(dir, name);
    const tmpPath = join(dir, `.${name}.tmp`);
    let fd = -1;
    try {
      fd = openSync(tmpPath, 'wx', ENVELOPE_FILE_MODE);
      chmodSync(tmpPath, ENVELOPE_FILE_MODE);
      writeSync(fd, body);
      closeSync(fd);
      fd = -1;
      renameSync(tmpPath, finalPath);
      return { ok: true, file: finalPath };
    } catch (error) {
      if (fd !== -1) {
        try {
          closeSync(fd);
        } catch {
          /* already closed */
        }
      }
      try {
        unlinkSync(tmpPath);
      } catch {
        /* nothing was created */
      }
      if (/** @type {any} */ (error)?.code === 'EEXIST' && !text(random)) {
        rand = randomBytes(4).toString('hex');
        continue;
      }
      return { ok: false, error: 'spool_write_failed' };
    }
  }
  return { ok: false, error: 'spool_write_failed' };
}

/* ------------------------------------------------------------------- emit --- */

/**
 * Emit one lifecycle event. This is the whole contract in one call:
 *
 *   1. no spool configured (`RWF_NOTIFY_SPOOL` unset) ⇒ `{ ok: true, skipped:
 *      'no_spool' }`, before anything is read or written (safe by default);
 *   2. a channel the customer switched off ⇒ `{ ok: true, skipped:
 *      'suppressed' }`, and NO file (the preference is not delegated to the
 *      transport);
 *   3. unknown event / bad channel / unusable recipient / missing variable ⇒
 *      `{ ok: false, error, missing? }` and NO file, with one redacted log line;
 *   4. otherwise exactly one `*.key` file, written atomically.
 *
 * @param {{
 *   spoolDir?: unknown,
 *   event: unknown,
 *   channel: unknown,
 *   recipient: unknown,
 *   vars?: Record<string, string>,
 *   prefs?: unknown,
 *   now?: Date|string|number,
 *   random?: string,
 *   log?: (line: string) => void
 * }} args
 * @returns {{ ok: boolean, skipped?: string, file?: string, error?: string, missing?: string[] }}
 */
export function emitEvent({ spoolDir, event, channel, recipient, vars = {}, prefs, now, random, log } = /** @type {any} */ ({})) {
  const dir = text(spoolDir);
  const name = text(event);
  const logger = typeof log === 'function' ? log : null;

  if (!dir) return { ok: true, skipped: 'no_spool' };
  if (!NOTIFY_EVENTS.includes(name)) {
    logger?.(logLine({ event: name, result: 'refused_unknown_event', recipient }));
    return { ok: false, error: 'unknown_event' };
  }
  if (!channelEnabled(prefs, channel)) {
    return { ok: true, skipped: 'suppressed' };
  }

  const envelope = buildEnvelope(name, channel, recipient, vars);
  if (!envelope.ok) {
    logger?.(logLine({ event: name, result: `refused_${envelope.error}`, recipient }));
    return { ok: false, error: envelope.error, missing: envelope.missing };
  }

  const written = writeEnvelope(dir, envelope.text, { now, random, event: name, ref: vars.trip_ref });
  if (!written.ok) {
    logger?.(logLine({ event: name, result: `refused_${written.error}`, recipient }));
    return { ok: false, error: written.error };
  }
  logger?.(logLine({ event: name, result: 'queued', recipient }));
  return { ok: true, file: written.file };
}
