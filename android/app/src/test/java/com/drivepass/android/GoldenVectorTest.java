package com.drivepass.android;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Base64;

import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Pins the interop contract against values produced by the Chrome extension's
 * own src/lib/crypto.js.
 *
 * Written in plain Java against the JDK only — VaultCrypto itself depends on
 * android.util.Base64, which is not available in a JVM unit test. The
 * instrumented variant of this test is the one that matters, because the device
 * uses a different JCA provider than the desktop JVM; this one catches the
 * arithmetic mistakes early and for free.
 *
 * The password is deliberately NON-ASCII. An ASCII-only vector passes even when
 * the password->bytes convention is wrong, which is the single most likely way
 * this port silently produces an unopenable vault.
 */
public class GoldenVectorTest {

    private static final String PASSWORD = "Tëst-Pässwörd-🔐";
    private static final int ITERATIONS = 210_000;
    private static final String PLAINTEXT = "{\"entries\":[]}";

    private static final String EXPECT_PW_HEX = "54c3ab73742d50c3a4737377c3b672642df09f9490";
    private static final String EXPECT_KEY_HEX =
            "3cbff337059dcc6693631784836389472b0d99ba1b14d8ef5f0a2337ede23b6a";
    private static final String EXPECT_CT_B64 = "sBSsHrA26M8plto7YzHBnZS+Pfdo4oOq0Kc0do2t";

    private static byte[] ramp(int n) {
        byte[] b = new byte[n];
        for (int i = 0; i < n; i++) b[i] = (byte) i;
        return b;
    }

    private static String hex(byte[] b) {
        StringBuilder s = new StringBuilder();
        for (byte x : b) s.append(String.format("%02x", x));
        return s.toString();
    }

    /** RFC 2898 over HMAC-SHA-256, taking password BYTES so no provider decides the encoding. */
    private static byte[] pbkdf2(byte[] password, byte[] salt, int iterations, int dkLen)
            throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(password, "HmacSHA256"));
        int hLen = mac.getMacLength();
        int blocks = (dkLen + hLen - 1) / hLen;
        byte[] out = new byte[blocks * hLen];
        byte[] block = new byte[salt.length + 4];
        System.arraycopy(salt, 0, block, 0, salt.length);
        for (int i = 1; i <= blocks; i++) {
            block[salt.length] = (byte) (i >>> 24);
            block[salt.length + 1] = (byte) (i >>> 16);
            block[salt.length + 2] = (byte) (i >>> 8);
            block[salt.length + 3] = (byte) i;
            byte[] u = mac.doFinal(block);
            byte[] acc = u.clone();
            for (int c = 1; c < iterations; c++) {
                u = mac.doFinal(u);
                for (int k = 0; k < acc.length; k++) acc[k] ^= u[k];
            }
            System.arraycopy(acc, 0, out, (i - 1) * hLen, hLen);
        }
        return Arrays.copyOf(out, dkLen);
    }

    @Test
    public void passwordIsRawUtf8_noNormalization() {
        byte[] pw = PASSWORD.getBytes(StandardCharsets.UTF_8);
        assertEquals("password must be 21 UTF-8 bytes", 21, pw.length);
        assertEquals(EXPECT_PW_HEX, hex(pw));
    }

    @Test
    public void derivedKeyMatchesWebCrypto() throws Exception {
        byte[] key = pbkdf2(PASSWORD.getBytes(StandardCharsets.UTF_8), ramp(16), ITERATIONS, 32);
        assertEquals(EXPECT_KEY_HEX, hex(key));
    }

    @Test
    public void ciphertextMatchesWebCryptoByteForByte() throws Exception {
        byte[] key = pbkdf2(PASSWORD.getBytes(StandardCharsets.UTF_8), ramp(16), ITERATIONS, 32);
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, ramp(12)));
        byte[] ct = c.doFinal(PLAINTEXT.getBytes(StandardCharsets.UTF_8));
        assertEquals(EXPECT_CT_B64, Base64.getEncoder().encodeToString(ct));
    }

    @Test
    public void tagIsAppended_sizeInvariantHolds() throws Exception {
        byte[] ct = Base64.getDecoder().decode(EXPECT_CT_B64);
        assertEquals("ciphertext must be plaintext + 16-byte tag",
                PLAINTEXT.getBytes(StandardCharsets.UTF_8).length + 16, ct.length);
    }

    @Test
    public void decryptsExtensionCiphertext() throws Exception {
        byte[] key = pbkdf2(PASSWORD.getBytes(StandardCharsets.UTF_8), ramp(16), ITERATIONS, 32);
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, ramp(12)));
        byte[] plain = c.doFinal(Base64.getDecoder().decode(EXPECT_CT_B64));
        assertEquals(PLAINTEXT, new String(plain, StandardCharsets.UTF_8));
    }

    @Test
    public void latin1PasswordConventionProducesDifferentKey() throws Exception {
        // Demonstrates the landmine rather than merely commenting on it: keeping
        // the low 8 bits of each UTF-16 char (what BouncyCastle's low-level
        // PKCS5PasswordToBytes does) must NOT match.
        char[] chars = PASSWORD.toCharArray();
        byte[] latin1 = new byte[chars.length];
        for (int i = 0; i < chars.length; i++) latin1[i] = (byte) chars[i];
        byte[] wrong = pbkdf2(latin1, ramp(16), ITERATIONS, 32);
        assertTrue("Latin-1 convention must diverge from WebCrypto",
                !hex(wrong).equals(EXPECT_KEY_HEX));
    }

    @Test
    public void base64IsStandardWithPaddingNoWrap() {
        assertEquals("AAECAwQFBgcICQoLDA0ODw==", Base64.getEncoder().encodeToString(ramp(16)));
        assertEquals("AAECAwQFBgcICQoL", Base64.getEncoder().encodeToString(ramp(12)));
        assertArrayEquals(ramp(16), Base64.getDecoder().decode("AAECAwQFBgcICQoLDA0ODw=="));
    }
}
