package com.drivepass.android

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The write half of the model: serialising back, and merging two copies.
 *
 * Instrumented rather than a JVM unit test for the same reason VaultInteropTest
 * is: this runs against Android's own org.json, which is a different
 * implementation from the desktop JVM's. Round-trip fidelity is exactly the
 * kind of thing that can pass on one and fail on the other.
 *
 * Everything here is about NOT LOSING DATA. The app's model deliberately does
 * not know about `history`, `passkey.credentialId`, or whatever a newer desktop
 * release adds — so the tests that matter most are the ones proving those
 * survive a trip through this client.
 */
@RunWith(AndroidJUnit4::class)
class VaultWriteModelTest {

    private val password = "correct-horse-battery-staple".toCharArray()

    private fun fixtureData(): VaultData {
        val text = InstrumentationRegistry.getInstrumentation().targetContext.assets
            .open("fixture-vault.enc").bufferedReader().use { it.readText() }
        val env = VaultCrypto.parseEnvelope(text)
        val key = VaultCrypto.deriveKey(password.copyOf(), env.salt, env.iterations)
        return VaultModel.parse(VaultCrypto.decrypt(key, env))
    }

    /** A one-entry payload, for the merge rules. */
    private fun one(id: String, name: String, updatedAt: Long, purged: String = "[]") =
        VaultModel.parse(
            """{"entries":[{"id":"$id","type":"login","name":"$name",""" +
                """"updatedAt":$updatedAt,"deletedAt":null}],"purged":$purged}"""
        )

    // ---- round trip ----------------------------------------------------------

    @Test
    fun fixtureRoundTripsWithoutLoss() {
        val data = fixtureData()
        val again = VaultModel.parse(VaultModel.serialize(data))

        assertEquals("entry count", 8, again.entries.size)
        assertEquals("purged tombstones", listOf("fixture-99-purged"), again.purged)
        assertEquals("entry order", data.entries.map { it.id }, again.entries.map { it.id })
    }

    @Test
    fun roundTripKeepsTheTombstone() {
        val again = VaultModel.parse(VaultModel.serialize(fixtureData()))
        val deleted = again.entries.filter { it.isDeleted }
        assertEquals("exactly one tombstoned entry", 1, deleted.size)
        assertEquals("fixture-08", deleted.single().id)
        assertEquals("live entries", 7, VaultModel.liveSorted(again).size)
    }

    @Test
    fun roundTripKeepsLiveEntriesLive() {
        val again = VaultModel.parse(VaultModel.serialize(fixtureData()))
        // deletedAt must come back as an explicit null, not a 0 or a missing key
        // — the extension reads it with a null check.
        val github = again.entries.single { it.id == "fixture-01" }
        assertNull(github.deletedAt)
        assertTrue("deletedAt must be present and null", github.raw.isNull("deletedAt"))
    }

    @Test
    fun roundTripKeepsPasskeyCredentialId() {
        // The model reads only rpId and userName. credentialId is the field that
        // makes a passkey usable, and rebuilding the entry would destroy it.
        val again = VaultModel.parse(VaultModel.serialize(fixtureData()))
        val passkey = again.entries.single { it.id == "fixture-07" }
        assertEquals("cloudflare.com", passkey.passkeyRpId)
        assertEquals(
            "QUJDRA==",
            passkey.raw.getJSONObject("passkey").getString("credentialId"),
        )
    }

    @Test
    fun roundTripKeepsCardFieldsAndUnicode() {
        val again = VaultModel.parse(VaultModel.serialize(fixtureData()))
        val card = again.entries.single { it.id == "fixture-05" }
        assertEquals("4111111111111111", card.cardNumber)
        assertEquals("OCTO CAT", card.cardHolder)
        assertEquals("09/28", card.cardExpiry)

        val unicode = again.entries.single { it.id == "fixture-04" }
        assertEquals("Unicode Test ünïcodé 🔐", unicode.name)
        assertEquals("Pässwörd-🔐-Ω≈ç", unicode.password)
    }

    @Test
    fun serializeKeepsFieldsTheModelDoesNotKnow() {
        val json = """
            {"entries":[{"id":"a","type":"login","name":"A","updatedAt":5,"deletedAt":null,
              "history":[{"password":"old","changedAt":1}],
              "futureField":"keep me",
              "passkey":{"rpId":"r","credentialId":"CRED","userName":"u"}}],
             "purged":[],"schemaVersion":7}
        """.trimIndent()

        val out = VaultModel.serialize(VaultModel.parse(json))
        val e = VaultModel.parse(out).entries.single().raw

        assertEquals("unknown entry field", "keep me", e.getString("futureField"))
        assertEquals("history length", 1, e.getJSONArray("history").length())
        assertEquals("history content", "old", e.getJSONArray("history").getJSONObject(0).getString("password"))
        assertEquals("credentialId", "CRED", e.getJSONObject("passkey").getString("credentialId"))
        assertEquals("unknown top-level key", 7, JSONObject(out).getInt("schemaVersion"))
    }

    @Test
    fun serializeDoesNotMutateTheParsedData() {
        val data = VaultModel.parse(
            """{"entries":[{"id":"a","name":"A","updatedAt":1,"deletedAt":null}],"purged":[]}"""
        )
        val before = data.entries.single().raw.toString()
        VaultModel.serialize(data)
        assertEquals("a failed save must leave memory untouched", before, data.entries.single().raw.toString())
    }

    // ---- merge ---------------------------------------------------------------

    @Test
    fun mergeLocalWinsOnEqualTimestamps() {
        // src/lib/vault.js uses `>=`, so a tie goes to local. Reversing this
        // would silently hand every clock-equal conflict to the remote.
        val merged = VaultModel.merge(one("x", "local", 100), one("x", "remote", 100))
        assertEquals("local", merged.entries.single().name)
    }

    @Test
    fun mergeTakesTheNewerSideEitherWay() {
        assertEquals(
            "remote",
            VaultModel.merge(one("x", "local", 100), one("x", "remote", 200)).entries.single().name,
        )
        assertEquals(
            "local",
            VaultModel.merge(one("x", "local", 300), one("x", "remote", 200)).entries.single().name,
        )
    }

    @Test
    fun mergeKeepsEntriesPresentOnOnlyOneSide() {
        val local = VaultModel.parse(
            """{"entries":[{"id":"a","name":"A","updatedAt":1,"deletedAt":null}],"purged":[]}"""
        )
        val remote = VaultModel.parse(
            """{"entries":[{"id":"b","name":"B","updatedAt":1,"deletedAt":null}],"purged":[]}"""
        )
        val ids = VaultModel.merge(local, remote).entries.map { it.id }.sorted()
        assertEquals(listOf("a", "b"), ids)
    }

    @Test
    fun mergeUnionsPurgedAndDropsThoseEntries() {
        // A hard delete on either side must not be undone by the other side
        // still holding the entry.
        val local = VaultModel.parse(
            """{"entries":[{"id":"a","name":"A","updatedAt":1,"deletedAt":null},
                           {"id":"b","name":"B","updatedAt":1,"deletedAt":null}],
                "purged":["a"]}"""
        )
        val remote = VaultModel.parse(
            """{"entries":[{"id":"a","name":"A","updatedAt":9,"deletedAt":null},
                           {"id":"b","name":"B","updatedAt":9,"deletedAt":null}],
                "purged":["b"]}"""
        )
        val merged = VaultModel.merge(local, remote)
        assertEquals("both purged ids survive", listOf("a", "b"), merged.purged.sorted())
        assertEquals("no purged entry survives", emptyList<String>(), merged.entries.map { it.id })
    }

    @Test
    fun mergeOutputSerializesBackCleanly() {
        val merged = VaultModel.merge(fixtureData(), one("extra", "Remote only", 1))
        val again = VaultModel.parse(VaultModel.serialize(merged))
        assertEquals("fixture entries plus the remote-only one", 9, again.entries.size)
        assertEquals(listOf("fixture-99-purged"), again.purged)
        assertTrue(again.entries.any { it.id == "extra" })
    }
}
