package com.tomesonic.app.player

import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.PlaybackStateCompat
import android.util.Log
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.common.util.BitmapLoader
import androidx.media3.datasource.DataSourceBitmapLoader
import androidx.media3.session.CacheBitmapLoader
import androidx.media3.session.CommandButton
import androidx.media3.session.MediaLibraryService.MediaLibrarySession
import androidx.media3.session.MediaLibraryService.MediaLibrarySession.Callback
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionToken
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.FutureCallback
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.MoreExecutors
import com.tomesonic.app.R
import com.tomesonic.app.data.PlaybackSession
import java.util.concurrent.Callable
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

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

    private var bitmapLoaderExecutor: ExecutorService? = null

    fun initializeMediaSession(
        notificationId: Int,
        channelId: String,
        sessionActivityPendingIntent: PendingIntent?,
        player: Player
    ) {
        // Create Media3 MediaLibrarySession with a Glide-backed BitmapLoader.
        // This is the critical path for Wear OS artwork: the watch (or any
        // MediaController, including the system media controls) asks the session's
        // BitmapLoader to resolve MediaMetadata.artworkUri. Without a BitmapLoader
        // the controller has no way to fetch high-resolution artwork from a remote
        // server URI.
        //
        // We deliberately do NOT instantiate a PlayerNotificationManager here.
        // MediaLibraryService already publishes a proper MediaStyle foreground
        // notification through DefaultMediaNotificationProvider; that notification
        // links to this session, which is what the Wear OS notification bridge
        // (and Android system media controls) require to display artwork.
        // Running a second PlayerNotificationManager alongside causes the bridge
        // to pick up a notification without a session token attached, which is
        // why Wear OS was showing no artwork before.
        // Use Media3's recommended CacheBitmapLoader(DataSourceBitmapLoader) so
        // covers are fetched at native resolution (no forced downscale) and cached.
        // This gives the system notification, lock screen, and Wear OS card the
        // highest-quality artwork the server provides; Media3 itself handles any
        // size limiting needed for IPC to controllers.
        if (bitmapLoaderExecutor == null || bitmapLoaderExecutor?.isShutdown == true) {
            bitmapLoaderExecutor = Executors.newSingleThreadExecutor()
        }
        val listeningExecutor = MoreExecutors.listeningDecorator(bitmapLoaderExecutor!!)
        val dataSourceBitmapLoader = DataSourceBitmapLoader(
            listeningExecutor,
            androidx.media3.datasource.DefaultDataSource.Factory(context)
        )
        val sessionBitmapLoader: BitmapLoader = object : BitmapLoader {
            private val cache = CacheBitmapLoader(dataSourceBitmapLoader)

            override fun supportsMimeType(mimeType: String): Boolean = cache.supportsMimeType(mimeType)

            override fun decodeBitmap(data: ByteArray): ListenableFuture<Bitmap> {
                Log.d(TAG, "BitmapLoader: Decoding bitmap from bytes (${data.size} bytes)")
                return cache.decodeBitmap(data)
            }

            override fun loadBitmap(uri: Uri): ListenableFuture<Bitmap> {
                Log.d(TAG, "BitmapLoader: Loading bitmap from URI: $uri")
                val future = cache.loadBitmap(uri)
                Futures.addCallback(future, object : FutureCallback<Bitmap> {
                    override fun onSuccess(result: Bitmap?) {
                        Log.d(TAG, "BitmapLoader: Successfully loaded bitmap from URI: $uri (size: ${result?.width}x${result?.height})")
                    }
                    override fun onFailure(t: Throwable) {
                        Log.e(TAG, "BitmapLoader: Failed to load bitmap from URI: $uri", t)
                    }
                }, listeningExecutor)
                return future
            }
        }

        val sessionBuilder = MediaLibrarySession.Builder(context, player, callback)
        sessionBuilder.setBitmapLoader(sessionBitmapLoader)
        sessionActivityPendingIntent?.let { sessionBuilder.setSessionActivity(it) }

        // Enable custom commands and actions for Android Auto
        sessionBuilder.setCustomLayout(buildCustomMediaActions())

        // Set media button preferences for Android Auto compact player
        // This determines which buttons appear in the mini player widget
        // BACK slot (left of play) -> Jump backward
        // FORWARD slot (right of play) -> Jump forward
        sessionBuilder.setMediaButtonPreferences(buildMediaButtonPreferences())

        mediaSession = sessionBuilder.build()

        Log.d(TAG, "Media3 MediaLibrarySession initialized (notifications handled by MediaLibraryService)")
    }

    /**
     * Build media button preferences for Android Auto compact player.
     * This puts the seek back/forward buttons closest to the play button
     * instead of the default skip to previous/next track buttons.
     */
    private fun buildMediaButtonPreferences(): ImmutableList<CommandButton> {
        val buttons = ImmutableList.builder<CommandButton>()

        // Back slot (left of play button) - Jump backward by configured time
        buttons.add(
            CommandButton.Builder(CommandButton.ICON_SKIP_BACK)
                .setDisplayName("Jump Back")
                .setSessionCommand(SessionCommand(PlayerNotificationService.CUSTOM_ACTION_JUMP_BACKWARD, Bundle.EMPTY))
                .setSlots(CommandButton.SLOT_BACK)
                .build()
        )

        // Forward slot (right of play button) - Jump forward by configured time
        buttons.add(
            CommandButton.Builder(CommandButton.ICON_SKIP_FORWARD)
                .setDisplayName("Jump Forward")
                .setSessionCommand(SessionCommand(PlayerNotificationService.CUSTOM_ACTION_JUMP_FORWARD, Bundle.EMPTY))
                .setSlots(CommandButton.SLOT_FORWARD)
                .build()
        )

        return buttons.build()
    }

    private fun buildCustomMediaActions(): ImmutableList<androidx.media3.session.CommandButton> {
        return buildCustomMediaActionsWithSpeed(service.mediaManager.getSavedPlaybackRate())
    }

    private fun buildCustomMediaActionsWithSpeed(currentSpeed: Float): ImmutableList<androidx.media3.session.CommandButton> {
        val customActions = ImmutableList.builder<androidx.media3.session.CommandButton>()

        // Jump backward button (time skip) - closest to play on left side
        customActions.add(
            androidx.media3.session.CommandButton.Builder(androidx.media3.session.CommandButton.ICON_SKIP_BACK)
                .setDisplayName("Jump Back")
                .setSessionCommand(SessionCommand(PlayerNotificationService.CUSTOM_ACTION_JUMP_BACKWARD, Bundle.EMPTY))
                .build()
        )

        // Jump forward button (time skip) - closest to play on right side
        customActions.add(
            androidx.media3.session.CommandButton.Builder(androidx.media3.session.CommandButton.ICON_SKIP_FORWARD)
                .setDisplayName("Jump Forward")
                .setSessionCommand(SessionCommand(PlayerNotificationService.CUSTOM_ACTION_JUMP_FORWARD, Bundle.EMPTY))
                .build()
        )

        // Speed control button with speed-specific icon
        customActions.add(
            androidx.media3.session.CommandButton.Builder()
                .setIconResId(getSpeedIcon(currentSpeed))
                .setDisplayName("Speed")
                .setSessionCommand(SessionCommand(PlayerNotificationService.CUSTOM_ACTION_CHANGE_PLAYBACK_SPEED, Bundle.EMPTY))
                .build()
        )

        // Previous chapter button (after speed)
        customActions.add(
            androidx.media3.session.CommandButton.Builder(androidx.media3.session.CommandButton.ICON_PREVIOUS)
                .setDisplayName("Previous Chapter")
                .setSessionCommand(SessionCommand(PlayerNotificationService.CUSTOM_ACTION_SKIP_TO_PREVIOUS_CHAPTER, Bundle.EMPTY))
                .build()
        )

        // Next chapter button (after speed)
        customActions.add(
            androidx.media3.session.CommandButton.Builder(androidx.media3.session.CommandButton.ICON_NEXT)
                .setDisplayName("Next Chapter")
                .setSessionCommand(SessionCommand(PlayerNotificationService.CUSTOM_ACTION_SKIP_TO_NEXT_CHAPTER, Bundle.EMPTY))
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

    /**
     * Update MediaSession metadata with chapter-aware information
     * This makes Android Auto treat each chapter as a separate track with proper duration
     */
    fun updateChapterMetadata(chapterTitle: String, chapterDuration: Long, bookTitle: String, author: String?, artworkUri: Uri?, artworkData: ByteArray? = null) {
        Log.d(TAG, "Updating chapter metadata: chapter='$chapterTitle', duration=${chapterDuration}ms, artworkUri=$artworkUri, artworkData=${artworkData?.size ?: 0} bytes")

        mediaSession?.let { session ->
            // Use Media3 1.8.0+ recommended way to update metadata without replacing MediaItem
            val metadataBuilder = session.player.currentMediaItem?.mediaMetadata?.buildUpon()
                ?: MediaMetadata.Builder()

            metadataBuilder
                .setTitle(chapterTitle)
                .setDisplayTitle(chapterTitle)
                .setArtist("$bookTitle • $author")
                .setAlbumArtist("$bookTitle • $author")
                .setSubtitle("$bookTitle • $author")
                .setAlbumTitle(author)
                .setArtworkUri(artworkUri)
                .setArtworkData(artworkData, MediaMetadata.PICTURE_TYPE_FRONT_COVER)
                .setDurationMs(chapterDuration)
                .setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC)
                .setIsPlayable(true)

            // Update the session metadata directly
            val metadata = metadataBuilder.build()
            session.player.playlistMetadata = metadata
            Log.d(TAG, "MediaSession metadata updated directly via playlistMetadata")
        }
    }

    fun getSessionToken(): androidx.media3.session.SessionToken? =
        SessionToken(context, ComponentName(context, service::class.java))

    fun getCompatSessionToken(): androidx.media3.session.SessionToken? =
        // Return Media3 SessionToken
        SessionToken(context, ComponentName(context, service::class.java))

    /**
     * Updates the MediaSession with a new player without recreating the session
     */
    fun updatePlayer(newPlayer: Player) {
        Log.d(TAG, "updatePlayer: Switching to new player type: ${newPlayer.javaClass.simpleName}")

        // MediaLibraryService's built-in DefaultMediaNotificationProvider follows the
        // session's player automatically, so we don't need to wire the new player into
        // a separate notification manager here.
        Log.d(TAG, "updatePlayer: Player updated successfully")
    }

    fun release() {
        bitmapLoaderExecutor?.shutdownNow()
        bitmapLoaderExecutor = null

        mediaSession?.let { session: MediaLibrarySession ->
            session.release()
            Log.d(TAG, "Media3 MediaLibrarySession released")
        }

        mediaSession = null
    }
}
