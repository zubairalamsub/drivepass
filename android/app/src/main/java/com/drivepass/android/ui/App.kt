package com.drivepass.android.ui

import android.net.Uri
import android.os.Build
import android.view.HapticFeedbackConstants
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
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
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import com.drivepass.android.SensitiveClipboard
import com.drivepass.android.UiState
import com.drivepass.android.VaultViewModel

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
                        // The extension saves vault.enc as application/json, but a
                        // copy that went through a download may be anything.
                        onPickFile = { picker.launch(arrayOf("*/*")) },
                        onOpenRecent = vm::openRecent,
                        onForgetRecent = vm::forgetRecent,
                        onDemo = vm::openDemo,
                        onDismissError = vm::dismissError,
                    )
                    is UiState.Unlock -> UnlockScreen(s, onUnlock = vm::unlock, onBack = vm::closeVault)
                    is UiState.Unlocked -> VaultScreen(s, onLock = vm::lock)
                }
            }
        }
    }
}
