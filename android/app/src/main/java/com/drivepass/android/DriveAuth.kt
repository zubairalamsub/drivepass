package com.drivepass.android

import android.content.Context
import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.AuthorizationResult
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.common.api.ApiException
import com.google.android.gms.common.api.CommonStatusCodes
import com.google.android.gms.common.api.Scope
import com.google.android.gms.tasks.Task

/**
 * Getting an OAuth access token for Drive, via Play Services.
 *
 * Uses the Identity AuthorizationClient rather than the long-deprecated
 * GoogleSignInClient. The token it returns lives in memory for the life of the
 * unlock and is never written to disk — the same rule the derived vault key
 * follows.
 */
object DriveAuth {

    /**
     * Per-file access, matching the extension's manifest.json.
     *
     * Deliberately NOT `drive` or `drive.readonly`: those are restricted scopes
     * that drag in a paid CASA audit (see SETUP.md). `drive.file` only ever
     * exposes files this app created or that the user explicitly opened for it.
     */
    private val SCOPE = Scope("https://www.googleapis.com/auth/drive.file")

    /**
     * Ask for the scope. The result either carries an access token outright, or
     * carries a PendingIntent the caller must launch to let the user pick an
     * account and consent.
     */
    fun authorize(context: Context): Task<AuthorizationResult> =
        Identity.getAuthorizationClient(context).authorize(
            AuthorizationRequest.builder()
                .setRequestedScopes(listOf(SCOPE))
                .build()
        )

    /** Pull the result back out of the intent a resolution returned. */
    fun resultFrom(context: Context, intent: android.content.Intent?): AuthorizationResult =
        Identity.getAuthorizationClient(context).getAuthorizationResultFromIntent(intent)

    /**
     * Turn a Play Services failure into something the user can act on.
     *
     * The status code is the whole diagnosis here — "sign-in didn't work" is
     * indistinguishable between a missing OAuth client, a consent screen that
     * never got the scope, and the user simply backing out.
     */
    fun explain(e: Throwable): String {
        val status = (e as? ApiException)?.statusCode ?: return e.message ?: GENERIC
        return when (status) {
            CommonStatusCodes.DEVELOPER_ERROR ->
                "Google rejected this build's signature (DEVELOPER_ERROR / 10). The Cloud " +
                    "project needs an Android OAuth client for com.drivepass.android with " +
                    "this build's signing SHA-1."
            CommonStatusCodes.SIGN_IN_REQUIRED ->
                "No Google account is signed in on this device."
            CommonStatusCodes.NETWORK_ERROR ->
                "Couldn't reach Google to sign in. Check your connection."
            CommonStatusCodes.API_NOT_CONNECTED ->
                "Play Services wouldn't start the sign-in (API_NOT_CONNECTED / 17). Usually " +
                    "the OAuth consent screen is missing the drive.file scope, or this " +
                    "account isn't a test user on it."
            CommonStatusCodes.CANCELED, SIGN_IN_CANCELLED ->
                "Sign-in was cancelled."
            else -> "Google sign-in failed (code $status). ${e.message.orEmpty()}".trim()
        }
    }

    /** GoogleSignInStatusCodes.SIGN_IN_CANCELLED, without the deprecated class. */
    private const val SIGN_IN_CANCELLED = 12501

    private const val GENERIC = "Google sign-in didn't complete. Try again, or choose the file instead."
}
