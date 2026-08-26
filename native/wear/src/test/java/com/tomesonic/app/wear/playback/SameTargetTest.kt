package com.tomesonic.app.wear.playback

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The no-teardown short-circuit's one decision, as a table.
 *
 * This guard exists because of a field bug: tapping the book that was already
 * playing re-resolved it — a second server session, a hand-off of a healthy
 * one, a replaced queue — and broke playback. Every row here is a way that
 * guard could quietly stop matching (or worse, start matching a DIFFERENT
 * book) without a compiler noticing.
 */
class SameTargetTest {

    private fun active(itemId: String, episodeId: String? = null) = ActiveSession(
        serverSessionId = "s1",
        itemId = itemId,
        episodeId = episodeId,
        mediaType = if (episodeId == null) "book" else "podcast",
        title = "Title",
        author = null,
        duration = 3_600.0,
        chapters = emptyList(),
        tracks = emptyList(),
        coverUri = null
    )

    @Test
    fun nothingActiveNeverMatches() {
        assertFalse(SessionManager.isSameTarget(null, "b", null))
    }

    @Test
    fun theSameBookMatches() {
        assertTrue(SessionManager.isSameTarget(active("b"), "b", null))
    }

    @Test
    fun aBlankEpisodeIdMeansTheBook() {
        // Callers pass "" and null interchangeably for "no episode" — both must
        // land on the same answer or the guard depends on which screen tapped.
        assertTrue(SessionManager.isSameTarget(active("b"), "b", ""))
    }

    @Test
    fun aDifferentBookNeverMatches() {
        assertFalse(SessionManager.isSameTarget(active("a"), "b", null))
    }

    @Test
    fun theSameEpisodeMatches() {
        assertTrue(SessionManager.isSameTarget(active("p", "ep-1"), "p", "ep-1"))
    }

    @Test
    fun aDifferentEpisodeOfTheSamePodcastIsASwitchNotAResume() {
        assertFalse(SessionManager.isSameTarget(active("p", "ep-1"), "p", "ep-2"))
    }

    @Test
    fun theItemAloneDoesNotMatchWhileOneOfItsEpisodesPlays() {
        // Asking for the PODCAST while an episode plays is a real switch (the
        // item screen's Play means "play this item"), not a re-tap.
        assertFalse(SessionManager.isSameTarget(active("p", "ep-1"), "p", null))
    }

    @Test
    fun anEpisodeDoesNotMatchWhileItsItemPlaysAsABook() {
        assertFalse(SessionManager.isSameTarget(active("p"), "p", "ep-1"))
    }
}
