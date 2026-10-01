package com.elilaltd.roadwisefleet.core.i18n

import android.content.Context
import org.json.JSONObject

/**
 * Loads the pilot's locale catalogues (board task #6). The four files under
 * `assets/locales/` are byte-identical copies of `pilot/locales/*.json`, so a
 * key the app uses carries the pilot's translation; `tools/check-locales.mjs`
 * proves the copies have not drifted.
 */
object Catalog {
    val SUPPORTED = listOf("en", "de", "pl", "tr")
    const val DEFAULT = "en"

    /** BCP-47 tags handed to the platform formatters, EU-first like the pilot. */
    val LOCALE_TAGS = mapOf(
        "en" to "en-GB",
        "de" to "de-DE",
        "pl" to "pl-PL",
        "tr" to "tr-TR",
    )

    /** The language name shown *in that language*. */
    val LABELS = mapOf(
        "en" to "English",
        "de" to "Deutsch",
        "pl" to "Polski",
        "tr" to "Türkçe",
    )

    /** Reduce any language tag to a supported base language, else `null`. */
    fun normalize(value: String?): String? {
        if (value.isNullOrBlank()) return null
        val base = value.trim().lowercase().replace('_', '-').substringBefore('-')
        return if (SUPPORTED.contains(base)) base else null
    }

    /** Parse one catalogue. Non-string values are ignored, never coerced. */
    fun parse(json: String): Map<String, String> {
        val root = JSONObject(json)
        val out = LinkedHashMap<String, String>()
        val keys = root.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            val value = root.opt(key)
            if (value is String) out[key] = value
        }
        return out
    }

    /** Read a catalogue from `assets/<assetDir>/<lang>.json`; empty on failure. */
    fun load(context: Context, assetDir: String, locale: String): Map<String, String> {
        val lang = normalize(locale) ?: DEFAULT
        return try {
            val text = context.assets.open("$assetDir/$lang.json").bufferedReader().use { it.readText() }
            parse(text)
        } catch (t: Throwable) {
            emptyMap()
        }
    }
}
