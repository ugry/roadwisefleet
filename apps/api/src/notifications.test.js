/**
 * Notification emitter contract (board #135, UXF-O2a).
 *
 * The transport (`infra/notifications.md` §3.1, `pilot-notify-deliver.sh`) is
 * installed nowhere yet, so these tests are the proof that the app produces
 * exactly what it will parse: one envelope per lifecycle event, with the exact
 * key set of §2, preferences applied at emit time, and no file at all when the
 * spool is unset or the event cannot be rendered honestly.
 *
 * Dependency-free (node:test + Node builtins only), so the no-install CI job
 * (`node --test apps/api/src/`) covers the whole contract.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ENVELOPE_FILE_MODE,
  EVENT_VARIABLES,
  NOTIFY_CHANNELS,
  NOTIFY_EVENTS,
  buildEnvelope,
  channelEnabled,
  chooseChannel,
  documentLinkFor,
  emitEvent,
  formatEta,
  formatMoney,
  lifecycleVars,
  logLine,
  normalizePrefs,
  redactRecipient,
  tripLinkFor,
  tripRef,
  writeEnvelope,
} from './notifications.js';
import { signShareLink, signTrackLink } from './track-link.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const AUTH_SECRET = 'notifications-test-secret';

/* ------------------------------------------------------------- fixtures --- */

const customer = { name: 'Ada' };
const order = {
  id: 'order_1042',
  customerId: 'cust_1',
  origin: 'Lagos, NG',
  destination: 'Accra, GH',
  plannedAt: new Date('2026-10-27T14:30:00Z'),
};
const trip = {
  id: 'trip_1',
  orderId: 'order_1042',
  order,
  rateEur: 1200,
  driver: { name: 'Kofi' },
  truck: { plate: 'TRK-77' },
};
const load = {
  id: 'load_1',
  orderId: 'order_1042',
  customerId: 'cust_1',
  origin: 'Lagos, NG',
  destination: 'Accra, GH',
};
const offer = { carrierName: 'Asif Transport', priceEur: 1200 };
const invoiceDocument = { id: 'doc_invoice_9f8e7d6c', docType: 'invoice' };
const podDocument = { id: 'doc_pod_9f8e7d6c', docType: 'pod' };
const LINK = 'https://roadwisefleet.com/track/capability-token';

/** The minimal context each event reads (all values from real model rows). */
const CONTEXT = {
  offer_received: { load, customer },
  awarded: { load, offer, customer, trip },
  driver_assigned: { trip, customer },
  at_pickup: { trip, customer },
  in_transit: { trip, customer },
  delivered: { trip, customer, link: LINK },
  pod_ready: { trip, customer, link: LINK, document: podDocument },
  invoice_issued: { trip, customer, link: LINK, document: invoiceDocument },
};

/** A fresh directory per test, removed afterwards. */
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'rwf-notify-'));
  return {
    dir,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
    files() {
      return readdirSync(dir).filter((name) => name.endsWith('.key')).sort();
    },
  };
}

/** Key=value pairs of one envelope file. */
function parseEnvelope(path) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue;
    const at = line.indexOf('=');
    assert.ok(at > 0, `every line must be key=value: ${line}`);
    out[line.slice(0, at)] = line.slice(at + 1);
  }
  return out;
}

/* ------------------------------------------------------- the eight events --- */

test('the catalogue is exactly the eight UXF-O2 events and three channels', () => {
  assert.deepEqual([...NOTIFY_EVENTS], [
    'offer_received',
    'awarded',
    'driver_assigned',
    'at_pickup',
    'in_transit',
    'delivered',
    'pod_ready',
    'invoice_issued',
  ]);
  assert.deepEqual([...NOTIFY_CHANNELS], ['email', 'whatsapp', 'sms']);
});

for (const event of NOTIFY_EVENTS) {
  test(`${event}: renders exactly one envelope with the §2 key set`, () => {
    const built = lifecycleVars({ event, ...CONTEXT[event] });
    assert.equal(built.ok, true, `${event} must build: ${JSON.stringify(built)}`);
    assert.deepEqual(Object.keys(built.vars), [...EVENT_VARIABLES[event]]);

    const envelope = buildEnvelope(event, 'email', 'customer@example.com', built.vars);
    assert.equal(envelope.ok, true, `${event} envelope must render: ${JSON.stringify(envelope)}`);
    assert.deepEqual(envelope.keys, ['event', 'channel', 'recipient', ...EVENT_VARIABLES[event]]);

    const dir = tempDir();
    try {
      const result = emitEvent({
        spoolDir: dir.dir,
        event,
        channel: 'email',
        recipient: 'customer@example.com',
        vars: built.vars,
        prefs: normalizePrefs(null),
        now: new Date('2026-10-25T10:00:00Z'),
        random: 'deadbeef',
      });
      assert.equal(result.ok, true, `${event} must queue: ${JSON.stringify(result)}`);
      const files = dir.files();
      assert.equal(files.length, 1, `${event} must write exactly one envelope`);
      assert.match(files[0], new RegExp(`^${event}-RWF-[A-Za-z0-9]+-\\d{8}T\\d{9}Z-deadbeef\\.key$`));

      const parsed = parseEnvelope(join(dir.dir, files[0]));
      assert.deepEqual(Object.keys(parsed), ['event', 'channel', 'recipient', ...EVENT_VARIABLES[event]]);
      assert.equal(parsed.event, event);
      assert.equal(parsed.channel, 'email');
      assert.equal(parsed.recipient, 'customer@example.com');
      // The trip reference is derived from the ORDER, so it does not change
      // between events for the same shipment.
      assert.equal(parsed.trip_ref, tripRef({ orderId: order.id }));
    } finally {
      dir.cleanup();
    }
  });
}

test('the reference comes from the order, so it is stable from offer to invoice', () => {
  const fromOrder = tripRef({ orderId: 'order_1042' });
  // The load and the trip both carry the order, so every event for the same
  // shipment renders the same reference even though the ids differ.
  assert.equal(tripRef({ orderId: 'order_1042', tripId: 'trip_1', loadId: 'load_1' }), fromOrder);
  assert.equal(fromOrder, tripRef({ orderId: 'order_1042' }));
  assert.match(fromOrder, /^RWF-[A-Z0-9]{1,8}$/);
  assert.equal(tripRef({}), '');
});

test('in_transit key set carries the planned delivery as `eta`', () => {
  const built = lifecycleVars({ event: 'in_transit', ...CONTEXT.in_transit });
  assert.equal(built.ok, true);
  assert.equal(built.vars.eta, formatEta(order.plannedAt));
  assert.equal(built.vars.eta, '2026-10-27 14:30 UTC');
  assert.equal(built.vars.delivery, 'Accra, GH');
});

test('invoice_issued carries a deterministic invoice reference and the amount', () => {
  const built = lifecycleVars({ event: 'invoice_issued', ...CONTEXT.invoice_issued });
  assert.equal(built.ok, true);
  assert.equal(built.vars.invoice_ref, 'INV-9F8E7D6C');
  assert.equal(built.vars.amount, '1200.00 EUR');
});

/* ------------------------------------------------------- safe by default --- */

test('RWF_NOTIFY_SPOOL unset ⇒ emit is a no-op and writes nothing', () => {
  const dir = tempDir();
  try {
    const result = emitEvent({
      spoolDir: '',
      event: 'delivered',
      channel: 'email',
      recipient: 'customer@example.com',
      vars: lifecycleVars({ event: 'delivered', ...CONTEXT.delivered }).vars,
      prefs: normalizePrefs(null),
    });
    assert.deepEqual(result, { ok: true, skipped: 'no_spool' });
    assert.deepEqual(dir.files(), []);
  } finally {
    dir.cleanup();
  }
});

test('whitespace-only spool path is the same no-op', () => {
  assert.deepEqual(
    emitEvent({
      spoolDir: '   ',
      event: 'delivered',
      channel: 'email',
      recipient: 'customer@example.com',
      vars: lifecycleVars({ event: 'delivered', ...CONTEXT.delivered }).vars,
      prefs: normalizePrefs(null),
    }),
    { ok: true, skipped: 'no_spool' },
  );
});

/* ---------------------------------------------------------- preferences --- */

test('a channel switched off writes NO envelope (not a send-time filter)', () => {
  const dir = tempDir();
  try {
    const prefs = normalizePrefs({ email: false, whatsapp: false, sms: false });
    const result = emitEvent({
      spoolDir: dir.dir,
      event: 'in_transit',
      channel: 'email',
      recipient: 'customer@example.com',
      vars: lifecycleVars({ event: 'in_transit', ...CONTEXT.in_transit }).vars,
      prefs,
    });
    assert.deepEqual(result, { ok: true, skipped: 'suppressed' });
    assert.deepEqual(dir.files(), [], 'a disabled preference must not queue a file');
  } finally {
    dir.cleanup();
  }
});

test('preferences default to email on, chat channels off', () => {
  assert.deepEqual(normalizePrefs(null), { email: true, sms: false, whatsapp: false });
  assert.equal(channelEnabled(null, 'email'), true);
  assert.equal(channelEnabled(null, 'whatsapp'), false);
  assert.equal(channelEnabled(null, 'sms'), false);
});

test('chooseChannel picks the first enabled channel with a usable contact', () => {
  const prefs = normalizePrefs({ email: false, whatsapp: true, sms: true });
  assert.equal(chooseChannel({ prefs, email: 'a@b.co', whatsapp: '+15551234567', sms: '+15557654321' }), 'whatsapp');
  assert.equal(chooseChannel({ prefs, email: 'a@b.co', whatsapp: '', sms: '+15557654321' }), 'sms');
  // An enabled channel with no address is skipped; no address at all means no
  // recipient, hence no envelope.
  assert.equal(chooseChannel({ prefs, email: 'a@b.co' }), null);
  assert.equal(chooseChannel({ prefs: normalizePrefs(null), email: '' }), null);
});

/* -------------------------------------------------------------- refusals --- */

test('a missing template variable refuses the event and writes no file', () => {
  const dir = tempDir();
  try {
    const built = lifecycleVars({ event: 'delivered', trip, customer, link: '' });
    assert.deepEqual(built, { ok: false, error: 'missing_variable', missing: ['link'] });

    const result = emitEvent({
      spoolDir: dir.dir,
      event: 'delivered',
      channel: 'email',
      recipient: 'customer@example.com',
      vars: { customer_name: 'Ada', trip_ref: 'RWF-1042', delivery: 'Accra, GH' }, // no link
      prefs: normalizePrefs(null),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'missing_variable');
    assert.deepEqual(result.missing, ['link']);
    assert.deepEqual(dir.files(), []);
  } finally {
    dir.cleanup();
  }
});

test('an unknown event / bad channel / unusable recipient is refused', () => {
  const vars = lifecycleVars({ event: 'delivered', ...CONTEXT.delivered }).vars;
  assert.equal(buildEnvelope('surprise_event', 'email', 'a@b.co', vars).error, 'unknown_event');
  assert.equal(buildEnvelope('delivered', 'carrier-pigeon', 'a@b.co', vars).error, 'unknown_channel');
  assert.equal(buildEnvelope('delivered', 'email', 'not-an-address', vars).error, 'invalid_recipient');
  assert.equal(buildEnvelope('delivered', 'sms', '12345', vars).error, 'invalid_recipient');
  assert.equal(buildEnvelope('delivered', 'email', 'a@b.co', { ...vars, link: 'a\nrecipient=evil@x.co' }).error, 'invalid_variable');
});

test('unknown event / recipient is logged as a redacted refusal, never a body', () => {
  const dir = tempDir();
  try {
    const lines = [];
    const result = emitEvent({
      spoolDir: dir.dir,
      event: 'nope',
      channel: 'email',
      recipient: 'customer@example.com',
      vars: {},
      prefs: normalizePrefs(null),
      log: (line) => lines.push(line),
    });
    assert.equal(result.ok, false);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^event=nope to=c\*\*\*@example\.com result=refused_unknown_event$/);
    assert.doesNotMatch(lines[0], /customer@example\.com/);
    assert.deepEqual(dir.files(), []);
  } finally {
    dir.cleanup();
  }
});

test('redaction follows §3.4 for addresses and phone numbers', () => {
  assert.equal(redactRecipient('customer@example.com'), 'c***@example.com');
  assert.equal(redactRecipient('+15551234567'), '***4567');
  assert.equal(redactRecipient(''), '***');
  assert.equal(logLine({ event: 'delivered', result: 'queued', recipient: 'customer@example.com' }), 'event=delivered to=c***@example.com result=queued');
});

/* ------------------------------------------------------------- the spool --- */

test('the envelope file is atomic, 0600 and uniquely named', () => {
  const dir = tempDir();
  try {
    const text = 'event=delivered\nchannel=email\nrecipient=a@b.co\n';
    const first = writeEnvelope(dir.dir, text, { event: 'delivered', ref: 'RWF-1042', now: new Date('2026-10-25T10:00:00Z'), random: 'aaaa' });
    const second = writeEnvelope(dir.dir, text, { event: 'delivered', ref: 'RWF-1042', now: new Date('2026-10-25T10:00:00Z'), random: 'bbbb' });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.notEqual(first.file, second.file);
    assert.equal(statSync(first.file).mode & 0o777, ENVELOPE_FILE_MODE);
    assert.equal(readFileSync(first.file, 'utf8'), text);
    // No temp files survive a successful rename.
    assert.deepEqual(readdirSync(dir.dir).filter((name) => name.includes('.tmp')), []);
  } finally {
    dir.cleanup();
  }
});

test('a value that would forge an extra key is refused', () => {
  const envelope = buildEnvelope('delivered', 'email', 'a@b.co', {
    customer_name: 'Ada',
    trip_ref: 'RWF-1042',
    link: '/track/x\nrecipient=evil@example.com',
  });
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error, 'invalid_variable');
});

/* ----------------------------------------------------------- the `link` --- */

test('delivered reuses the trip tracking token (no new scheme)', () => {
  const issuedAt = new Date('2026-10-01T00:00:00Z');
  const expiresAt = new Date('2026-10-31T00:00:00Z');
  const shareTrip = {
    id: 'trip_1',
    trackLinkVersion: 2,
    trackLinkIssuedAt: issuedAt,
    trackLinkExpiresAt: expiresAt,
  };
  const now = new Date('2026-10-25T10:00:00Z').getTime();
  const url = tripLinkFor(shareTrip, { authSecret: AUTH_SECRET, now });
  assert.ok(url, 'a live link must resolve');
  const token = url.replace('/track/', '');
  // It is byte-for-byte the token the tracker hands out.
  const expected = signTrackLink({
    tripId: 'trip_1',
    version: 2,
    authSecret: AUTH_SECRET,
    ttlSeconds: Math.round((expiresAt.getTime() - issuedAt.getTime()) / 1000),
    now: Math.floor(issuedAt.getTime() / 1000),
  });
  assert.equal(token, expected.token);
  assert.equal(url, `/track/${expected.token}`);
  // An expired or missing window has no link: the event is refused, not faked.
  assert.equal(tripLinkFor({ ...shareTrip, trackLinkExpiresAt: new Date('2026-10-02T00:00:00Z') }, { authSecret: AUTH_SECRET, now }), null);
  assert.equal(tripLinkFor({ id: 'trip_1' }, { authSecret: AUTH_SECRET, now }), null);
});

test('pod_ready / invoice_issued reuse the guest document share token', () => {
  const issuedAt = new Date('2026-10-01T00:00:00Z');
  const expiresAt = new Date('2026-10-31T00:00:00Z');
  const shareTrip = { id: 'trip_1', trackLinkVersion: 3, trackLinkIssuedAt: issuedAt, trackLinkExpiresAt: expiresAt };
  const now = new Date('2026-10-25T10:00:00Z').getTime();
  const url = documentLinkFor(shareTrip, invoiceDocument, { scope: 'invoice', authSecret: AUTH_SECRET, now });
  assert.ok(url, 'a live share window must resolve a document link');
  assert.match(url, /^\/g\/invoice\//);
  const token = decodeURIComponent(url.replace('/g/invoice/', ''));
  const expected = signShareLink({
    scope: 'invoice',
    documentId: invoiceDocument.id,
    version: 3,
    authSecret: AUTH_SECRET,
    ttlSeconds: Math.round((expiresAt.getTime() - issuedAt.getTime()) / 1000),
    now: Math.floor(issuedAt.getTime() / 1000),
  });
  assert.equal(token, expected.token);
  assert.equal(documentLinkFor({ id: 'trip_1' }, invoiceDocument, { scope: 'invoice', authSecret: AUTH_SECRET, now }), null);
});

test('money and eta formatting never render "undefined"', () => {
  assert.equal(formatMoney(1200), '1200.00 EUR');
  assert.equal(formatMoney('1200.5'), '1200.50 EUR');
  assert.equal(formatMoney({ toNumber: () => 99.9 }), '99.90 EUR');
  assert.equal(formatMoney(null), '');
  assert.equal(formatEta(null), '');
  assert.equal(formatEta('not a date'), '');
});

/* -------------------------------------------------- catalogue drift guards --- */

test('every event has a transport template with exactly the expected placeholders', () => {
  const templateDir = join(REPO_ROOT, 'infra/notifications/templates');
  for (const event of NOTIFY_EVENTS) {
    const text = readFileSync(join(templateDir, `${event}.txt`), 'utf8');
    assert.match(text, /^Subject: /, `${event}.txt needs a Subject: line`);
    const placeholders = [...text.matchAll(/\{\{([a-zA-Z0-9_]+)\}\}/g)].map((m) => m[1]);
    assert.deepEqual(
      [...new Set(placeholders)].sort(),
      [...EVENT_VARIABLES[event]].sort(),
      `${event}.txt placeholders must match the emitter's key set`,
    );
  }
  // No template without an event.
  const templates = readdirSync(templateDir).filter((name) => name.endsWith('.txt'));
  assert.deepEqual(templates.map((name) => name.replace(/\.txt$/, '')).sort(), [...NOTIFY_EVENTS].sort());
});

test('the transport catalogue lists the same eight events', () => {
  const script = readFileSync(join(REPO_ROOT, 'infra/scripts/pilot-notify-deliver.sh'), 'utf8');
  const match = /^EVENTS=\((.*)\)$/m.exec(script);
  assert.ok(match, 'the transport must declare its EVENTS list');
  assert.deepEqual(match[1].trim().split(/\s+/).sort(), [...NOTIFY_EVENTS].sort());
  const channels = /^CHANNELS=\((.*)\)$/m.exec(script);
  assert.ok(channels, 'the transport must declare its CHANNELS list');
  assert.deepEqual(channels[1].trim().split(/\s+/).sort(), [...NOTIFY_CHANNELS].sort());
});
