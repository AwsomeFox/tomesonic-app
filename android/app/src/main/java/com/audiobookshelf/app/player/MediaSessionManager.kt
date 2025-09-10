package com.audiobookshelf.app.player

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.support.v4.media.MediaDescriptionCompat
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaControllerCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import android.util.Log
import androidx.core.app.NotificationCompat
import com.google.android.exoplayer2.Player
import com.google.android.exoplayer2.ext.mediasession.MediaSessionConnector
import com.google.android.exoplayer2.ext.mediasession.MediaSessionConnector.CustomActionProvider
import com.google.android.exoplayer2.ext.mediasession.TimelineQueueNavigator
import com.google.android.exoplayer2.ui.PlayerNotificationManager
import com.audiobookshelf.app.R
import androidx.media.session.MediaButtonReceiver
import com.audiobookshelf.app.data.PlaybackSession
import com.audiobookshelf.app.player.AbMediaDescriptionAdapter
import com.audiobookshelf.app.player.MediaSessionCallback
import com.audiobookshelf.app.player.MediaSessionPlaybackPreparer
import com.audiobookshelf.app.player.PlayerNotificationListener

/**
 * Manages MediaSession setup, notification configuration, and queue navigation
 */
class MediaSessionManager(
    private val context: Context,
    private val service: PlayerNotificationService
) {
    companion object {
        private const val TAG = "MediaSessionManager"
    }

    // MediaSession components
    lateinit var mediaSession: MediaSessionCompat
        private set
    lateinit var mediaSessionConnector: MediaSessionConnector
        private set
    lateinit var playerNotificationManager: PlayerNotificationManager
        private set
    lateinit var transportControls: MediaControllerCompat.TransportControls
        private set

    fun initializeMediaSession(
        notificationId: Int,
        channelId: String,
        sessionActivityPendingIntent: PendingIntent?
    ) {
        // Create MediaSession
        mediaSession = MediaSessionCompat(context, TAG).apply {
            setSessionActivity(sessionActivityPendingIntent)
            isActive = true
        }

        val mediaController = MediaControllerCompat(context, mediaSession.sessionToken)
        transportControls = mediaController.transportControls

        // Initialize PlayerNotificationManager
        initializeNotificationManager(notificationId, channelId, mediaController)

        // Initialize MediaSessionConnector
        initializeMediaSessionConnector()

        Log.d(TAG, "MediaSession initialized successfully")
    }

    private fun initializeNotificationManager(
        notificationId: Int,
        channelId: String,
        mediaController: MediaControllerCompat
    ) {
        val builder = PlayerNotificationManager.Builder(context, notificationId, channelId)

        builder.setMediaDescriptionAdapter(AbMediaDescriptionAdapter(mediaController, service))
        builder.setNotificationListener(PlayerNotificationListener(service))

        playerNotificationManager = builder.build()
        playerNotificationManager.setMediaSessionToken(mediaSession.sessionToken)
        playerNotificationManager.setUsePlayPauseActions(true)
        playerNotificationManager.setUseNextAction(false)
        playerNotificationManager.setUsePreviousAction(false)
        playerNotificationManager.setUseChronometer(false)
        playerNotificationManager.setUseStopAction(false)
        playerNotificationManager.setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
        playerNotificationManager.setPriority(NotificationCompat.PRIORITY_MAX)
        playerNotificationManager.setUseFastForwardActionInCompactView(true)
        playerNotificationManager.setUseRewindActionInCompactView(true)
        playerNotificationManager.setSmallIcon(R.drawable.icon_monochrome)
        playerNotificationManager.setBadgeIconType(NotificationCompat.BADGE_ICON_LARGE)
    }

    private fun initializeMediaSessionConnector() {
        mediaSessionConnector = MediaSessionConnector(mediaSession)
        
        val queueNavigator: TimelineQueueNavigator? = createQueueNavigator()
        
        // Set up connector components
        service.setMediaSessionConnectorPlaybackActions()
        mediaSessionConnector.setQueueNavigator(queueNavigator)
        mediaSessionConnector.setPlaybackPreparer(MediaSessionPlaybackPreparer(service))
        
        // Set callback
        mediaSession.setCallback(MediaSessionCallback(service))
    }

    private fun createQueueNavigator(): TimelineQueueNavigator? {
        // Always use manual queue management instead of TimelineQueueNavigator
        // This provides consistent chapter-based navigation for all books
        Log.d(TAG, "Using manual queue management for consistent chapter-based navigation")
        return null
    }

    fun getSessionToken(): MediaSessionCompat.Token = mediaSession.sessionToken

    fun setPlaybackActions(allowSeekingOnMediaControls: Boolean) {
        var playbackActions =
            PlaybackStateCompat.ACTION_PLAY_PAUSE or
                PlaybackStateCompat.ACTION_PLAY or
                PlaybackStateCompat.ACTION_PAUSE or
                PlaybackStateCompat.ACTION_FAST_FORWARD or
                PlaybackStateCompat.ACTION_REWIND or
                PlaybackStateCompat.ACTION_SKIP_TO_NEXT or
                PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or
                PlaybackStateCompat.ACTION_STOP

        if (allowSeekingOnMediaControls) {
            playbackActions = playbackActions or PlaybackStateCompat.ACTION_SEEK_TO
        }
        mediaSessionConnector.setEnabledPlaybackActions(playbackActions)
    }

    fun setCustomActions(playbackSession: PlaybackSession, context: Context, service: PlayerNotificationService) {
        // Ensure we're on the main thread since this accesses MediaSessionConnector
        if (Looper.myLooper() != Looper.getMainLooper()) {
            Log.w(TAG, "setCustomActions called on wrong thread, posting to main thread")
            Handler(Looper.getMainLooper()).post {
                setCustomActions(playbackSession, context, service)
            }
            return
        }
        
        val mediaItems = playbackSession.getMediaItems(context)
        val customActionProviders = mutableListOf<CustomActionProvider>(
            JumpBackwardCustomActionProvider(service),
            JumpForwardCustomActionProvider(service),
            ChangePlaybackSpeedCustomActionProvider(service) // Will be pushed to far left
        )
        
        // Show skip buttons if we have multiple chapters OR multiple tracks (but not for cast player)
        val hasMultipleItems = playbackSession.chapters.size > 1 || mediaItems.size > 1
        if (playbackSession.mediaPlayer != "cast-player" && hasMultipleItems) {
            customActionProviders.addAll(
                listOf(
                    SkipBackwardCustomActionProvider(service),
                    SkipForwardCustomActionProvider(service),
                )
            )
        }
        mediaSessionConnector.setCustomActionProviders(*customActionProviders.toTypedArray())
    }

    fun release() {
        if (::mediaSession.isInitialized) {
            mediaSession.release()
            Log.d(TAG, "MediaSession released")
        }
    }
}
