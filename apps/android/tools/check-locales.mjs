#!/usr/bin/env node
/**
 * Locale parity guard for the Android app catalogues (board #103, AND1-A1).
 *
 * The app catalogue is a *superset* of the pilot catalogue: every key in
 * `pilot/locales/<lang>.json` is copied verbatim, and the app-shell chrome
 * (`nav.*`, `driver.sos*`, `common.confirm`, `driver.shell.*`) is added on top
 * in all four languages. This script fails if either half drifts:
 *
 *   1. every pilot key exists in the app catalogue with the identical value;
 *   2. the keys the app adds are the same set for EN/DE/PL/TR and non-empty;
 *   3. the four catalogues cover the same base keys (CLDR plural variants
 *      such as `.one`/`.few`/`.many` are allowed to differ).
 *
 * Run from anywhere:  node apps/android/tools/check-locales.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const LANGS = ['en', 'de', 'pl', 'tr'];
const PILOT_DIR = join(repo, 'pilot', 'locales');
const APP_DIR = join(repo, 'apps', 'android', 'core', 'src', 'main', 'assets', 'locales');
const PLURAL = /\.(zero|one|two|few|many|other)$/;

let failures = 0;
const fail = (msg) => {
  console.error(`  FAIL  ${msg}`);
  failures += 1;
};
const ok = (msg) => console.log(`  ok    ${msg}`);

const read = (dir, lang) => {
  const path = join(dir, `${lang}.json`);
  if (!existsSync(path)) throw new Error(`missing catalogue: ${path}`);
  return JSON.parse(readFileSync(path, 'utf8'));
};
const baseKeys = (obj) => new Set(Object.keys(obj).map((key) => key.replace(PLURAL, '')));

console.log('RoadwiseFleet Android locale parity\n');

const pilot = {};
const app = {};
for (const lang of LANGS) {
  try {
    pilot[lang] = read(PILOT_DIR, lang);
    app[lang] = read(APP_DIR, lang);
  } catch (error) {
    fail(error.message);
  }
}
if (failures > 0) {
  console.error(`\n  failures: ${failures}`);
  process.exit(1);
}

// 1. pilot keys are copied verbatim.
for (const lang of LANGS) {
  let drift = 0;
  for (const [key, value] of Object.entries(pilot[lang])) {
    if (!(key in app[lang])) {
      fail(`${lang}: pilot key absent from the app catalogue: ${key}`);
      drift += 1;
    } else if (app[lang][key] !== value) {
      fail(`${lang}: value drifted from the pilot for ${key}`);
      drift += 1;
    }
  }
  if (drift === 0) ok(`${lang}: every pilot key is copied verbatim`);
}

// 2. the app-added keys are the same set for every language and non-empty.
const extras = {};
for (const lang of LANGS) {
  extras[lang] = Object.keys(app[lang]).filter((key) => !(key in pilot[lang])).sort();
}
const referenceExtras = extras.en;
for (const lang of LANGS) {
  const same = JSON.stringify(extras[lang]) === JSON.stringify(referenceExtras);
  if (!same) {
    fail(`${lang}: app-only key set differs from EN`);
  }
  for (const key of extras[lang]) {
    if (typeof app[lang][key] !== 'string' || app[lang][key].trim() === '') {
      fail(`${lang}: app-only key is empty: ${key}`);
    }
  }
}
if (extras.en.length === 0) {
  fail('the app catalogue adds no shell keys');
} else {
  ok(`app-only key set is identical across the four languages (${extras.en.length} keys)`);
}

// 3. base key coverage (plural variants may differ per language).
const referenceBases = [...baseKeys(app.en)].sort();
for (const lang of LANGS) {
  const bases = [...baseKeys(app[lang])].sort();
  if (JSON.stringify(bases) !== JSON.stringify(referenceBases)) {
    fail(`${lang}: base key coverage differs from EN`);
  }
}
ok('the four catalogues cover the same base keys (plural variants aside)');

console.log(`\n  failures: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
