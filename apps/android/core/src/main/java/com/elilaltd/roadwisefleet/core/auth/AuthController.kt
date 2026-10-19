package com.elilaltd.roadwisefleet.core.auth

import com.elilaltd.roadwisefleet.core.data.remote.ApiResult
import com.elilaltd.roadwisefleet.core.model.AuthUser
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** What the app should show. */
sealed interface AuthState {
    /** Reading the stored session / trying the device credential. */
    data object Restoring : AuthState

    /** The login screen. [noticeKey] is an optional sentence (e.g. "sign in again"). */
    data class SignedOut(val noticeKey: String? = null) : AuthState

    /** The shell, for a driver. [noticeKey] is a non-blocking banner. */
    data class SignedIn(val user: AuthUser, val noticeKey: String? = null) : AuthState
}

/**
 * The auth state machine (board #104 reopen):
 *
 *   start()   — restore the session, or passwordless re-login when a device
 *               credential is stored; a failed/revoked credential is cleared
 *               and the login screen is shown.
 *   signIn()  — password login -> role gate -> persist -> best-effort device
 *               registration (`credentialId` + label) -> shell.
 *   signOut() — best-effort revoke -> clear session + credential -> login.
 *
 * Everything it calls is an interface, so the whole machine is unit-tested with
 * a fake API, a fake key material and an in-memory store.
 */
class AuthController(
    private val api: AuthApi,
    private val deviceAuth: DeviceAuth,
    private val session: SessionStorage,
    private val deviceLabel: () -> String,
) {
    private val _state = MutableStateFlow<AuthState>(AuthState.Restoring)
    val state: StateFlow<AuthState> = _state.asStateFlow()

    /** Restore once per app process; later calls are no-ops. */
    suspend fun start() {
        if (_state.value !is AuthState.Restoring) return
        when (val gate = AuthRules.gateStart(session.token, session.credentialId)) {
            GateStart.SignedOut -> _state.value = AuthState.SignedOut()

            GateStart.SignedIn -> {
                val user = storedUser()
                if (user == null || !AuthRules.isDriverRole(user.roleId)) {
                    session.clear()
                    _state.value = AuthState.SignedOut(AuthRules.ERROR_NOT_DRIVER)
                } else {
                    _state.value = AuthState.SignedIn(user)
                }
            }

            is GateStart.Passwordless -> {
                // The password never prompted on this launch: challenge -> sign
                // -> verify. Any failure means the credential is gone, revoked
                // or expired, so it is dropped and the password login is shown.
                val result = deviceAuth.authenticate(gate.credentialId)
                val user = storedUser()
                if (result is ApiResult.Ok && user != null && AuthRules.isDriverRole(user.roleId)) {
                    session.token = result.value.token
                    _state.value = AuthState.SignedIn(user)
                } else {
                    session.clear()
                    _state.value = AuthState.SignedOut(AuthRules.NOTICE_SIGN_IN_AGAIN)
                }
            }
        }
    }

    /**
     * Password sign-in. Returns `null` on success, else the catalogue key the
     * form shows. On a non-driver role the session is cleared and the caller
     * renders the refusal.
     */
    suspend fun signIn(email: String, password: String): String? {
        val normalizedEmail = email.trim()
        if (normalizedEmail.isEmpty() || password.isEmpty()) return AuthRules.ERROR_REQUIRED

        val result = api.login(normalizedEmail, password)
        val failure = AuthRules.failureKey(result)
        if (failure != null) return failure
        val login = (result as ApiResult.Ok).value

        if (!AuthRules.isDriverRole(login.user.roleId)) {
            session.clear()
            return AuthRules.ERROR_NOT_DRIVER
        }

        // The password session is valid from here on: the app must never be
        // locked out because the Keystore or the registration call failed.
        session.save(login.token, login.user)
        val notice = registerDevice()
        _state.value = AuthState.SignedIn(login.user, notice)
        return null
    }

    /** Revoke best-effort, then drop the session and return to the login screen. */
    suspend fun signOut() {
        session.credentialId?.let { credentialId ->
            // Offline sign-out must still work: the local credential is removed
            // regardless, and the server-side revoke is retried by nothing — the
            // lost-phone revoke path (docs/android-architecture.md §9a) remains
            // available to the dispatcher.
            api.revokeDevice(credentialId)
        }
        session.clear()
        _state.value = AuthState.SignedOut()
    }

    /**
     * Bind this device to the signed-in driver. A Keystore or API failure is a
     * non-blocking notice, never a failed login.
     */
    private suspend fun registerDevice(): String? {
        val label = deviceLabel()
        return when (val registered = deviceAuth.register(label)) {
            is ApiResult.Ok -> {
                session.credentialId = registered.value.credentialId
                session.deviceLabel = registered.value.deviceLabel ?: label
                null
            }
            else -> AuthRules.NOTICE_NO_PASSWORDLESS
        }
    }

    private fun storedUser(): AuthUser? {
        val id = session.userId ?: return null
        return AuthUser(
            id = id,
            name = session.userName.orEmpty(),
            roleId = session.roleId.orEmpty(),
            orgId = session.orgId,
        )
    }
}
