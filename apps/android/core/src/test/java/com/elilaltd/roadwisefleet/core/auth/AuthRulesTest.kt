package com.elilaltd.roadwisefleet.core.auth

import com.elilaltd.roadwisefleet.core.data.remote.ApiResult
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Pure rules behind the login gate (board #104 reopen). */
class AuthRulesTest {

    @Test
    fun `driver roles are exactly the two the server issues`() {
        assertTrue(AuthRules.isDriverRole("driver"))
        assertTrue(AuthRules.isDriverRole("solo"))
        // The account-type vocabulary name; accepted without widening access.
        assertTrue(AuthRules.isDriverRole("solo_driver"))

        assertFalse(AuthRules.isDriverRole("owner"))
        assertFalse(AuthRules.isDriverRole("dispatcher"))
        assertFalse(AuthRules.isDriverRole("customer"))
        assertFalse(AuthRules.isDriverRole(""))
        assertFalse(AuthRules.isDriverRole(null))
    }

    @Test
    fun `launch gate prefers passwordless only when a credential is stored`() {
        assertEquals(GateStart.SignedOut, AuthRules.gateStart(null, null))
        assertEquals(GateStart.SignedOut, AuthRules.gateStart("", "cred-1"))
        assertEquals(GateStart.SignedIn, AuthRules.gateStart("token", null))
        assertEquals(GateStart.SignedIn, AuthRules.gateStart("token", ""))
        assertEquals(
            GateStart.Passwordless("cred-1"),
            AuthRules.gateStart("token", "cred-1"),
        )
    }

    @Test
    fun `login errors map to the three sentences the wireframe promises`() {
        assertEquals(AuthRules.ERROR_INVALID, AuthRules.loginErrorKey(401))
        assertEquals(AuthRules.ERROR_LOCKED, AuthRules.loginErrorKey(423))
        assertEquals(AuthRules.ERROR_LOCKED, AuthRules.loginErrorKey(401, "account_locked"))
        assertEquals(AuthRules.ERROR_RATE_LIMITED, AuthRules.loginErrorKey(429))
        assertEquals(AuthRules.ERROR_SERVER, AuthRules.loginErrorKey(500))
        assertEquals(AuthRules.ERROR_SERVER, AuthRules.loginErrorKey(503))
        // A malformed request is still "these credentials do not work" on a phone.
        assertEquals(AuthRules.ERROR_INVALID, AuthRules.loginErrorKey(400))
    }

    @Test
    fun `api failures map to catalogue keys`() {
        assertNull(AuthRules.failureKey(ApiResult.Ok(Unit)))
        assertEquals(
            AuthRules.ERROR_INVALID,
            AuthRules.failureKey(ApiResult.HttpFailure(401, "invalid_credentials")),
        )
        assertEquals(
            AuthRules.ERROR_NETWORK,
            AuthRules.failureKey(ApiResult.NetworkFailure("timeout")),
        )
        // status 0 is the client's synthetic "no response" code.
        assertEquals(AuthRules.ERROR_NETWORK, AuthRules.failureKey(ApiResult.HttpFailure(0, "?")))
        assertEquals(
            AuthRules.ERROR_SERVER,
            AuthRules.failureKey(ApiResult.HttpFailure(502, "bad_gateway")),
        )
    }

    @Test
    fun `device label is the hardware model, trimmed to the backend limit`() {
        assertEquals("Google Pixel 7", AuthRules.deviceLabel("Google", "Pixel 7"))
        assertEquals("Pixel 7", AuthRules.deviceLabel(null, " Pixel 7 "))
        assertEquals("Android device", AuthRules.deviceLabel(" ", null))
        assertEquals(80, AuthRules.deviceLabel("M".repeat(60), "X".repeat(60)).length)
    }

    @Test
    fun `the delete confirmation arms only on the exact word`() {
        assertTrue(AuthRules.deleteConfirmationMatches("DELETE"))
        assertTrue(AuthRules.deleteConfirmationMatches(" DELETE "))
        assertFalse(AuthRules.deleteConfirmationMatches("delete"))
        assertFalse(AuthRules.deleteConfirmationMatches("DELET"))
        assertFalse(AuthRules.deleteConfirmationMatches(""))
        assertFalse(AuthRules.deleteConfirmationMatches(null))
    }

    @Test
    fun `a failed deletion maps to a sentence a driver can act on`() {
        assertEquals(AuthRules.ERROR_NETWORK, AuthRules.deleteErrorKey(0))
        assertEquals(AuthRules.ERROR_RATE_LIMITED, AuthRules.deleteErrorKey(429, "rate_limited"))
        assertEquals(AuthRules.NOTICE_SIGN_IN_AGAIN, AuthRules.deleteErrorKey(401, "unauthorized"))
        assertEquals(AuthRules.ERROR_SERVER, AuthRules.deleteErrorKey(503))
        assertEquals(AuthRules.ERROR_DELETE, AuthRules.deleteErrorKey(400, "invalid_input"))
    }

    @Test
    fun `the last administrator refusal is its own sentence, not a generic retry`() {
        // Board #144: `409 last_owner` is actionable (add/hand over an admin).
        assertEquals(AuthRules.ERROR_LAST_OWNER, AuthRules.deleteErrorKey(409, "last_owner"))
        // The machine code wins over the status, like the login mapper.
        assertEquals(AuthRules.ERROR_LAST_OWNER, AuthRules.deleteErrorKey(409))
        assertEquals("auth.deleteAccount.lastOwner", AuthRules.ERROR_LAST_OWNER)
    }
}
