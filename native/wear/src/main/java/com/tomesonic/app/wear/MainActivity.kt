package com.tomesonic.app.wear

import android.content.pm.ApplicationInfo
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import com.tomesonic.app.wear.ui.WearApp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * The whole watch UI is [WearApp]; this class exists to host it.
 *
 * Nothing is constructed here on purpose. The two things that must outlive a
 * screen — the MediaController wrapper and Coil's ImageLoader — belong to
 * `RootViewModel`, which is scoped to this Activity's ViewModelStore: that
 * survives configuration changes (which an Activity does not) and releases the
 * controller in `onCleared`, after the last screen is gone.
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        applyDebugLaunchExtras()
        setContent { WearApp() }
    }

    /**
     * Screenshot/dev rig, DEBUG BUILDS ONLY — see [DebugLaunch] and
     * `.github/workflows/wear-screenshots.yml`. This is the only writer of the
     * [DebugLaunch] holders, so a release build (where the flag is clear)
     * returns here immediately and every reader downstream sees the nulls it
     * would see if this method did not exist.
     */
    private fun applyDebugLaunchExtras() {
        if ((applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) == 0) return
        val args = DebugLaunch.parse { key -> intent?.getStringExtra(key) }
        DebugLaunch.apply(args)
        val creds = args.creds ?: return
        // Fire-and-forget: the credential store is a DataStore write and the UI
        // already re-renders off its flow (see RootViewModel), so there is
        // nothing to wait for and nothing to block the first frame with.
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            Graph.credsRepository.set(creds.first, creds.second, "", "")
        }
    }
}
