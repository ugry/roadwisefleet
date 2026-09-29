/**
 * Locale resolution for the API (board task #6, i18n scaffolding).
 *
 * The pilot UI ships four catalogues — EN/DE/PL/TR — under `pilot/locales/`.
 * The server's job is the *default*: which language a driver or dispatcher
 * should get before they have made a choice of their own.
 *
 * `Org.locale` is the tenant default (schema already carries it); `User.lang` is
 * the person's own preference. Both are free-text columns, so an unexpected
 * value (`fr`, `de-DE`, an empty string) must never reach the UI — it is
 * normalised and, if unsupported, skipped in favour of the next candidate.
 *
 * The browser side of the same contract is `pilot/lib/i18n.js`;
 * `src/i18n.test.js` fails if the two ever drift apart.
 */

/** The four languages the strategy mandates. */
export const SUPPORTED_LOCALES = Object.freeze(['en', 'de', 'pl', 'tr']);

/** Fallback for every unsupported or missing value. */
export const DEFAULT_LOCALE = 'en';

/**
 * Reduce any language tag to a supported base language, else `null`.
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeLocale(value) {
  if (typeof value !== 'string') return null;
  const tag = value.trim().toLowerCase().replace(/_/g, '-');
  if (!tag) return null;
  const base = tag.split('-')[0];
  return SUPPORTED_LOCALES.includes(base) ? base : null;
}

/**
 * The locale a principal should see, and where that answer came from.
 * Order: an explicit request, the user's own language, the org default, then en.
 * @param {{ requested?: unknown, user?: unknown, org?: unknown, fallback?: unknown }} [input]
 * @returns {{ locale: string, source: string }}
 */
export function resolveLocale(input = {}) {
  const candidates = /** @type {const} */ ([
    ['requested', input.requested],
    ['user', input.user],
    ['org', input.org],
  ]);
  for (const [source, value] of candidates) {
    const picked = normalizeLocale(value);
    if (picked) return { locale: picked, source };
  }
  return { locale: normalizeLocale(input.fallback) ?? DEFAULT_LOCALE, source: 'fallback' };
}

/**
 * The i18n half of a login response: the org default, plus the user's own
 * preference when it is one we actually ship.
 * @param {{ orgLocale?: unknown, userLang?: unknown }} input
 * @returns {{ locale: string, lang: string | null, source: string, supported: string[] }}
 */
export function localePayload(input = {}) {
  const resolved = resolveLocale({ user: input.userLang, org: input.orgLocale });
  return {
    locale: resolved.locale,
    lang: normalizeLocale(input.userLang),
    source: resolved.source,
    supported: [...SUPPORTED_LOCALES],
  };
}
