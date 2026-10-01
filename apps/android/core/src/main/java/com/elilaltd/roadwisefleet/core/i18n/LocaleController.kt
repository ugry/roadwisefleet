package com.elilaltd.roadwisefleet.core.i18n

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Holds the active locale for the process and builds a [Translator] from the
 * shared catalogues. The choice is made once from the same precedence the pilot
 * uses; the shell's language menu calls [set].
 */
class LocaleController(
    context: Context,
    private val assetDir: String,
    stored: String?,
    device: String?,
) {
    private val appContext = context.applicationContext
    private val _locale = MutableStateFlow(I18n.resolveLocale(stored = stored, device = device))
    val locale: StateFlow<String> = _locale.asStateFlow()

    fun translator(): Translator = I18n.translator(appContext, assetDir, _locale.value)

    fun set(locale: String) {
        Catalog.normalize(locale)?.let { _locale.value = it }
    }

    fun current(): String = _locale.value
}
