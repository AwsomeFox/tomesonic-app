package com.tomesonic.app.wear

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * One tap on the Continue Listening tile or the Resume complication, carried
 * from [MainActivity] to the composition that can act on it.
 *
 * The production sibling of [DebugLaunch]: the same consume-once discipline,
 * with NO `FLAG_DEBUGGABLE` gate. These extras do not come from `am start` —
 * they come from our own tile and complication services, which ship in every
 * build, so the holders below are live in release too.
 *
 * Consume-once for the reason DebugLaunch has it: WearApp REBUILDS its
 * navigation graph whenever the connected/disconnected line is crossed, and a
 * request that stayed readable would restart the book (or re-open the player)
 * on every one of those rebuilds.
 *
 * Nothing here touches the Android framework, which is what lets the parsing
 * rules be pinned by a plain JUnit test.
 */
object LaunchRequests {

    /** Tile/complication contract — the manifest never names these; both ends do. */
    const val EXTRA_OPEN_PLAYER = "extra_open_player"
    const val EXTRA_PLAY_ITEM = "extra_play_item"
    const val EXTRA_PLAY_EPISODE = "extra_play_episode"

    /**
     * One launch's extras, cleaned. A launcher tap — and the tile's "open the
     * app" action, which deliberately carries no extras at all — parses to
     * [Args] with nothing in it.
     */
    data class Args(
        val openPlayer: Boolean = false,
        val playItemId: String? = null,
        val playEpisodeId: String? = null
    ) {
        /** Nothing was asked for; the app opens where it normally would. */
        val isEmpty: Boolean
            get() = !openPlayer && playItemId == null && playEpisodeId == null
    }

    @Volatile
    private var openPlayer: Boolean = false

    @Volatile
    private var playItemId: String? = null

    @Volatile
    private var playEpisodeId: String? = null

    private val _revision = MutableStateFlow(0)

    /**
     * Bumped once per NON-EMPTY [apply]. The holders above cannot be observed,
     * and a tile tap does NOT always arrive cold: when the app is already up the
     * intent lands in MainActivity.onNewIntent, long after the composition's
     * first frame, where an effect keyed on `Unit` has already run and would
     * never look again. Keying the consuming effect on this instead is what
     * makes a tap on an open app do something.
     *
     * Written only from the Activity callbacks that call [apply] — one thread,
     * so the read-modify-write below needs no CAS. Read from anywhere.
     */
    val revision: StateFlow<Int> = _revision.asStateFlow()

    /**
     * Extras -> [Args]. Blank reads as absent (same rule as DebugLaunch), and an
     * episode id with no item id is DROPPED: an episode is only ever playable
     * through its podcast, so a half pair would ask SessionManager for something
     * it cannot resolve.
     */
    fun parse(boolExtra: (String) -> Boolean, stringExtra: (String) -> String?): Args {
        val itemId = clean(stringExtra(EXTRA_PLAY_ITEM))
        return Args(
            openPlayer = boolExtra(EXTRA_OPEN_PLAYER),
            playItemId = itemId,
            playEpisodeId = if (itemId == null) null else clean(stringExtra(EXTRA_PLAY_EPISODE))
        )
    }

    /**
     * Last launch wins, INCLUDING an empty one: a launcher tap arriving after a
     * tile tap must not replay the tile's request.
     */
    fun apply(args: Args) {
        openPlayer = args.openPlayer
        playItemId = args.playItemId
        playEpisodeId = args.playEpisodeId
        // An empty launch clears but does not signal: there is nothing for the
        // UI to wake up and do about a plain launcher tap.
        if (!args.isEmpty) _revision.value = _revision.value + 1
    }

    /** The pending request, cleared. Null when there is nothing to act on. */
    fun consume(): Args? {
        val args = Args(openPlayer, playItemId, playEpisodeId)
        openPlayer = false
        playItemId = null
        playEpisodeId = null
        return args.takeUnless { it.isEmpty }
    }

    private fun clean(raw: String?): String? = raw?.trim()?.ifEmpty { null }
}
