/**
 * RoadwiseFleet pilot — i18n browser layer (board task #6).
 *
 * `i18n.js` is pure and knows nothing about the DOM; this file is the only
 * place that touches it. It does three things:
 *
 *   1. applies a translation to the static markup, driven by attributes:
 *        data-i18n              -> textContent
 *        data-i18n-placeholder  -> placeholder
 *        data-i18n-title        -> title
 *        data-i18n-aria-label   -> aria-label
 *        data-i18n-content      -> content   (meta tags)
 *        data-i18n-value        -> value
 *   2. renders and wires the language switcher (`#langSwitcher`);
 *   3. boots: resolve the locale (?lang= > remembered choice > user > org >
 *      browser > en), load the catalogues from `pilot/locales/<lang>.json`,
 *      apply them and remember an explicit choice.
 *
 * Loaded as a classic script after `lib/i18n.js` (`window.RoadwiseI18nUI`); also
 * requireable from Node so `apps/api/src/i18n.test.js` can drive it with a stub
 * document and the real catalogue files — no install, no browser.
 *
 * ES5-compatible syntax: the pilot targets cheap Android WebViews.
 */
(function (root, factory) {
  var core = (typeof module === 'object' && module.exports)
    ? require('./i18n.js')
    : root.RoadwiseI18n;
  var api = factory(core);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.RoadwiseI18nUI = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core) {
  'use strict';

  /** attribute -> destination attribute on the element (null = textContent). */
  var ATTRS = {
    'data-i18n': null,
    'data-i18n-placeholder': 'placeholder',
    'data-i18n-title': 'title',
    'data-i18n-aria-label': 'aria-label',
    'data-i18n-content': 'content',
    'data-i18n-value': 'value'
  };

  /** The selector that finds every translatable node, in one pass. */
  var SELECTOR = '[data-i18n],[data-i18n-placeholder],[data-i18n-title],[data-i18n-aria-label],[data-i18n-content],[data-i18n-value]';

  var DEFAULT_STORAGE_KEY = 'rwf.lang';
  var DEFAULT_BASE = 'locales/';

  /**
   * Apply a translator to a document (or any subtree).
   *
   * The translation key is read from the attribute; a `data-i18n-params`
   * attribute may carry JSON parameters (`{"count":2}`) for plural/placeholder
   * strings, so a static element can be plural-aware without a JS render pass.
   * @param {{ querySelectorAll: (s: string) => any }} root
   * @param {(key: string, params?: any) => string} t
   * @returns {{ applied: number, missing: string[] }}
   */
  function applyTranslations(root, t) {
    if (!root || typeof root.querySelectorAll !== 'function') return { applied: 0, missing: [] };
    var nodes = root.querySelectorAll(SELECTOR);
    var list = [];
    for (var i = 0; i < nodes.length; i++) list.push(nodes[i]);
    var applied = 0;
    for (var n = 0; n < list.length; n++) {
      var el = list[n];
      for (var attr in ATTRS) {
        if (!Object.prototype.hasOwnProperty.call(ATTRS, attr)) continue;
        var key = el.getAttribute(attr);
        if (!key) continue;
        var params = null;
        var rawParams = el.getAttribute('data-i18n-params');
        if (rawParams) {
          try { params = JSON.parse(rawParams); } catch (err) { params = null; }
        }
        var text = t(key, params);
        var target = ATTRS[attr];
        if (target === null) el.textContent = text;
        else if (typeof el.setAttribute === 'function') el.setAttribute(target, text);
        applied += 1;
      }
    }
    return { applied: applied, missing: [] };
  }

  /**
   * The switcher markup. Rendered as a string (like the rest of the pilot pages)
   * so it is pure and testable without `document.createElement`.
   * @param {{ t: (k: string, p?: any) => string, current?: string, locales?: string[] }} input
   * @returns {string}
   */
  function switcherHtml(input) {
    var b = input || {};
    var t = b.t || function (key) { return key; };
    var locales = b.locales || core.SUPPORTED_LOCALES;
    var current = core.normalizeLocale(b.current) || core.DEFAULT_LOCALE;
    var options = '';
    for (var i = 0; i < locales.length; i++) {
      var loc = locales[i];
      var label = t('language.name.' + loc);
      if (label === 'language.name.' + loc) label = core.LOCALE_LABELS[loc] || loc;
      options += '<option value="' + loc + '"' + (loc === current ? ' selected' : '') + '>' + label + '</option>';
    }
    return '<select id="langSwitcher" class="lang-switcher" aria-label="' + t('common.language') + '" data-i18n-aria-label="common.language">' +
      options + '</select>';
  }

  /**
   * Default catalogue loader: one static JSON file per locale, same origin.
   * A failed load is `{}` rather than a rejection — the English fallback inside
   * the translator still renders every key.
   * @param {string} base
   * @param {{ fetch?: any }} [opts]
   */
  function catalogLoader(base, opts) {
    var dir = typeof base === 'string' && base ? base : DEFAULT_BASE;
    var options = opts || {};
    var doFetch = options.fetch || (typeof fetch === 'function' ? fetch : null);
    return function (locale) {
      if (!doFetch) return Promise.resolve({});
      return doFetch(dir + locale + '.json').then(function (res) {
        if (!res || res.ok === false || (typeof res.status === 'number' && res.status >= 400)) return {};
        return res.json().catch(function () { return {}; });
      }).catch(function () { return {}; });
    };
  }

  /**
   * @param {unknown} value
   * @returns {any|null}
   */
  function element(value, doc) {
    if (!value) return null;
    if (typeof value === 'string') {
      if (!doc || typeof doc.querySelector !== 'function') return null;
      return doc.querySelector(value);
    }
    return value;
  }

  /**
   * Boot the page i18n.
   * @param {{
   *   doc?: any, base?: string, catalogs?: any, loadCatalog?: (l: string) => Promise<any>,
   *   storage?: any, storageKey?: string, search?: string, navigatorLanguages?: any,
   *   user?: any, org?: any, mount?: any, onApply?: (i18n: any) => void
   * }} [options]
   * @returns {Promise<any>} the i18n object (`locale`, `source`, `t`, `currency`, …)
   */
  function init(options) {
    var b = options || {};
    var doc = b.doc || (typeof document !== 'undefined' ? document : null);
    var storage = b.storage || safeStorage();
    var key = b.storageKey || DEFAULT_STORAGE_KEY;
    var load = b.loadCatalog || catalogLoader(b.base, b);
    var search = b.search !== undefined
      ? b.search
      : (typeof location !== 'undefined' && location.search ? location.search : '');
    var navigatorLanguages = b.navigatorLanguages;
    if (navigatorLanguages === undefined && typeof navigator !== 'undefined') {
      navigatorLanguages = navigator.languages || navigator.language || null;
    }
    var mount = element(b.mount, doc);
    var books = b.catalogs || null;

    function remembered() {
      if (!storage || typeof storage.getItem !== 'function') return null;
      try { return storage.getItem(key); } catch (err) { return null; }
    }

    function remember(locale) {
      if (!storage || typeof storage.setItem !== 'function') return;
      try { storage.setItem(key, locale); } catch (err) { /* private mode */ }
    }

    function loadBooks(locale) {
      if (books) return Promise.resolve(books);
      return Promise.all([load(locale), locale === core.DEFAULT_LOCALE ? Promise.resolve({}) : load(core.DEFAULT_LOCALE)])
        .then(function (loaded) {
          var catalogues = {};
          catalogues[core.DEFAULT_LOCALE] = loaded[1] || {};
          catalogues[locale] = loaded[0] || {};
          if (locale === core.DEFAULT_LOCALE) catalogues[locale] = loaded[0] || {};
          return catalogues;
        });
    }

    function render(current) {
      var resolved = core.resolveLocaleDetailed({
        requested: core.localeFromSearch(search),
        stored: remembered(),
        user: b.user && b.user.lang,
        org: b.org,
        navigator: navigatorLanguages
      });
      var locale = current || resolved.locale;
      var source = current ? 'choice' : resolved.source;
      return loadBooks(locale).then(function (catalogues) {
        var i18n = core.createI18n({ catalogs: catalogues, locale: locale });
        i18n.source = source;
        i18n.html = switcherHtml({ t: i18n.t, current: locale });
        if (doc) {
          if (doc.documentElement && typeof doc.documentElement.setAttribute === 'function') {
            doc.documentElement.setAttribute('lang', locale);
          }
          if (mount) mount.innerHTML = i18n.html;
          applyTranslations(doc, i18n.t);
        }
        wireSwitch(i18n);
        if (typeof b.onApply === 'function') b.onApply(i18n);
        return decorate(i18n);
      });
    }

    /**
     * Two re-resolution hooks the pages use after a login:
     *   `setUser(user)`  — the login response carries the org's default locale,
     *                      which should take effect unless the person already
     *                      picked a language (`?lang=` or the switcher);
     *   `setLocale(x)`   — an explicit choice, remembered like the switcher.
     */
    function decorate(i18n) {
      i18n.setUser = function (user) {
        b.user = user;
        b.org = user && user.locale;
        return render(null);
      };
      i18n.setLocale = function (locale) {
        var next = core.normalizeLocale(locale) || core.DEFAULT_LOCALE;
        remember(next);
        return render(next);
      };
      return i18n;
    }

    function wireSwitch(i18n) {
      var select = mount && typeof mount.querySelector === 'function' ? mount.querySelector('#langSwitcher') : null;
      if (!select || typeof select.addEventListener !== 'function') return;
      select.addEventListener('change', function () {
        var next = core.normalizeLocale(select.value) || core.DEFAULT_LOCALE;
        remember(next);
        render(next);
      });
    }

    var first = core.resolveLocaleDetailed({
      requested: core.localeFromSearch(search),
      stored: remembered(),
      user: b.user && b.user.lang,
      org: b.org,
      navigator: navigatorLanguages
    });
    // An explicit `?lang=` sticks: navigating between the pilot pages keeps it
    // without having to carry the parameter in every link.
    if (first.source === 'requested') remember(first.locale);
    return render(null);
  }

  /**
   * `window.localStorage`, or `null` when it is unavailable (private mode).
   * @returns {any|null}
   */
  function safeStorage() {
    try {
      if (typeof localStorage === 'undefined') return null;
      localStorage.getItem('__rwf_probe__');
      return localStorage;
    } catch (err) {
      return null;
    }
  }

  return {
    ATTRS: ATTRS,
    SELECTOR: SELECTOR,
    DEFAULT_STORAGE_KEY: DEFAULT_STORAGE_KEY,
    DEFAULT_BASE: DEFAULT_BASE,
    applyTranslations: applyTranslations,
    switcherHtml: switcherHtml,
    catalogLoader: catalogLoader,
    init: init
  };
});
