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
 * AND1-QA3 (board #128) — QA-owned acceptance coverage of the #104 auth GATE
 * (`AuthController`), at merge `b4c5862`.
 *
 * Scope is the acceptance criteria, not the developer's unit list:
 *   - fresh install -> login screen (and the shell is never opened early)
 *   - invalid credentials -> inline error, nothing persisted
 *   - driver / solo -> shell; non-driver -> refused, session cleared
 *   - passwordless re-login via the Keystore credential (and every failure path)
 *   - sign-out revokes and clears
 *
 * Fakes are local to this file so the QA suite can never be satisfied by a
 * change the developer makes to their own fake.
 */
class AuthControllerQaTest {

    private val driver = AuthUser("u1", "Dana Driver", "driver", "org1")

    private class FakeApi : AuthApi {
        var loginResult: ApiResult<PasswordLogin> = ApiResult.HttpFailure(401, "invalid_credentials")
        var registerResult: ApiResult<DeviceRegistration> =
            ApiResult.Ok(DeviceRegistration("cred-1", "ES256", "Test Phone"))
        var challengeResult: ApiResult<DeviceChallenge> =
            ApiResult.Ok(DeviceChallenge("ch-1", "nonce-1", "ES256"))
        var verifyResult: ApiResult<DeviceSession> =
            ApiResult.Ok(DeviceSession("device-token", "u1", "cred-1"))
        var revokeResult: ApiResult<Unit> = ApiResult.Ok(Unit)
        var codeAvailableResult: ApiResult<Boolean> = ApiResult.Ok(true)

        val logins = mutableListOf<Pair<String, String>>()
        val revoked = mutableListOf<String>()
        var registerCalls = 0
        var challengeCalls = 0
        var verifyCalls = 0

        override suspend fun login(email: String, password: String): ApiResult<PasswordLogin> {
            logins += email to password
            return loginResult
        }

        override suspend fun registerDevice(
            publicKeyBase64: String,
            algorithm: String,
            deviceLabel: String?,
        ): ApiResult<DeviceRegistration> {
            registerCalls++
            return registerResult
        }

        override suspend fun deviceChallenge(credentialId: String): ApiResult<DeviceChallenge> {
            challengeCalls++
            return challengeResult
        }

        override suspend fun deviceVerify(
            challengeId: String,
            signatureBase64: String,
        ): ApiResult<DeviceSession> {
            verifyCalls++
            return verifyResult
        }

        override suspend fun revokeDevice(credentialId: String): ApiResult<Unit> {
            revoked += credentialId
            return revokeResult
        }

        override suspend fun requestEmailCode(email: String): ApiResult<Unit> = ApiResult.Ok(Unit)

        override suspend fun verifyEmailCode(email: String, code: String): ApiResult<PasswordLogin> =
            ApiResult.HttpFailure(401, "invalid_code")

        override suspend fun emailOtpAvailable(): ApiResult<Boolean> = codeAvailableResult
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

    private fun signedInSession() = MemorySession().apply {
        token = "old-token"
        credentialId = "cred-1"
        deviceLabel = "Test Phone"
        userId = "u1"
        userName = "Dana Driver"
        roleId = "driver"
        orgId = "org1"
    }

    // --- fresh install / launch ---------------------------------------------

    @Test
    fun `a fresh install shows the login screen and writes nothing`() = runTest {
        val session = MemorySession()
        val auth = controller(FakeApi(), session)

        auth.start()

        assertEquals(AuthState.SignedOut(), auth.state.value)
        assertNull(session.token)
        assertNull(session.credentialId)
    }

    @Test
    fun `the gate resolves once and never re-runs on a later call`() = runTest {
        // A second start() must not resurrect a session written after the first
        // launch decision (it would flash the shell over the login screen).
        val api = FakeApi()
        val session = MemorySession()
        val auth = controller(api, session)

        auth.start()
        session.save("late-token", driver)
        auth.start()

        assertEquals(AuthState.SignedOut(), auth.state.value)
        assertEquals(0, api.challengeCalls)
    }

    @Test
    fun `a stored token whose user row is missing is refused and cleared`() = runTest {
        val session = MemorySession().apply {
            token = "orphan-token"
            userId = null
        }
        val auth = controller(FakeApi(), session)

        auth.start()

        assertEquals(AuthState.SignedOut(AuthRules.ERROR_NOT_DRIVER), auth.state.value)
        assertNull(session.token)
    }

    @Test
    fun `a stale non-driver session can never open the shell`() = runTest {
        val session = MemorySession().apply {
            token = "owner-token"
            userId = "u2"
            userName = "Olivia Owner"
            roleId = "owner"
            orgId = "org1"
        }
        val auth = controller(FakeApi(), session)

        auth.start()

        assertEquals(AuthState.SignedOut(AuthRules.ERROR_NOT_DRIVER), auth.state.value)
        assertNull(session.token)
        assertNull(session.roleId)
    }

    // --- passwordless re-login ----------------------------------------------

    @Test
    fun `a device credential signs the driver in without a password`() = runTest {
        val api = FakeApi()
        val session = signedInSession()
        val auth = controller(api, session)

        auth.start()

        assertEquals(AuthState.SignedIn(driver), auth.state.value)
        assertEquals("device-token", session.token)
        assertTrue("no password login may be made", api.logins.isEmpty())
        assertEquals(1, api.challengeCalls)
        assertEquals(1, api.verifyCalls)
    }

    @Test
    fun `a revoked credential drops the session and asks for the password`() = runTest {
        val api = FakeApi().apply { challengeResult = ApiResult.HttpFailure(403, "credential_revoked") }
        val session = signedInSession()
        val auth = controller(api, session)

        auth.start()

        assertEquals(AuthState.SignedOut(AuthRules.NOTICE_SIGN_IN_AGAIN), auth.state.value)
        assertNull(session.token)
        assertNull(session.credentialId)
        assertEquals(0, api.verifyCalls)
    }

    @Test
    fun `a wiped keystore never reaches the verify call`() = runTest {
        val api = FakeApi()
        val session = signedInSession()
        val auth = controller(api, session, keys = FakeKeys(available = false))

        auth.start()

        assertEquals(AuthState.SignedOut(AuthRules.NOTICE_SIGN_IN_AGAIN), auth.state.value)
        assertNull(session.token)
        assertNull(session.credentialId)
        assertEquals(1, api.challengeCalls)
        assertEquals(0, api.verifyCalls)
    }

    @Test
    fun `a credential that authenticates a non-driver role is refused`() = runTest {
        // The role changed server-side since the credential was bound.
        val api = FakeApi()
        val session = signedInSession().apply { roleId = "dispatcher" }
        val auth = controller(api, session)

        auth.start()

        assertEquals(AuthState.SignedOut(AuthRules.NOTICE_SIGN_IN_AGAIN), auth.state.value)
        assertNull(session.token)
        assertNull(session.credentialId)
    }

    // --- password sign-in ----------------------------------------------------

    @Test
    fun `every login failure maps to a sentence and persists nothing`() = runTest {
        val cases = listOf(
            401 to AuthRules.ERROR_INVALID,
            423 to AuthRules.ERROR_LOCKED,
            429 to AuthRules.ERROR_RATE_LIMITED,
            500 to AuthRules.ERROR_SERVER,
            403 to AuthRules.ERROR_INVALID,
        )
        for ((status, expected) in cases) {
            val api = FakeApi().apply { loginResult = ApiResult.HttpFailure(status, "x") }
            val session = MemorySession()
            val auth = controller(api, session)

            assertEquals("status $status", expected, auth.signIn("dana@example.com", "secret"))
            assertNull("status $status must not persist a token", session.token)
            assertNull(session.userId)
            assertEquals("status $status must not register a device", 0, api.registerCalls)
            assertTrue(api.revoked.isEmpty())
        }
    }

    @Test
    fun `a driver login opens the shell and binds the device`() = runTest {
        val api = FakeApi().apply { loginResult = ApiResult.Ok(PasswordLogin("token-1", driver)) }
        val session = MemorySession()
        val auth = controller(api, session)

        val error = auth.signIn("driver@example.com", "secret")

        assertNull(error)
        assertEquals("token-1", session.token)
        assertEquals("cred-1", session.credentialId)
        assertEquals(1, api.registerCalls)
        assertEquals(AuthState.SignedIn(driver), auth.state.value)
    }

    @Test
    fun `a solo driver is allowed in`() = runTest {
        val solo = AuthUser("u3", "Sam Solo", "solo", "org3")
        val api = FakeApi().apply { loginResult = ApiResult.Ok(PasswordLogin("solo-token", solo)) }
        val auth = controller(api, MemorySession())

        val error = auth.signIn("sam@example.com", "secret")

        assertNull(error)
        assertEquals(AuthState.SignedIn(solo), auth.state.value)
    }

    @Test
    fun `a device-register HTTP failure still lets the driver in`() = runTest {
        val api = FakeApi().apply {
            loginResult = ApiResult.Ok(PasswordLogin("token-1", driver))
            registerResult = ApiResult.HttpFailure(500, "http_error")
        }
        val session = MemorySession()
        val auth = controller(api, session)

        val error = auth.signIn("dana@example.com", "secret")

        assertNull("a registration failure must never block the login", error)
        assertEquals("token-1", session.token)
        assertNull(session.credentialId)
        assertEquals(AuthState.SignedIn(driver, AuthRules.NOTICE_NO_PASSWORDLESS), auth.state.value)
    }

    @Test
    fun `a non-driver login is refused before any device is bound`() = runTest {
        val owner = AuthUser("u2", "Olivia Owner", "owner", "org1")
        val api = FakeApi().apply { loginResult = ApiResult.Ok(PasswordLogin("owner-token", owner)) }
        val session = MemorySession()
        val auth = controller(api, session)

        val error = auth.signIn("owner@example.com", "secret")

        assertEquals(AuthRules.ERROR_NOT_DRIVER, error)
        assertEquals(0, api.registerCalls)
        assertTrue("an unusable account must not be revoked against", api.revoked.isEmpty())
        assertNull(session.token)
        assertEquals("the form stays on the login screen", AuthState.Restoring, auth.state.value)
    }

    // --- sign out ------------------------------------------------------------

    @Test
    fun `sign out revokes the device and clears every field`() = runTest {
        val api = FakeApi().apply { loginResult = ApiResult.Ok(PasswordLogin("token-1", driver)) }
        val session = MemorySession()
        val auth = controller(api, session)
        auth.signIn("dana@example.com", "secret")

        auth.signOut()

        assertEquals(listOf("cred-1"), api.revoked)
        assertNull(session.token)
        assertNull(session.credentialId)
        assertNull(session.deviceLabel)
        assertNull(session.userId)
        assertNull(session.userName)
        assertNull(session.roleId)
        assertNull(session.orgId)
        assertEquals(AuthState.SignedOut(), auth.state.value)
    }

    @Test
    fun `sign out without a device credential makes no network call`() = runTest {
        val api = FakeApi()
        val session = MemorySession().apply {
            token = "token-1"
            userId = "u1"
            roleId = "driver"
        }
        val auth = controller(api, session)

        auth.signOut()

        assertTrue(api.revoked.isEmpty())
        assertNull(session.token)
        assertEquals(AuthState.SignedOut(), auth.state.value)
    }

    @Test
    fun `a relaunch after sign out shows the login screen`() = runTest {
        val api = FakeApi().apply { loginResult = ApiResult.Ok(PasswordLogin("token-1", driver)) }
        val session = MemorySession()
        val auth = controller(api, session)
        auth.signIn("dana@example.com", "secret")
        auth.signOut()

        val relaunched = controller(api, session)
        relaunched.start()

        assertEquals(AuthState.SignedOut(), relaunched.state.value)
        assertEquals("no device credential survives sign-out", 0, api.challengeCalls)
    }

    // --- email-code availability (#124 fail-open) ---------------------------

    @Test
    fun `code availability follows the server but fails open`() = runTest {
        val off = FakeApi().apply { codeAvailableResult = ApiResult.Ok(false) }
        val offAuth = controller(off, MemorySession())
        offAuth.probeCodeAvailability()
        assertEquals(false, offAuth.codeAvailable.value)

        val broken = FakeApi().apply { codeAvailableResult = ApiResult.HttpFailure(503, "http_error") }
        val brokenAuth = controller(broken, MemorySession())
        brokenAuth.probeCodeAvailability()
        assertEquals("a server error must not hide a working button", true, brokenAuth.codeAvailable.value)

        val offline = FakeApi().apply { codeAvailableResult = ApiResult.NetworkFailure("offline") }
        val offlineAuth = controller(offline, MemorySession())
        offlineAuth.probeCodeAvailability()
        assertEquals(true, offlineAuth.codeAvailable.value)
    }

    // --- input handling ------------------------------------------------------

    @Test
    fun `an empty email or password never reaches the network`() = runTest {
        val api = FakeApi()
        val auth = controller(api, MemorySession())

        assertEquals(AuthRules.ERROR_REQUIRED, auth.signIn("   ", "secret"))
        assertEquals(AuthRules.ERROR_REQUIRED, auth.signIn("dana@example.com", ""))
        assertTrue(api.logins.isEmpty())
        assertEquals(AuthState.Restoring, auth.state.value)
    }

    @Test
    fun `the email is trimmed and the password is sent unchanged`() = runTest {
        val api = FakeApi().apply { loginResult = ApiResult.Ok(PasswordLogin("token-1", driver)) }

        controller(api, MemorySession()).signIn("  dana@example.com ", " pass word ")

        assertEquals(listOf("dana@example.com" to " pass word "), api.logins)
    }
}
