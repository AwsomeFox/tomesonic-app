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
import android.util.Log
import androidx.core.app.NotificationCompat
// Media3 imports
import androidx.media3.common.Player
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import androidx.media3.ui.PlayerNotificationManager
// Legacy MediaSession support for Android Auto compatibility
import android.support.v4.media.MediaDescriptionCompat
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaControllerCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import androidx.media.session.MediaButtonReceiver
import com.audiobookshelf.app.MainActivity
import com.audiobookshelf.app.R
import com.audiobookshelf.app.data.PlaybackSession
import com.audiobookshelf.app.player.AbMediaDescriptionAdapter
import com.audiobookshelf.app.player.MediaSessionCallback
import com.audiobookshelf.app.player.PlayerNotificationListener

/**
 * Manages MediaSession setup using Media3 with legacy MediaSessionCompat bridge for Android Auto
 */
class MediaSessionManager(
    private val context: Context,
    private val service: PlayerNotificationService
) {
    companion object {
        private const val TAG = "MediaSessionManager"
    }

    // Media3 MediaSession (primary)
    private var media3Session: MediaSession? = null

    // Legacy MediaSessionCompat (for Android Auto compatibility)
    lateinit var mediaSession: MediaSessionCompat
        private set
    lateinit var playerNotificationManager: PlayerNotificationManager
        private set
    lateinit var transportControls: MediaControllerCompat.TransportControls
        private set

    fun initializeMediaSession(
        notificationId: Int,
        channelId: String,
        sessionActivityPendingIntent: PendingIntent?,
        player: Player
    ) {
        // Create Media3 MediaSession (primary)
        val sessionBuilder = MediaSession.Builder(context, player)
        sessionActivityPendingIntent?.let { sessionBuilder.setSessionActivity(it) }
        media3Session = sessionBuilder.build()

        Log.d(TAG, "Media3 MediaSession created with token: ${media3Session?.token}")

        // Create legacy MediaSessionCompat for Android Auto compatibility
        mediaSession = MediaSessionCompat(context, TAG).apply {
            setSessionActivity(sessionActivityPendingIntent)
            setFlags(MediaSessionCompat.FLAG_HANDLES_MEDIA_BUTTONS or
                    MediaSessionCompat.FLAG_HANDLES_TRANSPORT_CONTROLS)
            isActive = true
        }

        Log.d(TAG, "MediaSessionCompat created with token: ${mediaSession.sessionToken}")

        val mediaController = MediaControllerCompat(context, mediaSession.sessionToken)
        transportControls = mediaController.transportControls

        // Initialize PlayerNotificationManager with Media3 session
        initializeNotificationManager(notificationId, channelId, player)

        // Set callback for legacy session
        mediaSession.setCallback(MediaSessionCallback(service))

        Log.d(TAG, "Media3 MediaSession and legacy MediaSessionCompat initialized successfully")
        Log.d(TAG, "Media3 session is active: ${media3Session != null}")
        Log.d(TAG, "MediaSessionCompat is active: ${mediaSession.isActive}")
    }

    private fun initializeNotificationManager(
        notificationId: Int,
        channelId: String,
        player: Player
    ) {
        val builder = PlayerNotificationManager.Builder(context, notificationId, channelId)

        // CRITICAL FIX: Create custom notification listener that bridges MediaSession token
        val customNotificationListener = object : PlayerNotificationManager.NotificationListener {
            private val baseListener = PlayerNotificationListener(service)

            override fun onNotificationCancelled(notificationId: Int, dismissedByUser: Boolean) {
                baseListener.onNotificationCancelled(notificationId, dismissedByUser)
            }

            override fun onNotificationPosted(
                notificationId: Int,
                notification: android.app.Notification,
                ongoing: Boolean
            ) {
                // CRITICAL: Manually inject the MediaSession token into the notification
                // This bridges Media3 notifications with legacy MediaSessionCompat for Android Auto
                try {
                    // Access the notification's extras bundle
                    val extras = notification.extras

                    // Add the MediaSession token to the notification
                    // This is what Android Auto looks for to recognize media notifications
                    extras.putParcelable(
                        android.app.Notification.EXTRA_MEDIA_SESSION,
                        mediaSession.sessionToken
                    )

                    // Log success
                    Log.d(TAG, "✅ MediaSession token injected into notification")
                    Log.d(TAG, "✅ Token: ${mediaSession.sessionToken}")

                } catch (e: Exception) {
                    Log.e(TAG, "❌ Failed to inject MediaSession token: ${e.message}")
                }

                // Call the original listener
                baseListener.onNotificationPosted(notificationId, notification, ongoing)
            }
        }

        // Set our custom notification listener that bridges the session token
        builder.setNotificationListener(customNotificationListener)
        Log.d(TAG, "🔧 ✅ Custom NotificationListener with session token bridging created")

        // Create Media3 compatible MediaDescriptionAdapter to extract metadata from MediaItems
        val mediaDescriptionAdapter = object : PlayerNotificationManager.MediaDescriptionAdapter {
            override fun getCurrentContentTitle(player: Player): CharSequence {
                val metadata = player.currentMediaItem?.mediaMetadata
                val title = metadata?.title ?: metadata?.displayTitle ?: "Unknown Title"
                Log.d(TAG, "MediaDescriptionAdapter - getCurrentContentTitle: $title")
                return title
            }

            override fun createCurrentContentIntent(player: Player): PendingIntent? {
                // Create intent to open the app when notification is tapped
                val intent = Intent(context, MainActivity::class.java)
                intent.flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
                return PendingIntent.getActivity(
                    context,
                    0,
                    intent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
            }

            override fun getCurrentContentText(player: Player): CharSequence? {
                val metadata = player.currentMediaItem?.mediaMetadata
                val text = metadata?.artist ?: metadata?.albumArtist ?: metadata?.subtitle
                Log.d(TAG, "MediaDescriptionAdapter - getCurrentContentText: $text")
                return text
            }

            override fun getCurrentLargeIcon(
                player: Player,
                callback: PlayerNotificationManager.BitmapCallback
            ): Bitmap? {
                val metadata = player.currentMediaItem?.mediaMetadata
                val artworkUri = metadata?.artworkUri
                Log.d(TAG, "MediaDescriptionAdapter - getCurrentLargeIcon artworkUri: $artworkUri")

                // For now return null to use default icon
                // TODO: Implement async bitmap loading if needed
                return null
            }
        }

        builder.setMediaDescriptionAdapter(mediaDescriptionAdapter)

        // CRITICAL: Set the group key to force notification to always be shown
        builder.setGroup("AUDIOBOOKSHELF_PLAYBACK")

        // NOTE: MediaSession token is injected via custom NotificationListener above
        // This is the proper way to bridge Media3 notifications with legacy MediaSessionCompat

        // EXPERIMENTAL: Try to force ongoing notifications for all playback states
        // This might help with Media3's decision making about when to show notifications

        playerNotificationManager = builder.build()

        Log.d(TAG, "🔧 PlayerNotificationManager built successfully")

        // EXPERIMENTAL: Force immediate notification check on build
        Log.d(TAG, "🔧 Attempting immediate notification manager setup test...")
        try {
            // Force an immediate refresh to test the notification system
            playerNotificationManager.invalidate()
            Log.d(TAG, "🔧 Initial invalidation completed successfully")
        } catch (e: Exception) {
            Log.e(TAG, "🔧 Error during initial notification setup: ${e.message}")
            e.printStackTrace()
        }

        // Connect the player to the notification manager
        // The Media3 session will be automatically detected by the PlayerNotificationManager
        playerNotificationManager.setPlayer(player)
        Log.d(TAG, "Connected PlayerNotificationManager to player")

        // Force the notification to be visible immediately for debugging
        Log.d(TAG, "🔧 Setting PlayerNotificationManager visibility and priority")

        // Add player state listener to debug notification issues
        player.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(playbackState: Int) {
                val stateString = when (playbackState) {
                    Player.STATE_IDLE -> "IDLE"
                    Player.STATE_BUFFERING -> "BUFFERING"
                    Player.STATE_READY -> "READY"
                    Player.STATE_ENDED -> "ENDED"
                    else -> "UNKNOWN($playbackState)"
                }
                Log.d(TAG, "🔄 Player state changed: $stateString")
                Log.d(TAG, "🔄 Player isPlaying: ${player.isPlaying}")
                Log.d(TAG, "🔄 Current MediaItem: ${player.currentMediaItem?.mediaId}")
                Log.d(TAG, "🔄 Player now has ${player.mediaItemCount} media items")

                // Force invalidate notification when state changes
                Log.d(TAG, "🔧 Invalidating notification due to state change")
                playerNotificationManager.invalidate()

                // CRITICAL FIX: Re-set the player when we transition to READY with media
                if (playbackState == Player.STATE_READY && player.mediaItemCount > 0) {
                    Log.d(TAG, "🔥 CRITICAL: Player is READY with media - re-setting player to force notification manager refresh")
                    // This forces PlayerNotificationManager to re-evaluate whether to show notifications
                    playerNotificationManager.setPlayer(null)
                    playerNotificationManager.setPlayer(player)
                    Log.d(TAG, "🔥 PlayerNotificationManager player re-set completed")
                }

                // Log this info to help debug notification ongoing status
                if (playbackState == Player.STATE_READY && player.isPlaying) {
                    Log.d(TAG, "✅ Player is READY and PLAYING - notification should be ongoing=true")
                } else if (playbackState == Player.STATE_READY && !player.isPlaying) {
                    Log.d(TAG, "⏸️ Player is READY but PAUSED - notification should be ongoing=false")
                } else {
                    Log.d(TAG, "⏳ Player is not ready for playback - notification may be ongoing=false")
                }
            }

            override fun onIsPlayingChanged(isPlaying: Boolean) {
                Log.d(TAG, "🎵 Player isPlaying changed: $isPlaying")
                Log.d(TAG, "🎵 Player has ${player.mediaItemCount} media items")

                if (isPlaying) {
                    Log.d(TAG, "▶️ PLAYING - notification should now be ongoing=true")
                    Log.d(TAG, "🔧 Forcing notification invalidation for PLAYING state")
                    playerNotificationManager.invalidate()

                    // CRITICAL FIX: If we're playing but have media items, re-set player to trigger notifications
                    if (player.mediaItemCount > 0) {
                        Log.d(TAG, "🔥 CRITICAL: Playing with media - re-setting player to ensure notifications")
                        playerNotificationManager.setPlayer(null)
                        playerNotificationManager.setPlayer(player)
                        Log.d(TAG, "🔥 PlayerNotificationManager player re-set for playing state")
                    }

                    // EXPERIMENTAL: Try manually starting foreground service to trigger notification
                    Log.d(TAG, "🚀 EXPERIMENTAL: Attempting to force foreground service start")
                    try {
                        // Check if service is foreground by checking if PlayerNotificationService has the flag
                        Log.d(TAG, "🚀 Checking service foreground state...")
                        // Note: We'll let PlayerNotificationManager handle foreground service management
                        // but log our attempt to help debug
                    } catch (e: Exception) {
                        Log.e(TAG, "🚀 Error checking foreground state: ${e.message}")
                    }
                } else {
                    Log.d(TAG, "⏸️ PAUSED/STOPPED - notification should be ongoing=false")
                }
            }
        })

        playerNotificationManager.setUsePlayPauseActions(true)
        playerNotificationManager.setUseNextAction(true)
        playerNotificationManager.setUsePreviousAction(true)
        playerNotificationManager.setUseChronometer(true)
        playerNotificationManager.setUseStopAction(false)
        playerNotificationManager.setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
        playerNotificationManager.setPriority(NotificationCompat.PRIORITY_HIGH)
        playerNotificationManager.setUseFastForwardActionInCompactView(true)
        playerNotificationManager.setUseRewindActionInCompactView(true)
        playerNotificationManager.setSmallIcon(R.drawable.icon_monochrome)
        playerNotificationManager.setBadgeIconType(NotificationCompat.BADGE_ICON_NONE)
        // Disable colorization to prevent image quality degradation
        playerNotificationManager.setColorized(false)
        playerNotificationManager.setUseNextActionInCompactView(false)
        playerNotificationManager.setUsePreviousActionInCompactView(false)

        // CRITICAL: Force the PlayerNotificationManager to refresh and check for notifications
        Log.d(TAG, "🔧 Force invalidating PlayerNotificationManager to trigger notification posting")
        playerNotificationManager.invalidate()

        // EXPERIMENTAL: Try to force the notification to be considered "ongoing" by checking player state
        Log.d(TAG, "🔧 PlayerNotificationManager configuration completed")
        Log.d(TAG, "🔧 Player currently has ${player.mediaItemCount} media items")
        Log.d(TAG, "🔧 Player current state: ${player.playbackState}")
        Log.d(TAG, "🔧 Player isPlaying: ${player.isPlaying}")

        // If player already has content loaded, force a notification check
        if (player.mediaItemCount > 0) {
            Log.d(TAG, "🔧 Player has media loaded - forcing immediate notification check")
            Handler(Looper.getMainLooper()).post {
                playerNotificationManager.invalidate()
            }
        }
    }

    fun getSessionToken(): MediaSessionCompat.Token = mediaSession.sessionToken

    fun getMedia3SessionToken() = media3Session?.token

    fun setPlaybackActions(allowSeekingOnMediaControls: Boolean) {
        // For Media3, playback actions are handled automatically by the MediaSession
        // For legacy compatibility, update the MediaSessionCompat
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

        // Note: Media3 handles these actions automatically, but we keep the legacy session for Android Auto
        Log.d(TAG, "Playback actions configured - seeking allowed: $allowSeekingOnMediaControls")
    }

    fun setCustomActions(playbackSession: PlaybackSession, context: Context, service: PlayerNotificationService) {
        // Media3 custom actions are handled through MediaSession.Callback.onCustomAction()
        // We need to create the custom actions and add them to the playback state

        val customActions = mutableListOf<PlaybackStateCompat.CustomAction>()

        // Jump Backward Action
        val jumpBackwardAction = PlaybackStateCompat.CustomAction.Builder(
            PlayerNotificationService.CUSTOM_ACTION_JUMP_BACKWARD,
            context.getString(android.R.string.ok), // TODO: Add proper string resource
            android.R.drawable.ic_media_rew
        ).build()
        customActions.add(jumpBackwardAction)

        // Jump Forward Action
        val jumpForwardAction = PlaybackStateCompat.CustomAction.Builder(
            PlayerNotificationService.CUSTOM_ACTION_JUMP_FORWARD,
            context.getString(android.R.string.ok), // TODO: Add proper string resource
            android.R.drawable.ic_media_ff
        ).build()
        customActions.add(jumpForwardAction)

        // Skip Forward (for multi-chapter books)
        if (playbackSession.chapters.isNotEmpty()) {
            val skipForwardAction = PlaybackStateCompat.CustomAction.Builder(
                PlayerNotificationService.CUSTOM_ACTION_SKIP_FORWARD,
                "Next Chapter",
                android.R.drawable.ic_media_next
            ).build()
            customActions.add(skipForwardAction)

            // Skip Backward
            val skipBackwardAction = PlaybackStateCompat.CustomAction.Builder(
                PlayerNotificationService.CUSTOM_ACTION_SKIP_BACKWARD,
                "Previous Chapter",
                android.R.drawable.ic_media_previous
            ).build()
            customActions.add(skipBackwardAction)
        }

        // Playback Speed Action
        val speedAction = PlaybackStateCompat.CustomAction.Builder(
            PlayerNotificationService.CUSTOM_ACTION_CHANGE_PLAYBACK_SPEED,
            "Speed",
            android.R.drawable.ic_menu_manage
        ).build()
        customActions.add(speedAction)

        // Apply custom actions to the legacy MediaSession (for Android Auto compatibility)
        val controller = mediaSession.controller
        val currentState = controller?.playbackState

        // Define base playback actions
        val baseActions = PlaybackStateCompat.ACTION_PLAY_PAUSE or
            PlaybackStateCompat.ACTION_PLAY or
            PlaybackStateCompat.ACTION_PAUSE or
            PlaybackStateCompat.ACTION_FAST_FORWARD or
            PlaybackStateCompat.ACTION_REWIND or
            PlaybackStateCompat.ACTION_SKIP_TO_NEXT or
            PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or
            PlaybackStateCompat.ACTION_STOP

        val stateBuilder = PlaybackStateCompat.Builder()
            .setActions(currentState?.actions ?: baseActions)
            .setState(
                currentState?.state ?: PlaybackStateCompat.STATE_NONE,
                currentState?.position ?: PlaybackStateCompat.PLAYBACK_POSITION_UNKNOWN,
                currentState?.playbackSpeed ?: 1.0f
            )

        // Add custom actions to playback state
        customActions.forEach { action ->
            stateBuilder.addCustomAction(action)
        }

        mediaSession.setPlaybackState(stateBuilder.build())

        Log.d(TAG, "Custom actions set for Media3: ${customActions.size} actions added")
    }

    fun release() {
        media3Session?.release()
        if (::mediaSession.isInitialized) {
            mediaSession.release()
            Log.d(TAG, "Media3 MediaSession and legacy MediaSessionCompat released")
        }
    }
}
