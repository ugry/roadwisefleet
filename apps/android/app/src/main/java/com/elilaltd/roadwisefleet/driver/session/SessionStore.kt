package com.elilaltd.roadwisefleet.driver.session

import android.content.Context
import android.content.SharedPreferences

/**
 * The signed-in driver's session (board #103, AND1-A1). Private app storage
 * only — never the repo, never a log. A2 (#104) replaces the bearer token here
 * with a Keystore-backed device credential; the interface stays the same.
 */
class SessionStore(context: Context) {
    private val prefs: SharedPreferences =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    var token: String?
        get() = prefs.getString(KEY_TOKEN, null)
        set(value) = prefs.edit().putString(KEY_TOKEN, value).apply()

    var deviceLabel: String?
        get() = prefs.getString(KEY_DEVICE, null)
        set(value) = prefs.edit().putString(KEY_DEVICE, value).apply()

    var locale: String?
        get() = prefs.getString(KEY_LOCALE, null)
        set(value) = prefs.edit().putString(KEY_LOCALE, value).apply()

    private companion object {
        const val PREFS_NAME = "roadwisefleet.driver.session"
        const val KEY_TOKEN = "token"
        const val KEY_DEVICE = "deviceLabel"
        const val KEY_LOCALE = "locale"
    }
}
