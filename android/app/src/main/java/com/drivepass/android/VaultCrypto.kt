package com.drivepass.android

import android.util.Base64
import org.json.JSONObject
import java.nio.charset.StandardCharsets
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * The DrivePass vault envelope, exactly as the Chrome extension writes it.
 *
 * Six cleartext fields; only [ciphertext] is protected. [salt], [iterations]
 * and [format] deliberately live OUTSIDE the AEAD — there is no AAD anywhere,
 * so never call Cipher.updateAAD.
 */
data class VaultEnvelope(
    val format: String,
    val kdf: String,
    val iterations: Int,
    val salt: ByteArray,
    val iv: ByteArray,
    val ciphertext: ByteArray,
) {
    // data class equals/hashCode on ByteArray compares references; not needed
    // here, but override so accidental use is not silently wrong.
    override fun equals(other: Any?) = this === other
    override fun hashCode() = System.identityHashCode(this)
}

sealed class VaultError(message: String) : Exception(message) {
    class UnrecognizedFormat(found: String?) :
        VaultError("Unrecognized vault file format: ${found ?: "(missing)"}")
    class UnsupportedKdf(found: String?) : VaultError("Unsupported KDF: ${found ?: "(missing)"}")
    class UnsafeKdfCost(n: Long) : VaultError("This vault file declares an unsafe KDF cost ($n).")
    class Corrupt(detail: String) : VaultError("Corrupt vault file: $detail")
    object WrongPassword : VaultError("Wrong master password or corrupted vault.")
}

object VaultCrypto {

    const val FORMAT = "drivepass-v1"
    const val KDF_NAME = "PBKDF2-SHA256"
    const val KDF_ITERATIONS = 210_000
    const val MIN_ACCEPTED_ITERATIONS = 100_000
    const val MAX_ACCEPTED_ITERATIONS = 10_000_000

    private const val KEY_BYTES = 32 // AES-256
    private const val SALT_BYTES = 16
    private const val IV_BYTES = 12
    private const val GCM_TAG_BITS = 128 // BITS. Passing 16 here compiles and breaks everything.

    /**
     * Standard RFC 4648 base64 WITH padding and NO line breaks — what btoa
     * produces. NO_WRAP is mandatory: Base64.DEFAULT inserts a newline every 76
     * chars and the ciphertext is multi-KB, so it would fire every time and
     * atob() would throw on the extension side.
     */
    private fun b64encode(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.NO_WRAP)

    private fun b64decode(s: String, field: String): ByteArray = try {
        Base64.decode(s, Base64.DEFAULT)
    } catch (e: IllegalArgumentException) {
        throw VaultError.Corrupt("field '$field' is not valid base64")
    }

    /** Parse the envelope, validating everything the extension does and more. */
    fun parseEnvelope(json: String): VaultEnvelope {
        val o = try {
            JSONObject(json)
        } catch (e: Exception) {
            throw VaultError.Corrupt("not valid JSON")
        }

        val format = o.optString("format", "")
        if (format != FORMAT) throw VaultError.UnrecognizedFormat(format.ifEmpty { null })

        // The extension ignores `kdf` on read; we harden by rejecting anything
        // else, which is safe because it never writes another value.
        val kdf = o.optString("kdf", "")
        if (kdf != KDF_NAME) throw VaultError.UnsupportedKdf(kdf.ifEmpty { null })

        // Reproduce `Number(fileObj.iterations) || KDF_ITERATIONS`: absent, 0,
        // or unparseable all fall back to the default.
        val rawIter = o.opt("iterations")
        val iterations: Long = when (rawIter) {
            null -> KDF_ITERATIONS.toLong()
            is Number -> rawIter.toLong()
            is String -> rawIter.toDoubleOrNull()?.toLong() ?: KDF_ITERATIONS.toLong()
            else -> KDF_ITERATIONS.toLong()
        }.let { if (it == 0L) KDF_ITERATIONS.toLong() else it }

        if (iterations < MIN_ACCEPTED_ITERATIONS || iterations > MAX_ACCEPTED_ITERATIONS) {
            throw VaultError.UnsafeKdfCost(iterations)
        }

        // Validate base64 BEFORE spending seconds on derivation, and surface
        // corruption as corruption rather than as "wrong password".
        for (f in listOf("salt", "iv", "ciphertext")) {
            if (!o.has(f)) throw VaultError.Corrupt("field '$f' is missing")
        }
        val salt = b64decode(o.getString("salt"), "salt")
        val iv = b64decode(o.getString("iv"), "iv")
        val ct = b64decode(o.getString("ciphertext"), "ciphertext")

        if (iv.size != IV_BYTES) throw VaultError.Corrupt("iv is ${iv.size} bytes, expected $IV_BYTES")
        if (ct.size < 16) throw VaultError.Corrupt("ciphertext shorter than the GCM tag")

        return VaultEnvelope(format, kdf, iterations.toInt(), salt, iv, ct)
    }

    /**
     * PBKDF2-HMAC-SHA256 over the RAW UTF-8 BYTES of the password.
     *
     * Deliberately hand-rolled over Mac rather than going through
     * SecretKeyFactory/PBEKeySpec, which take a char[] and leave the
     * password->bytes conversion to the provider. That conversion is where
     * interop dies: BouncyCastle's low-level PKCS5PasswordToBytes keeps only the
     * low 8 bits of each UTF-16 char, silently deriving a different key for any
     * non-ASCII password. Encoding the bytes ourselves removes the provider from
     * the decision entirely.
     *
     * No Unicode normalization, no NUL terminator, no trimming — matching
     * `new TextEncoder().encode(password)`.
     */
    fun deriveKey(password: CharArray, salt: ByteArray, iterations: Int): ByteArray {
        val pwBytes = toUtf8(password)
        try {
            val mac = Mac.getInstance("HmacSHA256")
            mac.init(SecretKeySpec(pwBytes, "HmacSHA256"))
            val hLen = mac.macLength
            val blocks = (KEY_BYTES + hLen - 1) / hLen
            val out = ByteArray(blocks * hLen)
            val block = ByteArray(salt.size + 4)
            System.arraycopy(salt, 0, block, 0, salt.size)
            for (i in 1..blocks) {
                block[salt.size] = (i ushr 24).toByte()
                block[salt.size + 1] = (i ushr 16).toByte()
                block[salt.size + 2] = (i ushr 8).toByte()
                block[salt.size + 3] = i.toByte()
                var u = mac.doFinal(block)
                val acc = u.copyOf()
                for (c in 1 until iterations) {
                    u = mac.doFinal(u)
                    for (k in acc.indices) acc[k] = (acc[k].toInt() xor u[k].toInt()).toByte()
                }
                System.arraycopy(acc, 0, out, (i - 1) * hLen, hLen)
            }
            return out.copyOf(KEY_BYTES).also { out.fill(0) }
        } finally {
            pwBytes.fill(0)
        }
    }

    /** UTF-8 encode a char[] without ever materialising a String (immutable, GC-copied, heap-dumpable). */
    private fun toUtf8(chars: CharArray): ByteArray {
        val bb = StandardCharsets.UTF_8.encode(java.nio.CharBuffer.wrap(chars))
        val out = ByteArray(bb.remaining())
        bb.get(out)
        if (bb.hasArray()) bb.array().fill(0)
        return out
    }

    /** Decrypt to the plaintext JSON payload. AEADBadTagException => wrong password. */
    fun decrypt(key: ByteArray, envelope: VaultEnvelope): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.DECRYPT_MODE,
            SecretKeySpec(key, "AES"),
            GCMParameterSpec(GCM_TAG_BITS, envelope.iv),
        )
        val plain = try {
            cipher.doFinal(envelope.ciphertext)
        } catch (e: javax.crypto.AEADBadTagException) {
            throw VaultError.WrongPassword
        } catch (e: javax.crypto.BadPaddingException) {
            throw VaultError.WrongPassword
        } catch (e: javax.crypto.IllegalBlockSizeException) {
            throw VaultError.Corrupt("ciphertext length invalid")
        }
        return String(plain, StandardCharsets.UTF_8).also { plain.fill(0) }
    }

    /**
     * Encrypt with a FRESH random IV every time. The salt (and therefore the
     * key) is stable while the file is re-encrypted on every mutation, so IV
     * uniqueness is the only thing standing between this format and
     * catastrophic GCM nonce reuse. Never reuse the envelope's existing iv.
     */
    fun seal(key: ByteArray, plaintextJson: String, prev: VaultEnvelope): VaultEnvelope {
        val iv = ByteArray(IV_BYTES).also { java.security.SecureRandom().nextBytes(it) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(GCM_TAG_BITS, iv))
        val ct = cipher.doFinal(plaintextJson.toByteArray(StandardCharsets.UTF_8))
        // KDF params MUST carry over: the key was derived from them.
        return VaultEnvelope(FORMAT, KDF_NAME, prev.iterations, prev.salt, iv, ct)
    }

    fun envelopeToJson(e: VaultEnvelope): String = JSONObject().apply {
        put("format", e.format)
        put("kdf", e.kdf)
        put("iterations", e.iterations)
        put("salt", b64encode(e.salt))
        put("iv", b64encode(e.iv))
        put("ciphertext", b64encode(e.ciphertext))
    }.toString()

    fun needsKdfUpgrade(e: VaultEnvelope) = e.iterations < KDF_ITERATIONS

    fun hex(bytes: ByteArray): String =
        bytes.joinToString("") { "%02x".format(it) }
}
