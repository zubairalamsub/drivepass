package com.drivepass.android

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith

/**
 * TOTP against the RFC 6238 Appendix B reference vectors, same ones the desktop
 * suite pins. A code that is merely plausible is worse than none: it locks the
 * user out of the account the vault exists to get them into.
 */
@RunWith(AndroidJUnit4::class)
class TotpTest {

    // ASCII seed "12345678901234567890" in Base32.
    private val rfcSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"

    private val vectors = listOf(
        59L to "94287082",
        1111111109L to "07081804",
        1111111111L to "14050471",
        1234567890L to "89005924",
        2000000000L to "69279037",
    )

    @Test
    fun matchesRfc6238EightDigitVectors() {
        for ((seconds, expected) in vectors) {
            assertEquals(
                "RFC 6238 vector at T=$seconds",
                expected,
                Totp.generate(rfcSecret, seconds * 1000, 30, 8),
            )
        }
    }

    @Test
    fun sixDigitCodesAreTheLowSixDigits() {
        for ((seconds, expected) in vectors) {
            assertEquals(expected.takeLast(6), Totp.generate(rfcSecret, seconds * 1000, 30, 6))
        }
    }

    @Test
    fun zeroPadsToTheRequestedWidth() {
        // T=1234567890 -> 89005924; the six-digit form starts with a zero.
        assertEquals("005924", Totp.generate(rfcSecret, 1234567890_000L, 30, 6))
    }

    @Test
    fun codeIsStableWithinAPeriodAndRollsAtTheBoundary() {
        assertEquals(Totp.generate(rfcSecret, 30_000), Totp.generate(rfcSecret, 59_000))
        assertNotEquals(Totp.generate(rfcSecret, 59_000), Totp.generate(rfcSecret, 60_000))
    }

    @Test
    fun acceptsLowercaseSpacedAndOtpauthForms() {
        val expected = Totp.generate(rfcSecret, 59_000, 30, 8)
        assertEquals(expected, Totp.generate(rfcSecret.lowercase(), 59_000, 30, 8))
        assertEquals(expected, Totp.generate("GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ", 59_000, 30, 8))
        assertEquals(
            expected,
            Totp.generate("otpauth://totp/GitHub:a@b.com?secret=$rfcSecret&issuer=GitHub", 59_000, 30, 8),
        )
    }

    @Test
    fun unusableSecretsYieldNullNotAWrongCode() {
        for (bad in listOf("", "   ", "!!!!", null)) {
            assertNull("input=${bad}", Totp.generate(bad, 59_000))
        }
    }

    @Test
    fun countdownStaysWithinThePeriod() {
        for (s in 0..120) {
            val left = Totp.secondsRemaining(30, s * 1000L)
            assert(left in 1..30) { "t=$s gave $left" }
        }
        assertEquals(30, Totp.secondsRemaining(30, 0))
        assertEquals(29, Totp.secondsRemaining(30, 1000))
        assertEquals(1, Totp.secondsRemaining(30, 29_000))
    }

    @Test
    fun agreesWithTheDesktopImplementation() {
        // The fixture entries carry JBSWY3DPEHPK3PXP. This expected value was
        // produced by the extension's own src/lib/totp.js, not derived by hand —
        // the two clients must agree digit for digit or 2FA silently breaks.
        assertEquals("282760", Totp.generate("JBSWY3DPEHPK3PXP", 0L))
    }
}
