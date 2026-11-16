package com.drivepass.android.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import com.drivepass.android.EntryDraft

/**
 * Add or edit an entry.
 *
 * Full screen rather than a sheet: a bottom sheet plus the keyboard plus eight
 * fields is miserable to type into.
 *
 * The draft lives in plain `remember`, never `rememberSaveable` — it holds a
 * password, and saved-instance state is written to disk by the system. The
 * cost is that a rotation mid-edit loses the typing; the alternative is the
 * vault's secrets in a Bundle on disk.
 *
 * The editor stays open until the save actually succeeds, so a failed write
 * leaves the user looking at their draft and [error], one tap from a retry.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EntryEditor(
    initial: EntryDraft,
    saving: Boolean,
    error: String?,
    onSave: (EntryDraft) -> Unit,
    onCancel: () -> Unit,
) {
    var draft by remember { mutableStateOf(initial) }
    var showPassword by remember { mutableStateOf(false) }
    var confirmDiscard by remember { mutableStateOf(false) }
    val isNew = initial.id == null
    val dirty = draft != initial
    val canSave = !saving && (draft.name.isNotBlank() || draft.url.isNotBlank())

    fun leave() { if (dirty && !saving) confirmDiscard = true else if (!saving) onCancel() }
    BackHandler { leave() }

    Scaffold(
        topBar = {
            Column {
                TopAppBar(
                    navigationIcon = {
                        IconButton(onClick = ::leave, enabled = !saving) {
                            Icon(DpIcons.Close, contentDescription = "Cancel")
                        }
                    },
                    title = { Text(if (isNew) "New item" else "Edit item") },
                    actions = {
                        TextButton(onClick = { onSave(draft) }, enabled = canSave) {
                            Text(if (saving) "Saving…" else "Save")
                        }
                    },
                )
                if (saving) LinearProgressIndicator(Modifier.fillMaxWidth())
            }
        },
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            error?.let { ErrorBanner(it) }

            // Type is fixed once an entry exists: switching a login to a card
            // would leave the login's fields orphaned in the JSON.
            if (isNew) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    for ((type, label) in listOf("login" to "Login", "card" to "Card", "note" to "Note")) {
                        FilterChip(
                            selected = draft.type == type,
                            onClick = { draft = draft.copy(type = type) },
                            label = { Text(label) },
                            enabled = !saving,
                        )
                    }
                }
            }

            Field("Name", draft.name, !saving, capitalize = true) { draft = draft.copy(name = it) }

            when (draft.type) {
                "card" -> {
                    Field("Card number", draft.cardNumber, !saving, mono = true, keyboard = KeyboardType.Number) {
                        draft = draft.copy(cardNumber = it.filter(Char::isDigit))
                    }
                    Field("Name on card", draft.cardHolder, !saving, capitalize = true) {
                        draft = draft.copy(cardHolder = it)
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Field("MM", draft.cardExpMonth, !saving, Modifier.weight(1f), keyboard = KeyboardType.Number) {
                            draft = draft.copy(cardExpMonth = it.filter(Char::isDigit).take(2))
                        }
                        Field("YY", draft.cardExpYear, !saving, Modifier.weight(1f), keyboard = KeyboardType.Number) {
                            draft = draft.copy(cardExpYear = it.filter(Char::isDigit).take(4))
                        }
                        Field("CVV", draft.cardCvv, !saving, Modifier.weight(1f), secret = true, keyboard = KeyboardType.NumberPassword) {
                            draft = draft.copy(cardCvv = it.filter(Char::isDigit).take(4))
                        }
                    }
                }
                "note" -> Unit
                else -> {
                    Field("Website", draft.url, !saving, keyboard = KeyboardType.Uri) { draft = draft.copy(url = it.trim()) }
                    Field("Username", draft.username, !saving, keyboard = KeyboardType.Email) {
                        draft = draft.copy(username = it)
                    }
                    OutlinedTextField(
                        value = draft.password,
                        onValueChange = { draft = draft.copy(password = it) },
                        label = { Text("Password") },
                        singleLine = true,
                        enabled = !saving,
                        textStyle = MaterialTheme.typography.bodyLarge.copy(fontFamily = FontFamily.Monospace),
                        visualTransformation = if (showPassword) VisualTransformation.None else PasswordVisualTransformation(),
                        // KeyboardType.Password also keeps the keyboard from
                        // learning the password.
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false),
                        trailingIcon = {
                            IconButton(onClick = { showPassword = !showPassword }) {
                                Icon(
                                    if (showPassword) DpIcons.EyeOff else DpIcons.Eye,
                                    contentDescription = if (showPassword) "Hide password" else "Show password",
                                    modifier = Modifier.size(20.dp),
                                )
                            }
                        },
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Field("2FA secret or otpauth:// link", draft.totp, !saving, mono = true) {
                        draft = draft.copy(totp = it.trim())
                    }
                }
            }

            OutlinedTextField(
                value = draft.notes,
                onValueChange = { draft = draft.copy(notes = it) },
                label = { Text("Notes") },
                enabled = !saving,
                minLines = 3,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                modifier = Modifier.fillMaxWidth(),
            )

            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(DpIcons.Star, contentDescription = null, modifier = Modifier.size(20.dp))
                Spacer(Modifier.width(12.dp))
                Text("Favorite", style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
                Switch(
                    checked = draft.favorite,
                    onCheckedChange = { draft = draft.copy(favorite = it) },
                    enabled = !saving,
                )
            }
        }
    }

    if (confirmDiscard) {
        AlertDialog(
            onDismissRequest = { confirmDiscard = false },
            title = { Text("Discard changes?") },
            text = { Text("What you've typed here hasn't been saved.") },
            confirmButton = {
                TextButton(onClick = { confirmDiscard = false; onCancel() }) { Text("Discard") }
            },
            dismissButton = { TextButton(onClick = { confirmDiscard = false }) { Text("Keep editing") } },
        )
    }
}

@Composable
private fun Field(
    label: String,
    value: String,
    enabled: Boolean,
    modifier: Modifier = Modifier.fillMaxWidth(),
    mono: Boolean = false,
    secret: Boolean = false,
    capitalize: Boolean = false,
    keyboard: KeyboardType = KeyboardType.Text,
    onChange: (String) -> Unit,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        label = { Text(label) },
        singleLine = true,
        enabled = enabled,
        textStyle = if (mono) MaterialTheme.typography.bodyLarge.copy(fontFamily = FontFamily.Monospace)
        else MaterialTheme.typography.bodyLarge,
        visualTransformation = if (secret) PasswordVisualTransformation() else VisualTransformation.None,
        keyboardOptions = KeyboardOptions(
            keyboardType = keyboard,
            capitalization = if (capitalize) KeyboardCapitalization.Words else KeyboardCapitalization.None,
            autoCorrectEnabled = false,
        ),
        modifier = modifier,
    )
}
