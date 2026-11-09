package com.drivepass.android

import android.content.SharedPreferences
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Quick unlock: reopening a vault already known to this device with a
 * fingerprint or a DrivePass PIN, instead of retyping the master password.
 *
 * The master password itself is never stored. What is stored is the 32-byte key
 * PBKDF2 derived from it, wrapped so that the stored bytes are useless alone:
 *
 *     biometric   Keystore_bio( vaultKey )
 *     PIN         Keystore_pin( PBKDF2(pin)( vaultKey ) )
 *
 * Both wrapping keys are generated inside the AndroidKeyStore and cannot be
 * exported, so a copy of this app's SharedPreferences taken off the device
 * decrypts to nothing. The PIN layer sits INSIDE the Keystore layer on purpose:
 * a four-digit PIN is 14 bits, and it must never be the only thing between an
 * attacker and the vault key — they need this specific device too.
 *
 * Even so, a PIN is guessable by someone holding the phone, so failures are
 * counted across process death and quick unlock erases itself after
 * [MAX_PIN_ATTEMPTS], dropping the user back to the master password.
 *
 * This is a real widening of the app's threat model: before it, the derived key
 * existed only in RAM. It is now at rest, protected by the Keystore rather than
 * by not existing.
 */
object QuickUnlock {

    const val MIN_PIN_LENGTH = 4
    const val MAX_PIN_LENGTH = 12

    /** Failed PIN entries allowed before quick unlock is wiped entirely. */
    const val MAX_PIN_ATTEMPTS = 5

    /**
     * Same cost as the vault's own KDF. It runs once per PIN entry on a
     * background thread; the Keystore layer is what actually makes offline
     * guessing impossible, this just makes on-device guessing slow too.
     */
    private const val PIN_KDF_ITERATIONS = VaultCrypto.KDF_ITERATIONS

    private const val KEYSTORE = "AndroidKeyStore"
    private const val BIO_ALIAS = "drivepass.quickunlock.bio"
    private const val PIN_ALIAS = "drivepass.quickunlock.pin"
    private const val TRANSFORM = "AES/GCM/NoPadding"
    private const val GCM_TAG_BITS = 128

    // Vault identity: the envelope salt at enrolment. A different salt means a
    // different vault (or a changed master password), so the stored key would
    // decrypt to garbage — wipe instead of reporting "wrong password".
    private const val K_SALT = "qu_vault_salt"
    private const val K_BIO_IV = "qu_bio_iv"
    private const val K_BIO_BLOB = "qu_bio_blob"
    private const val K_PIN_IV = "qu_pin_iv"
    private const val K_PIN_BLOB = "qu_pin_blob"
    private const val K_PIN_KDF_SALT = "qu_pin_kdf_salt"
    private const val K_PIN_ITER = "qu_pin_iter"
    private const val K_PIN_FAILS = "qu_pin_fails"

    /** Quick unlock is set up but the vault on screen is not the one it is for. */
    class WrongVault : Exception("Quick unlock was set up for a different vault.")

    /** The PIN did not decrypt the stored key. */
    class BadPin(val attemptsLeft: Int) : Exception("That PIN is not right.")

    /** Biometric enrolment changed, so the Keystore key is gone for good. */
    class BiometricsChanged : Exception("Biometric enrolment changed; quick unlock was reset.")

    // ---- state ---------------------------------------------------------------

    fun hasBiometric(prefs: SharedPreferences) = prefs.contains(K_BIO_BLOB)

    fun hasPin(prefs: SharedPreferences) = prefs.contains(K_PIN_BLOB)

    fun isSetUp(prefs: SharedPreferences) = hasBiometric(prefs) || hasPin(prefs)

    fun pinAttemptsLeft(prefs: SharedPreferences) =
        (MAX_PIN_ATTEMPTS - prefs.getInt(K_PIN_FAILS, 0)).coerceAtLeast(0)

    /**
     * True when what is stored belongs to [envelope]'s vault. Checked before
     * offering quick unlock at all, so a user who switches vaults is asked for
     * the master password rather than shown a method that cannot work.
     */
    fun matches(prefs: SharedPreferences, envelope: VaultEnvelope): Boolean {
        val stored = prefs.getString(K_SALT, null) ?: return false
        return stored == b64(envelope.salt)
    }

    /** Forget everything, and drop the Keystore keys with it. */
    fun disable(prefs: SharedPreferences) {
        prefs.edit()
            .remove(K_SALT).remove(K_BIO_IV).remove(K_BIO_BLOB)
            .remove(K_PIN_IV).remove(K_PIN_BLOB).remove(K_PIN_KDF_SALT)
            .remove(K_PIN_ITER).remove(K_PIN_FAILS)
            .apply()
        runCatching {
            val ks = KeyStore.getInstance(KEYSTORE).apply { load(null) }
            ks.deleteEntry(BIO_ALIAS)
            ks.deleteEntry(PIN_ALIAS)
        }
    }

    // ---- biometric enrolment -------------------------------------------------

    /**
     * Step 1 of enrolling biometrics: a Cipher to hand to BiometricPrompt. The
     * Keystore will not let it be used until the prompt succeeds.
     */
    fun beginBiometricEnrol(): Cipher {
        deleteKey(BIO_ALIAS)
        val cipher = Cipher.getInstance(TRANSFORM)
        // No IV supplied: AndroidKeyStore AES-GCM requires randomized
        // encryption and generates the IV itself. Read it back after doFinal.
        cipher.init(Cipher.ENCRYPT_MODE, generateBioKey())
        return cipher
    }

    /** Step 2: the prompt succeeded, so the cipher is now usable. */
    fun finishBiometricEnrol(
        prefs: SharedPreferences,
        cipher: Cipher,
        vaultKey: ByteArray,
        envelope: VaultEnvelope,
    ) {
        val blob = cipher.doFinal(vaultKey)
        prefs.edit()
            .putString(K_SALT, b64(envelope.salt))
            .putString(K_BIO_IV, b64(cipher.iv))
            .putString(K_BIO_BLOB, b64(blob))
            .apply()
    }

    // ---- biometric unlock ----------------------------------------------------

    /** Step 1 of unlocking: a Cipher primed with the stored IV. */
    fun beginBiometricUnlock(prefs: SharedPreferences): Cipher {
        val iv = prefs.getString(K_BIO_IV, null)?.let(::unb64)
            ?: throw IllegalStateException("No biometric quick unlock stored.")
        val key = loadKey(BIO_ALIAS) ?: throw BiometricsChanged()
        val cipher = Cipher.getInstance(TRANSFORM)
        try {
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(GCM_TAG_BITS, iv))
        } catch (e: KeyPermanentlyInvalidatedException) {
            // A new fingerprint was enrolled. The key is unrecoverable, so stop
            // offering a method that can never succeed again.
            disable(prefs)
            throw BiometricsChanged()
        }
        return cipher
    }

    /** Step 2: the prompt succeeded; recover the vault key. */
    fun finishBiometricUnlock(prefs: SharedPreferences, cipher: Cipher): ByteArray {
        val blob = prefs.getString(K_BIO_BLOB, null)?.let(::unb64)
            ?: throw IllegalStateException("No biometric quick unlock stored.")
        return cipher.doFinal(blob)
    }

    // ---- PIN -----------------------------------------------------------------

    fun enablePin(
        prefs: SharedPreferences,
        pin: CharArray,
        vaultKey: ByteArray,
        envelope: VaultEnvelope,
    ) {
        require(pin.size in MIN_PIN_LENGTH..MAX_PIN_LENGTH) { "PIN length out of range" }
        val kdfSalt = ByteArray(16).also { java.security.SecureRandom().nextBytes(it) }
        val pinKey = VaultCrypto.deriveKey(pin, kdfSalt, PIN_KDF_ITERATIONS)
        val inner = try {
            // Inner layer: PIN-derived key over the vault key. Its own random IV.
            val iv = ByteArray(12).also { java.security.SecureRandom().nextBytes(it) }
            val c = Cipher.getInstance(TRANSFORM)
            c.init(Cipher.ENCRYPT_MODE, SecretKeySpec(pinKey, "AES"), GCMParameterSpec(GCM_TAG_BITS, iv))
            iv + c.doFinal(vaultKey)
        } finally {
            pinKey.fill(0)
        }

        deleteKey(PIN_ALIAS)
        val outer = Cipher.getInstance(TRANSFORM)
        outer.init(Cipher.ENCRYPT_MODE, generatePinKey())
        val blob = outer.doFinal(inner)
        inner.fill(0)

        prefs.edit()
            .putString(K_SALT, b64(envelope.salt))
            .putString(K_PIN_IV, b64(outer.iv))
            .putString(K_PIN_BLOB, b64(blob))
            .putString(K_PIN_KDF_SALT, b64(kdfSalt))
            .putInt(K_PIN_ITER, PIN_KDF_ITERATIONS)
            .putInt(K_PIN_FAILS, 0)
            .apply()
    }

    /**
     * Recover the vault key from a PIN, or throw [BadPin].
     *
     * The failure is recorded BEFORE the attempt and cleared only on success,
     * so killing the app mid-guess cannot be used to reset the counter.
     */
    fun unlockWithPin(prefs: SharedPreferences, pin: CharArray): ByteArray {
        val blob = prefs.getString(K_PIN_BLOB, null)?.let(::unb64)
            ?: throw IllegalStateException("No PIN quick unlock stored.")
        val outerIv = prefs.getString(K_PIN_IV, null)?.let(::unb64)
            ?: throw IllegalStateException("No PIN quick unlock stored.")
        val kdfSalt = prefs.getString(K_PIN_KDF_SALT, null)?.let(::unb64)
            ?: throw IllegalStateException("No PIN quick unlock stored.")
        val iterations = prefs.getInt(K_PIN_ITER, PIN_KDF_ITERATIONS)
        val key = loadKey(PIN_ALIAS) ?: run { disable(prefs); throw IllegalStateException("Quick unlock key is gone.") }

        prefs.edit().putInt(K_PIN_FAILS, prefs.getInt(K_PIN_FAILS, 0) + 1).commit()

        val outer = Cipher.getInstance(TRANSFORM)
        outer.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(GCM_TAG_BITS, outerIv))
        // The outer layer is device-bound, not PIN-bound: if THIS fails the
        // stored data is damaged, not mis-keyed.
        val inner = outer.doFinal(blob)

        val pinKey = VaultCrypto.deriveKey(pin, kdfSalt, iterations)
        val vaultKey = try {
            val c = Cipher.getInstance(TRANSFORM)
            c.init(
                Cipher.DECRYPT_MODE,
                SecretKeySpec(pinKey, "AES"),
                GCMParameterSpec(GCM_TAG_BITS, inner.copyOfRange(0, 12)),
            )
            c.doFinal(inner, 12, inner.size - 12)
        } catch (e: javax.crypto.AEADBadTagException) {
            val left = pinAttemptsLeft(prefs)
            if (left == 0) disable(prefs)
            throw BadPin(left)
        } catch (e: javax.crypto.BadPaddingException) {
            val left = pinAttemptsLeft(prefs)
            if (left == 0) disable(prefs)
            throw BadPin(left)
        } finally {
            pinKey.fill(0)
            inner.fill(0)
        }

        prefs.edit().putInt(K_PIN_FAILS, 0).apply()
        return vaultKey
    }

    // ---- keystore plumbing ---------------------------------------------------

    private fun generateBioKey(): SecretKey {
        val spec = KeyGenParameterSpec.Builder(
            BIO_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(true)
            // A newly enrolled fingerprint must not inherit access to the vault.
            .setInvalidatedByBiometricEnrollment(true)
            .apply {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    // 0 = valid for one use, tied to this authentication only.
                    setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
                } else {
                    @Suppress("DEPRECATION")
                    setUserAuthenticationValidityDurationSeconds(-1)
                }
            }
            .build()
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
            .apply { init(spec) }
            .generateKey()
    }

    private fun generatePinKey(): SecretKey {
        val spec = KeyGenParameterSpec.Builder(
            PIN_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            // No user-auth requirement: the PIN is the thing being checked, and
            // requiring the device credential as well would defeat the point of
            // having an app PIN. Hardware backing still binds it to this device.
            .setUserAuthenticationRequired(false)
            .build()
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
            .apply { init(spec) }
            .generateKey()
    }

    private fun loadKey(alias: String): SecretKey? = runCatching {
        val ks = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        ks.getKey(alias, null) as? SecretKey
    }.getOrNull()

    private fun deleteKey(alias: String) {
        runCatching { KeyStore.getInstance(KEYSTORE).apply { load(null) }.deleteEntry(alias) }
    }

    private fun b64(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.NO_WRAP)

    private fun unb64(s: String): ByteArray = Base64.decode(s, Base64.NO_WRAP)
}
