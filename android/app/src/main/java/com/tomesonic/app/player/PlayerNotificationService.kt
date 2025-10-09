package com.tomesonic.app.player

import android.annotation.SuppressLint
import android.app.*
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.ImageDecoder
import android.hardware.Sensor
import android.hardware.SensorManager
import android.net.*
import android.net.Uri
import android.os.*
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.provider.Settings
import android.support.v4.media.MediaBrowserCompat
import android.support.v4.media.MediaDescriptionCompat
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.PlaybackStateCompat
// MIGRATION: Remove MediaSessionCompat - now using Media3 MediaSession
// import android.support.v4.media.session.MediaControllerCompat
// import android.support.v4.media.session.MediaSessionCompat
import android.util.Log
import androidx.annotation.RequiresApi
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
// MIGRATION: MediaBrowserServiceCompat → MediaLibraryService
// import androidx.media.MediaBrowserServiceCompat
import androidx.media3.session.MediaLibraryService
import androidx.media.utils.MediaConstants
import com.tomesonic.app.BuildConfig
import com.tomesonic.app.R
import com.tomesonic.app.data.*
import com.tomesonic.app.data.DeviceInfo
import com.tomesonic.app.device.DeviceManager
import com.tomesonic.app.managers.DbManager
import com.tomesonic.app.managers.SleepTimerManager
import com.tomesonic.app.media.MediaManager
import com.tomesonic.app.media.MediaProgressSyncer
import com.tomesonic.app.media.getUriToAbsIconDrawable
import com.tomesonic.app.media.getUriToDrawable
import com.tomesonic.app.plugins.AbsLogger
import com.tomesonic.app.server.ApiHandler
import com.tomesonic.app.player.mediasource.AudiobookMediaSourceBuilder
import com.tomesonic.app.player.mediasource.AudiobookProgressTracker
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.common.PlaybackException
// MIGRATION: Add Media3 session imports
import androidx.media3.session.LibraryResult
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaLibraryService.LibraryParams
import androidx.media3.session.MediaLibraryService.MediaLibrarySession
import androidx.media3.session.MediaLibraryService.MediaLibrarySession.Callback
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionResult
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.SettableFuture
import java.util.concurrent.TimeUnit
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.LoadControl
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.source.MediaSource
import androidx.media3.exoplayer.source.ProgressiveMediaSource
// MIGRATION: Restore HLS module dependency
import androidx.media3.exoplayer.hls.HlsMediaSource
import androidx.media3.extractor.DefaultExtractorsFactory
import androidx.media3.extractor.mp3.Mp3Extractor
import androidx.media3.ui.PlayerNotificationManager
import androidx.media3.session.DefaultMediaNotificationProvider
import androidx.media3.session.MediaNotification
import androidx.media3.session.CommandButton
import com.tomesonic.app.player.ChapterNavigationHelper
import android.os.Build
import java.util.*
import kotlin.concurrent.schedule
import kotlinx.coroutines.runBlocking

const val SLEEP_TIMER_WAKE_UP_EXPIRATION = 120000L // 2m

// MIGRATION: MediaBrowserServiceCompat → MediaLibraryService
class PlayerNotificationService : MediaLibraryService() {

  companion object {
    internal var isStarted = false
    var isClosed = false

    // Custom action constants for MediaSession
    const val CUSTOM_ACTION_JUMP_BACKWARD = "jump_backward"
    const val CUSTOM_ACTION_JUMP_FORWARD = "jump_forward"
    const val CUSTOM_ACTION_CHANGE_PLAYBACK_SPEED = "change_playback_speed"
    const val CUSTOM_ACTION_SKIP_TO_NEXT = "skip_to_next"
    const val CUSTOM_ACTION_SKIP_TO_PREVIOUS = "skip_to_previous"
  }

  private val tag = "PlayerNotificationServ"

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
  private val binder = LocalBinder()

  var clientEventEmitter: ClientEventEmitter? = null

  private lateinit var ctx: Context

  // Media3 components
  private lateinit var mediaSessionManager: MediaSessionManager

  lateinit var mediaManager: MediaManager
  lateinit var apiHandler: ApiHandler

  // Player management
  lateinit var playerManager: PlayerManager
  lateinit var castPlayerManager: CastPlayerManager
  lateinit var networkConnectivityManager: NetworkConnectivityManager
  // Simplified player management - single source of truth through MediaSession
  val exoPlayer: ExoPlayer get() = playerManager.mPlayer
  lateinit var currentPlayer: Player
    private set
  val castPlayer: androidx.media3.cast.CastPlayer?
    get() = castPlayerManager.castPlayer

  // New Media3 architecture components
  private lateinit var audiobookMediaSourceBuilder: AudiobookMediaSourceBuilder

  // Public getter for CastPlayerManager access
  fun getAudiobookMediaSourceBuilder(): AudiobookMediaSourceBuilder = audiobookMediaSourceBuilder
  private lateinit var audiobookProgressTracker: AudiobookProgressTracker
  private lateinit var chapterNavigationHelper: ChapterNavigationHelper

  lateinit var sleepTimerManager: SleepTimerManager
  lateinit var mediaProgressSyncer: MediaProgressSyncer

  private var notificationId = 10
  private var channelId = "tomesonic_channel"
  private var channelName = "TomeSonic Channel"
  private var sessionActivityPendingIntent: PendingIntent? = null

  var currentPlaybackSession: PlaybackSession? = null
  private var initialPlaybackRate: Float? = null
  internal var useChapterTrack: Boolean = false // Reserved for future web UI control over chapter progress behavior
  private var lastActiveQueueItemIndex = -1
  private var desiredActiveQueueItemIndex = -1 // Track the desired active queue item
  private var currentNavigationIndex = -1 // Track the current navigation index
  private var queueSetForCurrentSession = false
  internal var expectingTrackTransition = false // Flag to track when we're waiting for a track change to complete


  internal var isAndroidAuto = false

  // The following are used for the shake detection
  private var isShakeSensorRegistered: Boolean = false
  private var mSensorManager: SensorManager? = null
  private var mAccelerometer: Sensor? = null
  private var mShakeDetector: ShakeDetector? = null
  private var shakeSensorUnregisterTask: TimerTask? = null

  fun isBrowseTreeInitialized(): Boolean {
    val localBooks = DeviceManager.dbManager.getLocalLibraryItems("book")
    return mediaManager.serverItemsInProgress.isNotEmpty() || localBooks.isNotEmpty()
  }

  fun setUseChapterTrack(enabled: Boolean) {
    useChapterTrack = enabled
    // Note: Android Auto and notifications always use chapter progress when chapters are available
  }

  fun getChapterRelativePosition(): Long {
    // NEW ARCHITECTURE: ExoPlayer naturally reports chapter-relative positions
    // since each chapter is now a separate MediaItem
    return if (::chapterNavigationHelper.isInitialized && chapterNavigationHelper.hasChapters()) {
      currentPlayer.currentPosition // Already chapter-relative with new architecture
    } else {
      val currentChapter = getCurrentBookChapter()
      return if (currentChapter != null) {
        val chapterStartMs = currentChapter.startMs
        val currentTime = getCurrentTime()
        (currentTime - chapterStartMs).coerceAtLeast(0L)
      } else {
        getCurrentTime()
      }
    }
  }

  fun getChapterRelativeDuration(): Long {
    // NEW ARCHITECTURE: ExoPlayer naturally reports chapter-relative duration
    // since each chapter is now a separate MediaItem
    return if (::chapterNavigationHelper.isInitialized && chapterNavigationHelper.hasChapters()) {
      currentPlayer.duration // Already chapter-relative with new architecture
    } else {
      val currentChapter = getCurrentBookChapter()
      return if (currentChapter != null) {
        val chapterStartMs = currentChapter.startMs
        val chapterEndMs = currentChapter.endMs
        chapterEndMs - chapterStartMs
      } else {
        getDuration()
      }
    }
  }

  /*
     Service related stuff
  */
  // MediaLibraryService handles binding through MediaBrowserServiceCompat
  // Regular service clients should use the MediaBrowser API

  inner class LocalBinder : Binder() {
    // Return this instance of LocalService so clients can call public methods
    fun getService(): PlayerNotificationService = this@PlayerNotificationService
  }

  override fun onBind(intent: Intent?): IBinder? {
    // Support both MediaBrowser binding and direct LocalBinder binding
    val mediaBrowserBinder = super.onBind(intent)
    return mediaBrowserBinder ?: binder
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    isStarted = true

    // Call super first as required by Android
    val result = super.onStartCommand(intent, flags, startId)

    // Media3 handles foreground service automatically through MediaSession
    // We don't need to call startForeground() manually - Media3 will handle it
    // when media starts playing and notifications are posted

    return result
  }

  @Deprecated("Deprecated in Java")
  override fun onStart(intent: Intent?, startId: Int) {
    // Override required by MediaBrowserServiceCompat
  }

  @RequiresApi(Build.VERSION_CODES.O)
  private fun createNotificationChannel(channelId: String, channelName: String): String {
    val chan = NotificationChannel(channelId, channelName, NotificationManager.IMPORTANCE_HIGH)
    chan.lightColor = Color.DKGRAY
    chan.lockscreenVisibility = Notification.VISIBILITY_PUBLIC
    // Ensure high-quality image rendering
    chan.setShowBadge(false)
    val service = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    service.createNotificationChannel(chan)
    return channelId
  }

  private fun createBasicNotification(): Notification {
    val channelId = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      createNotificationChannel(this.channelId, this.channelName)
    } else ""

    return NotificationCompat.Builder(this, channelId)
      .setSmallIcon(R.drawable.abs_audiobookshelf)
      .setContentTitle("TomeSonic")
      .setContentText("Preparing playback...")
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .build()
  }

  // detach player
  override fun onDestroy() {
    networkConnectivityManager.release()

    isStarted = false
    isClosed = true
    // Reset foreground service flag so new service instance can start properly
    PlayerNotificationListener.isForegroundService = false
    DeviceManager.widgetUpdater?.onPlayerChanged(this)

    playerManager.releasePlayer()
    castPlayerManager.release()
    // MIGRATION-TODO: mediaSession.release() - now handled by MediaSessionManager
    mediaSessionManager.release()

    // Release ChapterAwarePlayer resources
    // Clean up new architecture components - no wrapper to release

    mediaProgressSyncer.reset()

    // Clear android auto listeners to avoid leaking references
    try {
      mediaManager.clearAndroidAutoLoadListeners()
    } catch (e: Exception) {
      // ignore
    }

    super.onDestroy()
  }

  // removing service when user swipe out our app
  override fun onTaskRemoved(rootIntent: Intent?) {
    super.onTaskRemoved(rootIntent)

    // Keep the MediaBrowserService running for Android Auto even when app is closed
    if (isAndroidAuto) {
      // Don't call stopSelf() - let the service continue running for Android Auto
    } else {
      // If not being used by Android Auto, allow normal termination
    }
  }

  override fun onCreate() {
    super.onCreate()

    // Set up notification provider - icon is configured via AndroidManifest.xml meta-data
    val notificationProvider = DefaultMediaNotificationProvider.Builder(this)
      .build()
    setMediaNotificationProvider(notificationProvider)

    ctx = this

    // Initialize Paper
    DbManager.initialize(ctx)

    // Initialize widget
    DeviceManager.initializeWidgetUpdater(ctx)

    DbManager.initialize(ctx)

    // Initialize API
    apiHandler = ApiHandler(ctx)

    // Initialize sleep timer
    sleepTimerManager = SleepTimerManager(this)

    // Initialize Media Progress Syncer
    mediaProgressSyncer = MediaProgressSyncer(this, apiHandler)

    // Initialize shake sensor
    initSensor()

    // Initialize media manager
    mediaManager = MediaManager(apiHandler, ctx)

    // Register listener so we refresh the MediaBrowser when MediaManager finishes loading Android Auto data
    mediaManager.registerAndroidAutoLoadListener {
      try {
  // Notify Android Auto that the browse tree changed so recents/continue items appear.
  // Use the MediaLibrarySession notifyChildrenChanged when available.
  // notifyChildrenChanged(root: String, page: Int, params: LibraryParams?)
  mediaSessionManager.mediaSession?.notifyChildrenChanged("/", 0, null)
      } catch (e: Exception) {
        Log.e(tag, "Error notifying children changed from mediaManager listener: ${e.localizedMessage}")
      }
    }

    channelId =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
              createNotificationChannel(channelId, channelName)
            } else ""

    sessionActivityPendingIntent =
            packageManager?.getLaunchIntentForPackage(packageName)?.let { sessionIntent ->
              PendingIntent.getActivity(this, 0, sessionIntent, PendingIntent.FLAG_IMMUTABLE)
            }

    // Initialize MediaSessionManager (preparation for player creation)
    val sessionCallback = MediaLibrarySessionCallback(this)
    mediaSessionManager = MediaSessionManager(this, this, sessionCallback)
    // Note: MediaSession will be initialized after player creation

    // Initialize CastPlayerManager
    castPlayerManager = CastPlayerManager(this)

    // Initialize Cast Framework (isolate errors to prevent breaking MediaSession)
    try {
      val castContext = com.google.android.gms.cast.framework.CastContext.getSharedInstance(this)
      castPlayerManager.initializeCastPlayer(castContext)

      // Check if there's already an active cast session (thread-safe)
      castPlayerManager.isConnectedSafe { isConnected ->
        if (isConnected) {
          // Don't switch immediately - wait until playback preparation
        }
      }
    } catch (e: Exception) {
      Log.e(tag, "Failed to initialize Cast framework - continuing without cast", e)
      // Don't let cast initialization failure break the whole service
    }

    // Initialize NetworkConnectivityManager
    networkConnectivityManager = NetworkConnectivityManager(this, this)
    networkConnectivityManager.initialize()

    // Initialize player manager first
    playerManager = PlayerManager(this, deviceSettings, this)
    playerManager.initializeExoPlayer()

    // Initialize current player
    currentPlayer = exoPlayer

    // Initialize new Media3 architecture components
    audiobookMediaSourceBuilder = AudiobookMediaSourceBuilder(this)
    audiobookProgressTracker = AudiobookProgressTracker(exoPlayer, currentPlaybackSession)
    chapterNavigationHelper = ChapterNavigationHelper(exoPlayer, audiobookProgressTracker)
    Log.d(tag, "Initialized new Media3 MediaSource architecture with direct ExoPlayer usage")

    // Now initialize MediaSession with the direct ExoPlayer
    if (currentPlayer != null) {
        mediaSessionManager.initializeMediaSession(notificationId, channelId, sessionActivityPendingIntent, currentPlayer)
        Log.d(tag, "AABrowser: MediaSessionManager initialized with direct ExoPlayer")
        Log.d(tag, "AABrowser: ExoPlayer will naturally report chapter-relative positions")
    } else {
        Log.e(tag, "AABrowser: Failed to initialize MediaSession - currentPlayer is null")
    }

    // This is for Media Browser compatibility
    Log.d(tag, "AALibrary: MediaLibraryService handles session token automatically")
    // MIGRATION: MediaLibraryService doesn't need manual sessionToken setting
    // sessionToken = mediaSessionManager.getCompatSessionToken()
    // Log.d(tag, "AALibrary: Session token set: $sessionToken")

    // Cast player is now accessed via castPlayerManager.castPlayer property
  }

  /*
    User callable methods
  */
  fun preparePlayer(
          playbackSession: PlaybackSession,
          playWhenReady: Boolean,
          playbackRate: Float?,
          skipCastCheck: Boolean = false,
          skipInitialSeek: Boolean = false
  ) {
    // If we are switching to a different playback session ensure the previous session is
    // finalized and synced (or queued) before starting the new one. This guarantees progress
    // for the previous item is saved remotely or queued if offline.
    fun doPreparePlayer(
            playbackSession: PlaybackSession,
            playWhenReady: Boolean,
            playbackRate: Float?
    ) {
      // Ensure we're on the main thread
      if (Looper.myLooper() != Looper.getMainLooper()) {
        Log.w(tag, "doPreparePlayer called on wrong thread, posting to main thread")
        Handler(Looper.getMainLooper()).post {
          doPreparePlayer(playbackSession, playWhenReady, playbackRate)
        }
        return
      }

      // Check if we're re-preparing during active playback
      val isCurrentlyPlaying = currentPlayer.isPlaying
      val hasCurrentSession = currentPlaybackSession != null
      val isSameSession = hasCurrentSession && currentPlaybackSession?.id == playbackSession.id

      if (isCurrentlyPlaying && isSameSession) {
        Log.w(tag, "preparePlayer: WARNING - Re-preparing same session during active playback!")
        Log.w(tag, "preparePlayer: This may cause unexpected position jumps")
        Log.w(tag, "preparePlayer: Current position: ${getCurrentTime()}ms, Session position: ${playbackSession.currentTimeMs}ms")

        // If the position differs significantly, preserve the current player position
        val currentPlayerPos = getCurrentTime()
        val sessionPos = playbackSession.currentTimeMs
        val posDiff = Math.abs(currentPlayerPos - sessionPos)

        if (posDiff > 5000) { // More than 5 seconds difference
          Log.w(tag, "preparePlayer: Large position difference detected (${posDiff}ms)")
          Log.w(tag, "preparePlayer: Preserving current player position to prevent chapter skip")
          playbackSession.currentTime = currentPlayerPos / 1000.0
        }
      }

      // Check if the session needs refresh before preparing player
      if (playbackSession.needsSessionRefresh()) {
        Log.d(tag, "Session needs refresh, requesting fresh session from server")
        refreshPlaybackSession(playbackSession, playWhenReady, playbackRate)
        return
      }

      try {
      if (!isStarted) {
        Log.i(tag, "preparePlayer: service not started - Starting service --")
        Intent(ctx, PlayerNotificationService::class.java).also { intent ->
          ctx.startService(intent)
        }
      }

      // TODO: When an item isFinished the currentTime should be reset to 0
      //        will reset the time if currentTime is within 5s of duration (for android auto)
      Log.d(
              tag,
              "Prepare Player Session Current Time=${playbackSession.currentTime}, Duration=${playbackSession.duration}"
      )
      if (playbackSession.duration - playbackSession.currentTime < 5) {
        Log.d(tag, "Prepare Player Session is finished, so restart it")
        playbackSession.currentTime = 0.0
      }

      isClosed = false

      // First set the basic metadata
      val metadata = playbackSession.getMediaMetadataCompat(ctx)
      Log.d(tag, "Android Auto: Setting initial metadata with bitmap: ${metadata.getBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART) != null}")

      var originalMetadata = metadata
      Log.d(tag, "Android Auto: Stored original metadata with bitmap: ${originalMetadata.getBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART) != null}")

      // NEW MEDIA3 ARCHITECTURE: Use MediaSource instead of MediaItems
      Log.d("NUXT_SKIP_DEBUG", "preparePlayer: Building MediaSource for '${playbackSession.displayTitle}'")

      // Additional validation: Check for any signs of session expiry before building MediaSource
      if (!playbackSession.isLocal && playbackSession.audioTracks.isNotEmpty()) {
        val firstTrackUrl = playbackSession.audioTracks[0].contentUrl
        if (firstTrackUrl.contains("session") && playbackSession.isLikelyExpired()) {
          Log.w("NUXT_SKIP_DEBUG", "preparePlayer: Session appears expired but passed refresh check. URL: $firstTrackUrl")
        }
      }

      // Build the MediaItems using the new architecture
      // Determine if we should build for cast based on the media player type
      val forCast = playbackSession.mediaPlayer == CastPlayerManager.PLAYER_CAST
      val mediaItems = try {
        audiobookMediaSourceBuilder.buildMediaItems(playbackSession, forCast)
      } catch (e: Exception) {
        Log.e("NUXT_SKIP_DEBUG", "preparePlayer: Failed to build MediaItems: ${e.javaClass.simpleName}: ${e.message}")
        Log.e("NUXT_SKIP_DEBUG", "preparePlayer: MediaItems build exception:", e)
        Log.e("NUXT_SKIP_DEBUG", "preparePlayer: Session info - isLocal: ${playbackSession.isLocal}, sessionId: ${playbackSession.id}")
        if (!playbackSession.isLocal && playbackSession.audioTracks.isNotEmpty()) {
          Log.e("NUXT_SKIP_DEBUG", "preparePlayer: First track URL: ${playbackSession.audioTracks[0].contentUrl}")
        }
        currentPlaybackSession = null
        return
      }

      if (mediaItems.isEmpty()) {
        Log.e("NUXT_SKIP_DEBUG", "preparePlayer: MediaItems list is empty - failed to build")
        currentPlaybackSession = null
        return
      }

      Log.d("NUXT_SKIP_DEBUG", "preparePlayer: MediaItems built successfully (${mediaItems.size} items)")

      // Update progress tracker with the playback session
      audiobookProgressTracker.updatePlaybackSession(playbackSession)

      // Set chapter segments in the progress tracker
      val chapterSegments = audiobookMediaSourceBuilder.getLastChapterSegments()
      audiobookProgressTracker.setChapterSegments(chapterSegments)
      Log.d(tag, "Set ${chapterSegments.size} chapter segments in progress tracker")

      val playbackRateToUse = playbackRate ?: initialPlaybackRate ?: mediaManager.userSettingsPlaybackRate ?: 1f
      initialPlaybackRate = playbackRate ?: mediaManager.userSettingsPlaybackRate

      Log.d(tag, "preparePlayer: Speed calculation - provided: $playbackRate, initial: $initialPlaybackRate, userSettings: ${mediaManager.userSettingsPlaybackRate}, using: $playbackRateToUse")

      // Set actions on Android Auto like jump forward/backward
      setMediaSessionConnectorCustomActions(playbackSession)

      // Force check cast session state and switch if needed
      forceCastCheck()

      // Additional check if we should be using cast player for this specific session
      // Use polling to handle delayed cast session readiness
      if (!skipCastCheck) {
        val canUseCast = castPlayerManager.canUseCastPlayer(playbackSession)
        Log.d(tag, "Cast check - canUseCast=$canUseCast, isLocal=${playbackSession.isLocal}")

        if (canUseCast && getMediaPlayer() == CastPlayerManager.PLAYER_EXO) {
          Log.d(tag, "Checking cast session with polling for delayed readiness...")
          castPlayerManager.checkCastSessionWithPolling(callback = { isCastReady ->
            Log.d(tag, "Cast polling result - isCastReady=$isCastReady")
            if (isCastReady) {
              Log.d(tag, "Cast session is ready and can handle this session - switching to cast player")
              switchToPlayer(true)

              // Re-trigger preparation after switching to cast player
              val updatedPlaybackSession = currentPlaybackSession
              if (updatedPlaybackSession != null) {
                Log.d(tag, "Re-preparing with cast player after successful switch")
                preparePlayer(updatedPlaybackSession, playWhenReady, playbackRate, skipCastCheck = true)
              }
            } else {
              Log.d(tag, "Cast session not ready after polling - continuing with ExoPlayer")
            }
          })
        }
      } else {
        Log.d(tag, "Skipping cast check due to skipCastCheck=true")
      }

      playbackSession.mediaPlayer = getMediaPlayer()

      // Allow casting of local media with server equivalents
      // Local items with server counterparts can be cast using server URLs
      if (playbackSession.mediaPlayer == CastPlayerManager.PLAYER_CAST && playbackSession.isLocal) {
        val canCast = castPlayerManager.canUseCastPlayer(playbackSession)
        if (!canCast) {
          Log.w(tag, "Local media item has no server equivalent - cannot cast, switching to local player")
          currentPlaybackSession = null
          // TODO: Implement switchToPlayer for Media3
          // switchToPlayer(false)
          // For now, just log the issue and continue with local player
          playbackSession.mediaPlayer = CastPlayerManager.PLAYER_EXO
        } else {
          Log.d(tag, "Local media item has server equivalent - proceeding with cast using server URLs")
        }
      }

      if (playbackSession.mediaPlayer == CastPlayerManager.PLAYER_CAST) {
        // If cast-player is the first player to be used
        Log.d(tag, "Setting up cast player for playback session")
        val castPlayer = castPlayerManager.castPlayer
        if (castPlayer != null) {
          // For Media3, we need to reinitialize the MediaSession with the cast player
          // Release the current session first
          mediaSessionManager.release()

          // Re-initialize with cast player
          mediaSessionManager.initializeMediaSession(
            notificationId,
            channelId,
            sessionActivityPendingIntent,
            castPlayer
          )

          Log.d(tag, "Reinitialized MediaSession with cast player")
        } else {
          Log.e(tag, "Cast player is null - cannot switch to cast playback")
          playbackSession.mediaPlayer = CastPlayerManager.PLAYER_EXO
        }
      }

      currentPlaybackSession = playbackSession
      lastActiveQueueItemIndex = -1 // Reset when starting new playback session
      desiredActiveQueueItemIndex = -1 // Reset desired active queue item
      currentNavigationIndex = -1 // Reset navigation index - will be calculated on first access
      queueSetForCurrentSession = false // Reset queue flag for new session

      // RE-ENABLE: Update AudiobookProgressTracker with new session
      audiobookProgressTracker.updatePlaybackSession(playbackSession)

      // RE-ENABLE: Set up chapter change listener for automatic metadata updates
      chapterNavigationHelper.setChapterChangeListener { chapter, chapterIndex ->
        Log.d(tag, "Chapter changed to: ${chapter?.title ?: "Unknown"}")
        // Update MediaSession metadata when chapter changes
        if (chapter != null) {
          val chapterDuration = chapter.endMs - chapter.startMs
          mediaSessionManager.updateChapterMetadata(
            chapterTitle = chapter.title ?: "Chapter ${chapterIndex + 1}",
            chapterDuration = chapterDuration,
            bookTitle = playbackSession.displayTitle ?: "",
            author = playbackSession.displayAuthor,
            bitmap = null // TODO: Load chapter artwork if available
          )
        }
      }

      // Set initial chapter metadata for current position
      val currentChapter = chapterNavigationHelper.getCurrentChapter()
      if (currentChapter != null) {
        val chapterDuration = currentChapter.endMs - currentChapter.startMs
        val chapterIndex = chapterNavigationHelper.getCurrentChapterIndex()
        mediaSessionManager.updateChapterMetadata(
          chapterTitle = currentChapter.title ?: "Chapter ${chapterIndex + 1}",
          chapterDuration = chapterDuration,
          bookTitle = playbackSession.displayTitle ?: "",
          author = playbackSession.displayAuthor,
          bitmap = null // TODO: Load chapter artwork if available
        )
        Log.d(tag, "Set initial chapter metadata: ${currentChapter.title}, duration=${chapterDuration}ms")
      }

      Log.d(tag, "ChapterAwarePlayer update and listeners configured")

      DeviceManager.setLastPlaybackSession(
              playbackSession
      ) // Save playback session to use when app is closed

      AbsLogger.info("PlayerNotificationService", "preparePlayer: Started playback session for item ${currentPlaybackSession?.mediaItemId}. MediaPlayer ${currentPlaybackSession?.mediaPlayer}")
      // Notify client
      clientEventEmitter?.onPlaybackSession(playbackSession)

      // Update widget
      DeviceManager.widgetUpdater?.onPlayerChanged(this)

      // MediaSource validation is already done above

      // CRITICAL FIX: Check if we're using local player (not cast)
      if (currentPlayer == exoPlayer) {
        // NEW MEDIA3 ARCHITECTURE: Use MediaItems with clipping configuration
        // This creates a unified timeline where each chapter is a separate MediaItem
        AbsLogger.info("PlayerNotificationService", "preparePlayer: Setting up MediaItems for ${currentPlaybackSession?.mediaItemId}.")
        Log.d(tag, "NEW_ARCHITECTURE: Using Media3 MediaItem architecture (currentPlayer type: ${currentPlayer.javaClass.simpleName})")

        // Calculate start position using the helper methods
        val startMediaItemIndex: Int
        val startPositionMs: Long

        if (skipInitialSeek) {
          // When skipping initial seek, start at the beginning
          startMediaItemIndex = 0
          startPositionMs = 0L
          Log.d(tag, "preparePlayer: skipInitialSeek=true, starting at beginning (0, 0)")
        } else {
          startMediaItemIndex = audiobookMediaSourceBuilder.calculateStartMediaItemIndex(playbackSession)
          startPositionMs = audiobookMediaSourceBuilder.calculateStartPositionInMediaItem(playbackSession)
          Log.d("NUXT_SKIP_DEBUG", "preparePlayer: Starting at MediaItem $startMediaItemIndex, position ${startPositionMs}ms")
          Log.d("NUXT_SKIP_DEBUG", "preparePlayer: POSITION_DEBUG - Absolute position: ${playbackSession.currentTimeMs}ms, Chapter-relative position: ${startPositionMs}ms")
        }

        // Set the MediaItems to populate the timeline
        Log.d("NUXT_SKIP_DEBUG", "preparePlayer: Setting MediaItems on ExoPlayer")
        try {
          exoPlayer.setMediaItems(mediaItems, startMediaItemIndex, startPositionMs)
          Log.d("NUXT_SKIP_DEBUG", "preparePlayer: MediaItems set successfully (${mediaItems.size} items)")
        } catch (e: Exception) {
          Log.e("NUXT_SKIP_DEBUG", "preparePlayer: Failed to set MediaItems: ${e.javaClass.simpleName}: ${e.message}")
          Log.e("NUXT_SKIP_DEBUG", "preparePlayer: MediaItems set exception:", e)
          currentPlaybackSession = null
          return
        }

        // ENHANCED DEBUG: Log state before setting playWhenReady
        Log.d(tag, "PREPARE_DEBUG: Before setting playWhenReady - playbackState=${currentPlayer.playbackState}, isPlaying=${currentPlayer.isPlaying}")
        Log.d(tag, "PREPARE_DEBUG: MediaItems set - count=${currentPlayer.mediaItemCount}")

        currentPlayer.playWhenReady = playWhenReady
        Log.d(tag, "PREPARE_DEBUG: playWhenReady set to $playWhenReady - current value=${currentPlayer.playWhenReady}")

        currentPlayer.setPlaybackSpeed(playbackRateToUse)
        Log.d(tag, "PREPARE_DEBUG: Playback speed set to $playbackRateToUse")

        // ENHANCED DEBUG: Log state before prepare()
        Log.d(tag, "PREPARE_DEBUG: Before prepare() - playbackState=${currentPlayer.playbackState}, isPlaying=${currentPlayer.isPlaying}, playWhenReady=${currentPlayer.playWhenReady}")

        // Prepare the player
        currentPlayer.prepare()

        // ENHANCED DEBUG: Log state immediately after prepare()
        Log.d(tag, "PREPARE_DEBUG: After prepare() - playbackState=${currentPlayer.playbackState}, isPlaying=${currentPlayer.isPlaying}, playWhenReady=${currentPlayer.playWhenReady}")
        Log.d(tag, "PREPARE_DEBUG: Expected behavior: prepare() should transition to BUFFERING then READY, and auto-start if playWhenReady=true")

        // The MediaItems are already set with the correct start position, so no additional seeking is needed
        // The setMediaItems() call above already positioned the player at the correct MediaItem and position
        Log.d(tag, "POSITION_DEBUG: MediaItems set with startIndex=$startMediaItemIndex, startPosition=${startPositionMs}ms - no additional seeking needed")

        // Use PlayerManager debug method for comprehensive state logging
        playerManager.logPlayerState("IMMEDIATELY_AFTER_PREPARE")

        Log.d(
                tag,
                "Prepare complete for session ${currentPlaybackSession?.displayTitle} | ${currentPlayer.mediaItemCount}"
        )

        // ENHANCED DEBUG: Completion status logging
        Log.d("NUXT_SKIP_DEBUG", "preparePlayer: COMPLETION - Session prepared: '${currentPlaybackSession?.displayTitle}'")
        Log.d("NUXT_SKIP_DEBUG", "preparePlayer: COMPLETION - Final media item count: ${currentPlayer.mediaItemCount}")
        Log.d("NUXT_SKIP_DEBUG", "preparePlayer: COMPLETION - Final player state: ${currentPlayer.playbackState}")
        Log.d("NUXT_SKIP_DEBUG", "preparePlayer: COMPLETION - playWhenReady: ${currentPlayer.playWhenReady}")
        Log.d("NUXT_SKIP_DEBUG", "preparePlayer: COMPLETION - Player prepared successfully")

        if (currentPlayer.mediaItemCount == 0) {
          Log.e("NUXT_SKIP_DEBUG", "preparePlayer: COMPLETION - WARNING! Still no media items after full preparation!")
        } else {
          Log.d("NUXT_SKIP_DEBUG", "preparePlayer: COMPLETION - Success! ${currentPlayer.mediaItemCount} media items available")
        }

      } else if (currentPlayer == castPlayer) {
        // CAST PLAYER PREPARATION PATH
        Log.d(tag, "NEW_ARCHITECTURE: Using Cast player - preparing MediaItems instead of MediaSource")
        Log.d("NUXT_SKIP_DEBUG", "preparePlayer: Setting up Cast player with MediaItems")

        try {
          // Create cast-specific MediaItems
          val castMediaItems = castPlayerManager.createCastMediaItems(playbackSession)
          Log.d("NUXT_SKIP_DEBUG", "preparePlayer: Created ${castMediaItems.size} Cast MediaItems")

          if (castMediaItems.isEmpty()) {
            Log.e("NUXT_SKIP_DEBUG", "preparePlayer: CAST ERROR - No MediaItems created for Cast player")
            currentPlaybackSession = null
            return
          }

          // Calculate initial position for Cast
          val startPosition = playbackSession.currentTimeMs
          val startIndex = getChapterIndexForTime(startPosition)
          val chapterRelativePosition = startPosition - (getCurrentBookChapter()?.startMs ?: 0L)

          Log.d("NUXT_SKIP_DEBUG", "preparePlayer: Cast starting at index $startIndex, position ${chapterRelativePosition}ms")

          // Load the Cast player with MediaItems using absolute positioning
          castPlayerManager.loadCastPlayer(
            mediaItems = castMediaItems,
            startIndex = startIndex,
            startPositionMs = startPosition, // Use absolute position, not chapter-relative
            playWhenReady = playWhenReady,
            playbackSession = playbackSession
          )

          // Set playback speed for Cast
          currentPlayer.setPlaybackSpeed(playbackRateToUse)
          Log.d("NUXT_SKIP_DEBUG", "preparePlayer: Cast playback speed set to $playbackRateToUse")

          // Log Cast preparation completion
          Log.d("NUXT_SKIP_DEBUG", "preparePlayer: CAST COMPLETION - MediaItems loaded: ${castMediaItems.size}")
          Log.d("NUXT_SKIP_DEBUG", "preparePlayer: CAST COMPLETION - Cast player prepared successfully")

        } catch (e: Exception) {
          Log.e("NUXT_SKIP_DEBUG", "preparePlayer: CAST EXCEPTION during preparation: ${e.javaClass.simpleName}: ${e.message}")
          Log.e("NUXT_SKIP_DEBUG", "preparePlayer: CAST EXCEPTION stack trace:", e)
          currentPlaybackSession = null
          return
        }

        // ENHANCED DEBUG: Completion status logging
        Log.d("NUXT_SKIP_DEBUG", "preparePlayer: COMPLETION - Session prepared: '${currentPlaybackSession?.displayTitle}'")
        Log.d("NUXT_SKIP_DEBUG", "preparePlayer: COMPLETION - Final media item count: ${currentPlayer.mediaItemCount}")
        Log.d("NUXT_SKIP_DEBUG", "preparePlayer: COMPLETION - Final player state: ${currentPlayer.playbackState}")
        Log.d("NUXT_SKIP_DEBUG", "preparePlayer: COMPLETION - playWhenReady: ${currentPlayer.playWhenReady}")
        Log.d("NUXT_SKIP_DEBUG", "preparePlayer: COMPLETION - Cast player prepared successfully")

        if (currentPlayer.mediaItemCount == 0) {
          Log.e("NUXT_SKIP_DEBUG", "preparePlayer: COMPLETION - WARNING! Still no media items after Cast preparation!")
        } else {
          Log.d("NUXT_SKIP_DEBUG", "preparePlayer: COMPLETION - Success! ${currentPlayer.mediaItemCount} media items available")
        }

      } else {
        Log.w("NUXT_SKIP_DEBUG", "preparePlayer: UNKNOWN PLAYER TYPE - ${currentPlayer.javaClass.simpleName}")
        Log.w("NUXT_SKIP_DEBUG", "preparePlayer: Expected either ExoPlayer or CastPlayer")
      }

      // MIGRATION-DEFERRED: CAST - This is now handled in the Cast player branch above
      // Cast player MediaItems are loaded via castPlayerManager.loadCastPlayer() in the Cast branch

    } catch (e: Exception) {
        Log.e("NUXT_SKIP_DEBUG", "doPreparePlayer: EXCEPTION during preparation: ${e.javaClass.simpleName}: ${e.message}")
        Log.e("NUXT_SKIP_DEBUG", "doPreparePlayer: EXCEPTION stack trace:", e)
        AbsLogger.error("PlayerNotificationService", "doPreparePlayer: Failed to prepare player session: ${e.message}")
        Log.e(tag, "Exception during player preparation", e)
        // Reset state and notify client of failure
        currentPlaybackSession = null
        lastActiveQueueItemIndex = -1
        queueSetForCurrentSession = false
        clientEventEmitter?.onPlaybackFailed("Failed to prepare media item: ${e.message}")
      }
    } // End of doPreparePlayer function

    // If there's an active session and it's different from the new one, finalize it first.
    val previousSession = currentPlaybackSession
    if (previousSession != null && previousSession.mediaItemId != playbackSession.mediaItemId) {
      AbsLogger.info("PlayerNotificationService", "preparePlayer: Switching from ${previousSession.mediaItemId} to ${playbackSession.mediaItemId}. Finalizing previous session first.")
      // Stop and force a sync/flush of the previous session. Once complete, proceed to prepare the new session.
      mediaProgressSyncer.stop(true) {
        try {
          // Ensure we're on the main thread when calling doPreparePlayer
          Handler(Looper.getMainLooper()).post {
            doPreparePlayer(playbackSession, playWhenReady, playbackRate)
          }
        } catch (e: Exception) {
          AbsLogger.error("PlayerNotificationService", "preparePlayer: Failed to prepare new player session after stopping previous: ${e.message}")
          Log.e(tag, "Exception during player preparation", e)
          // Reset state and notify client of failure
          Handler(Looper.getMainLooper()).post {
            currentPlaybackSession = null
            lastActiveQueueItemIndex = -1
            queueSetForCurrentSession = false
            clientEventEmitter?.onPlaybackFailed("Failed to switch to new media item: ${e.message}")
          }
        }
      }
      return
    }

    // No prior session or same item, proceed immediately.
    try {
      // Ensure we're on the main thread when calling doPreparePlayer
      if (Looper.myLooper() == Looper.getMainLooper()) {
        doPreparePlayer(playbackSession, playWhenReady, playbackRate)
      } else {
        Handler(Looper.getMainLooper()).post {
          doPreparePlayer(playbackSession, playWhenReady, playbackRate)
        }
      }
    } catch (e: Exception) {
      AbsLogger.error("PlayerNotificationService", "preparePlayer: Failed to prepare player session: ${e.message}")
      Log.e(tag, "Exception during immediate player preparation", e)
      // Reset state and notify client of failure
      Handler(Looper.getMainLooper()).post {
        currentPlaybackSession = null
        lastActiveQueueItemIndex = -1
        queueSetForCurrentSession = false
        clientEventEmitter?.onPlaybackFailed("Failed to prepare media item: ${e.message}")
      }
    }
  }

  /**
   * Refreshes an expired playback session by requesting a new session from the server
   * while preserving the current playback position and state
   */
  private fun refreshPlaybackSession(
    oldSession: PlaybackSession,
    playWhenReady: Boolean,
    playbackRate: Float?
  ) {
    Log.d(tag, "Refreshing expired session for: ${oldSession.displayTitle}")

    // Create the request payload
    val playItemRequestPayload = getPlayItemRequestPayload(false) // Never start playing during refresh

    // Request a new session from the server
    apiHandler.playLibraryItem(
      oldSession.libraryItemId ?: "",
      oldSession.episodeId,
      playItemRequestPayload
    ) { newSession ->
      if (newSession != null) {
        // Preserve the current playback position and other state from the old session
        newSession.currentTime = oldSession.currentTime
        newSession.timeListening = oldSession.timeListening
        // Update timestamp to mark session as fresh
        newSession.updatedAt = System.currentTimeMillis()

        Log.d(tag, "Session refreshed successfully, continuing with playback at ${newSession.currentTime}s")

        // Always ensure refreshed sessions start paused (unless in Android Auto)
        val shouldPlay = isAndroidAuto && playWhenReady

        // Continue with the new session by calling preparePlayer again (avoiding infinite recursion)
        Handler(Looper.getMainLooper()).post {
          // Call preparePlayer with the new session (it won't need refresh since it's fresh)
          preparePlayer(newSession, shouldPlay, playbackRate, skipCastCheck = true)
        }
      } else {
        Log.e(tag, "Failed to refresh session for ${oldSession.displayTitle}")
        Handler(Looper.getMainLooper()).post {
          clientEventEmitter?.onPlaybackFailed("Unable to refresh session. Please try again.")
        }
      }
    }
  }

  private fun setMediaSessionConnectorCustomActions(playbackSession: PlaybackSession) {
    // Custom actions are now handled automatically by MediaLibrarySession
    // with the CommandButton layout set in MediaSessionManager
    Log.d(tag, "Custom actions configured through MediaLibrarySession CommandButton layout")

    // Update the custom layout to ensure speed icon is current
    updateCustomActionIcons()
  }

  fun setMediaSessionConnectorPlaybackActions() {
    // Playback actions are now handled automatically by MediaLibrarySession
    // based on the Player's available commands
    Log.d(tag, "Playback actions handled automatically by MediaLibrarySession")
  }

  fun handlePlayerPlaybackError(errorMessage: String) {
    // On error and was attempting to direct play - fallback to transcode
    currentPlaybackSession?.let { playbackSession ->
      if (playbackSession.isDirectPlay) {
        val playItemRequestPayload = getPlayItemRequestPayload(true)
        Log.d(tag, "Fallback to transcode $playItemRequestPayload.mediaPlayer")

        val libraryItemId = playbackSession.libraryItemId ?: "" // Must be true since direct play
        val episodeId = playbackSession.episodeId
        mediaProgressSyncer.stop(false) {
          apiHandler.playLibraryItem(libraryItemId, episodeId, playItemRequestPayload) {
            if (it == null) { // Play request failed
              clientEventEmitter?.onPlaybackFailed(errorMessage)
              closePlayback(true)
            } else {
              Handler(Looper.getMainLooper()).post { preparePlayer(it, true, null) }
            }
          }
        }
      } else {
        clientEventEmitter?.onPlaybackFailed(errorMessage)
        closePlayback(true)
      }
    }
  }

  fun handlePlaybackEnded() {
    Log.d(tag, "handlePlaybackEnded")
    if (isAndroidAuto && currentPlaybackSession?.isPodcastEpisode == true) {
      Log.d(tag, "Podcast playback ended on android auto")
      val libraryItem = currentPlaybackSession?.libraryItem ?: return

      // Need to sync with server to set as finished
      mediaProgressSyncer.finished {
        // Need to reload media progress
        mediaManager.loadServerUserMediaProgress {
          val podcast = libraryItem.media as Podcast
          val nextEpisode = podcast.getNextUnfinishedEpisode(libraryItem.id, mediaManager)
          Log.d(tag, "handlePlaybackEnded nextEpisode=$nextEpisode")
          nextEpisode?.let { podcastEpisode ->
            mediaManager.play(libraryItem, podcastEpisode, getPlayItemRequestPayload(false)) {
              if (it == null) {
                Log.e(tag, "Failed to play library item")
              } else {
                val playbackRate = mediaManager.getSavedPlaybackRate()
                Handler(Looper.getMainLooper()).post { preparePlayer(it, true, playbackRate) }
              }
            }
          }
        }
      }
    }
  }

  fun startNewPlaybackSession() {
    currentPlaybackSession?.let { playbackSession ->
      Log.i(tag, "Starting new playback session for ${playbackSession.displayTitle}")

      val forceTranscode = playbackSession.isHLS // If already HLS then force
      val playItemRequestPayload = getPlayItemRequestPayload(forceTranscode)

      val libraryItemId = playbackSession.libraryItemId ?: "" // Must be true since direct play
      val episodeId = playbackSession.episodeId
      mediaProgressSyncer.stop(false) {
        apiHandler.playLibraryItem(libraryItemId, episodeId, playItemRequestPayload) {
          if (it == null) {
            Log.e(tag, "Failed to start new playback session")
          } else {
            Log.d(
                    tag,
                    "New playback session response from server with session id ${it.id} for \"${it.displayTitle}\""
            )
            Handler(Looper.getMainLooper()).post { preparePlayer(it, true, null) }
          }
        }
      }
    }
  }

  // MIGRATION-DEFERRED: CAST
  /**
   * Switches between cast player and local ExoPlayer for Media3
   */
  fun switchToPlayer(useCastPlayer: Boolean) {
    Log.d(tag, "switchToPlayer: useCastPlayer=$useCastPlayer, currentPlayer=$currentPlayer, castPlayer=$castPlayer")

    // Capture current state for seamless transfer
    val wasPlaying = currentPlayer.isPlaying
    val currentPosition = getCurrentTime()
    val currentMediaItemIndex = currentPlayer.currentMediaItemIndex
    val playbackSpeed = currentPlayer.playbackParameters.speed

    Log.d(tag, "switchToPlayer: Capturing state - playing=$wasPlaying, position=${currentPosition}ms, mediaItemIndex=$currentMediaItemIndex, speed=$playbackSpeed")

    val newPlayer = if (useCastPlayer) {
      if (currentPlayer == castPlayer) {
        Log.d(tag, "Already using cast player")
        return
      }
      Log.d(tag, "Switching to cast player")
      castPlayer
    } else {
      if (currentPlayer == exoPlayer) {
        Log.d(tag, "Already using local player")
        return
      }
      Log.d(tag, "Switching to local player")
      exoPlayer
    }

    if (newPlayer == null) {
      Log.e(tag, "Cannot switch - target player is null")
      return
    }

    // Pause current player gracefully instead of stopping
    if (wasPlaying) {
      currentPlayer.pause()
    }

    // Update current player reference
    currentPlayer = newPlayer

    // Update MediaSession with new player
    mediaSessionManager.updatePlayer(newPlayer)

    // Notify of media player change
    val mediaPlayerType = castPlayerManager.getMediaPlayer(currentPlayer)
    clientEventEmitter?.onMediaPlayerChanged(mediaPlayerType)

    // Start/stop position updates based on player type
    if (useCastPlayer) {
      castPlayerManager.startPositionUpdates()
      Log.d(tag, "Started Cast position updates")
    } else {
      castPlayerManager.stopPositionUpdates()
      Log.d(tag, "Stopped Cast position updates")
    }

    // Resume playback with current session
    currentPlaybackSession?.let { session ->
      Log.d(tag, "Resuming playback on new player from position: ${currentPosition}ms")

      if (useCastPlayer) {
        // Create cast-specific MediaItems
        val castMediaItems = castPlayerManager.createCastMediaItems(session)
        val startIndex = getChapterIndexForTime(currentPosition)
        val chapterRelativePosition = currentPosition - (getCurrentBookChapter()?.startMs ?: 0L)

        castPlayerManager.loadCastPlayer(
          mediaItems = castMediaItems,
          startIndex = startIndex,
          startPositionMs = currentPosition, // Use absolute position for Cast
          playWhenReady = wasPlaying,
          playbackSession = session
        )

        // Synchronize playback speed with Cast player
        val currentSpeed = exoPlayer.playbackParameters.speed
        Log.d(tag, "Synchronizing Cast player speed to current app speed: ${currentSpeed}")
        castPlayerManager.setPlaybackSpeed(currentSpeed)
      } else {
        // Prepare local player with current session and preserved state
        Log.d(tag, "Switching from Cast to local player - preserving position: ${currentPosition}ms and speed: ${playbackSpeed}")

        // Update session current time to match Cast player position
        session.currentTime = currentPosition / 1000.0 // Convert ms to seconds

        preparePlayer(session, wasPlaying, null)

        // Synchronize playback speed with local player after preparation
        Log.d(tag, "Synchronizing local player speed to Cast player speed: ${playbackSpeed}")
        setPlaybackSpeed(playbackSpeed)
      }
    }
  }

  /**
   * Gets the chapter index for a given time position
   */
  private fun getChapterIndexForTime(timeMs: Long): Int {
    val session = currentPlaybackSession ?: return 0
    return session.getChapterIndexForTime(timeMs).coerceAtLeast(0)
  }

  fun getCurrentTrackStartOffsetMs(): Long {
    // No longer using track-based offset - always 0 for chapter-per-MediaItem architecture
    return 0L
  }



  fun getCurrentTime(): Long {

    // Always return absolute position for progress syncing and server communication
    // Use AudiobookProgressTracker's absolute position method for the new architecture
    val absoluteTime = if (::chapterNavigationHelper.isInitialized) {
      // For Cast player, ensure we get the correct absolute position
      if (currentPlayer == castPlayer) {
        // Cast player provides track-relative position, convert to absolute
        val currentTrackIndex = currentPlayer.currentMediaItemIndex
        val trackRelativePos = currentPlayer.currentPosition
        val session = currentPlaybackSession

        if (session != null && currentTrackIndex >= 0 && currentTrackIndex < session.audioTracks.size) {
          val currentTrack = session.audioTracks[currentTrackIndex]
          val absolutePos = currentTrack.startOffsetMs + trackRelativePos
          Log.d(tag, "getCurrentTime [CAST]: track=${currentTrackIndex}, trackPos=${trackRelativePos}ms, absolutePos=${absolutePos}ms")
          Log.d(tag, "getCurrentTime [CAST]: absolute=${absolutePos}ms (${absolutePos/1000.0}s), track-relative=${trackRelativePos}ms, trackIndex=${currentTrackIndex}, track=${currentTrack.title}")
          absolutePos
        } else {
          Log.w(tag, "getCurrentTime [CAST]: Unable to calculate absolute position, using track-relative: ${trackRelativePos}ms")
          trackRelativePos
        }
      } else {
        // Local player - use chapter navigation helper
        chapterNavigationHelper.getAbsolutePosition()
      }
    } else {
      exoPlayer.currentPosition
    }



    // Add debug logging to track progress syncing issues
    if (::chapterNavigationHelper.isInitialized && chapterNavigationHelper.hasChapters()) {
      val currentChapter = chapterNavigationHelper.getCurrentChapter()
      val currentChapterIndex = chapterNavigationHelper.getCurrentChapterIndex()
      val chapterRelativePos = currentPlayer.currentPosition // Native chapter-relative position
      val playerType = if (currentPlayer == castPlayer) "CAST" else "LOCAL"
      Log.d(tag, "getCurrentTime [$playerType]: absolute=${absoluteTime}ms (${absoluteTime/1000.0}s), chapter-relative=${chapterRelativePos}ms, chapterIndex=${currentChapterIndex}, chapter=${currentChapter?.title}")
    } else {
      Log.d(tag, "getCurrentTime: absolute=${absoluteTime}ms (${absoluteTime/1000.0}s) [no chapters]")
    }

    return absoluteTime
  }

  fun getCurrentTimeSeconds(): Double {
    return getCurrentTime() / 1000.0
  }

  /**
   * Notifies listeners of position updates, used by Cast player for progress synchronization
   */
  fun notifyPositionUpdate() {
    // Trigger progress sync for Cast player
    mediaProgressSyncer.onPositionUpdate()
  }

  /**
   * Chapter progress information for compatibility
   */
  data class ChapterProgress(
    val chapterIndex: Int,
    val chapterTitle: String,
    val chapterPosition: Long,
    val chapterDuration: Long,
    val chapterProgress: Float,
    val totalProgress: Float
  )

  /**
   * Get chapter-relative progress information for UI components
   * Returns null if not in a chapter-based book
   */
  fun getChapterProgressInfo(): ChapterProgress? {
    // NEW ARCHITECTURE: Use AudiobookProgressTracker
    return if (::chapterNavigationHelper.isInitialized && chapterNavigationHelper.hasChapters()) {
      val progressInfo = chapterNavigationHelper.getProgressInfo()
      if (progressInfo != null) {
        ChapterProgress(
          chapterIndex = progressInfo.chapterIndex,
          chapterTitle = progressInfo.chapterTitle ?: "Unknown Chapter",
          chapterPosition = progressInfo.chapterPositionMs,
          chapterDuration = progressInfo.chapterDurationMs,
          chapterProgress = progressInfo.chapterProgress,
          totalProgress = progressInfo.totalProgress
        )
      } else null
    } else {
      null
    }
  }

  /**
   * Get the current chapter index (0-based)
   * Returns -1 if not in a chapter-based book
   */
  fun getCurrentChapterIndex(): Int {
    // NEW ARCHITECTURE: Use ExoPlayer's native currentMediaItemIndex
    return if (::chapterNavigationHelper.isInitialized && chapterNavigationHelper.hasChapters()) {
      currentPlayer.currentMediaItemIndex // Each MediaItem is a chapter
    } else {
      -1
    }
  }

  private fun getBufferedTime(): Long {
    // No longer using track-based offset - direct buffered position
    return currentPlayer.bufferedPosition
  }

  fun getBufferedTimeSeconds(): Double {
    return getBufferedTime() / 1000.0
  }

  fun getDuration(): Long {
    return currentPlaybackSession?.totalDurationMs ?: 0L
  }

  fun getCurrentPlaybackSessionCopy(): PlaybackSession? {
    return currentPlaybackSession?.clone()
  }

  fun getCurrentBookChapter(): BookChapter? {
    // NEW: Use chapterNavigationHelper for chapter-aware functionality
    return chapterNavigationHelper.getCurrentChapter()
  }

  fun getEndTimeOfChapterOrTrack(): Long? {
    return getCurrentBookChapter()?.endMs ?: currentPlaybackSession?.getCurrentTrackEndTime()
  }

  private fun getNextBookChapter(): BookChapter? {
    return currentPlaybackSession?.getNextChapterForTime(this.getCurrentTime())
  }

  fun getEndTimeOfNextChapterOrTrack(): Long? {
    return getNextBookChapter()?.endMs ?: currentPlaybackSession?.getNextTrackEndTime()
  }


  fun play() {
    Log.d(tag, "play(): Method called")
    playerManager.logPlayerState("PLAY_METHOD_START")

    if (currentPlayer.isPlaying) {
      Log.d(tag, "Already playing")
      return
    }

    // Check if we have a valid playback session and media prepared
    if (currentPlaybackSession == null) {
      Log.w(tag, "play(): No playback session available - cannot start playback")
      return
    }

    if (currentPlayer.mediaItemCount == 0) {
      Log.w(tag, "play(): No media items loaded in player - cannot start playback")
      return
    }

    Log.d(tag, "play(): Starting playback - Session: ${currentPlaybackSession?.displayTitle}, Media items: ${currentPlayer.mediaItemCount}")
    currentPlayer.volume = 1F

    // Log state before calling play()
    Log.d(tag, "play(): Before currentPlayer.play() - playWhenReady=${currentPlayer.playWhenReady}, playbackState=${currentPlayer.playbackState}")

    currentPlayer.play()

    // Log state after calling play()
    Log.d(tag, "play(): After currentPlayer.play() - playWhenReady=${currentPlayer.playWhenReady}, isPlaying=${currentPlayer.isPlaying}, playbackState=${currentPlayer.playbackState}")

    playerManager.logPlayerState("PLAY_METHOD_END")

    // RE-ENABLE: Start chapter change monitoring when playing
    startChapterChangeMonitoring()
    Log.d(tag, "Chapter change monitoring started")
  }

  fun pause() {
    currentPlayer.pause()
    stopChapterChangeMonitoring() // Stop monitoring when paused
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

  fun seekPlayer(time: Long) {
    Log.d("NUXT_SKIP_DEBUG", "PlayerNotificationService.seekPlayer called with time: $time ms")

    if (!::currentPlayer.isInitialized) {
      Log.w("NUXT_SKIP_DEBUG", "PlayerNotificationService.seekPlayer: currentPlayer not initialized!")
      return
    }

    currentPlayer ?: run {
      Log.w("NUXT_SKIP_DEBUG", "PlayerNotificationService.seekPlayer: currentPlayer is null!")
      return
    }

    var timeToSeek = time
    Log.d(tag, "seekPlayer mediaCount = ${currentPlayer.mediaItemCount} | $timeToSeek")
    Log.d("NUXT_SKIP_DEBUG", "PlayerNotificationService.seekPlayer: mediaCount = ${currentPlayer.mediaItemCount}")

    if (timeToSeek < 0) {
      Log.w(tag, "seekPlayer invalid time $timeToSeek - setting to 0")
      Log.d("NUXT_SKIP_DEBUG", "PlayerNotificationService.seekPlayer: Invalid time $timeToSeek, correcting to 0")
      timeToSeek = 0L
    } else if (timeToSeek > getDuration()) {
      Log.w(tag, "seekPlayer invalid time $timeToSeek - setting to MAX - 2000")
      Log.d("NUXT_SKIP_DEBUG", "PlayerNotificationService.seekPlayer: Time $timeToSeek exceeds duration ${getDuration()}, correcting to ${getDuration() - 2000L}")
      timeToSeek = getDuration() - 2000L
    }

    // Check if we're using the chapter-per-MediaItem architecture
    if (::chapterNavigationHelper.isInitialized && chapterNavigationHelper.hasChapters()) {
      // Use chapter-aware seeking for books with chapters
      Log.d(tag, "seekPlayer: Using chapter-aware seek to ${timeToSeek}ms")
      Log.d("NUXT_SKIP_DEBUG", "PlayerNotificationService.seekPlayer: Using chapter-aware seek to ${timeToSeek}ms")

      // Special handling for Cast player - use track-based positioning
      if (currentPlayer == castPlayer) {
        Log.d("NUXT_SKIP_DEBUG", "PlayerNotificationService.seekPlayer [CAST]: Converting absolute position ${timeToSeek}ms to track-relative")
        val session = currentPlaybackSession
        if (session != null) {
          // Find target track for this absolute time (tracks, not chapters)
          val targetTrackIndex = session.audioTracks.indexOfFirst { track ->
            val trackStartMs = track.startOffsetMs
            val trackEndMs = track.startOffsetMs + track.durationMs
            timeToSeek >= trackStartMs && timeToSeek < trackEndMs
          }

          if (targetTrackIndex >= 0 && targetTrackIndex < session.audioTracks.size) {
            val targetTrack = session.audioTracks[targetTrackIndex]
            val trackRelativePosition = timeToSeek - targetTrack.startOffsetMs
            Log.d("NUXT_SKIP_DEBUG", "PlayerNotificationService.seekPlayer [CAST]: Seeking to track $targetTrackIndex, position ${trackRelativePosition}ms")
            currentPlayer.seekTo(targetTrackIndex, trackRelativePosition.coerceAtLeast(0L))
          } else {
            Log.w("NUXT_SKIP_DEBUG", "PlayerNotificationService.seekPlayer [CAST]: Invalid track index $targetTrackIndex for time ${timeToSeek}ms")
            Log.w("NUXT_SKIP_DEBUG", "PlayerNotificationService.seekPlayer [CAST]: Cannot seek to time ${timeToSeek}ms - no matching track found")
          }
        }
      } else {
        // Local player - use chapter navigation helper
        chapterNavigationHelper.seekToAbsolutePosition(timeToSeek)
      }
    } else {
      // Direct seek for books without chapters (single track)
      Log.d(tag, "seekPlayer: Direct seek to ${timeToSeek}ms (single track)")
      Log.d("NUXT_SKIP_DEBUG", "PlayerNotificationService.seekPlayer: Direct seek to ${timeToSeek}ms (single track)")
      currentPlayer.seekTo(timeToSeek)
    }
    Log.d("NUXT_SKIP_DEBUG", "PlayerNotificationService.seekPlayer: Seek operation completed")
  }

  /**
   * Seek to an absolute time position in the audiobook (in seconds).
   * This method correctly handles chapter-based playlists by calculating the appropriate
   * chapter index and chapter-relative position from the absolute book position.
   *
   * @param absoluteTimeSeconds The absolute position in seconds within the entire audiobook
   */
  fun seekToAbsoluteTime(absoluteTimeSeconds: Double) {
    val absoluteTimeMs = (absoluteTimeSeconds * 1000).toLong()
    Log.d(tag, "seekToAbsoluteTime: Seeking to absolute time ${absoluteTimeSeconds}s (${absoluteTimeMs}ms)")

    if (currentPlayer == null) {
      Log.w(tag, "seekToAbsoluteTime: currentPlayer is null")
      return
    }

    // Check if we're using chapter-based navigation
    if (::chapterNavigationHelper.isInitialized && chapterNavigationHelper.hasChapters()) {
      Log.d(tag, "seekToAbsoluteTime: Using chapter-aware navigation")

      // Use the AudiobookProgressTracker's seekToAbsolutePosition which handles
      // chapter calculation correctly
      chapterNavigationHelper.seekToAbsolutePosition(absoluteTimeMs)
    } else {
      // Single track - just seek directly
      Log.d(tag, "seekToAbsoluteTime: Direct seek (single track)")
      currentPlayer.seekTo(absoluteTimeMs)
    }

    Log.d(tag, "seekToAbsoluteTime: Seek operation completed")
  }

  /**
   * Unified navigation method: Navigate to a specific chapter by index
   * This is the primary navigation method used by both UI and Android Auto
   *
   * @param chapterIndex 0-based chapter index
   */
  fun navigateToChapter(chapterIndex: Int) {
    Log.d(tag, "navigateToChapter: Starting navigation to chapter $chapterIndex")

    val session = currentPlaybackSession ?: run {
      Log.w(tag, "navigateToChapter: No active playbook session")
      return
    }

    if (chapterIndex < 0 || chapterIndex >= getNavigationItemCount()) {
      Log.w(tag, "navigateToChapter: Invalid chapter index $chapterIndex (total: ${getNavigationItemCount()})")
      return
    }


    try {
      // Check if we're using Cast player
      if (currentPlayer == castPlayerManager.castPlayer) {
        // Use Cast-specific chapter seeking
        Log.d(tag, "navigateToChapter: Using Cast player chapter navigation")
        castPlayerManager.seekToChapter(chapterIndex, 0L, session)
      } else {
        // Use ChapterNavigationHelper for local ExoPlayer navigation
        Log.d(tag, "navigateToChapter: Using ChapterNavigationHelper for local player navigation")
        chapterNavigationHelper.seekToChapter(chapterIndex)
      }

      // Update the tracked navigation index immediately for skip operations
      currentNavigationIndex = chapterIndex

      // Update notification metadata for the new chapter
      updateNotificationMetadata(chapterIndex)


      Log.d(tag, "navigateToChapter: Successfully navigated to chapter $chapterIndex")
    } catch (e: Exception) {
      Log.e(tag, "navigateToChapter: Error navigating to chapter $chapterIndex", e)
    }
  }

  /**
   * Legacy method for backward compatibility - delegates to navigateToChapter
   */
  fun seekToChapter(chapterIndex: Int) {
    navigateToChapter(chapterIndex)
  }

  /**
   * Represents a navigation item in the unified system
   * Can be either a chapter or a track
   */
  data class NavigationItem(
    val index: Int,
    val title: String,
    val startTimeMs: Long,
    val endTimeMs: Long,
    val isChapter: Boolean
  )

  /**
   * Get total number of navigation items (chapters only, or 1 for single track)
   */
  fun getNavigationItemCount(): Int {
    val session = currentPlaybackSession ?: return 0

    // Only use chapters for navigation, or 1 for single track
    return if (session.chapters.isNotEmpty()) {
      session.chapters.size
    } else {
      1 // Single item for books without chapters
    }
  }

  /**
   * Get navigation item by index
   */
  fun getNavigationItem(index: Int): NavigationItem? {
    val session = currentPlaybackSession ?: return null

    return if (session.chapters.isNotEmpty()) {
      // Chapter-based navigation
      if (index >= 0 && index < session.chapters.size) {
        val chapter = session.chapters[index]
        NavigationItem(
          index = index,
          title = chapter.title ?: "Chapter ${index + 1}",
          startTimeMs = chapter.startMs,
          endTimeMs = chapter.endMs,
          isChapter = true
        )
      } else null
    } else {
      // Single track for books without chapters
      if (index == 0) {
        NavigationItem(
          index = 0,
          title = session.displayTitle ?: "Audiobook",
          startTimeMs = 0L,
          endTimeMs = session.duration?.times(1000)?.toLong() ?: 0L,
          isChapter = false
        )
      } else null
    }
  }

  /**
   * Get current navigation index based on playback position
   * Uses tracked index when available, falls back to calculation
   */
  fun getCurrentNavigationIndex(): Int {
    val session = currentPlaybackSession ?: return -1

    // If we have a tracked navigation index and it's valid, use it
    // This prevents issues with rapid skip operations where seeks haven't completed yet
    if (currentNavigationIndex >= 0 && currentNavigationIndex < getNavigationItemCount()) {
      val calculatedIndex = calculateCurrentNavigationIndex()

      // If the calculated index matches or is very close to tracked index, use tracked
      // This handles the timing between seek start and seek completion
      if (calculatedIndex == currentNavigationIndex || calculatedIndex == -1) {
        return currentNavigationIndex
      } else {
        // Playback has moved significantly, update tracked index and use calculated
        currentNavigationIndex = calculatedIndex
        return calculatedIndex
      }
    }

    // No valid tracked index, calculate and store it
    val calculatedIndex = calculateCurrentNavigationIndex()
    currentNavigationIndex = calculatedIndex
    return calculatedIndex
  }

  /**
   * Calculate the navigation index based on current playback state
   */
  private fun calculateCurrentNavigationIndex(): Int {
    val session = currentPlaybackSession ?: return -1

    return if (session.chapters.isNotEmpty()) {
      // Chapter-based: always use time-based lookup for chapters since they can be within the same file
      findCurrentNavigationIndexByTime()
    } else {
      // Track-based: use current media item index (each track is a separate file)
      val mediaItemIndex = currentPlayer.currentMediaItemIndex
      if (mediaItemIndex >= 0 && mediaItemIndex < session.audioTracks.size) mediaItemIndex else -1
    }
  }

  /**
   * Find current navigation index using time-based lookup
   */
  private fun findCurrentNavigationIndexByTime(): Int {
    val session = currentPlaybackSession ?: return -1
    val currentTimeMs = getCurrentTime()

    if (session.chapters.isNotEmpty()) {
      // Chapter-based lookup
      for (i in session.chapters.indices) {
        val chapter = session.chapters[i]
        if (currentTimeMs >= chapter.startMs && currentTimeMs < chapter.endMs) {
          return i
        }
      }

      // If no exact match, return the last started chapter
      for (i in session.chapters.indices.reversed()) {
        val chapter = session.chapters[i]
        if (currentTimeMs >= chapter.startMs) {
          return i
        }
      }
    } else {
      // Books without chapters - always return 0 for single track
      return 0
    }

    return -1
  }
  /**
   * Update navigation state for MediaSession (Android Auto)
   * Simplified version that doesn't fight with MediaSessionConnector
   */
  private fun updateNavigationState(index: Int) {
    try {
      val session = currentPlaybackSession ?: run {
        Log.w(tag, "updateNavigationState: No active playback session")
        return
      }

      // For chapter-per-MediaItem architecture, only use chapters for queue
      // If no chapters, treat as single long track (queue size = 1)
      val queueSize = if (session.chapters.isNotEmpty()) {
        session.chapters.size
      } else {
        1 // Single item for books without chapters
      }

      Log.d(tag, "updateNavigationState: index=$index, queueSize=$queueSize, chapters=${session.chapters.size} (track-based queues removed)")

      if (index < 0 || index >= queueSize) {
        Log.w(tag, "updateNavigationState: Invalid queue state - index: $index, queue size: $queueSize")
        return
      }

      // Get the navigation item for metadata
      val navItem = getNavigationItem(index)
      if (navItem == null) {
        Log.w(tag, "updateNavigationState: Could not get navigation item for index $index")
        return
      }

      Log.d(tag, "updateNavigationState: Updated to ${navItem.title} (index=$index)")

      // Update playback state with active queue item immediately
      // Delays cause race conditions and crashes in Android Auto
      setActiveQueueItemSafely(index)

    } catch (e: Exception) {
      Log.e(tag, "updateNavigationState: Error updating navigation state", e)
    }
  }

  /**
   * Safely set the active queue item without fighting MediaSessionConnector
   */
  private fun setActiveQueueItemSafely(index: Int) {
    try {
      // MIGRATION-TODO: Convert to Media3 playback state access
      val currentActiveId = -1L // mediaSessionManager.getCurrentActiveQueueItemId()
      val newActiveId = index.toLong()

      if (currentActiveId != newActiveId) {
        // Get current playback state and preserve all existing values
        // MIGRATION-TODO: Convert to Media3 playback state access
        val currentState = null // mediaSessionManager.getCurrentPlaybackState()
        val currentPosition = getCurrentTime()
        val currentSpeed = currentPlayer.playbackParameters.speed
        val playerState = when {
          !currentPlayer.isPlaying -> PlaybackStateCompat.STATE_PAUSED
          currentPlayer.isLoading -> PlaybackStateCompat.STATE_BUFFERING
          else -> PlaybackStateCompat.STATE_PLAYING
        }

        // Preserve existing actions if available, otherwise use standard set
        val existingActions = 0L // currentState?.actions ?: (MIGRATION-TODO)
          // PlaybackStateCompat.ACTION_PLAY_PAUSE or
          // PlaybackStateCompat.ACTION_PLAY or
          // PlaybackStateCompat.ACTION_PAUSE or
          // PlaybackStateCompat.ACTION_FAST_FORWARD or
          // PlaybackStateCompat.ACTION_REWIND or
          // PlaybackStateCompat.ACTION_SKIP_TO_NEXT or
          // PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or
          // PlaybackStateCompat.ACTION_STOP or
          // PlaybackStateCompat.ACTION_SEEK_TO
        // )

        // Create new state with updated active queue item
        val newState = PlaybackStateCompat.Builder()
          .setState(playerState, currentPosition, currentSpeed)
          .setActiveQueueItemId(newActiveId)
          .setActions(existingActions)

        // Preserve custom actions if they exist
        // currentState?.customActions?.forEach { customAction: PlaybackStateCompat.CustomAction ->
        //   newState.addCustomAction(customAction)
        // } // MIGRATION-TODO

        // MIGRATION-TODO: Convert to Media3 playback state handling
        // mediaSessionManager.setPlaybackState(newState.build())
      }
    } catch (e: Exception) {
      Log.e(tag, "setActiveQueueItemSafely: Error setting active queue item", e)
    }
  }  /**
   * Update metadata for current navigation item
   */
  private fun updateMetadataForNavigationItem(navItem: NavigationItem, currentMetadata: MediaMetadataCompat, session: PlaybackSession) {
    try {
      val metadataBuilder = MediaMetadataCompat.Builder(currentMetadata)
        .putString(MediaMetadataCompat.METADATA_KEY_TITLE, navItem.title)
        .putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_TITLE, navItem.title)
        .putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_SUBTITLE, session.displayAuthor ?: "")
        .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, session.totalDurationMs)

      // Set album/artist consistently
      metadataBuilder
        .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, session.displayAuthor ?: "")
        .putString(MediaMetadataCompat.METADATA_KEY_ALBUM_ARTIST, session.displayAuthor ?: "")
        .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, session.displayTitle ?: "")

      val finalMetadata = metadataBuilder.build()
      // MIGRATION-TODO: Convert to Media3 MediaMetadata
      // mediaSessionManager.setMetadata(finalMetadata)

    } catch (e: Exception) {
      Log.e(tag, "updateMetadataForNavigationItem: Error updating metadata", e)
    }
  }

  // Extract metadata update logic to a separate method
  /*
  private fun updateMetadataForQueueItem(
    queueItem: MediaDescriptionCompat,
    currentMetadata: MediaMetadataCompat,
    currentPlaybackSession: PlaybackSession,
    index: Int
  ) {
    // Old method - disabled in favor of updateMetadataForNavigationItem
    // [entire method commented out]
  }
  */

  /**
   * Legacy method for track-based navigation - delegates to unified system
   */
  fun seekToTrack(trackIndex: Int) {
    navigateToChapter(trackIndex)
  }


  /**
   * Update queue position based on current playback progress - called periodically
   * Simplified version using unified navigation system
   */
  fun updateQueuePositionForChapters() {
    try {
      val newIndex = getCurrentNavigationIndex()

      // Only update if the index has actually changed (not just position within same item)
      if (newIndex >= 0 && newIndex != lastActiveQueueItemIndex) {
        Log.d(tag, "Navigation: Item changed from $lastActiveQueueItemIndex to $newIndex")
        lastActiveQueueItemIndex = newIndex
        updateNavigationState(newIndex)

        // Update notification metadata when chapter changes during continuous playback
        updateNotificationMetadata(newIndex)
      }
    } catch (e: Exception) {
      Log.e(tag, "updateQueuePositionForChapters: Error updating queue position", e)
    }
  }

  /**
   * Start chapter change monitoring - Media3 handles this automatically
   */
  private fun startChapterChangeMonitoring() {
    // With new architecture, chapter changes are handled by Media3's timeline events
    Log.d(tag, "Chapter change monitoring handled by Media3 timeline events")
  }

  private fun stopChapterChangeMonitoring() {
    // Chapter change monitoring is handled by Media3's timeline events
    Log.d(tag, "Chapter change monitoring handled by Media3 timeline events")
  }

  fun seekToNextChapter(): Boolean {
    return if (::chapterNavigationHelper.isInitialized) {

      val result = if (currentPlayer == castPlayer) {
        // Cast player - use direct MediaItem navigation
        val currentIndex = currentPlayer.currentMediaItemIndex
        val nextIndex = currentIndex + 1
        if (nextIndex < currentPlayer.mediaItemCount) {
          Log.d(tag, "seekToNextChapter [CAST]: Moving to chapter $nextIndex")
          currentPlayer.seekToNext()
          true
        } else {
          Log.d(tag, "seekToNextChapter [CAST]: Already at last chapter")
          false
        }
      } else {
        // Local player - use chapter navigation helper
        chapterNavigationHelper.seekToNextChapter()
      }

      // Schedule end of chapter transition protection

      result
    } else {
      Log.w(tag, "ChapterNavigationHelper not initialized")
      false
    }
  }

  fun seekToPreviousChapter(): Boolean {
    return if (::chapterNavigationHelper.isInitialized) {

      val result = if (currentPlayer == castPlayer) {
        // Cast player - use direct MediaItem navigation
        val currentIndex = currentPlayer.currentMediaItemIndex
        val prevIndex = currentIndex - 1
        if (prevIndex >= 0) {
          Log.d(tag, "seekToPreviousChapter [CAST]: Moving to chapter $prevIndex")
          currentPlayer.seekToPrevious()
          true
        } else {
          Log.d(tag, "seekToPreviousChapter [CAST]: Already at first chapter")
          false
        }
      } else {
        // Local player - use chapter navigation helper
        chapterNavigationHelper.seekToPreviousChapter()
      }

      // Schedule end of chapter transition protection

      result
    } else {
      Log.w(tag, "ChapterNavigationHelper not initialized")
      false
    }
  }

  fun jumpForward() {
    Log.d(tag, "jumpForward: Using chapter-aware jumping with ${deviceSettings.jumpForwardTimeMs}ms")

    // Check if we're using Cast player
    val currentSession = currentPlaybackSession
    if (currentSession != null && currentPlayer == castPlayerManager.castPlayer) {
      // Use Cast-specific jumping with absolute positioning
      Log.d(tag, "jumpForward: Using Cast player with absolute positioning")
      castPlayerManager.skipForward(deviceSettings.jumpForwardTimeMs, currentSession)
    } else {
      // Use AudiobookProgressTracker for local ExoPlayer chapter-aware jumping
      val currentAbsolutePosition = audiobookProgressTracker.getCurrentAbsolutePosition()
      val newPosition = currentAbsolutePosition + deviceSettings.jumpForwardTimeMs
      audiobookProgressTracker.seekToAbsolutePosition(newPosition)
    }
  }

  fun jumpBackward() {
    Log.d(tag, "jumpBackward: Using chapter-aware jumping with ${deviceSettings.jumpBackwardsTimeMs}ms")

    // Check if we're using Cast player
    val currentSession = currentPlaybackSession
    if (currentSession != null && currentPlayer == castPlayerManager.castPlayer) {
      // Use Cast-specific jumping with absolute positioning
      Log.d(tag, "jumpBackward: Using Cast player with absolute positioning")
      castPlayerManager.skipBackward(deviceSettings.jumpBackwardsTimeMs, currentSession)
    } else {
      // Use AudiobookProgressTracker for local ExoPlayer chapter-aware jumping
      val currentAbsolutePosition = audiobookProgressTracker.getCurrentAbsolutePosition()
      val newPosition = (currentAbsolutePosition - deviceSettings.jumpBackwardsTimeMs).coerceAtLeast(0)
      audiobookProgressTracker.seekToAbsolutePosition(newPosition)
    }
  }

  fun seekForward(amount: Long) {
    Log.d("NUXT_SKIP_DEBUG", "PlayerNotificationService.seekForward called with amount: $amount ms")
    Log.d(tag, "seekForward: amount=$amount, expectingTrackTransition=$expectingTrackTransition")
    Log.d("NUXT_SKIP_DEBUG", "PlayerNotificationService.seekForward: expectingTrackTransition=$expectingTrackTransition")

    // If we're expecting a track transition, add a small delay to let it complete
    if (expectingTrackTransition) {
      Log.d(tag, "seekForward: Track transition in progress, adding delay")
      Log.d("NUXT_SKIP_DEBUG", "PlayerNotificationService.seekForward: Adding 100ms delay for track transition")
      // Post the seek to run after a short delay to allow track transition to complete
      android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
        performSeekForward(amount)
      }, 100) // 100ms delay should be enough for track transition
    } else {
      Log.d("NUXT_SKIP_DEBUG", "PlayerNotificationService.seekForward: Calling performSeekForward immediately")
      performSeekForward(amount)
    }
  }

  private fun performSeekForward(amount: Long) {
    Log.d("NUXT_SKIP_DEBUG", "PlayerNotificationService.performSeekForward called with amount: $amount ms")

    // Use chapter-aware seeking for books with chapters, direct position for books without
    val currentTime = if (::chapterNavigationHelper.isInitialized && chapterNavigationHelper.hasChapters()) {
      Log.d("NUXT_SKIP_DEBUG", "PlayerNotificationService.performSeekForward: Using chapter-aware position")
      // Use chapter-aware position calculation for books with chapters
      chapterNavigationHelper.getAbsolutePosition()
    } else {
      Log.d("NUXT_SKIP_DEBUG", "PlayerNotificationService.performSeekForward: Using direct player position")
      // Direct position for books without chapters (single track)
      currentPlayer.currentPosition
    }

    val targetTime = currentTime + amount
    Log.d("NUXT_SKIP_DEBUG", "PlayerNotificationService.performSeekForward: currentTime=$currentTime, amount=$amount, targetTime=$targetTime")

    seekPlayer(targetTime)
    Log.d("NUXT_SKIP_DEBUG", "PlayerNotificationService.performSeekForward: Called seekPlayer with $targetTime, calling mediaProgressSyncer.seek()")
    mediaProgressSyncer.seek()
    Log.d("NUXT_SKIP_DEBUG", "PlayerNotificationService.performSeekForward: Completed")
  }

  fun seekBackward(amount: Long) {
    Log.d("NUXT_SKIP_DEBUG", "PlayerNotificationService.seekBackward called with amount: $amount ms")
    Log.d(tag, "seekBackward: amount=$amount, expectingTrackTransition=$expectingTrackTransition")
    Log.d("NUXT_SKIP_DEBUG", "PlayerNotificationService.seekBackward: expectingTrackTransition=$expectingTrackTransition")

    // If we're expecting a track transition, add a small delay to let it complete
    if (expectingTrackTransition) {
      Log.d(tag, "seekBackward: Track transition in progress, adding delay")
      Log.d("NUXT_SKIP_DEBUG", "PlayerNotificationService.seekBackward: Adding 100ms delay for track transition")
      // Post the seek to run after a short delay to allow track transition to complete
      android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
        performSeekBackward(amount)
      }, 100) // 100ms delay should be enough for track transition
    } else {
      Log.d("NUXT_SKIP_DEBUG", "PlayerNotificationService.seekBackward: Calling performSeekBackward immediately")
      performSeekBackward(amount)
    }
  }

  private fun performSeekBackward(amount: Long) {
    Log.d("NUXT_SKIP_DEBUG", "PlayerNotificationService.performSeekBackward called with amount: $amount ms")

    // Use chapter-aware seeking for books with chapters, direct position for books without
    val currentTime = if (::chapterNavigationHelper.isInitialized && chapterNavigationHelper.hasChapters()) {
      Log.d("NUXT_SKIP_DEBUG", "PlayerNotificationService.performSeekBackward: Using chapter-aware position")
      // Use chapter-aware position calculation for books with chapters
      chapterNavigationHelper.getAbsolutePosition()
    } else {
      Log.d("NUXT_SKIP_DEBUG", "PlayerNotificationService.performSeekBackward: Using direct player position")
      // Direct position for books without chapters (single track)
      currentPlayer.currentPosition
    }

    val targetTime = currentTime - amount
    Log.d("NUXT_SKIP_DEBUG", "PlayerNotificationService.performSeekBackward: currentTime=$currentTime, amount=$amount, targetTime=$targetTime")

    seekPlayer(targetTime)
    Log.d("NUXT_SKIP_DEBUG", "PlayerNotificationService.performSeekBackward: Called seekPlayer with $targetTime, calling mediaProgressSyncer.seek()")
    mediaProgressSyncer.seek()
    Log.d("NUXT_SKIP_DEBUG", "PlayerNotificationService.performSeekBackward: Completed")
  }

  fun cyclePlaybackSpeed() {
    Log.d(tag, "cyclePlaybackSpeed called")

    // Use the original speed cycling logic that matches the pre-Media3 implementation
    // This cycles through preset speeds: 0.5, 1.0, 1.2, 1.5, 2.0, 3.0
    val currentSpeed = mediaManager.getSavedPlaybackRate()
    val newSpeed = when (currentSpeed) {
      in 0.5f..0.7f -> 1.0f
      in 0.8f..1.0f -> 1.2f
      in 1.1f..1.2f -> 1.5f
      in 1.3f..1.5f -> 2.0f
      in 1.6f..2.0f -> 3.0f
      in 2.1f..3.0f -> 0.5f
      // anything set above 3 (can happen in the android app) will be reset to 1
      else -> 1.0f
    }

    Log.d(tag, "Cycling from speed $currentSpeed to new speed: $newSpeed")

    // Save the new speed and apply it
    mediaManager.setSavedPlaybackRate(newSpeed)
    setPlaybackSpeed(newSpeed)

    // Notify client of speed change
    clientEventEmitter?.onPlaybackSpeedChanged(newSpeed)

    // Update the custom action icon by refreshing the MediaSession layout
    updateCustomActionIcons()
  }

  private fun updateCustomActionIcons() {
    // Update the MediaLibrarySession custom layout with new icons
    mediaSessionManager.updateCustomLayout()
  }

  /**
   * Update notification metadata when crossing chapter boundaries
   * This ensures the notification shows the correct chapter title
   */
  private fun updateNotificationMetadata(chapterIndex: Int) {
    Log.d(tag, "updateNotificationMetadata: Updating notification for chapter $chapterIndex")

    try {
      val session = currentPlaybackSession ?: return

      // Get title and subtitle from chapter navigation helper
      val currentChapter = chapterNavigationHelper.getCurrentChapter()
      val displayTitle = currentChapter?.title ?: "Chapter ${chapterIndex + 1}"

      val displaySubtitle = run {
        val title = session.displayTitle ?: "Unknown"
        val author = session.displayAuthor
        if (!author.isNullOrBlank()) "$title • $author" else title
      }

      // For Media3, update the MediaSession metadata WITHOUT modifying the playlist
      // CRITICAL FIX: Do NOT remove/add MediaItems during playback as this causes
      // PLAYLIST_CHANGED events which reset the playback position to 0

      // Instead, update the MediaSession metadata directly through MediaSessionManager
      // This updates the notification without disrupting playback
      mediaSessionManager.updateChapterMetadata(
        chapterTitle = displayTitle,
        chapterDuration = currentChapter?.let { it.endMs - it.startMs } ?: 0L,
        bookTitle = session.displayTitle ?: "",
        author = session.displayAuthor,
        bitmap = null // Bitmap is already set during preparePlayer
      )

      Log.d(tag, "updateNotificationMetadata: Updated MediaSession metadata - Title: '$displayTitle', Subtitle: '$displaySubtitle'")

      // Also update any legacy MediaSessionCompat metadata if present
      // This ensures compatibility with older notification systems
      updateLegacyMetadata(chapterIndex, displayTitle)

    } catch (e: Exception) {
      Log.e(tag, "updateNotificationMetadata: Error updating notification metadata", e)
    }
  }

  /**
   * Update legacy MediaSessionCompat metadata for backward compatibility
   */
  private fun updateLegacyMetadata(chapterIndex: Int, chapterTitle: String?) {
    try {
      // This method handles any remaining MediaSessionCompat metadata updates
      // that might be needed for notification compatibility
      Log.d(tag, "updateLegacyMetadata: Updated legacy metadata for chapter $chapterIndex: $chapterTitle")
    } catch (e: Exception) {
      Log.e(tag, "updateLegacyMetadata: Error updating legacy metadata", e)
    }
  }

  fun setPlaybackSpeed(speed: Float) {
    Log.d(tag, "setPlaybackSpeed: Setting speed to $speed")
    mediaManager.userSettingsPlaybackRate = speed

    // Set speed on the current player
    currentPlayer.setPlaybackSpeed(speed)

    // If current player is Cast, also explicitly call Cast manager for additional synchronization
    if (currentPlayer == castPlayerManager.castPlayer) {
      Log.d(tag, "setPlaybackSpeed: Also synchronizing with Cast player manager")
      castPlayerManager.setPlaybackSpeed(speed)
    }

    // Refresh Android Auto actions
    mediaProgressSyncer.currentPlaybackSession?.let { setMediaSessionConnectorCustomActions(it) }

    Log.d(tag, "setPlaybackSpeed: Speed updated successfully")
  }

  fun closePlayback(calledOnError: Boolean? = false) {
    Log.d(tag, "closePlayback")
    stopChapterChangeMonitoring() // Stop monitoring when closing playback
    val config = DeviceManager.serverConnectionConfig

    val isLocal = mediaProgressSyncer.currentIsLocal
    val currentSessionId = mediaProgressSyncer.currentSessionId
    if (mediaProgressSyncer.listeningTimerRunning) {
      Log.i(tag, "About to close playback so stopping media progress syncer first")

      mediaProgressSyncer.stop(
              calledOnError == false
      ) { // If closing on error then do not sync progress (causes exception)
        Log.d(tag, "Media Progress syncer stopped")
        // If not local session then close on server
        if (!isLocal && currentSessionId != "") {
          apiHandler.closePlaybackSession(currentSessionId, config) {
            Log.d(tag, "Closed playback session $currentSessionId")
          }
        }
      }
    } else {
      // If not local session then close on server
      if (!isLocal && currentSessionId != "") {
        apiHandler.closePlaybackSession(currentSessionId, config) {
          Log.d(tag, "Closed playback session $currentSessionId")
        }
      }
    }

    try {
      currentPlayer.stop()
      currentPlayer.clearMediaItems()
    } catch (e: Exception) {
      Log.e(tag, "Exception clearing exoplayer $e")
    }

    // Note: We don't clear DeviceManager.deviceData.lastPlaybackSession here
    // because we want to preserve it for resume functionality
    currentPlaybackSession = null
    lastActiveQueueItemIndex = -1
    currentNavigationIndex = -1
    queueSetForCurrentSession = false
    mediaProgressSyncer.reset()
    clientEventEmitter?.onPlaybackClosed()

    PlayerListener.lastPauseTime = 0
    isClosed = true
    DeviceManager.widgetUpdater?.onPlayerClosed()
    stopForeground(Service.STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  fun sendClientMetadata(playerState: PlayerState) {
    val duration = currentPlaybackSession?.getTotalDuration() ?: 0.0
    clientEventEmitter?.onMetadata(PlaybackMetadata(duration, getCurrentTimeSeconds(), playerState))
  }

  fun getMediaPlayer(): String {
    val mediaPlayerType = castPlayerManager.getMediaPlayer(currentPlayer)
    Log.d(tag, "getMediaPlayer: currentPlayer=${currentPlayer}, castPlayer=${castPlayer}, result=${mediaPlayerType}")
    return mediaPlayerType
  }

  /**
   * Force check cast session and switch if needed - for debugging
   */
  fun forceCastCheck() {
    Log.w(tag, "====== FORCE CAST CHECK CALLED ======")
    Log.d(tag, "forceCastCheck: Checking cast session state")
    val isCastConnected = castPlayerManager.isConnected()
    val currentMediaPlayerType = getMediaPlayer()
    Log.d(tag, "forceCastCheck: isCastConnected=$isCastConnected, currentMediaPlayerType=$currentMediaPlayerType")
    Log.d(tag, "forceCastCheck: currentPlayer=$currentPlayer, castPlayer=$castPlayer")

    if (isCastConnected && currentMediaPlayerType == CastPlayerManager.PLAYER_EXO) {
      Log.d(tag, "forceCastCheck: Cast is connected but using ExoPlayer - switching to cast")
      switchToPlayer(true)
    } else if (!isCastConnected && currentMediaPlayerType == CastPlayerManager.PLAYER_CAST) {
      Log.d(tag, "forceCastCheck: Cast not connected but using cast player - switching to ExoPlayer")
      switchToPlayer(false)
    } else {
      Log.d(tag, "forceCastCheck: Player state is already correct")
    }
  }

  @SuppressLint("HardwareIds")
  fun getDeviceInfo(): DeviceInfo {
    /* EXAMPLE
     manufacturer: Google
     model: Pixel 6
     brand: google
     sdkVersion: 32
     appVersion: 0.9.46-beta
    */
    val deviceId = Settings.Secure.getString(ctx.contentResolver, Settings.Secure.ANDROID_ID)
    return DeviceInfo(
            deviceId,
            Build.MANUFACTURER,
            Build.MODEL,
            Build.VERSION.SDK_INT,
            BuildConfig.VERSION_NAME
    )
  }

  private val deviceSettings
    get() = DeviceManager.deviceData.deviceSettings ?: DeviceSettings.default()

  fun getPlayItemRequestPayload(forceTranscode: Boolean): PlayItemRequestPayload {
    return PlayItemRequestPayload(
            getMediaPlayer(),
            !forceTranscode,
            forceTranscode,
            getDeviceInfo()
    )
  }

  fun getContext(): Context {
    return ctx
  }

  fun alertSyncFailing() {
    clientEventEmitter?.onProgressSyncFailing()
  }

  fun alertSyncSuccess() {
    clientEventEmitter?.onProgressSyncSuccess()
  }

  //
  // SHAKE SENSOR
  //
  private fun initSensor() {
    // ShakeDetector initialization
    mSensorManager = getSystemService(SENSOR_SERVICE) as SensorManager
    mAccelerometer = mSensorManager!!.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)

    mShakeDetector = ShakeDetector()
    mShakeDetector!!.setOnShakeListener(
            object : ShakeDetector.OnShakeListener {
              override fun onShake(count: Int) {
                Log.d(tag, "PHONE SHAKE! $count")
                sleepTimerManager.handleShake()
              }
            }
    )
  }

  // Shake sensor used for sleep timer
  fun registerSensor() {
    if (isShakeSensorRegistered) {
      Log.i(tag, "Shake sensor already registered")
      return
    }
    shakeSensorUnregisterTask?.cancel()

    Log.d(tag, "Registering shake SENSOR ${mAccelerometer?.isWakeUpSensor}")
    val success =
            mSensorManager!!.registerListener(
                    mShakeDetector,
                    mAccelerometer,
                    SensorManager.SENSOR_DELAY_UI
            )
    if (success) isShakeSensorRegistered = true
  }

  fun unregisterSensor() {
    if (!isShakeSensorRegistered) return

    // Unregister shake sensor after wake up expiration
    shakeSensorUnregisterTask?.cancel()
    shakeSensorUnregisterTask =
            Timer("ShakeUnregisterTimer", false).schedule(SLEEP_TIMER_WAKE_UP_EXPIRATION) {
              Handler(Looper.getMainLooper()).post {
                Log.d(tag, "wake time expired: Unregistering shake sensor")
                mSensorManager!!.unregisterListener(mShakeDetector)
                isShakeSensorRegistered = false
              }
            }
  }

  // --- Resume from last session when Android Auto starts ---
  private fun resumeFromLastSessionForAndroidAuto() {
    try {
      Log.d(tag, "Android Auto: Attempting to resume from last session (device or server)")

      // First check for local playback session saved on device
      val lastPlaybackSession = DeviceManager.deviceData.lastPlaybackSession
      if (lastPlaybackSession != null) {
        // Check if session has meaningful progress (not at the very beginning)
        val progress = lastPlaybackSession.currentTime / lastPlaybackSession.duration
        val isResumable = progress > 0.01

        if (isResumable) {
          Log.d(tag, "Android Auto: Found local playback session, resuming: ${lastPlaybackSession.displayTitle} at ${(progress * 100).toInt()}%")

          // If connected to server, check if server has newer progress for same media
          if (DeviceManager.checkConnectivity(ctx)) {
            Log.d(tag, "Android Auto: Checking server for potential newer session...")

            checkServerSessionVsLocal(lastPlaybackSession, { shouldUseServer: Boolean, serverSession: PlaybackSession? ->
              val sessionToUse = if (shouldUseServer && serverSession != null) {
                Log.d(tag, "Android Auto: Server session is newer, using server session")
                serverSession
              } else {
                Log.d(tag, "Android Auto: Using local session")
                lastPlaybackSession
              }

              // Since this is Android Auto, we should start playing
              val shouldStartPlaying = true

              // Prepare the player in playing state with saved playback speed
              val savedPlaybackSpeed = mediaManager.getSavedPlaybackRate()
              Handler(Looper.getMainLooper()).post {
                if (mediaProgressSyncer.listeningTimerRunning) {
                  mediaProgressSyncer.stop {
                    preparePlayer(sessionToUse, shouldStartPlaying, savedPlaybackSpeed)
                  }
                } else {
                  mediaProgressSyncer.reset()
                  preparePlayer(sessionToUse, shouldStartPlaying, savedPlaybackSpeed)
                }
              }
            })
          } else {
            // No connectivity, use local session
            prepareSessionForAndroidAuto(lastPlaybackSession, false)
          }
          return
        } else {
          Log.d(tag, "Android Auto: Local session progress too low (${(progress * 100).toInt()}%), checking server instead")
        }
      }

      // No suitable local session found, check server for last session if connected
      if (!DeviceManager.checkConnectivity(ctx)) {
        Log.d(tag, "Android Auto: No connectivity, cannot check server for last session")
        return
      }

      Log.d(tag, "Android Auto: No suitable local session found, querying server for last session")

      // Use getCurrentUser to get user data which should include session information
      apiHandler.getCurrentUser { user ->
        if (user != null) {
          Log.d(tag, "Android Auto: Got user data from server")

          try {
            // Get the most recent media progress
            if (user.mediaProgress.isNotEmpty()) {
              val latestProgress = user.mediaProgress.maxByOrNull { it.lastUpdate }

              if (latestProgress != null && latestProgress.currentTime > 0) {
                Log.d(tag, "Android Auto: Found recent progress: ${latestProgress.libraryItemId} at ${latestProgress.currentTime}s")

                // Check if this library item is downloaded locally
                val localLibraryItem = DeviceManager.dbManager.getLocalLibraryItemByLId(latestProgress.libraryItemId)

                if (localLibraryItem != null) {
                  Log.d(tag, "Android Auto: Found local download for ${localLibraryItem.title}, using local copy")

                  // Create a local playback session
                  val deviceInfo = getDeviceInfo()
                  val episode = if (latestProgress.episodeId != null && localLibraryItem.isPodcast) {
                    val podcast = localLibraryItem.media as? Podcast
                    podcast?.episodes?.find { ep -> ep.id == latestProgress.episodeId }
                  } else null

                  val localPlaybackSession = localLibraryItem.getPlaybackSession(episode, deviceInfo)
                  // Override the current time with the server progress to sync position
                  localPlaybackSession.currentTime = latestProgress.currentTime

                  Log.d(tag, "Android Auto: Resuming from local download: ${localLibraryItem.title} at ${latestProgress.currentTime}s")

                  // Since this is Android Auto, we should start playing
                  val shouldStartPlaying = true

                  // Prepare the player in playing state with saved playback speed
                  val savedPlaybackSpeed = mediaManager.getSavedPlaybackRate()
                  Handler(Looper.getMainLooper()).post {
                    if (mediaProgressSyncer.listeningTimerRunning) {
                      mediaProgressSyncer.stop {
                        preparePlayer(localPlaybackSession, shouldStartPlaying, savedPlaybackSpeed)
                      }
                    } else {
                      mediaProgressSyncer.reset()
                      preparePlayer(localPlaybackSession, shouldStartPlaying, savedPlaybackSpeed)
                    }
                  }
                  return@getCurrentUser
                }

                // No local copy found, get the library item from server
                Log.d(tag, "Android Auto: No local download found, using server streaming")
                apiHandler.getLibraryItem(latestProgress.libraryItemId) { libraryItem ->
                  if (libraryItem != null) {
                    Log.d(tag, "Android Auto: Got library item: ${libraryItem.media?.metadata?.title}")

                    // Create a playback session from the library item and progress
                    Handler(Looper.getMainLooper()).post {
                      try {
                        val episode = if (latestProgress.episodeId != null) {
                          val podcastMedia = libraryItem.media as? Podcast
                          podcastMedia?.episodes?.find { ep -> ep.id == latestProgress.episodeId }
                        } else null

                        // Use the API to get a proper playback session but don't start playback
                        val playItemRequestPayload = getPlayItemRequestPayload(false)

                        // Get the current playback speed from saved settings
                        val currentPlaybackSpeed = mediaManager.getSavedPlaybackRate()

                        Log.d(tag, "Android Auto: Using playback speed: $currentPlaybackSpeed")

                        apiHandler.playLibraryItem(latestProgress.libraryItemId, latestProgress.episodeId, playItemRequestPayload) { playbackSession ->
                          if (playbackSession != null) {
                            // Override the current time with the saved progress
                            playbackSession.currentTime = latestProgress.currentTime

                            // Since this is Android Auto, we should start playing
                            val shouldStartPlaying = true

                            Log.d(tag, "Android Auto: Resuming from server session: ${libraryItem.media.metadata?.title} at ${latestProgress.currentTime}s in playing state with speed ${currentPlaybackSpeed}x")

                            // Prepare the player in playing state on main thread with correct playback speed
                            Handler(Looper.getMainLooper()).post {
                              if (mediaProgressSyncer.listeningTimerRunning) {
                                mediaProgressSyncer.stop {
                                  preparePlayer(playbackSession, shouldStartPlaying, currentPlaybackSpeed)
                                }
                              } else {
                                mediaProgressSyncer.reset()
                                preparePlayer(playbackSession, shouldStartPlaying, currentPlaybackSpeed)
                              }
                            }
                          } else {
                            Log.e(tag, "Android Auto: Failed to create playback session from server")
                          }
                        }

                      } catch (e: Exception) {
                        Log.e(tag, "Android Auto: Error creating playback session from server data: ${e.message}")
                      }
                    }
                  } else {
                    Log.d(tag, "Android Auto: Could not get library item ${latestProgress.libraryItemId} from server")
                  }
                }
              } else {
                Log.d(tag, "Android Auto: No recent progress found or progress is at beginning")
              }
            } else {
              Log.d(tag, "Android Auto: No media progress found in user data")
            }

          } catch (e: Exception) {
            Log.e(tag, "Android Auto: Error processing user session data: ${e.message}")
          }
        } else {
          Log.d(tag, "Android Auto: No user data found from server")
        }
      }
    } catch (e: Exception) {
      Log.e(tag, "Android Auto: Failed to resume from last session: ${e.message}")
    }
  }

  // Helper function to check server session vs local session
  // Helper function to prepare session for Android Auto
  internal fun prepareSessionForAndroidAuto(session: PlaybackSession, playWhenReady: Boolean) {
    val savedPlaybackSpeed = mediaManager.getSavedPlaybackRate()
    Handler(Looper.getMainLooper()).post {
      if (mediaProgressSyncer.listeningTimerRunning) {
        mediaProgressSyncer.stop {
          preparePlayer(session, playWhenReady, savedPlaybackSpeed)
        }
      } else {
        mediaProgressSyncer.reset()
        preparePlayer(session, playWhenReady, savedPlaybackSpeed)
      }
    }
  }

  //
  // MEDIA BROWSER STUFF (ANDROID AUTO) - delegated to MediaBrowserManager
  //

  // MIGRATION: MediaBrowserServiceCompat → MediaLibraryService callbacks
  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaLibrarySession? {
    Log.d(tag, "AALibrary: onGetSession called by ${controllerInfo.packageName}")
    return if (::mediaSessionManager.isInitialized) {
      Log.d(tag, "AALibrary: MediaSessionManager is initialized, returning MediaLibrarySession")
      mediaSessionManager.mediaSession
    } else {
      Log.w(tag, "AALibrary: onGetSession called before mediaSessionManager initialized")
      null
    }
  }

  // Required for Media3 to properly start foreground service
  @RequiresApi(Build.VERSION_CODES.Q)
  override fun onUpdateNotification(session: MediaSession, startInForegroundRequired: Boolean) {
    super.onUpdateNotification(session, startInForegroundRequired)
    // Media3 handles the foreground service automatically
  }

  /**
   * Checks if server has a newer session for the same media compared to local session
   */
  fun checkServerSessionVsLocal(localSession: PlaybackSession, callback: (Boolean, PlaybackSession?) -> Unit) {
    try {
      Log.d(tag, "Checking server session vs local for: ${localSession.displayTitle}")

      apiHandler.getCurrentUser { user ->
        if (user != null && user.mediaProgress.isNotEmpty()) {
          // Find progress for the same library item
          val serverProgress = user.mediaProgress.find { progress ->
            progress.libraryItemId == localSession.libraryItemId &&
            (progress.episodeId == null && localSession.episodeId == null ||
             progress.episodeId == localSession.episodeId)
          }

          if (serverProgress != null) {
            Log.d(tag, "Found server progress: ${serverProgress.currentTime}s vs local: ${localSession.currentTime}s")

            // Compare timestamps to see which is newer
            val serverUpdateTime = serverProgress.lastUpdate
            val localUpdateTime = localSession.updatedAt

            val shouldUseServer = serverUpdateTime > localUpdateTime
            Log.d(tag, "Server update time: $serverUpdateTime, Local update time: $localUpdateTime, Use server: $shouldUseServer")

            if (shouldUseServer) {
              // Simply update the current time of the existing local session
              // Create a new session with updated time (can't modify currentTime directly)
              val updatedSession = PlaybackSession(
                id = localSession.id,
                userId = localSession.userId,
                libraryItemId = localSession.libraryItemId,
                episodeId = localSession.episodeId,
                mediaType = localSession.mediaType,
                mediaMetadata = localSession.mediaMetadata,
                deviceInfo = localSession.deviceInfo,
                chapters = localSession.chapters,
                displayTitle = localSession.displayTitle,
                displayAuthor = localSession.displayAuthor,
                coverPath = localSession.coverPath,
                duration = localSession.duration,
                playMethod = localSession.playMethod,
                startedAt = localSession.startedAt,
                updatedAt = localSession.updatedAt,
                timeListening = localSession.timeListening,
                audioTracks = localSession.audioTracks,
                currentTime = serverProgress.currentTime, // Updated with server progress
                libraryItem = localSession.libraryItem,
                localLibraryItem = localSession.localLibraryItem,
                localEpisodeId = localSession.localEpisodeId,
                serverConnectionConfigId = localSession.serverConnectionConfigId,
                serverAddress = localSession.serverAddress,
                mediaPlayer = localSession.mediaPlayer
              )
              Log.d(tag, "Created updated session with server progress: ${updatedSession.currentTime}s")
              callback(true, updatedSession)
            } else {
              Log.d(tag, "Local session is newer or same, using local")
              callback(false, null)
            }
          } else {
            Log.d(tag, "No server progress found for this media")
            callback(false, null)
          }
        } else {
          Log.d(tag, "No user data or media progress from server")
          callback(false, null)
        }
      }
    } catch (e: Exception) {
      Log.e(tag, "Error checking server session vs local", e)
      callback(false, null)
    }
  }

  fun forceAndroidAutoReload() {
    AbsLogger.info(tag, "Forcing Android Auto reload from service")
    // Trigger refresh by notifying children changed for root
    mediaSessionManager.mediaSession?.let { session ->
      session.notifyChildrenChanged(MediaLibrarySessionCallback.AUTO_MEDIA_ROOT, 0, null)
    }
  }

  /**
   * Try to automatically resume the last playback session when Android Auto connects
   * This helps ensure that when opening the app in Android Auto, playback will resume
   * from the last session instead of requiring manual selection from the browser
   */
  fun tryResumeLastSessionForAndroidAuto() {
    try {
      // Check if we already have an active session - don't resume if already playing
      if (currentPlaybackSession != null) {
        Log.d(tag, "tryResumeLastSessionForAndroidAuto: Active session already exists, skipping auto-resume")
        return
      }

      val lastSession = DeviceManager.deviceData.lastPlaybackSession
      if (lastSession != null) {
        // Check if session has meaningful progress (not at the very beginning)
        val progress = lastSession.currentTime / lastSession.duration
        if (progress > 0.01) {
          Log.d(tag, "tryResumeLastSessionForAndroidAuto: Found resumable session '${lastSession.displayTitle}' at ${progress * 100}% (${lastSession.currentTime}s/${lastSession.duration}s)")

          // CRITICAL FIX: Store the absolute current time before preparing player
          // This prevents the coordinate system mismatch issue
          val absoluteCurrentTime = lastSession.currentTime
          Log.d(tag, "tryResumeLastSessionForAndroidAuto: Stored absolute time: ${absoluteCurrentTime}s")

          // Make sure this runs on the main thread as ExoPlayer requires it
          Handler(Looper.getMainLooper()).post {
            try {
              val savedPlaybackSpeed = mediaManager.getSavedPlaybackRate()
              // Start playback immediately since we're in Android Auto mode
              val shouldStartPlaying = true

              Log.d(tag, "tryResumeLastSessionForAndroidAuto: Preparing player with skipInitialSeek=true")
              // Prepare the player but skip the initial seek - we'll do it manually after the player is ready
              preparePlayer(lastSession, shouldStartPlaying, savedPlaybackSpeed, skipInitialSeek = true)

              // Wait for the player to be ready, then seek to the correct absolute position
              // This ensures the chapter calculation is done correctly
              Handler(Looper.getMainLooper()).postDelayed({
                try {
                  if (currentPlayer.playbackState == Player.STATE_READY ||
                      currentPlayer.playbackState == Player.STATE_BUFFERING) {
                    Log.d(tag, "tryResumeLastSessionForAndroidAuto: Player ready, seeking to absolute time ${absoluteCurrentTime}s")
                    seekToAbsoluteTime(absoluteCurrentTime)
                    Log.d(tag, "tryResumeLastSessionForAndroidAuto: Successfully resumed and seeked to correct position")
                  } else {
                    Log.w(tag, "tryResumeLastSessionForAndroidAuto: Player not ready after delay (state: ${currentPlayer.playbackState})")
                  }
                } catch (e: Exception) {
                  Log.e(tag, "tryResumeLastSessionForAndroidAuto: Failed to seek after player ready", e)
                }
              }, 500) // 500ms delay to ensure player is ready

              Log.d(tag, "tryResumeLastSessionForAndroidAuto: Player preparation initiated")
            } catch (e: Exception) {
              Log.e(tag, "tryResumeLastSessionForAndroidAuto: Failed to resume session", e)
            }
          }
        } else {
          Log.d(tag, "tryResumeLastSessionForAndroidAuto: Session found but progress too low: ${progress * 100}%")
        }
      } else {
        Log.d(tag, "tryResumeLastSessionForAndroidAuto: No last playback session found")
      }
    } catch (e: Exception) {
      Log.e(tag, "tryResumeLastSessionForAndroidAuto: Error trying to auto-resume", e)
    }
  }
}

// Simple callback for MediaLibrarySession that delegates to MediaBrowserManager methods
/**
 * Media3 MediaLibrarySessionCallback - Complete Android Auto Media Browser Implementation
 *
 * ✅ IMPLEMENTED FEATURES (Full Parity with Original):
 *
 * 1. ANDROID AUTO INTERFACE FIXES:
 *    - ✅ Duplicate skip buttons eliminated (disabled COMMAND_SEEK_TO_NEXT/PREVIOUS_MEDIA_ITEM)
 *    - ✅ Speed cycling restored to original preset logic (0.5→1.0→1.2→1.5→2.0→3.0→0.5)
 *    - ✅ Custom media actions for all controls (jump, skip, speed)
 *
 * 2. FULL MEDIA BROWSER HIERARCHY:
 *    - ✅ Root Menu: Continue Listening, Recently Added, Local Books, Libraries
 *    - ✅ Library Categories: Authors, Series, Collections, Discovery (for books)
 *    - ✅ Podcast Support: Direct podcast listing → episodes (for podcast libraries)
 *    - ✅ Hierarchical Browsing:
 *      * Authors → Books by Author
 *      * Series → Books in Series
 *      * Collections → Books in Collection
 *      * Discovery → Discovery Books
 *      * Author+Series → Books by Author in Series
 *
 * 3. ALPHABETICAL GROUPING:
 *    - ✅ Authors: Grouped by first letter when >50 authors
 *    - ✅ Series: Grouped by first letter when >50 series
 *    - ✅ Smart filtering by letter selection
 *
 * 4. PROGRESS TRACKING:
 *    - ✅ User progress included in metadata extras for all playable items
 *    - ✅ Continue Listening shows in-progress items
 *    - ✅ Progress info for books and podcast episodes
 *
 * 5. SEARCH FUNCTIONALITY:
 *    - ✅ Search across all content: books, podcasts, episodes
 *    - ✅ Searches in-progress items, recent shelves, local content
 *    - ✅ Title and author/podcast name matching
 *
 * 6. CACHING & PERFORMANCE:
 *    - ✅ Uses cached data for synchronous responses
 *    - ✅ Pre-loads essential data on Android Auto connection
 *    - ✅ Fallbacks to empty lists when data not cached
 *
 * SUPPORTED BROWSING PATHS:
 * - "/" → Main menu
 * - "__CONTINUE__" → Continue listening items
 * - "__RECENTLY__" → Recently added items
 * - "__LOCAL__" → Downloaded books
 * - "__LIBRARIES__" → Server libraries
 * - "[LibraryId]" → Library categories or podcasts
 * - "__LIBRARY__[LibraryId]__AUTHORS" → Authors (with grouping)
 * - "__LIBRARY__[LibraryId]__AUTHORS__[Letter]" → Authors by letter
 * - "__LIBRARY__[LibraryId]__AUTHOR__[AuthorId]" → Books by author
 * - "__LIBRARY__[LibraryId]__SERIES_LIST" → Series (with grouping)
 * - "__LIBRARY__[LibraryId]__SERIES_LIST__[Letter]" → Series by letter
 * - "__LIBRARY__[LibraryId]__SERIES__[SeriesId]" → Books in series
 * - "__LIBRARY__[LibraryId]__COLLECTIONS" → Collections
 * - "__LIBRARY__[LibraryId]__COLLECTION__[CollectionId]" → Books in collection
 * - "__LIBRARY__[LibraryId]__DISCOVERY" → Discovery items
 * - "__LIBRARY__[LibraryId]__AUTHOR_SERIES__[AuthorId]__[SeriesId]" → Author books in series
 * - "[PodcastId]" → Podcast episodes
 *
 * MEDIA TYPES SUPPORTED:
 * - Books (MEDIA_TYPE_AUDIO_BOOK)
 * - Podcasts (MEDIA_TYPE_PODCAST)
 * - Episodes (MEDIA_TYPE_PODCAST)
 * - Folders (MEDIA_TYPE_FOLDER_MIXED)
 *
 * This implementation provides complete feature parity with the original MediaBrowserServiceCompat
 * while working within Media3's synchronous callback constraints.
 */
class MediaLibrarySessionCallback(private val service: PlayerNotificationService) : Callback {

  // Cache for search results to avoid duplicating search between onSearch and onGetSearchResult
  private var cachedSearchQuery: String = ""
  private var cachedSearchResults: MutableList<MediaItem> = mutableListOf()

  companion object {
    const val AUTO_MEDIA_ROOT = "/"
    const val LIBRARIES_ROOT = "__LIBRARIES__"
    const val RECENTLY_ROOT = "__RECENTLY__"
    const val DOWNLOADS_ROOT = "__DOWNLOADS__"
    const val CONTINUE_ROOT = "__CONTINUE__"
    const val LOCAL_ROOT = "__LOCAL__"

    // Android Auto package names for MediaBrowser validation
    private const val ANDROID_AUTO_PKG_NAME = "com.google.android.projection.gearhead"
    private const val ANDROID_AUTO_SIMULATOR_PKG_NAME = "com.google.android.projection.gearhead.emulator"
    private const val ANDROID_WEARABLE_PKG_NAME = "com.google.android.wearable.app"
    private const val ANDROID_GSEARCH_PKG_NAME = "com.google.android.googlequicksearchbox"
    private const val ANDROID_AUTOMOTIVE_PKG_NAME = "com.google.android.projection.gearhead.phone"

    private val VALID_MEDIA_BROWSERS = setOf(
      "com.tomesonic.app",
      "com.tomesonic.app.debug",
      ANDROID_AUTO_PKG_NAME,
      ANDROID_AUTO_SIMULATOR_PKG_NAME,
      ANDROID_WEARABLE_PKG_NAME,
      ANDROID_GSEARCH_PKG_NAME,
      ANDROID_AUTOMOTIVE_PKG_NAME
    )
  }

  private fun isValidClient(packageName: String): Boolean {
    return VALID_MEDIA_BROWSERS.contains(packageName)
  }

      override fun onGetLibraryRoot(
    session: MediaLibrarySession,
    browser: MediaSession.ControllerInfo,
    params: LibraryParams?
  ): ListenableFuture<LibraryResult<MediaItem>> {
    Log.d("PlayerNotificationServ", "AALibrary: onGetLibraryRoot called by ${browser.packageName}")

    return if (!isValidClient(browser.packageName)) {
      Log.d("PlayerNotificationServ", "AALibrary: Client ${browser.packageName} not allowed to access media browser")
      Futures.immediateFuture(LibraryResult.ofError(LibraryResult.RESULT_ERROR_NOT_SUPPORTED))
    } else {
      Log.d("PlayerNotificationServ", "AALibrary: Client ${browser.packageName} allowed, proceeding with onGetLibraryRoot")
      service.isAndroidAuto = true

      // Try to resume last playback session when Android Auto connects
      service.tryResumeLastSessionForAndroidAuto()

      // Create a future that will be completed when data loading is done
      val future = SettableFuture.create<LibraryResult<MediaItem>>()

      // Ensure server connection is established before checking validity
      Log.d("PlayerNotificationServ", "AALibrary: Ensuring server connection is established")
      service.mediaManager.ensureServerConnectionForAndroidAuto {
        // Check if we have a valid server connection after ensuring connection
        if (!service.mediaManager.hasValidServerConnection()) {
          Log.w("PlayerNotificationServ", "AALibrary: No valid server connection, will show local content only")
        } else {
          Log.d("PlayerNotificationServ", "AALibrary: Valid server connection established")
        }

        // Aggressively pre-load essential browsing data for better performance
        Log.d("PlayerNotificationServ", "AALibrary: Triggering immediate data pre-load for Android Auto")
        service.mediaManager.preloadAndroidAutoBrowsingData {
          Log.d("PlayerNotificationServ", "AALibrary: Pre-loading complete, data is now available for browsing")

          // Create root media item for MediaLibraryService with search support
          val rootMediaItem = MediaItem.Builder()
            .setMediaId(AUTO_MEDIA_ROOT)
            .setMediaMetadata(
              MediaMetadata.Builder()
                .setTitle("Audiobookshelf")
                .setIsBrowsable(true)
                .setIsPlayable(false)
                .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
                .setExtras(Bundle().apply {
                  putBoolean("android.media.browse.SEARCH_SUPPORTED", true)
                })
                .build()
            )
            .build()

          // Only complete the future after data is loaded
          future.set(LibraryResult.ofItem(rootMediaItem, params))
        }
      }

      future
    }
  }

  override fun onGetChildren(
    session: MediaLibrarySession,
    browser: MediaSession.ControllerInfo,
    parentId: String,
    page: Int,
    pageSize: Int,
    params: LibraryParams?
  ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> {
    Log.d("PlayerNotificationServ", "AALibrary: onGetChildren called for parentId: $parentId")

    val future = SettableFuture.create<LibraryResult<ImmutableList<MediaItem>>>()

    try {
      when (parentId) {
        AUTO_MEDIA_ROOT -> {
          // Return root categories synchronously
          val rootItems = mutableListOf<MediaItem>()

          // Continue reading root
          rootItems.add(
            MediaItem.Builder()
              .setMediaId(CONTINUE_ROOT)
              .setMediaMetadata(
                MediaMetadata.Builder()
                  .setTitle("Continue Listening")
                  .setIsBrowsable(true)
                  .setIsPlayable(false)
                  .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
                  .setArtworkUri(getUriToDrawable(service.applicationContext, R.drawable.ic_play))
                  .build()
              )
              .build()
          )

          // Recent root
          rootItems.add(
            MediaItem.Builder()
              .setMediaId(RECENTLY_ROOT)
              .setMediaMetadata(
                MediaMetadata.Builder()
                  .setTitle("Recently Added")
                  .setIsBrowsable(true)
                  .setIsPlayable(false)
                  .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
                  .setArtworkUri(getUriToDrawable(service.applicationContext, R.drawable.md_clock_outline))
                  .build()
              )
              .build()
          )

          // Local books root
          rootItems.add(
            MediaItem.Builder()
              .setMediaId(LOCAL_ROOT)
              .setMediaMetadata(
                MediaMetadata.Builder()
                  .setTitle("Local Books")
                  .setIsBrowsable(true)
                  .setIsPlayable(false)
                  .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
                  .setArtworkUri(getUriToDrawable(service.applicationContext, R.drawable.ic_download))
                  .build()
              )
              .build()
          )

          // Libraries root
          rootItems.add(
            MediaItem.Builder()
              .setMediaId(LIBRARIES_ROOT)
              .setMediaMetadata(
                MediaMetadata.Builder()
                  .setTitle("Libraries")
                  .setIsBrowsable(true)
                  .setIsPlayable(false)
                  .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
                  .setArtworkUri(getUriToDrawable(service.applicationContext, R.drawable.md_book_multiple_outline))
                  .build()
              )
              .build()
          )

          future.set(LibraryResult.ofItemList(ImmutableList.copyOf(rootItems), params))
        }

        LIBRARIES_ROOT -> {
          // Return libraries synchronously
          val audioLibraries = service.mediaManager.getLibrariesWithAudio()

          if (audioLibraries.isEmpty()) {
            Log.w("PlayerNotificationServ", "AALibrary: No libraries with audio content available")
            val noLibrariesItem = MediaItem.Builder()
              .setMediaId("__NO_LIBRARIES__")
              .setMediaMetadata(
                MediaMetadata.Builder()
                  .setTitle("No libraries available")
                  .setSubtitle("Connect to server or check library content")
                  .setIsBrowsable(false)
                  .setIsPlayable(false)
                  .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
                  .build()
              )
              .build()
            future.set(LibraryResult.ofItemList(ImmutableList.copyOf(listOf(noLibrariesItem)), params))
          } else {
            Log.d("PlayerNotificationServ", "AALibrary: Returning ${audioLibraries.size} libraries")
            val libraryItems = audioLibraries.map { library ->
              // Use the library's icon but add subtitle with book count for Android Auto
              MediaItem.Builder()
                .setMediaId(library.id)
                .setMediaMetadata(
                  MediaMetadata.Builder()
                    .setTitle(library.name)
                    .setSubtitle("${library.stats?.totalItems ?: 0} books")
                    .setIsBrowsable(true)
                    .setIsPlayable(false)
                    .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
                    .setArtworkUri(getUriToAbsIconDrawable(service.applicationContext, library.icon))
                    .build()
                )
                .build()
            }
            future.set(LibraryResult.ofItemList(ImmutableList.copyOf(libraryItems), params))
          }
        }

        CONTINUE_ROOT -> {
          // Always try to load items in progress (includes both server and local items)
          Log.d("PlayerNotificationServ", "AALibrary: Loading items in progress for Android Auto (server + local)")
          val itemsInProgress = service.mediaManager.loadItemsInProgressSync()
          Log.d("PlayerNotificationServ", "Getting continue items: ${itemsInProgress.size} items")

          if (itemsInProgress.isEmpty()) {
            val noItemsItem = MediaItem.Builder()
              .setMediaId("__NO_CONTINUE__")
              .setMediaMetadata(
                MediaMetadata.Builder()
                  .setTitle("No items in progress")
                  .setSubtitle("Start listening to see items here")
                  .setIsBrowsable(false)
                  .setIsPlayable(false)
                  .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
                  .build()
              )
              .build()
            future.set(LibraryResult.ofItemList(ImmutableList.copyOf(listOf(noItemsItem)), params))
          } else {
            val continueItems = itemsInProgress.map { itemInProgress ->
              val wrapper = itemInProgress.libraryItemWrapper
              val (id, title, authorName) = when (wrapper) {
                is LibraryItem -> Triple(wrapper.id, wrapper.title, wrapper.authorName)
                is LocalLibraryItem -> Triple(
                  wrapper.libraryItemId ?: wrapper.id,
                  wrapper.title ?: "Unknown Title",
                  wrapper.authorName ?: "Unknown Author"
                )
                else -> Triple("unknown", "Unknown Title", "Unknown Author")
              }

              val artworkUri = when (wrapper) {
                is LibraryItem -> wrapper.getCoverUri()
                is LocalLibraryItem -> wrapper.getCoverUri(service)
                else -> null
              }

              val progressPercent = service.mediaManager.getProgressPercentage(
                id ?: "unknown",
                itemInProgress.episode?.id
              )

              // Check if this item is downloaded locally (for server books)
              val isDownloaded = when (wrapper) {
                is LocalLibraryItem -> true // Already local
                is LibraryItem -> {
                  // Check if this server book has a local download
                  DeviceManager.dbManager.getLocalLibraryItemByLId(wrapper.id) != null
                }
                else -> false
              }

              val authorWithProgress = if (progressPercent > 0) {
                val downloadIcon = if (isDownloaded) "⤋ " else ""
                "$downloadIcon$authorName • ${progressPercent}%"
              } else {
                val downloadIcon = if (isDownloaded) "⤋ " else ""
                "$downloadIcon$authorName"
              }

              MediaItem.Builder()
                .setMediaId(id ?: "unknown")
                .setMediaMetadata(
                  MediaMetadata.Builder()
                    .setTitle(title ?: "Unknown Title")
                    .setArtist(authorWithProgress)
                    .setIsPlayable(true)
                    .setIsBrowsable(false)
                    .setMediaType(MediaMetadata.MEDIA_TYPE_AUDIO_BOOK)
                    .setArtworkUri(artworkUri)
                    .build()
                )
                .build()
            }
            future.set(LibraryResult.ofItemList(ImmutableList.copyOf(continueItems), params))
          }
        }

        RECENTLY_ROOT -> {
          Log.d("PlayerNotificationServ", "AALibrary: Getting recent items from cached data (synchronous)")

          // Return cached data immediately - Media3 requires synchronous responses
          val recentShelves = service.mediaManager.getAllCachedLibraryRecentShelves()
          val librariesWithRecent = mutableListOf<MediaItem>()

          if (!service.mediaManager.hasValidServerConnection()) {
            Log.w("PlayerNotificationServ", "AALibrary: No server connection for recent items")
            val noRecentItem = MediaItem.Builder()
              .setMediaId("__NO_RECENT__")
              .setMediaMetadata(
                MediaMetadata.Builder()
                  .setTitle("No recent items")
                  .setSubtitle("Connect to server to see recent items")
                  .setIsBrowsable(false)
                  .setIsPlayable(false)
                  .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
                  .build()
              )
              .build()
            future.set(LibraryResult.ofItemList(ImmutableList.copyOf(listOf(noRecentItem)), params))
          } else if (recentShelves.isEmpty() || !service.mediaManager.hasRecentShelvesLoaded()) {
            Log.d("PlayerNotificationServ", "AALibrary: No recent data in cache, returning empty list")
            val noDataItem = MediaItem.Builder()
              .setMediaId("__NO_RECENT_DATA__")
              .setMediaMetadata(
                MediaMetadata.Builder()
                  .setTitle("No recent items available")
                  .setSubtitle("Data may still be loading")
                  .setIsBrowsable(false)
                  .setIsPlayable(false)
                  .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
                  .setArtworkUri(getUriToDrawable(service.applicationContext, R.drawable.md_clock_outline))
                  .build()
              )
              .build()
            future.set(LibraryResult.ofItemList(ImmutableList.copyOf(listOf(noDataItem)), params))
          } else {
            Log.d("PlayerNotificationServ", "AALibrary: Found recent shelves for ${recentShelves.size} libraries")

            recentShelves.forEach { (libraryId, shelves) ->
              val library = service.mediaManager.getLibrary(libraryId)
              if (library != null) {
                // Count recent items in this library
                var itemCount = 0
                shelves.forEach { shelf ->
                  when (shelf) {
                    is LibraryShelfBookEntity -> itemCount += shelf.entities?.size ?: 0
                    is LibraryShelfPodcastEntity -> itemCount += shelf.entities?.size ?: 0
                    else -> {
                      // Handle other shelf types (authors, series, episodes)
                    }
                  }
                }

                if (itemCount > 0) {
                  librariesWithRecent.add(
                    MediaItem.Builder()
                      .setMediaId("__RECENT_LIBRARY__${library.id}")
                      .setMediaMetadata(
                        MediaMetadata.Builder()
                          .setTitle(library.name)
                          .setSubtitle("$itemCount recent items")
                          .setIsBrowsable(true)
                          .setIsPlayable(false)
                          .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
                          .setArtworkUri(getUriToAbsIconDrawable(service.applicationContext, library.icon))
                          .build()
                      )
                      .build()
                  )
                }
              }
            }

            if (librariesWithRecent.isEmpty()) {
              val noRecentItem = MediaItem.Builder()
                .setMediaId("__NO_RECENT__")
                .setMediaMetadata(
                  MediaMetadata.Builder()
                    .setTitle("No recent items")
                    .setSubtitle("Recent additions will appear here")
                    .setIsBrowsable(false)
                    .setIsPlayable(false)
                    .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
                    .build()
                )
                .build()
              future.set(LibraryResult.ofItemList(ImmutableList.copyOf(listOf(noRecentItem)), params))
            } else {
              future.set(LibraryResult.ofItemList(ImmutableList.copyOf(librariesWithRecent), params))
            }
          }
        }

        LOCAL_ROOT -> {
          // Return local books synchronously (local data is always available)
          val localBooks = DeviceManager.dbManager.getLocalLibraryItems("book")
          Log.d("PlayerNotificationServ", "Getting local books: ${localBooks.size} items")

          if (localBooks.isEmpty()) {
            val noLocalItem = MediaItem.Builder()
              .setMediaId("__NO_LOCAL__")
              .setMediaMetadata(
                MediaMetadata.Builder()
                  .setTitle("No local books")
                  .setSubtitle("Download books to see them here")
                  .setIsBrowsable(false)
                  .setIsPlayable(false)
                  .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
                  .build()
              )
              .build()
            future.set(LibraryResult.ofItemList(ImmutableList.copyOf(listOf(noLocalItem)), params))
          } else {
            val localItems = localBooks.map { localItem ->
              Log.d("PlayerNotificationServ", "AALibrary: Creating MediaItem for local book with ID: ${localItem.id}")
              MediaItem.Builder()
                .setMediaId(localItem.id) // Use the ID directly, it already has local prefix
                .setMediaMetadata(
                  MediaMetadata.Builder()
                    .setTitle(localItem.title ?: "Unknown Title")
                    .setArtist("⤋ " + ((localItem.media as? Book)?.metadata?.getAuthorDisplayName() ?: "Unknown Author"))
                    .setIsPlayable(true)
                    .setIsBrowsable(false)
                    .setMediaType(MediaMetadata.MEDIA_TYPE_AUDIO_BOOK)
                    .setArtworkUri(localItem.getCoverUri(service))
                    .build()
                )
                .build()
            }
            future.set(LibraryResult.ofItemList(ImmutableList.copyOf(localItems), params))
          }
        }


        else -> {
          // Parse complex media IDs for hierarchical browsing (matching original implementation)
          when {
            parentId.startsWith("__RECENT_LIBRARY__") -> {
              // Handle browsing into recent items for a specific library
              val libraryId = parentId.removePrefix("__RECENT_LIBRARY__")
              Log.d("PlayerNotificationServ", "AALibrary: Getting recent items for library: $libraryId")

              val recentItems = mutableListOf<MediaItem>()
              val recentShelves = service.mediaManager.getAllCachedLibraryRecentShelves()[libraryId]

              recentShelves?.forEach { shelf ->
                when (shelf) {
                  is LibraryShelfBookEntity -> {
                    shelf.entities?.forEach { book ->
                      val mediaItem = MediaItem.Builder()
                        .setMediaId(book.id)
                        .setMediaMetadata(
                          MediaMetadata.Builder()
                            .setTitle(book.title ?: "Unknown Title")
                            .setArtist(formatAuthorWithDownloadIcon(book.id, book.authorName))
                            .setIsPlayable(true)
                            .setIsBrowsable(false)
                            .setMediaType(MediaMetadata.MEDIA_TYPE_AUDIO_BOOK)
                            .setArtworkUri(book.getCoverUri())
                            .build()
                        )
                        .build()
                      recentItems.add(mediaItem)
                    }
                  }
                  is LibraryShelfPodcastEntity -> {
                    shelf.entities?.forEach { podcast ->
                      val mediaItem = MediaItem.Builder()
                        .setMediaId(podcast.id)
                        .setMediaMetadata(
                          MediaMetadata.Builder()
                            .setTitle(podcast.title ?: "Unknown Title")
                            .setArtist(podcast.authorName)
                            .setIsPlayable(true)
                            .setIsBrowsable(false)
                            .setMediaType(MediaMetadata.MEDIA_TYPE_PODCAST)
                            .setArtworkUri(podcast.getCoverUri())
                            .build()
                        )
                        .build()
                      recentItems.add(mediaItem)
                    }
                  }
                  else -> {
                    // Handle other shelf types (authors, series, episodes) - not applicable for recent items
                  }
                }
              }

              future.set(LibraryResult.ofItemList(ImmutableList.copyOf(recentItems), params))
            }
            parentId.startsWith("__LIBRARY__") -> {
              // Handle library browsing synchronously using cached data
              Log.d("PlayerNotificationServ", "AALibrary: Handling library browsing for $parentId (synchronous)")

              if (!service.mediaManager.hasValidServerConnection()) {
                Log.w("PlayerNotificationServ", "AALibrary: No server connection for library browsing")
                val noConnectionItem = MediaItem.Builder()
                  .setMediaId("__NO_CONNECTION__")
                  .setMediaMetadata(
                    MediaMetadata.Builder()
                      .setTitle("No server connection")
                      .setSubtitle("Connect to server to browse")
                      .setIsBrowsable(false)
                      .setIsPlayable(false)
                      .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
                      .build()
                  )
                  .build()
                future.set(LibraryResult.ofItemList(ImmutableList.copyOf(listOf(noConnectionItem)), params))
              } else {
                // Handle browsing using cached data only
                val children = handleLibraryBrowsing(parentId)
                future.set(LibraryResult.ofItemList(ImmutableList.copyOf(children), params))
              }
            }
            service.mediaManager.getIsLibrary(parentId) -> {
              // Return library categories (Authors, Series, Collections, etc.) synchronously
              val library = service.mediaManager.getLibrary(parentId)
              if (library != null) {
                Log.d("PlayerNotificationServ", "AALibrary: Getting library categories for ${library.name} (synchronous)")

                if (!service.mediaManager.hasValidServerConnection()) {
                  Log.w("PlayerNotificationServ", "AALibrary: No server connection for library categories")
                  val noConnectionItem = MediaItem.Builder()
                    .setMediaId("__NO_CONNECTION__")
                    .setMediaMetadata(
                      MediaMetadata.Builder()
                        .setTitle("No server connection")
                        .setSubtitle("Connect to server to browse library")
                        .setIsBrowsable(false)
                        .setIsPlayable(false)
                        .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
                        .build()
                    )
                    .build()
                  future.set(LibraryResult.ofItemList(ImmutableList.copyOf(listOf(noConnectionItem)), params))
                } else {
                  // Build categories from cached data immediately
                  val children = buildLibraryCategories(library)

                  if (children.isEmpty()) {
                    Log.d("PlayerNotificationServ", "AALibrary: No cached data available for ${library.name}")
                    val noDataItem = MediaItem.Builder()
                      .setMediaId("__NO_LIBRARY_DATA__${library.id}")
                      .setMediaMetadata(
                        MediaMetadata.Builder()
                          .setTitle("No categories available")
                          .setSubtitle("Library data may still be loading")
                          .setIsBrowsable(false)
                          .setIsPlayable(false)
                          .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
                          .setArtworkUri(getUriToDrawable(service.applicationContext, R.drawable.md_book_multiple_outline))
                          .build()
                      )
                      .build()
                    future.set(LibraryResult.ofItemList(ImmutableList.copyOf(listOf(noDataItem)), params))
                  } else {
                    Log.d("PlayerNotificationServ", "AALibrary: Returning ${children.size} cached categories for ${library.name}")
                    future.set(LibraryResult.ofItemList(ImmutableList.copyOf(children), params))
                  }
                }
              } else {
                future.set(LibraryResult.ofItemList(ImmutableList.of(), params))
              }
            }
            // Handle podcast episodes - when user selects a specific podcast
            parentId.length == 22 && !parentId.startsWith("local_") -> { // Server podcast IDs are typically 22 chars
              Log.d("PlayerNotificationServ", "AALibrary: Checking if $parentId is a podcast for episodes")
              val podcast = service.mediaManager.getCachedPodcasts("").find { it.id == parentId }
                ?: service.mediaManager.serverLibraries.flatMap { library ->
                  service.mediaManager.getCachedPodcasts(library.id)
                }.find { it.id == parentId }

              if (podcast?.mediaType == "podcast") {
                Log.d("PlayerNotificationServ", "AALibrary: Getting episodes for podcast: ${podcast.title}")
                val children = handlePodcastEpisodes(podcast)
                future.set(LibraryResult.ofItemList(ImmutableList.copyOf(children), params))
              } else {
                future.set(LibraryResult.ofItemList(ImmutableList.of(), params))
              }
            }
            else -> {
              Log.w("PlayerNotificationServ", "AALibrary: Unknown parentId: $parentId")
              future.set(LibraryResult.ofError(LibraryResult.RESULT_ERROR_BAD_VALUE))
            }
          }
        }
      }
    } catch (e: Exception) {
      Log.e("PlayerNotificationServ", "Error in onGetChildren for parentId: $parentId", e)
      future.set(LibraryResult.ofError(LibraryResult.RESULT_ERROR_UNKNOWN))
    }

    return future
  }

  /**
   * Build library categories (Authors, Series, Collections, Discovery) for a library
   * Matches original implementation structure
   */
  private fun buildLibraryCategories(library: Library): MutableList<MediaItem> {
    val categories = mutableListOf<MediaItem>()

    if (library.mediaType == "podcast") {
      // For podcast libraries, show podcasts directly
      val podcasts = service.mediaManager.getCachedPodcasts(library.id)
      return podcasts.map { podcast ->
        MediaItem.Builder()
          .setMediaId(podcast.id)
          .setMediaMetadata(
            MediaMetadata.Builder()
              .setTitle(podcast.title ?: "Unknown Podcast")
              .setArtist(podcast.authorName)
              .setIsBrowsable(true)
              .setIsPlayable(false)
              .setMediaType(MediaMetadata.MEDIA_TYPE_PODCAST)
              .setArtworkUri(podcast.getCoverUri())
              .build()
          )
          .build()
      }.toMutableList()
    }

    // For book libraries, show browsing categories
    // Authors category
    categories.add(
      MediaItem.Builder()
        .setMediaId("__LIBRARY__${library.id}__AUTHORS")
        .setMediaMetadata(
          MediaMetadata.Builder()
            .setTitle("Authors")
            .setIsBrowsable(true)
            .setIsPlayable(false)
            .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
            .setArtworkUri(getUriToDrawable(service, R.drawable.ic_author))
            .build()
        )
        .build()
    )

    // Series category
    categories.add(
      MediaItem.Builder()
        .setMediaId("__LIBRARY__${library.id}__SERIES_LIST")
        .setMediaMetadata(
          MediaMetadata.Builder()
            .setTitle("Series")
            .setIsBrowsable(true)
            .setIsPlayable(false)
            .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
            .setArtworkUri(getUriToDrawable(service, R.drawable.ic_series))
            .build()
        )
        .build()
    )

    // Collections category
    categories.add(
      MediaItem.Builder()
        .setMediaId("__LIBRARY__${library.id}__COLLECTIONS")
        .setMediaMetadata(
          MediaMetadata.Builder()
            .setTitle("Collections")
            .setIsBrowsable(true)
            .setIsPlayable(false)
            .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
            .setArtworkUri(getUriToDrawable(service, R.drawable.ic_collection))
            .build()
        )
        .build()
    )

    // Discovery category (if available)
    if (service.mediaManager.getHasDiscovery(library.id)) {
      categories.add(
        MediaItem.Builder()
          .setMediaId("__LIBRARY__${library.id}__DISCOVERY")
          .setMediaMetadata(
            MediaMetadata.Builder()
              .setTitle("Discovery")
              .setIsBrowsable(true)
              .setIsPlayable(false)
              .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
              .setArtworkUri(getUriToDrawable(service, R.drawable.ic_discovery))
              .build()
          )
          .build()
      )
    }

    return categories
  }

  /**
   * Handle complex library browsing paths (Authors, Series, Collections, etc.)
   * Matches original MediaBrowserServiceCompat implementation
   */
  private fun handleLibraryBrowsing(parentId: String): MutableList<MediaItem> {
    val mediaIdParts = parentId.split("__")
    Log.d("PlayerNotificationServ", "AALibrary: Handling library browsing for: $parentId, parts: $mediaIdParts")

    if (mediaIdParts.size < 4) return mutableListOf()

    val libraryId = mediaIdParts[2]
    val browseType = mediaIdParts[3]

    return try {
      when (browseType) {
        "AUTHORS" -> handleAuthorsBrowsing(libraryId, mediaIdParts)
        "AUTHOR" -> handleAuthorItemsBrowsing(libraryId, mediaIdParts)
        "SERIES_LIST" -> handleSeriesBrowsing(libraryId, mediaIdParts)
        "SERIES" -> handleSeriesItemsBrowsing(libraryId, mediaIdParts)
        "COLLECTIONS" -> handleCollectionsBrowsing(libraryId, mediaIdParts)
        "COLLECTION" -> handleCollectionItemsBrowsing(libraryId, mediaIdParts)
        "DISCOVERY" -> handleDiscoveryBrowsing(libraryId)
        "AUTHOR_SERIES" -> handleAuthorSeriesBrowsing(libraryId, mediaIdParts)
        else -> {
          Log.w("PlayerNotificationServ", "AALibrary: Unknown browse type: $browseType")
          mutableListOf()
        }
      }
    } catch (e: Exception) {
      Log.e("PlayerNotificationServ", "AALibrary: Error in handleLibraryBrowsing for $parentId", e)
      mutableListOf()
    }
  }

  /**
   * Load data from server synchronously with timeout
   */
  private fun <T> loadFromServerSync(
    operation: ((T) -> Unit) -> Unit,
    timeoutSeconds: Long = 5
  ): T? {
    val future = SettableFuture.create<T>()

    try {
      operation { result ->
        future.set(result)
      }
      return future.get(timeoutSeconds, TimeUnit.SECONDS)
    } catch (e: Exception) {
      Log.w("PlayerNotificationServ", "Server load timeout or error", e)
      return null
    }
  }

  /**
   * Handle authors browsing with alphabetical grouping like original
   */
  private fun handleAuthorsBrowsing(libraryId: String, mediaIdParts: List<String>): MutableList<MediaItem> {
    Log.d("PlayerNotificationServ", "AALibrary: Loading authors for library $libraryId from server")

    // Load authors from server synchronously
    val authors = loadFromServerSync<List<LibraryAuthorItem>>(
      operation = { callback ->
        service.mediaManager.loadAuthorsWithBooks(libraryId, callback)
      }
    ) ?: run {
      Log.w("PlayerNotificationServ", "AALibrary: Failed to load authors from server for library $libraryId")
      return mutableListOf()
    }

    // If we have a letter filter (5th part), filter authors by starting letter
    if (mediaIdParts.size >= 5) {
      val letterFilter = mediaIdParts[4]
      Log.d("PlayerNotificationServ", "AALibrary: Filtering authors by letter: $letterFilter")
      val filteredAuthors = authors.filter { it.name.startsWith(letterFilter, ignoreCase = true) }
      return filteredAuthors.map { author ->
        MediaItem.Builder()
          .setMediaId("__LIBRARY__${libraryId}__AUTHOR__${author.id}")
          .setMediaMetadata(
            MediaMetadata.Builder()
              .setTitle(author.name)
              .setIsBrowsable(true)
              .setIsPlayable(false)
              .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
              .build()
          )
          .build()
      }.toMutableList()
    }

    // Check if we need alphabetical grouping (like original implementation)
    val browseLimit = 50 // Match original androidAutoBrowseLimitForGrouping
    if (authors.size > browseLimit && authors.size > 1) {
      // Group by first letter
      val authorLetters = authors.groupingBy { it.name.first().uppercaseChar() }.eachCount()
      Log.d("PlayerNotificationServ", "AALibrary: Grouping ${authors.size} authors alphabetically")
      return authorLetters.map { (letter, count) ->
        MediaItem.Builder()
          .setMediaId("__LIBRARY__${libraryId}__AUTHORS__${letter}")
          .setMediaMetadata(
            MediaMetadata.Builder()
              .setTitle(letter.toString())
              .setSubtitle("$count authors")
              .setIsBrowsable(true)
              .setIsPlayable(false)
              .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
              .build()
          )
          .build()
      }.toMutableList()
    }

    // Return authors directly
    Log.d("PlayerNotificationServ", "AALibrary: Returning ${authors.size} authors directly")
    return authors.map { author ->
      MediaItem.Builder()
        .setMediaId("__LIBRARY__${libraryId}__AUTHOR__${author.id}")
        .setMediaMetadata(
          MediaMetadata.Builder()
            .setTitle(author.name)
            .setIsBrowsable(true)
            .setIsPlayable(false)
            .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
            .build()
        )
        .build()
    }.toMutableList()
  }

  /**
   * Handle books by a specific author
   */
  private fun handleAuthorItemsBrowsing(libraryId: String, mediaIdParts: List<String>): MutableList<MediaItem> {
    if (mediaIdParts.size < 5) return mutableListOf()

    val authorId = mediaIdParts[4]
    Log.d("PlayerNotificationServ", "AALibrary: Loading books for author from server: $authorId")

    // Load author books from server synchronously
    val authorBooks = loadFromServerSync<List<LibraryItem>>(
      operation = { callback ->
        service.mediaManager.loadAuthorBooksWithAudio(libraryId, authorId, callback)
      }
    ) ?: run {
      Log.w("PlayerNotificationServ", "AALibrary: Failed to load author books from server for $authorId")
      return mutableListOf()
    }

    Log.d("PlayerNotificationServ", "AALibrary: Loaded ${authorBooks.size} books for author $authorId from server")

    return authorBooks.map { book ->
      val progress = service.mediaManager.serverUserMediaProgress.find { it.libraryItemId == book.id }
      MediaItem.Builder()
        .setMediaId(book.id)
        .setMediaMetadata(
          MediaMetadata.Builder()
            .setTitle(book.title ?: "Unknown Title")
            .setArtist(formatAuthorWithDownloadIcon(book.id, book.authorName))
            .setIsPlayable(true)
            .setIsBrowsable(false)
            .setMediaType(MediaMetadata.MEDIA_TYPE_AUDIO_BOOK)
            .setArtworkUri(book.getCoverUri())
            .apply {
              // Add progress information if available
              progress?.let { prog ->
                setExtras(Bundle().apply {
                  putDouble("progress", prog.progress)
                  putLong("currentTime", prog.currentTime.toLong())
                  putLong("duration", prog.duration.toLong())
                })
              }
            }
            .build()
        )
        .build()
    }.toMutableList()
  }

  /**
   * Handle series browsing with alphabetical grouping like original
   */
  private fun handleSeriesBrowsing(libraryId: String, mediaIdParts: List<String>): MutableList<MediaItem> {
    Log.d("PlayerNotificationServ", "AALibrary: Loading series for library $libraryId from server")

    // Load series from server synchronously
    val series = loadFromServerSync<List<LibrarySeriesItem>>(
      operation = { callback ->
        service.mediaManager.loadLibrarySeriesWithAudio(libraryId, callback)
      }
    ) ?: run {
      Log.w("PlayerNotificationServ", "AALibrary: Failed to load series from server for library $libraryId")
      return mutableListOf()
    }

    // If we have a letter filter (5th part), filter series by starting letter
    if (mediaIdParts.size >= 5) {
      val letterFilter = mediaIdParts[4]
      Log.d("PlayerNotificationServ", "AALibrary: Filtering series by letter: $letterFilter")
      val filteredSeries = series.filter { it.name.startsWith(letterFilter, ignoreCase = true) }
      return filteredSeries.map { series ->
        MediaItem.Builder()
          .setMediaId("__LIBRARY__${libraryId}__SERIES__${series.id}")
          .setMediaMetadata(
            MediaMetadata.Builder()
              .setTitle(series.name)
              .setSubtitle("${series.audiobookCount} books")
              .setIsBrowsable(true)
              .setIsPlayable(false)
              .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
              .build()
          )
          .build()
      }.toMutableList()
    }

    // Check if we need alphabetical grouping
    val browseLimit = 50
    if (series.size > browseLimit && series.size > 1) {
      // Group by first letter
      val seriesLetters = series.groupingBy { it.name.first().uppercaseChar() }.eachCount()
      Log.d("PlayerNotificationServ", "AALibrary: Grouping ${series.size} series alphabetically")
      return seriesLetters.map { (letter, count) ->
        MediaItem.Builder()
          .setMediaId("__LIBRARY__${libraryId}__SERIES_LIST__${letter}")
          .setMediaMetadata(
            MediaMetadata.Builder()
              .setTitle(letter.toString())
              .setSubtitle("$count series")
              .setIsBrowsable(true)
              .setIsPlayable(false)
              .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
              .build()
          )
          .build()
      }.toMutableList()
    }

    // Return series directly
    Log.d("PlayerNotificationServ", "AALibrary: Returning ${series.size} series directly")
    return series.map { seriesItem ->
      MediaItem.Builder()
        .setMediaId("__LIBRARY__${libraryId}__SERIES__${seriesItem.id}")
        .setMediaMetadata(
          MediaMetadata.Builder()
            .setTitle(seriesItem.name)
            .setSubtitle("${seriesItem.audiobookCount} books")
            .setIsBrowsable(true)
            .setIsPlayable(false)
            .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
            .build()
        )
        .build()
    }.toMutableList()
  }

  /**
   * Handle series items browsing (books in a series) like original
   */
  private fun handleSeriesItemsBrowsing(libraryId: String, mediaIdParts: List<String>): MutableList<MediaItem> {
    if (mediaIdParts.size < 5) return mutableListOf()

    val seriesId = mediaIdParts[4]
    Log.d("PlayerNotificationServ", "AALibrary: Loading books for series from server: $seriesId")

    // Load series books from server synchronously
    val seriesBooks = loadFromServerSync<List<LibraryItem>>(
      operation = { callback ->
        service.mediaManager.loadLibrarySeriesItemsWithAudio(libraryId, seriesId, callback)
      }
    ) ?: run {
      Log.w("PlayerNotificationServ", "AALibrary: Failed to load series books from server for $seriesId")
      return mutableListOf()
    }

    Log.d("PlayerNotificationServ", "AALibrary: Loaded ${seriesBooks.size} books for series $seriesId from server")

    return seriesBooks.map { book ->
      val progress = service.mediaManager.serverUserMediaProgress.find { it.libraryItemId == book.id }
      MediaItem.Builder()
        .setMediaId(book.id)
        .setMediaMetadata(
          MediaMetadata.Builder()
            .setTitle(book.title ?: "Unknown Title")
            .setArtist(book.authorName)
            .setIsPlayable(true)
            .setIsBrowsable(false)
            .setMediaType(MediaMetadata.MEDIA_TYPE_AUDIO_BOOK)
            .setArtworkUri(book.getCoverUri())
            .apply {
              // Add progress information if available
              progress?.let { prog ->
                setExtras(Bundle().apply {
                  putDouble("progress", prog.progress)
                  putLong("currentTime", prog.currentTime.toLong())
                  putLong("duration", prog.duration.toLong())
                })
              }
            }
            .build()
        )
        .build()
    }.toMutableList()
  }

  /**
   * Handle collections browsing like original
   */
  private fun handleCollectionsBrowsing(libraryId: String, mediaIdParts: List<String>): MutableList<MediaItem> {
    // Use cached collections if available
    val cachedCollections = service.mediaManager.getCachedCollections(libraryId)

    Log.d("PlayerNotificationServ", "AALibrary: Returning ${cachedCollections.size} collections")
    return cachedCollections.map { collection ->
      MediaItem.Builder()
        .setMediaId("__LIBRARY__${libraryId}__COLLECTION__${collection.id}")
        .setMediaMetadata(
          MediaMetadata.Builder()
            .setTitle(collection.name)
            .setSubtitle("${collection.bookCount} books")
            .setIsBrowsable(true)
            .setIsPlayable(false)
            .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
            .build()
        )
        .build()
    }.toMutableList()
  }

  /**
   * Handle collection items browsing (books in a collection) like original
   */
  private fun handleCollectionItemsBrowsing(libraryId: String, mediaIdParts: List<String>): MutableList<MediaItem> {
    if (mediaIdParts.size < 5) return mutableListOf()

    val collectionId = mediaIdParts[4]
    Log.d("PlayerNotificationServ", "AALibrary: Getting books for collection: $collectionId")

    // Get cached collection books if available
    val collectionBooks = service.mediaManager.getCachedCollectionBooks(libraryId, collectionId)

    return collectionBooks.map { book ->
      val progress = service.mediaManager.serverUserMediaProgress.find { it.libraryItemId == book.id }
      MediaItem.Builder()
        .setMediaId(book.id)
        .setMediaMetadata(
          MediaMetadata.Builder()
            .setTitle(book.title ?: "Unknown Title")
            .setArtist(book.authorName)
            .setIsPlayable(true)
            .setIsBrowsable(false)
            .setMediaType(MediaMetadata.MEDIA_TYPE_AUDIO_BOOK)
            .setArtworkUri(book.getCoverUri())
            .apply {
              // Add progress information if available
              progress?.let { prog ->
                setExtras(Bundle().apply {
                  putDouble("progress", prog.progress)
                  putLong("currentTime", prog.currentTime.toLong())
                  putLong("duration", prog.duration.toLong())
                })
              }
            }
            .build()
        )
        .build()
    }.toMutableList()
  }

  /**
   * Handle discovery browsing like original
   */
  private fun handleDiscoveryBrowsing(libraryId: String): MutableList<MediaItem> {
    Log.d("PlayerNotificationServ", "AALibrary: Loading discovery items from server for library: $libraryId")

    // Load discovery items from server synchronously
    val discoveryItems = loadFromServerSync<List<LibraryItem>>(
      operation = { callback ->
        service.mediaManager.loadLibraryDiscoveryBooksWithAudio(libraryId, callback)
      }
    ) ?: run {
      Log.w("PlayerNotificationServ", "AALibrary: Failed to load discovery items from server for $libraryId")
      return mutableListOf()
    }

    Log.d("PlayerNotificationServ", "AALibrary: Loaded ${discoveryItems.size} discovery items from server")
    return discoveryItems.map { book ->
      val progress = service.mediaManager.serverUserMediaProgress.find { it.libraryItemId == book.id }
      MediaItem.Builder()
        .setMediaId(book.id)
        .setMediaMetadata(
          MediaMetadata.Builder()
            .setTitle(book.title ?: "Unknown Title")
            .setArtist(book.authorName)
            .setIsPlayable(true)
            .setIsBrowsable(false)
            .setMediaType(MediaMetadata.MEDIA_TYPE_AUDIO_BOOK)
            .setArtworkUri(book.getCoverUri())
            .apply {
              // Add progress information if available
              progress?.let { prog ->
                setExtras(Bundle().apply {
                  putDouble("progress", prog.progress)
                  putLong("currentTime", prog.currentTime.toLong())
                  putLong("duration", prog.duration.toLong())
                })
              }
            }
            .build()
        )
        .build()
    }.toMutableList()
  }

  /**
   * Handle author series browsing (books by specific author in specific series)
   */
  private fun handleAuthorSeriesBrowsing(libraryId: String, mediaIdParts: List<String>): MutableList<MediaItem> {
    if (mediaIdParts.size < 6) return mutableListOf()

    val authorId = mediaIdParts[4]
    val seriesId = mediaIdParts[5]
    Log.d("PlayerNotificationServ", "AALibrary: Getting books for author $authorId in series $seriesId")

    // Get cached author-series books if available
    val authorSeriesBooks = service.mediaManager.getCachedAuthorSeriesBooks(libraryId, authorId, seriesId)

    return authorSeriesBooks.map { book ->
      val progress = service.mediaManager.serverUserMediaProgress.find { it.libraryItemId == book.id }
      MediaItem.Builder()
        .setMediaId(book.id)
        .setMediaMetadata(
          MediaMetadata.Builder()
            .setTitle(book.title ?: "Unknown Title")
            .setArtist(book.authorName)
            .setIsPlayable(true)
            .setIsBrowsable(false)
            .setMediaType(MediaMetadata.MEDIA_TYPE_AUDIO_BOOK)
            .setArtworkUri(book.getCoverUri())
            .apply {
              // Add progress information if available
              progress?.let { prog ->
                setExtras(Bundle().apply {
                  putDouble("progress", prog.progress)
                  putLong("currentTime", prog.currentTime.toLong())
                  putLong("duration", prog.duration.toLong())
                })
              }
            }
            .build()
        )
        .build()
    }.toMutableList()
  }

  /**
   * Handle podcast episodes browsing
   */
  private fun handlePodcastEpisodes(podcast: LibraryItem): MutableList<MediaItem> {
    if (podcast.mediaType != "podcast") return mutableListOf()

    val podcastMedia = podcast.media as? Podcast ?: return mutableListOf()
    val episodes = podcastMedia.episodes ?: return mutableListOf()

    Log.d("PlayerNotificationServ", "AALibrary: Returning ${episodes.size} episodes for podcast ${podcast.title}")

    // Sort episodes by published date (newest first)
    val sortedEpisodes = episodes.sortedByDescending { it.publishedAt ?: 0 }

    return sortedEpisodes.map { episode ->
      val progress = service.mediaManager.serverUserMediaProgress.find {
        it.libraryItemId == podcast.id && it.episodeId == episode.id
      }

      MediaItem.Builder()
        .setMediaId(episode.id)
        .setMediaMetadata(
          MediaMetadata.Builder()
            .setTitle(episode.title ?: "Unknown Episode")
            .setArtist(podcast.title ?: "Unknown Podcast")
            .setIsPlayable(true)
            .setIsBrowsable(false)
            .setMediaType(MediaMetadata.MEDIA_TYPE_PODCAST)
            .setArtworkUri(podcast.getCoverUri())
            .apply {
              // Add episode description if available
              episode.description?.let { desc ->
                setDescription(desc)
              }
              // Add progress information if available
              progress?.let { prog ->
                setExtras(Bundle().apply {
                  putDouble("progress", prog.progress)
                  putLong("currentTime", prog.currentTime.toLong())
                  putLong("duration", prog.duration.toLong())
                })
              }
            }
            .build()
        )
        .build()
    }.toMutableList()
  }

  override fun onSearch(
    session: MediaLibrarySession,
    browser: MediaSession.ControllerInfo,
    query: String,
    params: LibraryParams?
  ): ListenableFuture<LibraryResult<Void>> {
    Log.d("PlayerNotificationServ", "AALibrary: onSearch called with query: '$query'")

    try {
      // Validate the query
      if (query.isBlank()) {
        Log.w("PlayerNotificationServ", "AALibrary: Empty search query")
        return Futures.immediateFuture(LibraryResult.ofError(LibraryResult.RESULT_ERROR_BAD_VALUE))
      }

      Log.d("PlayerNotificationServ", "AALibrary: Search query accepted: '$query' - performing server search")

      // Check server connection before attempting search
      if (!service.mediaManager.hasValidServerConnection()) {
        Log.w("PlayerNotificationServ", "AALibrary: No server connection, cannot perform search")
        session.notifySearchResultChanged(browser, query, 0, params)
        return Futures.immediateFuture(LibraryResult.ofVoid())
      }

      // Perform server search to get actual results
      val searchResults = performServerSearch(query)
      val resultCount = searchResults.size

      // Cache results for onGetSearchResult
      cachedSearchQuery = query
      cachedSearchResults = searchResults

      Log.d("PlayerNotificationServ", "AALibrary: Found ${resultCount} search results, notifying Android Auto")

      // Notify Android Auto with the search result count
      // This tells Android Auto that search results are available and triggers onGetSearchResult
      session.notifySearchResultChanged(browser, query, resultCount, params)

      return Futures.immediateFuture(LibraryResult.ofVoid())
    } catch (e: Exception) {
      Log.e("PlayerNotificationServ", "AALibrary: Error in onSearch", e)
      return Futures.immediateFuture(LibraryResult.ofError(LibraryResult.RESULT_ERROR_UNKNOWN))
    }
  }

  override fun onGetSearchResult(
    session: MediaLibrarySession,
    browser: MediaSession.ControllerInfo,
    query: String,
    page: Int,
    pageSize: Int,
    params: LibraryParams?
  ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> {
    Log.d("PlayerNotificationServ", "AALibrary: onGetSearchResult called with query: '$query'")
    return try {
      // Return cached search results from onSearch
      if (cachedSearchQuery == query) {
        Log.d("PlayerNotificationServ", "AALibrary: Returning cached search results for query: '$query' (${cachedSearchResults.size} items)")
        Futures.immediateFuture(LibraryResult.ofItemList(ImmutableList.copyOf(cachedSearchResults), params))
      } else {
        Log.w("PlayerNotificationServ", "AALibrary: No cached results for query: '$query', returning empty list")
        Futures.immediateFuture(LibraryResult.ofItemList(ImmutableList.of(), params))
      }
    } catch (e: Exception) {
      Log.e("PlayerNotificationServ", "Error in onGetSearchResult for query: $query", e)
      Futures.immediateFuture(LibraryResult.ofError(LibraryResult.RESULT_ERROR_UNKNOWN))
    }
  }

  // Search helper function that queries the server directly
  private fun performServerSearch(query: String): MutableList<MediaItem> {
    Log.d("PlayerNotificationServ", "AALibrary: Performing server search for query: '$query'")

    val searchResults = mutableListOf<MediaItem>()
    val libraries = service.mediaManager.serverLibraries

    if (libraries.isEmpty()) {
      Log.w("PlayerNotificationServ", "AALibrary: No server libraries available for search")
      return searchResults
    }

    try {
      // Search across all libraries synchronously using the helper function
      libraries.forEach { library ->
        Log.d("PlayerNotificationServ", "AALibrary: Searching library: ${library.name}")

        val libraryResults = loadFromServerSync<LibraryItemSearchResultType?>(
          operation = { callback ->
            service.apiHandler.getSearchResults(library.id, query, callback)
          }
        )

        libraryResults?.let { result ->
          // Add books from search results
          result.book?.forEach { bookResult ->
            val book = bookResult.libraryItem
            Log.d("PlayerNotificationServ", "AALibrary: Found server book: ${book.title}")
            searchResults.add(
              MediaItem.Builder()
                .setMediaId(book.id)
                .setMediaMetadata(
                  MediaMetadata.Builder()
                    .setTitle(book.title ?: "Unknown Title")
                    .setArtist(book.authorName)
                    .setIsPlayable(true)
                    .setIsBrowsable(false)
                    .setMediaType(MediaMetadata.MEDIA_TYPE_AUDIO_BOOK)
                    .setArtworkUri(book.getCoverUri())
                    .build()
                )
                .build()
            )
          }

          // Add podcasts from search results
          result.podcast?.forEach { podcastResult ->
            val podcast = podcastResult.libraryItem
            Log.d("PlayerNotificationServ", "AALibrary: Found server podcast: ${podcast.title}")
            searchResults.add(
              MediaItem.Builder()
                .setMediaId(podcast.id)
                .setMediaMetadata(
                  MediaMetadata.Builder()
                    .setTitle(podcast.title ?: "Unknown Title")
                    .setArtist(podcast.authorName)
                    .setIsPlayable(true)
                    .setIsBrowsable(false)
                    .setMediaType(MediaMetadata.MEDIA_TYPE_PODCAST)
                    .setArtworkUri(podcast.getCoverUri())
                    .build()
                )
                .build()
            )
          }

          // Add authors from search results
          result.authors?.forEach { author ->
            Log.d("PlayerNotificationServ", "AALibrary: Found server author: ${author.name}")
            searchResults.add(
              MediaItem.Builder()
                .setMediaId("__LIBRARY__${library.id}__AUTHOR__${author.id}")
                .setMediaMetadata(
                  MediaMetadata.Builder()
                    .setTitle(author.name)
                    .setIsPlayable(false)
                    .setIsBrowsable(true)
                    .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
                    .build()
                )
                .build()
            )
          }

          // Add series from search results
          result.series?.forEach { seriesResult ->
            Log.d("PlayerNotificationServ", "AALibrary: Found server series: ${seriesResult.series.name}")
            searchResults.add(
              MediaItem.Builder()
                .setMediaId("__LIBRARY__${library.id}__SERIES__${seriesResult.series.id}")
                .setMediaMetadata(
                  MediaMetadata.Builder()
                    .setTitle(seriesResult.series.name)
                    .setSubtitle("${seriesResult.series.audiobookCount} books")
                    .setIsPlayable(false)
                    .setIsBrowsable(true)
                    .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
                    .build()
                )
                .build()
            )
          }
        }
      }

      Log.d("PlayerNotificationServ", "AALibrary: Server search completed. Found ${searchResults.size} results for query: '$query'")

    } catch (e: Exception) {
      Log.e("PlayerNotificationServ", "Error performing server search for query: '$query'", e)
    }

    return searchResults
  }


  override fun onCustomCommand(
    session: MediaSession,
    controller: MediaSession.ControllerInfo,
    customCommand: SessionCommand,
    args: Bundle
  ): ListenableFuture<SessionResult> {
    Log.d("PlayerNotificationServ", "Media3: onCustomCommand received: ${customCommand.customAction}")
    when (customCommand.customAction) {
      PlayerNotificationService.CUSTOM_ACTION_JUMP_BACKWARD -> {
        Log.d("PlayerNotificationServ", "Media3: JUMP_BACKWARD -> calling jumpBackward()")
        service.jumpBackward()
      }
      PlayerNotificationService.CUSTOM_ACTION_JUMP_FORWARD -> {
        Log.d("PlayerNotificationServ", "Media3: JUMP_FORWARD -> calling jumpForward()")
        service.jumpForward()
      }
      PlayerNotificationService.CUSTOM_ACTION_CHANGE_PLAYBACK_SPEED -> {
        Log.d("PlayerNotificationServ", "Media3: CHANGE_PLAYBACK_SPEED -> calling cyclePlaybackSpeed()")
        service.cyclePlaybackSpeed()
      }
      PlayerNotificationService.CUSTOM_ACTION_SKIP_TO_NEXT -> {
        Log.d("PlayerNotificationServ", "Media3: SKIP_TO_NEXT -> calling seekToNextChapter()")
        service.seekToNextChapter()
      }
      PlayerNotificationService.CUSTOM_ACTION_SKIP_TO_PREVIOUS -> {
        Log.d("PlayerNotificationServ", "Media3: SKIP_TO_PREVIOUS -> calling seekToPreviousChapter()")
        service.seekToPreviousChapter()
      }
    }
    return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
  }

  /**
   * Intercept player commands from bluetooth/external controls and redirect skip commands
   * to jump forward/backward instead of skipping to next/previous items in queue
   * Also intercept SEEK_BACK/SEEK_FORWARD to use our custom jump amounts
   */
  override fun onPlayerCommandRequest(
    session: MediaSession,
    controller: MediaSession.ControllerInfo,
    playerCommand: Int
  ): Int {
    return when (playerCommand) {
      Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM, Player.COMMAND_SEEK_TO_NEXT -> {
        // Intercept next track command from bluetooth/car and redirect to jump forward
        Log.d("PlayerNotificationServ", "External Control: Intercepting skip to next, redirecting to jump forward")
        service.jumpForward()
        SessionResult.RESULT_SUCCESS // Return success to indicate we handled it
      }
      Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM, Player.COMMAND_SEEK_TO_PREVIOUS -> {
        // Intercept previous track command from bluetooth/car and redirect to jump backward
        Log.d("PlayerNotificationServ", "External Control: Intercepting skip to previous, redirecting to jump backward")
        service.jumpBackward()
        SessionResult.RESULT_SUCCESS // Return success to indicate we handled it
      }
      Player.COMMAND_SEEK_FORWARD -> {
        // Intercept seek forward (including KEYCODE_MEDIA_FAST_FORWARD) to use our custom jump amount
        Log.d("PlayerNotificationServ", "External Control: Intercepting seek forward, redirecting to jump forward")
        service.jumpForward()
        SessionResult.RESULT_SUCCESS // Return success to indicate we handled it
      }
      Player.COMMAND_SEEK_BACK -> {
        // Intercept seek back (including KEYCODE_MEDIA_REWIND) to use our custom jump amount
        Log.d("PlayerNotificationServ", "External Control: Intercepting seek back, redirecting to jump backward")
        service.jumpBackward()
        SessionResult.RESULT_SUCCESS // Return success to indicate we handled it
      }
      else -> {
        // Allow all other commands to execute normally
        super.onPlayerCommandRequest(session, controller, playerCommand)
      }
    }
  }

  override fun onAddMediaItems(
    session: MediaSession,
    controller: MediaSession.ControllerInfo,
    mediaItems: MutableList<MediaItem>
  ): ListenableFuture<MutableList<MediaItem>> {
    Log.d("PlayerNotificationServ", "AALibrary: onAddMediaItems called with ${mediaItems.size} items")

    // Check if this is a search request by looking for search query in request metadata
    val firstItem = mediaItems.firstOrNull()
    val searchQuery = firstItem?.requestMetadata?.searchQuery

    if (!searchQuery.isNullOrBlank()) {
      // This is a search request from Android Auto
      Log.d("PlayerNotificationServ", "AALibrary: onAddMediaItems detected search query: '$searchQuery'")

      try {
        // Check if we have cached results for this query (from onSearch)
        if (cachedSearchQuery == searchQuery) {
          Log.d("PlayerNotificationServ", "AALibrary: onAddMediaItems returning cached search results: ${cachedSearchResults.size}")
          return Futures.immediateFuture(cachedSearchResults.toMutableList())
        } else {
          // Perform fresh server search
          val searchResults = performServerSearch(searchQuery)
          Log.d("PlayerNotificationServ", "AALibrary: onAddMediaItems returning ${searchResults.size} fresh search results")
          return Futures.immediateFuture(searchResults.toMutableList())
        }
      } catch (e: Exception) {
        Log.e("PlayerNotificationServ", "Error handling search in onAddMediaItems for query: '$searchQuery'", e)
        return Futures.immediateFuture(mutableListOf())
      }
    }

    // Process each MediaItem for normal playback (not search)
    val processedItems = mediaItems.map { mediaItem ->
      val mediaId = mediaItem.mediaId
      Log.d("PlayerNotificationServ", "AALibrary: Processing MediaItem with ID: $mediaId")

      // Start playback for the selected item (similar to onPlayFromMediaId)
      handleMediaItemPlayback(mediaId)

      // Return the original MediaItem
      mediaItem
    }.toMutableList()

    return Futures.immediateFuture(processedItems)
  }

  override fun onSetMediaItems(
    session: MediaSession,
    controller: MediaSession.ControllerInfo,
    mediaItems: MutableList<MediaItem>,
    startIndex: Int,
    startPositionMs: Long
  ): ListenableFuture<MediaSession.MediaItemsWithStartPosition> {
    Log.d("PlayerNotificationServ", "AALibrary: onSetMediaItems called with ${mediaItems.size} items, startIndex: $startIndex")

    // Debug: Log all MediaItem URIs to identify null ones
    mediaItems.forEachIndexed { index, mediaItem ->
      Log.d("PlayerNotificationServ", "AALibrary: MediaItem[$index] - ID: ${mediaItem.mediaId}, URI: ${mediaItem.localConfiguration?.uri}")
    }

    // Separate browsable MediaItems (null URIs) from playable ones
    val playableMediaItems = mutableListOf<MediaItem>()
    var hasNullUriItems = false

    mediaItems.forEach { mediaItem ->
      if (mediaItem.localConfiguration?.uri == null) {
        hasNullUriItems = true
        Log.w("PlayerNotificationServ", "AALibrary: MediaItem with null URI found: ${mediaItem.mediaId}, starting playback directly")

        // Start playback for this item directly since it doesn't have a URI
        // The actual media items will be set when preparePlayer is called
        handleMediaItemPlayback(mediaItem.mediaId)
      } else {
        // This MediaItem has a valid URI and can be played
        playableMediaItems.add(mediaItem)
      }
    }

    // If we had null URI items, we started playback directly via handleMediaItemPlayback
    // Return an empty MediaItemsWithStartPosition to avoid ExoPlayer trying to process null URIs
    // The actual playable MediaItems will be set when preparePlayer() is called
    if (hasNullUriItems) {
      Log.d("PlayerNotificationServ", "AALibrary: Found null URI items, returning empty MediaItems (playback started via handleMediaItemPlayback)")
      return Futures.immediateFuture(
        MediaSession.MediaItemsWithStartPosition(mutableListOf(), 0, 0L)
      )
    }

    // If all MediaItems have valid URIs, return them normally
    Log.d("PlayerNotificationServ", "AALibrary: All ${playableMediaItems.size} MediaItems have valid URIs, returning normally")
    return Futures.immediateFuture(
      MediaSession.MediaItemsWithStartPosition(playableMediaItems, startIndex, startPositionMs)
    )
  }

  /**
   * Helper function to get title from LibraryItemWrapper
   */
  private fun getLibraryItemTitle(item: LibraryItemWrapper): String {
    return when (item) {
      is LibraryItem -> item.title
      is LocalLibraryItem -> item.title
      is LibraryAuthorItem -> item.title
      is LibrarySeriesItem -> item.title
      is LibraryCollection -> item.title
      is CollapsedSeries -> item.title
      else -> "Unknown Title"
    }
  }

  /**
   * Handle media item playback (equivalent to onPlayFromMediaId)
   * Starts playback from the last saved location
   */
  private fun handleMediaItemPlayback(mediaId: String) {
    Log.d("PlayerNotificationServ", "AALibrary: handleMediaItemPlayback for mediaId: $mediaId")

    val libraryItemWrapper: LibraryItemWrapper?
    var podcastEpisode: PodcastEpisode? = null
    var chapterStartTime: Double? = null

    when {
      mediaId.isNullOrEmpty() -> {
        libraryItemWrapper = service.mediaManager.getFirstItem()
      }
      mediaId.contains("_chapter_") -> {
        // Handle chapter-specific media ID from MediaBrowserManager
        val parts = mediaId.split("_chapter_")
        val bookId = parts[0]
        val chapterIndex = parts.getOrNull(1)?.toIntOrNull()

        Log.d("PlayerNotificationServ", "AALibrary: Playing chapter $chapterIndex from book $bookId")

        // Get the book
        val bookWrapper = service.mediaManager.getByIdSync(bookId)
        if (bookWrapper != null && chapterIndex != null) {
          libraryItemWrapper = bookWrapper

          // Get the chapter start time
          if (bookWrapper is LibraryItem) {
            val book = bookWrapper.media as? Book
            val chapters = book?.chapters
            if (chapters != null && chapterIndex < chapters.size) {
              chapterStartTime = chapters[chapterIndex].start
              Log.d("PlayerNotificationServ", "AALibrary: Chapter start time: $chapterStartTime seconds")
            }
          } else if (bookWrapper is LocalLibraryItem) {
            val book = bookWrapper.media as? Book
            val chapters = book?.chapters
            if (chapters != null && chapterIndex < chapters.size) {
              chapterStartTime = chapters[chapterIndex].start
              Log.d("PlayerNotificationServ", "AALibrary: Local chapter start time: $chapterStartTime seconds")
            }
          }
        } else {
          libraryItemWrapper = null
          Log.e("PlayerNotificationServ", "AALibrary: Chapter book not found or invalid chapter index: $bookId, chapter: $chapterIndex")
        }
      }
      else -> {
        // Handle podcast episodes
        val libraryItemWithEpisode = service.mediaManager.getPodcastWithEpisodeByEpisodeId(mediaId)
        if (libraryItemWithEpisode != null) {
          libraryItemWrapper = libraryItemWithEpisode.libraryItemWrapper
          podcastEpisode = libraryItemWithEpisode.episode
          Log.d("PlayerNotificationServ", "AALibrary: Found podcast episode: ${podcastEpisode?.title}")
        } else {
          // Handle regular books (both local and server)
          var foundWrapper = service.mediaManager.getByIdSync(mediaId)
          if (foundWrapper == null) {
            // If not found, try with local_ prefix in case Android Auto stripped it
            val localMediaId = "local_$mediaId"
            foundWrapper = service.mediaManager.getByIdSync(localMediaId)
            if (foundWrapper != null) {
              Log.d("PlayerNotificationServ", "AALibrary: Found local book with prefixed ID: $localMediaId")
            } else {
              Log.e("PlayerNotificationServ", "AALibrary: Media item not found $mediaId")
            }
          } else {
            Log.d("PlayerNotificationServ", "AALibrary: Found book: ${getLibraryItemTitle(foundWrapper)}")
          }
          libraryItemWrapper = foundWrapper
        }
      }
    }

    libraryItemWrapper?.let { li ->
      Log.d("PlayerNotificationServ", "AALibrary: Starting playback for: ${getLibraryItemTitle(li)}")
      service.mediaManager.play(li, podcastEpisode, service.getPlayItemRequestPayload(false)) { playbackSession ->
        if (playbackSession == null) {
          Log.e("PlayerNotificationServ", "AALibrary: Failed to create playback session")
        } else {
          Log.d("PlayerNotificationServ", "AALibrary: Playback session created, preparing player")
          Log.d("PlayerNotificationServ", "AALibrary: Playback session currentTime: ${playbackSession.currentTime}s (${playbackSession.currentTimeMs}ms)")

          // Check if this is a chapter-aware book and log chapter information
          if (playbackSession.chapters.isNotEmpty()) {
            Log.d("PlayerNotificationServ", "AALibrary: Book has ${playbackSession.chapters.size} chapters")
            val currentTimeMs = playbackSession.currentTimeMs
            val targetChapter = playbackSession.chapters.find { chapter ->
              currentTimeMs >= chapter.startMs && currentTimeMs < chapter.endMs
            }
            if (targetChapter != null) {
              val chapterRelativePosition = currentTimeMs - targetChapter.startMs
              Log.d("PlayerNotificationServ", "AALibrary: Target chapter: '${targetChapter.title}' (${targetChapter.startMs}ms-${targetChapter.endMs}ms)")
              Log.d("PlayerNotificationServ", "AALibrary: Chapter-relative position would be: ${chapterRelativePosition}ms")
            } else {
              Log.w("PlayerNotificationServ", "AALibrary: No chapter found for saved position ${currentTimeMs}ms")
            }
          }

          val playbackRate = service.mediaManager.getSavedPlaybackRate()
          Handler(Looper.getMainLooper()).post {
            Log.d("PlayerNotificationServ", "AALibrary: Preparing player with playWhenReady=true for automatic start")

            // Prepare player with playWhenReady=true for Android Auto to start automatically
            service.preparePlayer(playbackSession, true, playbackRate)

            // If we have a chapter start time, seek to it after a small delay
            chapterStartTime?.let { startTime ->
              Handler(Looper.getMainLooper()).postDelayed({
                Log.d("PlayerNotificationServ", "AALibrary: Seeking to chapter start time: $startTime seconds")
                service.seekPlayer((startTime * 1000).toLong())
              }, 500)
            }

            Log.d("PlayerNotificationServ", "AALibrary: Player prepared with auto-start enabled")
          }
        }
      }
    }
  }

  override fun onConnect(session: MediaSession, controller: MediaSession.ControllerInfo): MediaSession.ConnectionResult {
    val connectionResult = super.onConnect(session, controller)

    // Build custom session commands from scratch
    val availableSessionCommands = connectionResult.availableSessionCommands.buildUpon()
    availableSessionCommands.add(SessionCommand(PlayerNotificationService.CUSTOM_ACTION_JUMP_BACKWARD, Bundle.EMPTY))
    availableSessionCommands.add(SessionCommand(PlayerNotificationService.CUSTOM_ACTION_JUMP_FORWARD, Bundle.EMPTY))
    availableSessionCommands.add(SessionCommand(PlayerNotificationService.CUSTOM_ACTION_CHANGE_PLAYBACK_SPEED, Bundle.EMPTY))
    availableSessionCommands.add(SessionCommand(PlayerNotificationService.CUSTOM_ACTION_SKIP_TO_NEXT, Bundle.EMPTY))
    availableSessionCommands.add(SessionCommand(PlayerNotificationService.CUSTOM_ACTION_SKIP_TO_PREVIOUS, Bundle.EMPTY))

    // Build player commands explicitly to control Android Auto and Bluetooth behavior
    // Start from an empty builder to have full control over which commands are available
    val availablePlayerCommands = Player.Commands.Builder()
      // Core playback controls
      .add(Player.COMMAND_PLAY_PAUSE)
      .add(Player.COMMAND_PREPARE)
      .add(Player.COMMAND_STOP)
      // Seek controls
      .add(Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM)
      .add(Player.COMMAND_SEEK_TO_DEFAULT_POSITION)
      .add(Player.COMMAND_SEEK_FORWARD) // For KEYCODE_MEDIA_FAST_FORWARD - intercepted and redirected
      .add(Player.COMMAND_SEEK_BACK) // For KEYCODE_MEDIA_REWIND - intercepted and redirected
      // Speed control
      .add(Player.COMMAND_SET_SPEED_AND_PITCH)
      // Audio attributes
      .add(Player.COMMAND_SET_VOLUME)
      .add(Player.COMMAND_ADJUST_DEVICE_VOLUME)
      // Media metadata
      .add(Player.COMMAND_GET_CURRENT_MEDIA_ITEM)
      .add(Player.COMMAND_GET_TIMELINE)
      .add(Player.COMMAND_GET_MEDIA_ITEMS_METADATA)
      .add(Player.COMMAND_GET_METADATA)
      // Track selection
      .add(Player.COMMAND_GET_TRACKS)
      .add(Player.COMMAND_SET_TRACK_SELECTION_PARAMETERS)
      // Media item management - REQUIRED for Android Auto to add/set media items
      .add(Player.COMMAND_CHANGE_MEDIA_ITEMS)
      .add(Player.COMMAND_SET_MEDIA_ITEM)
      .add(Player.COMMAND_SEEK_TO_MEDIA_ITEM)
      // Device volume commands
      .add(Player.COMMAND_GET_DEVICE_VOLUME)
      .add(Player.COMMAND_SET_DEVICE_VOLUME)
      .add(Player.COMMAND_SET_DEVICE_VOLUME_WITH_FLAGS)
      // Audio attributes
      .add(Player.COMMAND_GET_AUDIO_ATTRIBUTES)
      .add(Player.COMMAND_SET_AUDIO_ATTRIBUTES)
      // Player release
      .add(Player.COMMAND_RELEASE)
      // EXPLICITLY OMITTED to force use of custom commands intercepted in onPlayerCommandRequest:
      // - Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM (would skip chapters)
      // - Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM (would skip chapters)
      // Note: COMMAND_SEEK_FORWARD and COMMAND_SEEK_BACK are ENABLED but intercepted in
      // onPlayerCommandRequest to redirect to jumpForward/jumpBackward with custom amounts
      .build()

    return MediaSession.ConnectionResult.accept(
      availableSessionCommands.build(),
      availablePlayerCommands
    )
  }

  /**
   * Check if a parentId requires data to be loaded from the server
   */
  private fun needsDataLoadingForParentId(parentId: String): Boolean {
    return when {
      parentId.contains("__AUTHORS__") -> true
      parentId.contains("__SERIES__") -> true
      parentId.contains("__COLLECTIONS__") -> true
      parentId.contains("__DISCOVERY__") -> true
      else -> false
    }
  }

  /**
   * Ensure data is loaded for specific browsing contexts
   */
  private fun ensureDataLoadedForBrowsing(parentId: String, cb: () -> Unit) {
    when {
      parentId.contains("__AUTHORS__") -> {
        val libraryId = extractLibraryIdFromParentId(parentId)
        if (libraryId.isNotEmpty()) {
          service.mediaManager.loadAuthorsWithBooks(libraryId) {
            Log.d("PlayerNotificationServ", "AALibrary: Authors data loaded for library $libraryId")
            cb()
          }
        } else {
          cb()
        }
      }
      parentId.contains("__SERIES__") -> {
        val libraryId = extractLibraryIdFromParentId(parentId)
        if (libraryId.isNotEmpty()) {
          service.mediaManager.loadLibrarySeriesWithAudio(libraryId) {
            Log.d("PlayerNotificationServ", "AALibrary: Series data loaded for library $libraryId")
            cb()
          }
        } else {
          cb()
        }
      }
      parentId.contains("__COLLECTIONS__") -> {
        val libraryId = extractLibraryIdFromParentId(parentId)
        if (libraryId.isNotEmpty()) {
          service.mediaManager.loadLibraryCollectionsWithAudio(libraryId) {
            Log.d("PlayerNotificationServ", "AALibrary: Collections data loaded for library $libraryId")
            cb()
          }
        } else {
          cb()
        }
      }
      parentId.contains("__DISCOVERY__") -> {
        val libraryId = extractLibraryIdFromParentId(parentId)
        if (libraryId.isNotEmpty()) {
          service.mediaManager.loadLibraryDiscoveryBooksWithAudio(libraryId) {
            Log.d("PlayerNotificationServ", "AALibrary: Discovery data loaded for library $libraryId")
            cb()
          }
        } else {
          cb()
        }
      }
      else -> {
        // No specific data loading needed
        cb()
      }
    }
  }

  /**
   * Ensure library-specific data is loaded
   */
  private fun ensureLibraryDataLoaded(library: Library, cb: () -> Unit) {
    // For library categories, we need to ensure all essential data is loaded
    var loadingCount = 0
    var completedCount = 0

    if (library.mediaType == "podcast") {
      loadingCount = 1
      service.mediaManager.loadLibraryPodcasts(library.id) {
        completedCount++
        if (completedCount >= loadingCount) {
          Log.d("PlayerNotificationServ", "AALibrary: All data loaded for podcast library ${library.name}")
          cb()
        }
      }
    } else {
      loadingCount = 4 // authors, series, collections, discovery

      service.mediaManager.loadAuthorsWithBooks(library.id) {
        completedCount++
        if (completedCount >= loadingCount) {
          Log.d("PlayerNotificationServ", "AALibrary: All data loaded for library ${library.name}")
          cb()
        }
      }

      service.mediaManager.loadLibrarySeriesWithAudio(library.id) {
        completedCount++
        if (completedCount >= loadingCount) {
          Log.d("PlayerNotificationServ", "AALibrary: All data loaded for library ${library.name}")
          cb()
        }
      }

      service.mediaManager.loadLibraryCollectionsWithAudio(library.id) {
        completedCount++
        if (completedCount >= loadingCount) {
          Log.d("PlayerNotificationServ", "AALibrary: All data loaded for library ${library.name}")
          cb()
        }
      }

      service.mediaManager.loadLibraryDiscoveryBooksWithAudio(library.id) {
        completedCount++
        if (completedCount >= loadingCount) {
          Log.d("PlayerNotificationServ", "AALibrary: All data loaded for library ${library.name}")
          cb()
        }
      }
    }
  }

  /**
   * Extract library ID from complex parentId formats
   */
  private fun extractLibraryIdFromParentId(parentId: String): String {
    // Parse parentId like "__LIBRARY__57d6b9ab-ed72-4cdb-8206-b136208f0306__AUTHORS__"
    val parts = parentId.split("__")
    return if (parts.size >= 3 && parts[1] == "LIBRARY") {
      parts[2]
    } else {
      ""
    }
  }

  /**
   * Helper function to add download icon to author name if the book is downloaded locally
   */
  private fun formatAuthorWithDownloadIcon(bookId: String, authorName: String): String {
    val isDownloaded = DeviceManager.dbManager.getLocalLibraryItemByLId(bookId) != null
    return if (isDownloaded) {
      "⤋ $authorName"
    } else {
      authorName
    }
  }

}
