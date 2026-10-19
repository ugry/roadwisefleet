package com.elilaltd.roadwisefleet.driver.session

import android.content.Context
import android.content.SharedPreferences
import com.elilaltd.roadwisefleet.core.auth.SessionStorage

/**
 * The signed-in driver's session (board #103, AND1-A1; extended by the #104
 * reopen). Private app storage only — never the repo, never a log.
 *
 * `credentialId` is the A2 device credential returned by
 * `POST /api/auth/device/register`. Its presence is exactly what enables
 * passwordless re-login, so it is removed together with the token on sign-out,
 * on a role refusal and when a stored credential stops authenticating.
 */
class SessionStore(context: Context) : SessionStorage {
    private val prefs: SharedPreferences =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    override var token: String?
        get() = prefs.getString(KEY_TOKEN, null)
        set(value) = prefs.edit().putString(KEY_TOKEN, value).apply()

    override var credentialId: String?
        get() = prefs.getString(KEY_CREDENTIAL, null)
        set(value) = prefs.edit().putString(KEY_CREDENTIAL, value).apply()

    override var deviceLabel: String?
        get() = prefs.getString(KEY_DEVICE, null)
        set(value) = prefs.edit().putString(KEY_DEVICE, value).apply()

    override var userId: String?
        get() = prefs.getString(KEY_USER_ID, null)
        set(value) = prefs.edit().putString(KEY_USER_ID, value).apply()

    override var userName: String?
        get() = prefs.getString(KEY_USER_NAME, null)
        set(value) = prefs.edit().putString(KEY_USER_NAME, value).apply()

    override var roleId: String?
        get() = prefs.getString(KEY_ROLE, null)
        set(value) = prefs.edit().putString(KEY_ROLE, value).apply()

    override var orgId: String?
        get() = prefs.getString(KEY_ORG, null)
        set(value) = prefs.edit().putString(KEY_ORG, value).apply()

    /** The driver's own language choice; kept across a sign-out on purpose. */
    var locale: String?
        get() = prefs.getString(KEY_LOCALE, null)
        set(value) = prefs.edit().putString(KEY_LOCALE, value).apply()

    /**
     * Remove every session key but keep the language choice. Explicit removes,
     * not `clear()`: signing out must not reset the phone's language.
     */
    override fun clear() {
        prefs.edit()
            .remove(KEY_TOKEN)
            .remove(KEY_CREDENTIAL)
            .remove(KEY_DEVICE)
            .remove(KEY_USER_ID)
            .remove(KEY_USER_NAME)
            .remove(KEY_ROLE)
            .remove(KEY_ORG)
            .apply()
    }

    private companion object {
        const val PREFS_NAME = "roadwisefleet.driver.session"
        const val KEY_TOKEN = "token"
        const val KEY_CREDENTIAL = "credentialId"
        const val KEY_DEVICE = "deviceLabel"
        const val KEY_USER_ID = "userId"
        const val KEY_USER_NAME = "userName"
        const val KEY_ROLE = "roleId"
        const val KEY_ORG = "orgId"
        const val KEY_LOCALE = "locale"
    }
}
