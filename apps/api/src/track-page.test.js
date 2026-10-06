/**
 * Public tracking page labels (board task #117, item C).
 *
 * The page rendered `esc(t.status)` / `esc(e.from) → esc(e.to)`, so a customer
 * read raw tokens (`IN_TRANSIT`, `AT_PICKUP`, `POD_UPLOADED`). This guard pins
 * the human-label map, proves it covers every status the state machine can
 * produce, and proves the markup labels both the badge and the history rows.
 *
 * Dependency-free: runs under the no-install CI job (`node --test apps/api/src/`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { TRACK_STATUS_LABELS, trackPageHtml } from './track-page.js';
import { TRIP_STATUSES } from './trip-status.js';

test('every trip status has a human label that is not the raw token', () => {
  for (const status of TRIP_STATUSES) {
    const label = TRACK_STATUS_LABELS[status];
    assert.equal(typeof label, 'string', `${status} has no label`);
    assert.ok(label.length > 0, `${status} label must not be empty`);
    assert.notEqual(label, status, `${status} must not render as its raw token`);
  }
});

test('the server-rendered labels are embedded in the page script', () => {
  const html = trackPageHtml();
  const m = /var STATUS_LABELS = (\{[\s\S]*?\});/.exec(html);
  assert.ok(m, 'the page must embed STATUS_LABELS');
  const embedded = JSON.parse(m[1]);
  assert.deepEqual(embedded, { ...TRACK_STATUS_LABELS });
});

test('the badge and the history rows render labels, never raw status tokens', () => {
  const html = trackPageHtml();
  assert.ok(html.includes('esc(statusLabel(t.status))'), 'the badge must be labelled');
  assert.ok(
    html.includes("esc(statusLabel(e.from)) + ' → ' + esc(statusLabel(e.to))"),
    'history rows must be labelled',
  );
  assert.ok(!html.includes('esc(t.status ||'), 'the raw badge token path must be gone');
  assert.ok(!html.includes('esc(e.from) +'), 'the raw history path must be gone');
});

test('the page still parses and keeps its inline-only, noindex shape', () => {
  const html = trackPageHtml();
  const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
  const inline = scripts.filter((s) => !/\bsrc=/.test(s[1]));
  assert.equal(inline.length, 1, 'exactly one inline script');
  // `new Function` throws on a syntax error, which is what we care about here.
  assert.doesNotThrow(() => new Function(inline[0][2]));
  assert.match(html, /<meta name="robots" content="noindex/);
});
