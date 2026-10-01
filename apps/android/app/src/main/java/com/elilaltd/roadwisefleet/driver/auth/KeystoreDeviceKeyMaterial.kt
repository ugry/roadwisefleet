package com.elilaltd.roadwisefleet.driver.auth

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.elilaltd.roadwisefleet.core.auth.DeviceKeyMaterial
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.spec.ECGenParameterSpec

/**
 * Android Keystore implementation of [DeviceKeyMaterial] (board #104, AND1-A2).
 *
 * The EC P-256 keypair is generated inside the Keystore and never leaves it:
 * only the DER-encoded public key (SPKI) and detached signatures are ever
 * handed to the app. StrongBox is requested when the device has it and the
 * generation silently falls back to the TEE otherwise. Signing happens on the
 * Keystore key, so no private bytes exist in the process.
 *
 * A missing/unusable Keystore returns `null`; the caller falls back to a
 * password login (`DeviceAuth.KEYSTORE_UNAVAILABLE`).
 */
class KeystoreDeviceKeyMaterial(
    private val alias: String = DEFAULT_ALIAS,
) : DeviceKeyMaterial {

    override fun publicKeySpkiBase64(): String? =
        keyPair()?.public?.encoded?.let { Base64.encodeToString(it, Base64.NO_WRAP) }

    override fun signNonce(nonceBase64: String): String? {
        val privateKey = keyPair()?.private ?: return null
        return try {
            val signer = Signature.getInstance(SIGNATURE_ALGORITHM)
            signer.initSign(privateKey)
            // The backend verifies over the UTF-8 bytes of the nonce string.
            signer.update(nonceBase64.toByteArray(Charsets.UTF_8))
            Base64.encodeToString(signer.sign(), Base64.NO_WRAP)
        } catch (t: Throwable) {
            null
        }
    }

    private fun keyPair(): KeyPair? = try {
        val store = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        val entry = store.getEntry(alias, null) as? KeyStore.PrivateKeyEntry
        if (entry != null) KeyPair(entry.certificate.publicKey, entry.privateKey) else generate()
    } catch (t: Throwable) {
        null
    }

    private fun generate(): KeyPair = try {
        generate(strongBox = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P)
    } catch (t: Throwable) {
        // StrongBox is optional and device-specific (setIsStrongBoxBacked throws
        // StrongBoxUnavailableException on hardware that lacks it) — the TEE key
        // is the documented fallback.
        generate(strongBox = false)
    }

    private fun generate(strongBox: Boolean): KeyPair {
        val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEYSTORE)
        val builder = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec(CURVE))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setUserAuthenticationRequired(false)
        if (strongBox) builder.setIsStrongBoxBacked(true)
        generator.initialize(builder.build())
        return generator.generateKeyPair()
    }

    companion object {
        const val DEFAULT_ALIAS = "roadwisefleet.device.v1"
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val SIGNATURE_ALGORITHM = "SHA256withECDSA"
        private const val CURVE = "secp256r1"
    }
}
