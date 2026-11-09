package com.drivepass.android.ui

import android.text.format.DateUtils
import androidx.compose.animation.Crossfade
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.drivepass.android.Entry
import kotlinx.coroutines.delay

/** Copies a secret (label, value). Provided once at the root so every copy behaves the same. */
val LocalCopier = staticCompositionLocalOf<(String, String) -> Unit> { { _, _ -> } }

/** The DrivePass mark: the extension's key glyph on its indigo tile. */
@Composable
fun AppMark(size: Dp = 64.dp) {
    Box(
        Modifier
            .size(size)
            .clip(RoundedCornerShape(size * 0.28f))
            .background(Color(0xFF4F46E5)),
        contentAlignment = Alignment.Center,
    ) {
        Icon(DpIcons.Key, contentDescription = null, tint = Color.White, modifier = Modifier.size(size * 0.55f))
    }
}

private val MonogramColors = listOf(
    Color(0xFF4F46E5), Color(0xFF0F766E), Color(0xFFB45309), Color(0xFFE11D48),
    Color(0xFF0284C7), Color(0xFF047857), Color(0xFF7C3AED), Color(0xFFC2410C),
)

/** Bare host of an entry's URL ("github.com"), or "" if it has none. */
fun Entry.host(): String =
    url.trim().substringAfter("://").substringBefore('/').substringBefore('?')
        .substringBefore(':').removePrefix("www.").lowercase()

fun Entry.title(): String = name.ifBlank { host() }.ifBlank { "Untitled" }

fun Entry.typeLabel(): String = when (type) {
    "card" -> "Card"
    "note" -> "Secure note"
    "passkey" -> "Passkey"
    else -> "Login"
}

fun Entry.typeIcon(): ImageVector = when (type) {
    "card" -> DpIcons.Card
    "note" -> DpIcons.Note
    "passkey" -> DpIcons.Passkey
    else -> DpIcons.Key
}

/**
 * A login shows a coloured monogram (stable per site, so the list is scannable
 * by colour); other types show their type glyph, since "N" for every note
 * would carry no information.
 */
@Composable
fun EntryAvatar(entry: Entry, size: Dp = 40.dp) {
    val shape = RoundedCornerShape(size * 0.3f)
    if (entry.type == "login") {
        val seed = entry.host().ifEmpty { entry.title() }
        val color = MonogramColors[Math.floorMod(seed.hashCode(), MonogramColors.size)]
        val letter = entry.title().firstOrNull { it.isLetterOrDigit() }?.uppercaseChar() ?: '•'
        Box(Modifier.size(size).clip(shape).background(color), contentAlignment = Alignment.Center) {
            Text(
                letter.toString(),
                color = Color.White,
                fontWeight = FontWeight.SemiBold,
                fontSize = (size.value * 0.42f).sp,
            )
        }
    } else {
        Box(
            Modifier.size(size).clip(shape).background(MaterialTheme.colorScheme.primaryContainer),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                entry.typeIcon(),
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(size * 0.5f),
            )
        }
    }
}

/** A copy button that briefly turns into a check mark, so the tap visibly registered. */
@Composable
fun CopyButton(label: String, value: String) {
    val copier = LocalCopier.current
    var done by remember { mutableStateOf(false) }
    LaunchedEffect(done) {
        if (done) {
            delay(1500)
            done = false
        }
    }
    IconButton(onClick = { copier(label, value); done = true }) {
        Crossfade(done, label = "copy") { copied ->
            Icon(
                if (copied) DpIcons.Check else DpIcons.Copy,
                contentDescription = if (copied) "$label copied" else "Copy $label",
                tint = if (copied) LocalExtraColors.current.ok else MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(20.dp),
            )
        }
    }
}

/** Password with digits and symbols tinted, so O/0 and l/1/| can be told apart when typing it by hand. */
@Composable
fun passwordText(value: String): AnnotatedString {
    val extra = LocalExtraColors.current
    return buildAnnotatedString {
        for (c in value) {
            when {
                c.isDigit() -> withStyle(SpanStyle(color = extra.digit)) { append(c) }
                !c.isLetter() -> withStyle(SpanStyle(color = extra.symbol)) { append(c) }
                else -> append(c)
            }
        }
    }
}

/** A rounded group of [DetailRow]s with hairlines between them. */
@Composable
fun DetailGroup(content: @Composable ColumnScope.() -> Unit) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        shape = MaterialTheme.shapes.medium,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(content = content)
    }
}

@Composable
fun GroupDivider() {
    HorizontalDivider(Modifier.padding(start = 52.dp), color = MaterialTheme.colorScheme.outlineVariant)
}

@Composable
fun DetailRow(
    icon: ImageVector,
    label: String,
    value: @Composable () -> Unit,
    actions: @Composable () -> Unit = {},
) {
    Row(
        Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 10.dp, bottom = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(20.dp))
        Spacer(Modifier.width(16.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            value()
        }
        actions()
    }
}

@Composable
fun MonoValue(text: AnnotatedString) {
    Text(text, style = MaterialTheme.typography.bodyLarge, fontFamily = FontFamily.Monospace)
}

@Composable
fun PlainValue(text: String) {
    Text(text, style = MaterialTheme.typography.bodyLarge)
}

/**
 * A time that reads naturally after a verb: "just now", "5 min. ago",
 * "yesterday", "on Mar 12, 2025".
 */
fun relativePhrase(millis: Long): String {
    val now = System.currentTimeMillis()
    if (now - millis in 0 until DateUtils.MINUTE_IN_MILLIS) return "just now"
    val s = DateUtils.getRelativeTimeSpanString(
        millis,
        now,
        DateUtils.MINUTE_IN_MILLIS,
        DateUtils.FORMAT_ABBREV_RELATIVE,
    ).toString()
    return when {
        DateUtils.isToday(millis + DateUtils.DAY_IN_MILLIS) && !s.first().isDigit() -> s.lowercase()
        s.first().isDigit() -> s
        else -> "on $s"
    }
}
