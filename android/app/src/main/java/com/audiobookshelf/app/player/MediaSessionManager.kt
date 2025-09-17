package com.audiobookshelf.app.player

import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.PlaybackStateCompat
// MIGRATION: Remove MediaSessionCompat - now using Media3 MediaSession
// import android.support.v4.media.session.MediaSessionCompat
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.media3.common.Player
import androidx.media3.session.MediaLibraryService.MediaLibrarySession
import androidx.media3.session.MediaLibraryService.MediaLibrarySession.Callback
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionToken
import androidx.media3.ui.PlayerNotificationManager
import com.google.common.collect.ImmutableList
import com.audiobookshelf.app.R
import com.audiobookshelf.app.data.PlaybackSession

// MIGRATION-BACKUP: ExoPlayer2 Implementation (commented out for reference)
/*
// Original ExoPlayer2 MediaSessionManager implementation
// This used MediaSessionConnector, TimelineQueueNavigator, etc.
// Full backup saved in MediaSessionManager_ExoPlayer2_backup.kt
*/

/**
 * Manages MediaSession setup for Media3
 * Media3 handles notifications automatically through the MediaSession
 */
class MediaSessionManager(
    private val context: Context,
    private val service: PlayerNotificationService,
    private val callback: Callback
) {
    companion object {
        private const val TAG = "MediaSessionManager"
    }

    // Media3 MediaSession components
    var mediaSession: MediaLibrarySession? = null
        private set

    fun initializeMediaSession(
        notificationId: Int,
        channelId: String,
        sessionActivityPendingIntent: PendingIntent?,
        player: Player
    ) {
        // Create Media3 MediaLibrarySession
        val sessionBuilder = MediaLibrarySession.Builder(context, player, callback)
        sessionActivityPendingIntent?.let { sessionBuilder.setSessionActivity(it) }
        
        // Enable custom commands and actions for Android Auto
        sessionBuilder.setCustomLayout(buildCustomMediaActions())
        
        mediaSession = sessionBuilder.build()

        Log.d(TAG, "Media3 MediaLibrarySession initialized successfully")
    }

    private fun buildCustomMediaActions(): ImmutableList<androidx.media3.session.CommandButton> {
        return buildCustomMediaActionsWithSpeed(service.mediaManager.getSavedPlaybackRate())
    }

    private fun buildCustomMediaActionsWithSpeed(currentSpeed: Float): ImmutableList<androidx.media3.session.CommandButton> {
        val customActions = ImmutableList.builder<androidx.media3.session.CommandButton>()
        
        // Jump backward button
        customActions.add(
            androidx.media3.session.CommandButton.Builder()
                .setDisplayName("Jump Back")
                .setIconResId(R.drawable.exo_icon_rewind)
                .setSessionCommand(SessionCommand(PlayerNotificationService.CUSTOM_ACTION_JUMP_BACKWARD, Bundle.EMPTY))
                .build()
        )
        
        // Jump forward button
        customActions.add(
            androidx.media3.session.CommandButton.Builder()
                .setDisplayName("Jump Forward")
                .setIconResId(R.drawable.exo_icon_fastforward)
                .setSessionCommand(SessionCommand(PlayerNotificationService.CUSTOM_ACTION_JUMP_FORWARD, Bundle.EMPTY))
                .build()
        )
        
        // Skip backward button
        customActions.add(
            androidx.media3.session.CommandButton.Builder()
                .setDisplayName("Previous")
                .setIconResId(R.drawable.skip_previous_24)
                .setSessionCommand(SessionCommand(PlayerNotificationService.CUSTOM_ACTION_SKIP_BACKWARD, Bundle.EMPTY))
                .build()
        )
        
        // Skip forward button
        customActions.add(
            androidx.media3.session.CommandButton.Builder()
                .setDisplayName("Next")
                .setIconResId(R.drawable.skip_next_24)
                .setSessionCommand(SessionCommand(PlayerNotificationService.CUSTOM_ACTION_SKIP_FORWARD, Bundle.EMPTY))
                .build()
        )
        
        // Speed control button with dynamic icon
        val speedIcon = getSpeedIcon(currentSpeed)
        customActions.add(
            androidx.media3.session.CommandButton.Builder()
                .setDisplayName("Speed")
                .setIconResId(speedIcon)
                .setSessionCommand(SessionCommand(PlayerNotificationService.CUSTOM_ACTION_CHANGE_PLAYBACK_SPEED, Bundle.EMPTY))
                .build()
        )
        
        return customActions.build()
    }

    private fun getSpeedIcon(playbackRate: Float): Int {
        return when (playbackRate) {
            in 0.5f..0.7f -> R.drawable.ic_play_speed_0_5x
            in 0.8f..1.0f -> R.drawable.ic_play_speed_1_0x
            in 1.1f..1.3f -> R.drawable.ic_play_speed_1_2x
            in 1.4f..1.6f -> R.drawable.ic_play_speed_1_5x
            in 1.7f..2.2f -> R.drawable.ic_play_speed_2_0x
            in 2.3f..3.0f -> R.drawable.ic_play_speed_3_0x
            // anything set above 3 will show the 3x icon
            else -> R.drawable.ic_play_speed_3_0x
        }
    }

    fun updateCustomLayout() {
        mediaSession?.let { session ->
            val newLayout = buildCustomMediaActionsWithSpeed(service.mediaManager.getSavedPlaybackRate())
            session.setCustomLayout(newLayout)
            Log.d(TAG, "Updated MediaSession custom layout with new speed icon")
        }
    }

    fun getSessionToken(): androidx.media3.session.SessionToken? =
        SessionToken(context, ComponentName(context, service::class.java))

    fun getCompatSessionToken(): androidx.media3.session.SessionToken? =
        // Return Media3 SessionToken
        SessionToken(context, ComponentName(context, service::class.java))

    fun release() {
        mediaSession?.let { session: MediaLibrarySession ->
            session.release()
            Log.d(TAG, "Media3 MediaLibrarySession released")
        }
    }
}
