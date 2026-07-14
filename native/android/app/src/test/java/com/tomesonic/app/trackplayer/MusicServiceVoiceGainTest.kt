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
 * Pins clampVoiceGain — the non-negative millibel clamp extracted from
 * absSetVoiceBoost in the patched MusicService (node_modules/
 * react-native-track-player/android/src/main/java/com/doublesymmetry/
 * trackplayer/service/MusicService.kt, applied by
 * patches/react-native-track-player+5.0.0-alpha0.patch). Was inline as
 * `if (gainMb > 0) gainMb else 0`. Private; reached by reflection on a bare
 * service from Robolectric.buildService(...).get() (onCreate NEVER called).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class MusicServiceVoiceGainTest {

    private lateinit var service: MusicService

    @Before
    fun setUp() {
        service = Robolectric.buildService(MusicService::class.java).get()
    }

    private fun clamp(gainMb: Int): Int {
        val m = try {
            MusicService::class.java.getDeclaredMethod("clampVoiceGain", Int::class.javaPrimitiveType!!)
        } catch (e: NoSuchMethodException) {
            throw AssertionError(
                "clampVoiceGain missing — signature changed in the RNTP patch? See " +
                    "native/patches/react-native-track-player+5.0.0-alpha0.patch",
                e
            )
        }
        m.isAccessible = true
        return m.invoke(service, gainMb) as Int
    }

    @Test
    fun positiveGainPassesThrough() {
        assertEquals(1500, clamp(1500))
    }

    @Test
    fun zeroStaysZero() {
        assertEquals(0, clamp(0))
    }

    @Test
    fun negativeGainFloorsToZero() {
        assertEquals(0, clamp(-100))
    }

    @Test
    fun largeGainPassesThroughUnclamped() {
        // Pins the CURRENT contract: there is NO upper clamp today.
        assertEquals(Int.MAX_VALUE, clamp(Int.MAX_VALUE))
    }
}
