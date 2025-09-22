package com.tomesonic.app

import android.content.Context
import android.util.Log
import com.google.android.gms.cast.framework.CastOptions
import com.google.android.gms.cast.framework.OptionsProvider
import com.google.android.gms.cast.framework.SessionProvider
import com.google.android.gms.cast.framework.media.CastMediaOptions

/**
 * CastOptionsProvider for Media3 integration with Audiobookshelf
 * Configures Cast Framework for chapter-based audiobook playback
 */
class CastOptionsProvider : OptionsProvider {
    companion object {
        private const val TAG = "CastOptionsProvider"

        // Using Default Media Receiver for basic audiobook playback
        // Custom receiver ID for advanced features: "242E16ED"
        private const val CAST_APP_ID = "CC1AD845"
    }

    override fun getCastOptions(context: Context): CastOptions {
        Log.d(TAG, "getCastOptions: Configuring Cast options for Default Media Receiver")
        Log.d(TAG, "getCastOptions: Using Cast App ID: $CAST_APP_ID")

        return CastOptions.Builder()
            .setReceiverApplicationId(CAST_APP_ID)
            .setCastMediaOptions(
                CastMediaOptions.Builder()
                    // Custom receiver: Supports chapter-aware media sessions
                    .setMediaSessionEnabled(true)
                    // Custom receiver: Handle notifications for chapter boundaries
                    .setNotificationOptions(null)
                    // Expanded controller shows Audiobookshelf activity
                    .setExpandedControllerActivityClassName(
                        "com.tomesonic.app.MainActivity"
                    )
                    // Custom receiver handles chapter timing data and absolute seeking
                    .build()
            )
            // Stop receiver when session ends to save battery
            .setStopReceiverApplicationWhenEndingSession(true)
            .build()
            .also {
                Log.d(TAG, "getCastOptions: Cast options created with receiver app ID: ${it.receiverApplicationId}")
            }
    }

    override fun getAdditionalSessionProviders(context: Context): List<SessionProvider>? {
        Log.d(TAG, "getAdditionalSessionProviders: No additional session providers")
        return null
    }
}
