package com.tomesonic.app.wear.playback

import com.tomesonic.app.wear.data.AudioTrack
import com.tomesonic.app.wear.data.Chapter
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Where the transport buttons actually seek to.
 *
 * Two rules are ported from the phone and must not drift: prev-chapter RESTARTS
 * once you are more than 3s in, and every target is clamped inside the book.
 * The third case is watch-only — a downloaded book has no chapter table (see
 * SessionManager.localChapters), and prev/next then step by TRACK.
 *
 * Pure JVM: nothing here touches a player.
 */
class PlaybackMathTest {

    private val chapters = listOf(
        Chapter(0, 0.0, 100.0, "One"),
        Chapter(1, 100.0, 250.0, "Two"),
        Chapter(2, 250.0, 400.0, "Three")
    )

    private fun track(index: Int, startOffset: Double, duration: Double) =
        AudioTrack(index, startOffset, duration, "t$index", "/f/$index", "audio/mpeg", "track_$index.mp3")

    private val tracks = listOf(track(0, 0.0, 200.0), track(1, 200.0, 200.0))

    private val duration = 400.0

    // ---- ±30s --------------------------------------------------------------

    @Test
    fun aJumpMovesByExactlyTheRequestedSeconds() {
        assertEquals(130.0, PlaybackMath.seekTarget(100.0, 30.0, duration), 1e-9)
        assertEquals(70.0, PlaybackMath.seekTarget(100.0, -30.0, duration), 1e-9)
    }

    @Test
    fun aJumpClampsAtBothEndsOfTheBook() {
        // Not of the TRACK: the queue is one item per track, so an unclamped
        // target is what walks off the end of a multi-file book.
        assertEquals(0.0, PlaybackMath.seekTarget(10.0, -30.0, duration), 1e-9)
        assertEquals(400.0, PlaybackMath.seekTarget(390.0, 30.0, duration), 1e-9)
    }

    @Test
    fun anUnknownDurationStillClampsAtZero() {
        assertEquals(0.0, PlaybackMath.seekTarget(10.0, -30.0, 0.0), 1e-9)
        assertEquals(40.0, PlaybackMath.seekTarget(10.0, 30.0, 0.0), 1e-9)
    }

    @Test
    fun aNonFinitePositionCannotProduceANonFiniteTarget() {
        // A player reports NaN while a track is torn down; a NaN seek target
        // would land the book at an undefined position.
        assertEquals(0.0, PlaybackMath.seekTarget(Double.NaN, 30.0, duration), 1e-9)
    }

    // ---- next --------------------------------------------------------------

    @Test
    fun nextGoesToTheNextChapterStart() {
        assertEquals(100.0, PlaybackMath.nextTarget(50.0, chapters, tracks, duration)!!, 1e-9)
        assertEquals(250.0, PlaybackMath.nextTarget(100.0, chapters, tracks, duration)!!, 1e-9)
    }

    @Test
    fun nextIsNullInTheLastChapter() {
        // Nothing to advance to — "next" must not silently restart the book.
        assertNull(PlaybackMath.nextTarget(300.0, chapters, tracks, duration))
    }

    // ---- previous ----------------------------------------------------------

    @Test
    fun previousRestartsTheCurrentChapterPastThreeSeconds() {
        // usePlaybackStore.previousChapter's `within > 3` rule, ported whole.
        assertEquals(100.0, PlaybackMath.prevTarget(104.0, chapters, tracks, duration)!!, 1e-9)
    }

    @Test
    fun previousStepsBackWithinThreeSeconds() {
        assertEquals(0.0, PlaybackMath.prevTarget(102.0, chapters, tracks, duration)!!, 1e-9)
        // Exactly 3s in is still "just started" — the rule is strictly greater.
        assertEquals(0.0, PlaybackMath.prevTarget(103.0, chapters, tracks, duration)!!, 1e-9)
    }

    @Test
    fun previousAtTheFirstChapterRestartsIt() {
        assertEquals(0.0, PlaybackMath.prevTarget(1.0, chapters, tracks, duration)!!, 1e-9)
    }

    // ---- no chapter table (a downloaded book) ------------------------------

    @Test
    fun withoutChaptersNextStepsToTheFollowingTrack() {
        assertEquals(200.0, PlaybackMath.nextTarget(50.0, emptyList(), tracks, duration)!!, 1e-9)
        // Last track: nothing after it.
        assertNull(PlaybackMath.nextTarget(350.0, emptyList(), tracks, duration))
    }

    @Test
    fun withoutChaptersPreviousKeepsTheSameThreeSecondRule() {
        // 50s into track 1 -> restart track 1.
        assertEquals(200.0, PlaybackMath.prevTarget(250.0, emptyList(), tracks, duration)!!, 1e-9)
        // 1s into track 1 -> the previous track.
        assertEquals(0.0, PlaybackMath.prevTarget(201.0, emptyList(), tracks, duration)!!, 1e-9)
        // First track, just started -> restart it.
        assertEquals(0.0, PlaybackMath.prevTarget(1.0, emptyList(), tracks, duration)!!, 1e-9)
    }

    @Test
    fun withNeitherChaptersNorTracksThereIsNothingToStepTo() {
        assertNull(PlaybackMath.nextTarget(0.0, emptyList(), emptyList(), 0.0))
        assertNull(PlaybackMath.prevTarget(0.0, emptyList(), emptyList(), 0.0))
    }

    @Test
    fun aSingleTrackDownloadHasNowhereToStep() {
        val single = listOf(track(0, 0.0, 400.0))
        assertNull(PlaybackMath.nextTarget(50.0, emptyList(), single, duration))
        // Past 3s it restarts, which is the only sensible "previous" for one file.
        assertEquals(0.0, PlaybackMath.prevTarget(50.0, emptyList(), single, duration)!!, 1e-9)
    }
}
