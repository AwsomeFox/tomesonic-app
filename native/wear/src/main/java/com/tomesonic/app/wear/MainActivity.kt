package com.tomesonic.app.wear

import android.content.Intent
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
        applyLaunchRequests(intent)
        setContent { WearApp() }
    }

    /**
     * A tile or complication tap can reach a LIVE activity as easily as a cold
     * one, and which of the two is not ours to choose: the manifest declares no
     * launchMode (standard, taskAffinity ""), so whether the system delivers the
     * intent by constructing this activity or by handing it to an existing
     * instance depends on what is already on the task stack. Parsing in BOTH
     * places is the only way a Resume tap cannot be silently dropped.
     */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        // getIntent() has to report the launch the app is about to act on —
        // it is still the source [applyDebugLaunchExtras] would read.
        setIntent(intent)
        applyLaunchRequests(intent)
    }

    /**
     * Tile/complication taps -> [LaunchRequests], for the composition to consume
     * once. See [LaunchRequests]; unlike [DebugLaunch] there is no debuggable
     * gate, because the senders ship in every build.
     */
    private fun applyLaunchRequests(intent: Intent?) {
        LaunchRequests.apply(
            LaunchRequests.parse(
                boolExtra = { key -> intent?.getBooleanExtra(key, false) ?: false },
                stringExtra = { key -> intent?.getStringExtra(key) }
            )
        )
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
