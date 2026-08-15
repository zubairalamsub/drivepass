package com.drivepass.android

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.WindowManager
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private const val TAG = "DrivePassSpike"

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Vault contents stay out of screenshots and the Recents thumbnail.
        // Note: this also blocks `adb screencap`, by design.
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        setContent { MaterialTheme(colorScheme = darkColorScheme()) { Surface { App() } } }
    }
}

private sealed interface Screen {
    object Pick : Screen
    data class Unlock(val envelopeJson: String, val source: String) : Screen
    data class Vault(val entries: List<Entry>, val meta: String, val millis: Long) : Screen
}

@Composable
private fun App() {
    val ctx = LocalContext.current
    var screen by remember { mutableStateOf<Screen>(Screen.Pick) }
    var detail by remember { mutableStateOf<Entry?>(null) }

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
        if (uri != null) {
            runCatching {
                ctx.contentResolver.openInputStream(uri)!!.bufferedReader().use { it.readText() }
            }.onSuccess { screen = Screen.Unlock(it, uri.lastPathSegment ?: "selected file") }
                .onFailure { Toast.makeText(ctx, "Could not read that file", Toast.LENGTH_LONG).show() }
        }
    }

    Column(Modifier.fillMaxSize().padding(20.dp)) {
        Text("DrivePass", fontSize = 24.sp, fontWeight = FontWeight.Bold)
        Text(
            "Test build — local file only, no network",
            fontSize = 12.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(20.dp))

        when (val s = screen) {
            is Screen.Pick -> PickScreen(
                onPickFile = { picker.launch(arrayOf("*/*")) },
                onDemo = {
                    val json = ctx.assets.open("fixture-vault.enc").bufferedReader().use { it.readText() }
                    screen = Screen.Unlock(json, "bundled demo vault")
                },
            )
            is Screen.Unlock -> UnlockScreen(
                envelopeJson = s.envelopeJson,
                source = s.source,
                onBack = { screen = Screen.Pick },
                onUnlocked = { entries, meta, ms -> screen = Screen.Vault(entries, meta, ms) },
            )
            is Screen.Vault -> VaultScreen(
                state = s,
                onLock = { screen = Screen.Pick },
                onOpen = { detail = it },
            )
        }
    }

    detail?.let { EntrySheet(it) { detail = null } }
}

@Composable
private fun PickScreen(onPickFile: () -> Unit, onDemo: () -> Unit) {
    Text("Open a vault", fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
    Spacer(Modifier.height(8.dp))
    Text(
        "Pick a vault.enc file from this device. Download it from your Google Drive first — " +
            "this build has no network access at all, so it cannot fetch it for you.",
        fontSize = 13.sp,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    Spacer(Modifier.height(16.dp))
    Button(onClick = onPickFile, modifier = Modifier.fillMaxWidth()) { Text("Choose vault.enc…") }
    Spacer(Modifier.height(8.dp))
    OutlinedButton(onClick = onDemo, modifier = Modifier.fillMaxWidth()) { Text("Open bundled demo vault") }
    Spacer(Modifier.height(16.dp))
    Text(
        "Demo password: correct-horse-battery-staple",
        fontSize = 12.sp,
        fontFamily = FontFamily.Monospace,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

@Composable
private fun UnlockScreen(
    envelopeJson: String,
    source: String,
    onBack: () -> Unit,
    onUnlocked: (List<Entry>, String, Long) -> Unit,
) {
    var password by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    fun go() {
        busy = true; error = null
        scope.launch {
            val r = withContext(Dispatchers.Default) {
                runCatching {
                    val t0 = System.nanoTime()
                    val env = VaultCrypto.parseEnvelope(envelopeJson)
                    val key = VaultCrypto.deriveKey(password.toCharArray(), env.salt, env.iterations)
                    try {
                        val data = VaultModel.parse(VaultCrypto.decrypt(key, env))
                        Triple(
                            VaultModel.liveSorted(data),
                            "${env.iterations} iters · ${data.entries.size} entries · ${data.purged.size} purged",
                            (System.nanoTime() - t0) / 1_000_000,
                        )
                    } finally {
                        key.fill(0)
                    }
                }
            }
            busy = false
            r.fold(
                onSuccess = { (e, m, ms) ->
                    Log.i(TAG, "UNLOCK OK in ${ms}ms — ${e.size} live entries from $source")
                    onUnlocked(e, m, ms)
                },
                onFailure = { error = it.message ?: it::class.java.simpleName },
            )
        }
    }

    Text(source, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
    Spacer(Modifier.height(12.dp))
    OutlinedTextField(
        value = password,
        onValueChange = { password = it },
        label = { Text("Master password") },
        singleLine = true,
        enabled = !busy,
        visualTransformation = PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Go),
        keyboardActions = KeyboardActions(onGo = { if (password.isNotEmpty()) go() }),
        modifier = Modifier.fillMaxWidth(),
    )
    Spacer(Modifier.height(12.dp))
    Button(
        onClick = { go() },
        enabled = !busy && password.isNotEmpty(),
        modifier = Modifier.fillMaxWidth(),
    ) { Text(if (busy) "Deriving key…" else "Unlock") }
    TextButton(onClick = onBack, enabled = !busy) { Text("Choose a different file") }

    if (busy) {
        LinearProgressIndicator(Modifier.fillMaxWidth())
        Text(
            "PBKDF2 · 210,000 iterations",
            fontSize = 12.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
    error?.let {
        Spacer(Modifier.height(12.dp))
        Text(it, color = MaterialTheme.colorScheme.error, fontSize = 13.sp)
    }
}

@Composable
private fun VaultScreen(state: Screen.Vault, onLock: () -> Unit, onOpen: (Entry) -> Unit) {
    var query by remember { mutableStateOf("") }
    val shown = remember(query, state.entries) {
        val q = query.trim().lowercase()
        if (q.isEmpty()) state.entries
        else state.entries.filter {
            it.name.lowercase().contains(q) || it.username.lowercase().contains(q) ||
                it.url.lowercase().contains(q)
        }
    }

    Row(verticalAlignment = Alignment.CenterVertically) {
        Text("✓ ${state.entries.size} entries", color = Color(0xFF35C99A), fontWeight = FontWeight.Bold)
        Spacer(Modifier.width(8.dp))
        Text("${state.millis} ms", fontSize = 12.sp, fontFamily = FontFamily.Monospace)
        Spacer(Modifier.weight(1f))
        TextButton(onClick = onLock) { Text("Lock") }
    }
    Text(state.meta, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
    Spacer(Modifier.height(8.dp))
    OutlinedTextField(
        value = query,
        onValueChange = { query = it },
        label = { Text("Search") },
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
    )
    Spacer(Modifier.height(10.dp))

    LazyColumn(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        items(shown) { e ->
            Card(
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier.fillMaxWidth().clickable { onOpen(e) },
            ) {
                Row(Modifier.padding(12.dp).fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        when (e.type) { "card" -> "▤"; "note" -> "▢"; "passkey" -> "⚿"; else -> "●" },
                        Modifier.padding(end = 12.dp),
                        color = MaterialTheme.colorScheme.primary,
                    )
                    Column(Modifier.weight(1f)) {
                        Text(
                            e.name.ifEmpty { "(unnamed)" },
                            fontWeight = FontWeight.SemiBold,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(
                            e.subtitle(),
                            fontSize = 12.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    if (e.totp.isNotEmpty()) Text("2FA", fontSize = 10.sp, color = MaterialTheme.colorScheme.primary)
                    if (e.favorite) Text("  ★", color = Color(0xFFE8A33D))
                }
            }
        }
    }
}

@Composable
private fun EntrySheet(entry: Entry, onDismiss: () -> Unit) {
    val ctx = LocalContext.current
    var reveal by remember { mutableStateOf(false) }
    var code by remember { mutableStateOf<String?>(null) }
    var left by remember { mutableStateOf(30) }

    // Live TOTP, recomputed every second like the desktop's countdown ring.
    LaunchedEffect(entry.id) {
        while (entry.totp.isNotEmpty()) {
            code = Totp.generate(entry.totp)
            left = Totp.secondsRemaining()
            delay(1000)
        }
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = { TextButton(onClick = onDismiss) { Text("Close") } },
        title = { Text(entry.name.ifEmpty { "(unnamed)" }) },
        text = {
            Column {
                if (entry.url.isNotEmpty()) Field("Website", entry.url, ctx)
                if (entry.username.isNotEmpty()) Field("Username", entry.username, ctx)
                if (entry.password.isNotEmpty()) {
                    Field(
                        label = "Password",
                        value = if (reveal) entry.password else "•".repeat(entry.password.length.coerceAtMost(16)),
                        ctx = ctx,
                        copyValue = entry.password,
                        trailing = {
                            TextButton(onClick = { reveal = !reveal }) {
                                Text(if (reveal) "Hide" else "Show", fontSize = 12.sp)
                            }
                        },
                    )
                }
                if (entry.cardNumber.isNotEmpty()) Field("Card number", entry.cardNumber, ctx)
                if (entry.notes.isNotEmpty()) Field("Notes", entry.notes, ctx)
                code?.let {
                    Spacer(Modifier.height(8.dp))
                    Text("2FA code  (${left}s)", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            it.chunked(3).joinToString(" "),
                            fontSize = 26.sp,
                            fontWeight = FontWeight.Bold,
                            fontFamily = FontFamily.Monospace,
                        )
                        TextButton(onClick = { copy(ctx, "2FA code", it) }) { Text("Copy", fontSize = 12.sp) }
                    }
                }
            }
        },
    )
}

@Composable
private fun Field(
    label: String,
    value: String,
    ctx: Context,
    copyValue: String = value,
    trailing: @Composable (() -> Unit)? = null,
) {
    Spacer(Modifier.height(8.dp))
    Text(label, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(value, fontSize = 14.sp, fontFamily = FontFamily.Monospace, modifier = Modifier.weight(1f))
        trailing?.invoke()
        TextButton(onClick = { copy(ctx, label, copyValue) }) { Text("Copy", fontSize = 12.sp) }
    }
}

/** Marks the clip sensitive so Android 13+ does not show its contents in the paste toast. */
private fun copy(ctx: Context, label: String, value: String) {
    val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    val clip = ClipData.newPlainText(label, value)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        clip.description.extras = android.os.PersistableBundle().apply {
            putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true)
        }
    }
    cm.setPrimaryClip(clip)
    Toast.makeText(ctx, "$label copied", Toast.LENGTH_SHORT).show()
}
