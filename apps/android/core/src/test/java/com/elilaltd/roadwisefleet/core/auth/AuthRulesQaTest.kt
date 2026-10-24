package com.elilaltd.roadwisefleet.core.auth

import com.elilaltd.roadwisefleet.core.data.remote.ApiResult
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * AND1-QA3 (board #128) — QA-owned, independent coverage of the #104 auth RULES.
 *
 * Written from the shipped implementation (`core/src/main/.../auth/AuthRules.kt`
 * at merge `b4c5862`), deliberately NOT a copy of the developer's
 * `AuthRulesTest`: every branch here is one the acceptance criteria depend on —
 * the launch gate, the role gate, the refusal copy and the HTTP -> sentence map
 * that decides what the driver actually reads.
 *
 * Pure JVM: no Android types, no device, no server.
 */
class AuthRulesQaTest {

    // --- launch gate (fresh install -> LoginScreen) --------------------------

    @Test
    fun `no token always starts on the login screen`() {
        assertEquals(GateStart.SignedOut, AuthRules.gateStart(null, null))
        assertEquals(GateStart.SignedOut, AuthRules.gateStart("", "cred-1"))
        assertEquals(GateStart.SignedOut, AuthRules.gateStart("   ", "cred-1"))
    }

    @Test
    fun `a token without a device credential opens the shell directly`() {
        // The documented case: a password session whose Keystore registration
        // failed at login. The app must not lock the driver out.
        assertEquals(GateStart.SignedIn, AuthRules.gateStart("token-1", null))
        assertEquals(GateStart.SignedIn, AuthRules.gateStart("token-1", ""))
    }

    @Test
    fun `a token with a device credential tries passwordless first`() {
        assertEquals(GateStart.Passwordless("cred-1"), AuthRules.gateStart("token-1", "cred-1"))
    }

    // --- role gate (non-driver -> refused) -----------------------------------

    @Test
    fun `every driver-role spelling is accepted`() {
        assertTrue(AuthRules.isDriverRole("driver"))
        assertTrue(AuthRules.isDriverRole("solo"))
        assertTrue(AuthRules.isDriverRole("solo_driver"))
    }

    @Test
    fun `non-driver and malformed roles are refused`() {
        for (role in listOf("owner", "dispatcher", "admin", "customer", "", "DRIVER", "driver ")) {
            assertFalse("role '$role' must not enter the driver app", AuthRules.isDriverRole(role))
        }
        assertFalse(AuthRules.isDriverRole(null))
    }

    // --- login -> sentence map ----------------------------------------------

    @Test
    fun `login statuses map to the sentence the form shows`() {
        assertEquals(AuthRules.ERROR_INVALID, AuthRules.loginErrorKey(401))
        assertEquals(AuthRules.ERROR_LOCKED, AuthRules.loginErrorKey(423))
        assertEquals(AuthRules.ERROR_RATE_LIMITED, AuthRules.loginErrorKey(429))
        assertEquals(AuthRules.ERROR_SERVER, AuthRules.loginErrorKey(500))
        assertEquals(AuthRules.ERROR_SERVER, AuthRules.loginErrorKey(503))
        assertEquals(AuthRules.ERROR_NETWORK, AuthRules.loginErrorKey(0))
    }

    @Test
    fun `every other login status is a plain invalid-credentials refusal`() {
        // 400/403/404 must never surface a machine code on the phone.
        for (status in listOf(400, 403, 404, 418)) {
            assertEquals("status $status", AuthRules.ERROR_INVALID, AuthRules.loginErrorKey(status))
        }
    }

    @Test
    fun `the machine code wins over the status`() {
        // A proxy or a future status change must not turn a lockout into
        // "wrong password", nor a rate limit into "server error".
        assertEquals(AuthRules.ERROR_LOCKED, AuthRules.loginErrorKey(401, "account_locked"))
        assertEquals(AuthRules.ERROR_RATE_LIMITED, AuthRules.loginErrorKey(500, "rate_limited"))
    }

    // --- API result -> sentence ---------------------------------------------

    @Test
    fun `api results map without a status`() {
        assertEquals(null, AuthRules.failureKey(ApiResult.Ok("anything")))
        assertEquals(AuthRules.ERROR_NETWORK, AuthRules.failureKey(ApiResult.NetworkFailure("offline")))
        assertEquals(
            AuthRules.ERROR_NETWORK,
            AuthRules.failureKey(ApiResult.HttpFailure(0, "http_error")),
        )
    }

    // --- email-code path (same gate, different entry) ------------------------

    @Test
    fun `a wrong or expired code is never reported as a wrong password`() {
        assertEquals(AuthRules.ERROR_CODE, AuthRules.codeErrorKey(401, "invalid_code"))
        assertEquals(AuthRules.ERROR_CODE, AuthRules.codeErrorKey(400))
        assertEquals(AuthRules.ERROR_LOCKED, AuthRules.codeErrorKey(423))
        assertEquals(AuthRules.ERROR_RATE_LIMITED, AuthRules.codeErrorKey(429, "rate_limited"))
        assertEquals(AuthRules.ERROR_SERVER, AuthRules.codeErrorKey(502))
    }

    @Test
    fun `a code request maps send failures separately from redemption`() {
        assertEquals(AuthRules.ERROR_CODE_EMAIL, AuthRules.requestErrorKey(400, "invalid_email"))
        assertEquals(AuthRules.ERROR_RATE_LIMITED, AuthRules.requestErrorKey(429, "rate_limited"))
        assertEquals(AuthRules.ERROR_SERVER, AuthRules.requestErrorKey(500))
        assertEquals(AuthRules.ERROR_CODE_SEND, AuthRules.requestErrorKey(400, "invalid_input"))
    }

    @Test
    fun `the code field keeps exactly six digits`() {
        assertEquals("123456", AuthRules.normalizeCode(" 12 34 56 78 "))
        assertEquals("123456", AuthRules.normalizeCode("123456\n"))
        assertEquals("1234", AuthRules.normalizeCode("12a34b"))
        assertEquals("", AuthRules.normalizeCode(null))
        assertEquals("", AuthRules.normalizeCode("abc"))
        assertEquals("123456", AuthRules.normalizeCode("1234567"))
    }

    @Test
    fun `a code is complete only at six digits`() {
        assertTrue(AuthRules.isCompleteCode("123456"))
        assertFalse(AuthRules.isCompleteCode("12345"))
        assertFalse(AuthRules.isCompleteCode(""))
        assertFalse(AuthRules.isCompleteCode(null))
    }

    // --- device label --------------------------------------------------------

    @Test
    fun `the device label is manufacturer plus model, trimmed`() {
        assertEquals("Samsung SM-A155F", AuthRules.deviceLabel("  Samsung ", " SM-A155F "))
        assertEquals("Samsung", AuthRules.deviceLabel("Samsung", null))
        assertEquals("SM-A155F", AuthRules.deviceLabel(null, "SM-A155F"))
    }

    @Test
    fun `an unknown device still gets a usable label`() {
        assertEquals("Android device", AuthRules.deviceLabel(null, null))
        assertEquals("Android device", AuthRules.deviceLabel("   ", ""))
    }

    @Test
    fun `the device label fits the backend limit and carries no identity`() {
        val long = AuthRules.deviceLabel("A".repeat(60), "B".repeat(60))
        assertEquals(80, long.length)
        // The label is hardware only: an email or driver name must never slip in.
        val label = AuthRules.deviceLabel("Samsung", "SM-A155F")
        assertFalse(label.contains("@"))
    }
}
