package com.tomesonic.app.wear.playback

import com.tomesonic.app.wear.data.AudioTrack
import com.tomesonic.app.wear.data.Chapter
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The one line the watch face's Ongoing Activity chip shows.
 *
 * media3 rebuilds the media notification on player EVENTS, not on a timer, so
 * whatever is picked here stays on a wrist until the next play/pause — and both
 * preferred inputs go missing routinely: a single-file download has no chapter
 * table (SessionManager.localChapters), and a process the system started from a
 * media button has no ActiveSession until something plays.
 *
 * Pure JVM: nothing here touches a notification.
 */
class OngoingStatusTest {

    private val chapters = listOf(
        Chapter(0, 0.0, 100.0, "Chapter One"),
        Chapter(1, 100.0, 250.0, "Chapter Two")
    )

    private fun session(
        title: String = "The Hobbit",
        chapters: List<Chapter> = this.chapters
    ) = ActiveSession(
        serverSessionId = "play_1",
        itemId = "li_1",
        episodeId = null,
        mediaType = "book",
        title = title,
        author = "Tolkien",
        duration = 250.0,
        chapters = chapters,
        tracks = listOf(AudioTrack(0, 0.0, 250.0, "t0", "/f/0", "audio/mpeg", "t0.mp3")),
        coverUri = null
    )

    @Test
    fun theChapterHoldingThePositionNamesTheChip() {
        assertEquals("Chapter Two", OngoingStatus.text(session(), 120.0, "ignored"))
    }

    @Test
    fun aBookWithNoChapterTableIsNamedByTheBook() {
        assertEquals("The Hobbit", OngoingStatus.text(session(chapters = emptyList()), 120.0, null))
    }

    @Test
    fun aPositionInsideNoChapterIsStillNamedByTheBook() {
        // Past the end of the table — a resume marker at the very end of a
        // finished book lands exactly here.
        assertEquals("The Hobbit", OngoingStatus.text(session(), 9_000.0, null))
    }

    @Test
    fun aBlankTitleIsNotATitle() {
        val blank = listOf(Chapter(0, 0.0, 100.0, "   "))
        assertEquals("The Hobbit", OngoingStatus.text(session(chapters = blank), 10.0, null))
        assertEquals(
            "Metadata Title",
            OngoingStatus.text(session(title = "", chapters = blank), 10.0, "Metadata Title")
        )
    }

    @Test
    fun withNoSessionThePlayersOwnMetadataAnswers() {
        assertEquals("Metadata Title", OngoingStatus.text(null, 0.0, "Metadata Title"))
    }

    @Test
    fun withNothingNamedTheChipStillSaysSomething() {
        assertEquals(OngoingStatus.FALLBACK, OngoingStatus.text(null, 0.0, null))
        assertEquals(OngoingStatus.FALLBACK, OngoingStatus.text(null, 0.0, " "))
    }

    @Test
    fun surroundingWhitespaceNeverReachesTheWatchFace() {
        val padded = listOf(Chapter(0, 0.0, 100.0, "  Chapter One "))
        assertEquals("Chapter One", OngoingStatus.text(session(chapters = padded), 10.0, null))
    }
}
