package com.drivepass.android.ui

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.drivepass.android.Entry
import com.drivepass.android.Totp
import kotlinx.coroutines.delay

private const val MASK = "••••••••••"

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EntrySheet(entry: Entry, onDismiss: () -> Unit) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = MaterialTheme.colorScheme.surfaceContainer,
    ) {
        Column(
            Modifier
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp)
                .padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Header(entry)
            when (entry.type) {
                "card" -> CardDetails(entry)
                "passkey" -> PasskeyDetails(entry)
                "note" -> Unit
                else -> LoginDetails(entry)
            }
            if (entry.totp.isNotBlank()) TotpCard(entry.totp)
            if (entry.notes.isNotBlank()) Notes(entry.notes)
            if (entry.tags.isNotEmpty()) Tags(entry.tags)
            Footer(entry)
        }
    }
}

@Composable
private fun Header(entry: Entry) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        EntryAvatar(entry, 52.dp)
        Spacer(Modifier.width(16.dp))
        Column(Modifier.weight(1f)) {
            Text(
                entry.title(),
                style = MaterialTheme.typography.titleLarge,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                listOf(entry.typeLabel(), entry.host()).filter { it.isNotBlank() }.joinToString(" · "),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (entry.favorite) {
            Icon(
                DpIcons.StarFilled,
                contentDescription = "Favorite",
                tint = LocalExtraColors.current.star,
                modifier = Modifier.size(22.dp),
            )
        }
    }
}

@Composable
private fun LoginDetails(entry: Entry) {
    if (entry.username.isEmpty() && entry.password.isEmpty() && entry.url.isEmpty()) return
    DetailGroup {
        var needsDivider = false
        if (entry.username.isNotEmpty()) {
            DetailRow(DpIcons.User, "Username", { PlainValue(entry.username) }) {
                CopyButton("Username", entry.username)
            }
            needsDivider = true
        }
        if (entry.password.isNotEmpty()) {
            if (needsDivider) GroupDivider()
            SecretRow(DpIcons.Key, "Password", entry.password, colored = true)
            needsDivider = true
        }
        if (entry.url.isNotEmpty()) {
            if (needsDivider) GroupDivider()
            WebsiteRow(entry.url)
        }
    }
}

@Composable
private fun CardDetails(entry: Entry) {
    DetailGroup {
        var needsDivider = false
        if (entry.cardHolder.isNotEmpty()) {
            DetailRow(DpIcons.User, "Cardholder", { PlainValue(entry.cardHolder) }) {
                CopyButton("Cardholder", entry.cardHolder)
            }
            needsDivider = true
        }
        if (entry.cardNumber.isNotEmpty()) {
            if (needsDivider) GroupDivider()
            SecretRow(
                DpIcons.Card,
                "Card number",
                entry.cardNumber,
                masked = "•••• " + entry.cardNumber.filter { it.isDigit() }.takeLast(4),
                display = { it.filter { c -> !c.isWhitespace() }.chunked(4).joinToString(" ") },
            )
            needsDivider = true
        }
        if (entry.cardExpiry.isNotEmpty()) {
            if (needsDivider) GroupDivider()
            DetailRow(DpIcons.Clock, "Expires", { PlainValue(entry.cardExpiry) }) {
                CopyButton("Expiry date", entry.cardExpiry)
            }
            needsDivider = true
        }
        if (entry.cardCvv.isNotEmpty()) {
            if (needsDivider) GroupDivider()
            SecretRow(DpIcons.Lock, "Security code", entry.cardCvv, masked = "•••")
        }
    }
}

@Composable
private fun PasskeyDetails(entry: Entry) {
    DetailGroup {
        if (entry.passkeyRpId.isNotEmpty()) {
            DetailRow(DpIcons.Globe, "Site", { PlainValue(entry.passkeyRpId) })
        }
        if (entry.passkeyUserName.isNotEmpty()) {
            if (entry.passkeyRpId.isNotEmpty()) GroupDivider()
            DetailRow(DpIcons.User, "User", { PlainValue(entry.passkeyUserName) }) {
                CopyButton("User name", entry.passkeyUserName)
            }
        }
    }
    Text(
        "Passkeys sign in from the DrivePass extension; this app can show them but not use them.",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

/** A hidden-by-default value with a show/hide toggle and a copy button that always copies the real value. */
@Composable
private fun SecretRow(
    icon: ImageVector,
    label: String,
    value: String,
    masked: String = MASK,
    colored: Boolean = false,
    display: (String) -> String = { it },
) {
    var reveal by remember { mutableStateOf(false) }
    DetailRow(
        icon,
        label,
        {
            when {
                !reveal -> MonoValue(AnnotatedString(masked))
                colored -> MonoValue(passwordText(display(value)))
                else -> MonoValue(AnnotatedString(display(value)))
            }
        },
    ) {
        IconButton(onClick = { reveal = !reveal }) {
            Icon(
                if (reveal) DpIcons.EyeOff else DpIcons.Eye,
                contentDescription = if (reveal) "Hide $label" else "Show $label",
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(20.dp),
            )
        }
        CopyButton(label, value)
    }
}

@Composable
private fun WebsiteRow(url: String) {
    val ctx = LocalContext.current
    val target = remember(url) { browsableUri(url) }
    DetailRow(DpIcons.Globe, "Website", {
        Text(url, style = MaterialTheme.typography.bodyLarge, maxLines = 2, overflow = TextOverflow.Ellipsis)
    }) {
        if (target != null) {
            IconButton(onClick = {
                try {
                    ctx.startActivity(Intent(Intent.ACTION_VIEW, target))
                } catch (e: ActivityNotFoundException) {
                    // No browser installed; nothing useful to do.
                }
            }) {
                Icon(
                    DpIcons.External,
                    contentDescription = "Open website",
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(20.dp),
                )
            }
        }
        CopyButton("Website", url)
    }
}

/**
 * Only http(s) is ever handed to another app. A stored URL is user data, and an
 * `intent:` or `file:` URI from a synced vault should not be able to launch
 * arbitrary activities from here.
 */
private fun browsableUri(url: String): Uri? {
    val trimmed = url.trim()
    if (trimmed.isEmpty()) return null
    val withScheme = if ("://" in trimmed) trimmed else "https://$trimmed"
    val uri = runCatching { Uri.parse(withScheme) }.getOrNull() ?: return null
    return uri.takeIf { it.scheme.equals("https", true) || it.scheme.equals("http", true) }
        ?.takeIf { !it.host.isNullOrEmpty() }
}

@Composable
private fun TotpCard(secret: String) {
    var code by remember { mutableStateOf(Totp.generate(secret)) }
    var left by remember { mutableIntStateOf(Totp.secondsRemaining()) }
    LaunchedEffect(secret) {
        while (true) {
            code = Totp.generate(secret)
            left = Totp.secondsRemaining()
            // Tick on the second boundary so the countdown never shows a stale code.
            delay(1000 - System.currentTimeMillis() % 1000)
        }
    }
    val progress by animateFloatAsState(left / 30f, label = "totp")
    val urgent = left <= 5
    val ringColor = if (urgent) LocalExtraColors.current.warn else MaterialTheme.colorScheme.primary

    DetailGroup {
        val c = code
        if (c == null) {
            DetailRow(DpIcons.Alert, "Two-factor code", { PlainValue("This 2FA secret isn't valid.") })
        } else {
            DetailRow(
                DpIcons.Shield,
                "Two-factor code",
                {
                    Text(
                        c.chunked(3).joinToString(" "),
                        fontSize = 28.sp,
                        fontWeight = FontWeight.SemiBold,
                        fontFamily = FontFamily.Monospace,
                        letterSpacing = 1.sp,
                        color = if (urgent) LocalExtraColors.current.warn else MaterialTheme.colorScheme.onSurface,
                    )
                },
            ) {
                Box(Modifier.size(40.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(
                        progress = { progress },
                        modifier = Modifier.size(32.dp),
                        color = ringColor,
                        strokeWidth = 3.dp,
                        trackColor = MaterialTheme.colorScheme.outlineVariant,
                    )
                    Text("$left", style = MaterialTheme.typography.labelSmall, color = ringColor)
                }
                CopyButton("2FA code", c)
            }
        }
    }
}

@Composable
private fun Notes(notes: String) {
    DetailGroup {
        Column(Modifier.padding(16.dp)) {
            Text("Notes", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(6.dp))
            SelectionContainer { Text(notes, style = MaterialTheme.typography.bodyLarge) }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Tags(tags: List<String>) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for (t in tags) {
            Surface(color = MaterialTheme.colorScheme.surfaceContainerHighest, shape = MaterialTheme.shapes.extraLarge) {
                Text(
                    t,
                    style = MaterialTheme.typography.labelMedium,
                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
                )
            }
        }
    }
}

@Composable
private fun Footer(entry: Entry) {
    val parts = buildList {
        if (entry.updatedAt > 0) add("Updated ${relativePhrase(entry.updatedAt)}")
        if (entry.createdAt > 0) add("created ${relativePhrase(entry.createdAt)}")
    }
    if (parts.isEmpty()) return
    Text(
        parts.joinToString(" · "),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.fillMaxWidth(),
    )
}
