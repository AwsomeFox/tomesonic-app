package com.tomesonic.app.wear.tile

import com.tomesonic.app.wear.data.LastItem
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The tile's whole decision table.
 *
 * Worth every row: a tile renders in a system surface that this project's test
 * rig cannot drive, so "the tile said the wrong thing" is reportable only as a
 * screenshot from a real watch. The three rules that matter — credentials
 * outrank the resume pointer, a v1 row with no title still renders, and every
 * state offers exactly one action — are pinned here instead.
 */
class TileStateTest {

    @Test
    fun noCredentialsIsNotConfigured() {
        assertEquals(TileState.NotConfigured, TileState.from(hasCreds = false, lastItem = null))
    }

    @Test
    fun noCredentialsWinsOverALastItem() {
        // Offering Resume without a token hands the user a play that can only
        // fail — SessionManager needs the token to open a play session.
        val last = LastItem("li_1", null, "Dune", "Frank Herbert")
        assertEquals(TileState.NotConfigured, TileState.from(hasCreds = false, lastItem = last))
    }

    @Test
    fun credentialsWithNothingPlayedOffersTheLibrary() {
        val state = TileState.from(hasCreds = true, lastItem = null)
        assertEquals(TileState.NothingPlaying, state)
        assertEquals("Browse your library", state.actionLabel)
    }

    @Test
    fun aFullLastItemBecomesResume() {
        val state = TileState.from(
            hasCreds = true,
            lastItem = LastItem("li_1", null, "Dune", "Frank Herbert")
        )
        assertEquals(
            TileState.Resume(
                primary = "Dune",
                secondary = "Frank Herbert",
                itemId = "li_1",
                episodeId = null
            ),
            state
        )
        assertEquals("Resume", state.actionLabel)
    }

    @Test
    fun anEpisodeCarriesItsIdIntoTheTapIntent() {
        // A podcast resume that dropped the episode id would restart the show at
        // whatever episode the item resolves to by default.
        val state = TileState.from(
            hasCreds = true,
            lastItem = LastItem("li_pod", "ep_7", "The Show", "Some Network")
        )
        assertTrue(state is TileState.Resume)
        assertEquals("ep_7", (state as TileState.Resume).episodeId)
        assertEquals("li_pod", state.itemId)
    }

    @Test
    fun aV1RowWithNoTitleStillRenders() {
        // Rows written before v2 carry an id and nothing else, and the tile has
        // no way to look one up — see CredsRepository.setLastItem.
        val state = TileState.from(hasCreds = true, lastItem = LastItem("li_1", null))
        assertEquals(TileState.GENERIC_TITLE, state.primary)
        assertNull(state.secondary)
        assertEquals("li_1", (state as TileState.Resume).itemId)
    }

    @Test
    fun blankTitleAndAuthorReadAsAbsent() {
        // A blank display field is a half-written row, not a book called "".
        val state = TileState.from(
            hasCreds = true,
            lastItem = LastItem("li_1", null, "   ", "")
        )
        assertEquals(TileState.GENERIC_TITLE, state.primary)
        assertNull(state.secondary)
    }

    @Test
    fun aTitleWithNoAuthorDropsTheSecondLineRatherThanFakingIt() {
        val state = TileState.from(
            hasCreds = true,
            lastItem = LastItem("li_1", null, "Dune", null)
        )
        assertEquals("Dune", state.primary)
        assertNull(state.secondary)
    }

    @Test
    fun everyStateHasAHeadlineAndExactlyOneAction() {
        val states = listOf(
            TileState.NotConfigured,
            TileState.NothingPlaying,
            TileState.from(hasCreds = true, lastItem = LastItem("li_1", null, "Dune", "Herbert"))
        )
        // The layout has no empty branch: a blank slot would render as a gap
        // where a line of text belongs.
        states.forEach { state ->
            assertTrue(state.toString(), state.primary.isNotBlank())
            assertTrue(state.toString(), state.actionLabel.isNotBlank())
        }
        assertEquals("Open TomeSonic", TileState.NotConfigured.actionLabel)
    }
}
