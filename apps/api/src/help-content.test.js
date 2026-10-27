/**
 * Help content (board #138, UXF-DOC2 + FAv1-SUP2b) — dependency-free guards.
 *
 * The help pages are one content table mounted twice (`/app/help`,
 * `/pilot/help.html`). Nothing here needs Fastify or a browser, so it runs in
 * the no-install CI job (`node --test apps/api/src/`), which is where a missing
 * translation or a drifted status list must fail the build:
 *
 *   1. every key the help table renders exists in EVERY catalogue of BOTH
 *      surfaces (EN/DE/PL/TR) — the issue's "a test that fails on a missing key";
 *   2. the status sequence mirrors `trip-status.js`, so a new status cannot
 *      appear on the page unlabelled;
 *   3. the copy keeps the R50 promise rule: no notification/SMS/WhatsApp
 *      promise, and the one place those words appear says they are NOT part of
 *      the pilot;
 *   4. the routes that mount it are the ones the docs claim (`/app/help` is a
 *      real page served from `app/help.html`, never the SPA fallback).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import helpContent from '../../../pilot/lib/help-content.js';
import { TRIP_STATUSES } from './trip-status.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

const LOCALES = ['en', 'de', 'pl', 'tr'];
const SURFACES = ['app', 'pilot'];

/** @type {Record<string, Record<string, Record<string, string>>>} */
const CATALOGS = {};
for (const surface of SURFACES) {
  CATALOGS[surface] = {};
  for (const locale of LOCALES) {
    CATALOGS[surface][locale] = JSON.parse(read(`${surface}/locales/${locale}.json`));
  }
}

// --- 1. every rendered key exists in every catalogue -------------------------

test('every help key exists in every catalogue of both surfaces (EN/DE/PL/TR)', () => {
  const keys = helpContent.helpKeys();
  assert.ok(keys.length > 35, `expected the help page to render many keys, found ${keys.length}`);
  for (const surface of SURFACES) {
    for (const locale of LOCALES) {
      const missing = keys.filter((key) => !(key in CATALOGS[surface][locale]));
      assert.deepEqual(missing, [], `${surface}/locales/${locale}.json is missing help keys`);
      const empty = keys.filter((key) => String(CATALOGS[surface][locale][key] ?? '').trim() === '');
      assert.deepEqual(empty, [], `${surface}/${locale}: help values must not be empty`);
    }
  }
});

test('a catalogue with one key removed fails this test (the guard is not vacuous)', () => {
  const keys = helpContent.helpKeys();
  const crippled = { ...CATALOGS.pilot.de };
  delete crippled['help.track.what'];
  const missing = keys.filter((key) => !(key in crippled));
  assert.deepEqual(missing, ['help.track.what']);
});

test('the help copy is translated, not copied English', () => {
  for (const locale of LOCALES) {
    if (locale === 'en') continue;
    const keys = helpContent.helpKeys();
    const translated = keys.filter(
      (key) => CATALOGS.app[locale][key] !== CATALOGS.app.en[key]
    );
    assert.ok(
      translated.length / keys.length > 0.9,
      `app/${locale}.json help copy looks untranslated (${translated.length}/${keys.length})`
    );
  }
});

test('both surfaces carry the same help copy, so the two mounts cannot drift', () => {
  for (const locale of LOCALES) {
    for (const key of helpContent.helpKeys()) {
      assert.equal(
        CATALOGS.app[locale][key],
        CATALOGS.pilot[locale][key],
        `${locale}:${key} differs between the app and pilot catalogues`
      );
    }
  }
});

// --- 2. the status list -----------------------------------------------------

test('the help status list is the state machine, in order', () => {
  assert.deepEqual([...helpContent.HELP_STATUSES], [...TRIP_STATUSES]);
});

test('every status the page prints resolves to a label on both surfaces', () => {
  for (const surface of SURFACES) {
    const prefix = helpContent.SURFACES[surface].statusPrefix;
    for (const locale of LOCALES) {
      for (const status of helpContent.HELP_STATUSES) {
        const label = CATALOGS[surface][locale][`${prefix}${status}`];
        assert.equal(typeof label, 'string', `${surface}/${locale}: ${status} has no label`);
        assert.ok(label.length > 0, `${surface}/${locale}: ${status} label is empty`);
        assert.notEqual(label, status, `${surface}/${locale}: ${status} would print its raw token`);
      }
    }
  }
});

// --- 3. the copy keeps its promises -----------------------------------------

test('no help string promises notifications, SMS or WhatsApp (R50)', () => {
  const offenders = [];
  for (const locale of LOCALES) {
    for (const key of helpContent.helpKeys()) {
      const text = String(CATALOGS.app[locale][key]);
      if (!/(whatsapp|sms\b|push notification|notification)/i.test(text)) continue;
      // The only allowed mention is the FAQ row that says they are NOT shipped:
      // it must name the pilot and carry a negation in that language.
      const negated = /pilot/i.test(text) && /(not|nicht|keine|nie |değil)/i.test(text);
      if (key !== 'help.faq.notifications' || !negated) offenders.push(`${locale}:${key}`);
    }
  }
  assert.deepEqual(offenders, [], 'help copy must not promise a channel the pilot does not ship');
});

test('no help string promises a delivery time or a price the product does not compute', () => {
  for (const locale of LOCALES) {
    for (const key of helpContent.helpKeys()) {
      const text = String(CATALOGS.app[locale][key]);
      assert.doesNotMatch(text, /\bETA\b|\b\d+\s*(hours?|days?|hours? later)\b/i, `${locale}:${key}`);
    }
  }
});

// --- 4. rendering and the routes that mount it -------------------------------

test('renderHelp renders the table with the surface status family and escapes values', () => {
  const html = helpContent.renderHelp('app', (key) => {
    if (key === 'help.toc') return '<script>alert(1)</script>';
    return key;
  });
  assert.match(html, /class="help-toc"/, 'a table of contents is rendered');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, 'values are escaped');
  assert.doesNotMatch(html, /<script>/, 'no raw markup survives escaping');
  for (const status of helpContent.HELP_STATUSES) {
    assert.ok(html.includes(`trips.status.${status}`), `app help must use trips.status.${status}`);
  }
  const pilot = helpContent.renderHelp('pilot', (key) => key);
  assert.ok(pilot.includes('status.DELIVERED'), 'pilot help uses the pilot status keys');
  assert.ok(!pilot.includes('trips.status.'), 'the pilot page must not print an app key');
  for (const topic of helpContent.TOPICS) {
    assert.ok(html.includes(`id="help-${topic.id}"`), `section ${topic.id} is rendered`);
  }
});

test('/app/help is a real page served from app/help.html, never the SPA shell', () => {
  const page = read('app/help.html');
  const shell = read('app/index.html');
  const route = read('apps/api/src/routes/app.ts');
  const shellModule = read('apps/api/src/app-shell.js');

  assert.match(shellModule, /export const HELP_PATH = '\/app\/help'/, 'the path lives in one place');
  assert.match(route, /app\.get\(HELP_PATH/, 'the route is registered');
  assert.match(route, /helpHtml\(\)/, 'the route sends the help page, not the shell');
  assert.ok(page.includes('id="helpBody"'), 'the page has the render target');
  assert.ok(page.includes('/pilot/lib/help-boot.js'), 'the page boots the shared renderer');
  // The document title must be distinct from the app shell's, or a reader (and
  // a QA probe) cannot tell the two apart.
  const pageTitle = /<title[^>]*data-i18n="help\.documentTitle"[^>]*>([^<]+)</.exec(page);
  assert.ok(pageTitle, 'the help page declares its own title key');
  assert.ok(!shell.includes(pageTitle[1]), 'the help title must not appear in the app shell');
});

test('the help pages declare the surface and catalogue base their renderer uses', () => {
  for (const surface of SURFACES) {
    const page = read(surface === 'app' ? 'app/help.html' : 'pilot/help.html');
    const cfg = helpContent.SURFACES[surface];
    assert.match(page, new RegExp(`data-surface="${surface}"`), `${surface}: data-surface`);
    assert.ok(page.includes(`data-locales="${cfg.localesBase}"`), `${surface}: catalogue base`);
    const files = readdirSync(resolve(root, `${surface}/locales`)).filter((f) => f.endsWith('.json')).sort();
    assert.deepEqual(files, ['de.json', 'en.json', 'pl.json', 'tr.json'], `${surface}: catalogues`);
  }
});

test('the pilot help page is part of the offline shell', () => {
  const sw = read('pilot/sw.js');
  assert.ok(sw.includes("'./help.html'"), 'sw.js caches the help page');
  assert.ok(sw.includes("'./lib/help-content.js'"), 'sw.js caches the content table');
  assert.ok(sw.includes("'./lib/help-boot.js'"), 'sw.js caches the boot script');
  assert.doesNotMatch(sw, /rwf-driver-shell-v2/, 'the cache name must be bumped or the old shell wins');
});

test('every surface named in the issue links to the help page', () => {
  const links = {
    'app/index.html': ['/app/help'],
    'pilot/dashboard.html': ['help.html'],
    'pilot/driver.html': ['help.html'],
    'solo/index.html': ['/pilot/help.html#help-solo'],
  };
  for (const [file, targets] of Object.entries(links)) {
    const page = read(file);
    for (const target of targets) {
      assert.ok(page.includes(`href="${target}"`), `${file} must link to ${target}`);
    }
  }
  // The sign-in screens: the Fleet Manager login and the driver login.
  assert.match(read('app/index.html'), /id="loginToHelp"[^>]*href="\/app\/help"/);
  assert.match(read('pilot/driver.html'), /id="loginCard"[\s\S]*help\.html/);
});

test('the public tracking page offers a "What is this link?" explanation', () => {
  const page = read('apps/api/src/track-page.js');
  assert.match(page, /<details class="card what">/, 'the disclosure is rendered');
  assert.match(page, /<summary>What is this link\?<\/summary>/);
  assert.ok(page.includes('href="/pilot/help.html#help-customer"'), 'it links to the customer guide');
});

test('the solo first-run screen links to the help page before an account exists', () => {
  const page = read('solo/index.html');
  const solo = JSON.parse(read('solo/locales/en.json'));
  assert.match(page, /id="soloHelpLink"[^>]*href="\/pilot\/help\.html#help-solo"/);
  assert.equal(typeof solo['solo.help.link'], 'string', 'the solo link label is catalogued');
});
