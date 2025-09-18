package com.audiobookshelf.app

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

        // Google's Default Media Receiver application ID for testing
        // Using Google's default receiver to test basic Cast functionality
        // Change back to custom receiver ID after testing: "242E16ED"
        private const val CAST_APP_ID = "242E16ED"
    }

    override fun getCastOptions(context: Context): CastOptions {
        Log.d(TAG, "getCastOptions: Configuring Cast options for Media3 with custom audiobook controls")
        Log.d(TAG, "getCastOptions: Using Cast App ID: $CAST_APP_ID")

        return CastOptions.Builder()
            .setReceiverApplicationId(CAST_APP_ID)
            .setCastMediaOptions(
                CastMediaOptions.Builder()
                    // Media3 handles MediaSession internally, so we enable it
                    // This is different from the original implementation
                    .setMediaSessionEnabled(true)
                    // Let Media3 handle notifications for consistency with local playback
                    .setNotificationOptions(null)
                    // Enable expanded controller for better audiobook controls
                    .setExpandedControllerActivityClassName(
                        "com.audiobookshelf.app.MainActivity"
                    )
                    // Note: setSupportedCommands is not available on CastMediaOptions.Builder
                    // Supported commands are controlled via the MediaInfo when creating media items
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
