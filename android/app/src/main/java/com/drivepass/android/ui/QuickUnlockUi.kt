package com.drivepass.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.drivepass.android.QuickState
import com.drivepass.android.QuickUnlock

/**
 * The quick-unlock controls above the master password field.
 *
 * Only shown when something is actually enrolled for the vault on screen; the
 * master password stays visible underneath as the way out of every failure.
 */
@Composable
fun QuickUnlockPanel(
    quick: QuickState,
    busy: Boolean,
    onBiometric: () -> Unit,
    onPin: (CharArray) -> Unit,
) {
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
        if (quick.biometric) {
            Button(
                onClick = onBiometric,
                enabled = !busy,
                modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp),
            ) { Text("Unlock with fingerprint") }
        }

        if (quick.pin) {
            if (quick.biometric) Spacer(Modifier.height(10.dp))
            var pin by remember { mutableStateOf("") }
            val canSubmit = pin.length >= QuickUnlock.MIN_PIN_LENGTH && !busy
            fun submit() {
                if (!canSubmit) return
                val chars = pin.toCharArray()
                pin = ""
                onPin(chars)
            }
            OutlinedTextField(
                value = pin,
                onValueChange = { v ->
                    if (v.length <= QuickUnlock.MAX_PIN_LENGTH && v.all(Char::isDigit)) pin = v
                },
                label = { Text("PIN") },
                singleLine = true,
                enabled = !busy,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.NumberPassword,
                    imeAction = ImeAction.Done,
                ),
                keyboardActions = KeyboardActions(onDone = { submit() }),
                supportingText = {
                    if (quick.pinAttemptsLeft < QuickUnlock.MAX_PIN_ATTEMPTS) {
                        Text("${quick.pinAttemptsLeft} left before quick unlock turns off")
                    }
                },
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(8.dp))
            OutlinedButton(
                onClick = { submit() },
                enabled = canSubmit,
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
            ) { Text("Unlock with PIN") }
        }

        Spacer(Modifier.height(20.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            HorizontalDivider(Modifier.weight(1f))
            Text(
                "  or master password  ",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            HorizontalDivider(Modifier.weight(1f))
        }
        Spacer(Modifier.height(12.dp))
    }
}

/**
 * Set up or turn off quick unlock. Doubles as the manage screen, reached from
 * the vault's toolbar, so there is one place where this is described and one
 * place where it is switched off.
 */
@Composable
fun QuickUnlockDialog(
    biometricAvailable: Boolean,
    biometricOn: Boolean,
    pinOn: Boolean,
    onEnableBiometric: () -> Unit,
    onSetPin: (CharArray) -> Unit,
    onDisable: () -> Unit,
    onDismiss: () -> Unit,
) {
    var pin by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    val pinValid = pin.length >= QuickUnlock.MIN_PIN_LENGTH && pin == confirm

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Quick unlock") },
        text = {
            // Two PIN fields, an explanation and up to three actions overflow a
            // short screen, and AlertDialog clips rather than scrolls by default.
            Column(
                verticalArrangement = Arrangement.spacedBy(12.dp),
                modifier = Modifier.verticalScroll(rememberScrollState()),
            ) {
                Text(
                    "Reopen this vault without retyping your master password. " +
                        "DrivePass stores the vault key encrypted by this device's " +
                        "secure hardware — it never leaves the phone, and your master " +
                        "password is still not stored anywhere.",
                    style = MaterialTheme.typography.bodyMedium,
                )

                HorizontalDivider()

                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(DpIcons.Shield, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.size(10.dp))
                    Text(
                        when {
                            biometricOn -> "Fingerprint is on"
                            !biometricAvailable -> "No fingerprint enrolled on this device"
                            else -> "Fingerprint"
                        },
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.weight(1f),
                    )
                    if (!biometricOn && biometricAvailable) {
                        TextButton(onClick = onEnableBiometric) { Text("Turn on") }
                    }
                }

                HorizontalDivider()

                Text(
                    if (pinOn) "PIN is on. Enter a new one to change it." else "Or set a PIN",
                    style = MaterialTheme.typography.bodyMedium,
                )
                OutlinedTextField(
                    value = pin,
                    onValueChange = { v ->
                        if (v.length <= QuickUnlock.MAX_PIN_LENGTH && v.all(Char::isDigit)) pin = v
                    },
                    label = { Text("PIN (${QuickUnlock.MIN_PIN_LENGTH}–${QuickUnlock.MAX_PIN_LENGTH} digits)") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = confirm,
                    onValueChange = { v ->
                        if (v.length <= QuickUnlock.MAX_PIN_LENGTH && v.all(Char::isDigit)) confirm = v
                    },
                    label = { Text("Confirm PIN") },
                    singleLine = true,
                    isError = confirm.isNotEmpty() && confirm != pin,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(
                        keyboardType = KeyboardType.NumberPassword,
                        imeAction = ImeAction.Done,
                    ),
                    modifier = Modifier.fillMaxWidth(),
                )
                TextButton(
                    onClick = {
                        val chars = pin.toCharArray()
                        pin = ""; confirm = ""
                        onSetPin(chars)
                    },
                    enabled = pinValid,
                ) { Text(if (pinOn) "Change PIN" else "Set PIN") }

                if (biometricOn || pinOn) {
                    HorizontalDivider()
                    TextButton(onClick = onDisable) { Text("Turn off quick unlock") }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Done") } },
    )
}
