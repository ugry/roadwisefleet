package com.elilaltd.roadwisefleet.core.auth

/**
 * The device-bound keypair, abstracted away from Android (board #104, AND1-A2).
 *
 * `core` depends only on this interface; the app module supplies the Android
 * Keystore implementation (`KeystoreDeviceKeyMaterial`). Keeping the seam here
 * means the orchestration is testable with a fake signer, and the private key
 * never crosses it — only the public key and detached signatures do.
 */
interface DeviceKeyMaterial {
    /**
     * Base64 (standard, no wrap) DER SPKI of this device's EC P-256 public key.
     * `null` when the Keystore is unavailable and no key can be created — the
     * caller must then fall back to a password login.
     */
    fun publicKeySpkiBase64(): String?

    /**
     * Base64 (standard, no wrap) DER ECDSA P-256/SHA-256 signature over the
     * UTF-8 bytes of [nonceBase64] (the nonce string exactly as received).
     * `null` when signing is impossible.
     */
    fun signNonce(nonceBase64: String): String?
}
