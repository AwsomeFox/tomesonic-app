package com.tomesonic.app.wear.playback

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The listening-time accumulator. Every case here is a way ABS's stats could be
 * silently wrong: the number this produces becomes Minutes Listening, Days
 * Listened and the streak, and nothing on the watch would ever show that it
 * drifted.
 *
 * Pure JVM — the clock is a parameter precisely so these are plain arithmetic.
 */
class ListenAccumulatorTest {

    private val eps = 1e-9

    @Test
    fun countsOnlyTheTimeSpentPlaying() {
        val accumulator = ListenAccumulator()
        accumulator.update(0L, isPlaying = true)
        accumulator.update(15_000L, isPlaying = true)
        assertEquals(15.0, accumulator.pending, eps)
    }

    @Test
    fun theFirstSampleBanksNothing() {
        // No baseline yet — there is no interval to attribute.
        val accumulator = ListenAccumulator()
        accumulator.update(1_000_000L, isPlaying = true)
        assertEquals(0.0, accumulator.pending, eps)
    }

    @Test
    fun aPauseBanksItsFinalPartialIntervalAndThenStops() {
        // With a 15s tick, discarding the segment between the last tick and the
        // pause would throw away up to 15s of REAL listening on every pause.
        val accumulator = ListenAccumulator()
        accumulator.update(0L, isPlaying = true)
        accumulator.update(10_000L, isPlaying = false)
        assertEquals(10.0, accumulator.pending, eps)

        accumulator.update(3_600_000L, isPlaying = false)
        assertEquals(10.0, accumulator.pending, eps)
    }

    @Test
    fun resumingAfterAPauseDoesNotBillThePause() {
        val accumulator = ListenAccumulator()
        accumulator.update(0L, isPlaying = true)
        accumulator.update(10_000L, isPlaying = false)
        // An hour in a pocket, then play again.
        accumulator.update(3_610_000L, isPlaying = true)
        assertEquals(10.0, accumulator.pending, eps)

        accumulator.update(3_615_000L, isPlaying = true)
        assertEquals(15.0, accumulator.pending, eps)
    }

    @Test
    fun aSeekNeitherInflatesNorLosesTime() {
        // A seek is a POSITION jump; this counts elapsed playing time, so the
        // extra sync a seek triggers must be arithmetically invisible.
        val withSeek = ListenAccumulator()
        withSeek.update(0L, isPlaying = true)
        withSeek.update(5_000L, isPlaying = true) // the seek's debounced sync
        withSeek.update(20_000L, isPlaying = true)

        val withoutSeek = ListenAccumulator()
        withoutSeek.update(0L, isPlaying = true)
        withoutSeek.update(20_000L, isPlaying = true)

        assertEquals(20.0, withSeek.pending, eps)
        assertEquals(withoutSeek.pending, withSeek.pending, eps)
    }

    @Test
    fun consumeKeepsSecondsAccruedWhileARequestWasInFlight() {
        val accumulator = ListenAccumulator()
        accumulator.update(0L, isPlaying = true)
        accumulator.update(15_000L, isPlaying = true)
        val claimed = accumulator.pending

        // 3s of listening happen while the POST is still going.
        accumulator.update(18_000L, isPlaying = true)
        accumulator.consume(claimed)

        // Blind-clearing here is the listening-time loss under flaky networks.
        assertEquals(3.0, accumulator.pending, eps)
    }

    @Test
    fun consumeNeverGoesNegative() {
        val accumulator = ListenAccumulator()
        accumulator.consume(30.0)
        assertEquals(0.0, accumulator.pending, eps)
    }

    @Test
    fun oneIntervalIsCappedSoADeferredTickCannotInventHours() {
        val accumulator = ListenAccumulator(maxIntervalSeconds = 120.0)
        accumulator.update(0L, isPlaying = true)
        accumulator.update(3_600_000L, isPlaying = true)
        assertEquals(120.0, accumulator.pending, eps)
    }

    @Test
    fun aBackwardsClockNeverSubtracts() {
        // elapsedRealtime can't go backwards, but nothing in this class enforces
        // its caller's choice of clock, and a negative delta would silently
        // shrink a real total.
        val accumulator = ListenAccumulator()
        accumulator.update(10_000L, isPlaying = true)
        accumulator.update(5_000L, isPlaying = true)
        assertEquals(0.0, accumulator.pending, eps)
    }

    @Test
    fun resetDropsBothTheTotalAndTheBaseline() {
        // A new book must not inherit the previous one's owed seconds.
        val accumulator = ListenAccumulator()
        accumulator.update(0L, isPlaying = true)
        accumulator.update(10_000L, isPlaying = true)
        accumulator.reset()
        assertEquals(0.0, accumulator.pending, eps)

        accumulator.update(20_000L, isPlaying = true)
        assertEquals(0.0, accumulator.pending, eps)
    }
}
