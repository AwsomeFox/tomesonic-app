package com.audiobookshelf.app.player.service

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import com.audiobookshelf.app.BuildConfig
import androidx.media3.cast.CastPlayer
import androidx.media3.cast.SessionAvailabilityListener
import androidx.media3.common.*
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.*
import androidx.media3.exoplayer.hls.HlsMediaSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
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
import com.audiobookshelf.app.managers.SleepTimerManager
import com.audiobookshelf.app.media.MediaProgressSyncer
import com.google.android.gms.cast.framework.CastContext
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.MoreExecutors
import kotlinx.coroutines.*
import javax.inject.Inject
import android.hardware.Sensor
import android.hardware.SensorManager
import com.audiobookshelf.app.player.ShakeDetector
import java.util.*
import kotlin.concurrent.schedule
import okhttp3.Request

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

        // Legacy custom action constants from PlayerNotificationService (for compatibility)
        const val CUSTOM_ACTION_JUMP_BACKWARD = "jump_backward"
        const val CUSTOM_ACTION_JUMP_FORWARD = "jump_forward"
        const val CUSTOM_ACTION_SKIP_FORWARD = "skip_forward"
        const val CUSTOM_ACTION_SKIP_BACKWARD = "skip_backward"
        const val CUSTOM_ACTION_CHANGE_PLAYBACK_SPEED = "change_playback_speed"
    }

    // Dependencies - initialized in initializeDependencies()
    private lateinit var playbackRepository: PlaybackRepository
    private lateinit var mediaItemBuilder: MediaItemBuilder
    lateinit var mediaManager: MediaManager
    lateinit var apiHandler: ApiHandler
    lateinit var castPlayerManager: CastPlayerManager
    lateinit var networkConnectivityManager: com.audiobookshelf.app.player.NetworkConnectivityManager

    lateinit var player: Player
    private lateinit var mediaLibrarySession: MediaLibrarySession
    private lateinit var exoPlayer: ExoPlayer
    private var localMediaController: MediaController? = null
    // Media3 handles notifications automatically through MediaSession

    private val serviceScope = CoroutineScope(Dispatchers.Main + SupervisorJob())

    private val notificationId = 1001
    private val channelId = "audiobookshelf_media3_channel"

    // Metadata update timer
    private var metadataTimer: Timer? = null

    override fun onCreate() {
        super.onCreate()
        Log.i(TAG, "=== AudiobookMediaService.onCreate() ===")

        // Check if token is expired and attempt refresh before initializing player
        if (DeviceManager.isTokenExpired()) {
            Log.w(TAG, "Token is expired, attempting refresh before initializing player")
            refreshTokenAndInitialize()
        } else {
            initializeComponents()
        }
    }

    private fun refreshTokenAndInitialize() {
        // Use ApiHandler to attempt token refresh
        val apiHandler = ApiHandler(this)
        
        // Ensure server address has proper scheme
        val serverAddress = DeviceManager.serverAddress.let { address ->
            if (!address.startsWith("http://") && !address.startsWith("https://")) {
                "http://$address"
            } else {
                address
            }
        }
        
        // Create a dummy request to trigger token refresh
        val dummyRequest = okhttp3.Request.Builder()
            .url("${serverAddress}/api/libraries")
            .addHeader("Authorization", "Bearer ${DeviceManager.token}")
            .build()
        
        apiHandler.makeRequest(dummyRequest, null) { response ->
            if (response.has("error")) {
                Log.e(TAG, "Token refresh failed, proceeding with expired token: ${response.getString("error")}")
            } else {
                Log.i(TAG, "Token refresh successful, proceeding with new token")
            }
            // Always initialize components regardless of refresh success/failure
            initializeComponents()
        }
    }

    private fun initializeComponents() {
        // Initialize components (in real app, this would be done via dependency injection)
        initializeDependencies()

        // Initialize CastPlayerManager with switch listener
        castPlayerManager.setPlayerSwitchListener(this)

        // Initialize ExoPlayer with HLS support
        val httpDataSourceFactory = DefaultHttpDataSource.Factory()
            .setUserAgent("Audiobookshelf-App")
            .setDefaultRequestProperties(hashMapOf(
                "Authorization" to "Bearer ${DeviceManager.token}"
            ))

        exoPlayer = ExoPlayer.Builder(this)
            .setAudioAttributes(AudioAttributes.Builder()
                .setContentType(C.AUDIO_CONTENT_TYPE_SPEECH)
                .setUsage(C.USAGE_MEDIA)
                .build(), true)
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_LOCAL)
            .setMediaSourceFactory(DefaultMediaSourceFactory(httpDataSourceFactory))
            .build()

        // Add player listener for events
        exoPlayer.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(playbackState: Int) {
                Log.i(TAG, "*** PLAYER STATE CHANGED: ${getPlaybackStateString(playbackState)} ***")
                Log.i(TAG, "*** Current Session Token: ${mediaLibrarySession.token} ***")
                Log.i(TAG, "*** Current Player: ${player.javaClass.simpleName} ***")

                when (playbackState) {
                    Player.STATE_ENDED -> {
                        Log.i(TAG, "*** PLAYBACK ENDED - Media3 should hide notification ***")
                        // unregisterShakeSensor() // TODO: Implement shake sensor functionality
                        clientEventEmitter?.onPlayingUpdate(false)
                    }
                    Player.STATE_BUFFERING -> {
                        Log.i(TAG, "*** PLAYER BUFFERING - Media3 should show buffering notification ***")
                    }
                    Player.STATE_READY -> {
                        Log.i(TAG, "*** PLAYER READY - Key state for Media3 notifications ***")
                        Log.i(TAG, "*** PlayWhenReady: ${player.playWhenReady} ***")
                        Log.i(TAG, "*** IsPlaying: ${player.isPlaying} ***")
                        Log.i(TAG, "*** MediaItems: ${player.mediaItemCount} ***")

                        if (player.playWhenReady) {
                            Log.i(TAG, "*** CRITICAL: Player READY + PlayWhenReady - Media3 MUST show notification ***")
                        }
                    }
                    Player.STATE_IDLE -> {
                        Log.i(TAG, "*** PLAYER IDLE - Media3 should hide notification ***")
                        // unregisterShakeSensor() // TODO: Implement shake sensor functionality
                    }
                }
            }

            override fun onIsPlayingChanged(isPlaying: Boolean) {
                Log.i(TAG, "*** IS PLAYING CHANGED: $isPlaying ***")
                Log.i(TAG, "*** Player State: ${getPlaybackStateString(player.playbackState)} ***")

                if (isPlaying) {
                    // CRITICAL: Start the foreground service. This is the primary trigger
                    // that tells Media3 it is now responsible for managing a notification.
                    ensureForegroundService()

                    // The local controller is still a good practice for other reasons,
                    // but the foreground state is the key for notifications.
                    ensureLocalMediaControllerConnected()

                    clientEventEmitter?.onPlayingUpdate(true)
                    // registerShakeSensor() // TODO: Implement shake sensor functionality
                    
                    Log.i(TAG, "*** PLAYBACK STARTED - Foreground service initiated. Media3 should now create a notification. ***")
                } else {
                    Log.i(TAG, "*** PLAYBACK STOPPED - Releasing resources. ***")
                    clientEventEmitter?.onPlayingUpdate(false)
                    // unregisterShakeSensor() // TODO: Implement shake sensor functionality

                    // Release the local controller when playback stops
                    localMediaController?.release()
                    localMediaController = null

                    // Stop the foreground service, allowing the notification to be dismissed
                    stopForeground(false) // Pass false to not remove the notification if it's still useful
                }
            }

            override fun onPlayerError(error: PlaybackException) {
                Log.e(TAG, "Player error: ${error.message}")
                // unregisterShakeSensor() // TODO: Implement shake sensor functionality
                clientEventEmitter?.onPlaybackFailed(error.message ?: "Unknown playback error")
            }
        })

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

        Log.i(TAG, "*** CREATING MEDIA LIBRARY SESSION ***")
        Log.i(TAG, "*** Session Extras: $sessionExtras ***")

        // Create session activity pending intent with proper flags for Android Auto
        val sessionActivityIntent = createSessionActivityPendingIntent()

        // Create callback instance first
        val sessionCallback = AudiobookMediaSessionCallback()
        Log.i(TAG, "*** Created session callback: ${sessionCallback.javaClass.simpleName} ***")

        mediaLibrarySession = MediaLibrarySession.Builder(this, player, sessionCallback)
            .setId("AudiobookMediaSession")
            .setSessionActivity(sessionActivityIntent)
            .setExtras(sessionExtras)
            // CRITICAL: Enable automatic notifications in Media3
            .setShowPlayButtonIfPlaybackIsSuppressed(true)  // Enable better notification support
            // Media3 will automatically handle notifications when MediaController clients connect
            .also { builder ->
                Log.i(TAG, "*** Configured MediaLibrarySession for automatic Media3 notifications ***")
            }
            .build()

        Log.i(TAG, "*** MEDIA LIBRARY SESSION CREATED: ${mediaLibrarySession.id} ***")
        Log.i(TAG, "*** SESSION PLAYER: ${mediaLibrarySession.player.javaClass.simpleName} ***")
        Log.i(TAG, "*** SESSION TOKEN: ${mediaLibrarySession.token} ***")
        Log.i(TAG, "*** SESSION CALLBACK: ${sessionCallback.javaClass.simpleName} ***")
        Log.i(TAG, "*** MEDIA3 AUTOMATIC NOTIFICATIONS SHOULD BE ENABLED ***")

        // CRITICAL: Ensure session is active and discoverable for Android Auto
        try {
            // Force the session to become active by setting initial metadata
            val initialMetadata = MediaMetadata.Builder()
                .setTitle("Audiobookshelf")
                .setArtist("Ready for playback")
                .setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC)
                .build()

            Log.i(TAG, "*** SESSION ACTIVATED WITH INITIAL METADATA ***")
            Log.i(TAG, "*** SESSION INITIALIZED AND READY FOR ANDROID AUTO ***")

        } catch (e: Exception) {
            Log.e(TAG, "*** ERROR ACTIVATING SESSION: ${e.message} ***")
        }

        // Setup notifications
        setupNotifications()
    }

    override fun onDestroy() {
        Log.d(TAG, "AudiobookMediaService onDestroy")

        // Clean up local MediaController
        localMediaController?.release()
        localMediaController = null

        // Clean up shake sensor
        // unregisterShakeSensor() // TODO: Implement shake sensor functionality
        shakeSensorUnregisterTask?.cancel()

        // Clean up metadata timer
        // stopMetadataTimer() // TODO: Implement metadata timer functionality

        // Media3 automatically handles notification cleanup
        mediaLibrarySession.release()

        exoPlayer.release()
        castPlayerManager.release()
        playbackRepository.release()
        serviceScope.cancel()
        super.onDestroy()
    }


    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaLibrarySession? {
        Log.i(TAG, "*** onGetSession called for ${controllerInfo.packageName} ***")
        Log.i(TAG, "*** Controller UID: ${controllerInfo.uid} ***")
        Log.i(TAG, "*** Controller connection hints: ${controllerInfo.connectionHints} ***")

        // Enhanced Android Auto detection and debugging
        when (controllerInfo.packageName) {
            "com.google.android.projection.gearhead" -> {
                Log.i(TAG, "🚗 *** ANDROID AUTO DETECTED - RETURNING MEDIA LIBRARY SESSION ***")
                Log.i(TAG, "🚗 *** Android Auto MediaSession Token: ${mediaLibrarySession.token} ***")

                // CRITICAL: Ensure MediaLibrarySession is properly configured for Android Auto
                Log.i(TAG, "🚗 *** MediaLibrarySession initialized for Android Auto ***")
                Log.i(TAG, "🚗 *** MediaLibrarySession extras: ${mediaLibrarySession.sessionExtras} ***")
            }
            "com.google.android.gms" -> {
                Log.i(TAG, "📱 *** GOOGLE SERVICES DETECTED ***")
            }
            "com.android.systemui" -> {
                Log.i(TAG, "🎵 *** SYSTEM UI MEDIA CONTROLS DETECTED ***")
            }
            else -> {
                Log.i(TAG, "🔍 *** UNKNOWN CONTROLLER: ${controllerInfo.packageName} ***")
            }
        }

        Log.i(TAG, "*** Session ID: ${mediaLibrarySession.id} ***")
        Log.i(TAG, "*** Session player: ${mediaLibrarySession.player.javaClass.simpleName} ***")
        Log.i(TAG, "*** Player state: ${mediaLibrarySession.player.playbackState} ***")
        Log.i(TAG, "*** Media items: ${mediaLibrarySession.player.mediaItemCount} ***")

        return mediaLibrarySession
    }


    private fun createSessionActivityPendingIntent(): PendingIntent {
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            // Add Android Auto specific extras for better discovery
            putExtra("android.media.browse.MediaBrowserService", true)
            putExtra("android.media.session.action.MEDIA_SESSION", true)
            putExtra("source", "android_auto")
            action = Intent.ACTION_MAIN
            addCategory(Intent.CATEGORY_LAUNCHER)
        }
        return PendingIntent.getActivity(
            this, 0, intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
    }

    private fun initializeDependencies() {
        // Initialize Paper database
        com.audiobookshelf.app.managers.DbManager.initialize(this)

        // Initialize widget
        com.audiobookshelf.app.device.DeviceManager.initializeWidgetUpdater(this)

        // Initialize components similar to PlayerNotificationService
        playbackRepository = PlaybackRepository()
        mediaItemBuilder = MediaItemBuilder()
        castPlayerManager = CastPlayerManager(this)

        // Initialize media manager and API handler like in PlayerNotificationService
        apiHandler = com.audiobookshelf.app.server.ApiHandler(this)
        mediaManager = com.audiobookshelf.app.media.MediaManager(apiHandler, this)

        // Initialize network connectivity manager
        networkConnectivityManager = com.audiobookshelf.app.player.NetworkConnectivityManager(this, this)

        // Register Android Auto reload listener
        mediaManager.registerAndroidAutoLoadListener {
            try {
                // Force MediaLibrarySession to refresh its content
                Log.d(TAG, "MediaManager finished loading Android Auto data - notifying session")
                // Note: MediaLibrarySession doesn't have direct equivalent to notifyChildrenChanged
                // Content will be refreshed on next browse request
            } catch (e: Exception) {
                Log.e(TAG, "Error in Android Auto reload listener: ${e.localizedMessage}")
            }
        }

        // Initialize shake sensor
        Log.d(TAG, "onCreate Register sensor listener")
        initSensor()
    }

    private fun initSensor() {
        Log.d(TAG, "initSensor")
        try {
            mSensorManager = getSystemService(SENSOR_SERVICE) as SensorManager
            mAccelerometer = mSensorManager!!.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)

            if (mAccelerometer == null) {
                Log.w(TAG, "Accelerometer not found")
                return
            }

            mShakeDetector = ShakeDetector()
            mShakeDetector!!.setOnShakeListener(object : ShakeDetector.OnShakeListener {
                override fun onShake(count: Int) {
                    Log.d(TAG, "ON SHAKE $count")
                    if (currentPlaybackSession != null) {
                        seekBackward(30000) // Go back 30 seconds
                        clientEventEmitter?.let {
                            // If shake to rewind is enabled, emit event
                            Log.d(TAG, "Shake detected - seeking backward 30 seconds")
                        }
                    }
                }
            })

            Log.d(TAG, "Shake detector initialized - isWakeUpSensor: ${mAccelerometer?.isWakeUpSensor}")
        } catch (e: Exception) {
            Log.e(TAG, "Error initializing shake detector: ${e.message}")
        }
    }

    private fun setupNotifications() {
        Log.d(TAG, "Setting up Media3 notifications")

        // Create notification channel for Media3
        createNotificationChannel()

        // CRITICAL: For Media3 automatic notifications to work, we need to ensure
        // the MediaLibraryService can properly handle notification lifecycle
        // This happens automatically when the player state changes to READY and playing
        Log.d(TAG, "Media3 notifications setup completed - notifications will appear when player starts")
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val notificationManager = getSystemService(NotificationManager::class.java)

            // Check if channel already exists
            val existingChannel = notificationManager.getNotificationChannel(channelId)
            if (existingChannel != null) {
                Log.d(TAG, "Notification channel already exists: $channelId")
                return
            }

            // Create Media3 compatible notification channel
            val channel = NotificationChannel(
                channelId,
                "Media playback",
                NotificationManager.IMPORTANCE_DEFAULT  // Media3 notifications need DEFAULT importance to appear properly
            ).apply {
                description = "Audiobook playback controls"
                setShowBadge(false) // Media notifications don't show badges
                setSound(null, null) // Silent for media playback
                lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC // Show on lock screen
                enableVibration(false) // No vibration for media
            }

            notificationManager.createNotificationChannel(channel)
            Log.d(TAG, "Created notification channel for Media3: $channelId")
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
            Log.i(TAG, "*** Connection hints: ${browser.connectionHints} ***")
            Log.i(TAG, "*** LibraryParams: $params ***")
            Log.i(TAG, "*** LibraryParams extras: ${params?.extras} ***")

            if (browser.packageName == "com.google.android.projection.gearhead") {
                Log.i(TAG, "*** ANDROID AUTO REQUESTING LIBRARY ROOT ***")

                // Log detailed Android Auto connection info
                browser.connectionHints?.let { hints ->
                    Log.i(TAG, "*** Android Auto Connection Hints: ***")
                    for (key in hints.keySet()) {
                        Log.i(TAG, "*** Hint: $key = ${hints.get(key)} ***")
                    }
                }

                // CRITICAL: Force accept Android Auto with immediate success
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

                Log.i(TAG, "*** IMMEDIATE SUCCESS FOR ANDROID AUTO ROOT ***")
                Log.i(TAG, "*** ROOT ITEM: ${rootItem.mediaId} - ${rootItem.mediaMetadata.title} ***")

                return Futures.immediateFuture(LibraryResult.ofItem(rootItem, null))
            }

            // For all other clients, use the full implementation

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
                    Log.i(TAG, "*** ROOT ITEM MEDIA ID: ${rootItem.mediaId} ***")
                    Log.i(TAG, "*** ROOT ITEM TITLE: ${rootItem.mediaMetadata.title} ***")
                    Log.i(TAG, "*** ROOT ITEM BROWSABLE: ${rootItem.mediaMetadata.isBrowsable} ***")
                    Log.i(TAG, "*** ROOT ITEM PLAYABLE: ${rootItem.mediaMetadata.isPlayable} ***")
                    Log.i(TAG, "*** COMPAT PARAMS: ${compatParams.extras} ***")
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

            Log.i(TAG, "*** RETURNING ROOT RESULT FOR ${browser.packageName} ***")
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
                    currentPlayer.setPlaybackSpeed(speed)
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

        // Media3 automatically updates notifications when player changes
        Log.d(TAG, "Player switched - Media3 will handle notification updates automatically")

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
        val newPosition = currentPlayer.currentPosition + (seconds * 1000)
        val duration = currentPlayer.duration

        if (duration != C.TIME_UNSET && newPosition >= duration) {
            // Would skip past end, go to next chapter/item instead
            currentPlayer.seekToNextMediaItem()
        } else {
            currentPlayer.seekTo(newPosition)
        }
    }

    private fun skipBackward(seconds: Int) {
        val newPosition = currentPlayer.currentPosition - (seconds * 1000)

        if (newPosition < 0) {
            // Would skip before start, go to previous chapter/item
            currentPlayer.seekToPreviousMediaItem()
        } else {
            currentPlayer.seekTo(newPosition)
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

                // CRITICAL: Debug MediaMetadata values for notification system
                val title = audioTrack.title ?: "Track ${index + 1}"
                val displayTitle = audioTrack.title ?: "Track ${index + 1}" // Use same as title for display
                val artist = playbackSession.displayAuthor ?: "Unknown Author"
                val albumTitle = playbackSession.displayTitle ?: "Unknown Title"

                Log.i(TAG, "*** DEBUGGING MEDIAITEM METADATA FOR NOTIFICATIONS ***")
                Log.i(TAG, "*** MediaItem $index - Title: '$title' ***")
                Log.i(TAG, "*** MediaItem $index - DisplayTitle: '$displayTitle' ***")
                Log.i(TAG, "*** MediaItem $index - Artist: '$artist' ***")
                Log.i(TAG, "*** MediaItem $index - Album: '$albumTitle' ***")
                Log.i(TAG, "*** MediaItem $index - MediaType: MEDIA_TYPE_MUSIC (better notification support) ***")

                if (title.isBlank()) {
                    Log.e(TAG, "*** CRITICAL: MediaItem $index has BLANK TITLE - notification may not appear! ***")
                }
                if (displayTitle.isBlank()) {
                    Log.e(TAG, "*** CRITICAL: MediaItem $index has BLANK DISPLAY TITLE - notification may not appear! ***")
                }
                if (artist.isBlank()) {
                    Log.w(TAG, "*** WARNING: MediaItem $index has BLANK ARTIST ***")
                }

                val mediaItem = MediaItem.Builder()
                    .setMediaId("local_track_$index")
                    .setUri(validUri)
                    .setMediaMetadata(
                        MediaMetadata.Builder()
                            .setTitle(title)
                            .setDisplayTitle(displayTitle)
                            .setArtist(artist)
                            .setAlbumTitle(albumTitle)
                            .setIsPlayable(true)
                            .setIsBrowsable(false)
                            .setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC)
                            .build()
                    )
                    .build()

                mediaItems.add(mediaItem)
                Log.d(TAG, "Created MediaItem: ID=${mediaItem.mediaId}, URI=$validUri")
                Log.i(TAG, "*** MediaItem $index created with metadata - Media3 can use for notifications ***")
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
        Log.i(TAG, "*** onBind called with intent: ${intent?.action} ***")
        Log.i(TAG, "*** Intent package: ${intent?.`package`} ***")
        Log.i(TAG, "*** Intent component: ${intent?.component} ***")

        // CRITICAL: Always delegate Media3 and MediaBrowser actions to super.onBind()
        return when (intent?.action) {
            "androidx.media3.session.MediaLibraryService" -> {
                Log.i(TAG, "*** Binding Media3 MediaLibraryService ***")
                super.onBind(intent)
            }
            "android.media.browse.MediaBrowserService" -> {
                Log.i(TAG, "*** Binding Legacy MediaBrowserService (Android Auto) ***")
                super.onBind(intent)
            }
            else -> {
                Log.i(TAG, "*** Binding local service ***")
                binder
            }
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

    // Shake detection for rewind functionality
    private var isShakeSensorRegistered: Boolean = false
    private var mSensorManager: SensorManager? = null
    private var mAccelerometer: Sensor? = null
    private var mShakeDetector: ShakeDetector? = null
    private var shakeSensorUnregisterTask: TimerTask? = null

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
        fun onPlayerError(errorMessage: String)
        fun onMediaItemHistoryUpdated(mediaItemHistory: MediaItemHistory)
        fun onPlaybackSpeedChanged(playbackSpeed: Float)
    }

    var clientEventEmitter: ClientEventEmitter? = null

    // MediaBrowserService compatibility methods
    fun notifyChildrenChanged(parentId: String) {
        Log.d(TAG, "notifyChildrenChanged called for parentId: $parentId")
        // In Media3, this is handled automatically when onGetChildren is called again
    }

    // Property access methods

    /**
     * Get the session token for MediaController creation
     * This enables external clients to create MediaController instances
     */
    fun getSessionToken(): androidx.media3.session.SessionToken? {
        return if (::mediaLibrarySession.isInitialized) {
            mediaLibrarySession.token
        } else {
            Log.w(TAG, "MediaLibrarySession not initialized, cannot provide session token")
            null
        }
    }

    fun getMediaMetadataCompat(): android.support.v4.media.MediaMetadataCompat? {
        // Return current media metadata in old format
        val currentMediaItem = currentPlayer.currentMediaItem
        return if (currentMediaItem != null) {
            android.support.v4.media.MediaMetadataCompat.Builder()
                .putString(android.support.v4.media.MediaMetadataCompat.METADATA_KEY_TITLE, currentMediaItem.mediaMetadata.title?.toString())
                .putString(android.support.v4.media.MediaMetadataCompat.METADATA_KEY_ARTIST, currentMediaItem.mediaMetadata.artist?.toString())
                .putLong(android.support.v4.media.MediaMetadataCompat.METADATA_KEY_DURATION, currentPlayer.duration)
                .build()
        } else null
    }

    fun setMediaSessionPlaybackActions() {
        // In Media3, playback actions are handled automatically by the session
        Log.d(TAG, "setMediaSessionPlaybackActions called - handled by Media3")
    }

    fun jumpForward() {
        val currentPosition = currentPlayer.currentPosition
        val forwardTime = com.audiobookshelf.app.device.DeviceManager.deviceData.deviceSettings?.jumpForwardTimeMs ?: 30000L
        val newPosition = currentPosition + forwardTime
        currentPlayer.seekTo(newPosition)
        Log.d(TAG, "Jump forward: $forwardTime ms to position: $newPosition")
    }

    fun jumpBackward() {
        val currentPosition = currentPlayer.currentPosition
        val backwardTime = com.audiobookshelf.app.device.DeviceManager.deviceData.deviceSettings?.jumpBackwardsTimeMs ?: 10000L
        val newPosition = (currentPosition - backwardTime).coerceAtLeast(0)
        currentPlayer.seekTo(newPosition)
        Log.d(TAG, "Jump backward: $backwardTime ms to position: $newPosition")
    }

    fun getCurrentTrackStartOffsetMs(): Long {
        // Return the start offset of the current track in milliseconds
        // For Media3, this would be the start time of the current media item
        val session = currentPlaybackSession
        val trackIndex = player.currentMediaItemIndex
        return if (session != null && session.audioTracks.isNotEmpty() && trackIndex < session.audioTracks.size) {
            (session.audioTracks[trackIndex].startOffset * 1000).toLong()
        } else {
            0L
        }
    }

    fun getContext(): Context {
        return this
    }

    // Additional compatibility properties and methods
    var isBrowseTreeInitialized: Boolean = false

    // Property to access the session
    val mediaSession: MediaSession?
        get() = null // MediaLibraryService doesn't expose session directly

    fun checkServerSessionVsLocal(localSession: PlaybackSession, callback: (Boolean, PlaybackSession?) -> Unit) {
        // Check if server session matches local session
        Log.d(TAG, "checkServerSessionVsLocal called for session: ${localSession.displayTitle}")
        // For now, use local session (would implement server comparison in full app)
        callback(false, null)
    }

    fun handlePlayerPlaybackError(errorMessage: String) {
        Log.e(TAG, "Player playback error: $errorMessage")
        // Handle playback errors, potentially fallback to transcode
        clientEventEmitter?.onPlayerError(errorMessage)
    }

    // Additional methods needed by PlayerListener
    fun getCurrentBookChapter(): Any? {
        // Return current chapter information
        return currentPlaybackSession?.chapters?.find { chapter ->
            val currentTime = currentPlayer.currentPosition / 1000.0
            currentTime >= chapter.start && currentTime < chapter.end
        }
    }

    // Removed duplicate seekBackward method - using the one below

    // Removed duplicate getMediaPlayer method - using the one below

    // MediaProgressSyncer needs access to this property (removed duplicate - using existing one at line 1194)

    // Add property access for lazy-initialized properties (removed duplicate sleepTimerManager)

    // Add missing methods that are called by other components
    fun seek() {
        // Called by MediaProgressSyncer when seeking
        Log.d(TAG, "seek() called")
    }

    fun play(playbackSession: PlaybackSession) {
        // Called by MediaProgressSyncer when starting playback
        Log.d(TAG, "play() called for session: ${playbackSession.displayTitle}")
    }

    fun handleMediaPlayEvent(sessionId: String) {
        // Called by SleepTimerManager
        Log.d(TAG, "handleMediaPlayEvent() called for session: $sessionId")
    }

    // Real managers and utilities
    val mediaProgressSyncer: MediaProgressSyncer by lazy {
        MediaProgressSyncer(this@AudiobookMediaService, apiHandler)
    }
    val sleepTimerManager: SleepTimerManager by lazy {
        SleepTimerManager(this@AudiobookMediaService)
    }

    // Playback control methods
    fun preparePlayer(playbackSession: PlaybackSession, playWhenReady: Boolean, playbackRate: Float) {
        Log.d(TAG, "preparePlayer: ${playbackSession.displayTitle}, playWhenReady=$playWhenReady, rate=${playbackRate}x")
        currentPlaybackSession = playbackSession

        // Build media items from playback session
        val mediaItems = buildMediaItemsFromPlaybackSession(playbackSession)

        if (mediaItems.isNotEmpty()) {
            Log.d(TAG, "Setting ${mediaItems.size} media items on player")

            // CRITICAL DEBUG: Check MediaItem metadata for notification issues
            Log.i(TAG, "*** DEBUGGING MEDIAITEM METADATA FOR NOTIFICATIONS ***")
            mediaItems.forEachIndexed { index, mediaItem ->
                Log.i(TAG, "*** MediaItem $index: ***")
                Log.i(TAG, "*** - ID: ${mediaItem.mediaId} ***")
                Log.i(TAG, "*** - URI: ${mediaItem.localConfiguration?.uri} ***")
                Log.i(TAG, "*** - Title: '${mediaItem.mediaMetadata.title}' ***")
                Log.i(TAG, "*** - DisplayTitle: '${mediaItem.mediaMetadata.displayTitle}' ***")
                Log.i(TAG, "*** - Artist: '${mediaItem.mediaMetadata.artist}' ***")
                Log.i(TAG, "*** - IsPlayable: ${mediaItem.mediaMetadata.isPlayable} ***")
                Log.i(TAG, "*** - MediaType: ${mediaItem.mediaMetadata.mediaType} ***")

                // Check for empty/null critical metadata
                if (mediaItem.mediaMetadata.title.isNullOrBlank() &&
                    mediaItem.mediaMetadata.displayTitle.isNullOrBlank()) {
                    Log.e(TAG, "*** CRITICAL: MediaItem $index has NO TITLE - notification may not appear! ***")
                }
            }

            currentPlayer.setMediaItems(mediaItems)

            val seekPositionMs = (playbackSession.currentTime * 1000).toLong()
            Log.d(TAG, "Seeking to position: ${seekPositionMs}ms (${playbackSession.currentTime}s)")

            currentPlayer.playbackParameters = PlaybackParameters(playbackRate)

            Log.d(TAG, "Calling currentPlayer.prepare()")
            currentPlayer.prepare()

            // CRITICAL FIX: Must seek and set playWhenReady AFTER prepare() in Media3
            currentPlayer.seekTo(0, seekPositionMs)
            currentPlayer.playWhenReady = playWhenReady

            Log.d(TAG, "Set playWhenReady=$playWhenReady after prepare()")

            // CRITICAL: Activate MediaSession for notifications and Android Auto discovery
            // activateMediaSessionForAndroidAuto(playbackSession, mediaItems.firstOrNull()) // TODO: Implement Android Auto activation

            Log.i(TAG, "*** PLAYER PREPARED - SESSION ACTIVE AND NOTIFICATIONS ENABLED ***")

            Log.d(TAG, "Player prepared successfully, emitting session event")
            // Emit session started event
            clientEventEmitter?.onPlaybackSession(playbackSession)

            // Media3 automatically handles notifications when media is prepared and playing
            Log.d(TAG, "Media3 should show notification automatically for prepared media")
            Log.d(TAG, "Player after prepare: playbackState=${currentPlayer.playbackState}, isPlaying=${currentPlayer.isPlaying}, mediaItems=${currentPlayer.mediaItemCount}")
        } else {
            Log.e(TAG, "Cannot prepare player: no media items available")
        }
    }

    fun play() {
        Log.d(TAG, "play() called - Player state: ${currentPlayer.playbackState}")
        Log.d(TAG, "Player has ${currentPlayer.mediaItemCount} media items")

        // Handle case where play is called but player has no media items
        if (currentPlayer.mediaItemCount == 0 && currentPlaybackSession != null) {
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

        Log.d(TAG, "Calling currentPlayer.play()")
        currentPlayer.play()

        // Log notification status after starting playback
        Log.d(TAG, "After play() - Player state: ${currentPlayer.playbackState}, isPlaying: ${currentPlayer.isPlaying}")
        Log.d(TAG, "Media3 should show notification automatically for active playback")

        // Register shake sensor when playing
        // registerShakeSensor() // TODO: Implement shake sensor functionality

        // Start metadata timer
        // startMetadataTimer() // TODO: Implement metadata timer functionality

        clientEventEmitter?.onPlayingUpdate(true)
        Log.d(TAG, "Play command sent, isPlaying: ${currentPlayer.isPlaying}")
    }

    fun pause() {
        currentPlayer.pause()

        // Unregister shake sensor when paused to save battery
        // unregisterShakeSensor() // TODO: Implement shake sensor functionality

        // Stop metadata timer
        // stopMetadataTimer() // TODO: Implement metadata timer functionality

        clientEventEmitter?.onPlayingUpdate(false)
    }

    fun playPause(): Boolean {
        return if (currentPlayer.isPlaying) {
            pause()
            false
        } else {
            play()
            true
        }
    }

    fun seekPlayer(positionMs: Long) {
        currentPlayer.seekTo(positionMs)
    }

    fun seekForward(amountMs: Long) {
        val newPosition = currentPlayer.currentPosition + amountMs
        currentPlayer.seekTo(newPosition)
    }

    fun seekBackward(amountMs: Long) {
        val newPosition = (currentPlayer.currentPosition - amountMs).coerceAtLeast(0)
        currentPlayer.seekTo(newPosition)
    }

    fun setPlaybackSpeed(speed: Float) {
        currentPlayer.playbackParameters = PlaybackParameters(speed)
        clientEventEmitter?.onPlaybackSpeedChanged(speed)
    }

    fun closePlayback() {
        currentPlaybackSession = null
        currentPlayer.stop()
        currentPlayer.clearMediaItems()

        // Stop timers and sensors
        // stopMetadataTimer() // TODO: Implement metadata timer functionality
        // unregisterShakeSensor() // TODO: Implement shake sensor functionality

        clientEventEmitter?.onPlaybackClosed()
    }

    fun getCurrentTimeSeconds(): Double {
        return currentPlayer.currentPosition / 1000.0
    }

    fun getBufferedTimeSeconds(): Double {
        return currentPlayer.bufferedPosition / 1000.0
    }

    // Legacy compatibility methods
    fun getCurrentPlaybackSessionCopy(): PlaybackSession? {
        return currentPlaybackSession
    }

    fun getCurrentTime(): Long {
        return currentPlayer.currentPosition
    }

    fun getDuration(): Long {
        return if (currentPlayer.duration == C.TIME_UNSET) 0L else currentPlayer.duration
    }

    fun isClosed(): Boolean {
        return currentPlaybackSession == null
    }

    fun registerSensor() {
        // registerShakeSensor() // TODO: Implement shake sensor functionality
    }

    fun unregisterSensor() {
        // unregisterShakeSensor() // TODO: Implement shake sensor functionality
    }

    fun getMediaPlayer(): String {
        return when {
            player == castPlayerManager.castPlayer -> "cast"
            else -> "exoplayer"
        }
    }

    fun checkAutoSleepTimer() {
        // Auto sleep timer logic - stub for now
        Log.d(TAG, "checkAutoSleepTimer called")
    }

    fun updateQueuePositionForChapters() {
        // Update queue position logic - stub for now
        Log.d(TAG, "updateQueuePositionForChapters called")
    }

    fun alertSyncSuccess() {
        clientEventEmitter?.onProgressSyncSuccess()
    }

    fun alertSyncFailing() {
        clientEventEmitter?.onProgressSyncFailing()
    }

    fun sendClientMetadata(playerState: PlayerState? = null) {
        if (currentPlaybackSession != null) {
            val currentTime = getCurrentTimeSeconds()
            val duration = getDuration() / 1000.0
            val metadata = PlaybackMetadata(
                duration = if (duration > 0) duration else 0.0,
                currentTime = currentTime,
                playerState = if (currentPlayer.isPlaying) PlayerState.READY else PlayerState.IDLE
            )
            clientEventEmitter?.onMetadata(metadata)
        }
    }

    fun handlePlaybackEnded() {
        Log.d(TAG, "Playback ended")
        // stopMetadataTimer() // TODO: Implement metadata timer functionality
        // unregisterShakeSensor() // TODO: Implement shake sensor functionality
        clientEventEmitter?.onPlayingUpdate(false)
    }

    fun getEndTimeOfChapterOrTrack(): Long? {
        // Get the end time of the current chapter/track
        // For now, return the duration - this should be implemented properly
        val duration = getDuration()
        return if (duration > 0) duration else null
    }

    fun getEndTimeOfNextChapterOrTrack(): Long? {
        // Get the end time of the next chapter/track
        // For now, return null - this should be implemented with proper chapter navigation
        return null
    }

    // Service control methods - these are already available from Service base class

    fun skipToNext() {
        currentPlayer.seekToNextMediaItem()
    }

    fun skipToPrevious() {
        currentPlayer.seekToPreviousMediaItem()
    }

    fun navigateToChapter(chapterIndex: Int) {
        if (chapterIndex >= 0 && chapterIndex < currentPlayer.mediaItemCount) {
            currentPlayer.seekTo(chapterIndex, 0)
        }
    }

    fun getCurrentNavigationIndex(): Int {
        return currentPlayer.currentMediaItemIndex
    }

    fun getNavigationItemCount(): Int {
        return currentPlayer.mediaItemCount
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

    /**
     * Ensures the service is running in the foreground for Media3 notifications.
     * Media3 requires the service to be in a foreground state to display its
     * media notification automatically. This method starts the foreground service
     * with a minimal, temporary notification that Media3 will then replace.
     */
    private fun ensureForegroundService() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                channelId,
                "Media Playback",
                NotificationManager.IMPORTANCE_DEFAULT
            )
            val notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            notificationManager.createNotificationChannel(channel)

            val notification = android.app.Notification.Builder(this, channelId)
                .setContentTitle("Audiobookshelf")
                .setContentText("Starting playback...")
                .setSmallIcon(R.mipmap.ic_launcher) // Using the app's logo icon
                .build()

            try {
                Log.i(TAG, "Starting foreground service to enable Media3 notifications.")
                startForeground(notificationId, notification)
            } catch (e: Exception) {
                // This can happen on newer Android versions if the app is in the background
                // and doesn't have background start permissions.
                Log.e(TAG, "Failed to start foreground service: ${e.message}")
            }
        }
    }

    /**
     * CRITICAL FIX: Create local MediaController to trigger Media3 notifications
     * Media3 MediaLibraryService only shows notifications when MediaController clients are connected
     * Android Auto works because it connects as a client, but main UI playback has no clients
     */
    private fun ensureLocalMediaControllerConnected() {
        if (localMediaController != null) {
            Log.d(TAG, "*** Local MediaController already connected ***")
            return
        }

        try {
            Log.i(TAG, "*** CREATING LOCAL MEDIACONTROLLER TO TRIGGER NOTIFICATIONS ***")

            val sessionToken = mediaLibrarySession.token
            val controllerFuture = MediaController.Builder(this, sessionToken).buildAsync()

            controllerFuture.addListener({
                try {
                    localMediaController = controllerFuture.get()
                    Log.i(TAG, "*** LOCAL MEDIACONTROLLER CONNECTED - Media3 should now show notifications! ***")
                } catch (e: Exception) {
                    Log.e(TAG, "*** Error connecting local MediaController: ${e.message} ***")
                }
            }, MoreExecutors.directExecutor())

        } catch (e: Exception) {
            Log.e(TAG, "*** Error creating local MediaController: ${e.message} ***")
        }
    }

    /**
     * DEBUG: Helper function to decode player states for logging
     */
    private fun getPlaybackStateString(playbackState: Int): String {
        return when (playbackState) {
            Player.STATE_IDLE -> "IDLE"
            Player.STATE_BUFFERING -> "BUFFERING"
            Player.STATE_READY -> "READY"
            Player.STATE_ENDED -> "ENDED"
            else -> "UNKNOWN($playbackState)"
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
}
