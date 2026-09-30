/**
 * RoadwiseFleet pilot — internationalisation core (board task #6).
 *
 * Loaded twice, on purpose, exactly like `driver-core.js`:
 *   - in the browser, as a classic script (`<script src="lib/i18n.js">`), which
 *     exposes `window.RoadwiseI18n`;
 *   - in the API test suite (`apps/api/src/i18n.test.js`), so the resolver, the
 *     translator, the plural rules and the formatters are covered by
 *     `node --test apps/api/src/` with no install.
 *
 * Nothing here touches the DOM, the network or storage — `i18n-ui.js` owns
 * that. The catalogues themselves are `pilot/locales/<lang>.json`, one file per
 * supported language; a missing key falls back to English and then to the key
 * itself, so a translation gap can never blank out the UI.
 *
 * ES5-compatible syntax: the pilot targets cheap Android WebViews.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.RoadwiseI18n = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** Strategy mandates these four. `en` is the fallback for every other one. */
  var SUPPORTED_LOCALES = ['en', 'de', 'pl', 'tr'];

  /** The fallback locale: every catalogue is keyed against `en`. */
  var DEFAULT_LOCALE = 'en';

  /** The language name shown *in that language* in the switcher. */
  var LOCALE_LABELS = {
    en: 'English',
    de: 'Deutsch',
    pl: 'Polski',
    tr: 'Türkçe'
  };

  /**
   * BCP-47 tags handed to `Intl`. EU-first on purpose: the English pilot shows
   * day-before-month (`en-GB`), not `en-US`, because every pilot customer is in
   * the EU/TR corridor. Money in the pilot is always EUR.
   */
  var LOCALE_TAGS = {
    en: 'en-GB',
    de: 'de-DE',
    pl: 'pl-PL',
    tr: 'tr-TR'
  };

  var DEFAULT_CURRENCY = 'EUR';

  /**
   * Reduce any language tag to a supported base language, else `null`.
   * Accepts `de`, `de-DE`, `DE_at`, ` de ` — anything else is unsupported.
   * @param {unknown} value
   * @returns {string|null}
   */
  function normalizeLocale(value) {
    if (typeof value !== 'string') return null;
    var tag = value.trim().toLowerCase().replace(/_/g, '-');
    if (!tag) return null;
    var base = tag.split('-')[0];
    return SUPPORTED_LOCALES.indexOf(base) !== -1 ? base : null;
  }

  /**
   * @param {unknown} value
   * @returns {boolean}
   */
  function isSupported(value) {
    return normalizeLocale(value) !== null;
  }

  /**
   * The `?lang=` parameter of a query string (`?lang=de`, `?a=1&lang=PL`).
   * Written by hand rather than with `URLSearchParams`: old Android WebViews
   * do not all have it.
   * @param {unknown} search
   * @returns {string|null}
   */
  function localeFromSearch(search) {
    if (typeof search !== 'string') return null;
    var query = search.charAt(0) === '?' ? search.slice(1) : search;
    var parts = query.split('&');
    for (var i = 0; i < parts.length; i++) {
      var eq = parts[i].indexOf('=');
      if (eq === -1) continue;
      var name = parts[i].slice(0, eq);
      if (decodeURIComponent(name) !== 'lang') continue;
      var raw = parts[i].slice(eq + 1).replace(/\+/g, ' ');
      return normalizeLocale(decodeURIComponent(raw));
    }
    return null;
  }

  /**
   * Pick the locale for this page load.
   *
   * Precedence (board scope): an explicit `?lang=`/switcher choice, then the
   * choice remembered in this browser, then the user's own language, then the
   * org's default locale, then the browser's languages, then English. An
   * unsupported value never wins — it is skipped, not obeyed.
   * @param {{ requested?: unknown, stored?: unknown, user?: unknown, org?: unknown,
   *           navigator?: unknown, fallback?: unknown, source?: string }} [input]
   * @returns {string}
   */
  function resolveLocale(input) {
    return resolveLocaleDetailed(input).locale;
  }

  /**
   * `resolveLocale` plus where the answer came from — the reason is surfaced in
   * the UI tests and is useful when a demo shows the wrong language.
   * @param {{ requested?: unknown, stored?: unknown, user?: unknown, org?: unknown,
   *           navigator?: unknown, fallback?: unknown, source?: string }} [input]
   * @returns {{ locale: string, source: string, candidate: string|null }}
   */
  function resolveLocaleDetailed(input) {
    var b = input || {};
    var candidates = [
      { value: b.requested, source: 'requested' },
      { value: b.stored, source: 'stored' },
      { value: b.user, source: 'user' },
      { value: b.org, source: 'org' }
    ];
    if (typeof b.navigator === 'string') {
      candidates.push({ value: b.navigator, source: 'navigator' });
    } else if (Object.prototype.toString.call(b.navigator) === '[object Array]') {
      for (var n = 0; n < b.navigator.length; n++) {
        candidates.push({ value: b.navigator[n], source: 'navigator' });
      }
    }
    for (var i = 0; i < candidates.length; i++) {
      var picked = normalizeLocale(candidates[i].value);
      if (picked) return { locale: picked, source: candidates[i].source, candidate: picked };
    }
    var fallback = normalizeLocale(b.fallback) || DEFAULT_LOCALE;
    return { locale: fallback, source: 'fallback', candidate: null };
  }

  /**
   * `{name}` placeholders. An unknown placeholder is left as-is (visible, not
   * silently dropped) so a catalogue typo shows up in review rather than in an
   * empty line for the driver.
   * @param {unknown} template
   * @param {Record<string, unknown>} [params]
   * @returns {string}
   */
  function interpolate(template, params) {
    var text = String(template === null || template === undefined ? '' : template);
    if (!params) return text;
    return text.replace(/\{(\w+)\}/g, function (match, name) {
      if (!Object.prototype.hasOwnProperty.call(params, name)) return match;
      var value = params[name];
      return value === null || value === undefined ? match : String(value);
    });
  }

  /**
   * CLDR plural category for a count. Polish needs one/few/many (`1 zmiana`,
   * `2 zmiany`, `5 zmian`) — a `count === 1 ? one : other` shortcut would give
   * a Polish driver `2 zmiana`-style errors. `Intl.PluralRules` decides it
   * where it exists; otherwise the one/other approximation is used.
   * @param {string} locale
   * @param {number} count
   * @param {{ PluralRules?: any }|null} [intlImpl]
   * @returns {string} one | few | many | other
   */
  function pluralCategory(locale, count, intlImpl) {
    var n = Number(count);
    if (!isFinite(n)) return 'other';
    var intl = intlImpl || (typeof Intl !== 'undefined' ? Intl : null);
    if (intl && typeof intl.PluralRules === 'function') {
      try {
        return String(new intl.PluralRules(LOCALE_TAGS[normalizeLocale(locale)] || normalizeLocale(locale) || DEFAULT_LOCALE).select(n));
      } catch (err) {
        /* fall through to the approximation */
      }
    }
    return n === 1 ? 'one' : 'other';
  }

  /**
   * @param {unknown} value
   * @returns {number|null}
   */
  function finite(value) {
    if (value === null || value === undefined || value === '') return null;
    var n = Number(value);
    return isFinite(n) ? n : null;
  }

  /**
   * Build the translator for one locale.
   *
   * `t(key, params)` looks the key up in the active catalogue, then English,
   * then returns the key itself (never `undefined`, so the UI cannot print
   * "undefined"). With a numeric `params.count` it also tries the CLDR plural
   * key (`key.one`, `key.few`, `key.many`) before `key.other`.
   *
   * @param {Record<string, Record<string, string>>} catalogs
   * @param {string} locale
   * @param {{ fallback?: string }} [opts]
   */
  function createTranslator(catalogs, locale, opts) {
    var books = catalogs || {};
    var primary = normalizeLocale(locale) || DEFAULT_LOCALE;
    var fallbackLocale = normalizeLocale(opts && opts.fallback) || DEFAULT_LOCALE;
    var missing = [];
    var active = books[primary] || {};
    var fallback = books[fallbackLocale] || {};

    function lookup(book, key) {
      var value = book ? book[key] : undefined;
      return typeof value === 'string' && value !== '' ? value : null;
    }

    function t(key, params) {
      var name = String(key);
      var values = params || {};
      var value = null;
      if (typeof values.count === 'number') {
        var category = pluralCategory(primary, values.count);
        value = lookup(active, name + '.' + category) ||
          lookup(active, name + '.other') ||
          lookup(fallback, name + '.' + category) ||
          lookup(fallback, name + '.other');
      }
      if (value === null) value = lookup(active, name);
      if (value === null) value = lookup(fallback, name);
      if (value === null) {
        if (missing.indexOf(name) === -1) missing.push(name);
        return name;
      }
      return interpolate(value, values);
    }

    return {
      locale: primary,
      fallbackLocale: fallbackLocale,
      t: t,
      missing: missing,
      has: function (key) {
        return lookup(active, key) !== null || lookup(fallback, key) !== null;
      }
    };
  }

  /**
   * The date/number/currency formatting hooks (board scope). Every hook is
   * total: an unusable value returns `null` and an `Intl` failure falls back to
   * a plain string, so a page never throws on a formatting call.
   * @param {string} locale
   * @param {{ NumberFormat?: any, DateTimeFormat?: any }|null} [intlImpl]
   */
  function formatters(locale, intlImpl) {
    var loc = normalizeLocale(locale) || DEFAULT_LOCALE;
    var tag = LOCALE_TAGS[loc] || loc;
    var intl = intlImpl || (typeof Intl !== 'undefined' ? Intl : null);

    function number(value, options) {
      var n = finite(value);
      if (n === null) return null;
      if (!intl || typeof intl.NumberFormat !== 'function') return String(n);
      try {
        return new intl.NumberFormat(tag, options || {}).format(n);
      } catch (err) {
        return String(n);
      }
    }

    function currency(value, currencyCode) {
      return number(value, { style: 'currency', currency: currencyCode || DEFAULT_CURRENCY });
    }

    function percent(value, options) {
      var opts = options || {};
      var merged = { style: 'percent', maximumFractionDigits: 1 };
      for (var k in opts) {
        if (Object.prototype.hasOwnProperty.call(opts, k)) merged[k] = opts[k];
      }
      return number(value, merged);
    }

    /**
     * `date` accepts an ISO string, epoch ms or `Date`. An unparseable value is
     * returned as-is (never "Invalid Date").
     */
    function dateTime(value, options) {
      var ms = null;
      if (value instanceof Date) ms = value.getTime();
      else if (typeof value === 'number') ms = value;
      else if (typeof value === 'string' && value !== '') ms = Date.parse(value);
      if (ms === null || !isFinite(ms)) return value === null || value === undefined || value === '' ? null : String(value);
      if (!intl || typeof intl.DateTimeFormat !== 'function') return new Date(ms).toISOString();
      try {
        return new intl.DateTimeFormat(tag, options || { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms));
      } catch (err) {
        return new Date(ms).toISOString();
      }
    }

    function date(value, options) {
      return dateTime(value, options || { dateStyle: 'medium' });
    }

    return {
      locale: loc,
      tag: tag,
      number: number,
      currency: currency,
      percent: percent,
      date: date,
      dateTime: dateTime
    };
  }

  /**
   * One object with the translator and the formatting hooks bound to the same
   * locale — what the pages hold on to.
   * @param {{ catalogs?: any, locale?: string, intl?: any }} [input]
   */
  function createI18n(input) {
    var b = input || {};
    var locale = normalizeLocale(b.locale) || DEFAULT_LOCALE;
    var translator = createTranslator(b.catalogs, locale);
    var format = formatters(locale, b.intl);
    return {
      locale: locale,
      supported: SUPPORTED_LOCALES.slice(),
      labels: LOCALE_LABELS,
      t: translator.t,
      has: translator.has,
      missing: translator.missing,
      translator: translator,
      format: format,
      number: format.number,
      currency: format.currency,
      percent: format.percent,
      date: format.date,
      dateTime: format.dateTime
    };
  }

  return {
    SUPPORTED_LOCALES: SUPPORTED_LOCALES,
    DEFAULT_LOCALE: DEFAULT_LOCALE,
    LOCALE_LABELS: LOCALE_LABELS,
    LOCALE_TAGS: LOCALE_TAGS,
    DEFAULT_CURRENCY: DEFAULT_CURRENCY,
    normalizeLocale: normalizeLocale,
    isSupported: isSupported,
    localeFromSearch: localeFromSearch,
    resolveLocale: resolveLocale,
    resolveLocaleDetailed: resolveLocaleDetailed,
    interpolate: interpolate,
    pluralCategory: pluralCategory,
    createTranslator: createTranslator,
    formatters: formatters,
    createI18n: createI18n
  };
});
