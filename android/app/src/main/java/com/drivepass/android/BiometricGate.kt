package com.drivepass.android

import android.content.Context
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import javax.crypto.Cipher

/**
 * The BiometricPrompt half of quick unlock.
 *
 * Always BIOMETRIC_STRONG, never DEVICE_CREDENTIAL: the Keystore key behind
 * this is generated with AUTH_BIOMETRIC_STRONG, so a weak sensor or the
 * lockscreen PIN could not release it even if the prompt accepted them. The
 * negative button is the master password, which is the real fallback.
 */
object BiometricGate {

    /** Whether this device has a usable strong biometric enrolled right now. */
    fun available(context: Context): Boolean =
        BiometricManager.from(context)
            .canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG) ==
            BiometricManager.BIOMETRIC_SUCCESS

    /**
     * Show the prompt for [cipher]. [onError] receives null when the user simply
     * backed out, which should not be reported as a failure.
     */
    fun prompt(
        activity: FragmentActivity,
        title: String,
        subtitle: String,
        cipher: Cipher,
        onSuccess: (Cipher) -> Unit,
        onError: (String?) -> Unit,
    ) {
        val callback = object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                val unlocked = result.cryptoObject?.cipher
                if (unlocked != null) onSuccess(unlocked)
                else onError("The fingerprint check returned no key.")
            }

            override fun onAuthenticationError(code: Int, message: CharSequence) {
                val cancelled = code == BiometricPrompt.ERROR_USER_CANCELED ||
                    code == BiometricPrompt.ERROR_NEGATIVE_BUTTON ||
                    code == BiometricPrompt.ERROR_CANCELED
                onError(if (cancelled) null else message.toString())
            }
            // onAuthenticationFailed (a finger that did not match) is left to the
            // prompt's own UI; it retries in place and is not terminal.
        }

        BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), callback).authenticate(
            BiometricPrompt.PromptInfo.Builder()
                .setTitle(title)
                .setSubtitle(subtitle)
                .setNegativeButtonText("Use master password")
                .setConfirmationRequired(false)
                .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
                .build(),
            BiometricPrompt.CryptoObject(cipher),
        )
    }
}
