package com.tomesonic.app.automotive

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.util.Log
import com.tomesonic.app.automotive.data.CredsRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * The screenshot rig's way in — a DEV TOOL, not a feature.
 *
 * The car normally gets its server and token from exactly one place: a human
 * typing them into [com.tomesonic.app.automotive.ui.SignInActivity] while parked
 * (ARCHITECTURE.md §6). Neither half of that is drivable from CI — there is no
 * account to sign in with, and tapping a three-field form through a head-unit
 * emulator from a workflow is precisely the kind of flake the wear rig removed
 * when it added `DebugLaunch`. So a DEBUG build accepts the same facts as
 * broadcast extras (see `native/automotive/screenshots/capture.sh`).
 *
 * This is the car's equivalent of `:wear`'s `DebugLaunch` (that class is in
 * another module and deliberately un-linked here), and it carries the donor's
 * two rules plus one the car needs:
 *  - the ONLY writer is this receiver, behind an
 *    `ApplicationInfo.FLAG_DEBUGGABLE` check, so even if this class somehow
 *    reached a release APK the seeding path would return immediately and the
 *    store would keep whatever a real sign-in put there;
 *  - **the class and its manifest entry live in `src/debug/` only** — the wear
 *    donor could gate a component the release build still declares because the
 *    watch HAS a launcher activity to hang it off; this artifact declares
 *    exactly two activities and one media service, and `ManifestRulesTest`
 *    fails the build if a third component appears in `src/main`'s manifest.
 *    A debug-only source set is the one place a dev component can live;
 *  - the receiver is `exported`, which in a debug build means any app on the
 *    device can hand this process a server and a token. That is acceptable for
 *    exactly the reason `adb install` of a debuggable build is acceptable, and
 *    for no other: it never ships. `exported` is not optional — the sender is
 *    `adb shell am broadcast`, i.e. the shell uid, which is outside this app.
 *
 * Nothing here touches the browse tree or the media session: the service already
 * collects [CredsRepository.creds] and invalidates on identity change (§6), so
 * writing the store IS the whole handshake — the same one a real sign-in uses.
 */
class DebugSeed : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val app = context.applicationContext
        // The gate, spelled exactly as the donor spells it. A release build can
        // not reach this line (the class is not in the release source set), and
        // if it ever could, it would return here.
        if ((app.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) == 0) return

        Graph.init(app)
        val args = parse { key -> intent.getStringExtra(key) }
        if (args.creds == null && args.lastItemId == null) {
            Log.w(TAG, "nothing to seed: no $EXTRA_SERVER/$EXTRA_TOKEN pair and no $EXTRA_LAST_ITEM")
            return
        }

        // goAsync, NOT fire-and-forget: `adb shell am broadcast` blocks until the
        // receiver finishes, so the rig's next command (open the Media Center)
        // starts AFTER the DataStore write has landed. The wear donor could be
        // fire-and-forget because its UI re-renders off the creds flow; here the
        // very next thing that happens is a browse request, and a browse that
        // races the write photographs a signed-out tree.
        val pending = goAsync()
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            try {
                val repo = Graph.credsRepository
                args.creds?.let { (server, token) ->
                    repo.setCarLogin(
                        server = server,
                        // No refresh token by design: the mock server issues
                        // none, and a fabricated one would send AbsClient down
                        // the refresh path on the first 401 instead of straight
                        // to the signed-out tree the rig wants to photograph.
                        refreshToken = null,
                        token = token,
                        userId = args.userId.orEmpty(),
                        username = args.username.orEmpty()
                    )
                    Log.i(TAG, "seeded creds for $server")
                }
                args.lastItemId?.let { itemId ->
                    // The playback-resumption affordance the Media Center draws
                    // before this app has fetched anything (EP-2) — seeded so
                    // the rig can photograph it without playing a book.
                    repo.setLastItem(itemId, args.lastEpisodeId, args.lastTitle, args.lastAuthor)
                    Log.i(TAG, "seeded last item $itemId")
                }
                // A result code the rig can assert on: `am broadcast` sends an
                // ORDERED broadcast and prints the code it gets back, so
                // "Broadcast completed: result=1" appears only if this line ran
                // — "the seed worked" becomes a checkable fact instead of a
                // guess. (A caller that sends this un-ordered gets a logged
                // complaint from the framework and nothing else; the write above
                // has already happened either way.)
                pending.setResultCode(RESULT_SEEDED)
            } catch (t: Throwable) {
                Log.e(TAG, "seed failed", t)
            } finally {
                pending.finish()
            }
        }
    }

    /**
     * One broadcast's extras, cleaned. Every field is null when the extra was
     * absent, empty or blank — `am broadcast --es debug_abs_token ""` must read
     * as "not asked for", not as a token named "".
     */
    data class Args(
        val server: String? = null,
        val token: String? = null,
        val userId: String? = null,
        val username: String? = null,
        val lastItemId: String? = null,
        val lastEpisodeId: String? = null,
        val lastTitle: String? = null,
        val lastAuthor: String? = null
    ) {
        /**
         * Credentials, or nothing. Both halves or neither: [CredsRepository]
         * treats a half-written pair as unconfigured anyway, and a server with
         * no token can only 401 its way back to the sign-in affordance.
         */
        val creds: Pair<String, String>? =
            server?.let { s -> token?.let { t -> s to t } }
    }

    companion object {
        private const val TAG = "DebugSeed"

        /** Result code of a completed seed — see the `setResultCode` note above. */
        const val RESULT_SEEDED = 1

        /**
         * The receiver's own action, declared in `src/debug/AndroidManifest.xml`.
         * The rig broadcasts EXPLICITLY (`am broadcast -n <pkg>/<class>`), which
         * needs no filter at all; the filter exists so a human poking at a debug
         * build can use the action, and so the component is greppable by name.
         */
        const val ACTION = "com.tomesonic.app.automotive.DEBUG_SEED"

        // Extra names are the wear rig's where wear has an equivalent, so one
        // pair of eyes reads both capture scripts.
        const val EXTRA_SERVER = "debug_abs_server"
        const val EXTRA_TOKEN = "debug_abs_token"
        const val EXTRA_USER_ID = "debug_abs_user_id"
        const val EXTRA_USERNAME = "debug_abs_username"
        const val EXTRA_LAST_ITEM = "debug_last_item"
        const val EXTRA_LAST_EPISODE = "debug_last_episode"
        const val EXTRA_LAST_TITLE = "debug_last_title"
        const val EXTRA_LAST_AUTHOR = "debug_last_author"

        /**
         * Extras -> [Args]. Pure, and takes its reader as a lambda for the same
         * reason the donor does: nothing here touches the Android framework, so
         * the parsing rules could be pinned by a plain JUnit test if this ever
         * grows a rule worth pinning.
         */
        fun parse(extra: (String) -> String?): Args = Args(
            // Same normalization CredsRepository applies, applied here too, so
            // the value that reaches the store is the value the rig passed.
            server = clean(extra(EXTRA_SERVER))?.trimEnd('/'),
            token = clean(extra(EXTRA_TOKEN)),
            userId = clean(extra(EXTRA_USER_ID)),
            username = clean(extra(EXTRA_USERNAME)),
            lastItemId = clean(extra(EXTRA_LAST_ITEM)),
            lastEpisodeId = clean(extra(EXTRA_LAST_EPISODE)),
            lastTitle = clean(extra(EXTRA_LAST_TITLE)),
            lastAuthor = clean(extra(EXTRA_LAST_AUTHOR))
        )

        private fun clean(raw: String?): String? = raw?.trim()?.ifEmpty { null }
    }
}
