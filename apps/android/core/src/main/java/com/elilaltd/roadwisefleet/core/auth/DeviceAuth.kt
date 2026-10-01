package com.elilaltd.roadwisefleet.core.auth

import com.elilaltd.roadwisefleet.core.data.remote.ApiClient
import com.elilaltd.roadwisefleet.core.data.remote.ApiResult
import com.elilaltd.roadwisefleet.core.model.DeviceRegistration
import com.elilaltd.roadwisefleet.core.model.DeviceSession

/**
 * Passwordless device auth orchestration (board #104, AND1-A2).
 *
 *   first login:  [register]     -> the backend binds this device's public key
 *   later logins: [authenticate] -> challenge, sign on-device, session token
 *
 * No password travels in either path after the first login; the private key is
 * generated in the Keystore and never leaves the device ([DeviceKeyMaterial]).
 * This class holds no state — the caller persists the credential id (and the
 * returned token) in `SessionStore`.
 */
class DeviceAuth(
    private val api: ApiClient,
    private val keys: DeviceKeyMaterial,
) {
    /** Bind this device. Called once, right after the first password/OTP login. */
    suspend fun register(deviceLabel: String?): ApiResult<DeviceRegistration> {
        val publicKey = keys.publicKeySpkiBase64()
            // The Keystore is unavailable: the caller must fall back to a
            // password login, which is why this is a distinct error, not an HTTP one.
            ?: return ApiResult.NetworkFailure(KEYSTORE_UNAVAILABLE)
        return api.registerDevice(publicKey, ALGORITHM, deviceLabel)
    }

    /** Log in with no password: challenge -> sign -> session token. */
    suspend fun authenticate(credentialId: String): ApiResult<DeviceSession> =
        when (val challenge = api.deviceChallenge(credentialId)) {
            is ApiResult.Ok -> {
                val signature = keys.signNonce(challenge.value.nonce)
                if (signature == null) {
                    ApiResult.NetworkFailure(KEYSTORE_UNAVAILABLE)
                } else {
                    api.deviceVerify(challenge.value.challengeId, signature)
                }
            }
            // `ApiResult` is covariant, so a failure of the challenge call is
            // directly a failure of the authentication.
            is ApiResult.HttpFailure -> challenge
            is ApiResult.NetworkFailure -> challenge
        }

    companion object {
        /** The only algorithm the backend accepts (ECDSA P-256 / SHA-256). */
        const val ALGORITHM = "ES256"
        /** `ApiResult.NetworkFailure.message` when the Keystore cannot produce a key. */
        const val KEYSTORE_UNAVAILABLE = "keystore_unavailable"
    }
}
