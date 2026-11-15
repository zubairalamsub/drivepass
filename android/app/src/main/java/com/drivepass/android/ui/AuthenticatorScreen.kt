package com.drivepass.android.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.drivepass.android.Entry
import com.drivepass.android.Totp

/**
 * The 2FA codes on their own, the way an authenticator app shows them.
 *
 * A separate destination rather than a mode of the vault list, because the two
 * answer different questions and disagree about what a tap means: in the vault
 * a tap opens the entry and the trailing button copies the password, here a tap
 * copies the code. Overloading that by filter state is the kind of modal
 * surprise a password manager cannot afford.
 *
 * Period is fixed at 30 and digits at 6 — the app does not yet honour otpauth://
 * parameters, and neither does the extension, so changing that here alone would
 * make the two clients disagree on exactly these entries.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AuthenticatorScreen(entries: List<Entry>, onBack: () -> Unit, onLock: () -> Unit) {
    BackHandler { onBack() }

    // One tick for the whole list; rows subscribe at the leaf.
    val clock = rememberTotpClock()
    val accounts = remember(entries) { entries.filter { it.totp.isNotBlank() } }
    val scroll = TopAppBarDefaults.pinnedScrollBehavior()

    Scaffold(
        topBar = {
            TopAppBar(
                scrollBehavior = scroll,
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(DpIcons.Back, contentDescription = "Back to vault")
                    }
                },
                title = {
                    Column {
                        Text("Authenticator", style = MaterialTheme.typography.titleLarge)
                        Text(
                            if (accounts.size == 1) "1 account" else "${accounts.size} accounts",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                },
                actions = {
                    IconButton(onClick = onLock) { Icon(DpIcons.Lock, contentDescription = "Lock vault") }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    scrolledContainerColor = MaterialTheme.colorScheme.surfaceContainer,
                ),
            )
        },
    ) { padding ->
        if (accounts.isEmpty()) {
            Column(
                Modifier.fillMaxSize().padding(padding).padding(horizontal = 32.dp),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Icon(
                    DpIcons.Clock,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(40.dp),
                )
                Spacer(Modifier.size(16.dp))
                Text("No 2FA codes yet", style = MaterialTheme.typography.titleMedium)
                Spacer(Modifier.size(6.dp))
                Text(
                    "Add a 2FA secret to a login with the DrivePass extension and it will appear here.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                )
            }
        } else {
            LazyColumn(
                Modifier.fillMaxSize().padding(padding),
                contentPadding = PaddingValues(bottom = 24.dp),
            ) {
                items(accounts, key = { it.id }) { entry -> AuthRow(entry, clock) }
            }
        }
    }
}

private const val PERIOD = 30

@Composable
private fun AuthRow(entry: Entry, clock: TotpClock) {
    val copier = LocalCopier.current

    // The code changes once a period, not once a second. derivedStateOf only
    // notifies when the step actually changes, so this row recomposes every
    // 30s rather than 30 times — the single most important line here.
    val step by remember(clock) { derivedStateOf { clock.nowMillis / 1000L / PERIOD } }
    val code = remember(entry.totp, step) {
        Totp.generate(entry.totp, step * PERIOD * 1000L, PERIOD)
    }

    Row(
        Modifier
            .fillMaxWidth()
            .clickable(enabled = code != null) { if (code != null) copier("2FA code", code) }
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Countdown(clock)
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(
                entry.title(),
                style = MaterialTheme.typography.titleMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                entry.subtitle(),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Spacer(Modifier.width(12.dp))
        if (code == null) {
            // Never render placeholder digits: a plausible-but-wrong code is
            // worse than visibly no code.
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    DpIcons.Alert,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.error,
                    modifier = Modifier.size(18.dp),
                )
                Spacer(Modifier.width(6.dp))
                Text(
                    "Invalid secret",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
        } else {
            Text(
                // 8-digit codes group by 4; chunking those by 3 would read
                // "123 456 78".
                if (code.length == 8) code.chunked(4).joinToString(" ")
                else code.chunked(3).joinToString(" "),
                fontFamily = FontFamily.Monospace,
                fontWeight = FontWeight.SemiBold,
                fontSize = 24.sp,
                color = MaterialTheme.colorScheme.primary,
            )
        }
    }
}

/**
 * The ring and the seconds.
 *
 * This is the only part that recomposes every second, and it is deliberately a
 * leaf so that the row around it — and the list above it — does not.
 */
@Composable
private fun Countdown(clock: TotpClock) {
    val extra = LocalExtraColors.current
    val seconds = Totp.secondsRemaining(PERIOD, clock.nowMillis)
    val urgent = seconds <= 5
    Box(Modifier.size(40.dp), contentAlignment = Alignment.Center) {
        CircularProgressIndicator(
            // A lambda, so the sweep is read in the draw phase rather than
            // forcing a recomposition of its own.
            progress = { Totp.fractionRemaining(PERIOD, clock.nowMillis) },
            modifier = Modifier.size(40.dp),
            strokeWidth = 3.dp,
            color = if (urgent) extra.warn else MaterialTheme.colorScheme.primary,
            trackColor = MaterialTheme.colorScheme.outlineVariant,
        )
        Text(
            "$seconds",
            style = MaterialTheme.typography.labelMedium,
            color = if (urgent) extra.warn else MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
