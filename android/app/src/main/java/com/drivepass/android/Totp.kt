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

        return try {
            // Coerced, not trusted. `period` is a divisor, and these become
            // caller-supplied the moment otpauth:// parameters are honoured —
            // a period of 0 in a synced vault would otherwise throw straight
            // out of a function documented never to. The desktop coerces the
            // same way (`parseInt(...) || 30`).
            val step = if (period > 0) period else 30
            val width = digits.coerceIn(1, 10)
            // Inside the try with everything else: this division is exactly
            // the one that used to escape it.
            val counter = (timeMillis / 1000) / step
            val msg = ByteBuffer.allocate(8).putLong(counter).array()
            val mac = Mac.getInstance("HmacSHA1")
            mac.init(SecretKeySpec(keyBytes, "HmacSHA1"))
            val h = mac.doFinal(msg)
            val offset = (h[h.size - 1].toInt() and 0x0f)
            val binary = ((h[offset].toInt() and 0x7f) shl 24) or
                ((h[offset + 1].toInt() and 0xff) shl 16) or
                ((h[offset + 2].toInt() and 0xff) shl 8) or
                (h[offset + 3].toInt() and 0xff)
            // Long, not Int: 10^10 overflows an Int, and `digits` stops being
            // a constant as soon as URIs are parsed properly.
            var mod = 1L
            repeat(width) { mod *= 10L }
            (binary % mod).toString().padStart(width, '0')
        } catch (e: Exception) {
            null
        }
    }

    /** Whole seconds left in the step: 1..period, and never 0. */
    fun secondsRemaining(period: Int = 30, timeMillis: Long = System.currentTimeMillis()): Int {
        val step = if (period > 0) period else 30
        return step - ((timeMillis / 1000) % step).toInt()
    }

    /**
     * How much of the current step is left: 1f at its start, approaching 0f at
     * its end.
     *
     * [secondsRemaining] is deliberately 1..period and never 0, which is right
     * for the number on screen and wrong for a progress ring — that would step
     * from full to 1/period and never reach empty. This is the continuous
     * version, and unlike a hard-coded /30f it is correct for any period.
     */
    fun fractionRemaining(period: Int = 30, timeMillis: Long = System.currentTimeMillis()): Float {
        val span = (if (period > 0) period else 30) * 1000L
        return (span - Math.floorMod(timeMillis, span)) / span.toFloat()
    }
}
