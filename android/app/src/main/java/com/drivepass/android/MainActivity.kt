package com.drivepass.android

import android.os.Bundle
import android.view.WindowManager
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import com.drivepass.android.ui.DrivePassApp
import com.drivepass.android.ui.DrivePassTheme

// FragmentActivity, not ComponentActivity: androidx BiometricPrompt hosts
// itself in a fragment and will not accept a bare ComponentActivity.
class MainActivity : FragmentActivity() {

    private val vm: VaultViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        // targetSdk 35+ is edge-to-edge whether we ask or not; asking makes the
        // system bars follow the app's light/dark theme, and the screens pad
        // themselves with window insets.
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        // Vault contents stay out of screenshots and the Recents thumbnail.
        // Note: this also blocks `adb screencap`, by design.
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)

        lifecycle.addObserver(
            LifecycleEventObserver { _, event ->
                when (event) {
                    // A rotation stops and restarts the activity too; that is not
                    // the user leaving, so it must not start the lock timer.
                    Lifecycle.Event.ON_STOP -> if (!isChangingConfigurations) vm.onBackgrounded()
                    Lifecycle.Event.ON_START -> vm.onForegrounded()
                    else -> Unit
                }
            },
        )

        setContent { DrivePassTheme { DrivePassApp(vm) } }
    }
}
