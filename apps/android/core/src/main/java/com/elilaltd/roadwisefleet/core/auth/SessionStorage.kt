package com.elilaltd.roadwisefleet.core.auth

import com.elilaltd.roadwisefleet.core.model.AuthUser

/**
 * The persisted session the auth gate and the login flow read and write
 * (board #104 reopen).
 *
 * Implemented by `SessionStore` (private SharedPreferences) in `:app`, and by
 * an in-memory fake in the JVM tests. Keeping it an interface is what makes the
 * session/role/gate rules testable without Android.
 *
 * `credentialId` is the A2 device credential: present only when this device
 * completed a Keystore registration, which is what enables passwordless
 * re-login.
 */
interface SessionStorage {
    var token: String?
    var credentialId: String?
    var deviceLabel: String?
    var userId: String?
    var userName: String?
    var roleId: String?
    var orgId: String?

    /** Persist a password or device session in one step. */
    fun save(token: String, user: AuthUser) {
        this.token = token
        userId = user.id
        userName = user.name
        roleId = user.roleId
        orgId = user.orgId
    }

    /**
     * Drop the session AND the device credential. Used on sign-out, on a
     * non-driver refusal and when a stored credential no longer authenticates —
     * so the next launch asks for a password.
     */
    fun clear() {
        token = null
        credentialId = null
        deviceLabel = null
        userId = null
        userName = null
        roleId = null
        orgId = null
    }
}
