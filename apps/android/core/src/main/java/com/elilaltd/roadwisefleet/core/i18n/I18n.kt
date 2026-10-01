package com.elilaltd.roadwisefleet.core.i18n

import android.content.Context
import android.icu.text.PluralRules
import java.util.Locale

/**
 * Pure translation core, mirroring `pilot/lib/i18n.js#createTranslator`
 * (board #103, AND1-A1). No Android types, so it is JVM-unit-testable; the
 * only platform call is the CLDR plural rule, which falls back safely.
 */
object I18n {
    /**
     * Resolution precedence (same as the pilot): an explicit request, then the
     * remembered choice, then the user's own language, then the org default,
     * then the device language, then English. An unsupported value is skipped,
     * never obeyed.
     */
    fun resolveLocale(
        requested: String? = null,
        stored: String? = null,
        user: String? = null,
        org: String? = null,
        device: String? = null,
        fallback: String? = null,
    ): String {
        for (candidate in listOf(requested, stored, user, org, device)) {
            Catalog.normalize(candidate)?.let { return it }
        }
        return Catalog.normalize(fallback) ?: Catalog.DEFAULT
    }

    /**
     * CLDR plural category. Polish needs one/few/many (`1 zmiana`, `2 zmiany`,
     * `5 zmian`) — a `count == 1 ? one : other` shortcut would be wrong. On a
     * device the platform decides; if it is unavailable, fall back to one/other.
     */
    fun pluralCategory(locale: String, count: Int): String {
        val tag = Catalog.LOCALE_TAGS[Catalog.normalize(locale) ?: Catalog.DEFAULT] ?: "en-GB"
        return try {
            PluralRules.forLocale(Locale.forLanguageTag(tag)).select(count.toDouble())
        } catch (t: Throwable) {
            if (count == 1) "one" else "other"
        }
    }

    /** `{name}` placeholders. An unknown placeholder is left visible. */
    fun interpolate(template: String, params: Map<String, Any?>): String {
        if (params.isEmpty()) return template
        return PLACEHOLDER.replace(template) { match ->
            val name = match.groupValues[1]
            if (params.containsKey(name)) params[name]?.toString() ?: match.value else match.value
        }
    }

    /** Open a translator for one locale from the app's assets. */
    fun translator(context: Context, assetDir: String, locale: String): Translator {
        val lang = Catalog.normalize(locale) ?: Catalog.DEFAULT
        return Translator(
            active = Catalog.load(context, assetDir, lang),
            fallback = Catalog.load(context, assetDir, Catalog.DEFAULT),
            locale = lang,
        )
    }

    private val PLACEHOLDER = Regex("\\{(\\w+)\\}")
}

/**
 * `t(key, params)` looks the key up in the active catalogue, then English, then
 * returns the key itself (never a blank line). With a numeric `count` it tries
 * the CLDR plural key (`key.one`, `key.few`, …) before `key.other`.
 */
class Translator(
    private val active: Map<String, String>,
    private val fallback: Map<String, String>,
    val locale: String,
) {
    private val _missing = LinkedHashSet<String>()
    val missing: List<String> get() = _missing.toList()

    fun t(key: String, params: Map<String, Any?> = emptyMap()): String {
        val count = (params["count"] as? Number)?.toInt()
        var value: String? = null
        if (count != null) {
            val category = I18n.pluralCategory(locale, count)
            value = active["$key.$category"] ?: active["$key.other"]
                ?: fallback["$key.$category"] ?: fallback["$key.other"]
        }
        if (value == null) value = active[key]
        if (value == null) value = fallback[key]
        if (value == null) {
            _missing.add(key)
            return key
        }
        return I18n.interpolate(value, params)
    }

    fun has(key: String): Boolean = active[key] != null || fallback[key] != null

    /** `count` for a plural key, so callers never build the params map by hand. */
    fun plural(key: String, count: Int): String = t(key, mapOf("count" to count))
}
