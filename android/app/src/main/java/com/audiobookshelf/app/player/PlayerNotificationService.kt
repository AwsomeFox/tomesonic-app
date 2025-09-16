package com.audiobookshelf.app.player

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
import android.os.*
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.provider.Settings
import android.support.v4.media.MediaBrowserCompat
import android.support.v4.media.MediaDescriptionCompat
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaControllerCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import android.util.Log
import androidx.annotation.RequiresApi
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.media.MediaBrowserServiceCompat
import androidx.media.utils.MediaConstants
import com.audiobookshelf.app.BuildConfig
import com.audiobookshelf.app.R
import com.audiobookshelf.app.data.*
import com.audiobookshelf.app.data.DeviceInfo
import com.audiobookshelf.app.device.DeviceManager
import com.audiobookshelf.app.managers.DbManager
import com.audiobookshelf.app.managers.SleepTimerManager
import com.audiobookshelf.app.media.MediaManager
import com.audiobookshelf.app.media.MediaProgressSyncer
import com.audiobookshelf.app.media.getUriToAbsIconDrawable
import com.audiobookshelf.app.media.getUriToDrawable
import com.audiobookshelf.app.plugins.AbsLogger
import com.audiobookshelf.app.server.ApiHandler
// Media3 imports
import androidx.media3.common.*
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.*
import androidx.media3.ui.PlayerNotificationManager
import androidx.media3.datasource.*
import androidx.media3.extractor.DefaultExtractorsFactory
import androidx.media3.extractor.mp3.Mp3Extractor
import androidx.media3.exoplayer.source.MediaSource
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import androidx.media3.exoplayer.hls.HlsMediaSource
import java.util.*
import kotlin.concurrent.schedule
import kotlinx.coroutines.runBlocking

const val SLEEP_TIMER_WAKE_UP_EXPIRATION = 120000L // 2m

class PlayerNotificationService : MediaBrowserServiceCompat() {

  companion object {
    internal var isStarted = false
    var isClosed = false

    // Custom action constants for MediaSession
    const val CUSTOM_ACTION_JUMP_BACKWARD = "jump_backward"
    const val CUSTOM_ACTION_JUMP_FORWARD = "jump_forward"
    const val CUSTOM_ACTION_SKIP_FORWARD = "skip_forward"
    const val CUSTOM_ACTION_SKIP_BACKWARD = "skip_backward"
    const val CUSTOM_ACTION_CHANGE_PLAYBACK_SPEED = "change_playback_speed"
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

  // Legacy properties (now managed by MediaSessionManager)
  private lateinit var playerNotificationManager: PlayerNotificationManager
  lateinit var mediaSession: MediaSessionCompat
  private lateinit var transportControls: MediaControllerCompat.TransportControls

  lateinit var mediaManager: MediaManager
  lateinit var apiHandler: ApiHandler

  // Media session management
  lateinit var mediaSessionManager: MediaSessionManager

  // Player management
  lateinit var playerManager: PlayerManager
  lateinit var castPlayerManager: CastPlayerManager
  lateinit var networkConnectivityManager: NetworkConnectivityManager
  lateinit var mPlayer: ExoPlayer
  lateinit var currentPlayer: Player
  var castPlayer: com.google.android.exoplayer2.ext.cast.CastPlayer? = null

  lateinit var sleepTimerManager: SleepTimerManager
  lateinit var mediaProgressSyncer: MediaProgressSyncer

  private var notificationId = 10
  private var channelId = "audiobookshelf_channel"
  private var channelName = "Audiobookshelf Channel"

  var currentPlaybackSession: PlaybackSession? = null
  private var initialPlaybackRate: Float? = null
  private var lastActiveQueueItemIndex = -1
  private var desiredActiveQueueItemIndex = -1 // Track the desired active queue item
  private var currentNavigationIndex = -1 // Track the current navigation index for skip operations
  private var queueSetForCurrentSession = false

  internal var isAndroidAuto = false

  // The following are used for the shake detection
  private var isShakeSensorRegistered: Boolean = false
  private var mSensorManager: SensorManager? = null
  private var mAccelerometer: Sensor? = null
  private var mShakeDetector: ShakeDetector? = null
  private var shakeSensorUnregisterTask: TimerTask? = null

  // These are managed by MediaBrowserManager
  private lateinit var mediaBrowserManager: MediaBrowserManager

  fun isBrowseTreeInitialized(): Boolean {
    return ::mediaBrowserManager.isInitialized && mediaBrowserManager.isBrowseTreeInitialized()
  }

  /*
     Service related stuff
  */
  override fun onBind(intent: Intent): IBinder? {
    Log.d(tag, "AABrowser: onBind called with action: ${intent?.action}")

    // Android Auto Media Browser Service
    if (SERVICE_INTERFACE == intent.action) {
      Log.d(tag, "AABrowser: Binding as Media Browser Service")
      return super.onBind(intent)
    }
    Log.d(tag, "AABrowser: Binding as regular service")
    return binder
  }

  inner class LocalBinder : Binder() {
    // Return this instance of LocalService so clients can call public methods
    fun getService(): PlayerNotificationService = this@PlayerNotificationService
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    Log.d(tag, "AABrowser: onStartCommand called with startId: $startId")
    isStarted = true
    Log.d(tag, "onStartCommand $startId")

    // Start foreground service immediately to prevent ANR
    // This creates a basic notification that will be replaced by PlayerNotificationManager
    if (!PlayerNotificationListener.isForegroundService) {
      val notification = createBasicNotification()
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(notificationId, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
      } else {
        startForeground(notificationId, notification)
      }
      PlayerNotificationListener.isForegroundService = true
      Log.d(tag, "Started foreground service with basic notification")
    }

    return START_STICKY
  }

  @Deprecated("Deprecated in Java")
  override fun onStart(intent: Intent?, startId: Int) {
    Log.d(tag, "onStart $startId")
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
      .setSmallIcon(R.drawable.icon_monochrome)
      .setContentTitle("Audiobookshelf")
      .setContentText("Preparing playback...")
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .build()
  }

  // detach player
  override fun onDestroy() {
    networkConnectivityManager.release()

    Log.d(tag, "onDestroy")
    isStarted = false
    isClosed = true
    DeviceManager.widgetUpdater?.onPlayerChanged(this)

    playerNotificationManager.setPlayer(null)
    playerManager.releasePlayer()
    castPlayerManager.release()
    mediaSession.release()
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
    Log.d(tag, "onTaskRemoved")

    // Keep the MediaBrowserService running for Android Auto even when app is closed
    if (isAndroidAuto) {
      Log.d(tag, "onTaskRemoved: Keeping MediaBrowserService alive for Android Auto")
      // Don't call stopSelf() - let the service continue running for Android Auto
    } else {
      // If not being used by Android Auto, allow normal termination
      Log.d(tag, "onTaskRemoved: Not in Android Auto mode, allowing normal termination")
    }
  }

  override fun onCreate() {
    Log.d(tag, "AABrowser: PlayerNotificationService onCreate called")
    super.onCreate()
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
    Log.d(tag, "onCreate Register sensor listener ${mAccelerometer?.isWakeUpSensor}")
    initSensor()

    // Initialize media manager
    mediaManager = MediaManager(apiHandler, ctx)

    // Register listener so we refresh the MediaBrowser when MediaManager finishes loading Android Auto data
    mediaManager.registerAndroidAutoLoadListener {
      try {
        notifyChildrenChanged("/")
      } catch (e: Exception) {
        Log.e(tag, "Error notifying children changed from mediaManager listener: ${e.localizedMessage}")
      }
    }

    channelId =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
              createNotificationChannel(channelId, channelName)
            } else ""

    val sessionActivityPendingIntent =
            packageManager?.getLaunchIntentForPackage(packageName)?.let { sessionIntent ->
              PendingIntent.getActivity(this, 0, sessionIntent, PendingIntent.FLAG_IMMUTABLE)
            }

    // Initialize CastPlayerManager
    castPlayerManager = CastPlayerManager(this)

    // Initialize NetworkConnectivityManager
    networkConnectivityManager = NetworkConnectivityManager(this, this)
    networkConnectivityManager.initialize()

    // Initialize player manager FIRST (so currentPlayer is available)
    playerManager = PlayerManager(this, deviceSettings, this)
    playerManager.setDependencies(null, null) // Will set dependencies after MediaSessionManager is ready
    playerManager.initializeExoPlayer()

    // Set player references for backward compatibility
    mPlayer = playerManager.mPlayer
    currentPlayer = playerManager.currentPlayer

    // Initialize MediaSessionManager with the initialized player
    Log.d(tag, "AABrowser: Initializing MediaSessionManager")
    mediaSessionManager = MediaSessionManager(this, this)
    mediaSessionManager.initializeMediaSession(notificationId, channelId, sessionActivityPendingIntent, currentPlayer)
    Log.d(tag, "AABrowser: MediaSessionManager initialized")

    // Now set the MediaSession dependency for PlayerManager
    playerManager.setDependencies(mediaSessionManager.playerNotificationManager, null)

    // Initialize MediaBrowserManager
    Log.d(tag, "AABrowser: Initializing MediaBrowserManager")
    mediaBrowserManager = MediaBrowserManager(this, mediaManager, networkConnectivityManager, this)
    Log.d(tag, "AABrowser: MediaBrowserManager initialized successfully")

    // Set references for backward compatibility
    mediaSession = mediaSessionManager.mediaSession
    Log.d(tag, "AABrowser: MediaSession set: ${mediaSession != null}")
    playerNotificationManager = mediaSessionManager.playerNotificationManager
    transportControls = mediaSessionManager.transportControls

    // This is for Media Browser
    Log.d(tag, "AABrowser: Setting session token for MediaBrowser")
    sessionToken = mediaSessionManager.getSessionToken()
    Log.d(tag, "AABrowser: Session token set: $sessionToken")

    // Set cast player reference for backward compatibility
    castPlayer = castPlayerManager.castPlayer
  }

  /*
    User callable methods
  */
  fun preparePlayer(
          playbackSession: PlaybackSession,
          playWhenReady: Boolean,
          playbackRate: Float?
  ) {
    // If we are switching to a different playback session ensure the previous session is
    // finalized and synced (or queued) before starting the new one. This guarantees progress
    // for the previous item is saved remotely or queued if offline.

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
   * Builds chapter queue asynchronously with bitmap loading in background to prevent OutOfMemoryError
   * Uses Media3 style async patterns for better memory management
   */
  private fun buildChapterQueueAsync(
    playbackSession: PlaybackSession,
    chapterQueue: MutableList<android.support.v4.media.session.MediaSessionCompat.QueueItem>,
    coverUri: Uri?,
    metadata: MediaMetadataCompat
  ) {
    // Build initial queue with URIs only (no bitmaps) - fast and memory efficient
    Log.d(tag, "Android Auto: Building initial queue with ${if (playbackSession.chapters.isNotEmpty()) playbackSession.chapters.size else playbackSession.audioTracks.size} items")

    if (playbackSession.chapters.isNotEmpty()) {
      for ((idx, chapter) in playbackSession.chapters.withIndex()) {
        val desc = android.support.v4.media.MediaDescriptionCompat.Builder()
          .setMediaId("chapter_$idx")
          .setTitle(chapter.title ?: "Chapter ${idx + 1}")
          .setSubtitle(playbackSession.displayTitle)
          .setIconUri(coverUri)
          .build()
        val queueItem = android.support.v4.media.session.MediaSessionCompat.QueueItem(desc, idx.toLong())
        chapterQueue.add(queueItem)
      }
    } else {
      for ((idx, track) in playbackSession.audioTracks.withIndex()) {
        val desc = android.support.v4.media.MediaDescriptionCompat.Builder()
          .setMediaId("track_$idx")
          .setTitle(track.title ?: "Track ${idx + 1}")
          .setSubtitle(playbackSession.displayTitle)
          .setIconUri(coverUri)
          .build()
        val queueItem = android.support.v4.media.session.MediaSessionCompat.QueueItem(desc, idx.toLong())
        chapterQueue.add(queueItem)
      }
    }

    // Set initial queue immediately with URIs
    if (chapterQueue.isNotEmpty()) {
      Handler(Looper.getMainLooper()).post {
        if (!queueSetForCurrentSession) {
          Log.d(tag, "Android Auto: Setting initial queue with ${chapterQueue.size} items (URIs only)")
          mediaSession.setQueue(chapterQueue)
          queueSetForCurrentSession = true
        }
      }
    }

    // Load bitmap asynchronously in background thread, then update queue with bitmaps
    if (playbackSession.localLibraryItem?.coverContentUrl != null) {
      Thread {
        try {
          Log.d(tag, "Android Auto: Loading bitmap on background thread")

          val localCoverUri = playbackSession.getCoverUri(ctx)
          val rawBitmap = if (Build.VERSION.SDK_INT < 28) {
            MediaStore.Images.Media.getBitmap(ctx.contentResolver, localCoverUri)
          } else {
            val source: ImageDecoder.Source = ImageDecoder.createSource(ctx.contentResolver, localCoverUri)
            ImageDecoder.decodeBitmap(source) { decoder, _, _ ->
              decoder.setTargetSize(512, 512)
              decoder.setAllocator(ImageDecoder.ALLOCATOR_SOFTWARE)
            }
          }

          // Optimize bitmap size for memory efficiency
          val optimizedBitmap = if (rawBitmap.width != 512 || rawBitmap.height != 512) {
            val scaledBitmap = Bitmap.createBitmap(512, 512, Bitmap.Config.RGB_565) // Use RGB_565 for 50% memory savings
            val canvas = android.graphics.Canvas(scaledBitmap)
            val paint = android.graphics.Paint().apply { isFilterBitmap = true }
            val srcRect = android.graphics.Rect(0, 0, rawBitmap.width, rawBitmap.height)
            val dstRect = android.graphics.Rect(0, 0, 512, 512)
            canvas.drawBitmap(rawBitmap, srcRect, dstRect, paint)
            rawBitmap.recycle() // Immediately recycle original
            scaledBitmap
          } else {
            rawBitmap
          }

          Log.d(tag, "Android Auto: Bitmap loaded successfully in background - Size: ${optimizedBitmap.width}x${optimizedBitmap.height}")

          // Update queue and metadata on main thread with bitmap
          Handler(Looper.getMainLooper()).post {
            updateQueueWithBitmap(playbackSession, chapterQueue, optimizedBitmap, metadata)
          }

        } catch (e: Exception) {
          Log.w(tag, "Android Auto: Failed to load bitmap in background: ${e.message}")
          // Queue is already set with URIs, so playback can continue without bitmaps
        }
      }.start()
    } else {
      Log.d(tag, "Android Auto: No local cover available, using URIs only")
    }
  }

  /**
   * Updates existing queue with loaded bitmap - called on main thread
   */
  private fun updateQueueWithBitmap(
    playbackSession: PlaybackSession,
    chapterQueue: MutableList<android.support.v4.media.session.MediaSessionCompat.QueueItem>,
    bitmap: Bitmap,
    metadata: MediaMetadataCompat
  ) {
    try {
      Log.d(tag, "Android Auto: Updating queue with bitmap on main thread")

      // Update existing queue items with bitmap
      chapterQueue.clear()

      if (playbackSession.chapters.isNotEmpty()) {
        for ((idx, chapter) in playbackSession.chapters.withIndex()) {
          val desc = android.support.v4.media.MediaDescriptionCompat.Builder()
            .setMediaId("chapter_$idx")
            .setTitle(chapter.title ?: "Chapter ${idx + 1}")
            .setSubtitle(playbackSession.displayTitle)
            .setIconBitmap(bitmap) // Now use bitmap instead of URI
            .build()
          val queueItem = android.support.v4.media.session.MediaSessionCompat.QueueItem(desc, idx.toLong())
          chapterQueue.add(queueItem)
        }
      } else {
        for ((idx, track) in playbackSession.audioTracks.withIndex()) {
          val desc = android.support.v4.media.MediaDescriptionCompat.Builder()
            .setMediaId("track_$idx")
            .setTitle(track.title ?: "Track ${idx + 1}")
            .setSubtitle(playbackSession.displayTitle)
            .setIconBitmap(bitmap) // Now use bitmap instead of URI
            .build()
          val queueItem = android.support.v4.media.session.MediaSessionCompat.QueueItem(desc, idx.toLong())
          chapterQueue.add(queueItem)
        }
      }

      // Update queue with bitmaps
      mediaSession.setQueue(chapterQueue)

      // Update current metadata with bitmap
      val updatedMetadata = MediaMetadataCompat.Builder(metadata)
        .putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, bitmap)
        .putBitmap(MediaMetadataCompat.METADATA_KEY_ART, bitmap)
        .build()
      mediaSession.setMetadata(updatedMetadata)

      Log.d(tag, "Android Auto: Queue and metadata updated with bitmap successfully")

    } catch (e: Exception) {
      Log.w(tag, "Android Auto: Failed to update queue with bitmap: ${e.message}")
    }
  }

  private fun doPreparePlayer(
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

      try {
      if (!isStarted) {
        Log.i(tag, "preparePlayer: foreground service not started - Starting service --")
        Intent(ctx, PlayerNotificationService::class.java).also { intent ->
          ContextCompat.startForegroundService(ctx, intent)
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

      // First set the basic metadata for legacy MediaSessionCompat
      val metadata = playbackSession.getMediaMetadataCompat(ctx)
      Log.d(tag, "Android Auto: Setting initial metadata with bitmap: ${metadata.getBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART) != null}")
      mediaSession.setMetadata(metadata)

      // Log Media3 session status for debugging
      Log.d(tag, "Media3: Session active status: ${mediaSessionManager.getMedia3SessionToken() != null}")
      Log.d(tag, "Media3: PlayerNotificationManager connected: ${::playerNotificationManager.isInitialized}")

      // Store the original metadata for later use (to preserve after queue changes)
      var originalMetadata = metadata
      Log.d(tag, "Android Auto: Stored original metadata with bitmap: ${originalMetadata.getBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART) != null}")

      // Build MediaSession queue from chapters/tracks so Android Auto shows actual navigation list
      try {
        val chapterQueue: MutableList<android.support.v4.media.session.MediaSessionCompat.QueueItem> = mutableListOf()

        // Cache bitmap once for all queue items and metadata (local books only)
        // Load bitmap asynchronously to prevent OutOfMemoryError and main thread blocking
        val coverUri = playbackSession.getCoverUri(ctx)
        Log.d(tag, "Android Auto: Loading shared bitmap asynchronously - Cover URI: $coverUri")
        Log.d(tag, "Android Auto: Local library item cover content URL: ${playbackSession.localLibraryItem?.coverContentUrl}")

        // Build queue immediately without bitmap, then update asynchronously
        buildChapterQueueAsync(playbackSession, chapterQueue, coverUri, metadata)
      } catch (e: Exception) {
        Log.e(tag, "Android Auto: Failed to build queue: ${e.message}")
        e.printStackTrace()
      }
      val mediaItems = playbackSession.getMediaItems(ctx)
      val playbackRateToUse = playbackRate ?: initialPlaybackRate ?: 1f
      initialPlaybackRate = playbackRate

      // Set actions on Android Auto like jump forward/backward
      setMediaSessionCustomActions(playbackSession)

      playbackSession.mediaPlayer = getMediaPlayer()

      if (playbackSession.mediaPlayer == CastPlayerManager.PLAYER_CAST && playbackSession.isLocal) {
        Log.w(tag, "Cannot cast local media item - switching player")
        currentPlaybackSession = null
        switchToPlayer(false)
        playbackSession.mediaPlayer = getMediaPlayer()
      }

      if (playbackSession.mediaPlayer == CastPlayerManager.PLAYER_CAST) {
        // Cast player setup - TODO: Handle cast player with Media3 notification manager
        // playerNotificationManager.setPlayer(castPlayer)
      }

      currentPlaybackSession = playbackSession
      lastActiveQueueItemIndex = -1 // Reset when starting new playback session
      desiredActiveQueueItemIndex = -1 // Reset desired active queue item
      currentNavigationIndex = -1 // Reset navigation index - will be calculated on first access
      queueSetForCurrentSession = false // Reset queue flag for new session
      DeviceManager.setLastPlaybackSession(playbackSession) // Save playback session to use when app is closed

      AbsLogger.info("PlayerNotificationService", "preparePlayer: Started playback session for item ${currentPlaybackSession?.mediaItemId}. MediaPlayer ${currentPlaybackSession?.mediaPlayer}")
      // Notify client
      clientEventEmitter?.onPlaybackSession(playbackSession)

      // Update widget
      DeviceManager.widgetUpdater?.onPlayerChanged(this)

      if (mediaItems.isEmpty()) {
        Log.e(tag, "Invalid playback session no media items to play")
        currentPlaybackSession = null
        return
      }

      if (mPlayer == currentPlayer) {
        val mediaSource: MediaSource

        if (playbackSession.isLocal) {
          AbsLogger.info("PlayerNotificationService", "preparePlayer: Playing local item ${currentPlaybackSession?.mediaItemId}.")
          val dataSourceFactory = DefaultDataSource.Factory(ctx)

          val extractorsFactory = DefaultExtractorsFactory()
          if (DeviceManager.deviceData.deviceSettings?.enableMp3IndexSeeking == true) {
            extractorsFactory.setMp3ExtractorFlags(Mp3Extractor.FLAG_ENABLE_INDEX_SEEKING)
          }

          mediaSource = ProgressiveMediaSource.Factory(dataSourceFactory, extractorsFactory).createMediaSource(mediaItems[0])
        } else if (!playbackSession.isHLS) {
          AbsLogger.info("PlayerNotificationService", "preparePlayer: Direct playing item ${currentPlaybackSession?.mediaItemId}.")
          val dataSourceFactory = DefaultHttpDataSource.Factory()

          val extractorsFactory = DefaultExtractorsFactory()
          if (DeviceManager.deviceData.deviceSettings?.enableMp3IndexSeeking == true) {
            extractorsFactory.setMp3ExtractorFlags(Mp3Extractor.FLAG_ENABLE_INDEX_SEEKING)
          }

          dataSourceFactory.setUserAgent(channelId)
          mediaSource = ProgressiveMediaSource.Factory(dataSourceFactory, extractorsFactory).createMediaSource(mediaItems[0])
        } else {
          AbsLogger.info("PlayerNotificationService", "preparePlayer: Playing HLS stream of item ${currentPlaybackSession?.mediaItemId}.")
          val dataSourceFactory = androidx.media3.datasource.DefaultHttpDataSource.Factory()
          dataSourceFactory.setUserAgent(channelId)
          dataSourceFactory.setDefaultRequestProperties(hashMapOf("Authorization" to "Bearer ${DeviceManager.token}"))
          mediaSource = HlsMediaSource.Factory(dataSourceFactory).createMediaSource(mediaItems[0])
        }
        mPlayer.setMediaSource(mediaSource)

        // Add remaining media items if multi-track
        if (mediaItems.size > 1) {
          currentPlayer.addMediaItems(mediaItems.subList(1, mediaItems.size))
          Log.d(tag, "currentPlayer total media items ${currentPlayer.mediaItemCount}")

          val currentTrackIndex = playbackSession.getCurrentTrackIndex()
          val currentTrackTime = playbackSession.getCurrentTrackTimeMs()
          Log.d(tag, "currentPlayer current track index $currentTrackIndex & current track time $currentTrackTime")
          currentPlayer.seekTo(currentTrackIndex, currentTrackTime)
        } else {
          currentPlayer.seekTo(playbackSession.currentTimeMs)
        }

        Log.d(tag, "Prepare complete for session ${currentPlaybackSession?.displayTitle} | ${currentPlayer.mediaItemCount}")
        currentPlayer.playWhenReady = playWhenReady
        currentPlayer.setPlaybackSpeed(playbackRateToUse)

        currentPlayer.prepare()

        // Force notification update after preparation
        Log.d(tag, "Player prepared, forcing notification manager refresh")
        try {
            // Ensure the notification manager is connected and ready
            playerNotificationManager.setPlayer(currentPlayer)
            Log.d(tag, "PlayerNotificationManager reconnected to current player")
        } catch (e: Exception) {
            Log.e(tag, "Failed to refresh notification manager: ${e.message}")
        }
      } else if (castPlayer != null) {
        val currentTrackIndex = playbackSession.getCurrentTrackIndex()
        val currentTrackTime = playbackSession.getCurrentTrackTimeMs()
        val mediaType = playbackSession.mediaType
        Log.d(tag, "Loading cast player $currentTrackIndex $currentTrackTime $mediaType")
        // TODO: Update cast player for Media3 compatibility
      }
    } catch (e: Exception) {
      AbsLogger.error("PlayerNotificationService", "doPreparePlayer: Failed to prepare player session: ${e.message}")
      Log.e(tag, "Exception during player preparation", e)
      // Reset state and notify client of failure
      currentPlaybackSession = null
      lastActiveQueueItemIndex = -1
      queueSetForCurrentSession = false
      clientEventEmitter?.onPlaybackFailed("Failed to prepare media item: ${e.message}")
    }
  }

  private fun setMediaSessionCustomActions(playbackSession: PlaybackSession) {
    mediaSessionManager.setCustomActions(playbackSession, ctx, this)
  }

  fun setMediaSessionPlaybackActions() {
    mediaSessionManager.setPlaybackActions(deviceSettings.allowSeekingOnMediaControls)
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

  fun switchToPlayer(useCastPlayer: Boolean) {
    // TODO: Update cast player switching for Media3 compatibility
    // currentPlayer = castPlayerManager.switchToPlayer(
    //   useCastPlayer = useCastPlayer,
    //   currentPlayer = currentPlayer,
    //   mPlayer = mPlayer,
    //   playerNotificationManager = null, // TODO: Handle Media3 notification manager for cast
    //   currentPlaybackSession = currentPlaybackSession,
    //   mediaProgressSyncer = mediaProgressSyncer,
    //   preparePlayerCallback = { session, startPlayer, playbackRate ->
    //     preparePlayer(session, startPlayer, playbackRate)
    //   },
    //   onMediaPlayerChangedCallback = { mediaPlayer ->
    //     clientEventEmitter?.onMediaPlayerChanged(mediaPlayer)
    //   },
    //   onPlayingUpdateCallback = { isPlaying ->
    //     clientEventEmitter?.onPlayingUpdate(isPlaying)
    //   }
    // )
  }

  fun getCurrentTrackStartOffsetMs(): Long {
    return if (currentPlayer.mediaItemCount > 1) {
      val windowIndex = currentPlayer.currentMediaItemIndex
      val currentTrackStartOffset = currentPlaybackSession?.getTrackStartOffsetMs(windowIndex) ?: 0L
      currentTrackStartOffset
    } else {
      0
    }
  }

  fun getCurrentTime(): Long {
    return currentPlayer.currentPosition + getCurrentTrackStartOffsetMs()
  }

  fun getCurrentTimeSeconds(): Double {
    return getCurrentTime() / 1000.0
  }

  private fun getBufferedTime(): Long {
    return if (currentPlayer.mediaItemCount > 1) {
      val windowIndex = currentPlayer.currentMediaItemIndex
      val currentTrackStartOffset = currentPlaybackSession?.getTrackStartOffsetMs(windowIndex) ?: 0L
      currentPlayer.bufferedPosition + currentTrackStartOffset
    } else {
      currentPlayer.bufferedPosition
    }
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
    return currentPlaybackSession?.getChapterForTime(this.getCurrentTime())
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

  // Called from PlayerListener play event
  // check with server if progress has updated since last play and sync progress update
  fun checkCurrentSessionProgress(seekBackTime: Long): Boolean {
    if (currentPlaybackSession == null) return true

    mediaProgressSyncer.currentPlaybackSession?.let { playbackSession ->
      if (!DeviceManager.checkConnectivity(ctx)) {
        return true // carry on
      }

      if (playbackSession.isLocal) {

        // Make sure this connection config exists
        val serverConnectionConfig =
                DeviceManager.getServerConnectionConfig(playbackSession.serverConnectionConfigId)
        if (serverConnectionConfig == null) {
          Log.d(
                  tag,
                  "checkCurrentSessionProgress: Local library item server connection config is not saved ${playbackSession.serverConnectionConfigId}"
          )
          return true // carry on
        }

        // Local playback session check if server has updated media progress
        Log.d(
                tag,
                "checkCurrentSessionProgress: Checking if local media progress was updated on server"
        )
        apiHandler.getMediaProgress(
                playbackSession.libraryItemId!!,
                playbackSession.episodeId,
                serverConnectionConfig
        ) { mediaProgress ->
          if (mediaProgress != null &&
                          mediaProgress.lastUpdate > playbackSession.updatedAt &&
                          mediaProgress.currentTime != playbackSession.currentTime
          ) {
            Log.d(
                    tag,
                    "checkCurrentSessionProgress: Media progress was updated since last play time updating from ${playbackSession.currentTime} to ${mediaProgress.currentTime}"
            )
            mediaProgressSyncer.syncFromServerProgress(mediaProgress)

            // Update current playback session stored in PNS since MediaProgressSyncer version is a
            // copy
            mediaProgressSyncer.currentPlaybackSession?.let { updatedPlaybackSession ->
              currentPlaybackSession = updatedPlaybackSession
            }

            Handler(Looper.getMainLooper()).post {
              seekPlayer(playbackSession.currentTimeMs)
              // Should already be playing
              currentPlayer.volume = 1F // Volume on sleep timer might have decreased this
              currentPlaybackSession?.let { mediaProgressSyncer.play(it) }
              clientEventEmitter?.onPlayingUpdate(true)
            }
          } else {
            Handler(Looper.getMainLooper()).post {
              if (seekBackTime > 0L) {
                seekBackward(seekBackTime)
              }

              // Should already be playing
              currentPlayer.volume = 1F // Volume on sleep timer might have decreased this
              mediaProgressSyncer.currentPlaybackSession?.let { playbackSession ->
                mediaProgressSyncer.play(playbackSession)
              }
              clientEventEmitter?.onPlayingUpdate(true)
            }
          }
        }
      } else {
        // Streaming from server so check if playback session still exists on server
        Log.d(
                tag,
                "checkCurrentSessionProgress: Checking if playback session ${playbackSession.id} for server stream is still available"
        )
        apiHandler.getPlaybackSession(playbackSession.id) {
          if (it == null) {
            Log.d(
                    tag,
                    "checkCurrentSessionProgress: Playback session does not exist on server - start new playback session"
            )

            Handler(Looper.getMainLooper()).post {
              currentPlayer.pause()
              startNewPlaybackSession()
            }
          } else {
            Log.d(tag, "checkCurrentSessionProgress: Playback session still available on server")
            Handler(Looper.getMainLooper()).post {
              if (seekBackTime > 0L) {
                seekBackward(seekBackTime)
              }

              currentPlayer.volume = 1F // Volume on sleep timer might have decreased this
              mediaProgressSyncer.currentPlaybackSession?.let { playbackSession ->
                mediaProgressSyncer.play(playbackSession)
              }

              clientEventEmitter?.onPlayingUpdate(true)
            }
          }
        }
      }
    }
    return false
  }

  fun play() {
    playerManager.play()
  }

  fun pause() {
    playerManager.pause()
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
    var timeToSeek = time
    Log.d(tag, "seekPlayer mediaCount = ${currentPlayer.mediaItemCount} | $timeToSeek")
    if (timeToSeek < 0) {
      Log.w(tag, "seekPlayer invalid time $timeToSeek - setting to 0")
      timeToSeek = 0L
    } else if (timeToSeek > getDuration()) {
      Log.w(tag, "seekPlayer invalid time $timeToSeek - setting to MAX - 2000")
      timeToSeek = getDuration() - 2000L
    }

    if (currentPlayer.mediaItemCount > 1) {
      currentPlaybackSession?.currentTime = timeToSeek / 1000.0
      val newWindowIndex = currentPlaybackSession?.getCurrentTrackIndex() ?: 0
      val newTimeOffset = currentPlaybackSession?.getCurrentTrackTimeMs() ?: 0
      Log.d(tag, "seekPlayer seekTo $newWindowIndex | $newTimeOffset")
      currentPlayer.seekTo(newWindowIndex, newTimeOffset)
    } else {
      currentPlayer.seekTo(timeToSeek)
    }
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
      Log.w(tag, "navigateToChapter: No active playback session")
      return
    }

    if (chapterIndex < 0 || chapterIndex >= getNavigationItemCount()) {
      Log.w(tag, "navigateToChapter: Invalid chapter index $chapterIndex (total: ${getNavigationItemCount()})")
      return
    }

    try {
      // Get the navigation item (chapter or track) for this index
      val navItem = getNavigationItem(chapterIndex)
      if (navItem == null) {
        Log.w(tag, "navigateToChapter: Could not get navigation item for index $chapterIndex")
        return
      }
      Log.d(tag, "navigateToChapter: Navigating to item: ${navItem.title} at ${navItem.startTimeMs}ms")

      // Use existing seekPlayer method which handles single/multi-file logic
      seekPlayer(navItem.startTimeMs)

      // Update the tracked navigation index immediately for skip operations
      currentNavigationIndex = chapterIndex

      // Update MediaSession state immediately for Android Auto compatibility
      // Delays cause race conditions and crashes in Android Auto
      updateNavigationState(chapterIndex)

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
   * Get total number of navigation items (chapters or tracks)
   */
  fun getNavigationItemCount(): Int {
    val session = currentPlaybackSession ?: return 0

    // Prefer chapters over tracks for navigation
    return if (session.chapters.isNotEmpty()) {
      session.chapters.size
    } else {
      session.audioTracks.size
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
      // Track-based navigation
      if (index >= 0 && index < session.audioTracks.size) {
        val track = session.audioTracks[index]
        NavigationItem(
          index = index,
          title = track.title ?: "Track ${index + 1}",
          startTimeMs = track.startOffsetMs,
          endTimeMs = track.endOffsetMs,
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
      // Track-based lookup
      for (i in session.audioTracks.indices) {
        val track = session.audioTracks[i]
        if (currentTimeMs >= track.startOffsetMs && currentTimeMs < track.endOffsetMs) {
          return i
        }
      }

      // If no exact match, return the last started track
      for (i in session.audioTracks.indices.reversed()) {
        val track = session.audioTracks[i]
        if (currentTimeMs >= track.startOffsetMs) {
          return i
        }
      }
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

      val queue = mediaSession.controller?.queue
      if (queue == null || index < 0 || index >= queue.size) {
        Log.w(tag, "updateNavigationState: Invalid queue state - index: $index, queue size: ${queue?.size ?: 0}")
        return
      }

      // Get the navigation item for metadata
      val navItem = getNavigationItem(index)
      if (navItem == null) {
        Log.w(tag, "updateNavigationState: Could not get navigation item for index $index")
        return
      }

      // Update metadata with current chapter/track info
      val currentMetadata = mediaSession.controller?.metadata
      if (currentMetadata != null) {
        updateMetadataForNavigationItem(navItem, currentMetadata, session)
      }

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
      val currentActiveId = mediaSession.controller?.playbackState?.activeQueueItemId ?: -1L
      val newActiveId = index.toLong()

      if (currentActiveId != newActiveId) {
        // Get current playback state and preserve all existing values
        val currentState = mediaSession.controller?.playbackState
        val currentPosition = getCurrentTime()
        val currentSpeed = currentPlayer.playbackParameters.speed
        val playerState = when {
          !currentPlayer.isPlaying -> PlaybackStateCompat.STATE_PAUSED
          currentPlayer.isLoading -> PlaybackStateCompat.STATE_BUFFERING
          else -> PlaybackStateCompat.STATE_PLAYING
        }

        // Preserve existing actions if available, otherwise use standard set
        val existingActions = currentState?.actions ?: (
          PlaybackStateCompat.ACTION_PLAY_PAUSE or
          PlaybackStateCompat.ACTION_PLAY or
          PlaybackStateCompat.ACTION_PAUSE or
          PlaybackStateCompat.ACTION_FAST_FORWARD or
          PlaybackStateCompat.ACTION_REWIND or
          PlaybackStateCompat.ACTION_SKIP_TO_NEXT or
          PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or
          PlaybackStateCompat.ACTION_STOP or
          PlaybackStateCompat.ACTION_SEEK_TO
        )

        // Create new state with updated active queue item
        val newState = PlaybackStateCompat.Builder()
          .setState(playerState, currentPosition, currentSpeed)
          .setActiveQueueItemId(newActiveId)
          .setActions(existingActions)

        // Preserve custom actions if they exist
        currentState?.customActions?.forEach { customAction ->
          newState.addCustomAction(customAction)
        }

        mediaSession.setPlaybackState(newState.build())
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
      mediaSession.setMetadata(finalMetadata)

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
   * Legacy method for backward compatibility - delegates to getCurrentNavigationIndex
   */
  fun getCurrentChapterIndex(): Int {
    return getCurrentNavigationIndex()
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
      }
    } catch (e: Exception) {
      Log.e(tag, "updateQueuePositionForChapters: Error updating queue position", e)
    }
  }

  /**
   * Skip to the previous chapter/track
   * Simplified logic that works consistently for all book types
   */
  fun skipToPrevious() {
    Log.d(tag, "skipToPrevious: Starting previous navigation")

    try {
      val currentIndex = getCurrentNavigationIndex()

      if (currentIndex < 0) {
        Log.w(tag, "skipToPrevious: Could not determine current navigation index")
        return
      }

      val navItem = getNavigationItem(currentIndex)
      if (navItem == null) {
        Log.w(tag, "skipToPrevious: Could not get current navigation item")
        return
      }

      val currentTime = getCurrentTime()
      val timeInCurrentItem = currentTime - navItem.startTimeMs

      // If we're more than 5 seconds into the current item, restart it
      if (timeInCurrentItem > 5000) {
        navigateToChapter(currentIndex)
      } else if (currentIndex > 0) {
        // Go to previous item
        val previousIndex = currentIndex - 1
        navigateToChapter(previousIndex)
      } else {
        // At first item, restart it
        navigateToChapter(0)
      }

    } catch (e: Exception) {
      Log.e(tag, "skipToPrevious: Error during previous navigation", e)
      // Fallback to ExoPlayer's default behavior
      try {
        currentPlayer.seekToPrevious()
      } catch (fallbackError: Exception) {
        Log.e(tag, "skipToPrevious: Fallback also failed", fallbackError)
      }
    }
  }

  /**
   * Skip to the next chapter/track
   * Simplified logic that works consistently for all book types
   */
  fun skipToNext() {
    Log.d(tag, "skipToNext: Starting next navigation")

    try {
      val currentIndex = getCurrentNavigationIndex()
      val totalItems = getNavigationItemCount()

      if (currentIndex < 0) {
        Log.w(tag, "skipToNext: Could not determine current navigation index")
        return
      }

      if (currentIndex < totalItems - 1) {
        // Go to next item
        val nextIndex = currentIndex + 1
        navigateToChapter(nextIndex)
      } else {
        // At last item - could implement various behaviors:
        // For now, just stay at the last item
        Log.d(tag, "skipToNext: At last item, staying put")
        // Could also: seek to end, stop playback, or loop to beginning
      }

    } catch (e: Exception) {
      Log.e(tag, "skipToNext: Error during next navigation", e)
      // Fallback to ExoPlayer's default behavior
      try {
        currentPlayer.seekToNext()
      } catch (fallbackError: Exception) {
        Log.e(tag, "skipToNext: Fallback also failed", fallbackError)
      }
    }
  }

  fun jumpForward() {
    seekForward(deviceSettings.jumpForwardTimeMs)
  }

  fun jumpBackward() {
    seekBackward(deviceSettings.jumpBackwardsTimeMs)
  }

  fun seekForward(amount: Long) {
    seekPlayer(getCurrentTime() + amount)
  }

  fun seekBackward(amount: Long) {
    seekPlayer(getCurrentTime() - amount)
  }

  fun setPlaybackSpeed(speed: Float) {
    Log.d(tag, "setPlaybackSpeed: $speed")

    mediaManager.userSettingsPlaybackRate = speed
    currentPlayer.setPlaybackSpeed(speed)

    // Refresh Android Auto actions
    mediaProgressSyncer.currentPlaybackSession?.let {
      setMediaSessionCustomActions(it)
    }
  }

  fun closePlayback(calledOnError: Boolean? = false) {
    Log.d(tag, "closePlayback")
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
    // TODO: Update cast player detection for Media3 compatibility
    // return castPlayerManager.getMediaPlayer(currentPlayer)
    return CastPlayerManager.PLAYER_EXO // Default to exo player for now
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

              // When resuming from stored session, start in paused state to allow user control
              // Android Auto users can manually start playback via the UI
              val shouldStartPlaying = false

              // Prepare the player in paused state with saved playback speed
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

                  // When resuming from stored session, start in paused state to allow user control
                  // Android Auto users can manually start playback via the UI
                  val shouldStartPlaying = false

                  // Prepare the player in paused state with saved playback speed
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

                            // When resuming from stored session, start in paused state to allow user control
                            // Android Auto users can manually start playback via the UI
                            val shouldStartPlaying = false

                            Log.d(tag, "Android Auto: Resuming from server session: ${libraryItem.media.metadata?.title} at ${latestProgress.currentTime}s in paused state with speed ${currentPlaybackSpeed}x")

                            // Prepare the player in paused state on main thread with correct playback speed
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

  override fun onGetRoot(
          clientPackageName: String,
          clientUid: Int,
          rootHints: Bundle?
  ): BrowserRoot? {
    Log.d(tag, "AABrowser: onGetRoot called by $clientPackageName (uid: $clientUid)")
    return if (::mediaBrowserManager.isInitialized) {
      Log.d(tag, "AABrowser: MediaBrowserManager is initialized, delegating to onGetRoot")
      mediaBrowserManager.onGetRoot(clientPackageName, clientUid, rootHints)
    } else {
      Log.w(tag, "AABrowser: onGetRoot called before mediaBrowserManager initialized")
      null
    }
  }

  override fun onLoadChildren(
          parentMediaId: String,
          result: Result<MutableList<MediaBrowserCompat.MediaItem>>
  ) {
    Log.d(tag, "AABrowser: onLoadChildren called for parentMediaId: $parentMediaId")
    if (::mediaBrowserManager.isInitialized) {
      Log.d(tag, "AABrowser: MediaBrowserManager is initialized, delegating to onLoadChildren")
      mediaBrowserManager.onLoadChildren(parentMediaId, result)
    } else {
      Log.w(tag, "AABrowser: onLoadChildren called before mediaBrowserManager initialized")
      result.sendResult(mutableListOf())
    }
  }

  override fun onSearch(
          query: String,
          extras: Bundle?,
          result: Result<MutableList<MediaBrowserCompat.MediaItem>>
  ) {
    if (::mediaBrowserManager.isInitialized) {
      mediaBrowserManager.onSearch(query, extras, result)
    } else {
      Log.w(tag, "onSearch called before mediaBrowserManager initialized")
      result.sendResult(mutableListOf())
    }
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
    if (::mediaBrowserManager.isInitialized) {
        AbsLogger.info(tag, "Forcing Android Auto reload from service")
        mediaBrowserManager.forceReload()
    }
  }
}
