package com.tomesonic.app.automotive.media

import android.app.Application
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The progress labels a car row carries — [BrowseStyles.progressPct],
 * [BrowseStyles.progressSubtitle] and the title prefix they feed.
 *
 * The rewrite of `MusicServiceProgressLabelTest` from the phone module, which
 * reflected into the patch's private `absProgressPct`/`absProgressSubtitle`.
 * Same table, called directly; the display-title cases are new here because
 * the donor's prefixing was inline in `absPlayableItem` and had no test of its
 * own, and the prefix is the ONLY place progress reliably shows on a car screen
 * (ARCHITECTURE.md §4.3).
 *
 * Robolectric only for org.json — nothing here touches a Context.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class ProgressLabelTest {

    private fun prog(duration: Double, currentTime: Double, isFinished: Boolean = false): JSONObject =
        JSONObject()
            .put("duration", duration)
            .put("currentTime", currentTime)
            .put("isFinished", isFinished)

    // ---- progressPct: 1..99, else null -----------------------------------

    @Test
    fun pctIsNullWithoutProgress() {
        assertNull(BrowseStyles.progressPct(null))
    }

    @Test
    fun pctIsNullWhenFinished() {
        assertNull(BrowseStyles.progressPct(prog(1000.0, 500.0, isFinished = true)))
    }

    @Test
    fun pctIsNullForZeroDuration() {
        assertNull(BrowseStyles.progressPct(prog(0.0, 500.0)))
    }

    @Test
    fun pctIsNullForZeroCurrentTime() {
        assertNull(BrowseStyles.progressPct(prog(1000.0, 0.0)))
    }

    @Test
    fun tinyProgressClampsUpToOnePercent() {
        // 4/1000 = 0.4% -> toInt() would be 0; a just-started book must still
        // read as in-progress, so the floor is 1.
        assertEquals(1, BrowseStyles.progressPct(prog(1000.0, 4.0)))
    }

    @Test
    fun nearlyDoneClampsDownToNinetyNinePercent() {
        // 997/1000 = 99.7% -> truncates to 99; 100% is reserved for isFinished,
        // which renders as a checkmark instead of a percent.
        assertEquals(99, BrowseStyles.progressPct(prog(1000.0, 997.0)))
    }

    @Test
    fun halfwayIsFiftyPercent() {
        assertEquals(50, BrowseStyles.progressPct(prog(200.0, 100.0)))
    }

    // ---- progressSubtitle: "author • Xh Ym left" and its fallbacks --------

    @Test
    fun noProgressFallsBackToAuthor() {
        assertEquals("Author A", BrowseStyles.progressSubtitle(null, "Author A"))
        assertEquals("", BrowseStyles.progressSubtitle(null, null))
    }

    @Test
    fun finishedWithoutAuthorSaysFinished() {
        val finished = prog(1000.0, 1000.0, isFinished = true)
        assertEquals("Finished", BrowseStyles.progressSubtitle(finished, null))
        assertEquals("Finished", BrowseStyles.progressSubtitle(finished, ""))
    }

    @Test
    fun finishedWithAuthorPrefixesAuthor() {
        assertEquals(
            "Author A • Finished",
            BrowseStyles.progressSubtitle(prog(1000.0, 1000.0, isFinished = true), "Author A")
        )
    }

    @Test
    fun hoursAndMinutesRemaining() {
        // remaining = 4661 - 1000 = 3661s -> 1h, then 61s of leftover minutes
        // truncates to 1m (it never rounds up to "1h 2m").
        assertEquals("1h 1m left", BrowseStyles.progressSubtitle(prog(4661.0, 1000.0), null))
        assertEquals(
            "Author A • 1h 1m left",
            BrowseStyles.progressSubtitle(prog(4661.0, 1000.0), "Author A")
        )
    }

    @Test
    fun subHourRemainingOmitsHours() {
        assertEquals("5m left", BrowseStyles.progressSubtitle(prog(1300.0, 1000.0), null))
    }

    @Test
    fun zeroRemainingFallsBackToAuthor() {
        // current == duration but not flagged finished: nothing meaningful to
        // count down, so show the author (or nothing) rather than "0m left".
        assertEquals("Author A", BrowseStyles.progressSubtitle(prog(1000.0, 1000.0), "Author A"))
        assertEquals("", BrowseStyles.progressSubtitle(prog(1000.0, 1000.0), null))
    }

    @Test
    fun zeroCurrentTimeFallsBackToAuthor() {
        // Not started: no countdown even though the remaining time is positive.
        assertEquals("Author A", BrowseStyles.progressSubtitle(prog(1000.0, 0.0), "Author A"))
    }

    // ---- displayTitle: the prefix that actually survives truncation -------

    @Test
    fun unstartedTitleIsUnchanged() {
        assertEquals("Critical Mass", BrowseStyles.displayTitle(null, "Critical Mass"))
        assertEquals(
            "Critical Mass",
            BrowseStyles.displayTitle(prog(1000.0, 0.0), "Critical Mass")
        )
    }

    @Test
    fun inProgressTitleLeadsWithThePercent() {
        assertEquals(
            "42% • Critical Mass",
            BrowseStyles.displayTitle(prog(1000.0, 420.0), "Critical Mass")
        )
    }

    @Test
    fun finishedTitleLeadsWithACheckmarkAndNoPercent() {
        assertEquals(
            "✓ Critical Mass",
            BrowseStyles.displayTitle(prog(1000.0, 1000.0, isFinished = true), "Critical Mass")
        )
    }
}
