package com.elilaltd.roadwisefleet.core.auth

import com.elilaltd.roadwisefleet.core.data.remote.ApiResult
import com.elilaltd.roadwisefleet.core.model.DeviceChallenge
import com.elilaltd.roadwisefleet.core.model.DeviceRegistration
import com.elilaltd.roadwisefleet.core.model.DeviceSession
import com.elilaltd.roadwisefleet.core.model.PasswordLogin

/**
 * The auth surface the client uses (board #104 reopen). `ApiClient` implements
 * it; the JVM tests supply a fake, so the session/role/gate rules are pinned
 * without a device or a server.
 *
 * The four device methods are the A2 contract (already shipped in the API);
 * [login] and [revokeDevice] are the missing app-facing pieces.
 */
interface AuthApi {
    /** `POST /api/auth/login` — email + password. */
    suspend fun login(email: String, password: String): ApiResult<PasswordLogin>

    /** `POST /api/auth/otp/email/request` — mail a sign-in code (board #125). */
    suspend fun requestEmailCode(email: String): ApiResult<Unit>

    /**
     * `POST /api/auth/otp/email/verify` — redeem a code. The success payload is
     * the same `{ token, user }` shape as [login], so both paths converge.
     */
    suspend fun verifyEmailCode(email: String, code: String): ApiResult<PasswordLogin>

    /**
     * `GET /api/auth/otp/email/status` — whether the server has a working email
     * sender (#124). The login screen hides "Email me a code" when it does not,
     * instead of sending the driver to a mailbox that will never fill.
     */
    suspend fun emailOtpAvailable(): ApiResult<Boolean>

    /** `POST /api/auth/device/register` (bearer) — bind this device's public key. */
    suspend fun registerDevice(
        publicKeyBase64: String,
        algorithm: String,
        deviceLabel: String?,
    ): ApiResult<DeviceRegistration>

    /** `POST /api/auth/device/challenge` (public) — a single-use nonce. */
    suspend fun deviceChallenge(credentialId: String): ApiResult<DeviceChallenge>

    /** `POST /api/auth/device/verify` (public) — signature -> session token. */
    suspend fun deviceVerify(challengeId: String, signatureBase64: String): ApiResult<DeviceSession>

    /** `POST /api/auth/device/revoke` (bearer) — lost-phone / sign-out revoke. */
    suspend fun revokeDevice(credentialId: String): ApiResult<Unit>

    /**
     * `DELETE /api/account` (bearer) — the Play-required account deletion
     * (board #142). Anonymises the account in place, revokes every device and
     * leaves the trip/document records to the carrier's retention policy.
     */
    suspend fun deleteAccount(): ApiResult<Unit>
}
