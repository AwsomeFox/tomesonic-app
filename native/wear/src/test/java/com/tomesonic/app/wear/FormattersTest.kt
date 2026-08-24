package com.tomesonic.app.wear

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Formatters.msToClock — the clock label the player/item screens render.
 * Pure JVM: no Robolectric runner, so it also proves :wear's test source set
 * really compiles and executes in CI.
 */
class FormattersTest {

    @Test
    fun zeroIsMinuteSecond() {
        assertEquals("0:00", Formatters.msToClock(0L))
    }

    @Test
    fun negativePositionsClampToZero() {
        // media3 reports C.TIME_UNSET-derived negatives before the first frame.
        assertEquals("0:00", Formatters.msToClock(-1L))
        assertEquals("0:00", Formatters.msToClock(-90_000L))
    }

    @Test
    fun subSecondRemaindersTruncate() {
        assertEquals("0:01", Formatters.msToClock(1_999L))
        assertEquals("0:00", Formatters.msToClock(999L))
    }

    @Test
    fun secondsAreZeroPaddedAndMinutesAreNot() {
        assertEquals("1:01", Formatters.msToClock(61_000L))
        assertEquals("9:05", Formatters.msToClock(545_000L))
    }

    @Test
    fun hourFieldAppearsOnlyAtOneHour() {
        assertEquals("59:59", Formatters.msToClock(3_599_000L))
        assertEquals("1:00:00", Formatters.msToClock(3_600_000L))
    }

    @Test
    fun hoursKeepMinutesZeroPadded() {
        assertEquals("1:02:03", Formatters.msToClock(3_723_000L))
        assertEquals("10:00:00", Formatters.msToClock(36_000_000L))
    }

    @Test
    fun hoursDoNotWrapAtADay() {
        // A 30h audiobook is one number, not "6:00:00" of a second day.
        assertEquals("30:00:00", Formatters.msToClock(108_000_000L))
    }
}
