package com.drivepass.android

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.PersistableBundle
import kotlinx.coroutines.Job
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Copies secrets to the clipboard and takes them back out again.
 *
 * Mirrors the extension: a copied secret is cleared after [CLEAR_AFTER_MS]
 * (its SCHEDULE_CLEAR_CLIPBOARD alarm uses the same 30 s).
 */
object SensitiveClipboard {

    const val CLEAR_AFTER_MS = 30_000L
    private const val LABEL = "DrivePass"

    private val scope = MainScope()
    private var pending: Job? = null

    /** Android 13+ shows its own "copied" confirmation; earlier versions need ours. */
    val systemShowsConfirmation get() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU

    fun copy(ctx: Context, value: String) {
        val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val clip = ClipData.newPlainText(LABEL, value)
        // Keeps the value out of the paste preview and keyboard suggestions.
        // The flag is only honoured from API 33; older versions ignore the extra.
        clip.description.extras = PersistableBundle().apply {
            putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true)
        }
        cm.setPrimaryClip(clip)

        pending?.cancel()
        pending = scope.launch {
            delay(CLEAR_AFTER_MS)
            clearIfOurs(cm)
        }
    }

    /**
     * Clear only if the clipboard still holds what we put there. From Android 10
     * a backgrounded app cannot read the clipboard description at all; then we
     * clear anyway, because leaving a password on the clipboard is the worse
     * failure than wiping something copied in the last few seconds.
     */
    private fun clearIfOurs(cm: ClipboardManager) {
        val desc = runCatching { cm.primaryClipDescription }.getOrNull()
        if (desc != null && desc.label != LABEL) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            runCatching { cm.clearPrimaryClip() }
        } else {
            runCatching { cm.setPrimaryClip(ClipData.newPlainText("", "")) }
        }
    }
}
