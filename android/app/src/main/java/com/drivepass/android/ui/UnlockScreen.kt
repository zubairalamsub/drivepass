package com.drivepass.android.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.drivepass.android.UiState

private const val DEMO_PASSWORD = "correct-horse-battery-staple"

@Composable
fun UnlockScreen(
    state: UiState.Unlock,
    onUnlock: (CharArray) -> Unit,
    onBiometric: () -> Unit,
    onPin: (CharArray) -> Unit,
    onBack: () -> Unit,
) {
    // Plain `remember`, not rememberSaveable: saved state is written to disk by
    // the system, and a master password must never be.
    var password by remember { mutableStateOf("") }
    var visible by remember { mutableStateOf(false) }
    // The error describes the attempt that failed; once the user starts
    // correcting it, stop shouting about it.
    var editedSinceError by remember { mutableStateOf(false) }
    LaunchedEffect(state.error) { editedSinceError = false }

    val focus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    LaunchedEffect(Unit) {
        // With a quick method on offer, popping the keyboard on the master
        // password field pushes the slow path into the user's face instead of
        // the fast one.
        if (!state.quick.any) {
            focus.requestFocus()
            keyboard?.show()
        }
    }

    val canSubmit = password.isNotEmpty() && !state.busy
    fun submit() {
        if (!canSubmit) return
        keyboard?.hide()
        onUnlock(password.toCharArray())
    }

    Box(Modifier.fillMaxSize().safeDrawingPadding().imePadding()) {
        IconButton(onClick = onBack, enabled = !state.busy, modifier = Modifier.padding(4.dp)) {
            Icon(DpIcons.Back, contentDescription = "Back")
        }
        Column(
            Modifier
                .align(Alignment.TopCenter)
                .widthIn(max = 480.dp)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp)
                .padding(top = 72.dp, bottom = 24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Box(
                Modifier.size(72.dp),
                contentAlignment = Alignment.Center,
            ) {
                Surface(
                    color = MaterialTheme.colorScheme.primaryContainer,
                    shape = MaterialTheme.shapes.large,
                    modifier = Modifier.fillMaxSize(),
                ) {}
                Icon(DpIcons.Lock, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(36.dp))
            }
            Spacer(Modifier.height(20.dp))
            Text("Unlock your vault", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(10.dp))
            FileChip(state.vault.name, state.vault.isDemo, state.vault.isFromDrive)
            Spacer(Modifier.height(28.dp))

            if (state.quick.any) {
                QuickUnlockPanel(
                    quick = state.quick,
                    busy = state.busy,
                    onBiometric = onBiometric,
                    onPin = onPin,
                )
            }

            val showError = state.error != null && !editedSinceError
            OutlinedTextField(
                value = password,
                onValueChange = {
                    password = it
                    editedSinceError = true
                },
                label = { Text("Master password") },
                singleLine = true,
                enabled = !state.busy,
                isError = showError && state.wrongPassword,
                leadingIcon = { Icon(DpIcons.Key, contentDescription = null, modifier = Modifier.size(20.dp)) },
                trailingIcon = {
                    IconButton(onClick = { visible = !visible }) {
                        Icon(
                            if (visible) DpIcons.EyeOff else DpIcons.Eye,
                            contentDescription = if (visible) "Hide password" else "Show password",
                            modifier = Modifier.size(20.dp),
                        )
                    }
                },
                visualTransformation = if (visible) VisualTransformation.None else PasswordVisualTransformation(),
                // KeyboardType.Password also keeps the keyboard from learning it.
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Password,
                    autoCorrectEnabled = false,
                    imeAction = ImeAction.Done,
                ),
                keyboardActions = KeyboardActions(onDone = { submit() }),
                modifier = Modifier.fillMaxWidth().focusRequester(focus),
            )

            AnimatedVisibility(showError) {
                Column {
                    Spacer(Modifier.height(12.dp))
                    ErrorBanner(state.error.orEmpty())
                }
            }

            if (state.vault.isDemo) {
                Spacer(Modifier.height(12.dp))
                Surface(
                    color = MaterialTheme.colorScheme.surfaceContainer,
                    shape = MaterialTheme.shapes.medium,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Row(Modifier.padding(start = 14.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f).padding(vertical = 10.dp)) {
                            Text("Demo password", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Text(DEMO_PASSWORD, style = MaterialTheme.typography.bodyMedium, fontFamily = FontFamily.Monospace)
                        }
                        TextButton(onClick = { password = DEMO_PASSWORD; editedSinceError = true }, enabled = !state.busy) {
                            Text("Fill in")
                        }
                    }
                }
            }

            Spacer(Modifier.height(20.dp))
            Button(
                onClick = { submit() },
                enabled = canSubmit,
                modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp),
            ) {
                if (state.busy) {
                    CircularProgressIndicator(
                        Modifier.size(18.dp),
                        strokeWidth = 2.dp,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                    Spacer(Modifier.size(12.dp))
                    Text("Unlocking…")
                } else {
                    Text("Unlock")
                }
            }
            AnimatedVisibility(state.busy) {
                Text(
                    "Your password is stretched ${"%,d".format(state.vault.envelope.iterations)} times " +
                        "so it's slow to guess. This takes a moment.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.padding(top = 12.dp),
                )
            }
        }
    }
}

@Composable
private fun FileChip(name: String, demo: Boolean, fromDrive: Boolean = false) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        shape = MaterialTheme.shapes.extraLarge,
    ) {
        Row(Modifier.padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(
                if (demo) DpIcons.Note else DpIcons.CloudOk,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(16.dp),
            )
            Spacer(Modifier.size(6.dp))
            Text(
                // Where it came from matters: a stale picked copy and the live
                // Drive file can disagree.
                if (fromDrive) "$name · Drive" else name,
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}
