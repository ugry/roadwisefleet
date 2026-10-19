package com.elilaltd.roadwisefleet.core.auth

import com.elilaltd.roadwisefleet.core.data.remote.ApiResult

/**
 * Pure auth rules (board #104 reopen): the role gate, the launch decision, the
 * device label and the error -> catalogue-key mapping. No Android types, so
 * every branch is pinned by a JVM unit test.
 */
object AuthRules {
    /**
     * Roles allowed into the driver app.
     *
     * `driver` is the fleet role (`reference-data.js`) and `solo` is the solo
     * driver role (`solo.SOLO_ROLE` in the API). `solo_driver` is accepted too
     * because the account-type vocabulary uses it; the server never issues it
     * as a `roleId` today, and accepting it cannot widen access (it is the same
     * person's own account).
     */
    val DRIVER_ROLES = setOf("driver", "solo", "solo_driver")

    const val ERROR_REQUIRED = "auth.error.required"
    const val ERROR_INVALID = "auth.error.invalid"
    const val ERROR_LOCKED = "auth.error.locked"
    const val ERROR_NETWORK = "auth.error.network"
    const val ERROR_SERVER = "auth.error.server"
    const val ERROR_RATE_LIMITED = "auth.error.rateLimited"
    const val ERROR_NOT_DRIVER = "auth.error.notDriver"
    const val NOTICE_NO_PASSWORDLESS = "auth.notice.passwordless"
    const val NOTICE_SIGN_IN_AGAIN = "auth.notice.signInAgain"

    fun isDriverRole(roleId: String?): Boolean = roleId != null && roleId in DRIVER_ROLES

    /**
     * Which screen a launch starts on (the decision is pure so it is testable):
     *  - no token -> login;
     *  - token + credential id -> try passwordless first;
     *  - token only -> the shell (a password session whose Keystore
     *    registration failed at login, per the auth-flow diagram).
     */
    fun gateStart(token: String?, credentialId: String?): GateStart = when {
        token.isNullOrBlank() -> GateStart.SignedOut
        !credentialId.isNullOrBlank() -> GateStart.Passwordless(credentialId)
        else -> GateStart.SignedIn
    }

    /** Map a login HTTP status/code to the sentence the form shows. */
    fun loginErrorKey(status: Int, error: String? = null): String = when {
        // Machine codes win over the status: a future proxy/status change must
        // not turn "account locked" into "wrong password".
        status == 423 || error == "account_locked" -> ERROR_LOCKED
        status == 429 || error == "rate_limited" -> ERROR_RATE_LIMITED
        status == 0 -> ERROR_NETWORK
        status == 401 -> ERROR_INVALID
        status >= 500 -> ERROR_SERVER
        // 400/403/404 from /auth/login are all "these credentials do not work" to
        // the driver; never surface a machine code on the phone.
        else -> ERROR_INVALID
    }

    /** `null` for success, else the catalogue key for the failure. */
    fun failureKey(result: ApiResult<*>): String? = when (result) {
        is ApiResult.Ok -> null
        is ApiResult.NetworkFailure -> ERROR_NETWORK
        is ApiResult.HttpFailure ->
            if (result.status == 0) ERROR_NETWORK else loginErrorKey(result.status, result.error)
    }

    /**
     * `Manufacturer Model`, trimmed to the backend's 80-char limit
     * (`MAX_DEVICE_LABEL_LENGTH`). Never includes anything identifying beyond
     * the hardware model.
     */
    fun deviceLabel(manufacturer: String?, model: String?): String {
        val parts = listOf(manufacturer, model)
            .mapNotNull { it?.trim()?.takeIf(String::isNotEmpty) }
        return parts.joinToString(" ").ifBlank { "Android device" }.take(MAX_LABEL)
    }

    private const val MAX_LABEL = 80
}

/** Where a launch starts. */
sealed interface GateStart {
    data object SignedOut : GateStart
    data object SignedIn : GateStart
    data class Passwordless(val credentialId: String) : GateStart
}
