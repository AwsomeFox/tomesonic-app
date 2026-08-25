package com.tomesonic.app.wear

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

/**
 * The screenshot rig's launch contract.
 *
 * Worth pinning even though it is a dev tool: the CI job that consumes it can
 * only report "the watch showed the wrong screen", and every one of the rules
 * below (blank means absent, both credential halves or neither, the play id
 * fires once, a launch with no extras CLEARS the previous one) is a way for a
 * capture run to silently photograph the wrong thing.
 */
class DebugLaunchTest {

    /** The holders are process-wide; start every case from a launch with nothing. */
    @Before
    fun reset() {
        DebugLaunch.apply(DebugLaunch.Args())
    }

    private fun parse(vararg extras: Pair<String, String?>): DebugLaunch.Args {
        val map = extras.toMap()
        return DebugLaunch.parse { key -> map[key] }
    }

    @Test
    fun anAbsentExtraIsNull() {
        val args = DebugLaunch.parse { null }
        assertNull(args.server)
        assertNull(args.token)
        assertNull(args.route)
        assertNull(args.playItemId)
        assertNull(args.creds)
    }

    @Test
    fun blankExtrasReadAsAbsent() {
        // `am start -e debug_route ""` is a route nobody asked for, not a route
        // named "" — which as a start destination would fail to resolve.
        val args = parse(
            DebugLaunch.EXTRA_SERVER to "  ",
            DebugLaunch.EXTRA_TOKEN to "",
            DebugLaunch.EXTRA_ROUTE to "   ",
            DebugLaunch.EXTRA_PLAY_ITEM to ""
        )
        assertNull(args.server)
        assertNull(args.token)
        assertNull(args.route)
        assertNull(args.playItemId)
    }

    @Test
    fun theServerIsTrimmedToAnOriginWithNoTrailingSlash() {
        // Every URL the app builds is "$server/api/…"; a stray slash would 404
        // the whole capture run (same rule as CredsRepository.normalizeServer).
        val args = parse(
            DebugLaunch.EXTRA_SERVER to " http://10.0.2.2:3333/ ",
            DebugLaunch.EXTRA_TOKEN to " demo "
        )
        assertEquals("http://10.0.2.2:3333", args.server)
        assertEquals("demo", args.token)
        assertEquals("http://10.0.2.2:3333" to "demo", args.creds)
    }

    @Test
    fun halfACredentialPairIsNoCredentialPair() {
        assertNull(parse(DebugLaunch.EXTRA_SERVER to "http://10.0.2.2:3333").creds)
        assertNull(parse(DebugLaunch.EXTRA_TOKEN to "demo").creds)
    }

    @Test
    fun applyPublishesTheRouteAndTheItemToPlay() {
        DebugLaunch.apply(
            parse(
                DebugLaunch.EXTRA_ROUTE to "item/li_book_1",
                DebugLaunch.EXTRA_PLAY_ITEM to "li_book_1"
            )
        )
        assertEquals("item/li_book_1", DebugLaunch.route)
        assertEquals("li_book_1", DebugLaunch.playItemId)
    }

    @Test
    fun aLaunchWithNoExtrasClearsThePreviousOne() {
        DebugLaunch.apply(parse(DebugLaunch.EXTRA_ROUTE to "player"))
        DebugLaunch.apply(DebugLaunch.parse { null })
        assertNull(DebugLaunch.route)
        assertNull(DebugLaunch.playItemId)
    }

    @Test
    fun theItemToPlayIsReadExactlyOnce() {
        // The UI rebuilds its graph when the connected/disconnected line is
        // crossed; a second read there would restart the book mid-screenshot.
        DebugLaunch.apply(parse(DebugLaunch.EXTRA_PLAY_ITEM to "li_book_1"))
        assertEquals("li_book_1", DebugLaunch.consumePlayItemId())
        assertNull(DebugLaunch.consumePlayItemId())
        assertNull(DebugLaunch.playItemId)
    }
}
