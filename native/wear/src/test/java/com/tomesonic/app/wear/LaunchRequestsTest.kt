package com.tomesonic.app.wear

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The tile/complication launch contract.
 *
 * The failure this pins is silent: WearApp rebuilds its navigation graph
 * whenever the connected/disconnected line is crossed, so a request that stayed
 * readable would restart the book on every rebuild — and a request that was
 * never cleared would replay on the NEXT plain launcher tap, days later.
 */
class LaunchRequestsTest {

    /** The holders are process-wide; start every case from a launch with nothing. */
    @Before
    fun reset() {
        LaunchRequests.apply(LaunchRequests.Args())
    }

    private fun parse(
        openPlayer: Boolean = false,
        vararg extras: Pair<String, String?>
    ): LaunchRequests.Args {
        val map = extras.toMap()
        return LaunchRequests.parse(
            boolExtra = { key -> key == LaunchRequests.EXTRA_OPEN_PLAYER && openPlayer },
            stringExtra = { key -> map[key] }
        )
    }

    @Test
    fun aLaunchWithNoExtrasAsksForNothing() {
        val args = LaunchRequests.parse(boolExtra = { false }, stringExtra = { null })
        assertFalse(args.openPlayer)
        assertNull(args.playItemId)
        assertNull(args.playEpisodeId)
        assertTrue(args.isEmpty)
    }

    @Test
    fun blankStringExtrasReadAsAbsent() {
        val args = parse(
            openPlayer = true,
            LaunchRequests.EXTRA_PLAY_ITEM to "  ",
            LaunchRequests.EXTRA_PLAY_EPISODE to ""
        )
        assertTrue(args.openPlayer)
        assertNull(args.playItemId)
        assertNull(args.playEpisodeId)
        // openPlayer alone is still a request — the complication sends exactly
        // that, and it means "open the player".
        assertFalse(args.isEmpty)
    }

    @Test
    fun theResumeTapCarriesBookAndEpisode() {
        val args = parse(
            openPlayer = true,
            LaunchRequests.EXTRA_PLAY_ITEM to "li_pod",
            LaunchRequests.EXTRA_PLAY_EPISODE to "ep_7"
        )
        assertTrue(args.openPlayer)
        assertEquals("li_pod", args.playItemId)
        assertEquals("ep_7", args.playEpisodeId)
    }

    @Test
    fun anEpisodeWithNoItemIsDropped() {
        // An episode is only playable through its podcast; a half pair would ask
        // SessionManager for something it cannot resolve.
        val args = parse(openPlayer = true, LaunchRequests.EXTRA_PLAY_EPISODE to "ep_7")
        assertNull(args.playItemId)
        assertNull(args.playEpisodeId)
    }

    @Test
    fun theRequestIsReadExactlyOnce() {
        LaunchRequests.apply(
            parse(openPlayer = true, LaunchRequests.EXTRA_PLAY_ITEM to "li_1")
        )
        val first = LaunchRequests.consume()
        assertEquals(LaunchRequests.Args(true, "li_1", null), first)
        assertNull(LaunchRequests.consume())
    }

    @Test
    fun aLaunchWithNoExtrasClearsThePreviousOne() {
        // A launcher tap after a tile tap must not replay the tile's request.
        LaunchRequests.apply(
            parse(openPlayer = true, LaunchRequests.EXTRA_PLAY_ITEM to "li_1")
        )
        LaunchRequests.apply(LaunchRequests.parse(boolExtra = { false }, stringExtra = { null }))
        assertNull(LaunchRequests.consume())
    }

    @Test
    fun aNewRequestBumpsTheRevisionAndAnEmptyOneDoesNot() {
        // The revision is how a tap on an ALREADY-OPEN app gets noticed: the
        // composition's first-frame effect has long since run by then.
        val before = LaunchRequests.revision.value
        LaunchRequests.apply(
            parse(openPlayer = true, LaunchRequests.EXTRA_PLAY_ITEM to "li_1")
        )
        assertEquals(before + 1, LaunchRequests.revision.value)
        LaunchRequests.apply(LaunchRequests.parse(boolExtra = { false }, stringExtra = { null }))
        assertEquals(before + 1, LaunchRequests.revision.value)
    }

    @Test
    fun theTilesOpenActionAsksForNothingAtAll() {
        // The "Open TomeSonic" / "Browse your library" taps deliberately carry no
        // extras: the app opens wherever it normally would.
        LaunchRequests.apply(LaunchRequests.parse(boolExtra = { false }, stringExtra = { null }))
        assertNull(LaunchRequests.consume())
    }
}
