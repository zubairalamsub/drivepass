package com.drivepass.android.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay

/**
 * One wall-clock tick for a whole screen of TOTP codes.
 *
 * Hoisted deliberately: a per-row LaunchedEffect would mean N coroutines and N
 * wakeups a second for a list that only needs one. Rows read [nowMillis] at the
 * leaf so the subscription stays there and the list root never recomposes.
 */
@Stable
class TotpClock internal constructor(initial: Long) {
    var nowMillis by mutableLongStateOf(initial)
        internal set
}

/**
 * A clock that ticks once a second while the screen is RESUMED.
 *
 * Two deliberate choices:
 *
 *  - Wall clock, not the frame clock. `withInfiniteAnimationFrameMillis` counts
 *    frames, and is skewed to nothing by an animator duration scale of 0 in
 *    developer options. A TOTP code derived from it would simply be wrong.
 *  - The time is re-read every tick rather than counted down. A dropped tick, a
 *    doze window or an NTP correction then heals on the next tick instead of
 *    leaving the display disagreeing with the code.
 *
 * `repeatOnLifecycle` is what stops it: a bare LaunchedEffect keeps running
 * while the Activity is merely stopped, because the composition is still alive.
 * Locking the vault disposes this composition outright, so there is nothing to
 * cancel by hand.
 */
@Composable
fun rememberTotpClock(): TotpClock {
    val clock = remember { TotpClock(System.currentTimeMillis()) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            while (true) {
                val now = System.currentTimeMillis()
                clock.nowMillis = now
                // Align to the next wall-clock second, so the countdown steps
                // with the clock instead of drifting by the loop's own cost.
                delay(1000 - now % 1000)
            }
        }
    }
    return clock
}
