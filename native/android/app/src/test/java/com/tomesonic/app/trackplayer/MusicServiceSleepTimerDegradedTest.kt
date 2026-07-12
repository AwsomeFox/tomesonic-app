package com.tomesonic.app.trackplayer

import android.app.Application
import com.doublesymmetry.trackplayer.service.MusicService
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Guards the isInitialized-guard on the patched MusicService sleep timer:
 * absSetSleepTimer reads player.isPlaying and writes player.volume, but
 * `player` is a lateinit that only setupPlayer() assigns. On a degraded
 * service (onCreate never ran / setupPlayer never called — e.g. a stray JS or
 * shake callback racing service startup) both entry points must NO-OP instead
 * of crashing with UninitializedPropertyAccessException, and must not arm the
 * timer. See the `::player.isInitialized` guards in absSetSleepTimer /
 * absSleepReanchor in node_modules/react-native-track-player/android/src/
 * main/java/com/doublesymmetry/trackplayer/service/MusicService.kt (applied
 * by patches/react-native-track-player+5.0.0-alpha0.patch).
 *
 * Same harness as the sibling tests: Robolectric.buildService(...).get()
 * attaches a base Context but never calls onCreate(), which is exactly the
 * degraded pre-setupPlayer state under test.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class MusicServiceSleepTimerDegradedTest {

    private fun sleepActive(service: MusicService): Boolean {
        val field = try {
            MusicService::class.java.getDeclaredField("absSleepActive")
        } catch (e: NoSuchFieldException) {
            throw AssertionError(
                "absSleepActive field missing — renamed in the RNTP patch? See " +
                    "native/patches/react-native-track-player+5.0.0-alpha0.patch",
                e
            )
        }
        field.isAccessible = true
        return field.get(service) as Boolean
    }

    @Test
    fun setSleepTimerBeforeSetupPlayerNoOpsWithoutThrowing() {
        val service = Robolectric.buildService(MusicService::class.java).get()
        // Must not throw UninitializedPropertyAccessException and must not arm.
        service.absSetSleepTimer(3600.0, 60, 30)
        assertFalse("timer must not arm before setupPlayer", sleepActive(service))
    }

    @Test
    fun cancelSleepTimerBeforeSetupPlayerNoOpsWithoutThrowing() {
        val service = Robolectric.buildService(MusicService::class.java).get()
        service.absCancelSleepTimer()
        assertFalse(sleepActive(service))
    }

    @Test
    fun setThenCancelBeforeSetupPlayerLeavesTimerInactive() {
        val service = Robolectric.buildService(MusicService::class.java).get()
        service.absSetSleepTimer(600.0, 30, 0)
        service.absCancelSleepTimer()
        assertFalse(sleepActive(service))
    }
}
