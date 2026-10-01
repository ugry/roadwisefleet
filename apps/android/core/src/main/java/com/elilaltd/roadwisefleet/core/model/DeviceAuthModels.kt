package com.elilaltd.roadwisefleet.core.model

/**
 * Passwordless device-auth DTOs (board #104, AND1-A2). Plain data — no Android
 * types — so they can be unit-tested on the JVM and reused by any client.
 */

/** A device credential the backend accepted: the server stores the public key only. */
data class DeviceRegistration(
    val credentialId: String,
    val algorithm: String,
    val deviceLabel: String?,
)

/** A single-use nonce to sign. `nonce` is base64 of random bytes. */
data class DeviceChallenge(
    val challengeId: String,
    val nonce: String,
    val algorithm: String,
)

/** The session token a successful device verify returns. */
data class DeviceSession(
    val token: String,
    val userId: String,
    val deviceCredentialId: String?,
)
