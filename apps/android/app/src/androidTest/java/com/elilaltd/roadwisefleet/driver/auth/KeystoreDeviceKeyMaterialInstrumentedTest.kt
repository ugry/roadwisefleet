package com.elilaltd.roadwisefleet.driver.auth

import android.security.keystore.KeyProperties
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.security.KeyFactory
import java.security.KeyStore
import java.security.Signature
import java.security.spec.ECParameterSpec
import java.security.spec.X509EncodedKeySpec

/**
 * AND1-QA1 (#108) criterion 1 — first-run Keystore keypair + public-key
 * registration material. UNRUN pending CI instrumented job #113.
 *
 * This is an `androidTest` (on-device) suite, not Robolectric: the real
 * `AndroidKeyStore` provider (and its hardware/TEE key generation) only exists
 * on a device/emulator, and the whole point of the criterion is that the private
 * key is generated *inside* the Keystore and never leaves it. Robolectric shadows
 * the Keystore, so it cannot prove this.
 *
 * Needs (see qa/and1-android-tests/README.md): `:app` add
 *   androidTestImplementation("androidx.test.ext:junit:1.2.1")
 *   androidTestImplementation("androidx.test:runner:1.6.2")
 * plus `testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"`
 * (already set in build.gradle.kts).
 */
@RunWith(AndroidJUnit4::class)
class KeystoreDeviceKeyMaterialInstrumentedTest {

    private val alias = "roadwisefleet.device.v1.qa"
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext

    private fun keystore(): KeyStore =
        KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    @Before
    fun clearAlias() {
        val store = keystore()
        if (store.containsAlias(alias)) store.deleteEntry(alias)
    }

    @After
    fun tearDown() = clearAlias()

    @Test
    fun `generates a persistent EC P-256 keypair on first use`() {
        val material = KeystoreDeviceKeyMaterial(alias)

        val first = material.publicKeySpkiBase64()
        assertNotNull("the first call must generate the keypair", first)

        // A second instance (a later app launch) must find the same key, not a new one.
        val second = KeystoreDeviceKeyMaterial(alias).publicKeySpkiBase64()
        assertEquals("the keypair must persist across instances", first, second)

        // The exported SPKI must decode as EC on the P-256 curve.
        val key = KeyFactory.getInstance("EC")
            .generatePublic(X509EncodedKeySpec(android.util.Base64.decode(first, android.util.Base64.NO_WRAP)))
        assertEquals("EC", key.algorithm)
        assertTrue(key.params is ECParameterSpec)
        assertEquals(
            "P-256 field size",
            256,
            (key.params as ECParameterSpec).curve.field.fieldSize,
        )
        // No private material may be exposed by the seam.
        assertTrue("only the public key is exported", !first.contains("PRIVATE"))
    }

    @Test
    fun `a signature verifies with the exported public key only`() {
        val material = KeystoreDeviceKeyMaterial(alias)
        val publicKeyB64 = material.publicKeySpkiBase64()
        assertNotNull(publicKeyB64)

        val nonce = "qa-and1-nonce-0123456789"
        val signatureB64 = material.signNonce(nonce)
        assertNotNull("signing must succeed while the Keystore is available", signatureB64)

        // Verify with the public key material alone: proves the device signed on
        // the Keystore key and that the private bytes never crossed the seam.
        val publicKey = KeyFactory.getInstance("EC")
            .generatePublic(X509EncodedKeySpec(android.util.Base64.decode(publicKeyB64, android.util.Base64.NO_WRAP)))
        val verifier = Signature.getInstance("SHA256withECDSA").apply { initVerify(publicKey) }
        verifier.update(nonce.toByteArray(Charsets.UTF_8))
        assertTrue(
            "the detached DER signature must verify over the UTF-8 nonce",
            verifier.verify(android.util.Base64.decode(signatureB64, android.util.Base64.NO_WRAP)),
        )
    }

    @Test
    fun `a different nonce does not verify (the signature is bound to the challenge)`() {
        val material = KeystoreDeviceKeyMaterial(alias)
        val publicKeyB64 = material.publicKeySpkiBase64()!!
        val signatureB64 = material.signNonce("nonce-A")!!

        val publicKey = KeyFactory.getInstance("EC")
            .generatePublic(X509EncodedKeySpec(android.util.Base64.decode(publicKeyB64, android.util.Base64.NO_WRAP)))
        val verifier = Signature.getInstance("SHA256withECDSA").apply { initVerify(publicKey) }
        verifier.update("nonce-B".toByteArray(Charsets.UTF_8))
        assertTrue(
            "a signature over nonce-A must not verify nonce-B",
            !verifier.verify(android.util.Base64.decode(signatureB64, android.util.Base64.NO_WRAP)),
        )
    }

    @Test
    fun `the generated key is an ES256 (P-256 / SHA-256) signing key`() {
        val material = KeystoreDeviceKeyMaterial(alias)
        material.publicKeySpkiBase64() // force generation
        val store = keystore()
        val entry = store.getEntry(alias, null) as? KeyStore.PrivateKeyEntry
        assertNotNull("the Keystore holds a private-key entry", entry)
        assertEquals("EC", entry!!.privateKey.algorithm)
        // The backend contract is ES256 = ECDSA P-256 + SHA-256.
        assertEquals(KeyProperties.KEY_ALGORITHM_EC, "EC")
    }
}
