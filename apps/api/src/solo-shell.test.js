/**
 * Solo driver surface (board task #77, UXF-M2) — dependency-free checks for the
 * static-serving contract (`solo-shell.js`) and the surface's own files.
 *
 * Runs with `node --test apps/api/src/` (no install, no Fastify): the route
 * wiring is a thin wrapper and is covered by `test/solo.test.ts` under
 * `test:router`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { contentTypeFor, servesShell } from './app-shell.js';
import { SOLO_PREFIX, SOLO_ROOT, resolveSoloFile, soloShellHtml } from './solo-shell.js';
import * as solo from '../../../solo/lib/solo-core.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

test('the mount point and root are the ones the route and docs use', () => {
  assert.equal(SOLO_PREFIX, '/s/');
  assert.equal(SOLO_ROOT, resolve(repoRoot, 'solo'));
});

test('a normal surface asset resolves inside <repo>/solo', () => {
  const file = resolveSoloFile('solo.js');
  assert.ok(file && file.startsWith(SOLO_ROOT + sep), 'resolves under the solo root');
  assert.ok(file.endsWith('solo.js'));
  assert.ok(resolveSoloFile('lib/solo-core.js'));
  assert.ok(resolveSoloFile('locales/en.json'));
  assert.ok(resolveSoloFile('manifest.webmanifest'));
  assert.equal(contentTypeFor('solo.js'), 'text/javascript; charset=utf-8');
  assert.equal(contentTypeFor('manifest.webmanifest'), 'application/manifest+json');
});

test('the module manifest is refused even though it exists on disk', () => {
  assert.ok(existsSync(resolve(SOLO_ROOT, 'package.json')), 'the file really exists');
  assert.equal(resolveSoloFile('package.json'), null, 'but it is never served');
});

test('traversal, dotfiles and unknown extensions never resolve', () => {
  assert.equal(resolveSoloFile('../apps/api/src/app.ts'), null);
  assert.equal(resolveSoloFile('..%2Fpackage.json'), null);
  assert.equal(resolveSoloFile('.env'), null);
  assert.equal(resolveSoloFile('notes.txt'), null);
  assert.equal(resolveSoloFile('does-not-exist.js'), null);
});

test('the SPA fallback serves a deep link but not a missing asset', () => {
  assert.equal(servesShell('jobs', false), true);
  assert.equal(servesShell('jobs/42', false), true);
  assert.equal(servesShell('missing.js', false), false);
  assert.equal(servesShell('.env', false), false);
});

test('the shell is the real index.html and declares a mobile viewport', () => {
  const html = soloShellHtml();
  assert.match(html, /id="panel"/, 'the render target is in the shell');
  assert.match(html, /id="loginForm"/, 'the sign-in form is in the shell');
  assert.match(html, /id="signupForm"/, 'the signup form is in the shell');
  assert.match(html, /width=device-width/, 'mobile viewport');
  assert.match(html, /type="module" src="\/s\/solo\.js"/, 'the module entry is /s/solo.js');
  assert.match(html, /rel="manifest"/, 'the pilot surface is installable');
});

test('the surface is mobile-first and keeps touch targets and motion honest', () => {
  const css = readFileSync(resolve(SOLO_ROOT, 'solo.css'), 'utf8');
  assert.equal(/@media\s*\(max-width/.test(css), false, 'no desktop-first max-width queries');
  assert.match(css, /@media \(min-width: 600px\)/, 'upgrades with min-width');
  assert.match(css, /@media \(pointer: coarse\)/, 'coarse pointers are handled');
  assert.match(css, /min-height: 44px/, '44px targets');
  assert.match(css, /prefers-reduced-motion/, 'reduced motion is honoured');
});

test('the catalogue covers every static key the shell and the core reference', () => {
  const cat = JSON.parse(readFileSync(resolve(SOLO_ROOT, 'locales/en.json'), 'utf8'));
  const html = soloShellHtml();
  const dataI18n = [...html.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(dataI18n.length > 5);
  for (const key of dataI18n) assert.ok(cat[key], `missing catalogue key ${key}`);
  for (const docType of solo.VERIFICATION_DOC_TYPES) {
    assert.ok(cat['solo.verify.' + docType], `missing paper label for ${docType}`);
  }
  for (const equipment of solo.EQUIPMENT) {
    assert.ok(cat['equipment.' + equipment], `missing equipment label for ${equipment}`);
  }
});

test('the shared core declares itself as an ES module for both runtimes', () => {
  const manifest = JSON.parse(readFileSync(resolve(SOLO_ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.type, 'module');
});
