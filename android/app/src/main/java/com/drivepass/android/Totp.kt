package com.drivepass.android

import java.nio.ByteBuffer
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * RFC 6238 TOTP, ported from src/lib/totp.js.
 *
 * Verified against the RFC 6238 Appendix B vectors in the instrumented tests —
 * a generator that is merely plausible is worthless here, because a wrong code
 * locks the user out of the account the vault exists to get them into.
 */
object Totp {

    private const val B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

    /** Accepts a bare Base32 secret or a full otpauth:// URI, like the desktop does. */
    fun parseSecret(secretOrUri: String?): String {
        val s = secretOrUri?.trim().orEmpty()
        if (s.isEmpty()) return ""
        if (s.lowercase().startsWith("otpauth://")) {
            // Deliberately not android.net.Uri: query parsing differences between
            // WHATWG URL and Uri are exactly the kind of thing that silently
            // diverges. Extract the parameter directly.
            val q = s.substringAfter('?', "")
            for (pair in q.split('&')) {
                val (k, v) = pair.split('=', limit = 2).let { it[0] to it.getOrElse(1) { "" } }
                if (k == "secret") return v.replace("\\s".toRegex(), "").uppercase()
            }
            return ""
        }
        return s.replace("\\s".toRegex(), "").uppercase()
    }

    private fun base32Decode(b32: String): ByteArray {
        val clean = b32.uppercase().filter { it in B32 }
        val bits = StringBuilder(clean.length * 5)
        for (c in clean) {
            bits.append(B32.indexOf(c).toString(2).padStart(5, '0'))
        }
        val out = ByteArray(bits.length / 8)
        for (i in out.indices) {
            out[i] = bits.substring(i * 8, i * 8 + 8).toInt(2).toByte()
        }
        return out
    }

    /**
     * Returns the code, or null if the secret is unusable — never a bogus code,
     * matching the desktop's behaviour.
     */
    fun generate(
        secretOrUri: String?,
        timeMillis: Long = System.currentTimeMillis(),
        period: Int = 30,
        digits: Int = 6,
    ): String? {
        val raw = parseSecret(secretOrUri)
        if (raw.isEmpty()) return null
        val keyBytes = try {
            base32Decode(raw)
        } catch (e: Exception) {
            return null
        }
        if (keyBytes.isEmpty()) return null

        val counter = (timeMillis / 1000) / period
        val msg = ByteBuffer.allocate(8).putLong(counter).array()

        return try {
            val mac = Mac.getInstance("HmacSHA1")
            mac.init(SecretKeySpec(keyBytes, "HmacSHA1"))
            val h = mac.doFinal(msg)
            val offset = (h[h.size - 1].toInt() and 0x0f)
            val binary = ((h[offset].toInt() and 0x7f) shl 24) or
                ((h[offset + 1].toInt() and 0xff) shl 16) or
                ((h[offset + 2].toInt() and 0xff) shl 8) or
                (h[offset + 3].toInt() and 0xff)
            var mod = 1
            repeat(digits) { mod *= 10 }
            (binary % mod).toString().padStart(digits, '0')
        } catch (e: Exception) {
            null
        }
    }

    fun secondsRemaining(period: Int = 30, timeMillis: Long = System.currentTimeMillis()): Int =
        period - ((timeMillis / 1000) % period).toInt()
}
