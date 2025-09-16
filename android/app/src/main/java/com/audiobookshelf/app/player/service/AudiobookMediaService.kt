package com.audiobookshelf.app.player.service

import android.app.PendingIntent
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.util.Log
import com.audiobookshelf.app.BuildConfig
import androidx.media3.cast.CastPlayer
import androidx.media3.cast.SessionAvailabilityListener
import androidx.media3.common.*
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.*
import androidx.media3.ui.PlayerNotificationManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.graphics.Color
import android.os.Build
import androidx.core.app.NotificationCompat
import com.audiobookshelf.app.MainActivity
import com.audiobookshelf.app.R
import com.audiobookshelf.app.data.*
import com.audiobookshelf.app.device.DeviceManager
import com.audiobookshelf.app.managers.DbManager
import com.audiobookshelf.app.media.MediaManager
import com.audiobookshelf.app.player.builder.MediaItemBuilder
import com.audiobookshelf.app.player.cast.CastPlayerManager
import com.audiobookshelf.app.player.cast.PlayerSwitchListener
import com.audiobookshelf.app.player.repository.PlaybackRepository
import com.audiobookshelf.app.server.ApiHandler
import com.google.android.gms.cast.framework.CastContext
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import kotlinx.coroutines.*
import javax.inject.Inject

/**
 * Media3 MediaLibraryService that serves as the unified playback service for local, Android Auto, and Cast
 */
class AudiobookMediaService : MediaLibraryService(), PlayerSwitchListener {

    companion object {
        private const val TAG = "AudiobookMediaService"
        const val ROOT_ID = "root"
        const val LIBRARIES_ROOT = "libraries"
        const val RECENTLY_ROOT = "recently"
        const val DOWNLOADS_ROOT = "downloads"
        const val CONTINUE_ROOT = "continue"

        // Custom commands
        const val COMMAND_SEEK_TO_CHAPTER = "seek_to_chapter"
        const val COMMAND_SKIP_FORWARD = "skip_forward"
        const val COMMAND_SKIP_BACKWARD = "skip_backward"
        const val COMMAND_SET_PLAYBACK_SPEED = "set_playback_speed"
    }

    // Dependencies - initialized in initializeDependencies()
    private lateinit var playbackRepository: PlaybackRepository
    private lateinit var mediaItemBuilder: MediaItemBuilder
    lateinit var mediaManager: MediaManager
    private lateinit var apiHandler: ApiHandler
    private lateinit var castPlayerManager: CastPlayerManager

    private lateinit var player: Player
    private lateinit var mediaLibrarySession: MediaLibrarySession
    private lateinit var exoPlayer: ExoPlayer
    private lateinit var playerNotificationManager: PlayerNotificationManager

    private val serviceScope = CoroutineScope(Dispatchers.Main + SupervisorJob())

    private val notificationId = 1001
    private val channelId = "audiobookshelf_media3_channel"

    override fun onCreate() {
        super.onCreate()
        Log.i(TAG, "=== AudiobookMediaService.onCreate() ===")

        // Initialize components (in real app, this would be done via dependency injection)
        initializeDependencies()

        // Initialize CastPlayerManager with switch listener
        castPlayerManager.setPlayerSwitchListener(this)

        // Initialize ExoPlayer
        exoPlayer = ExoPlayer.Builder(this)
            .setAudioAttributes(AudioAttributes.Builder()
                .setContentType(C.AUDIO_CONTENT_TYPE_SPEECH)
                .setUsage(C.USAGE_MEDIA)
                .build(), true)
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_LOCAL)
            .build()

        // Start with local player
        player = exoPlayer

        // Setup playback repository
        playbackRepository.onPlayerChanged(player)

        // Create MediaLibrarySession with custom callback
        // Create MediaLibrarySession with Android Auto compatibility
        val sessionExtras = Bundle().apply {
            putBoolean("android.media.browse.CONTENT_STYLE_SUPPORTED", true)
            putBoolean("android.media.browse.SEARCH_SUPPORTED", true)
            putInt("androidx.media.MediaBrowserCompat.Extras.KEY_ROOT_CHILDREN_LIMIT", 50)
            putInt("androidx.media.MediaBrowserCompat.Extras.KEY_ROOT_CHILDREN_SUPPORTED_FLAGS", 1)
        }

        mediaLibrarySession = MediaLibrarySession.Builder(this, player, AudiobookMediaSessionCallback())
            .setId("AudiobookMediaSession")
            .setSessionActivity(createSessionActivityPendingIntent())
            .setExtras(sessionExtras)
            .build()

        // Setup notifications
        setupNotifications()
    }

    override fun onDestroy() {
        Log.d(TAG, "AudiobookMediaService onDestroy")
        playerNotificationManager.setPlayer(null)
        mediaLibrarySession.release()
        exoPlayer.release()
        castPlayerManager.release()
        playbackRepository.release()
        serviceScope.cancel()
        super.onDestroy()
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaLibrarySession? {
        return mediaLibrarySession
    }


    private fun createSessionActivityPendingIntent(): PendingIntent {
        val intent = Intent(this, MainActivity::class.java)
        return PendingIntent.getActivity(
            this, 0, intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
    }

    private fun initializeDependencies() {
        // Initialize components similar to PlayerNotificationService
        playbackRepository = PlaybackRepository()
        mediaItemBuilder = MediaItemBuilder()
        castPlayerManager = CastPlayerManager(this)

        // Initialize media manager and API handler like in PlayerNotificationService
        apiHandler = com.audiobookshelf.app.server.ApiHandler(this)
        mediaManager = com.audiobookshelf.app.media.MediaManager(apiHandler, this)
    }

    private fun setupNotifications() {
        Log.d(TAG, "Setting up Media3 notifications")

        // Create notification channel
        createNotificationChannel()

        // Create PlayerNotificationManager
        playerNotificationManager = PlayerNotificationManager.Builder(
            this,
            notificationId,
            channelId
        )
            .setMediaDescriptionAdapter(createMediaDescriptionAdapter())
            .setNotificationListener(createNotificationListener())
            .setSmallIconResourceId(R.drawable.icon_monochrome)
            .setChannelNameResourceId(com.audiobookshelf.app.R.string.app_name)
            .build()

        // Connect to player
        playerNotificationManager.setPlayer(player)
        playerNotificationManager.setPriority(NotificationCompat.PRIORITY_HIGH)
        playerNotificationManager.setUsePlayPauseActions(true)
        playerNotificationManager.setUseNextAction(true)
        playerNotificationManager.setUsePreviousAction(true)

        Log.d(TAG, "Media3 notifications setup completed")
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val notificationManager = getSystemService(NotificationManager::class.java)

            // Check if channel already exists
            val existingChannel = notificationManager.getNotificationChannel(channelId)
            if (existingChannel != null) {
                Log.d(TAG, "Notification channel already exists: $channelId with importance ${existingChannel.importance}")
                return
            }

            val channel = NotificationChannel(
                channelId,
                "Audiobookshelf Media Playback",
                NotificationManager.IMPORTANCE_DEFAULT  // Changed from LOW to DEFAULT for better visibility
            ).apply {
                description = "Controls for audiobook and podcast playback"
                setShowBadge(false)
                lightColor = Color.BLUE
                lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
                enableVibration(false) // Disable vibration for media notifications
                enableLights(false)
                setSound(null, null) // Silent notifications for media playback
            }

            notificationManager.createNotificationChannel(channel)
            Log.i(TAG, "*** NOTIFICATION CHANNEL CREATED: $channelId with IMPORTANCE_DEFAULT ***")

            // Verify channel creation
            val createdChannel = notificationManager.getNotificationChannel(channelId)
            if (createdChannel != null) {
                Log.d(TAG, "Channel verification: importance=${createdChannel.importance}, name=${createdChannel.name}")
            } else {
                Log.e(TAG, "Failed to create notification channel!")
            }
        } else {
            Log.d(TAG, "Pre-Oreo device - no notification channel needed")
        }
    }

    private fun createMediaDescriptionAdapter(): PlayerNotificationManager.MediaDescriptionAdapter {
        return object : PlayerNotificationManager.MediaDescriptionAdapter {
            override fun getCurrentContentTitle(player: Player): CharSequence {
                val title = player.currentMediaItem?.mediaMetadata?.title
                Log.d(TAG, "Notification title: $title")
                return title ?: "Audiobookshelf"
            }

            override fun createCurrentContentIntent(player: Player): PendingIntent? {
                val intent = Intent(this@AudiobookMediaService, MainActivity::class.java).apply {
                    flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
                }
                return PendingIntent.getActivity(
                    this@AudiobookMediaService,
                    0,
                    intent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
            }

            override fun getCurrentContentText(player: Player): CharSequence? {
                val artist = player.currentMediaItem?.mediaMetadata?.artist
                Log.d(TAG, "Notification artist/author: $artist")
                return artist ?: "Audio Playback"
            }

            override fun getCurrentLargeIcon(
                player: Player,
                callback: PlayerNotificationManager.BitmapCallback
            ): android.graphics.Bitmap? {
                // For now, return null - could implement artwork loading later
                return null
            }
        }
    }

    private fun createNotificationListener(): PlayerNotificationManager.NotificationListener {
        return object : PlayerNotificationManager.NotificationListener {
            override fun onNotificationCancelled(notificationId: Int, dismissedByUser: Boolean) {
                Log.d(TAG, "Notification cancelled: $notificationId, dismissed by user: $dismissedByUser")
                if (dismissedByUser) {
                    // Stop playback when user dismisses notification
                    player.stop()
                }
                stopSelf()
            }

            override fun onNotificationPosted(
                notificationId: Int,
                notification: android.app.Notification,
                ongoing: Boolean
            ) {
                Log.i(TAG, "*** NOTIFICATION POSTED: ID=$notificationId, ongoing=$ongoing ***")
                if (ongoing) {
                    Log.i(TAG, "Starting foreground service with notification")
                    startForeground(notificationId, notification)
                } else {
                    Log.d(TAG, "Non-ongoing notification posted")
                }
            }
        }
    }

    inner class AudiobookMediaSessionCallback : MediaLibrarySession.Callback {

        override fun onConnect(
            session: MediaSession,
            controller: MediaSession.ControllerInfo
        ): MediaSession.ConnectionResult {
            Log.i(TAG, "*** MEDIA SESSION CLIENT CONNECTED: ${controller.packageName} ***")
            Log.i(TAG, "*** Controller UID: ${controller.uid}, connectionHints: ${controller.connectionHints} ***")

            // Special handling for Android Auto
            if (controller.packageName == "com.google.android.projection.gearhead") {
                Log.i(TAG, "*** ANDROID AUTO CLIENT CONNECTED ***")

                // Force accept connection for Android Auto with full permissions
                val sessionCommands = MediaSession.ConnectionResult.DEFAULT_SESSION_COMMANDS.buildUpon()
                    .add(SessionCommand(COMMAND_SEEK_TO_CHAPTER, Bundle.EMPTY))
                    .add(SessionCommand(COMMAND_SKIP_FORWARD, Bundle.EMPTY))
                    .add(SessionCommand(COMMAND_SKIP_BACKWARD, Bundle.EMPTY))
                    .add(SessionCommand(COMMAND_SET_PLAYBACK_SPEED, Bundle.EMPTY))
                    .build()

                val playerCommands = MediaSession.ConnectionResult.DEFAULT_PLAYER_COMMANDS.buildUpon()
                    .addAll(Player.Commands.Builder()
                        .addAll(
                            Player.COMMAND_PLAY_PAUSE,
                            Player.COMMAND_PREPARE,
                            Player.COMMAND_STOP,
                            Player.COMMAND_SEEK_TO_DEFAULT_POSITION,
                            Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM,
                            Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM,
                            Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM,
                            Player.COMMAND_SEEK_TO_MEDIA_ITEM,
                            Player.COMMAND_SEEK_BACK,
                            Player.COMMAND_SEEK_FORWARD,
                            Player.COMMAND_SET_SPEED_AND_PITCH,
                            Player.COMMAND_SET_REPEAT_MODE,
                            Player.COMMAND_SET_SHUFFLE_MODE,
                            Player.COMMAND_SET_MEDIA_ITEM,
                            Player.COMMAND_CHANGE_MEDIA_ITEMS,
                            Player.COMMAND_GET_CURRENT_MEDIA_ITEM,
                            Player.COMMAND_GET_TIMELINE,
                            Player.COMMAND_GET_MEDIA_ITEMS_METADATA,
                            Player.COMMAND_SET_MEDIA_ITEMS_METADATA,
                            Player.COMMAND_GET_TRACKS,
                            Player.COMMAND_GET_AUDIO_ATTRIBUTES,
                            Player.COMMAND_GET_VOLUME,
                            Player.COMMAND_GET_DEVICE_VOLUME,
                            Player.COMMAND_SET_VOLUME,
                            Player.COMMAND_SET_DEVICE_VOLUME,
                            Player.COMMAND_ADJUST_DEVICE_VOLUME
                        )
                        .build())
                    .build()

                return MediaSession.ConnectionResult.AcceptedResultBuilder(session)
                    .setAvailableSessionCommands(sessionCommands)
                    .setAvailablePlayerCommands(playerCommands)
                    .build()
            }

            val sessionCommands = MediaSession.ConnectionResult.DEFAULT_SESSION_COMMANDS.buildUpon()
                .add(SessionCommand(COMMAND_SEEK_TO_CHAPTER, Bundle.EMPTY))
                .add(SessionCommand(COMMAND_SKIP_FORWARD, Bundle.EMPTY))
                .add(SessionCommand(COMMAND_SKIP_BACKWARD, Bundle.EMPTY))
                .add(SessionCommand(COMMAND_SET_PLAYBACK_SPEED, Bundle.EMPTY))
                .build()

            val result = MediaSession.ConnectionResult.AcceptedResultBuilder(session)
                .setAvailableSessionCommands(sessionCommands)
                .build()

            Log.d(TAG, "Returning connection result for ${controller.packageName}")
            return result
        }

        override fun onGetLibraryRoot(
            session: MediaLibrarySession,
            browser: MediaSession.ControllerInfo,
            params: LibraryParams?
        ): ListenableFuture<LibraryResult<MediaItem>> {
            Log.i(TAG, "*** onGetLibraryRoot called ***")
            Log.i(TAG, "*** Client: ${browser.packageName}, UID: ${browser.uid} ***")
            Log.i(TAG, "*** LibraryParams: $params ***")

            // Create Android Auto compatible root item
            val rootItem = MediaItem.Builder()
                .setMediaId(ROOT_ID)
                .setMediaMetadata(
                    MediaMetadata.Builder()
                        .setTitle("Audiobookshelf")
                        .setSubtitle("Your audiobook library")
                        .setIsPlayable(false)
                        .setIsBrowsable(true)
                        .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
                        .build()
                )
                .build()

            // Create LibraryParams with Android Auto compatibility
            val compatParams = LibraryParams.Builder().apply {
                // Add Android Auto specific parameters if not already present
                if (params?.extras?.containsKey("android.media.browse.CONTENT_STYLE_SUPPORTED") != true) {
                    setExtras(Bundle().apply {
                        putBoolean("android.media.browse.CONTENT_STYLE_SUPPORTED", true)
                        putBoolean("android.media.browse.SEARCH_SUPPORTED", true)
                        putInt("androidx.media.MediaBrowserCompat.Extras.KEY_ROOT_CHILDREN_LIMIT", 50)
                        putInt("androidx.media.MediaBrowserCompat.Extras.KEY_ROOT_CHILDREN_SUPPORTED_FLAGS", 1)
                        // Copy any existing extras
                        params?.extras?.let { extras ->
                            putAll(extras)
                        }
                    })
                } else {
                    params?.extras?.let { setExtras(it) }
                }
            }.build()

            val result = LibraryResult.ofItem(rootItem, compatParams)

            when (browser.packageName) {
                "com.google.android.projection.gearhead" -> {
                    Log.i(TAG, "*** ANDROID AUTO ROOT RESULT: ${result.resultCode} ***")
                }
                "com.android.systemui" -> {
                    Log.d(TAG, "System UI root result: ${result.resultCode}")
                }
                packageName -> {
                    Log.d(TAG, "Own app root result: ${result.resultCode}")
                }
                else -> {
                    Log.d(TAG, "Unknown client root result: ${result.resultCode}")
                }
            }

            return Futures.immediateFuture(result)
        }

        override fun onGetChildren(
            session: MediaLibrarySession,
            browser: MediaSession.ControllerInfo,
            parentId: String,
            page: Int,
            pageSize: Int,
            params: LibraryParams?
        ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> {
            Log.i(TAG, "*** onGetChildren called ***")
            Log.i(TAG, "*** Client: ${browser.packageName}, ParentId: $parentId ***")
            Log.i(TAG, "*** Page: $page, PageSize: $pageSize ***")

            // Special handling for Android Auto
            if (browser.packageName == "com.google.android.projection.gearhead") {
                Log.i(TAG, "*** ANDROID AUTO REQUESTING CHILDREN ***")
            }

            return serviceScope.future {
                try {
                    val result = when {
                        parentId == ROOT_ID -> buildRootMenu()
                        parentId == LIBRARIES_ROOT -> buildLibraryItems()
                        parentId == RECENTLY_ROOT -> buildRecentlyPlayedItems()
                        parentId == DOWNLOADS_ROOT -> buildDownloadedItems()
                        parentId == CONTINUE_ROOT -> buildContinueListeningItems()
                        parentId.startsWith("library_") -> buildLibraryContentItems(parentId)
                        parentId.startsWith("book_") -> buildChapterItems(parentId)
                        else -> {
                            Log.w(TAG, "Unknown parentId: $parentId")
                            LibraryResult.ofItemList(ImmutableList.of(), params)
                        }
                    }

                    Log.i(TAG, "*** onGetChildren returning ${result.value?.size ?: 0} items ***")
                    result
                } catch (e: Exception) {
                    Log.e(TAG, "Error in onGetChildren: ${e.message}", e)
                    LibraryResult.ofError(LibraryResult.RESULT_ERROR_UNKNOWN)
                }
            }
        }

        override fun onCustomCommand(
            session: MediaSession,
            controller: MediaSession.ControllerInfo,
            customCommand: SessionCommand,
            args: Bundle
        ): ListenableFuture<SessionResult> {
            Log.d(TAG, "Custom command received: ${customCommand.customAction}")

            return when (customCommand.customAction) {
                COMMAND_SEEK_TO_CHAPTER -> {
                    val chapterIndex = args.getInt("chapter_index", -1)
                    if (chapterIndex >= 0) {
                        playbackRepository.seekToChapter(chapterIndex)
                    }
                    Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
                }
                COMMAND_SKIP_FORWARD -> {
                    val seconds = args.getInt("seconds", 30)
                    skipForward(seconds)
                    Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
                }
                COMMAND_SKIP_BACKWARD -> {
                    val seconds = args.getInt("seconds", 30)
                    skipBackward(seconds)
                    Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
                }
                COMMAND_SET_PLAYBACK_SPEED -> {
                    val speed = args.getFloat("speed", 1.0f)
                    player.setPlaybackSpeed(speed)
                    Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
                }
                else -> super.onCustomCommand(session, controller, customCommand, args)
            }
        }

        override fun onPlaybackResumption(
            mediaSession: MediaSession,
            controller: MediaSession.ControllerInfo
        ): ListenableFuture<MediaSession.MediaItemsWithStartPosition> {
            Log.d(TAG, "onPlaybackResumption called")

            return serviceScope.future {
                try {
                    // Get last playback session from database
                    val lastSession = getLastPlaybackSession()
                    lastSession?.let {
                        MediaSession.MediaItemsWithStartPosition(
                            it.mediaItems,
                            it.startIndex,
                            it.startPositionMs
                        )
                    } ?: MediaSession.MediaItemsWithStartPosition(
                        ImmutableList.of(),
                        0,
                        C.TIME_UNSET
                    )
                } catch (e: Exception) {
                    Log.e(TAG, "Error in playback resumption: ${e.message}")
                    MediaSession.MediaItemsWithStartPosition(
                        ImmutableList.of(),
                        0,
                        C.TIME_UNSET
                    )
                }
            }
        }

        override fun onAddMediaItems(
            mediaSession: MediaSession,
            controller: MediaSession.ControllerInfo,
            mediaItems: MutableList<MediaItem>
        ): ListenableFuture<MutableList<MediaItem>> {
            Log.d(TAG, "onAddMediaItems called with ${mediaItems.size} items")

            return serviceScope.future {
                // Process and enhance MediaItems with metadata if needed
                val enhancedItems = mediaItems.map { mediaItem ->
                    enhanceMediaItem(mediaItem)
                }.toMutableList()

                enhancedItems
            }
        }
    }

    // PlayerSwitchListener implementation
    override fun onSwitchToCastPlayer(castPlayer: CastPlayer) {
        Log.d(TAG, "Switching to CastPlayer")
        switchToPlayer(castPlayer)
    }

    override fun onSwitchToLocalPlayer() {
        Log.d(TAG, "Switching to local ExoPlayer")
        switchToPlayer(exoPlayer)
    }

    private fun switchToPlayer(newPlayer: Player) {
        Log.d(TAG, "Switching player from ${player.javaClass.simpleName} to ${newPlayer.javaClass.simpleName}")

        val oldPlayer = player

        // Copy state to new player
        val playWhenReady = oldPlayer.playWhenReady
        val mediaItems = (0 until oldPlayer.mediaItemCount).map { oldPlayer.getMediaItemAt(it) }
        val currentIndex = oldPlayer.currentMediaItemIndex
        val position = oldPlayer.currentPosition

        // Prepare new player
        if (mediaItems.isNotEmpty()) {
            newPlayer.setMediaItems(mediaItems, currentIndex, position)
        }
        newPlayer.playWhenReady = playWhenReady

        // Switch players
        oldPlayer.stop()
        oldPlayer.clearMediaItems()
        player = newPlayer
        mediaLibrarySession.player = newPlayer

        // Update repository
        playbackRepository.onPlayerChanged(newPlayer)

        if (playWhenReady) {
            newPlayer.prepare()
            newPlayer.play()
        }
    }

    private suspend fun buildRootMenu(): LibraryResult<ImmutableList<MediaItem>> {
        val items = listOf(
            createFolderItem(CONTINUE_ROOT, "Continue Listening", "Resume your audiobooks"),
            createFolderItem(RECENTLY_ROOT, "Recently Added", "Latest additions to your library"),
            createFolderItem(LIBRARIES_ROOT, "Libraries", "Browse your libraries"),
            createFolderItem(DOWNLOADS_ROOT, "Downloads", "Offline audiobooks")
        )

        return LibraryResult.ofItemList(ImmutableList.copyOf(items), null)
    }

    private suspend fun buildLibraryItems(): LibraryResult<ImmutableList<MediaItem>> {
        Log.d(TAG, "Building library items")

        return try {
            val libraries = mediaManager.serverLibraries
            Log.d(TAG, "Found ${libraries.size} libraries")

            val items = libraries.map { library ->
                createFolderItem(
                    "library_${library.id}",
                    library.name ?: "Unknown Library",
                    "${library.stats?.totalItems ?: 0} items"
                )
            }

            LibraryResult.ofItemList(ImmutableList.copyOf(items), null)
        } catch (e: Exception) {
            Log.e(TAG, "Error building library items: ${e.message}")
            LibraryResult.ofItemList(ImmutableList.of(), null)
        }
    }

    private suspend fun buildRecentlyPlayedItems(): LibraryResult<ImmutableList<MediaItem>> {
        Log.d(TAG, "Building recently played items")

        return try {
            // Get recently played items from media manager
            // Note: Using available methods from MediaManager
            val items = mutableListOf<MediaItem>()

            // For now, return empty list - we'll implement when we integrate with MediaManager
            LibraryResult.ofItemList(ImmutableList.copyOf(items), null)
        } catch (e: Exception) {
            Log.e(TAG, "Error building recently played items: ${e.message}")
            LibraryResult.ofItemList(ImmutableList.of(), null)
        }
    }

    private suspend fun buildDownloadedItems(): LibraryResult<ImmutableList<MediaItem>> {
        Log.d(TAG, "Building downloaded items")

        return try {
            // Get local downloads from device manager
            val downloads = com.audiobookshelf.app.device.DeviceManager.dbManager.getLocalLibraryItems()
            Log.d(TAG, "Found ${downloads.size} downloaded items")

            val mediaItems = downloads.mapNotNull { localItem ->
                createPlayableItemFromLocalItem(localItem)
            }

            LibraryResult.ofItemList(ImmutableList.copyOf(mediaItems), null)
        } catch (e: Exception) {
            Log.e(TAG, "Error building downloaded items: ${e.message}")
            LibraryResult.ofItemList(ImmutableList.of(), null)
        }
    }

    private suspend fun buildContinueListeningItems(): LibraryResult<ImmutableList<MediaItem>> {
        Log.d(TAG, "Building continue listening items")

        return try {
            // Get items with progress from media manager
            val items = mutableListOf<MediaItem>()

            // For now, return empty list - we'll implement when we integrate with MediaManager
            LibraryResult.ofItemList(ImmutableList.copyOf(items), null)
        } catch (e: Exception) {
            Log.e(TAG, "Error building continue listening items: ${e.message}")
            LibraryResult.ofItemList(ImmutableList.of(), null)
        }
    }

    private suspend fun buildLibraryContentItems(parentId: String): LibraryResult<ImmutableList<MediaItem>> {
        val libraryId = parentId.removePrefix("library_")
        // Implementation would fetch library content
        return LibraryResult.ofItemList(ImmutableList.of(), null)
    }

    private suspend fun buildChapterItems(parentId: String): LibraryResult<ImmutableList<MediaItem>> {
        val bookId = parentId.removePrefix("book_")
        // Implementation would build chapter items using MediaItemBuilder
        return LibraryResult.ofItemList(ImmutableList.of(), null)
    }

    private fun createFolderItem(mediaId: String, title: String, subtitle: String? = null): MediaItem {
        return MediaItem.Builder()
            .setMediaId(mediaId)
            .setMediaMetadata(
                MediaMetadata.Builder()
                    .setTitle(title)
                    .setSubtitle(subtitle)
                    .setIsPlayable(false)
                    .setIsBrowsable(true)
                    .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
                    .build()
            )
            .build()
    }

    private suspend fun enhanceMediaItem(mediaItem: MediaItem): MediaItem {
        // Enhance MediaItem with additional metadata if needed
        return mediaItem
    }

    private suspend fun getLastPlaybackSession(): com.audiobookshelf.app.player.repository.LastPlaybackSession? {
        // Implementation would fetch from database
        return null
    }

    private fun createPlayableItemFromLibraryItem(libraryItem: LibraryItem): MediaItem? {
        return try {
            val media = libraryItem.media ?: return null
            val metadata = media.metadata ?: return null

            MediaItem.Builder()
                .setMediaId("item_${libraryItem.id}")
                .setMediaMetadata(
                    MediaMetadata.Builder()
                        .setTitle(metadata.title ?: "Unknown Title")
                        .setArtist(metadata.getAuthorDisplayName())
                        .setAlbumTitle(metadata.title)
                        .setIsPlayable(true)
                        .setIsBrowsable(shouldItemHaveChapters(libraryItem))
                        .setMediaType(
                            if (libraryItem.mediaType == "book")
                                MediaMetadata.MEDIA_TYPE_MUSIC
                            else
                                MediaMetadata.MEDIA_TYPE_MUSIC
                        )
                        .build()
                )
                .build()
        } catch (e: Exception) {
            Log.e(TAG, "Error creating MediaItem from LibraryItem: ${e.message}")
            null
        }
    }

    private fun createPlayableItemFromLocalItem(localItem: LocalLibraryItem): MediaItem? {
        return try {
            val media = localItem.media ?: return null
            val metadata = media.metadata ?: return null

            MediaItem.Builder()
                .setMediaId("local_${localItem.id}")
                .setMediaMetadata(
                    MediaMetadata.Builder()
                        .setTitle(metadata.title ?: "Unknown Title")
                        .setArtist(metadata.getAuthorDisplayName())
                        .setAlbumTitle(metadata.title)
                        .setIsPlayable(true)
                        .setIsBrowsable(shouldLocalItemHaveChapters(localItem))
                        .setMediaType(
                            if (localItem.mediaType == "book")
                                MediaMetadata.MEDIA_TYPE_MUSIC
                            else
                                MediaMetadata.MEDIA_TYPE_MUSIC
                        )
                        .build()
                )
                .build()
        } catch (e: Exception) {
            Log.e(TAG, "Error creating MediaItem from LocalLibraryItem: ${e.message}")
            null
        }
    }

    private fun shouldItemHaveChapters(libraryItem: LibraryItem): Boolean {
        return libraryItem.mediaType == "book" &&
               (libraryItem.media as? Book)?.chapters?.isNotEmpty() == true
    }

    private fun shouldLocalItemHaveChapters(localItem: LocalLibraryItem): Boolean {
        return localItem.mediaType == "book" &&
               (localItem.media as? Book)?.chapters?.isNotEmpty() == true
    }

    private fun skipForward(seconds: Int) {
        val newPosition = player.currentPosition + (seconds * 1000)
        val duration = player.duration

        if (duration != C.TIME_UNSET && newPosition >= duration) {
            // Would skip past end, go to next chapter/item instead
            player.seekToNextMediaItem()
        } else {
            player.seekTo(newPosition)
        }
    }

    private fun skipBackward(seconds: Int) {
        val newPosition = player.currentPosition - (seconds * 1000)

        if (newPosition < 0) {
            // Would skip before start, go to previous chapter/item
            player.seekToPreviousMediaItem()
        } else {
            player.seekTo(newPosition)
        }
    }

    // Helper method to build MediaItems from PlaybackSession
    private fun buildMediaItemsFromPlaybackSession(playbackSession: PlaybackSession): List<MediaItem> {
        Log.d(TAG, "Building MediaItems from playback session: ${playbackSession.displayTitle}")

        val libraryItem = playbackSession.libraryItem
        val localLibraryItem = playbackSession.localLibraryItem

        // Check if this is a local item (downloaded book/podcast)
        if (localLibraryItem != null) {
            Log.d(TAG, "Local library item found: type=${localLibraryItem.mediaType}, ID=${localLibraryItem.id}")
            return buildMediaItemsFromLocalPlaybackSession(playbackSession)
        }

        // Check if this is a server item
        if (libraryItem != null) {
            Log.d(TAG, "Server library item found: type=${libraryItem.mediaType}, ID=${libraryItem.id}")

            return try {
                val mediaItems = when (libraryItem.mediaType) {
                    "book" -> {
                        Log.d(TAG, "Building server book media items...")
                        mediaItemBuilder.buildBookMediaItems(libraryItem, playbackSession)
                    }
                    "podcast" -> {
                        Log.d(TAG, "Building server podcast media items...")
                        mediaItemBuilder.buildPodcastMediaItems(libraryItem, playbackSession)
                    }
                    else -> {
                        Log.w(TAG, "Unknown server media type: ${libraryItem.mediaType}")
                        emptyList()
                    }
                }

                Log.d(TAG, "Successfully built ${mediaItems.size} server media items")
                if (mediaItems.isEmpty()) {
                    Log.w(TAG, "No media items were built from server library item")
                } else {
                    Log.d(TAG, "First media item ID: ${mediaItems.first().mediaId}")
                }

                mediaItems
            } catch (e: Exception) {
                Log.e(TAG, "Failed to build server media items: ${e.message}", e)
                emptyList()
            }
        }

        // Neither local nor server library item found - attempt fallback creation
        Log.w(TAG, "No library item (local or server) found in playback session")

        // Fallback: if we have audioTracks, create MediaItems directly from them
        if (playbackSession.audioTracks.isNotEmpty()) {
            Log.w(TAG, "Attempting fallback media creation from ${playbackSession.audioTracks.size} audio tracks")
            return buildFallbackMediaItems(playbackSession)
        }

        Log.e(TAG, "No fallback possible - no audio tracks available")
        return emptyList()
    }

    // Helper method to build MediaItems from local PlaybackSession using audioTracks
    private fun buildMediaItemsFromLocalPlaybackSession(playbackSession: PlaybackSession): List<MediaItem> {
        Log.d(TAG, "Building MediaItems from local playback session with ${playbackSession.audioTracks.size} audio tracks")

        val mediaItems = mutableListOf<MediaItem>()

        try {
            for ((index, audioTrack) in playbackSession.audioTracks.withIndex()) {
                Log.d(TAG, "Building MediaItem for track $index: ${audioTrack.title ?: "Track ${index + 1}"}")
                Log.d(TAG, "Raw audioTrack.contentUrl: ${audioTrack.contentUrl}")

                // Validate and fix the URI for local files
                val validUri = validateAndFixLocalUri(audioTrack.contentUrl)
                if (validUri == null) {
                    Log.e(TAG, "Invalid URI for track $index: ${audioTrack.contentUrl}")
                    continue
                }

                Log.d(TAG, "Using validated URI: $validUri")

                val mediaItem = MediaItem.Builder()
                    .setMediaId("local_track_$index")
                    .setUri(validUri)
                    .setMediaMetadata(
                        MediaMetadata.Builder()
                            .setTitle(audioTrack.title ?: "Track ${index + 1}")
                            .setArtist(playbackSession.displayAuthor ?: "Unknown Author")
                            .setAlbumTitle(playbackSession.displayTitle ?: "Unknown Title")
                            .setIsPlayable(true)
                            .setIsBrowsable(false)
                            .setMediaType(MediaMetadata.MEDIA_TYPE_AUDIO_BOOK_CHAPTER)
                            .build()
                    )
                    .build()

                mediaItems.add(mediaItem)
                Log.d(TAG, "Created MediaItem: ID=${mediaItem.mediaId}, URI=$validUri")
            }

            Log.i(TAG, "Successfully built ${mediaItems.size} MediaItems from local audioTracks")
            return mediaItems

        } catch (e: Exception) {
            Log.e(TAG, "Failed to build MediaItems from local audioTracks: ${e.message}", e)
            return emptyList()
        }
    }

    // Helper method to build fallback MediaItems when library items are unavailable
    private fun buildFallbackMediaItems(playbackSession: PlaybackSession): List<MediaItem> {
        Log.w(TAG, "Building fallback MediaItems from ${playbackSession.audioTracks.size} audio tracks")

        val mediaItems = mutableListOf<MediaItem>()

        try {
            for ((index, audioTrack) in playbackSession.audioTracks.withIndex()) {
                Log.d(TAG, "Building fallback MediaItem for track $index: ${audioTrack.title ?: "Track ${index + 1}"}")

                val mediaItem = MediaItem.Builder()
                    .setMediaId("fallback_track_$index")
                    .setUri(audioTrack.contentUrl)
                    .setMediaMetadata(
                        MediaMetadata.Builder()
                            .setTitle(audioTrack.title ?: playbackSession.displayTitle ?: "Track ${index + 1}")
                            .setArtist(playbackSession.displayAuthor ?: "Unknown Author")
                            .setAlbumTitle(playbackSession.displayTitle ?: "Unknown Album")
                            .setTrackNumber(index + 1)
                            .setTotalTrackCount(playbackSession.audioTracks.size)
                            .setIsPlayable(true)
                            .setIsBrowsable(false)
                            .setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC)
                            .setExtras(Bundle().apply {
                                putString("playback_session_id", playbackSession.id)
                                putInt("track_index", index)
                                putString("fallback_source", "audio_tracks")
                                putLong("duration_ms", (audioTrack.duration * 1000).toLong())
                            })
                            .build()
                    )
                    .build()

                mediaItems.add(mediaItem)
                Log.d(TAG, "Built fallback MediaItem ${index + 1}/${playbackSession.audioTracks.size}")
            }

            Log.i(TAG, "Successfully built ${mediaItems.size} fallback media items")
            return mediaItems

        } catch (e: Exception) {
            Log.e(TAG, "Error building fallback media items: ${e.message}", e)
            return emptyList()
        }
    }

    // Helper method to validate and fix local file URIs
    private fun validateAndFixLocalUri(contentUrl: String): String? {
        Log.d(TAG, "Validating URI: $contentUrl")

        try {
            // Check if it's already a valid file URI
            if (contentUrl.startsWith("file://")) {
                val file = java.io.File(Uri.parse(contentUrl).path ?: "")
                if (file.exists()) {
                    Log.d(TAG, "Valid file URI: $contentUrl")
                    return contentUrl
                } else {
                    Log.w(TAG, "File URI points to non-existent file: ${file.absolutePath}")
                }
            }

            // Check if it's an absolute path
            if (contentUrl.startsWith("/")) {
                val file = java.io.File(contentUrl)
                if (file.exists()) {
                    val fileUri = "file://$contentUrl"
                    Log.d(TAG, "Converted absolute path to file URI: $fileUri")
                    return fileUri
                } else {
                    Log.w(TAG, "Absolute path doesn't exist: $contentUrl")
                }
            }

            // Check if it's a relative path that needs to be resolved
            // First, try to resolve relative to app's internal storage
            val internalDir = filesDir
            val internalFile = java.io.File(internalDir, contentUrl)
            if (internalFile.exists()) {
                val fileUri = "file://${internalFile.absolutePath}"
                Log.d(TAG, "Found file in internal storage: $fileUri")
                return fileUri
            }

            // Try to resolve relative to external storage
            val externalDir = getExternalFilesDir(null)
            if (externalDir != null) {
                val externalFile = java.io.File(externalDir, contentUrl)
                if (externalFile.exists()) {
                    val fileUri = "file://${externalFile.absolutePath}"
                    Log.d(TAG, "Found file in external storage: $fileUri")
                    return fileUri
                }
            }

            // If the path contains session ID patterns, try to find the actual audio files
            if (contentUrl.contains("/hls/") && contentUrl.contains(".m3u8")) {
                Log.w(TAG, "Detected HLS playlist path - looking for actual audio files")
                val sessionId = contentUrl.substringAfter("/hls/").substringBefore("/")

                // Try to find audio files in various locations
                val possibleDirs = listOf(
                    java.io.File(internalDir, "downloads"),
                    java.io.File(internalDir, "audiobooks"),
                    java.io.File(internalDir, sessionId),
                    java.io.File(externalDir, "downloads"),
                    java.io.File(externalDir, "audiobooks"),
                    java.io.File(externalDir, sessionId)
                ).filterNotNull()

                for (dir in possibleDirs) {
                    if (dir.exists()) {
                        val audioFiles = dir.listFiles { file ->
                            file.isFile && (file.name.endsWith(".mp3") ||
                                          file.name.endsWith(".m4a") ||
                                          file.name.endsWith(".aac") ||
                                          file.name.endsWith(".mp4"))
                        }
                        if (!audioFiles.isNullOrEmpty()) {
                            val firstAudioFile = audioFiles.first()
                            val fileUri = "file://${firstAudioFile.absolutePath}"
                            Log.i(TAG, "Found audio file instead of HLS: $fileUri")
                            return fileUri
                        }
                    }
                }
            }

            Log.e(TAG, "Could not resolve URI: $contentUrl")
            return null

        } catch (e: Exception) {
            Log.e(TAG, "Error validating URI: $contentUrl", e)
            return null
        }
    }

    // === Compatibility methods for AbsAudioPlayer ===

    // Binder for local service binding (like PlayerNotificationService)
    inner class LocalBinder : android.os.Binder() {
        fun getService(): AudiobookMediaService = this@AudiobookMediaService
    }

    private val binder = LocalBinder()

    override fun onBind(intent: Intent?): android.os.IBinder? {
        return if (intent?.action == "androidx.media3.session.MediaLibraryService" ||
                   intent?.action == "android.media.browse.MediaBrowserService") {
            super.onBind(intent)
        } else {
            binder
        }
    }

    // Current playback session
    var currentPlaybackSession: PlaybackSession? = null
        private set

    // Current player reference
    val currentPlayer: Player
        get() = player

    // Android Auto mode flag
    var isAndroidAuto: Boolean = false

    // Client event emitter interface (compatible with PlayerNotificationService)
    interface ClientEventEmitter {
        fun onPlaybackSession(playbackSession: PlaybackSession)
        fun onPlaybackClosed()
        fun onPlayingUpdate(isPlaying: Boolean)
        fun onMetadata(metadata: PlaybackMetadata)
        fun onSleepTimerEnded(currentPosition: Long)
        fun onSleepTimerSet(sleepTimeRemaining: Int, isAutoSleepTimer: Boolean)
        fun onLocalMediaProgressUpdate(localMediaProgress: LocalMediaProgress)
        fun onPlaybackFailed(errorMessage: String)
        fun onMediaPlayerChanged(mediaPlayer: String)
        fun onProgressSyncFailing()
        fun onProgressSyncSuccess()
        fun onNetworkMeteredChanged(isUnmetered: Boolean)
        fun onMediaItemHistoryUpdated(mediaItemHistory: MediaItemHistory)
        fun onPlaybackSpeedChanged(playbackSpeed: Float)
    }

    var clientEventEmitter: ClientEventEmitter? = null

    // Stub managers and utilities (to be properly implemented)
    val mediaProgressSyncer: MediaProgressSyncer by lazy { MediaProgressSyncer() }
    val sleepTimerManager: SleepTimerManager by lazy { SleepTimerManager() }

    // Playback control methods
    fun preparePlayer(playbackSession: PlaybackSession, playWhenReady: Boolean, playbackRate: Float) {
        Log.d(TAG, "preparePlayer: ${playbackSession.displayTitle}, playWhenReady=$playWhenReady, rate=${playbackRate}x")
        currentPlaybackSession = playbackSession

        // Build media items from playback session
        val mediaItems = buildMediaItemsFromPlaybackSession(playbackSession)

        if (mediaItems.isNotEmpty()) {
            Log.d(TAG, "Setting ${mediaItems.size} media items on player")
            player.setMediaItems(mediaItems)

            val seekPositionMs = (playbackSession.currentTime * 1000).toLong()
            Log.d(TAG, "Seeking to position: ${seekPositionMs}ms (${playbackSession.currentTime}s)")
            player.seekTo(0, seekPositionMs)

            player.playbackParameters = PlaybackParameters(playbackRate)
            player.playWhenReady = playWhenReady

            Log.d(TAG, "Calling player.prepare()")
            player.prepare()

            Log.d(TAG, "Player prepared successfully, emitting session event")
            // Emit session started event
            clientEventEmitter?.onPlaybackSession(playbackSession)

            // Log notification manager status
            Log.d(TAG, "PlayerNotificationManager connected: ${::playerNotificationManager.isInitialized}")
        } else {
            Log.e(TAG, "Cannot prepare player: no media items available")
        }
    }

    fun play() {
        Log.d(TAG, "play() called - Player state: ${player.playbackState}")
        Log.d(TAG, "Player has ${player.mediaItemCount} media items")

        // Handle case where play is called but player has no media items
        if (player.mediaItemCount == 0 && currentPlaybackSession != null) {
            Log.w(TAG, "Player has no media items but session exists! Preparing player first...")
            // Get the current playback speed from the session or use default
            val playbackSpeed = try {
                mediaManager.getSavedPlaybackRate()
            } catch (e: Exception) {
                Log.w(TAG, "Could not get saved playback rate, using 1.0f: ${e.message}")
                1.0f
            }

            // Prepare the player with the existing session and then play
            preparePlayer(currentPlaybackSession!!, true, playbackSpeed)
            Log.i(TAG, "Player prepared and set to play")
            return
        }

        Log.d(TAG, "Calling player.play()")
        player.play()
        clientEventEmitter?.onPlayingUpdate(true)
        Log.d(TAG, "Play command sent, isPlaying: ${player.isPlaying}")
    }

    fun pause() {
        player.pause()
        clientEventEmitter?.onPlayingUpdate(false)
    }

    fun playPause(): Boolean {
        return if (player.isPlaying) {
            pause()
            false
        } else {
            play()
            true
        }
    }

    fun seekPlayer(positionMs: Long) {
        player.seekTo(positionMs)
    }

    fun seekForward(amountMs: Long) {
        val newPosition = player.currentPosition + amountMs
        player.seekTo(newPosition)
    }

    fun seekBackward(amountMs: Long) {
        val newPosition = (player.currentPosition - amountMs).coerceAtLeast(0)
        player.seekTo(newPosition)
    }

    fun setPlaybackSpeed(speed: Float) {
        player.playbackParameters = PlaybackParameters(speed)
        clientEventEmitter?.onPlaybackSpeedChanged(speed)
    }

    fun closePlayback() {
        currentPlaybackSession = null
        player.stop()
        player.clearMediaItems()
        clientEventEmitter?.onPlaybackClosed()
    }

    fun getCurrentTimeSeconds(): Double {
        return player.currentPosition / 1000.0
    }

    fun getBufferedTimeSeconds(): Double {
        return player.bufferedPosition / 1000.0
    }

    fun skipToNext() {
        player.seekToNextMediaItem()
    }

    fun skipToPrevious() {
        player.seekToPreviousMediaItem()
    }

    fun navigateToChapter(chapterIndex: Int) {
        if (chapterIndex >= 0 && chapterIndex < player.mediaItemCount) {
            player.seekTo(chapterIndex, 0)
        }
    }

    fun getCurrentNavigationIndex(): Int {
        return player.currentMediaItemIndex
    }

    fun getNavigationItemCount(): Int {
        return player.mediaItemCount
    }

    fun getDeviceInfo(): com.audiobookshelf.app.data.DeviceInfo {
        val deviceId = Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID)
        return com.audiobookshelf.app.data.DeviceInfo(
            deviceId,
            android.os.Build.MANUFACTURER,
            android.os.Build.MODEL,
            android.os.Build.VERSION.SDK_INT,
            BuildConfig.VERSION_NAME
        )
    }

    fun getPlayItemRequestPayload(forceTranscode: Boolean): PlayItemRequestPayload {
        return PlayItemRequestPayload(
            mediaPlayer = "exoplayer",
            forceDirectPlay = false,
            forceTranscode = forceTranscode,
            deviceInfo = getDeviceInfo()
        )
    }

    fun forceAndroidAutoReload() {
        // Implementation for Android Auto reload if needed
        Log.d(TAG, "forceAndroidAutoReload called")
    }

    // Stub classes for compatibility
    class MediaProgressSyncer {
        var listeningTimerRunning: Boolean = false
        var currentPlaybackSession: PlaybackSession? = null

        fun stop(sync: Boolean = false, callback: (() -> Unit)? = null) {
            listeningTimerRunning = false
            callback?.invoke()
        }

        fun reset() {
            listeningTimerRunning = false
            currentPlaybackSession = null
        }

        fun forceSyncNow(force: Boolean, callback: (Boolean) -> Unit) {
            callback(true)
        }

        fun pause(callback: (Boolean) -> Unit) {
            callback(true)
        }
    }

    class SleepTimerManager {
        fun setManualSleepTimer(sessionId: String, time: Long, isChapterTime: Boolean): Boolean {
            return false // Stub implementation
        }

        fun getSleepTimerTime(): Long {
            return 0L
        }

        fun increaseSleepTime(time: Long) {
            // Stub implementation
        }

        fun decreaseSleepTime(time: Long) {
            // Stub implementation
        }

        fun cancelSleepTimer() {
            // Stub implementation
        }
    }


}

/**
 * Extension function to create a ListenableFuture from a suspend function
 */
private fun <T> CoroutineScope.future(block: suspend () -> T): ListenableFuture<T> {
    val future = androidx.concurrent.futures.ResolvableFuture.create<T>()
    launch {
        try {
            val result = block()
            future.set(result)
        } catch (e: Exception) {
            future.setException(e)
        }
    }
    return future
}
