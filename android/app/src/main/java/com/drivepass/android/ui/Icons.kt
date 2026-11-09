package com.drivepass.android.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

/**
 * The extension's icon set (src/lib/icons.js), redrawn from the same 24x24
 * outlines so both clients share one visual language. Drawn in black and
 * recoloured by Icon's tint, the way `stroke=currentColor` works on the web.
 *
 * Hand-built rather than pulling in material-icons-extended: that artifact is
 * thousands of classes for the dozen glyphs used here.
 */
object DpIcons {
    val Key = icon("Key", circle(8f, 8f, 4.25f), "M11 11l8.5 8.5M16 16l2.25-2.25M18.5 18.5L21 16")
    val Lock = icon("Lock", rect(4.5f, 10.5f, 15f, 10f, 2.5f), "M8 10.5V7a4 4 0 0 1 8 0v3.5")
    val Shield = icon("Shield", "M12 3l7 3v5.5c0 4.4-3 8.2-7 9.5-4-1.3-7-5.1-7-9.5V6z", "M9 12l2.2 2.2L15.5 10")
    val Card = icon("Card", rect(2.5f, 5f, 19f, 14f, 2.5f), "M2.5 10h19M6 15h3")
    val Note = icon("Note", "M6 3.5h8.5L19 8v12.5H6z", "M14 3.5V8h5M9 12.5h6M9 16h4")
    val Passkey = icon(
        "Passkey",
        circle(9.5f, 8f, 3.75f),
        "M3.5 20c0-3.3 2.7-5.5 6-5.5 1 0 2 .2 2.8.6",
        "M15.5 15.5h5.5M18 13v5",
    )
    val Search = icon("Search", circle(11f, 11f, 6.5f), "M15.8 15.8L20.5 20.5")
    val Copy = icon(
        "Copy",
        rect(8.5f, 8.5f, 12f, 12f, 2.5f),
        "M15.5 8.5v-3a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3",
    )
    val Check = icon("Check", "M5 12.5l4.5 4.5L19 7.5")
    val Star = icon("Star", STAR)
    val StarFilled = icon("StarFilled", STAR, filled = true)
    val Eye = icon("Eye", "M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z", circle(12f, 12f, 3f))
    val EyeOff = icon(
        "EyeOff",
        "M9.9 5.8A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3.3 4.1M6.3 7.9A17 17 0 0 0 2.5 12S6 18.5 12 18.5c1.3 0 2.4-.3 3.4-.7",
        "M10 10a2.8 2.8 0 0 0 4 4M3.5 3.5l17 17",
    )
    val Back = icon("Back", "M14.5 5.5L8 12l6.5 6.5")
    val Close = icon("Close", "M6 6l12 12M18 6L6 18")
    val Chevron = icon("Chevron", "M8.5 5.5L15 12l-6.5 6.5")
    val Alert = icon("Alert", circle(12f, 12f, 8.5f), "M12 7.75v5M12 16.1v.05")
    val Clock = icon("Clock", circle(12f, 12f, 8.5f), "M12 7.5V12l3 1.8")
    val CloudOk = icon(
        "CloudOk",
        "M7 18.5a4.25 4.25 0 0 1-.4-8.48 5.5 5.5 0 0 1 10.6-1.4A4.25 4.25 0 0 1 17.5 18.5z",
        "M9.5 14l2 2 3.5-3.8",
    )
    val Folder = icon("Folder", "M3.5 7a1.5 1.5 0 0 1 1.5-1.5h4.2l2 2.5H19a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 19.5H5A1.5 1.5 0 0 1 3.5 18z")
    val External = icon(
        "External",
        "M14 4.5h5.5V10M19.5 4.5L11 13",
        "M17 13.5V18a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 5 18V9a1.5 1.5 0 0 1 1.5-1.5H11",
    )
    val User = icon("User", circle(12f, 8f, 3.75f), "M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6")
    val Globe = icon(
        "Globe",
        circle(12f, 12f, 8.5f),
        "M3.5 12h17M12 3.5c2.3 2.3 3.4 5.2 3.4 8.5s-1.1 6.2-3.4 8.5c-2.3-2.3-3.4-5.2-3.4-8.5s1.1-6.2 3.4-8.5z",
    )
}

private const val STAR = "M12 3.75l2.6 5.28 5.83.85-4.22 4.11 1 5.81L12 17.05l-5.21 2.75 1-5.81-4.22-4.11 5.83-.85z"

private fun circle(cx: Float, cy: Float, r: Float) =
    "M${cx - r},${cy}a$r,$r 0 1,0 ${2 * r},0a$r,$r 0 1,0 ${-2 * r},0z"

private fun rect(x: Float, y: Float, w: Float, h: Float, r: Float) =
    "M${x + r},${y}h${w - 2 * r}a$r,$r 0 0 1 $r,$r" +
        "v${h - 2 * r}a$r,$r 0 0 1 ${-r},$r" +
        "h${-(w - 2 * r)}a$r,$r 0 0 1 ${-r},${-r}" +
        "v${-(h - 2 * r)}a$r,$r 0 0 1 $r,${-r}z"

private fun icon(name: String, vararg paths: String, filled: Boolean = false): ImageVector =
    ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f).apply {
        for (d in paths) {
            addPath(
                pathData = addPathNodes(d),
                fill = if (filled) SolidColor(Color.Black) else null,
                stroke = SolidColor(Color.Black),
                strokeLineWidth = 1.75f,
                strokeLineCap = StrokeCap.Round,
                strokeLineJoin = StrokeJoin.Round,
            )
        }
    }.build()
