package com.drivepass.android

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import java.io.File
import java.io.FileOutputStream

/**
 * Writing the vault back to the file it came from.
 *
 * SAF offers no atomic replace — no rename-over-existing, no temp-and-swap — so
 * there is a window where the user's only copy is half-written. Everything here
 * exists to narrow that window and to notice when it bites:
 *
 *  1. The complete bytes are produced BEFORE any stream is opened. Serialising
 *     lazily into an open stream means a failure halfway leaves a truncated
 *     file and no replacement content in hand.
 *  2. The current contents are copied to a local backup first.
 *  3. The write truncates, flushes and fsyncs.
 *  4. The file is read back and re-parsed. A write that silently did nothing,
 *     or left a tail, is caught while the user is still looking at the screen.
 */
object VaultWriter {

    /** The grant or the provider will not accept a write. */
    class NotWritable : Exception("DrivePass cannot write to that file.")

    /** The bytes that came back are not the bytes that went in. */
    class VerifyFailed(detail: String) : Exception("The vault did not save correctly ($detail).")

    private const val BACKUP_DIR = "vault-backup"
    private const val KEEP_BACKUPS = 3

    /**
     * Whether this document can be written.
     *
     * When the provider does not answer, this assumes yes: most do accept
     * writes, and the verify step at the end of [write] is what actually proves
     * it. Disabling the editor on an unanswered query would be the worse error.
     */
    fun isWritable(context: Context, uri: Uri): Boolean {
        if (isDriveProvider(uri)) return false
        val cursor = runCatching {
            context.contentResolver.query(
                uri,
                arrayOf(DocumentsContract.Document.COLUMN_FLAGS),
                null, null, null,
            )
        }.getOrNull() ?: return true
        cursor.use {
            if (!it.moveToFirst()) return true
            val flags = runCatching { it.getInt(0) }.getOrElse { return true }
            return flags and DocumentsContract.Document.FLAG_SUPPORTS_WRITE != 0
        }
    }

    /**
     * Replace the file's contents with [envelopeJson], then prove it worked.
     *
     * @throws NotWritable when the grant or provider refuses
     * @throws VerifyFailed when the readback does not parse
     */
    fun write(
        context: Context,
        uri: Uri,
        envelopeJson: String,
        backupDir: File = defaultBackupDir(context),
    ) {
        // Defence in depth: the UI never offers editing for these, but nothing
        // should reach the file through this path regardless.
        if (isDriveProvider(uri)) throw NotWritable()
        val bytes = envelopeJson.toByteArray(Charsets.UTF_8)
        backup(context, uri, backupDir)

        val cr = context.contentResolver
        var wrote = false

        // "wt" is MODE_TRUNCATE on top of write. Plain "w" does NOT truncate:
        // a shorter payload then leaves the old tail behind, and because
        // Android's JSONTokener ignores trailing content while the extension's
        // JSON.parse does not, the result is a vault only this app can open.
        // Deleting an entry is exactly the case that shortens the file.
        for (mode in listOf("wt", "w")) {
            val pfd = runCatching { cr.openFileDescriptor(uri, mode) }.getOrNull() ?: continue
            try {
                FileOutputStream(pfd.fileDescriptor).use { out ->
                    // Belt and braces: truncate explicitly even under "wt", in
                    // case a provider accepted the mode and ignored the flag.
                    runCatching { out.channel.truncate(0) }
                    out.write(bytes)
                    out.flush()
                    // Get it onto the device rather than leaving it in a page
                    // cache that a kill would discard.
                    runCatching { pfd.fileDescriptor.sync() }
                }
                wrote = true
            } finally {
                runCatching { pfd.close() }
            }
            if (wrote) break
        }

        if (!wrote) {
            // Last resort: a provider that refuses openFileDescriptor but
            // accepts a stream. No fsync is possible on this path.
            val ok = runCatching {
                cr.openOutputStream(uri, "wt")?.use { it.write(bytes); it.flush() } ?: throw NotWritable()
            }.isSuccess
            if (!ok) throw NotWritable()
        }

        verify(context, uri, bytes.size)
    }

    /** Read it back and parse it. Catches truncation, a tail, and a silent no-op. */
    private fun verify(context: Context, uri: Uri, expectedBytes: Int) {
        val text = runCatching {
            context.contentResolver.openInputStream(uri)?.use { it.readBytes().toString(Charsets.UTF_8) }
        }.getOrNull() ?: throw VerifyFailed("it could not be read back")

        val actual = text.toByteArray(Charsets.UTF_8).size
        if (actual != expectedBytes) throw VerifyFailed("$actual bytes on disk, expected $expectedBytes")
        runCatching { VaultCrypto.parseEnvelope(text) }
            .getOrElse { throw VerifyFailed("the saved file no longer parses") }
    }

    // ---- backups -------------------------------------------------------------

    /**
     * Copy the current contents aside before overwriting.
     *
     * This is ciphertext, so it is no more sensitive than the vault itself —
     * but it IS an extra copy living in app storage, and the README says so.
     * Best effort: a vault that cannot be read right now is usually a vault
     * that is about to fail the write anyway, and refusing to save because the
     * backup failed would be the wrong trade.
     */
    fun backup(context: Context, uri: Uri, dir: File = defaultBackupDir(context)) {
        runCatching {
            dir.mkdirs()
            val current = context.contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: return
            File(dir, "${System.currentTimeMillis()}.enc").writeBytes(current)
            dir.listFiles()
                ?.sortedByDescending { it.name }
                ?.drop(KEEP_BACKUPS)
                ?.forEach { it.delete() }
        }
    }

    /** The most recent backup, for a restore affordance after a failed write. */
    fun latestBackup(context: Context, dir: File = defaultBackupDir(context)): File? =
        dir.listFiles()?.maxByOrNull { it.name }

    /**
     * The Google Drive app's DocumentsProvider.
     *
     * A vault picked through it opens read-only. Its write support has been
     * inconsistent across app versions, and a failed write there corrupts the
     * very file the extension syncs — the worst possible place to find a bug.
     * It also gives no merge: the Drive app uploads whatever the phone wrote,
     * overwriting a concurrent desktop edit outright.
     *
     * The proper way to edit a Drive vault is the Drive REST path, with the
     * extension's merge-before-write protocol. Until that lands, refuse.
     */
    fun isDriveProvider(uri: Uri): Boolean =
        uri.authority?.startsWith("com.google.android.apps.docs") == true

    /**
     * Injectable so the instrumented tests write into a scratch directory: they
     * run inside the real app's process, and backups made against the fixture
     * would otherwise rotate the user's genuine backups out.
     */
    fun defaultBackupDir(context: Context) = File(context.filesDir, BACKUP_DIR)
}
