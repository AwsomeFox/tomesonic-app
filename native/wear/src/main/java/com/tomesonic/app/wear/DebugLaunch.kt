package com.tomesonic.app.wear

/**
 * The screenshot rig's way in — a DEV TOOL, not a feature.
 *
 * A watch normally gets its server and token from the paired phone over the
 * Wearable Data Layer and always opens on the route
 * [com.tomesonic.app.wear.ui.Routes.startDestination] computes. Neither can be
 * driven from CI: there is no phone, and there is no way to tap through a round
 * emulator from a workflow. So a DEBUG build accepts the same three facts as
 * intent extras (see `.github/workflows/wear-screenshots.yml`).
 *
 * Two rules keep this out of the shipped app:
 *  - the ONLY writer is [com.tomesonic.app.wear.MainActivity], behind an
 *    `ApplicationInfo.FLAG_DEBUGGABLE` check, so in a release build both holders
 *    below stay null and every reader takes the same branch it takes today;
 *  - nothing here touches the Android framework, which is what lets the parsing
 *    rules be pinned by a plain JUnit test instead of by launching an emulator.
 */
object DebugLaunch {

    const val EXTRA_SERVER = "debug_abs_server"
    const val EXTRA_TOKEN = "debug_abs_token"
    const val EXTRA_ROUTE = "debug_route"
    const val EXTRA_PLAY_ITEM = "debug_play_item"

    /**
     * One launch's extras, cleaned. Every field is null when the extra was
     * absent, empty or blank — `am start -e debug_route ""` must read as "not
     * asked for", not as a route named "".
     */
    data class Args(
        val server: String? = null,
        val token: String? = null,
        val route: String? = null,
        val playItemId: String? = null
    ) {
        /**
         * Credentials, or nothing. Both halves or neither: CredsRepository
         * treats a half-written pair as unconfigured anyway, and a server with
         * no token can only 401 its way to the connect screen.
         */
        val creds: Pair<String, String>? =
            server?.let { s -> token?.let { t -> s to t } }
    }

    /**
     * The route to open INSTEAD of the computed start destination — STATIC
     * routes only. An argument-carrying route (contains '/') goes through
     * [consumeNavigateRoute] instead: handing `item/li_book_1` to the NavHost
     * as a start destination matched the template but the screen read an EMPTY
     * id on-device (the first emulator run fetched `/api/items/?expanded=1`),
     * while `navigate()` against the built graph is the exact path every real
     * tap uses.
     */
    @Volatile
    var route: String? = null
        private set

    /** An argument-carrying route to navigate to once the graph exists. */
    @Volatile
    private var navigateRoute: String? = null

    /** An item to start playing once the app is connected. Read once, by design. */
    @Volatile
    var playItemId: String? = null
        private set

    fun parse(extra: (String) -> String?): Args = Args(
        // Same normalization CredsRepository applies, applied here too so the
        // value that reaches the store is the value a test can predict.
        server = clean(extra(EXTRA_SERVER))?.trimEnd('/'),
        token = clean(extra(EXTRA_TOKEN)),
        route = clean(extra(EXTRA_ROUTE)),
        playItemId = clean(extra(EXTRA_PLAY_ITEM))
    )

    /**
     * Last launch wins, INCLUDING an empty one: relaunching with no extras must
     * clear a route left behind by the previous capture rather than reopen it.
     */
    fun apply(args: Args) {
        route = args.route?.takeUnless { it.contains('/') }
        navigateRoute = args.route?.takeIf { it.contains('/') }
        playItemId = args.playItemId
    }

    /**
     * One navigation per launch, same consume-once shape as the play command:
     * the UI re-runs its effects when the connected line is crossed, and
     * re-navigating there would stack a duplicate screen mid-screenshot.
     */
    fun consumeNavigateRoute(): String? {
        val r = navigateRoute
        navigateRoute = null
        return r
    }

    /**
     * The play command fires once per launch. The UI re-runs its effects
     * whenever the connected/disconnected line is crossed, and replaying a
     * `playItem` there would restart the book mid-screenshot.
     */
    fun consumePlayItemId(): String? {
        val id = playItemId
        playItemId = null
        return id
    }

    private fun clean(raw: String?): String? = raw?.trim()?.ifEmpty { null }
}
