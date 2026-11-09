package com.drivepass.android.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

/*
 * Colours are the design tokens from src/common.css, mapped onto Material 3
 * roles, so the phone and the extension read as one product. Deliberately no
 * dynamic (wallpaper) colour: a password manager's UI is somewhere users learn
 * to recognise the real thing, and that only works if it looks the same on
 * every device.
 */

private val Light = lightColorScheme(
    primary = Color(0xFF5457E5),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFECECFD),
    onPrimaryContainer = Color(0xFF2B2D9E),
    secondary = Color(0xFF3D4453),
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFE6E8F2),
    onSecondaryContainer = Color(0xFF10131A),
    background = Color(0xFFF6F7F9),
    onBackground = Color(0xFF10131A),
    surface = Color(0xFFF6F7F9),
    onSurface = Color(0xFF10131A),
    surfaceVariant = Color(0xFFF1F3F7),
    onSurfaceVariant = Color(0xFF646D80),
    surfaceContainerLowest = Color.White,
    surfaceContainerLow = Color.White,
    surfaceContainer = Color.White,
    surfaceContainerHigh = Color(0xFFF1F3F7),
    surfaceContainerHighest = Color(0xFFE9ECF2),
    outline = Color(0xFFCDD2DC),
    outlineVariant = Color(0xFFE3E6EC),
    error = Color(0xFFD92D20),
    onError = Color.White,
    errorContainer = Color(0xFFFDECEB),
    onErrorContainer = Color(0xFF8A1C14),
)

private val Dark = darkColorScheme(
    primary = Color(0xFF8B8CF7),
    onPrimary = Color(0xFF0C0E14),
    primaryContainer = Color(0xFF1E2036),
    onPrimaryContainer = Color(0xFFC9CAFF),
    secondary = Color(0xFFC6CBD7),
    onSecondary = Color(0xFF0C0E14),
    secondaryContainer = Color(0xFF262B38),
    onSecondaryContainer = Color(0xFFF2F4F8),
    background = Color(0xFF0C0E14),
    onBackground = Color(0xFFF2F4F8),
    surface = Color(0xFF0C0E14),
    onSurface = Color(0xFFF2F4F8),
    surfaceVariant = Color(0xFF1D212E),
    onSurfaceVariant = Color(0xFF8F97A8),
    surfaceContainerLowest = Color(0xFF0C0E14),
    surfaceContainerLow = Color(0xFF151822),
    surfaceContainer = Color(0xFF151822),
    surfaceContainerHigh = Color(0xFF1D212E),
    surfaceContainerHighest = Color(0xFF262B38),
    outline = Color(0xFF39404F),
    outlineVariant = Color(0xFF262B38),
    error = Color(0xFFFF6B5E),
    onError = Color(0xFF0C0E14),
    errorContainer = Color(0xFF2A1614),
    onErrorContainer = Color(0xFFFFB4AB),
)

/** Status colours Material 3 has no role for. */
@Immutable
data class ExtraColors(val ok: Color, val warn: Color, val star: Color, val digit: Color, val symbol: Color)

private val LightExtra = ExtraColors(
    ok = Color(0xFF0B9469),
    warn = Color(0xFFB25E02),
    star = Color(0xFFE09A1F),
    digit = Color(0xFF2563EB),
    symbol = Color(0xFFC2410C),
)

private val DarkExtra = ExtraColors(
    ok = Color(0xFF35C99A),
    warn = Color(0xFFE8A33D),
    star = Color(0xFFE8A33D),
    digit = Color(0xFF7DB4FF),
    symbol = Color(0xFFFFA26B),
)

val LocalExtraColors = staticCompositionLocalOf { DarkExtra }

private val AppShapes = Shapes(
    extraSmall = RoundedCornerShape(6.dp),
    small = RoundedCornerShape(10.dp),
    medium = RoundedCornerShape(14.dp),
    large = RoundedCornerShape(18.dp),
    extraLarge = RoundedCornerShape(28.dp),
)

@Composable
fun DrivePassTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalExtraColors provides if (dark) DarkExtra else LightExtra) {
        MaterialTheme(
            colorScheme = if (dark) Dark else Light,
            shapes = AppShapes,
            content = content,
        )
    }
}
