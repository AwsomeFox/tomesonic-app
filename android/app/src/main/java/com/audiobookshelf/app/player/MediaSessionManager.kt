package com.audiobookshelf.app.player

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.os.Build
import android.os.Bundle
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
        
        val queueNavigator: TimelineQueueNavigator = createQueueNavigator()
        
        // Set up connector components
        service.setMediaSessionConnectorPlaybackActions()
        mediaSessionConnector.setQueueNavigator(queueNavigator)
        mediaSessionConnector.setPlaybackPreparer(MediaSessionPlaybackPreparer(service))
        
        // Set callback
        mediaSession.setCallback(MediaSessionCallback(service))
    }

    private fun createQueueNavigator(): TimelineQueueNavigator {
        return object : TimelineQueueNavigator(mediaSession) {
            override fun getSupportedQueueNavigatorActions(player: Player): Long {
                return PlaybackStateCompat.ACTION_PLAY_PAUSE or
                        PlaybackStateCompat.ACTION_PLAY or
                        PlaybackStateCompat.ACTION_PAUSE
            }

            override fun getMediaDescription(
                player: Player,
                windowIndex: Int
            ): MediaDescriptionCompat {
                val currentPlaybackSession = service.currentPlaybackSession
                if (currentPlaybackSession == null) {
                    Log.e(TAG, "Playback session is not set - returning blank MediaDescriptionCompat")
                    return MediaDescriptionCompat.Builder().build()
                }

                val coverUri = currentPlaybackSession.getCoverUri(context)

                var bitmap: Bitmap? = null
                // Local covers get bitmap
                // Note: In Android Auto for local cover images, setting the icon uri to a local path does not work (cover is blank)
                // so we create and set the bitmap here instead of AbMediaDescriptionAdapter
                if (currentPlaybackSession.localLibraryItem?.coverContentUrl != null) {
                    bitmap = if (Build.VERSION.SDK_INT < 28) {
                        MediaStore.Images.Media.getBitmap(context.contentResolver, coverUri)
                    } else {
                        val source: ImageDecoder.Source =
                            ImageDecoder.createSource(context.contentResolver, coverUri)
                        ImageDecoder.decodeBitmap(source)
                    }
                }

                // Fix for local images crashing on Android 11 for specific devices
                // https://stackoverflow.com/questions/64186578/android-11-mediastyle-notification-crash/64232958#64232958
                try {
                    context.grantUriPermission(
                        "com.android.systemui",
                        coverUri,
                        Intent.FLAG_GRANT_READ_URI_PERMISSION
                    )
                } catch (error: Exception) {
                    Log.e(TAG, "Grant uri permission error $error")
                }

                val extra = Bundle()
                extra.putString(
                    MediaMetadataCompat.METADATA_KEY_ARTIST,
                    currentPlaybackSession.displayAuthor
                )

                // Prefer MediaSession queue item title (chapter) if available
                val queue = mediaSession.controller.getQueue()
                val queueTitle: String? = try {
                    if (queue != null && windowIndex >= 0 && windowIndex < queue.size) 
                        queue[windowIndex].description.title.toString() 
                    else null
                } catch (e: Exception) { 
                    null 
                }

                // Fallback to per-track title if queue title isn't set
                val track: com.audiobookshelf.app.data.AudioTrack? = try {
                    if (windowIndex >= 0 && windowIndex < currentPlaybackSession.audioTracks.size) 
                        currentPlaybackSession.audioTracks[windowIndex] 
                    else null
                } catch (e: Exception) { 
                    null 
                }

                val titleToShow = queueTitle ?: track?.title ?: currentPlaybackSession.displayTitle
                val bookTitle = currentPlaybackSession.displayTitle

                // Include chapter title in extras so Now Playing and other clients can show it
                if (queueTitle != null) {
                    extra.putString("chapter_title", queueTitle)
                } else if (track?.title != null) {
                    extra.putString("chapter_title", track.title)
                }

                val mediaDescriptionBuilder = MediaDescriptionCompat.Builder()
                    .setExtras(extra)
                    .setTitle(titleToShow)
                    .setSubtitle(bookTitle)

                bitmap?.let { mediaDescriptionBuilder.setIconBitmap(it) }
                    ?: mediaDescriptionBuilder.setIconUri(coverUri)

                return mediaDescriptionBuilder.build()
            }
        }
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
        val mediaItems = playbackSession.getMediaItems(context)
        val customActionProviders = mutableListOf<CustomActionProvider>(
            JumpBackwardCustomActionProvider(service),
            JumpForwardCustomActionProvider(service),
            ChangePlaybackSpeedCustomActionProvider(service) // Will be pushed to far left
        )
        if (playbackSession.mediaPlayer != "cast-player" && mediaItems.size > 1) {
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
