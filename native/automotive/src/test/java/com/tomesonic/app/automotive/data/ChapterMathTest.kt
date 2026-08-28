package com.tomesonic.app.automotive.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * ChapterMath — the Kotlin port of native/utils/chapterMath.ts. The boundary
 * cases below are the TS suite's cases, kept case-for-case so a divergence
 * between the phone's chapter math and the car's shows up here rather than as
 * a scrubber that disagrees with the chapter title on one device.
 *
 * Pure JVM (no Robolectric): nothing in ChapterMath touches an Android type,
 * which is the property that keeps it testable at all.
 */
class ChapterMathTest {

    private val chapters = listOf(
        Chapter(0, 0.0, 100.0, "One"),
        Chapter(1, 100.0, 250.0, "Two"),
        Chapter(2, 250.0, 400.0, "Three")
    )

    private fun track(index: Int, startOffset: Double, duration: Double) =
        AudioTrack(index, startOffset, duration, "t$index", "/f/$index", "audio/mpeg", "track_$index.mp3")

    private val tracks = listOf(
        track(0, 0.0, 3600.0),
        track(1, 3600.0, 1800.0),
        track(2, 5400.0, 600.0)
    )

    // ---- chapterIndexAt: half-open [start, end) ----------------------------

    @Test
    fun positionEqualToChapterEndRollsToTheNextChapter() {
        // 100 is chapter 0's exclusive end AND chapter 1's inclusive start — it
        // must resolve to chapter 1, exactly once.
        assertEquals(1, ChapterMath.chapterIndexAt(100.0, chapters))
        assertEquals(2, ChapterMath.chapterIndexAt(250.0, chapters))
    }

    @Test
    fun positionEqualToChapterStartBelongsToThatChapter() {
        assertEquals(0, ChapterMath.chapterIndexAt(0.0, chapters))
        assertEquals(1, ChapterMath.chapterIndexAt(100.0, chapters))
    }

    @Test
    fun positionsStrictlyInsideAChapterResolveToIt() {
        assertEquals(0, ChapterMath.chapterIndexAt(50.0, chapters))
        assertEquals(1, ChapterMath.chapterIndexAt(249.999, chapters))
        assertEquals(2, ChapterMath.chapterIndexAt(399.999, chapters))
    }

    @Test
    fun beforeTheFirstChapterIsUnmatched() {
        val late = listOf(Chapter(0, 10.0, 20.0, "a"), Chapter(1, 20.0, 30.0, "b"))
        assertEquals(-1, ChapterMath.chapterIndexAt(5.0, late))
        assertEquals(-1, ChapterMath.chapterIndexAt(9.999, late))
    }

    @Test
    fun afterTheLastChapterIsUnmatchedBecauseTheFinalEndIsExclusiveToo() {
        assertEquals(-1, ChapterMath.chapterIndexAt(400.0, chapters))
        assertEquals(-1, ChapterMath.chapterIndexAt(5000.0, chapters))
    }

    @Test
    fun emptyOrNullChapterListsAreUnmatched() {
        assertEquals(-1, ChapterMath.chapterIndexAt(50.0, emptyList()))
        assertEquals(-1, ChapterMath.chapterIndexAt(50.0, null))
    }

    @Test
    fun nonFiniteAndNegativePositionsMatchNothingWithoutThrowing() {
        assertEquals(-1, ChapterMath.chapterIndexAt(Double.NaN, chapters))
        assertEquals(-1, ChapterMath.chapterIndexAt(-1.0, chapters))
        assertEquals(-1, ChapterMath.chapterIndexAt(-0.0001, chapters))
        assertEquals(-1, ChapterMath.chapterIndexAt(Double.POSITIVE_INFINITY, chapters))
        assertEquals(-1, ChapterMath.chapterIndexAt(Double.NEGATIVE_INFINITY, chapters))
    }

    @Test
    fun negativeZeroCountsAsTheFirstChapter() {
        assertEquals(0, ChapterMath.chapterIndexAt(-0.0, chapters))
    }

    @Test
    fun zeroDurationChaptersNeverMatch() {
        // ABS emits these for empty "chapters" on some imports; matching one
        // would divide by zero in every progress derivation downstream.
        val degenerate = listOf(Chapter(0, 0.0, 0.0, "empty"), Chapter(1, 0.0, 50.0, "real"))
        assertEquals(1, ChapterMath.chapterIndexAt(0.0, degenerate))
        assertEquals(1, ChapterMath.chapterIndexAt(10.0, degenerate))
    }

    @Test
    fun everyPositionResolvesToAtMostOneChapterAcrossASweep() {
        var pos = -10.0
        while (pos <= 410.0) {
            val matches = chapters.filter { pos >= it.start && pos < it.end }
            val idx = ChapterMath.chapterIndexAt(pos, chapters)
            if (matches.isEmpty()) {
                assertEquals("pos=$pos", -1, idx)
            } else {
                assertEquals("pos=$pos", 1, matches.size)
                assertEquals("pos=$pos", matches[0], chapters[idx])
            }
            pos += 0.5
        }
    }

    // ---- chapterAt / elapsed / progress ------------------------------------

    @Test
    fun chapterAtReturnsTheContainingChapterOrNull() {
        assertEquals(chapters[1], ChapterMath.chapterAt(120.0, chapters))
        assertNull(ChapterMath.chapterAt(400.0, chapters))
        assertNull(ChapterMath.chapterAt(50.0, null))
    }

    @Test
    fun chapterElapsedIsSecondsSinceTheChapterStart() {
        assertEquals(20.0, ChapterMath.chapterElapsed(120.0, chapters), 1e-9)
        assertEquals(0.0, ChapterMath.chapterElapsed(100.0, chapters), 1e-9)
        assertEquals(0.0, ChapterMath.chapterElapsed(9999.0, chapters), 1e-9)
    }

    @Test
    fun chapterProgressIsClampedAndNeverNaN() {
        assertEquals(0.0, ChapterMath.chapterProgress(100.0, chapters), 1e-9)
        assertEquals(0.5, ChapterMath.chapterProgress(175.0, chapters), 1e-9)
        assertEquals(0.0, ChapterMath.chapterProgress(9999.0, chapters), 1e-9)
        // Zero-length chapter: 0.0, not a NaN that would poison a progress bar.
        assertEquals(0.0, ChapterMath.chapterProgress(0.0, listOf(Chapter(0, 0.0, 0.0, "x"))), 1e-9)
    }

    // ---- chapter navigation ------------------------------------------------

    @Test
    fun nextChapterStartStepsForwardAndStopsAtTheEnd() {
        assertEquals(100.0, ChapterMath.nextChapterStart(50.0, chapters))
        assertEquals(250.0, ChapterMath.nextChapterStart(100.0, chapters))
        assertNull(ChapterMath.nextChapterStart(300.0, chapters))
        assertNull(ChapterMath.nextChapterStart(9999.0, chapters))
    }

    @Test
    fun prevChapterRestartsTheCurrentChapterWhenMoreThanThreeSecondsIn() {
        // The phone's notification/prev-button rule: >3s in means "start over".
        assertEquals(100.0, ChapterMath.prevChapterStart(105.0, chapters))
        assertEquals(0.0, ChapterMath.prevChapterStart(50.0, chapters))
    }

    @Test
    fun prevChapterStepsBackWithinTheFirstThreeSeconds() {
        assertEquals(0.0, ChapterMath.prevChapterStart(102.0, chapters))
        assertEquals(100.0, ChapterMath.prevChapterStart(252.0, chapters))
    }

    @Test
    fun prevChapterTreatsExactlyThreeSecondsAsStepBackNotRestart() {
        // `within > 3`, not `>=` — matches usePlaybackStore.previousChapter.
        assertEquals(0.0, ChapterMath.prevChapterStart(103.0, chapters))
        assertEquals(100.0, ChapterMath.prevChapterStart(103.001, chapters))
    }

    @Test
    fun prevChapterFromTheFirstChapterRestartsItRatherThanFailing() {
        assertEquals(0.0, ChapterMath.prevChapterStart(1.0, chapters))
    }

    @Test
    fun chapterNavigationIsNullWhenNoChapterContainsThePosition() {
        assertNull(ChapterMath.prevChapterStart(9999.0, chapters))
        assertNull(ChapterMath.prevChapterStart(50.0, emptyList()))
        assertNull(ChapterMath.nextChapterStart(50.0, null))
    }

    // ---- absolute position <-> (trackIndex, trackPosition) -----------------

    @Test
    fun absolutePositionAddsTheTrackStartOffset() {
        assertEquals(7230.0, ChapterMath.absolutePosition(tracks, 2, 1830.0)!!, 1e-9)
        assertEquals(3600.0, ChapterMath.absolutePosition(tracks, 1, 0.0)!!, 1e-9)
    }

    @Test
    fun aTrackZeroOffsetOfZeroIsASuccessfulMappingNotNull() {
        assertEquals(12.0, ChapterMath.absolutePosition(tracks, 0, 12.0)!!, 1e-9)
        // Single-track queue: the identity mapping, still not null (this is the
        // documented deviation from the TS helper's single-file null).
        assertEquals(12.0, ChapterMath.absolutePosition(listOf(tracks[0]), 0, 12.0)!!, 1e-9)
    }

    @Test
    fun absolutePositionIsNullForAnUnknownTrackIndex() {
        assertNull(ChapterMath.absolutePosition(tracks, 99, 30.0))
        assertNull(ChapterMath.absolutePosition(tracks, -1, 30.0))
        assertNull(ChapterMath.absolutePosition(emptyList(), 0, 30.0))
        assertNull(ChapterMath.absolutePosition(null, 0, 30.0))
        assertNull(ChapterMath.absolutePosition(tracks, 0, Double.NaN))
    }

    @Test
    fun absolutePositionClampsBelowZero() {
        // media3 reports negative positions before the first frame is rendered.
        assertEquals(0.0, ChapterMath.absolutePosition(tracks, 0, -5.0)!!, 1e-9)
    }

    @Test
    fun trackPositionAtFindsTheContainingTrack() {
        assertEquals(ChapterMath.TrackPosition(0, 12.0), ChapterMath.trackPositionAt(tracks, 12.0))
        assertEquals(ChapterMath.TrackPosition(1, 30.0), ChapterMath.trackPositionAt(tracks, 3630.0))
        assertEquals(ChapterMath.TrackPosition(2, 0.0), ChapterMath.trackPositionAt(tracks, 5400.0))
    }

    @Test
    fun trackPositionAtRollsForwardOnATrackBoundary() {
        // Exactly on track 0's end belongs to track 1, never to both.
        assertEquals(ChapterMath.TrackPosition(1, 0.0), ChapterMath.trackPositionAt(tracks, 3600.0))
    }

    @Test
    fun trackPositionAtClampsAtBothEnds() {
        assertEquals(ChapterMath.TrackPosition(0, 0.0), ChapterMath.trackPositionAt(tracks, -50.0))
        // Past the whole book: the last track at its own end, which is where a
        // finished book resumes.
        assertEquals(ChapterMath.TrackPosition(2, 600.0), ChapterMath.trackPositionAt(tracks, 6000.0))
        assertEquals(ChapterMath.TrackPosition(2, 600.0), ChapterMath.trackPositionAt(tracks, 99999.0))
    }

    @Test
    fun trackPositionAtIsNullForNoQueueOrANaNPosition() {
        assertNull(ChapterMath.trackPositionAt(emptyList(), 10.0))
        assertNull(ChapterMath.trackPositionAt(null, 10.0))
        assertNull(ChapterMath.trackPositionAt(tracks, Double.NaN))
    }

    @Test
    fun trackPositionAtSkipsZeroDurationTracks() {
        val withEmpty = listOf(track(0, 0.0, 0.0), track(1, 0.0, 100.0))
        assertEquals(ChapterMath.TrackPosition(1, 10.0), ChapterMath.trackPositionAt(withEmpty, 10.0))
    }

    @Test
    fun positionAndTrackMappingsRoundTrip() {
        for (abs in listOf(0.5, 12.0, 3599.999, 3600.0, 4000.0, 5399.0, 5400.0, 5999.999)) {
            val tp = ChapterMath.trackPositionAt(tracks, abs)!!
            assertEquals(
                "abs=$abs",
                abs,
                ChapterMath.absolutePosition(tracks, tp.trackIndex, tp.positionSeconds)!!,
                1e-9
            )
        }
    }

    @Test
    fun aTranslatedEndOfTrackPositionLandsInTheExpectedChapter() {
        // The cross-helper invariant from the TS suite, in the car's terms:
        // a mapped position must never stick to the outgoing chapter.
        val justBefore = ChapterMath.absolutePosition(tracks, 0, 99.999)!!
        val atEnd = ChapterMath.absolutePosition(tracks, 0, 100.0)!!
        assertEquals(0, ChapterMath.chapterIndexAt(justBefore, chapters))
        assertEquals(1, ChapterMath.chapterIndexAt(atEnd, chapters))
    }
}
