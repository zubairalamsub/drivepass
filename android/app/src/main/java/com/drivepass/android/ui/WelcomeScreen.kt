package com.drivepass.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.drivepass.android.RecentVault
import com.drivepass.android.UiState

@Composable
fun WelcomeScreen(
    state: UiState.Welcome,
    onPickFile: () -> Unit,
    onOpenRecent: () -> Unit,
    onForgetRecent: () -> Unit,
    onDemo: () -> Unit,
    onDismissError: () -> Unit,
) {
    Box(Modifier.fillMaxSize().safeDrawingPadding(), contentAlignment = Alignment.TopCenter) {
        Column(
            Modifier
                .widthIn(max = 480.dp)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp, vertical = 32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Spacer(Modifier.height(24.dp))
            AppMark(72.dp)
            Spacer(Modifier.height(20.dp))
            Text("DrivePass", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(8.dp))
            Text(
                "Your passwords, encrypted on this device and stored in your own Google Drive.",
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(32.dp))

            state.error?.let {
                ErrorBanner(it, onDismissError)
                Spacer(Modifier.height(16.dp))
            }

            state.recent?.let {
                RecentCard(it, state.loading, onOpenRecent, onForgetRecent)
                Spacer(Modifier.height(16.dp))
            }

            val primaryLabel = if (state.recent == null) "Choose vault file" else "Choose a different file"
            if (state.recent == null) {
                Button(
                    onClick = onPickFile,
                    enabled = !state.loading,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp),
                ) {
                    if (state.loading) Spinner() else Text(primaryLabel)
                }
            } else {
                OutlinedButton(
                    onClick = onPickFile,
                    enabled = !state.loading,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp),
                ) { Text(primaryLabel) }
            }
            Spacer(Modifier.height(4.dp))
            TextButton(onClick = onDemo, enabled = !state.loading) { Text("Try the demo vault") }

            Spacer(Modifier.height(24.dp))
            HowTo()
            Spacer(Modifier.height(24.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    DpIcons.Shield,
                    contentDescription = null,
                    tint = LocalExtraColors.current.ok,
                    modifier = Modifier.size(16.dp),
                )
                Spacer(Modifier.size(6.dp))
                Text(
                    "Read-only · no internet access · decrypted only on this device",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun RecentCard(recent: RecentVault, loading: Boolean, onOpen: () -> Unit, onForget: () -> Unit) {
    Surface(
        onClick = onOpen,
        enabled = !loading,
        color = MaterialTheme.colorScheme.surfaceContainer,
        shape = MaterialTheme.shapes.large,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(Modifier.padding(start = 16.dp, top = 14.dp, bottom = 14.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier.size(44.dp),
                contentAlignment = Alignment.Center,
            ) {
                if (loading) Spinner() else AppMark(44.dp)
            }
            Spacer(Modifier.size(14.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    recent.name,
                    style = MaterialTheme.typography.titleMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    if (recent.openedAt > 0) "Last opened ${relativePhrase(recent.openedAt)}"
                    else "Tap to unlock",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            IconButton(onClick = onForget, enabled = !loading) {
                Icon(
                    DpIcons.Close,
                    contentDescription = "Forget this vault",
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(18.dp),
                )
            }
        }
    }
}

@Composable
private fun HowTo() {
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainer,
        shape = MaterialTheme.shapes.large,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("Finding your vault", style = MaterialTheme.typography.titleSmall)
            Step(DpIcons.Folder, "Tap Choose vault file and open Drive from the picker's menu.")
            Step(DpIcons.CloudOk, "Select vault.enc — the file the DrivePass extension keeps in your Drive.")
            Step(DpIcons.Lock, "Unlock it with your master password. Next time it's one tap away.")
        }
    }
}

@Composable
private fun Step(icon: ImageVector, text: String) {
    Row(verticalAlignment = Alignment.Top) {
        Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(20.dp))
        Spacer(Modifier.size(12.dp))
        Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
fun ErrorBanner(message: String, onDismiss: (() -> Unit)? = null) {
    Surface(
        color = MaterialTheme.colorScheme.errorContainer,
        contentColor = MaterialTheme.colorScheme.onErrorContainer,
        shape = MaterialTheme.shapes.medium,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(Modifier.padding(start = 14.dp, top = 12.dp, bottom = 12.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(DpIcons.Alert, contentDescription = null, tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(20.dp))
            Spacer(Modifier.size(12.dp))
            Text(message, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
            if (onDismiss != null) {
                IconButton(onClick = onDismiss) {
                    Icon(DpIcons.Close, contentDescription = "Dismiss", modifier = Modifier.size(18.dp))
                }
            } else {
                Spacer(Modifier.size(10.dp))
            }
        }
    }
}

@Composable
fun Spinner() {
    CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.primary)
}
