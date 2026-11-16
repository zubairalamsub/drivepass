package com.drivepass.android

import android.net.Uri
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Editing: the model mutations, and the write that puts them on disk.
 *
 * The writer tests are the ones that matter most. They exercise the real
 * ContentResolver on a real device, because the failure they guard against —
 * a write that leaves the old file's tail behind — is a property of how the
 * platform opens the file, not of anything in this codebase.
 */
@RunWith(AndroidJUnit4::class)
class VaultEditTest {

    private val password = "correct-horse-battery-staple".toCharArray()
    private val ctx get() = InstrumentationRegistry.getInstrumentation().targetContext

    /** Scratch, so nothing here touches the app's real backup directory. */
    private val scratch get() = File(ctx.cacheDir, "vault-edit-test").apply { mkdirs() }

    @After
    fun cleanUp() {
        scratch.deleteRecursively()
    }

    private fun fixtureText() =
        ctx.assets.open("fixture-vault.enc").bufferedReader().use { it.readText() }

    private class Opened(val env: VaultEnvelope, val key: ByteArray, val data: VaultData)

    private fun open(): Opened {
        val env = VaultCrypto.parseEnvelope(fixtureText())
        val key = VaultCrypto.deriveKey(password.copyOf(), env.salt, env.iterations)
        return Opened(env, key, VaultModel.parse(VaultCrypto.decrypt(key, env)))
    }

    private fun VaultData.byId(id: String) = entries.single { it.id == id }

    // ---- upsert --------------------------------------------------------------

    @Test
    fun changingThePasswordPushesTheOldOneOntoHistory() {
        val d = open().data
        val before = d.byId("fixture-01")
        val e = VaultModel.upsert(d, EntryDraft.of(before).copy(password = "rotated")).byId("fixture-01")

        assertEquals("rotated", e.password)
        val history = e.raw.getJSONArray("history")
        assertEquals(1, history.length())
        assertEquals(before.password, history.getJSONObject(0).getString("password"))
        // The desktop's shape is {password, updatedAt} — not changedAt.
        assertTrue(history.getJSONObject(0).has("updatedAt"))
    }

    @Test
    fun anUnchangedPasswordAddsNoHistory() {
        val d = open().data
        val e = VaultModel.upsert(d, EntryDraft.of(d.byId("fixture-01")).copy(name = "Renamed"))
            .byId("fixture-01")
        assertEquals("Renamed", e.name)
        assertEquals(0, e.raw.getJSONArray("history").length())
    }

    @Test
    fun historyIsCappedAtTenNewestFirst() {
        var d = open().data
        repeat(12) { i -> d = VaultModel.upsert(d, EntryDraft.of(d.byId("fixture-01")).copy(password = "p$i")) }
        val history = d.byId("fixture-01").raw.getJSONArray("history")
        assertEquals(10, history.length())
        assertEquals("newest pushed first", "p10", history.getJSONObject(0).getString("password"))
    }

    @Test
    fun anEditKeepsFieldsTheEditorCannotSee() {
        // The UI refuses to edit passkeys, but the model must be safe anyway.
        val d = open().data
        val e = VaultModel.upsert(d, EntryDraft.of(d.byId("fixture-07")).copy(name = "Renamed"))
            .byId("fixture-07")
        assertEquals("Renamed", e.name)
        assertEquals("QUJDRA==", e.raw.getJSONObject("passkey").getString("credentialId"))
        assertEquals("cloudflare.com", e.passkeyRpId)
    }

    @Test
    fun aNewEntryGetsAnIdAndMatchingTimestamps() {
        val d = open().data
        val out = VaultModel.upsert(d, EntryDraft(name = "New", password = "x"))
        assertEquals(d.entries.size + 1, out.entries.size)
        val e = out.entries.last()
        assertTrue(e.id.isNotBlank())
        assertTrue(e.createdAt > 0)
        assertEquals(e.createdAt, e.updatedAt)
        assertNull(e.deletedAt)
    }

    @Test
    fun savingADeletedEntryRestoresIt() {
        val d = VaultModel.softDelete(open().data, "fixture-01")
        val out = VaultModel.upsert(d, EntryDraft.of(d.byId("fixture-01")).copy(name = "Back"))
        assertFalse(out.byId("fixture-01").isDeleted)
    }

    // ---- delete --------------------------------------------------------------

    @Test
    fun softDeleteTombstonesWithoutRemovingAndRestoreUndoes() {
        val d = open().data
        val deleted = VaultModel.softDelete(d, "fixture-01")
        assertEquals("never removed outright", d.entries.size, deleted.entries.size)
        assertTrue(deleted.byId("fixture-01").isDeleted)
        assertEquals("purged is not touched", d.purged, deleted.purged)

        assertFalse(VaultModel.restore(deleted, "fixture-01").byId("fixture-01").isDeleted)
    }

    // ---- through the crypto --------------------------------------------------

    @Test
    fun anEditedVaultResealsAndOpensWithTheSameKey() {
        val o = open()
        val edited = VaultModel.upsert(o.data, EntryDraft.of(o.data.byId("fixture-01")).copy(password = "rotated"))
        val json = VaultCrypto.envelopeToJson(VaultCrypto.seal(o.key, VaultModel.serialize(edited), o.env))

        val again = VaultModel.parse(VaultCrypto.decrypt(o.key, VaultCrypto.parseEnvelope(json)))
        assertEquals("rotated", again.byId("fixture-01").password)
        assertEquals(8, again.entries.size)
        assertEquals(listOf("fixture-99-purged"), again.purged)
    }

    // ---- the writer ----------------------------------------------------------

    @Test
    fun aShorterWriteLeavesNoTrailingBytes() {
        // The trap: "w" does not truncate. A shorter payload then leaves the
        // old file's tail behind; Android's JSONTokener ignores it, the
        // extension's JSON.parse does not, and the vault silently becomes
        // unreadable on the desktop. Deleting an entry is exactly this case.
        val o = open()
        val file = File(scratch, "vault.enc").apply { writeText(fixtureText()) }
        val small = VaultCrypto.envelopeToJson(
            VaultCrypto.seal(o.key, """{"entries":[],"purged":[]}""", o.env),
        )
        assertTrue("the test needs a shorter payload", small.toByteArray().size < file.length())

        VaultWriter.write(ctx, Uri.fromFile(file), small, backupDir = File(scratch, "bk"))

        assertEquals("exactly the new payload, with no tail", small, file.readText())
    }

    @Test
    fun aWriteBacksUpThePreviousVersionFirst() {
        val o = open()
        val original = fixtureText()
        val file = File(scratch, "vault.enc").apply { writeText(original) }
        val bk = File(scratch, "bk")
        val next = VaultCrypto.envelopeToJson(VaultCrypto.seal(o.key, VaultModel.serialize(o.data), o.env))

        VaultWriter.write(ctx, Uri.fromFile(file), next, backupDir = bk)

        val backup = VaultWriter.latestBackup(ctx, bk) ?: return fail("no backup was written")
        assertEquals("the backup is the pre-write contents", original, backup.readText())
        assertEquals(next, file.readText())
    }

    @Test
    fun aVaultPickedThroughTheDriveAppIsNeverWritable() {
        val drive = Uri.parse("content://com.google.android.apps.docs.storage/document/acc%3D1%3Bdoc%3Dabc")
        assertFalse("offered for editing", VaultWriter.isWritable(ctx, drive))
        try {
            VaultWriter.write(ctx, drive, "{}", backupDir = File(scratch, "bk"))
            fail("write() must refuse the Drive provider outright")
        } catch (e: VaultWriter.NotWritable) {
            // expected — and before any backup or open was attempted
        }
        assertFalse("nothing was backed up", File(scratch, "bk").exists())
    }

    @Test
    fun backupsAreRotatedToTheNewestThree() {
        val o = open()
        val file = File(scratch, "vault.enc").apply { writeText(fixtureText()) }
        val bk = File(scratch, "bk")
        repeat(5) {
            val json = VaultCrypto.envelopeToJson(VaultCrypto.seal(o.key, VaultModel.serialize(o.data), o.env))
            VaultWriter.write(ctx, Uri.fromFile(file), json, backupDir = bk)
            Thread.sleep(5) // distinct millisecond names
        }
        assertEquals(3, bk.listFiles()!!.size)
    }
}
