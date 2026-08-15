package com.drivepass.android

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The verification that counts: runs the real VaultCrypto against a real
 * vault.enc produced by the Chrome extension's own src/lib/crypto.js, on a real
 * device, using the device's JCA provider.
 *
 * The desktop JVM uses SunJCE; Android uses Conscrypt/BouncyCastle. A passing
 * JVM unit test therefore does NOT prove on-device interop, which is why this
 * exists separately.
 */
@RunWith(AndroidJUnit4::class)
class VaultInteropTest {

    private val password = "correct-horse-battery-staple".toCharArray()

    private fun fixture(): String =
        InstrumentationRegistry.getInstrumentation().targetContext.assets
            .open("fixture-vault.enc").bufferedReader().use { it.readText() }

    @Test
    fun envelopeParsesWithExpectedParameters() {
        val e = VaultCrypto.parseEnvelope(fixture())
        assertEquals("drivepass-v1", e.format)
        assertEquals("PBKDF2-SHA256", e.kdf)
        assertEquals(210_000, e.iterations)
        assertEquals(16, e.salt.size)
        assertEquals(12, e.iv.size)
        assertTrue("ciphertext must exceed the tag length", e.ciphertext.size > 16)
        assertTrue("a fresh vault must not need upgrading", !VaultCrypto.needsKdfUpgrade(e))
    }

    @Test
    fun decryptsExtensionWrittenVaultOnDevice() {
        val env = VaultCrypto.parseEnvelope(fixture())
        val key = VaultCrypto.deriveKey(password.copyOf(), env.salt, env.iterations)
        val plaintext = VaultCrypto.decrypt(key, env)
        assertTrue("payload must be the entries object", plaintext.startsWith("{\"entries\":"))
        val data = VaultModel.parse(plaintext)
        assertEquals("total entries", 8, data.entries.size)
        assertEquals("purged tombstones", listOf("fixture-99-purged"), data.purged)
    }

    @Test
    fun liveEntriesMatchDesktopOrderingAndContent() {
        val env = VaultCrypto.parseEnvelope(fixture())
        val key = VaultCrypto.deriveKey(password.copyOf(), env.salt, env.iterations)
        val data = VaultModel.parse(VaultCrypto.decrypt(key, env))
        val live = VaultModel.liveSorted(data)

        assertEquals("tombstoned entry must be excluded", 7, live.size)
        // Favourites first, then name order — the desktop's rule.
        assertEquals(listOf("GitHub", "Google"), live.take(2).map { it.name })
        assertTrue("favourites must sort ahead", live[0].favorite && live[1].favorite)
        assertTrue("non-favourites follow", !live[2].favorite)
        assertTrue(
            "the deleted entry must not appear",
            live.none { it.name == "Deleted Example" },
        )
    }

    @Test
    fun nonAsciiSecretsSurviveTheRoundTrip() {
        // The whole point of the UTF-8 password/payload contract. If the byte
        // conventions were wrong this is what would silently corrupt.
        val env = VaultCrypto.parseEnvelope(fixture())
        val key = VaultCrypto.deriveKey(password.copyOf(), env.salt, env.iterations)
        val data = VaultModel.parse(VaultCrypto.decrypt(key, env))
        val e = data.entries.first { it.id == "fixture-04" }
        assertEquals("Unicode Test ünïcodé 🔐", e.name)
        assertEquals("Pässwörd-🔐-Ω≈ç", e.password)
        assertEquals("tëst@example.com", e.username)
    }

    @Test
    fun entryTypesAndSubtitlesMatchDesktop() {
        val env = VaultCrypto.parseEnvelope(fixture())
        val key = VaultCrypto.deriveKey(password.copyOf(), env.salt, env.iterations)
        val data = VaultModel.parse(VaultCrypto.decrypt(key, env))
        val byId = data.entries.associateBy { it.id }

        assertEquals("card", byId["fixture-05"]!!.type)
        assertEquals("•••• 1111", byId["fixture-05"]!!.subtitle())
        assertEquals("note", byId["fixture-06"]!!.type)
        assertEquals("Secure Note", byId["fixture-06"]!!.subtitle())
        assertEquals("passkey", byId["fixture-07"]!!.type)
        assertEquals("octocat", byId["fixture-07"]!!.subtitle())
        assertEquals("JBSWY3DPEHPK3PXP", byId["fixture-01"]!!.totp)
    }

    @Test
    fun wrongPasswordIsRejectedAsWrongPassword() {
        val env = VaultCrypto.parseEnvelope(fixture())
        val key = VaultCrypto.deriveKey("definitely-wrong".toCharArray(), env.salt, env.iterations)
        try {
            VaultCrypto.decrypt(key, env)
            fail("a wrong password must not decrypt")
        } catch (e: VaultError.WrongPassword) {
            // exactly right: AEADBadTagException mapped to the desktop's message
        }
    }

    @Test
    fun resealedVaultIsReadableAndReusesKdfParams() {
        // Proves the Android writer produces a file the extension could open:
        // same salt and iteration count, fresh IV, still decryptable.
        val env = VaultCrypto.parseEnvelope(fixture())
        val key = VaultCrypto.deriveKey(password.copyOf(), env.salt, env.iterations)
        val plaintext = VaultCrypto.decrypt(key, env)

        val resealed = VaultCrypto.seal(key, plaintext, env)
        assertEquals("iterations must carry over", env.iterations, resealed.iterations)
        assertTrue("salt must carry over", env.salt.contentEquals(resealed.salt))
        assertTrue("IV must be fresh", !env.iv.contentEquals(resealed.iv))
        assertEquals(
            "size invariant: plaintext + 16-byte tag",
            plaintext.toByteArray(Charsets.UTF_8).size + 16,
            resealed.ciphertext.size,
        )

        // Round-trip through the JSON envelope and decrypt again.
        val reparsed = VaultCrypto.parseEnvelope(VaultCrypto.envelopeToJson(resealed))
        val key2 = VaultCrypto.deriveKey(password.copyOf(), reparsed.salt, reparsed.iterations)
        assertEquals(plaintext, VaultCrypto.decrypt(key2, reparsed))
    }

    @Test
    fun ivIsNeverReusedAcrossSeals() {
        // The salt is stable while the file is re-encrypted on every mutation,
        // so IV uniqueness is the only thing preventing GCM nonce reuse.
        val env = VaultCrypto.parseEnvelope(fixture())
        val key = VaultCrypto.deriveKey(password.copyOf(), env.salt, env.iterations)
        val seen = mutableSetOf<String>()
        repeat(50) {
            val iv = VaultCrypto.seal(key, "{\"entries\":[]}", env).iv
            assertTrue("IV reused after $it seals", seen.add(VaultCrypto.hex(iv)))
        }
    }

    @Test
    fun corruptEnvelopesFailAsCorruptionNotAsWrongPassword() {
        val good = fixture()
        // Bad base64 in ciphertext must not be reported as a wrong password.
        val badB64 = good.replace(Regex("\"ciphertext\": \"[^\"]+\""), "\"ciphertext\": \"!!!not-base64!!!\"")
        try {
            VaultCrypto.parseEnvelope(badB64)
            fail("expected corruption error")
        } catch (e: VaultError.Corrupt) {
            // right
        }

        val badFormat = good.replace("drivepass-v1", "drivepass-v99")
        try {
            VaultCrypto.parseEnvelope(badFormat)
            fail("expected format rejection")
        } catch (e: VaultError.UnrecognizedFormat) {
            // right
        }
    }

    @Test
    fun unsafeKdfCostIsRefused() {
        val good = fixture()
        for (bad in listOf("1", "99999", "20000000")) {
            val tampered = good.replace(Regex("\"iterations\": \\d+"), "\"iterations\": $bad")
            try {
                VaultCrypto.parseEnvelope(tampered)
                fail("iterations=$bad must be refused")
            } catch (e: VaultError.UnsafeKdfCost) {
                // right
            }
        }
    }

    @Test
    fun derivationCostIsAcceptableOnThisDevice() {
        val env = VaultCrypto.parseEnvelope(fixture())
        val started = System.nanoTime()
        VaultCrypto.deriveKey(password.copyOf(), env.salt, env.iterations)
        val ms = (System.nanoTime() - started) / 1_000_000
        android.util.Log.i("DrivePassSpike", "PBKDF2 210k took ${ms}ms on this device")
        assertTrue("210k iterations took ${ms}ms — unusably slow", ms < 15_000)
    }
}
