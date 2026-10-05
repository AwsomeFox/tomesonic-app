package com.tomesonic.app.trackplayer

import android.app.Application
import com.doublesymmetry.trackplayer.service.MusicService
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Pins the POSITION-TARGET native sleep timer (end-of-chapter /
 * stop-after-chapter) added to the patched MusicService
 * (patches/react-native-track-player+5.0.0-alpha0.patch):
 *
 *  - sleepTargetRemainingSecs(curIndex, curPosMs, curDurMs, targetIndex,
 *    targetPosMs, speed): wall seconds until the player reaches the chapter
 *    end, judged on the player's OWN position. This replaced a one-shot
 *    wall-clock deadline that skip silence (position outruns the clock),
 *    speed changes and screen-off remote seeks pushed into the next chapter —
 *    the "end of chapter timer doesn't work" reports.
 *  - sleepNextTickDelayMs(remaining): the tick cadence that lands the pause
 *    on the boundary instead of up to a second past it.
 *  - the degraded-service guards on absSetSleepTimerAt /
 *    absGetSleepTimerRemaining (player lateinit unset → no-op / -1).
 *
 * Same harness as MusicServiceSleepShakeTest: private helpers invoked by
 * reflection on a bare service (Robolectric.buildService(...).get() — onCreate
 * NEVER called, so `player` is uninitialized).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class MusicServiceSleepTargetTest {

    private lateinit var service: MusicService

    @Before
    fun setUp() {
        service = Robolectric.buildService(MusicService::class.java).get()
    }

    private fun method(name: String, vararg types: Class<*>): java.lang.reflect.Method {
        val m = try {
            MusicService::class.java.getDeclaredMethod(name, *types)
        } catch (e: NoSuchMethodException) {
            throw AssertionError(
                "$name missing — signature changed in the RNTP patch? See " +
                    "native/patches/react-native-track-player+5.0.0-alpha0.patch",
                e
            )
        }
        m.isAccessible = true
        return m
    }

    private fun target(
        curIndex: Int,
        curPosMs: Long,
        curDurMs: Long,
        targetIndex: Int,
        targetPosMs: Long,
        speed: Float
    ): Double? = method(
        "sleepTargetRemainingSecs",
        Int::class.javaPrimitiveType!!,
        Long::class.javaPrimitiveType!!,
        Long::class.javaPrimitiveType!!,
        Int::class.javaPrimitiveType!!,
        Long::class.javaPrimitiveType!!,
        Float::class.javaPrimitiveType!!
    ).invoke(service, curIndex, curPosMs, curDurMs, targetIndex, targetPosMs, speed) as Double?

    private fun nextTick(remaining: Double?): Long =
        method("sleepNextTickDelayMs", Double::class.javaObjectType)
            .invoke(service, remaining) as Long

    private fun sleepActive(): Boolean {
        val f = MusicService::class.java.getDeclaredField("absSleepActive")
        f.isAccessible = true
        return f.get(service) as Boolean
    }

    // ---- sleepTargetRemainingSecs ----

    @Test
    fun inTheTargetItemItIsTheDistanceToTheTargetPosition() {
        // Flat single-file book, chapter ends at 100s, playing at 40s.
        assertEquals(60.0, target(0, 40_000, 300_000, 0, 100_000, 1f)!!, 1e-9)
    }

    @Test
    fun speedScalesBookSecondsToWallSeconds() {
        // Live player speed, so a speed change with the screen off needs no JS.
        assertEquals(30.0, target(0, 40_000, 300_000, 0, 100_000, 2f)!!, 1e-9)
        assertEquals(80.0, target(0, 40_000, 300_000, 0, 100_000, 0.75f)!!, 1e-9)
    }

    @Test
    fun aSkipSilenceJumpPastTheEndReadsAsReached() {
        // Skip silence can carry the position past the end between ticks —
        // the countdown must read <= 0 (fire), never a stale positive deadline.
        assertTrue(target(0, 100_400, 300_000, 0, 100_000, 1f)!! <= 0.0)
    }

    @Test
    fun theItemAfterTheTargetIsReachedEvenWithoutAnEndSample() {
        // Chapter-clipped queue: the target is the END of clip 1; the player
        // already transitioned into clip 2 before a tick saw the end.
        assertEquals(0.0, target(2, 0, 120_000, 1, 100_000, 1f)!!, 0.0)
        assertEquals(0.0, target(5, 30_000, 120_000, 1, 100_000, 1f)!!, 0.0)
    }

    @Test
    fun oneItemBeforeTheTargetSumsTheRestOfThisItem() {
        // Multi-file book: chapter end 5s into file 2, playing 10s from the
        // end of file 1 → 15s to go.
        assertEquals(15.0, target(0, 90_000, 100_000, 1, 5_000, 1f)!!, 1e-9)
    }

    @Test
    fun anUnknownDistanceIsNullNeverZero() {
        // Null = "can't tell from here" (no fade, no fire) — a 0 would pause.
        assertNull(target(0, 0, 100_000, 3, 5_000, 1f)) // two+ items ahead
        assertNull(target(0, 90_000, 0, 1, 5_000, 1f)) // item duration unknown
        assertNull(target(-1, 0, 0, 0, 5_000, 1f)) // no current item
        assertNull(target(0, 0, 0, -1, 5_000, 1f)) // no target
    }

    @Test
    fun aNonsenseSpeedFallsBackToOneX() {
        assertEquals(5.0, target(0, 0, 100_000, 0, 5_000, Float.NaN)!!, 1e-9)
        assertEquals(5.0, target(0, 0, 100_000, 0, 5_000, 0f)!!, 1e-9)
    }

    // ---- sleepNextTickDelayMs ----

    @Test
    fun tickCadenceTightensOnTheFinalApproach() {
        assertEquals(1000L, nextTick(null))
        assertEquals(1000L, nextTick(Double.POSITIVE_INFINITY))
        assertEquals(1000L, nextTick(60.0))
        assertEquals(200L, nextTick(10.0))
        // Under one 200ms step the next tick lands ON the boundary…
        assertEquals(120L, nextTick(0.12))
        // …with a floor so a near-zero remainder can't spin the handler.
        assertEquals(20L, nextTick(0.001))
    }

    // ---- degraded service guards ----

    @Test
    fun setSleepTimerAtBeforeSetupPlayerNoOpsWithoutThrowing() {
        service.absSetSleepTimerAt(1, 100_000.0, 20, 300)
        assertFalse("timer must not arm before setupPlayer", sleepActive())
    }

    @Test
    fun getRemainingReportsMinusOneWhenNothingIsArmed() {
        // -1 is what makes JS re-arm a timer the service lost.
        assertEquals(-1.0, service.absGetSleepTimerRemaining(), 0.0)
        service.absSetSleepTimer(600.0, 20, 0) // degraded → no-op
        assertEquals(-1.0, service.absGetSleepTimerRemaining(), 0.0)
    }
}
