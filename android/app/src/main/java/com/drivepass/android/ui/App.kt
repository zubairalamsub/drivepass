package com.drivepass.android.ui

import android.net.Uri
import android.os.Build
import android.util.Log
import android.view.HapticFeedbackConstants
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.fragment.app.FragmentActivity
import com.drivepass.android.BiometricGate
import com.drivepass.android.DriveAuth
import com.drivepass.android.SensitiveClipboard
import com.drivepass.android.UiState
import com.drivepass.android.VaultViewModel

private const val TAG = "DrivePassDrive"

@Composable
fun DrivePassApp(vm: VaultViewModel) {
    val state by vm.state.collectAsState()
    val ctx = LocalContext.current
    val view = LocalView.current

    val copier = remember(ctx, view) {
        { label: String, value: String ->
            SensitiveClipboard.copy(ctx, value)
            view.performHapticFeedback(
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) HapticFeedbackConstants.CONFIRM
                else HapticFeedbackConstants.KEYBOARD_TAP,
            )
            // Android 13+ confirms the copy itself; a second toast would be noise.
            if (!SensitiveClipboard.systemShowsConfirmation) {
                Toast.makeText(ctx, "$label copied · clears in 30 s", Toast.LENGTH_SHORT).show()
            }
        }
    }

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
        if (uri != null) vm.openPicked(uri)
    }

    // Play Services hands back a PendingIntent the first time (account picker +
    // consent); afterwards the token usually arrives without any UI at all.
    val driveConsent = rememberLauncherForActivityResult(
        ActivityResultContracts.StartIntentSenderForResult(),
    ) { result ->
        runCatching { DriveAuth.resultFrom(ctx, result.data).accessToken }.fold(
            onSuccess = { token ->
                if (token != null) vm.openFromDrive(token)
                else vm.driveFailed("Google completed sign-in but returned no access token.")
            },
            // Covers the ordinary case too: backing out of the account picker
            // arrives here as a failure, not as a cancelled result.
            onFailure = { e ->
                Log.w(TAG, "consent returned resultCode=${result.resultCode}", e)
                vm.driveFailed(DriveAuth.explain(e))
            },
        )
    }

    val connectDrive: () -> Unit = {
        vm.driveConnecting()
        DriveAuth.authorize(ctx)
            .addOnSuccessListener { auth ->
                val pending = auth.pendingIntent
                val token = auth.accessToken
                Log.i(TAG, "authorize ok: resolution=${auth.hasResolution()} token=${token != null}")
                when {
                    auth.hasResolution() && pending != null ->
                        driveConsent.launch(IntentSenderRequest.Builder(pending).build())
                    token != null -> vm.openFromDrive(token)
                    else -> vm.driveFailed("Google granted the scope but returned no access token.")
                }
            }
            .addOnFailureListener { e ->
                Log.w(TAG, "authorize failed", e)
                vm.driveFailed(DriveAuth.explain(e))
            }
    }

    // BiometricPrompt hosts itself in a fragment, so it needs the activity, not
    // whatever ContextWrapper the composition happens to be handing out.
    val activity = remember(ctx) {
        generateSequence(ctx) { (it as? android.content.ContextWrapper)?.baseContext }
            .filterIsInstance<FragmentActivity>()
            .firstOrNull()
    }
    var showQuickUnlock by remember { mutableStateOf(false) }

    val biometricUnlock: () -> Unit = {
        val cipher = vm.beginBiometricUnlock()
        if (cipher != null && activity != null) {
            BiometricGate.prompt(
                activity,
                title = "Unlock DrivePass",
                subtitle = "Use your fingerprint to open this vault",
                cipher = cipher,
                onSuccess = vm::completeBiometricUnlock,
                onError = vm::quickUnlockFailed,
            )
        }
    }

    val biometricEnrol: () -> Unit = {
        val cipher = vm.beginBiometricEnrol()
        if (cipher != null && activity != null) {
            BiometricGate.prompt(
                activity,
                title = "Turn on fingerprint unlock",
                subtitle = "Confirm to protect this vault's key with your fingerprint",
                cipher = cipher,
                onSuccess = vm::completeBiometricEnrol,
                onError = {},
            )
        }
    }

    // Offer the fingerprint straight away on arriving at a vault that has one,
    // keyed on the vault so a failed attempt doesn't loop the prompt.
    val arrivedAt = (state as? UiState.Unlock)?.takeIf { it.quick.biometric }?.vault?.source
    LaunchedEffect(arrivedAt) { if (arrivedAt != null) biometricUnlock() }

    BackHandler(enabled = state is UiState.Unlock && !(state as UiState.Unlock).busy) { vm.closeVault() }

    CompositionLocalProvider(LocalCopier provides copier) {
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
            // Animate between screens, not on every state change within one.
            AnimatedContent(
                targetState = state,
                contentKey = { it::class },
                // Locking cuts straight to the lock screen: a fade would leave
                // the vault, and any open entry, on screen for its duration.
                transitionSpec = {
                    if (initialState is UiState.Unlocked) EnterTransition.None togetherWith ExitTransition.None
                    else fadeIn() togetherWith fadeOut()
                },
                label = "screen",
            ) { s ->
                when (s) {
                    is UiState.Welcome -> WelcomeScreen(
                        state = s,
                        onConnectDrive = connectDrive,
                        // The extension saves vault.enc as application/json, but a
                        // copy that went through a download may be anything.
                        onPickFile = { picker.launch(arrayOf("*/*")) },
                        onOpenRecent = vm::openRecent,
                        onForgetRecent = vm::forgetRecent,
                        onDemo = vm::openDemo,
                        onDismissError = vm::dismissError,
                    )
                    is UiState.Unlock -> UnlockScreen(
                        state = s,
                        onUnlock = vm::unlock,
                        onBiometric = biometricUnlock,
                        onPin = vm::unlockWithPin,
                        onBack = vm::closeVault,
                    )
                    is UiState.Unlocked -> VaultScreen(
                        state = s,
                        onLock = vm::lock,
                        onManageQuickUnlock = { showQuickUnlock = true },
                    )
                }
            }

            val unlocked = state as? UiState.Unlocked
            if (unlocked != null && (showQuickUnlock || unlocked.offerQuickSetup)) {
                QuickUnlockDialog(
                    biometricAvailable = BiometricGate.available(ctx),
                    biometricOn = unlocked.quick.biometric,
                    pinOn = unlocked.quick.pin,
                    onEnableBiometric = biometricEnrol,
                    onSetPin = vm::enablePin,
                    onDisable = vm::disableQuickUnlock,
                    onDismiss = {
                        showQuickUnlock = false
                        vm.dismissQuickSetup()
                    },
                )
            }
        }
    }
}
