package com.tomesonic.app.trackplayer

import android.app.Application
import com.doublesymmetry.trackplayer.service.MusicService
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Pins bankedListenSeconds — the anti-over-report clamp extracted from
 * absPersistTickOnce in the patched MusicService (node_modules/
 * react-native-track-player/android/src/main/java/com/doublesymmetry/
 * trackplayer/service/MusicService.kt, applied by
 * patches/react-native-track-player+5.0.0-alpha0.patch).
 *
 * timeListened is WALL-CLOCK seconds between ticks, NOT the position delta (a
 * forward seek would over-report). The clamp banks 0 on the first tick
 * (prevWall < 0), on a non-positive delta (backwards/zero), and on a delta
 * larger than maxStep (a stall / doze). Private; reached by reflection on a
 * bare service from Robolectric.buildService(...).get() (onCreate NEVER called).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class MusicServiceListenBankTest {

    private lateinit var service: MusicService

    @Before
    fun setUp() {
        service = Robolectric.buildService(MusicService::class.java).get()
    }

    private fun banked(prevWallMs: Long, nowWallMs: Long, maxStep: Double): Double {
        val m = try {
            MusicService::class.java.getDeclaredMethod(
                "bankedListenSeconds",
                Long::class.javaPrimitiveType!!,
                Long::class.javaPrimitiveType!!,
                Double::class.javaPrimitiveType!!
            )
        } catch (e: NoSuchMethodException) {
            throw AssertionError(
                "bankedListenSeconds missing — signature changed in the RNTP patch? See " +
                    "native/patches/react-native-track-player+5.0.0-alpha0.patch",
                e
            )
        }
        m.isAccessible = true
        return m.invoke(service, prevWallMs, nowWallMs, maxStep) as Double
    }

    // Production maxStep = (ABS_PERSIST_INTERVAL_MS / 1000.0) * 4 = 20 * 4 = 80s.
    private val maxStep = 80.0

    @Test
    fun firstTickBanksZero() {
        // prevWall < 0 sentinel: the tick after a (re)start / seek / identity
        // change has no baseline yet.
        assertEquals(0.0, banked(-1L, 1000L, maxStep), 0.0)
    }

    @Test
    fun normalTickBanksElapsedWallSeconds() {
        assertEquals(20.0, banked(1000L, 21000L, maxStep), 0.0)
    }

    @Test
    fun dozeJumpBeyondMaxStepBanksZero() {
        // +5 min between ticks (> 80s) must not bank a huge fabricated value.
        assertEquals(0.0, banked(1000L, 301000L, maxStep), 0.0)
    }

    @Test
    fun backwardsClockBanksZero() {
        assertEquals(0.0, banked(21000L, 1000L, maxStep), 0.0)
    }

    @Test
    fun zeroDeltaBanksZero() {
        assertEquals(0.0, banked(1000L, 1000L, maxStep), 0.0)
    }

    @Test
    fun exactlyMaxStepIsBanked() {
        // delta == maxStep -> `it <= maxStep` true -> banked (inclusive upper bound).
        assertEquals(80.0, banked(1000L, 81000L, maxStep), 0.0)
    }
}
