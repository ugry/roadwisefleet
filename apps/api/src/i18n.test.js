/**
 * i18n scaffolding (board task #6) — dependency-free coverage.
 *
 * Runs in the no-install CI job (`node --test apps/api/src/`), so it imports
 * only `node:*` builtins plus the two UMD pilot modules. Three layers:
 *
 *   1. the API locale resolver (`./i18n.js`) and its parity with
 *      `pilot/lib/i18n.js` — the drift guard, like `driver-pwa.test.js`;
 *   2. the catalogues themselves (`pilot/locales/*.json`): every locale keys the
 *      same set, every placeholder survives translation, nothing is empty;
 *   3. the "no hardcoded UI strings" acceptance: the pilot pages are scanned for
 *      text nodes that are not covered by a `data-i18n` attribute, and every key
 *      they reference must exist in the English catalogue.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as apiI18n from './i18n.js';
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  localePayload,
  normalizeLocale,
  resolveLocale,
} from './i18n.js';
import pilotI18n from '../../../pilot/lib/i18n.js';
import i18nUi from '../../../pilot/lib/i18n-ui.js';
import driverCore from '../../../pilot/lib/driver-core.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const localesDir = resolve(root, 'pilot/locales');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

const PAGES = ['pilot/index.html', 'pilot/dashboard.html', 'pilot/driver.html'];

/** @type {Record<string, Record<string, string>>} */
const CATALOGS = {};
for (const locale of SUPPORTED_LOCALES) {
  CATALOGS[locale] = JSON.parse(read(`pilot/locales/${locale}.json`));
}

// --- 1. the API resolver ----------------------------------------------------

test('normalizeLocale accepts real language tags and rejects the rest', () => {
  assert.equal(normalizeLocale('de'), 'de');
  assert.equal(normalizeLocale('DE-at'), 'de');
  assert.equal(normalizeLocale(' pl '), 'pl');
  assert.equal(normalizeLocale('tr-TR'), 'tr');
  assert.equal(normalizeLocale('en'), 'en');
  assert.equal(normalizeLocale('fr'), null, 'a language we do not ship is not a locale');
  assert.equal(normalizeLocale(''), null);
  assert.equal(normalizeLocale(null), null);
  assert.equal(normalizeLocale(undefined), null);
  assert.equal(normalizeLocale(42), null);
});

test('resolveLocale prefers the request, then the user, then the org, then en', () => {
  assert.deepEqual(resolveLocale({ requested: 'pl', user: 'de', org: 'tr' }), { locale: 'pl', source: 'requested' });
  assert.deepEqual(resolveLocale({ user: 'de', org: 'tr' }), { locale: 'de', source: 'user' });
  assert.deepEqual(resolveLocale({ org: 'tr' }), { locale: 'tr', source: 'org' });
  assert.deepEqual(resolveLocale({}), { locale: DEFAULT_LOCALE, source: 'fallback' });
  assert.deepEqual(resolveLocale({ requested: 'fr', user: 'de' }), { locale: 'de', source: 'user' });
  assert.deepEqual(resolveLocale({ user: '', org: 'nonsense' }), { locale: DEFAULT_LOCALE, source: 'fallback' });
  assert.deepEqual(resolveLocale(), { locale: DEFAULT_LOCALE, source: 'fallback' });
});

test('localePayload tells the app which org default to use and what the user asked for', () => {
  assert.deepEqual(localePayload({ orgLocale: 'de', userLang: null }), {
    locale: 'de',
    lang: null,
    source: 'org',
    supported: [...SUPPORTED_LOCALES],
  });
  assert.deepEqual(localePayload({ orgLocale: 'de', userLang: 'PL-pl' }), {
    locale: 'pl',
    lang: 'pl',
    source: 'user',
    supported: [...SUPPORTED_LOCALES],
  });
  assert.deepEqual(localePayload({ orgLocale: 'fr', userLang: 'fr' }), {
    locale: 'en',
    lang: null,
    source: 'fallback',
    supported: [...SUPPORTED_LOCALES],
  });
  assert.deepEqual(localePayload({}).locale, 'en');
});

test('the API and the browser resolver ship the same locale list', () => {
  assert.deepEqual([...pilotI18n.SUPPORTED_LOCALES], [...SUPPORTED_LOCALES]);
  assert.equal(pilotI18n.DEFAULT_LOCALE, DEFAULT_LOCALE);
  for (const value of ['de', 'DE-at', 'pl', 'tr-TR', 'fr', '', null, 7]) {
    assert.equal(pilotI18n.normalizeLocale(value), normalizeLocale(value), `normalizeLocale(${String(value)})`);
  }
  assert.equal(apiI18n.resolveLocale, resolveLocale);
});

// --- 2. the catalogues ------------------------------------------------------

test('every supported locale has a catalogue file', () => {
  const files = readdirSync(localesDir).filter((f) => f.endsWith('.json')).sort();
  assert.deepEqual(files, ['de.json', 'en.json', 'pl.json', 'tr.json']);
});

/** Plural variants (`key.few`) are allowed on top of the English key set. A
 *  plural family needs no bare key: the translator looks up `key.one`/`key.other`
 *  first, so English itself only carries the plural forms. */
const PLURAL = ['one', 'few', 'many', 'other', 'two', 'zero'];
const baseKeys = new Set(Object.keys(CATALOGS.en));
const pluralBases = new Set();
for (const key of baseKeys) {
  const dot = key.lastIndexOf('.');
  if (dot !== -1 && PLURAL.includes(key.slice(dot + 1))) pluralBases.add(key.slice(0, dot));
}
const isPluralVariant = (key) => {
  const dot = key.lastIndexOf('.');
  if (dot === -1 || !PLURAL.includes(key.slice(dot + 1))) return false;
  const base = key.slice(0, dot);
  return baseKeys.has(base) || pluralBases.has(base);
};

test('each catalogue covers the English key set exactly', () => {
  for (const locale of SUPPORTED_LOCALES) {
    const keys = Object.keys(CATALOGS[locale]);
    const missing = [...baseKeys].filter((k) => !keys.includes(k) && !keys.some((c) => c.startsWith(`${k}.`)));
    const untranslatedBase = keys.filter((k) => !baseKeys.has(k) && !isPluralVariant(k));
    assert.deepEqual(missing, [], `${locale}.json is missing keys`);
    assert.deepEqual(untranslatedBase, [], `${locale}.json has keys English does not define`);
  }
});

test('no catalogue value is empty or a placeholder for work not done', () => {
  for (const locale of SUPPORTED_LOCALES) {
    for (const [key, value] of Object.entries(CATALOGS[locale])) {
      assert.equal(typeof value, 'string', `${locale}:${key} must be a string`);
      assert.ok(value.trim().length > 0, `${locale}:${key} must not be empty`);
      assert.ok(!/^(TODO|FIXME|TBD|XXX)/i.test(value), `${locale}:${key} looks unfinished`);
    }
  }
});

test('every {placeholder} survives translation', () => {
  const params = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const locale of SUPPORTED_LOCALES) {
    if (locale === DEFAULT_LOCALE) continue;
    for (const [key, value] of Object.entries(CATALOGS.en)) {
      const translated = CATALOGS[locale][key];
      if (typeof translated !== 'string') continue;
      assert.deepEqual(params(translated), params(value), `${locale}:${key} changed its placeholders`);
    }
  }
});

test('the four languages are actually translated, not copied English', () => {
  const probe = ['common.signIn', 'common.language', 'status.DELIVERED', 'driver.updateStatus'];
  for (const locale of SUPPORTED_LOCALES) {
    if (locale === DEFAULT_LOCALE) continue;
    const differs = probe.filter((key) => CATALOGS[locale][key] !== CATALOGS.en[key]);
    assert.ok(differs.length >= 3, `${locale} looks like a copy of English (only ${differs.length}/4 probed keys differ)`);
  }
  // Turkish is the odd one out on purpose (agglutinative, no eCMR acronym change).
  assert.equal(CATALOGS.tr['status.DELIVERED'], 'Teslim edildi');
  assert.equal(CATALOGS.pl['status.DELIVERED'], 'Dostarczony');
  assert.equal(CATALOGS.de['status.DELIVERED'], 'Geliefert');
});

// --- 3. translator, plurals, formatters -------------------------------------

test('a missing translation falls back to English and then to the key', () => {
  const catalogs = { en: { 'a.b': 'English text' }, de: {} };
  const german = pilotI18n.createTranslator(catalogs, 'de');
  assert.equal(german.locale, 'de');
  assert.equal(german.t('a.b'), 'English text');
  assert.equal(german.t('nope.at.all'), 'nope.at.all', 'the key is visible, never "undefined"');
  assert.deepEqual(german.missing, ['nope.at.all']);
  const french = pilotI18n.createTranslator(catalogs, 'fr');
  assert.equal(french.locale, 'en', 'an unsupported locale falls back to English, not to a blank page');
});

test('interpolation fills placeholders and leaves unknown ones visible', () => {
  assert.equal(pilotI18n.interpolate('Trip {id} → {to}', { id: 't1', to: 'LOADED' }), 'Trip t1 → LOADED');
  assert.equal(pilotI18n.interpolate('Trip {id}', {}), 'Trip {id}');
  assert.equal(pilotI18n.interpolate('{a} {b}', { a: 1 }), '1 {b}');
  assert.equal(pilotI18n.interpolate(null), '');
});

test('Polish plurals use all three CLDR forms, not a one/other guess', () => {
  const pl = pilotI18n.createTranslator(CATALOGS, 'pl');
  assert.equal(pilotI18n.pluralCategory('pl', 1), 'one');
  assert.equal(pilotI18n.pluralCategory('pl', 2), 'few');
  assert.equal(pilotI18n.pluralCategory('pl', 5), 'many');
  assert.equal(pl.t('driver.sync.pending', { count: 1 }), '1 zmiana czeka na synchronizację');
  assert.equal(pl.t('driver.sync.pending', { count: 2 }), '2 zmiany czekają na synchronizację');
  assert.equal(pl.t('driver.sync.pending', { count: 5 }), '5 zmian czeka na synchronizację');
  const en = pilotI18n.createTranslator(CATALOGS, 'en');
  assert.equal(en.t('driver.sync.pending', { count: 1 }), '1 change waiting to sync');
  assert.equal(en.t('driver.sync.pending', { count: 3 }), '3 changes waiting to sync');
});

test('the date/number/currency hooks follow the locale', () => {
  const de = pilotI18n.formatters('de');
  const en = pilotI18n.formatters('en');
  const pl = pilotI18n.formatters('pl');
  const tr = pilotI18n.formatters('tr');

  assert.equal(de.currency(1234.5, 'EUR').replace(/\u00a0/g, ' '), '1.234,50 €');
  assert.equal(en.currency(1234.5, 'EUR'), '€1,234.50');
  assert.match(pl.currency(1234.5, 'EUR'), /1\s?234,50/);
  assert.match(tr.currency(1234.5, 'EUR'), /1\.234,50/);
  assert.equal(de.number(1234.5), '1.234,5');
  assert.equal(en.number(1234.5), '1,234.5');
  assert.equal(en.percent(0.25), '25%');

  const when = '2026-09-23T11:59:00Z';
  assert.equal(de.date(when), '23.09.2026');
  assert.equal(en.date(when), '23 Sept 2026', 'EU-first dates even in English');
  // ICU abbreviates month names differently across versions — assert the shape.
  assert.match(pl.date(when), /^23 \S+ 2026$/, 'Polish must not render as US month/day');
  assert.match(tr.date(when), /^23 \S+ 2026$/);
  assert.notEqual(pl.date(when), en.date(when));
  assert.ok(de.dateTime(when).includes('13:59') || de.dateTime(when).includes('11:59'), 'a time is rendered');

  // The hooks are total: a missing or unusable value never throws.
  for (const f of [de, en, pl, tr]) {
    assert.equal(f.currency(null), null);
    assert.equal(f.currency('not-a-number'), null);
    assert.equal(f.number(undefined), null);
    assert.equal(f.date('nonsense'), 'nonsense');
    assert.equal(f.date(null), null);
  }
  assert.equal(pilotI18n.formatters('de').number('1450'), '1.450');
  assert.equal(pilotI18n.formatters('en').number('1450'), '1,450');
});

// --- 4. the browser layer ---------------------------------------------------

/** A tiny document stub: the applier only needs querySelectorAll + DOM props. */
function stubDoc(elements) {
  const els = elements.map((e) => ({
    attrs: { ...e.attrs },
    textContent: e.text ?? '',
    getAttribute: (k) => (k in e.attrs ? e.attrs[k] : null),
    setAttribute(k, v) { this.attrs[k] = String(v); },
  }));
  return { querySelectorAll: () => els, els, documentElement: { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } } };
}

test('applyTranslations fills text, placeholders and ARIA labels', () => {
  const doc = stubDoc([
    { attrs: { 'data-i18n': 'common.signIn' } },
    { attrs: { 'data-i18n-placeholder': 'login.emailPlaceholder' } },
    { attrs: { 'data-i18n-aria-label': 'common.language' } },
    { attrs: { 'data-i18n-params': '{"count":2}', 'data-i18n': 'driver.sync.pending' } },
  ]);
  const de = pilotI18n.createI18n({ catalogs: CATALOGS, locale: 'de' });
  const result = i18nUi.applyTranslations(doc, de.t);
  assert.equal(result.applied, 4);
  assert.equal(doc.els[0].textContent, 'Anmelden');
  assert.equal(doc.els[1].attrs.placeholder, 'admin@pilot.roadwisefleet.test');
  assert.equal(doc.els[2].attrs['aria-label'], 'Sprache');
  assert.equal(doc.els[3].textContent, '2 Änderungen warten auf Synchronisierung');
});

test('applyTranslations is a no-op on a root it cannot query', () => {
  const de = pilotI18n.createI18n({ catalogs: CATALOGS, locale: 'de' });
  assert.deepEqual(i18nUi.applyTranslations(null, de.t), { applied: 0, missing: [] });
});

test('the switcher lists all four languages and marks the current one', () => {
  const pl = pilotI18n.createI18n({ catalogs: CATALOGS, locale: 'pl' });
  const html = i18nUi.switcherHtml({ t: pl.t, current: 'pl' });
  assert.match(html, /<select id="langSwitcher"/);
  for (const label of ['English', 'Deutsch', 'Polski', 'Türkçe']) assert.ok(html.includes(label), `${label} must be offered`);
  assert.match(html, /<option value="pl" selected>Polski<\/option>/);
  assert.match(html, /aria-label="Język"/);
  assert.equal((html.match(/<option /g) || []).length, 4);
});

test('the page boot resolves ?lang= over everything and remembers an explicit choice', async () => {
  const storage = new Map();
  const doc = stubDoc([{ attrs: { 'data-i18n': 'common.signIn' } }]);
  doc.querySelector = () => ({ innerHTML: '', querySelector: () => null });
  const i18n = await i18nUi.init({
    doc,
    search: '?lang=tr',
    storage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, v),
    },
    user: { lang: 'de' },
    org: 'pl',
    navigatorLanguages: ['en-GB'],
    loadCatalog: (locale) => Promise.resolve(CATALOGS[locale] || {}),
  });
  assert.equal(i18n.locale, 'tr');
  assert.equal(i18n.source, 'requested');
  assert.equal(doc.els[0].textContent, 'Giriş yap');
  assert.equal(doc.documentElement.attrs.lang, 'tr');
  assert.equal(storage.get('rwf.lang'), 'tr', 'an explicit link choice sticks across pilot pages');
});

test('the page boot falls back to the org locale, then to English', async () => {
  const de = await i18nUi.init({
    doc: stubDoc([{ attrs: { 'data-i18n': 'common.signIn' } }]),
    search: '',
    storage: { getItem: () => null, setItem: () => undefined },
    org: 'de',
    navigatorLanguages: ['en-GB'],
    loadCatalog: (locale) => Promise.resolve(CATALOGS[locale] || {}),
  });
  assert.equal(de.locale, 'de');
  assert.equal(de.source, 'org');

  const fallback = await i18nUi.init({
    doc: stubDoc([]),
    search: '?lang=fr',
    storage: { getItem: () => null, setItem: () => undefined },
    org: 'nonsense',
    navigatorLanguages: [],
    loadCatalog: () => Promise.resolve({}),
  });
  assert.equal(fallback.locale, 'en', 'an unsupported ?lang= and a nonsense org locale land on English');
  assert.equal(fallback.source, 'fallback');
});

// --- 5. no hardcoded UI strings, and every key exists -----------------------

/**
 * Text nodes (letters, outside script/style/comments) that are not inside an
 * element carrying a `data-i18n` attribute. Punctuation and single characters
 * (`→`, `—`, `·`) are not language and are allowed through.
 * @param {string} html
 */
function untranslatedText(html) {
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<![^>]*>/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const tag = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  const stack = [];
  const found = [];
  let last = 0;
  let m;
  while ((m = tag.exec(cleaned)) !== null) {
    const text = cleaned.slice(last, m.index);
    if (text && /\p{L}\p{L}/u.test(text) && !stack.some((frame) => frame.translatable)) {
      found.push(text.trim().replace(/\s+/g, ' '));
    }
    last = tag.lastIndex;
    if (m[1] === '/') stack.pop();
    else if (!/\/\s*$/.test(m[3])) {
      stack.push({ name: m[2].toLowerCase(), translatable: /data-i18n/.test(m[3]) });
    }
  }
  return found;
}

test('the pilot pages keep no hardcoded UI string', () => {
  for (const page of PAGES) {
    assert.deepEqual(untranslatedText(read(page)), [], `${page} has text that is not translated`);
  }
});

test('the scanner itself catches an untranslated string', () => {
  assert.deepEqual(untranslatedText('<p data-i18n="a.b">Hello there</p>'), []);
  assert.deepEqual(untranslatedText('<p>Hello there</p>'), ['Hello there']);
  assert.deepEqual(untranslatedText('<p><span>Hello</span></p>'), ['Hello']);
  assert.deepEqual(untranslatedText('<p><span data-i18n="a">Hi there</span> → —</p>'), []);
  assert.deepEqual(untranslatedText('<style>p{content:"Hello"}</style>'), []);
  assert.deepEqual(untranslatedText('<script>var x = "Hello there";</script>'), []);
});

test('every translation key the pilot uses exists in the English catalogue', () => {
  const sources = [...PAGES.map(read), read('pilot/lib/i18n-ui.js'), read('pilot/lib/driver-core.js')];
  const keys = new Set();
  for (const source of sources) {
    for (const m of source.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) keys.add(m[1]);
    for (const m of source.matchAll(/\bt\('([A-Za-z0-9_.]+)'/g)) keys.add(m[1]);
    for (const m of source.matchAll(/labelKey:\s*'([A-Za-z0-9_.]+)'/g)) keys.add(m[1]);
  }
  // `t('status.' + code)` is a dynamic key: drop the truncated prefix.
  for (const key of [...keys]) if (key.endsWith('.')) keys.delete(key);
  assert.ok(keys.size > 100, `expected the pilot to reference a lot of keys, found ${keys.size}`);
  const missing = [...keys].filter((key) => !(key in CATALOGS.en) && !PLURAL.some((form) => `${key}.${form}` in CATALOGS.en));
  assert.deepEqual(missing, [], 'these keys are used but not translated');
});

test('the driver core ships keys, not English labels', () => {
  for (const row of driverCore.CHECKLIST) {
    assert.equal(typeof row.labelKey, 'string', `${row.docType} must carry a label key`);
    assert.equal(typeof row.hintKey, 'string', `${row.docType} must carry a hint key`);
    assert.ok(!('label' in row), `${row.docType} must not carry an English label`);
    assert.ok(!('hint' in row), `${row.docType} must not carry an English hint`);
    assert.ok(row.labelKey in CATALOGS.en, `${row.labelKey} must be translated`);
    assert.ok(row.hintKey in CATALOGS.en, `${row.hintKey} must be translated`);
  }
  const rows = driverCore.documentChecklist([]);
  assert.deepEqual(rows.map((r) => r.labelKey).filter(Boolean).length, rows.length);
  const card = driverCore.buildTourCard({ id: 't', status: 'DRAFT' });
  assert.equal(card.etaKey, 'driver.etaUnavailable');
  assert.ok(!('etaLabel' in card), 'the ETA placeholder moved into the catalogue');
  const indicator = driverCore.syncIndicator([], { online: true });
  assert.equal(indicator.labelKey, 'driver.sync.synced');
  assert.ok(!('label' in indicator), 'the sync chip label moved into the catalogue');
});
