package com.elilaltd.roadwisefleet.core.auth

import com.elilaltd.roadwisefleet.core.data.remote.ApiResult
import com.elilaltd.roadwisefleet.core.model.AuthUser
import com.elilaltd.roadwisefleet.core.model.PasswordLogin
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** What the app should show. */
sealed interface AuthState {
    /** Reading the stored session / trying the device credential. */
    data object Restoring : AuthState

    /** The login screen. [noticeKey] is an optional sentence (e.g. "sign in again"). */
    data class SignedOut(val noticeKey: String? = null) : AuthState

    /** The 6-digit code screen (board #125). [noticeKey] confirms the send. */
    data class CodeEntry(val email: String, val noticeKey: String? = null) : AuthState

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
 *   requestCode() / verifyCode() — the SAME gate and device registration, fed by
 *               an emailed one-time code instead of a password (board #125).
 *   signOut() — best-effort revoke -> clear session + credential -> login.
 *   deleteAccount() — board #142: the Play-required deletion. The API call runs
 *               with the CURRENT token, then the session and the device
 *               credential are dropped and the login screen explains what
 *               happened. A failure keeps the session so the driver can retry.
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

    /**
     * Whether the server has a working email sender (#124). Starts `true` and
     * only flips when the server says otherwise: a network blip must never hide
     * a button that works, and a hidden button is the fail-closed UX when the
     * `AUTH_EMAIL_*` credential is absent.
     */
    private val _codeAvailable = MutableStateFlow(true)
    val codeAvailable: StateFlow<Boolean> = _codeAvailable.asStateFlow()

    /** Ask the server once per login screen; failures leave the state alone. */
    suspend fun probeCodeAvailability() {
        when (val result = api.emailOtpAvailable()) {
            is ApiResult.Ok -> _codeAvailable.value = result.value
            else -> Unit
        }
    }

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
        return completeSignIn((result as ApiResult.Ok).value)
    }

    /**
     * Everything after ANY successful first authentication (password or email
     * code): the role gate, the session, the device key and the shell.
     */
    private suspend fun completeSignIn(login: PasswordLogin): String? {
        if (!AuthRules.isDriverRole(login.user.roleId)) {
            session.clear()
            return AuthRules.ERROR_NOT_DRIVER
        }

        // The session is valid from here on: the app must never be locked out
        // because the Keystore or the registration call failed.
        session.save(login.token, login.user)
        val notice = registerDevice()
        _state.value = AuthState.SignedIn(login.user, notice)
        return null
    }

    /**
     * Ask for a sign-in code (board #125). Returns `null` once the code screen
     * should be shown, else the catalogue key the login form displays.
     *
     * The address is validated locally first: an empty/invalid address never
     * costs a request. The server's answer is deliberately generic, so success
     * here means "a code exists if this account does", not "sent".
     */
    suspend fun requestCode(email: String): String? {
        val normalized = email.trim()
        if (normalized.isEmpty()) return AuthRules.ERROR_REQUIRED
        if (!normalized.contains('@') || normalized.contains(' ')) return AuthRules.ERROR_CODE_EMAIL

        return when (val result = api.requestEmailCode(normalized)) {
            is ApiResult.Ok -> {
                _state.value = AuthState.CodeEntry(normalized, AuthRules.NOTICE_CODE_SENT)
                null
            }
            is ApiResult.NetworkFailure -> AuthRules.ERROR_NETWORK
            is ApiResult.HttpFailure ->
                if (result.status == 0) AuthRules.ERROR_NETWORK
                else AuthRules.requestErrorKey(result.status, result.error)
        }
    }

    /**
     * Redeem the emailed code. Exactly the same post-login work as [signIn]:
     * role gate, session, best-effort device registration, then the shell.
     * On failure the app STAYS on the code screen so the driver can retry or
     * resend — a wrong digit must never drop them back a step.
     */
    suspend fun verifyCode(email: String, code: String): String? {
        val normalizedCode = AuthRules.normalizeCode(code)
        if (!AuthRules.isCompleteCode(normalizedCode)) return AuthRules.ERROR_CODE

        return when (val result = api.verifyEmailCode(email.trim(), normalizedCode)) {
            is ApiResult.Ok -> completeSignIn(result.value)
            is ApiResult.NetworkFailure -> AuthRules.ERROR_NETWORK
            is ApiResult.HttpFailure ->
                if (result.status == 0) AuthRules.ERROR_NETWORK
                else AuthRules.codeErrorKey(result.status, result.error)
        }
    }

    /** Leave the code screen for the password form (the code stays valid). */
    fun cancelCode() {
        if (_state.value is AuthState.CodeEntry) _state.value = AuthState.SignedOut()
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
     * Delete the signed-in account (board #142). Returns `null` on success, else
     * the catalogue key the screen shows.
     *
     * The server call happens FIRST: the route authenticates with the session
     * token, and the local session must survive a failed call (a network blip
     * must not silently look like a deletion). Only a confirmed 200 clears the
     * session — and it clears the device credential with it, because the server
     * has just revoked every credential of this account anyway.
     */
    suspend fun deleteAccount(): String? {
        return when (val result = api.deleteAccount()) {
            is ApiResult.Ok -> {
                session.clear()
                _state.value = AuthState.SignedOut(AuthRules.NOTICE_DELETED)
                null
            }
            is ApiResult.NetworkFailure -> AuthRules.ERROR_NETWORK
            is ApiResult.HttpFailure ->
                if (result.status == 0) AuthRules.ERROR_NETWORK
                else AuthRules.deleteErrorKey(result.status, result.error)
        }
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
