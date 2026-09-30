/**
 * UX + accessibility pass over the pilot surfaces (board task #70).
 *
 * Dependency-free guards for the fixes in the audit
 * `docs/ux-a11y-audit-20260929.md`: the AA contrast pairs, the touch-target
 * media query, reduced motion, the focus ring, the dashboard dialog semantics
 * and the keyboard-reachable table rows. Runs in the no-install CI job.
 *
 * The contrast values are re-derived in this file (pure WCAG 2.1 maths) rather
 * than trusted from the report, so a future palette edit that reintroduces a
 * failing pair fails here too.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pilotDir = resolve(here, '../../../pilot');
const appDir = resolve(here, '../../../app');

const readPilot = (name) => readFileSync(join(pilotDir, name), 'utf8');
const readApp = (name) => readFileSync(join(appDir, name), 'utf8');

const DASHBOARD = readPilot('dashboard.html');
const DRIVER = readPilot('driver.html');
const LANDING = readPilot('index.html');
const APP_JS = readApp('app.js');
const APP_CSS = readApp('app.css');
const TRACK_PAGE = readFileSync(join(here, 'track-page.js'), 'utf8');

/* --- WCAG 2.1 contrast maths (sRGB hex in, ratio out) --------------------- */

function srgbLum(hex) {
  const n = parseInt(hex.slice(1), 16);
  const channels = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const [r, g, b] = channels.map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(fg, bg) {
  const a = srgbLum(fg);
  const b = srgbLum(bg);
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

test('the AA-failing mid-tone success text is replaced by the deep variant', () => {
  // Before (ux check_contrast 2026-09-29): #048b56 FAILs on both backgrounds.
  assert.ok(contrast('#048b56', '#f9fafc') < 4.5, 'the old value must be the failing one');
  assert.ok(contrast('#048b56', '#ffffff') < 4.5);
  // After: the deep tone passes AA for normal text.
  assert.ok(contrast('#005a2d', '#f9fafc') >= 4.5, 'status pill text');
  assert.ok(contrast('#005a2d', '#ffffff') >= 4.5, 'P&L text');
  assert.match(DASHBOARD, /--success-deep:\s*oklch\(0\.40 0\.12 158\)/);
  assert.match(DASHBOARD, /\.status\.s-DELIVERED[^\n]*color:var\(--success-deep\)/);
  assert.match(DASHBOARD, /\.pnl\.pos\{color:var\(--success-deep\)\}/);
  assert.doesNotMatch(DASHBOARD, /\.status\.s-DELIVERED[^\n]*color:var\(--success\)/);
});

test('the public tracking pills use AA text tones on their tinted backgrounds', () => {
  const pairs = [
    ['#3970c2', '#dfecff', '#1a52a1'], // default pill: accent -> accent-text
    ['#258651', '#d2f6dd', '#006436'], // done pill: ok -> ok-text
    ['#b46e00', '#ffe9cb', '#723f00'], // pending pill: warn -> warn-text
  ];
  for (const [before, bg, after] of pairs) {
    assert.ok(contrast(before, bg) < 4.5, `${before} on ${bg} was the failing pair`);
    assert.ok(contrast(after, bg) >= 4.5, `${after} on ${bg} must pass AA`);
  }
  assert.ok(contrast('#6a727e', '#eaeff5') < 4.5, 'the old flag.no was the failing pair');
  assert.ok(contrast('#4e5661', '#eaeff5') >= 4.5);
  assert.match(TRACK_PAGE, /--accent-text:oklch\(0\.45 0\.14 258\)/);
  assert.match(TRACK_PAGE, /--ok-text:oklch\(0\.44 0\.11 155\)/);
  assert.match(TRACK_PAGE, /--warn-text:oklch\(0\.42 0\.11 70\)/);
  assert.match(TRACK_PAGE, /--muted-text:oklch\(0\.45 0\.02 258\)/);
  assert.match(TRACK_PAGE, /\.status\.done\{background:oklch\(0\.94 0\.05 155\);color:var\(--ok-text\)\}/);
  assert.match(TRACK_PAGE, /\.status\.pending\{background:oklch\(0\.95 0\.05 70\);color:var\(--warn-text\)\}/);
  assert.match(TRACK_PAGE, /\.flag\.no\{background:oklch\(0\.95 0\.01 258\);color:var\(--muted-text\)\}/);
});

test('every pilot surface honours reduced motion and the coarse-pointer touch size', () => {
  for (const [name, html] of [['landing', LANDING], ['dashboard', DASHBOARD], ['driver', DRIVER]]) {
    assert.match(html, /@media \(prefers-reduced-motion: reduce\)/, `${name}: reduced motion`);
    assert.match(html, /:focus-visible/, `${name}: focus ring`);
  }
  assert.match(DASHBOARD, /@media \(pointer:coarse\)/);
  assert.match(LANDING, /@media \(pointer:coarse\)/);
  assert.match(APP_CSS, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(APP_CSS, /@media \(pointer: coarse\)/);
  // The compact controls that fell under 44px are now at least 44px on mobile.
  assert.match(DRIVER, /button\.small\{min-height:44px/);
  assert.match(DRIVER, /\.appbar select\.lang-switcher\{[^}]*min-height:44px/);
});

test('the dashboard drawer is a dialog, out of tab order when closed, and focus-managed', () => {
  assert.match(DASHBOARD, /id="drawer"[^>]*role="dialog"/);
  assert.match(DASHBOARD, /id="drawer"[^>]*aria-modal="true"/);
  assert.match(DASHBOARD, /id="drawer"[^>]*aria-labelledby="drawerTitle"/);
  assert.match(DASHBOARD, /\.drawer\{[^}]*visibility:hidden/);
  assert.match(DASHBOARD, /\.drawer\.open\{[^}]*visibility:visible/);
  assert.match(DASHBOARD, /function openDrawer\(\)[\s\S]*?\.focus\(\)/);
  assert.match(DASHBOARD, /function closeDrawer\(\)[\s\S]*?lastFocus[\s\S]*?\.focus\(\)/);
});

test('dynamic status text is announced and the trip rows are keyboard-reachable', () => {
  assert.match(DASHBOARD, /id="globalMsg"[^>]*role="status"[^>]*aria-live="polite"/);
  // Dashboard: the route cell is a real button that opens the same drawer.
  assert.match(DASHBOARD, /<button type="button" class="row-open" data-open="/);
  assert.match(DASHBOARD, /querySelectorAll\('button\.row-open'\)/);
  // Fleet Manager trips list: same pattern, one focusable control per row.
  assert.match(APP_JS, /<button type="button" class="cell-open" data-trip="' \+ esc\(row\.id\)/);
  assert.match(APP_CSS, /\.cell-open \{/);
});

test('the Fleet Manager driver switcher uses toggle buttons, not a half-built tablist', () => {
  assert.doesNotMatch(APP_JS, /role="tablist"/);
  assert.doesNotMatch(APP_JS, /role="tab"/);
  assert.match(APP_JS, /class="driver-switcher" role="group" aria-label="/);
  assert.match(APP_JS, /aria-pressed="' \+ \(active \? 'true' : 'false'\)/);
});

test('the driver view does not skip a heading level', () => {
  assert.doesNotMatch(APP_JS, /<h3>' \+ esc\(T\('docs\.checklistTitle'\)\)/);
  assert.doesNotMatch(APP_JS, /<h3>' \+ esc\(T\('driver\.capture\.title'\)\)/);
  assert.match(APP_JS, /<h2>' \+ esc\(T\('docs\.checklistTitle'\)\)/);
  assert.match(APP_JS, /<h2>' \+ esc\(T\('driver\.capture\.title'\)\)/);
});

test('the driver sign-out is a button, not a link that only pretends to be one', () => {
  assert.match(DRIVER, /<button id="logout"[^>]*type="button"/);
  assert.doesNotMatch(DRIVER, /<a[^>]*id="logout"/);
});
