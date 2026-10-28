package com.elilaltd.roadwisefleet.core.auth

import com.elilaltd.roadwisefleet.core.data.remote.ApiResult
import com.elilaltd.roadwisefleet.core.model.AuthUser
import com.elilaltd.roadwisefleet.core.model.DeviceChallenge
import com.elilaltd.roadwisefleet.core.model.DeviceRegistration
import com.elilaltd.roadwisefleet.core.model.DeviceSession
import com.elilaltd.roadwisefleet.core.model.PasswordLogin
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The login gate's state machine (board #104 reopen), driven with a fake API,
 * a fake Keystore and an in-memory store — no device, no server, no Android.
 */
class AuthControllerTest {

    private val driver = AuthUser(
        id = "u1",
        name = "Dana Driver",
        roleId = "driver",
        orgId = "org1",
    )

    private class FakeApi : AuthApi {
        var loginResult: ApiResult<PasswordLogin> =
            ApiResult.HttpFailure(401, "invalid_credentials")
        var registerResult: ApiResult<DeviceRegistration> =
            ApiResult.Ok(DeviceRegistration("cred-1", "ES256", "Test Phone"))
        var challengeResult: ApiResult<DeviceChallenge> =
            ApiResult.Ok(DeviceChallenge("ch-1", "nonce-1", "ES256"))
        var verifyResult: ApiResult<DeviceSession> =
            ApiResult.Ok(DeviceSession("device-token", "u1", "cred-1"))
        var revokeResult: ApiResult<Unit> = ApiResult.Ok(Unit)
        var requestCodeResult: ApiResult<Unit> = ApiResult.Ok(Unit)
        var verifyCodeResult: ApiResult<PasswordLogin> =
            ApiResult.HttpFailure(401, "invalid_code")
        var deleteResult: ApiResult<Unit> = ApiResult.Ok(Unit)

        val logins = mutableListOf<Pair<String, String>>()
        val revoked = mutableListOf<String>()
        val codeRequests = mutableListOf<String>()
        val codeVerifications = mutableListOf<Pair<String, String>>()
        var deleteCalls = 0

        override suspend fun login(email: String, password: String): ApiResult<PasswordLogin> {
            logins += email to password
            return loginResult
        }

        override suspend fun registerDevice(
            publicKeyBase64: String,
            algorithm: String,
            deviceLabel: String?,
        ): ApiResult<DeviceRegistration> = registerResult

        override suspend fun deviceChallenge(credentialId: String): ApiResult<DeviceChallenge> =
            challengeResult

        override suspend fun deviceVerify(
            challengeId: String,
            signatureBase64: String,
        ): ApiResult<DeviceSession> = verifyResult

        override suspend fun revokeDevice(credentialId: String): ApiResult<Unit> {
            revoked += credentialId
            return revokeResult
        }

        override suspend fun requestEmailCode(email: String): ApiResult<Unit> {
            codeRequests += email
            return requestCodeResult
        }

        override suspend fun verifyEmailCode(email: String, code: String): ApiResult<PasswordLogin> {
            codeVerifications += email to code
            return verifyCodeResult
        }

        override suspend fun emailOtpAvailable(): ApiResult<Boolean> = ApiResult.Ok(true)

        override suspend fun deleteAccount(): ApiResult<Unit> {
            deleteCalls += 1
            return deleteResult
        }
    }

    private class FakeKeys(private val available: Boolean = true) : DeviceKeyMaterial {
        override fun publicKeySpkiBase64(): String? = if (available) "spki" else null
        override fun signNonce(nonceBase64: String): String? = if (available) "signature" else null
    }

    private class MemorySession : SessionStorage {
        override var token: String? = null
        override var credentialId: String? = null
        override var deviceLabel: String? = null
        override var userId: String? = null
        override var userName: String? = null
        override var roleId: String? = null
        override var orgId: String? = null
    }

    private fun controller(
        api: FakeApi,
        session: MemorySession,
        keys: FakeKeys = FakeKeys(),
    ) = AuthController(api, DeviceAuth(api, keys), session) { "Test Phone" }

    @Test
    fun `a fresh install starts on the login screen`() = runTest {
        val api = FakeApi()
        val session = MemorySession()
        val auth = controller(api, session)

        auth.start()

        assertEquals(AuthState.SignedOut(), auth.state.value)
    }

    @Test
    fun `a stored password session goes straight to the shell`() = runTest {
        val api = FakeApi()
        val session = MemorySession().apply {
            token = "token"
            userId = "u1"
            userName = "Dana Driver"
            roleId = "driver"
            orgId = "org1"
        }
        val auth = controller(api, session)

        auth.start()

        assertEquals(AuthState.SignedIn(driver), auth.state.value)
    }

    @Test
    fun `a stored credential re-logs in with no password`() = runTest {
        val api = FakeApi()
        val session = MemorySession().apply {
            token = "old-token"
            credentialId = "cred-1"
            userId = "u1"
            userName = "Dana Driver"
            roleId = "driver"
            orgId = "org1"
        }
        val auth = controller(api, session)

        auth.start()

        assertEquals("device-token", session.token)
        assertEquals(AuthState.SignedIn(driver), auth.state.value)
        assertTrue(api.logins.isEmpty())
    }

    @Test
    fun `a revoked credential clears the session and asks for a password`() = runTest {
        val api = FakeApi().apply {
            challengeResult = ApiResult.HttpFailure(403, "credential_revoked")
        }
        val session = MemorySession().apply {
            token = "old-token"
            credentialId = "cred-1"
            userId = "u1"
            userName = "Dana Driver"
            roleId = "driver"
        }
        val auth = controller(api, session)

        auth.start()

        assertNull(session.token)
        assertNull(session.credentialId)
        assertEquals(AuthState.SignedOut(AuthRules.NOTICE_SIGN_IN_AGAIN), auth.state.value)
    }

    @Test
    fun `password login persists the session, registers the device and opens the shell`() = runTest {
        val api = FakeApi().apply { loginResult = ApiResult.Ok(PasswordLogin("token-1", driver)) }
        val session = MemorySession()
        val auth = controller(api, session)

        val error = auth.signIn("  dana@example.com ", "secret")

        assertNull(error)
        assertEquals(listOf("dana@example.com" to "secret"), api.logins)
        assertEquals("token-1", session.token)
        assertEquals("cred-1", session.credentialId)
        assertEquals("Test Phone", session.deviceLabel)
        assertEquals(AuthState.SignedIn(driver), auth.state.value)
    }

    @Test
    fun `a failed Keystore registration keeps the password session and only warns`() = runTest {
        val api = FakeApi().apply { loginResult = ApiResult.Ok(PasswordLogin("token-1", driver)) }
        val session = MemorySession()
        val auth = controller(api, session, keys = FakeKeys(available = false))

        val error = auth.signIn("dana@example.com", "secret")

        assertNull(error)
        assertEquals("token-1", session.token)
        assertNull(session.credentialId)
        assertEquals(AuthState.SignedIn(driver, AuthRules.NOTICE_NO_PASSWORDLESS), auth.state.value)
    }

    @Test
    fun `invalid credentials show the inline error and persist nothing`() = runTest {
        val api = FakeApi().apply { loginResult = ApiResult.HttpFailure(401, "invalid_credentials") }
        val session = MemorySession()
        val auth = controller(api, session)

        assertEquals(AuthRules.ERROR_INVALID, auth.signIn("dana@example.com", "wrong"))
        assertNull(session.token)
        assertNull(session.credentialId)
    }

    @Test
    fun `a locked account and a network failure map to their own sentences`() = runTest {
        val locked = FakeApi().apply { loginResult = ApiResult.HttpFailure(423, "account_locked") }
        assertEquals(
            AuthRules.ERROR_LOCKED,
            controller(locked, MemorySession()).signIn("a@b.c", "x"),
        )

        val offline = FakeApi().apply { loginResult = ApiResult.NetworkFailure("offline") }
        assertEquals(
            AuthRules.ERROR_NETWORK,
            controller(offline, MemorySession()).signIn("a@b.c", "x"),
        )
    }

    @Test
    fun `a non-driver role is refused and its session is cleared`() = runTest {
        val owner = AuthUser("u2", "Olivia Owner", "owner", "org1")
        val api = FakeApi().apply { loginResult = ApiResult.Ok(PasswordLogin("owner-token", owner)) }
        val session = MemorySession()
        val auth = controller(api, session)
        auth.start()

        assertEquals(AuthRules.ERROR_NOT_DRIVER, auth.signIn("owner@example.com", "secret"))
        assertNull(session.token)
        assertNull(session.credentialId)
        assertEquals(AuthState.SignedOut(), auth.state.value)
        // The device must not be bound to an account that cannot use the app.
        assertTrue(api.revoked.isEmpty())
    }

    @Test
    fun `an empty form sends no request`() = runTest {
        val api = FakeApi()
        val auth = controller(api, MemorySession())

        assertEquals(AuthRules.ERROR_REQUIRED, auth.signIn("   ", "secret"))
        assertEquals(AuthRules.ERROR_REQUIRED, auth.signIn("dana@example.com", ""))
        assertTrue(api.logins.isEmpty())
    }

    // --- email one-time codes (board #125) -----------------------------------

    @Test
    fun `requesting a code opens the code screen without touching the session`() = runTest {
        val api = FakeApi()
        val session = MemorySession()
        val auth = controller(api, session)

        val error = auth.requestCode("  dana@example.com ")

        assertNull(error)
        assertEquals(listOf("dana@example.com"), api.codeRequests)
        assertEquals(AuthState.CodeEntry("dana@example.com", AuthRules.NOTICE_CODE_SENT), auth.state.value)
        assertNull(session.token)
    }

    @Test
    fun `an empty or malformed address sends no request`() = runTest {
        val api = FakeApi()
        val auth = controller(api, MemorySession())

        assertEquals(AuthRules.ERROR_REQUIRED, auth.requestCode("   "))
        assertEquals(AuthRules.ERROR_CODE_EMAIL, auth.requestCode("not-an-email"))
        assertTrue(api.codeRequests.isEmpty())
    }

    @Test
    fun `a code login persists the session, registers the device and opens the shell`() = runTest {
        val api = FakeApi().apply { verifyCodeResult = ApiResult.Ok(PasswordLogin("otp-token", driver)) }
        val session = MemorySession()
        val auth = controller(api, session)
        auth.requestCode("dana@example.com")

        val error = auth.verifyCode("dana@example.com", "123456")

        assertNull(error)
        assertEquals(listOf("dana@example.com" to "123456"), api.codeVerifications)
        assertEquals("otp-token", session.token)
        assertEquals("cred-1", session.credentialId)
        assertEquals(AuthState.SignedIn(driver), auth.state.value)
    }

    @Test
    fun `a wrong code stays on the code screen and persists nothing`() = runTest {
        val api = FakeApi().apply { verifyCodeResult = ApiResult.HttpFailure(401, "invalid_code") }
        val session = MemorySession()
        val auth = controller(api, session)
        auth.requestCode("dana@example.com")

        val error = auth.verifyCode("dana@example.com", "000000")

        assertEquals(AuthRules.ERROR_CODE, error)
        assertNull(session.token)
        assertNull(session.credentialId)
        assertEquals(AuthState.CodeEntry("dana@example.com", AuthRules.NOTICE_CODE_SENT), auth.state.value)
    }

    @Test
    fun `a short code never reaches the server`() = runTest {
        val api = FakeApi()
        val auth = controller(api, MemorySession())

        assertEquals(AuthRules.ERROR_CODE, auth.verifyCode("dana@example.com", "12"))
        assertTrue(api.codeVerifications.isEmpty())
    }

    @Test
    fun `the code field keeps only six digits`() = runTest {
        val api = FakeApi().apply { verifyCodeResult = ApiResult.Ok(PasswordLogin("otp-token", driver)) }
        val auth = controller(api, MemorySession())
        auth.requestCode("dana@example.com")

        assertNull(auth.verifyCode("dana@example.com", " 12 34 56 78 "))
        assertEquals(listOf("dana@example.com" to "123456"), api.codeVerifications)
    }

    @Test
    fun `code failures map to their own sentences`() = runTest {
        val locked = FakeApi().apply { verifyCodeResult = ApiResult.HttpFailure(423, "account_locked") }
        assertEquals(
            AuthRules.ERROR_LOCKED,
            controller(locked, MemorySession()).verifyCode("a@b.co", "123456"),
        )

        val limited = FakeApi().apply { verifyCodeResult = ApiResult.HttpFailure(429, "rate_limited") }
        assertEquals(
            AuthRules.ERROR_RATE_LIMITED,
            controller(limited, MemorySession()).verifyCode("a@b.co", "123456"),
        )

        val offline = FakeApi().apply { verifyCodeResult = ApiResult.NetworkFailure("offline") }
        assertEquals(
            AuthRules.ERROR_NETWORK,
            controller(offline, MemorySession()).verifyCode("a@b.co", "123456"),
        )

        val broken = FakeApi().apply { verifyCodeResult = ApiResult.HttpFailure(503, "http_error") }
        assertEquals(
            AuthRules.ERROR_SERVER,
            controller(broken, MemorySession()).verifyCode("a@b.co", "123456"),
        )
    }

    @Test
    fun `a code login for a non-driver role is refused and registers no device`() = runTest {
        val owner = AuthUser("u2", "Olivia Owner", "owner", "org1")
        val api = FakeApi().apply { verifyCodeResult = ApiResult.Ok(PasswordLogin("owner-token", owner)) }
        val session = MemorySession()
        val auth = controller(api, session)
        auth.requestCode("owner@example.com")

        assertEquals(AuthRules.ERROR_NOT_DRIVER, auth.verifyCode("owner@example.com", "123456"))
        assertNull(session.token)
        assertNull(session.credentialId)
        assertTrue(api.revoked.isEmpty())
    }

    @Test
    fun `cancelling the code screen returns to login`() = runTest {
        val auth = controller(FakeApi(), MemorySession())
        auth.requestCode("dana@example.com")

        auth.cancelCode()

        assertEquals(AuthState.SignedOut(), auth.state.value)
    }

    @Test
    fun `a rate-limited code request maps to the shared sentence`() = runTest {
        val api = FakeApi().apply { requestCodeResult = ApiResult.HttpFailure(429, "rate_limited") }
        val auth = controller(api, MemorySession())

        assertEquals(AuthRules.ERROR_RATE_LIMITED, auth.requestCode("dana@example.com"))
        assertEquals(AuthState.Restoring, auth.state.value)
    }

    @Test
    fun `sign out revokes the credential and returns to login`() = runTest {
        val api = FakeApi().apply { loginResult = ApiResult.Ok(PasswordLogin("token-1", driver)) }
        val session = MemorySession()
        val auth = controller(api, session)
        auth.signIn("dana@example.com", "secret")

        auth.signOut()

        assertEquals(listOf("cred-1"), api.revoked)
        assertNull(session.token)
        assertNull(session.credentialId)
        assertEquals(AuthState.SignedOut(), auth.state.value)
    }

    @Test
    fun `sign out still works when the revoke call fails`() = runTest {
        val api = FakeApi().apply {
            loginResult = ApiResult.Ok(PasswordLogin("token-1", driver))
            revokeResult = ApiResult.NetworkFailure("offline")
        }
        val session = MemorySession()
        val auth = controller(api, session)
        auth.signIn("dana@example.com", "secret")

        auth.signOut()

        assertNull(session.token)
        assertNull(session.credentialId)
        assertEquals(AuthState.SignedOut(), auth.state.value)
    }

    @Test
    fun `deleting the account clears the session and returns to login with a notice`() = runTest {
        val api = FakeApi().apply { loginResult = ApiResult.Ok(PasswordLogin("token-1", driver)) }
        val session = MemorySession()
        val auth = controller(api, session)
        auth.signIn("dana@example.com", "secret")

        val failure = auth.deleteAccount()

        assertNull(failure)
        assertEquals(1, api.deleteCalls)
        // The device credential is gone with the session: the server revoked
        // every credential of the account, so a local id would only be stale.
        assertNull(session.token)
        assertNull(session.credentialId)
        assertEquals(AuthState.SignedOut(AuthRules.NOTICE_DELETED), auth.state.value)
    }

    @Test
    fun `a failed deletion keeps the session so the driver can retry`() = runTest {
        val api = FakeApi().apply {
            loginResult = ApiResult.Ok(PasswordLogin("token-1", driver))
            deleteResult = ApiResult.NetworkFailure("offline")
        }
        val session = MemorySession()
        val auth = controller(api, session)
        auth.signIn("dana@example.com", "secret")

        val failure = auth.deleteAccount()

        assertEquals(AuthRules.ERROR_NETWORK, failure)
        assertEquals("token-1", session.token)
        assertEquals(AuthState.SignedIn(driver), auth.state.value)
    }

    @Test
    fun `an expired session is reported as sign in again, not a server error`() = runTest {
        val api = FakeApi().apply {
            loginResult = ApiResult.Ok(PasswordLogin("token-1", driver))
            deleteResult = ApiResult.HttpFailure(401, "unauthorized")
        }
        val session = MemorySession()
        val auth = controller(api, session)
        auth.signIn("dana@example.com", "secret")

        assertEquals(AuthRules.NOTICE_SIGN_IN_AGAIN, auth.deleteAccount())
        assertEquals("token-1", session.token)
    }
}
