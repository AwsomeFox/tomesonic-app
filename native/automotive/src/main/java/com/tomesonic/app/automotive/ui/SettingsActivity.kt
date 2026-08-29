package com.tomesonic.app.automotive.ui

import android.os.Bundle
import android.view.View
import android.widget.Button
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.preference.ListPreference
import androidx.preference.Preference
import androidx.preference.PreferenceCategory
import androidx.preference.PreferenceFragmentCompat
import com.tomesonic.app.automotive.Graph
import com.tomesonic.app.automotive.R
import com.tomesonic.app.automotive.account.AbsAuthenticator
import com.tomesonic.app.automotive.data.CredsRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.math.abs

/**
 * The `ACTION_APPLICATION_PREFERENCES` target — the app's entry in the car's own
 * Settings, and the second and last activity this module ships (§1, §5).
 *
 * Two levels, no deeper: a category of rows, and the dialog a row opens. A car
 * settings screen that nests is a car settings screen someone gets lost in
 * while parked, and the platform draws no back stack for us here.
 *
 * Parked-only, by the same rule as SignInActivity: no `distractionOptimized`
 * meta-data, no code that asks about driving state.
 */
class SettingsActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Idempotent; the car's Settings starts this activity directly.
        Graph.init(applicationContext)
        // Same edge-to-edge model as the sign-in form, for the same reason: one
        // insets path on every api level rather than one on 35 and another
        // below it.
        WindowCompat.setDecorFitsSystemWindows(window, false)
        setContentView(R.layout.activity_settings)

        // AR-1, same listener as the sign-in form and for the same reason: SDK
        // 35 lays the window out edge-to-edge and nothing else insets it.
        val root = findViewById<View>(R.id.settings_root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            )
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }

        // The explicit way back. The head unit's own back gesture/button reaches
        // the same finish(); this is the on-screen half, because a settings
        // screen whose only exit is system chrome is one a passenger can strand
        // themselves in.
        findViewById<Button>(R.id.settings_back).setOnClickListener { finish() }

        if (savedInstanceState == null) {
            supportFragmentManager.beginTransaction()
                .replace(R.id.settings_container, SettingsFragment())
                .commit()
        }
    }

    /**
     * The screen itself, built in Kotlin rather than inflated from `res/xml`.
     *
     * Deliberate: two of these four rows are filled from the DataStore
     * (CredsRepository is the only thing that knows the server, the user and the
     * rate), so an XML screen would put the keys in one file and everything that
     * reads them in another. Built here, a key is declared four lines from its
     * only reader.
     */
    class SettingsFragment : PreferenceFragmentCompat() {

        /**
         * Main-thread scope from the host's executor — `Dispatchers.Main` is not
         * available in this module (kotlinx-coroutines-core only; see
         * build.gradle), and every read below lands on a view.
         */
        private val scope: CoroutineScope by lazy {
            CoroutineScope(SupervisorJob() + requireContext().mainExecutor.asCoroutineDispatcher())
        }

        override fun onCreatePreferences(savedInstanceState: Bundle?, rootKey: String?) {
            val context = preferenceManager.context
            val screen = preferenceManager.createPreferenceScreen(context)

            // ---- Server ------------------------------------------------------

            val serverCategory = PreferenceCategory(context).apply {
                key = KEY_CATEGORY_SERVER
                title = getString(R.string.settings_category_server)
                isPersistent = false
            }
            screen.addPreference(serverCategory)

            // Non-interactive: this row is the answer to "which account is this
            // car signed in as", not a way to change it. Signing IN is the Media
            // Center's affordance and the car's account picker (§6).
            val account = Preference(context).apply {
                key = KEY_ACCOUNT
                title = getString(R.string.settings_account_title)
                summary = getString(R.string.settings_account_signed_out)
                isSelectable = false
                isPersistent = false
            }
            serverCategory.addPreference(account)

            val signOut = Preference(context).apply {
                key = KEY_SIGN_OUT
                title = getString(R.string.settings_sign_out_title)
                summary = getString(R.string.settings_sign_out_summary)
                isPersistent = false
                // Disabled until the store says there is something to sign out
                // of; the fill below decides.
                isEnabled = false
                setOnPreferenceClickListener {
                    confirmSignOut()
                    true
                }
            }
            serverCategory.addPreference(signOut)

            // ---- Playback ----------------------------------------------------

            val playbackCategory = PreferenceCategory(context).apply {
                key = KEY_CATEGORY_PLAYBACK
                title = getString(R.string.settings_category_playback)
                isPersistent = false
            }
            screen.addPreference(playbackCategory)

            // A ListPreference, NOT a DropDownPreference: the dialog puts six
            // full-width rows on the screen at once, which is a car-sized target
            // list; a spinner is a phone-sized one.
            val speed = ListPreference(context).apply {
                key = KEY_PLAYBACK_SPEED
                title = getString(R.string.settings_speed_title)
                entries = SPEED_LABELS
                entryValues = SPEED_VALUES
                dialogTitle = getString(R.string.settings_speed_title)
                // The rate lives in the DataStore as a Float (CredsRepository's
                // `playback_speed`), not in the SharedPreferences a Preference
                // would persist to. Not persistent, therefore: the value is read
                // in below and written out in the change listener, and there is
                // exactly one copy of it.
                isPersistent = false
                // What the row reads for the one frame before the DataStore
                // answers; without it the summary provider says "Not set",
                // which is not true of a rate that always has a value.
                setDefaultValue(SPEED_VALUES[nearestIndex(CredsRepository.DEFAULT_SPEED)].toString())
                summaryProvider = ListPreference.SimpleSummaryProvider.getInstance()
                setOnPreferenceChangeListener { _, newValue ->
                    val rate = speedOf(newValue as? CharSequence)
                    scope.launch { Graph.credsRepository.setPlaybackSpeed(rate) }
                    // True so the row updates now; the write is the store's
                    // problem and CredsRepository refuses a non-finite rate at
                    // its own boundary.
                    true
                }
            }
            playbackCategory.addPreference(speed)

            preferenceScreen = screen

            // One read, after the screen exists — the rows render immediately
            // with their defaults and fill a frame later, which is the right
            // trade on a cold DataStore.
            scope.launch {
                val creds = try {
                    Graph.credsRepository.creds.first()
                } catch (t: Throwable) {
                    null
                }
                if (creds != null) {
                    account.summary = summaryFor(creds.username, creds.server)
                    signOut.isEnabled = true
                }
                val rate = try {
                    Graph.credsRepository.playbackSpeed.first()
                } catch (t: Throwable) {
                    CredsRepository.DEFAULT_SPEED
                }
                speed.value = SPEED_VALUES[nearestIndex(rate)].toString()
            }
        }

        override fun onDestroy() {
            scope.cancel()
            super.onDestroy()
        }

        /**
         * Sign-out is destructive in one way that isn't obvious from the row:
         * CredsRepository.clear() drops the offline progress queue with the
         * credentials, because a queue that survived a logout would flush under
         * whichever account signs in next. So it is confirmed, and the message
         * says so.
         */
        private fun confirmSignOut() {
            AlertDialog.Builder(requireContext())
                .setTitle(R.string.settings_sign_out_title)
                .setMessage(R.string.settings_sign_out_confirm)
                .setNegativeButton(R.string.settings_sign_out_cancel, null)
                .setPositiveButton(R.string.settings_sign_out_title) { _, _ -> signOut() }
                .show()
        }

        private fun signOut() {
            scope.launch {
                // The store first: the media service collects `creds` and
                // invalidates its browse tree on the identity change, which is
                // the whole of §6's sign-out notification path — there is
                // nothing for this screen to tell it.
                try {
                    Graph.credsRepository.clear()
                } catch (t: Throwable) {
                    // An unwritable store leaves the car signed in; finishing
                    // anyway would claim otherwise, so fall through and let the
                    // screen stay.
                    return@launch
                }
                // The AccountManager row mirrors the store, so it goes too
                // — off the UI thread, same binder-IPC rule as ensure().
                val app = requireContext().applicationContext
                withContext(Dispatchers.IO) { AbsAuthenticator.forget(app) }
                // Finish to nothing: whatever opened this screen (the car's
                // Settings, the Media Center) is what the user goes back to.
                activity?.finish()
            }
        }

        private fun summaryFor(username: String, server: String): String {
            val user = username.trim()
            return if (user.isEmpty()) server else "$user · $server"
        }

        private companion object {

            // Keys. Stable strings even though nothing persists them: a key is
            // what `findPreference` and any future instrumentation address a row
            // by, and a row without one is a row that can only be found by title.
            const val KEY_CATEGORY_SERVER = "category_server"
            const val KEY_ACCOUNT = "account"
            const val KEY_SIGN_OUT = "sign_out"
            const val KEY_CATEGORY_PLAYBACK = "category_playback"

            /** Matches CredsRepository's DataStore key, so the two read as one setting. */
            const val KEY_PLAYBACK_SPEED = "playback_speed"

            /**
             * The rates on offer, index-parallel across all three arrays.
             *
             * EXACTLY the phone's quick-pick row (native/components/PlaybackSpeedModal.tsx)
             * and therefore exactly what the watch offers (`:wear`'s SpeedSteps):
             * the rate is a per-client stored preference, and three clients
             * offering three different sets would be three different apps to a
             * user who switches between them mid-book.
             *
             * The labels are the phone's own chip text — `{rate}×`, no trailing
             * zero, because a JS number renders that way.
             */
            val SPEED_STEPS = floatArrayOf(0.75f, 1.0f, 1.25f, 1.5f, 1.75f, 2.0f)
            val SPEED_VALUES: Array<CharSequence> =
                arrayOf("0.75", "1.0", "1.25", "1.5", "1.75", "2.0")
            val SPEED_LABELS: Array<CharSequence> =
                arrayOf("0.75×", "1×", "1.25×", "1.5×", "1.75×", "2×")

            /**
             * The step to show for a stored rate. The phone's ±0.05 stepper can
             * leave the shared preference anywhere (1.35 is a real value), and a
             * list that showed nothing selected for it would read as broken.
             */
            fun nearestIndex(speed: Float): Int {
                var best = 0
                for (i in SPEED_STEPS.indices) {
                    if (abs(SPEED_STEPS[i] - speed) < abs(SPEED_STEPS[best] - speed)) best = i
                }
                return best
            }

            /** An entry value back to the Float the store keeps. */
            fun speedOf(value: CharSequence?): Float =
                value?.toString()?.toFloatOrNull() ?: CredsRepository.DEFAULT_SPEED
        }
    }
}
