/**
 * Fleet Manager app shell (board task #32, FAv1-F1) — dependency-free coverage
 * for the servable surface: `src/app-shell.js` (path resolution, content types,
 * SPA fallback) and the `app/` files themselves (docs/markup/script drift, the
 * catalogue, keyboard-accessible login).
 *
 * Runs under the no-install CI job (`node --test apps/api/src/`): `node:*`
 * builtins only, no Fastify, no Prisma. The HTTP-level assertions live in
 * `apps/api/test/app-shell.test.ts` (`pnpm test:router`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import appCore from '../../../app/lib/app-core.js';
import {
  ALLOWED_EXTENSIONS,
  APP_PREFIX,
  APP_ROOT,
  contentTypeFor,
  resolveAppFile,
  servesShell,
  shellHtml,
} from './app-shell.js';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '../../../app');
const readApp = (name) => readFileSync(join(appDir, name), 'utf8');

const PAGE = readApp('index.html');
const APP_JS = readApp('app.js');
const CORE_JS = readApp('lib/app-core.js');
const CSS = readApp('app.css');
const CATALOGUE = JSON.parse(readApp('locales/en.json'));

// --- the shell --------------------------------------------------------------

test('the app root, prefix and file layout are what the docs claim', () => {
  assert.equal(APP_ROOT, appDir);
  assert.equal(APP_PREFIX, '/app/');
  assert.ok(existsSync(join(appDir, 'index.html')));
  assert.ok(existsSync(join(appDir, 'app.css')));
  assert.ok(existsSync(join(appDir, 'app.js')));
  assert.ok(existsSync(join(appDir, 'lib/app-core.js')));
  assert.ok(existsSync(join(appDir, 'locales/en.json')));
});

test('every element app.js reaches for exists in the shell', () => {
  const ids = new Set();
  for (const m of APP_JS.matchAll(/\b(?:el|setText|setHidden|show|hide)\(\s*'([A-Za-z][\w-]*)'/g)) {
    ids.add(m[1]);
  }
  assert.ok(ids.size >= 8, `expected the shell to be wired to several elements, saw ${ids.size}`);
  for (const id of ids) {
    assert.match(PAGE, new RegExp(`id="${id}"`), `#${id} is used by app.js but missing from index.html`);
  }
});

test('the shell loads the shared i18n core, its own core and app.js with absolute paths', () => {
  assert.match(PAGE, /<script src="\/pilot\/lib\/i18n\.js"><\/script>/);
  assert.match(PAGE, /<script src="\/pilot\/lib\/i18n-ui\.js"><\/script>/);
  assert.match(PAGE, /<script src="\/app\/lib\/app-core\.js"><\/script>/);
  assert.match(PAGE, /<script src="\/app\/app\.js"><\/script>/);
  assert.match(PAGE, /<link rel="stylesheet" href="\/app\/app\.css">/);
});

test('the shell is a two-view app: login and the authenticated shell', () => {
  assert.match(PAGE, /id="loginView"/);
  assert.match(PAGE, /id="loginForm"/);
  assert.match(PAGE, /id="appView"[\s\S]*hidden/);
  assert.match(PAGE, /id="navSlot"/);
  assert.match(PAGE, /id="outlet"/);
  assert.match(PAGE, /id="logout"/);
  assert.match(PAGE, /id="globalError" role="alert"/);
  assert.match(PAGE, /id="loginError" role="alert"/);
  // Both views start hidden: neither is rendered before the guard has decided.
  assert.match(PAGE, /id="loginView"[^>]*hidden/);
});

test('the login form is keyboard-navigable and labelled', () => {
  assert.match(PAGE, /<form id="loginForm"/);
  for (const id of ['email', 'password']) {
    assert.match(PAGE, new RegExp(`<label for="${id}"`), `#${id} needs a label`);
    assert.match(PAGE, new RegExp(`<input id="${id}"[^>]*required`), `#${id} must be required`);
  }
  assert.match(PAGE, /id="email"[^>]*autocomplete="username"/);
  assert.match(PAGE, /id="password"[^>]*autocomplete="current-password"/);
  assert.match(PAGE, /id="email"[^>]*autofocus/);
  assert.match(PAGE, /<button class="primary" id="loginSubmit" type="submit"/);
  // A keyboard user must be able to see where they are.
  assert.match(CSS, /:focus-visible/);
  assert.match(CSS, /\.skip-link/);
  assert.doesNotMatch(PAGE, /tabindex="-1"[^>]*id="email"|id="email"[^>]*tabindex="-1"/);
});

test('the layout covers both acceptance widths and no fixed pixel width breaks 375px', () => {
  assert.match(CSS, /@media \(max-width: 900px\)/);
  const wide = [...CSS.matchAll(/[;{]\s*(?:min-)?width:\s*(\d{3,4})px/g)]
    .map((m) => Number(m[1]))
    .filter((v) => v > 375 && v < 900);
  assert.deepEqual(wide, [], 'no fixed column wider than the 375px target');
  assert.match(PAGE, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
});

// --- the script -------------------------------------------------------------

test('app.js and app-core.js are valid JavaScript', () => {
  assert.doesNotThrow(() => new Function(APP_JS));
  assert.doesNotThrow(() => new Function(CORE_JS));
});

test('the app keeps its session in sessionStorage, never in a cookie', () => {
  assert.match(APP_JS, /sessionStorage/);
  assert.doesNotMatch(APP_JS, /document\.cookie/);
  assert.match(APP_JS, /APP\.TOKEN_KEY/);
  assert.match(APP_JS, /Bearer /);
});

test('the guard re-runs on popstate and pageshow, so a signed-out back navigation is refused', () => {
  assert.match(APP_JS, /addEventListener\('popstate'/);
  assert.match(APP_JS, /addEventListener\('pageshow'/);
  assert.match(APP_JS, /history\.replaceState/);
});

test('app.js consumes the pure core rather than reimplementing the rules', () => {
  for (const fn of ['guardDecision', 'navHtml', 'panelFor', 'escapeHtml', 'errorKey', 'routeForPath']) {
    assert.match(APP_JS, new RegExp(`APP\\.${fn}`), `app.js should call APP.${fn}`);
  }
  assert.doesNotMatch(APP_JS, /\beval\(|new Function\(/);
});

// --- the catalogue ----------------------------------------------------------

test('the English catalogue covers every key the app can ask for', () => {
  const sources = APP_JS + '\n' + CORE_JS;
  const namespaces = ['app.', 'brand.', 'common.', 'login.', 'nav.', 'overview.', 'role.', 'error.'];
  const keys = new Set();
  for (const m of sources.matchAll(/'([a-zA-Z]+\.[a-zA-Z0-9_.]+)'/g)) {
    if (namespaces.some((ns) => m[1].startsWith(ns))) keys.add(m[1]);
  }
  assert.ok(keys.size >= 25, `expected many catalogue keys, saw ${keys.size}`);
  const missing = [...keys].filter((key) => !(key in CATALOGUE));
  assert.deepEqual(missing, [], `missing catalogue keys: ${missing.join(', ')}`);

  // errorKey returns catalogue keys, so every one of its outputs must exist.
  for (const error of ['invalid_credentials', 'account_locked', 'unauthorized', 'forbidden', 'no_org']) {
    assert.ok(appCore.errorKey(error) in CATALOGUE);
  }
  for (const status of [400, 401, 403, 404, 423, 429, 500]) {
    assert.ok(appCore.errorKey(undefined, status) in CATALOGUE, `status ${status} maps to a known key`);
  }
  // Every route label and role label is translatable.
  for (const route of appCore.ROUTES) assert.ok(route.i18n in CATALOGUE, route.i18n);
  for (const role of appCore.ROLES) assert.ok(appCore.roleKey(role) in CATALOGUE, role);
});

test('no catalogue value is empty, and the language hook is wired EN-first', () => {
  for (const [key, value] of Object.entries(CATALOGUE)) {
    assert.equal(typeof value, 'string', key);
    assert.notEqual(String(value).trim(), '', key);
  }
  // EN first: the app ships one catalogue and loads it from its own root, so the
  // shared i18n core falls back to English for every key.
  assert.match(APP_JS, /APP\.APP_BASE \+ '\/locales\/'/);
  assert.match(APP_JS, /RoadwiseI18nUI|i18nUI\.init/);
});

// --- static serving ---------------------------------------------------------

test('servable files resolve inside the app root', () => {
  for (const rel of ['index.html', 'app.css', 'app.js', 'lib/app-core.js', 'locales/en.json']) {
    const file = resolveAppFile(rel);
    assert.ok(file, `${rel} should resolve`);
    assert.ok(String(file).startsWith(appDir));

  }
  assert.equal(resolveAppFile(''), null, 'the directory itself is never served');
  assert.equal(resolveAppFile('/'), null);
});

test('traversal, dotfiles and unlisted extensions are refused', () => {
  for (const rel of [
    '../package.json',
    '../../package.json',
    '..%2fpackage.json',
    '%2e%2e%2f%2e%2e%2fpackage.json',
    'lib/../../package.json',
    '.env',
    'locales/.hidden',
    'lib/app-core.ts',
    'payload.exe',
    'lib/app-core.js%00.png',
  ]) {
    assert.equal(resolveAppFile(rel), null, `${rel} must not resolve`);
  }
});

test('content types are explicit and the allow-list is closed', () => {
  assert.equal(contentTypeFor('index.html'), 'text/html; charset=utf-8');
  assert.equal(contentTypeFor('app.css'), 'text/css; charset=utf-8');
  assert.equal(contentTypeFor('app.js'), 'text/javascript; charset=utf-8');
  assert.equal(contentTypeFor('locales/en.json'), 'application/json; charset=utf-8');
  assert.equal(contentTypeFor('x.txt'), null);
  assert.equal(contentTypeFor('x.ts'), null);
  for (const ext of ALLOWED_EXTENSIONS) assert.ok(contentTypeFor('file' + ext), ext);
});

test('a deep link gets the shell, a missing asset gets a 404', () => {
  assert.equal(servesShell('trips', false), true);
  assert.equal(servesShell('', false), true);
  assert.equal(servesShell('app/trips', false), true);
  assert.equal(servesShell('old.html', false), true);
  assert.equal(servesShell('missing.js', false), false);
  assert.equal(servesShell('missing.css', false), false);
  assert.equal(servesShell('locales/fr.json', false), false);
  assert.equal(servesShell('.env', false), false);
  assert.equal(servesShell('.well-known/x', false), false);
  assert.equal(servesShell('trips', true), false);
});

test('shellHtml is the shell the tests above describe', () => {
  const html = shellHtml();
  assert.match(html, /id="loginView"/);
  assert.match(html, /id="appView"/);
  // It is cached: the same string comes back, and the read never goes outside app/.
  assert.equal(shellHtml(), html);
});
