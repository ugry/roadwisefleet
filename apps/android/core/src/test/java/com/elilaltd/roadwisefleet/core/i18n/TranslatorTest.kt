package com.elilaltd.roadwisefleet.core.i18n

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The translator rules of the scaffold (board #103, AND1-A1), mirroring the
 * pilot's `i18n.js`: fallback chain, `{placeholder}` interpolation and a
 * plural lookup that falls back to the plain key when no plural form exists.
 */
class TranslatorTest {

    private val active = mapOf(
        "driver.sync.pending.one" to "1 change waiting to sync",
        "driver.sync.pending.other" to "{count} changes waiting to sync",
        "driver.sync.synced" to "All changes synced",
        "driver.confirmStatus" to "Confirm: mark this trip as {status}?",
    )
    private val fallback = mapOf("driver.fallback" to "English only")

    private fun translator(locale: String = "de") = Translator(active, fallback, locale)

    @Test
    fun `an unknown key returns the key itself, never blank`() {
        assertEquals("driver.missing", translator().t("driver.missing"))
        assertTrue(translator().missing.contains("driver.missing"))
    }

    @Test
    fun `the fallback catalogue is used before the key`() {
        assertEquals("English only", translator().t("driver.fallback"))
    }

    @Test
    fun `placeholders are interpolated`() {
        assertEquals(
            "Confirm: mark this trip as Delivered?",
            translator().t("driver.confirmStatus", mapOf("status" to "Delivered")),
        )
    }

    @Test
    fun `an unknown placeholder is left visible`() {
        assertEquals("Confirm: mark this trip as {status}?", translator().t("driver.confirmStatus"))
    }

    @Test
    fun `a plural count selects the matching form`() {
        assertEquals("1 change waiting to sync", translator().plural("driver.sync.pending", 1))
        assertEquals("2 changes waiting to sync", translator().plural("driver.sync.pending", 2))
    }

    @Test
    fun `a key without plural forms falls back to the plain key`() {
        assertEquals("All changes synced", translator().plural("driver.sync.synced", 3))
    }

    @Test
    fun `locale normalisation accepts regional and underscore tags`() {
        assertEquals("de", Catalog.normalize("de-AT"))
        assertEquals("pl", Catalog.normalize("PL"))
        assertEquals("tr", Catalog.normalize("tr_TR"))
        assertEquals(null, Catalog.normalize("fr"))
        assertEquals(null, Catalog.normalize(""))
    }

    @Test
    fun `locale resolution follows the pilot precedence`() {
        assertEquals("pl", I18n.resolveLocale(requested = "pl", stored = "de", device = "tr"))
        assertEquals("de", I18n.resolveLocale(requested = "fr", stored = "de", device = "tr"))
        assertEquals("tr", I18n.resolveLocale(device = "tr"))
        assertEquals("en", I18n.resolveLocale(device = "fr"))
        assertFalse(Catalog.SUPPORTED.isEmpty())
    }
}
