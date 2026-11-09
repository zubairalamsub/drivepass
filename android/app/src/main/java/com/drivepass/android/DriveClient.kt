package com.drivepass.android

import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/**
 * The slice of the Drive v3 REST API this app needs: find vault.enc and read it.
 *
 * Hand-rolled over HttpURLConnection rather than pulled in with the Drive client
 * library. The whole surface is two GETs, and a process that holds decrypted
 * vault material is the wrong place to add a transitive dependency tree nobody
 * in this repo has read.
 *
 * Nothing here ever uploads: the Android app stays read-only, so there is no
 * code path that can overwrite the vault the extension owns.
 *
 * Every call blocks. Callers are expected to be on Dispatchers.IO.
 */
object DriveClient {

    private const val API = "https://www.googleapis.com/drive/v3"

    /** The filename the extension writes; see src/lib/vault.js FILE_NAME. */
    const val VAULT_NAME = "vault.enc"

    /** A real vault is kilobytes. Refuse to stream anything absurd into memory. */
    private const val MAX_BYTES = 32 * 1024 * 1024

    /** A vault.enc the signed-in account has granted this app access to. */
    data class DriveFile(val id: String, val name: String)

    /** Drive answered, but not with something usable. */
    class DriveError(message: String) : Exception(message)

    /** The access token was rejected. The caller should re-authorize. */
    class Unauthorized : Exception("Google sign-in has expired.")

    /** Drive could not be reached at all. */
    class Offline(cause: Throwable) : Exception("No connection to Google Drive.", cause)

    /**
     * The most recently modified vault.enc this app can see, or null if there is
     * none.
     *
     * With the drive.file scope this listing only ever contains files this app
     * created or that the user explicitly opened for it, so it cannot be used to
     * enumerate the rest of the user's Drive — the same guarantee the extension
     * relies on.
     */
    fun findVault(token: String): DriveFile? {
        val q = URLEncoder.encode("name='$VAULT_NAME' and trashed=false", "UTF-8")
        val fields = URLEncoder.encode("files(id,name)", "UTF-8")
        val order = URLEncoder.encode("modifiedTime desc", "UTF-8")
        val body = get("$API/files?q=$q&orderBy=$order&pageSize=10&fields=$fields", token)

        val files = runCatching { JSONObject(body).optJSONArray("files") }.getOrNull()
            ?: throw DriveError("Drive returned a listing that couldn't be read.")
        if (files.length() == 0) return null
        val first = files.getJSONObject(0)
        val id = first.optString("id").takeIf { it.isNotEmpty() }
            ?: throw DriveError("Drive returned a file with no id.")
        return DriveFile(id, first.optString("name", VAULT_NAME))
    }

    /** The file's bytes, as the UTF-8 text the vault envelope is stored in. */
    fun download(token: String, fileId: String): String =
        get("$API/files/$fileId?alt=media", token)

    // ---- transport -----------------------------------------------------------

    private fun get(url: String, token: String): String {
        val conn = try {
            (URL(url).openConnection() as HttpURLConnection)
        } catch (e: IOException) {
            throw Offline(e)
        }
        return try {
            conn.requestMethod = "GET"
            conn.setRequestProperty("Authorization", "Bearer $token")
            conn.setRequestProperty("Accept", "application/json")
            conn.connectTimeout = 15_000
            conn.readTimeout = 30_000

            val code = try {
                conn.responseCode
            } catch (e: IOException) {
                throw Offline(e)
            }
            when {
                code == 401 -> throw Unauthorized()
                code == 403 -> throw DriveError(
                    "Google Drive refused the request. Check that the Drive API is " +
                        "enabled for this app's Cloud project."
                )
                code == 404 -> throw DriveError("That vault file is no longer in Drive.")
                code !in 200..299 -> throw DriveError("Google Drive returned HTTP $code.")
            }
            conn.inputStream.use { it.readUpTo(MAX_BYTES) }
        } finally {
            conn.disconnect()
        }
    }

    private fun java.io.InputStream.readUpTo(max: Int): String {
        val out = java.io.ByteArrayOutputStream()
        val buf = ByteArray(8192)
        while (out.size() <= max) {
            val n = read(buf, 0, minOf(buf.size, max + 1 - out.size()))
            if (n < 0) break
            out.write(buf, 0, n)
        }
        if (out.size() > max) throw DriveError("That file is far too large to be a DrivePass vault.")
        return out.toString(Charsets.UTF_8.name())
    }
}
