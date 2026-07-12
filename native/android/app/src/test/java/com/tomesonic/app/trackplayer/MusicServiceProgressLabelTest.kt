package com.tomesonic.app.trackplayer

import android.app.Application
import com.doublesymmetry.trackplayer.service.MusicService
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Tests the REAL pure progress-label helpers of the patched MusicService
 * (private methods `absProgressPct` and `absProgressSubtitle` in
 * node_modules/react-native-track-player/android/src/main/java/com/
 * doublesymmetry/trackplayer/service/MusicService.kt, applied by
 * patches/react-native-track-player+5.0.0-alpha0.patch).
 *
 * Same harness as MusicServiceSearchCacheTest: the service comes from
 * Robolectric.buildService(...).get() — base Context attached, onCreate()
 * never called — and the private methods are invoked reflectively. Both are
 * pure functions of their arguments (JSONObject in, Int?/String out), so no
 * player or session state is needed.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class MusicServiceProgressLabelTest {

    private lateinit var service: MusicService

    @Before
    fun setUp() {
        service = Robolectric.buildService(MusicService::class.java).get()
    }

    private fun declaredMethod(name: String, vararg params: Class<*>) = try {
        MusicService::class.java.getDeclaredMethod(name, *params).apply { isAccessible = true }
    } catch (e: NoSuchMethodException) {
        throw AssertionError(
            "$name method missing — renamed in the RNTP patch? See " +
                "native/patches/react-native-track-player+5.0.0-alpha0.patch",
            e
        )
    }

    private fun pct(prog: JSONObject?): Int? =
        declaredMethod("absProgressPct", JSONObject::class.java)
            .invoke(service, prog) as Int?

    private fun subtitle(prog: JSONObject?, author: String?): String =
        declaredMethod("absProgressSubtitle", JSONObject::class.java, String::class.java)
            .invoke(service, prog, author) as String

    private fun prog(duration: Double, currentTime: Double, isFinished: Boolean = false): JSONObject =
        JSONObject()
            .put("duration", duration)
            .put("currentTime", currentTime)
            .put("isFinished", isFinished)

    // ---- absProgressPct: in-progress percent clamped to 1..99, else null ----

    @Test
    fun pctIsNullWithoutProgress() {
        assertNull(pct(null))
    }

    @Test
    fun pctIsNullWhenFinished() {
        assertNull(pct(prog(1000.0, 500.0, isFinished = true)))
    }

    @Test
    fun pctIsNullForZeroDuration() {
        assertNull(pct(prog(0.0, 500.0)))
    }

    @Test
    fun pctIsNullForZeroCurrentTime() {
        assertNull(pct(prog(1000.0, 0.0)))
    }

    @Test
    fun tinyProgressClampsUpToOnePercent() {
        // 4/1000 = 0.4% -> toInt() would be 0; a just-started book must still
        // show as in-progress, so the floor is 1.
        assertEquals(1, pct(prog(1000.0, 4.0)))
    }

    @Test
    fun nearlyDoneClampsDownToNinetyNinePercent() {
        // 997/1000 = 99.7% -> toInt() truncates to 99; 100% is reserved for
        // isFinished, which renders as "Finished" instead of a percent.
        assertEquals(99, pct(prog(1000.0, 997.0)))
    }

    @Test
    fun halfwayIsFiftyPercent() {
        assertEquals(50, pct(prog(200.0, 100.0)))
    }

    // ---- absProgressSubtitle: "author • Xh Ym left" and its fallbacks ----

    @Test
    fun noProgressFallsBackToAuthor() {
        assertEquals("Author A", subtitle(null, "Author A"))
        assertEquals("", subtitle(null, null))
    }

    @Test
    fun finishedWithoutAuthorSaysFinished() {
        assertEquals("Finished", subtitle(prog(1000.0, 1000.0, isFinished = true), null))
        assertEquals("Finished", subtitle(prog(1000.0, 1000.0, isFinished = true), ""))
    }

    @Test
    fun finishedWithAuthorPrefixesAuthor() {
        assertEquals("Author A • Finished", subtitle(prog(1000.0, 1000.0, isFinished = true), "Author A"))
    }

    @Test
    fun hoursAndMinutesRemaining() {
        // remaining = 4661 - 1000 = 3661s -> 1h, then 61s of leftover minutes
        // truncates to 1m (never rounds up to "1h 2m").
        assertEquals("1h 1m left", subtitle(prog(4661.0, 1000.0), null))
        assertEquals("Author A • 1h 1m left", subtitle(prog(4661.0, 1000.0), "Author A"))
    }

    @Test
    fun subHourRemainingOmitsHours() {
        // remaining = 300s -> "5m left", no "0h" prefix.
        assertEquals("5m left", subtitle(prog(1300.0, 1000.0), null))
    }

    @Test
    fun zeroRemainingFallsBackToAuthor() {
        // current == duration but not flagged finished: nothing meaningful to
        // count down, so show the author (or nothing) instead of "0m left".
        assertEquals("Author A", subtitle(prog(1000.0, 1000.0), "Author A"))
        assertEquals("", subtitle(prog(1000.0, 1000.0), null))
    }

    @Test
    fun zeroCurrentTimeFallsBackToAuthor() {
        // Not started yet: no countdown even though remaining is positive.
        assertEquals("Author A", subtitle(prog(1000.0, 0.0), "Author A"))
    }
}
