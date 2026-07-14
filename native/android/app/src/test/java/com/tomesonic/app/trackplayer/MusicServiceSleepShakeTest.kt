package com.tomesonic.app.trackplayer

import android.app.Application
import com.doublesymmetry.trackplayer.service.MusicService
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Pins the two native-sleep-timer helpers extracted from the patched
 * MusicService (node_modules/react-native-track-player/android/src/main/java/
 * com/doublesymmetry/trackplayer/service/MusicService.kt, applied by
 * patches/react-native-track-player+5.0.0-alpha0.patch):
 *
 *  - sleepFadeVolume(remainingSecs, fadeSecs): the linear ease-out volume over
 *    the final fade window (was inline in absSleepTick).
 *  - isShake(values): accelerometer normalize-by-g + magnitude + the strict
 *    `< 2.2f` shake threshold (was inline in the SensorEventListener).
 *
 * Both are private and invoked by reflection on a bare service from
 * Robolectric.buildService(...).get() (onCreate NEVER called).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class MusicServiceSleepShakeTest {

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

    // ---- sleepFadeVolume(remainingSecs: Double, fadeSecs: Int): Float ----

    private fun fade(remaining: Double, fadeSecs: Int): Float =
        method("sleepFadeVolume", Double::class.javaPrimitiveType!!, Int::class.javaPrimitiveType!!)
            .invoke(service, remaining, fadeSecs) as Float

    // Production always passes an already-guarded fade window: absSetSleepTimer
    // stores `if (fadeSeconds > 0) fadeSeconds else 60`, so fadeSecs is never 0
    // here (no divide-by-zero). These tests therefore use a valid window (60).
    private val fadeWindow = 60

    @Test
    fun fullVolumeWhenRemainingBeyondFadeWindow() {
        assertEquals(1.0f, fade(90.0, fadeWindow), 0.0f)
    }

    @Test
    fun fullVolumeExactlyAtFadeWindowStart() {
        // remaining == fade -> `remaining >= fadeSecs` true -> 1.0f (no fade yet).
        assertEquals(1.0f, fade(60.0, fadeWindow), 0.0f)
    }

    @Test
    fun halfVolumeAtHalfTheFadeWindow() {
        assertEquals(0.5f, fade(30.0, fadeWindow), 0.0f)
    }

    @Test
    fun zeroVolumeAtZeroRemaining() {
        assertEquals(0.0f, fade(0.0, fadeWindow), 0.0f)
    }

    @Test
    fun negativeRemainingClampsToZero() {
        // coerceIn(0.0, 1.0) floors a negative ratio at 0.0f.
        assertEquals(0.0f, fade(-5.0, fadeWindow), 0.0f)
    }

    // ---- isShake(values: FloatArray): Boolean ----

    private fun isShake(values: FloatArray): Boolean =
        method("isShake", FloatArray::class.java).invoke(service, values) as Boolean

    private val g = 9.80665f

    @Test
    fun atRestIsNotAShake() {
        // ~1g gravity on one axis: magnitude ~1.0 << 2.2 threshold.
        assertFalse(isShake(floatArrayOf(0f, 0f, 9.8f)))
    }

    @Test
    fun justBelowThresholdIsNotAShake() {
        assertFalse(isShake(floatArrayOf(2.19f * g, 0f, 0f)))
    }

    @Test
    fun exactlyAtThresholdIsAShake() {
        // The source uses `if (force < 2.2f) return` — a magnitude EXACTLY at the
        // 2.2f threshold is not below it, so isShake returns true (>= 2.2f). The
        // normalize-then-magnitude of a 2.2g single-axis sample lands on 2.2f
        // bit-for-bit, so this is the true boundary.
        assertTrue(isShake(floatArrayOf(2.2f * g, 0f, 0f)))
    }

    @Test
    fun justAboveThresholdIsAShake() {
        assertTrue(isShake(floatArrayOf(2.2001f * g, 0f, 0f)))
    }

    @Test
    fun largeSpikeIsAShake() {
        assertTrue(isShake(floatArrayOf(50f, 50f, 50f)))
    }
}
