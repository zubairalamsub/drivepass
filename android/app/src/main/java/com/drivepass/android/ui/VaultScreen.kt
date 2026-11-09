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
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.drivepass.android.Entry
import com.drivepass.android.UiState

private enum class Filter(val label: String, val matches: (Entry) -> Boolean) {
    All("All", { true }),
    Favorites("Favorites", { it.favorite }),
    Logins("Logins", { it.type == "login" }),
    TwoFactor("2FA", { it.totp.isNotBlank() }),
    Cards("Cards", { it.type == "card" }),
    Notes("Notes", { it.type == "note" }),
    Passkeys("Passkeys", { it.type == "passkey" }),
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VaultScreen(state: UiState.Unlocked, onLock: () -> Unit) {
    // Query and filter hold no secrets, so they may survive process death.
    var query by rememberSaveable { mutableStateOf("") }
    var filter by rememberSaveable { mutableStateOf(Filter.All) }
    var openId by rememberSaveable { mutableStateOf<String?>(null) }
    val focus = LocalFocusManager.current

    // Back clears search and filter before it leaves the app.
    BackHandler(enabled = query.isNotEmpty() || filter != Filter.All) {
        query = ""
        filter = Filter.All
        focus.clearFocus()
    }

    val counts = remember(state.entries) { Filter.entries.associateWith { f -> state.entries.count(f.matches) } }
    val shown = remember(state.entries, query, filter) {
        val q = query.trim().lowercase()
        state.entries.filter { e ->
            filter.matches(e) && (
                q.isEmpty() || e.name.lowercase().contains(q) || e.username.lowercase().contains(q) ||
                    e.url.lowercase().contains(q) || e.tags.any { it.lowercase().contains(q) }
                )
        }
    }
    // Section headers only make sense on the unfiltered list.
    val sectioned = query.isBlank() && filter == Filter.All && shown.any { it.favorite } && shown.any { !it.favorite }

    val scroll = TopAppBarDefaults.pinnedScrollBehavior()
    val listState = rememberLazyListState()
    LaunchedEffect(query, filter) { listState.scrollToItem(0) }

    Scaffold(
        modifier = Modifier.nestedScroll(scroll.nestedScrollConnection),
        topBar = {
            TopAppBar(
                scrollBehavior = scroll,
                title = {
                    Column {
                        Text("Vault", style = MaterialTheme.typography.titleLarge)
                        Text(
                            "${state.entries.size} items · ${state.vault.name}",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
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
        Column(Modifier.fillMaxSize().padding(padding)) {
            SearchField(query, onChange = { query = it })
            LazyRow(
                contentPadding = PaddingValues(horizontal = 16.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.padding(vertical = 8.dp),
            ) {
                items(Filter.entries.filter { it == Filter.All || counts.getValue(it) > 0 }) { f ->
                    FilterChip(
                        selected = filter == f,
                        onClick = { filter = if (filter == f) Filter.All else f },
                        label = { Text(if (f == Filter.All) f.label else "${f.label} ${counts.getValue(f)}") },
                        colors = FilterChipDefaults.filterChipColors(
                            selectedContainerColor = MaterialTheme.colorScheme.primaryContainer,
                            selectedLabelColor = MaterialTheme.colorScheme.onPrimaryContainer,
                        ),
                    )
                }
            }

            if (shown.isEmpty()) {
                EmptyState(
                    if (state.entries.isEmpty()) "This vault is empty"
                    else if (query.isNotBlank()) "Nothing matches “${query.trim()}”"
                    else "No ${filter.label.lowercase()} in this vault",
                    if (state.entries.isEmpty()) "Add logins with the DrivePass extension; they'll appear here."
                    else "Try a different search or filter.",
                )
            } else {
                LazyColumn(
                    state = listState,
                    contentPadding = PaddingValues(start = 12.dp, end = 12.dp, bottom = 24.dp),
                    modifier = Modifier.fillMaxSize(),
                ) {
                    if (sectioned) {
                        item(key = "h-fav") { SectionHeader("Favorites") }
                        items(shown.filter { it.favorite }) { EntryRow(it) { openId = it.id } }
                        item(key = "h-all") { SectionHeader("All items") }
                        items(shown.filter { !it.favorite }) { EntryRow(it) { openId = it.id } }
                    } else {
                        items(shown) { EntryRow(it) { openId = it.id } }
                    }
                }
            }
        }
    }

    openId?.let { id ->
        state.entries.firstOrNull { it.id == id }?.let { EntrySheet(it) { openId = null } }
    }
}

@Composable
private fun SearchField(query: String, onChange: (String) -> Unit) {
    TextField(
        value = query,
        onValueChange = onChange,
        placeholder = { Text("Search vault") },
        singleLine = true,
        leadingIcon = { Icon(DpIcons.Search, contentDescription = null, modifier = Modifier.size(20.dp)) },
        trailingIcon = {
            if (query.isNotEmpty()) {
                IconButton(onClick = { onChange("") }) {
                    Icon(DpIcons.Close, contentDescription = "Clear search", modifier = Modifier.size(18.dp))
                }
            }
        },
        keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, imeAction = ImeAction.Search),
        shape = MaterialTheme.shapes.extraLarge,
        colors = TextFieldDefaults.colors(
            focusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
            unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
            focusedIndicatorColor = Color.Transparent,
            unfocusedIndicatorColor = Color.Transparent,
        ),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
    )
}

@Composable
private fun SectionHeader(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.labelLarge,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(start = 12.dp, top = 16.dp, bottom = 6.dp),
    )
}

@Composable
private fun EntryRow(entry: Entry, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.medium)
            .clickable(onClick = onClick)
            .padding(start = 12.dp, top = 10.dp, bottom = 10.dp, end = 0.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        EntryAvatar(entry)
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    entry.title(),
                    style = MaterialTheme.typography.titleMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                if (entry.favorite) {
                    Spacer(Modifier.width(6.dp))
                    Icon(
                        DpIcons.StarFilled,
                        contentDescription = "Favorite",
                        tint = LocalExtraColors.current.star,
                        modifier = Modifier.size(14.dp),
                    )
                }
            }
            val sub = entry.subtitle()
            if (sub.isNotBlank()) {
                Text(
                    sub,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (entry.totp.isNotBlank()) {
            Surface(
                color = MaterialTheme.colorScheme.primaryContainer,
                shape = MaterialTheme.shapes.extraSmall,
                modifier = Modifier.padding(start = 8.dp),
            ) {
                Text(
                    "2FA",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onPrimaryContainer,
                    modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
                )
            }
        }
        // The one-tap action people open a password manager for.
        when {
            entry.password.isNotEmpty() -> CopyButton("Password", entry.password)
            entry.type == "card" && entry.cardNumber.isNotEmpty() -> CopyButton("Card number", entry.cardNumber)
            else -> Spacer(Modifier.width(48.dp))
        }
    }
}

@Composable
private fun EmptyState(title: String, body: String) {
    Box(Modifier.fillMaxSize().padding(32.dp), contentAlignment = Alignment.TopCenter) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.padding(top = 48.dp)) {
            Icon(
                DpIcons.Search,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.outline,
                modifier = Modifier.size(40.dp),
            )
            Spacer(Modifier.height(16.dp))
            Text(title, style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center)
            Spacer(Modifier.height(6.dp))
            Text(
                body,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
        }
    }
}
