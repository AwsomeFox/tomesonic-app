package com.tomesonic.app

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import com.reactnative.googlecast.RNGCExpandedControllerActivity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Guards the single-notification fix (plugins/withCastSingleNotification.js):
 * the app's CastOptionsProvider must never configure cast-framework
 * NotificationOptions, otherwise the framework posts a duplicate media
 * notification alongside the player's own.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class CastOptionsProviderTest {

    private fun castOptions() =
        CastOptionsProvider().getCastOptions(ApplicationProvider.getApplicationContext<Application>())

    @Test
    fun castMediaOptionsHaveNoNotificationOptions() {
        assertNull(
            "cast framework must not post its own media notification",
            castOptions().castMediaOptions?.notificationOptions
        )
    }

    @Test
    fun expandedControllerActivityIsTheLibraryActivity() {
        assertEquals(
            RNGCExpandedControllerActivity::class.java.name,
            castOptions().castMediaOptions?.expandedControllerActivityClassName
        )
    }

    @Test
    fun receiverApplicationIdComesFromManifestMetaData() {
        // AndroidManifest.xml meta-data:
        // com.reactnative.googlecast.RECEIVER_APPLICATION_ID = D887A434
        assertEquals("D887A434", castOptions().receiverApplicationId)
    }
}
