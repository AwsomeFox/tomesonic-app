package com.tomesonic.app.wear.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Every number the watch turns into a string.
 *
 * Pure JVM — no Android types anywhere in UiFormat, which is the point of
 * keeping it out of the composables. The cases that matter are the boundaries:
 * where a size changes unit, where precision drops, and where a value that is
 * absent must produce NOTHING rather than a confident "0%".
 */
class UiFormatTest {

    // ---- bytes --------------------------------------------------------------

    @Test
    fun zeroAndNegativeBytesReadAsEmptyStorage() {
        assertEquals("0 MB", UiFormat.bytes(0L))
        assertEquals("0 MB", UiFormat.bytes(-1L))
    }

    @Test
    fun bytesBelowAKilobyteStayBytes() {
        assertEquals("512 B", UiFormat.bytes(512L))
        assertEquals("1023 B", UiFormat.bytes(1023L))
    }

    @Test
    fun unitsStepAtEveryPowerOf1024() {
        assertEquals("1 KB", UiFormat.bytes(1024L))
        assertEquals("1 MB", UiFormat.bytes(1024L * 1024L))
        assertEquals("1 GB", UiFormat.bytes(1024L * 1024L * 1024L))
    }

    @Test
    fun oneDecimalUnderTenUnitsAndNoneAtOrAbove() {
        assertEquals("1.5 KB", UiFormat.bytes(1536L))
        assertEquals("9.4 MB", UiFormat.bytes(9_856_614L))
        assertEquals("18 MB", UiFormat.bytes(18L * 1024L * 1024L))
    }

    @Test
    fun aTypicalAudiobookReadsAsGigabytes() {
        assertEquals("1.2 GB", UiFormat.bytes(1_288_490_188L))
    }

    // ---- percent ------------------------------------------------------------

    @Test
    fun absentOrZeroProgressHasNoLabel() {
        // The difference between "not started" and "0%" is a row that shows a
        // number nobody asked for.
        assertNull(UiFormat.percent(null))
        assertNull(UiFormat.percent(0.0))
        assertNull(UiFormat.percent(Double.NaN))
    }

    @Test
    fun progressRoundsAndClamps() {
        assertEquals("42%", UiFormat.percent(0.42))
        assertEquals("7%", UiFormat.percent(0.0666))
        assertEquals("100%", UiFormat.percent(1.0))
        assertEquals("100%", UiFormat.percent(1.8))
    }

    // ---- durations ----------------------------------------------------------

    @Test
    fun unknownDurationsProduceNothingToRender() {
        assertEquals("", UiFormat.durationWords(0.0))
        assertEquals("", UiFormat.durationWords(-30.0))
        assertEquals("", UiFormat.durationWords(Double.NaN))
    }

    @Test
    fun durationsReadAsProseNotAsAClock() {
        assertEquals("<1m", UiFormat.durationWords(30.0))
        assertEquals("1m", UiFormat.durationWords(60.0))
        assertEquals("48m", UiFormat.durationWords(2_880.0))
        assertEquals("1h", UiFormat.durationWords(3_600.0))
        assertEquals("11h 4m", UiFormat.durationWords(39_840.0))
    }

    @Test
    fun clockReusesTheSharedFormatter() {
        assertEquals("1:01", UiFormat.secondsToClock(61.0))
        assertEquals("1:00:00", UiFormat.secondsToClock(3_600.0))
        // A player reports both of these before its first frame.
        assertEquals("0:00", UiFormat.secondsToClock(-5.0))
        assertEquals("0:00", UiFormat.secondsToClock(Double.NaN))
    }

    // ---- host ---------------------------------------------------------------

    @Test
    fun hostDropsTheSchemeAndKeepsThePort() {
        assertEquals("abs.example.com:13378", UiFormat.hostOnly("https://abs.example.com:13378"))
        assertEquals("10.0.0.5:13378", UiFormat.hostOnly("http://10.0.0.5:13378/"))
        assertEquals("abs.example.com", UiFormat.hostOnly("https://abs.example.com/audiobooks"))
    }

    @Test
    fun hostSurvivesAnUnexpectedServerString() {
        assertEquals("abs.example.com", UiFormat.hostOnly("abs.example.com"))
        assertEquals("", UiFormat.hostOnly(""))
    }
}
