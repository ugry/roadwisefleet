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
}
