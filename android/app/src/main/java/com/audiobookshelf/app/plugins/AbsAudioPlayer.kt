package com.audiobookshelf.app.plugins

import android.os.Handler
import android.os.Looper
import android.util.Log
import com.audiobookshelf.app.MainActivity
import com.audiobookshelf.app.data.*
import com.audiobookshelf.app.device.DeviceManager
import com.audiobookshelf.app.media.MediaEventManager
// Legacy CastManager removed - using Media3 cast integration in AudiobookMediaService
import com.audiobookshelf.app.player.PlayerListener
import com.audiobookshelf.app.player.service.AudiobookMediaService
import com.audiobookshelf.app.server.ApiHandler
import androidx.media3.session.MediaController
import com.google.common.util.concurrent.MoreExecutors
import com.fasterxml.jackson.core.json.JsonReadFeature
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.getcapacitor.*
import com.getcapacitor.annotation.CapacitorPlugin
import com.google.android.gms.cast.CastDevice
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import org.json.JSONObject

@CapacitorPlugin(name = "AbsAudioPlayer")
class AbsAudioPlayer : Plugin() {
  private val tag = "AbsAudioPlayer"
  private var jacksonMapper = jacksonObjectMapper().enable(JsonReadFeature.ALLOW_UNESCAPED_CONTROL_CHARS.mappedFeature())

  private lateinit var mainActivity: MainActivity
  private lateinit var apiHandler:ApiHandler
  // Legacy castManager removed - Cast functionality now handled by AudiobookMediaService

  lateinit var audiobookMediaService: AudiobookMediaService

  // MediaController for proper Media3 interface
  private var mediaController: MediaController? = null

  private var isCastAvailable:Boolean = false

  override fun load() {
    mainActivity = (activity as MainActivity)
    apiHandler = ApiHandler(mainActivity)

    // Cast functionality now handled by AudiobookMediaService - no separate initialization needed

    val foregroundServiceReady : () -> Unit = {
      audiobookMediaService = mainActivity.foregroundService

      audiobookMediaService.clientEventEmitter = (object : AudiobookMediaService.ClientEventEmitter {
        override fun onPlaybackSession(playbackSession: PlaybackSession) {
          notifyListeners("onPlaybackSession", JSObject(jacksonMapper.writeValueAsString(playbackSession)))
        }

        override fun onPlaybackClosed() {
          emit("onPlaybackClosed", true)
          // Ensure progress is saved and synced when playback is closed (native-only sessions)
          try {
            Handler(Looper.getMainLooper()).post {
              try {
                audiobookMediaService.mediaProgressSyncer.stop(true) { /* finished */ }
              } catch (e: Exception) {
                Log.e(tag, "onPlaybackClosed: Failed to stop/sync mediaProgressSyncer: ${e.message}")
              }
            }
          } catch (e: Exception) {
            Log.e(tag, "onPlaybackClosed: Exception scheduling stop: ${e.message}")
          }
        }

        override fun onPlayingUpdate(isPlaying: Boolean) {
          emit("onPlayingUpdate", isPlaying)
          // When playback state changes, persist and try to sync immediately.
          try {
            Handler(Looper.getMainLooper()).post {
              try {
                if (isPlaying) {
                  // Force an immediate sync attempt on start (will respect network/settings)
                  audiobookMediaService.mediaProgressSyncer.forceSyncNow(true) { /* result ignored */ }
                } else {
                  // On pause, ensure local progress is saved and attempt to push to server
                  audiobookMediaService.mediaProgressSyncer.pause { /* result ignored */ }
                }
              } catch (e: Exception) {
                Log.e(tag, "onPlayingUpdate: Failed to trigger sync/pause: ${e.message}")
              }
            }
          } catch (e: Exception) {
            Log.e(tag, "onPlayingUpdate: Exception scheduling sync: ${e.message}")
          }
        }

        override fun onMetadata(metadata: PlaybackMetadata) {
          notifyListeners("onMetadata", JSObject(jacksonMapper.writeValueAsString(metadata)))
        }

        override fun onSleepTimerEnded(currentPosition: Long) {
          emit("onSleepTimerEnded", currentPosition)
        }

        override fun onSleepTimerSet(sleepTimeRemaining: Int, isAutoSleepTimer:Boolean) {
          val ret = JSObject()
          ret.put("value", sleepTimeRemaining)
          ret.put("isAuto", isAutoSleepTimer)
          notifyListeners("onSleepTimerSet", ret)
        }

        override fun onLocalMediaProgressUpdate(localMediaProgress: LocalMediaProgress) {
          notifyListeners("onLocalMediaProgressUpdate", JSObject(jacksonMapper.writeValueAsString(localMediaProgress)))
        }

        override fun onPlaybackFailed(errorMessage: String) {
          emit("onPlaybackFailed", errorMessage)
        }

        override fun onMediaPlayerChanged(mediaPlayer:String) {
          emit("onMediaPlayerChanged", mediaPlayer)
        }

        override fun onProgressSyncFailing() {
          emit("onProgressSyncFailing", "")
        }

        override fun onProgressSyncSuccess() {
          emit("onProgressSyncSuccess", "")
        }

        override fun onNetworkMeteredChanged(isUnmetered:Boolean) {
          emit("onNetworkMeteredChanged", isUnmetered)
        }

        override fun onMediaItemHistoryUpdated(mediaItemHistory:MediaItemHistory) {
          notifyListeners("onMediaItemHistoryUpdated", JSObject(jacksonMapper.writeValueAsString(mediaItemHistory)))
        }

        override fun onPlaybackSpeedChanged(playbackSpeed:Float) {
          emit("onPlaybackSpeedChanged", playbackSpeed)
        }

        override fun onPlayerError(errorMessage: String) {
          emit("onPlayerError", errorMessage)
        }
      })

      MediaEventManager.clientEventEmitter = audiobookMediaService.clientEventEmitter

      // Initialize MediaController for proper Media3 interface
      initializeMediaController()

      // Set up Cast availability monitoring
      setupCastListeners()

      // --- Sync playback state and metadata on service connection ---
      syncCurrentPlaybackState()
    }
    mainActivity.pluginCallback = foregroundServiceReady
  }

  // --- New function to sync playback state and metadata ---
  fun syncCurrentPlaybackState() {
    try {
      val playbackSession = audiobookMediaService.currentPlaybackSession
      if (playbackSession != null) {
        Log.d(tag, "Syncing playback state: ${playbackSession.libraryItem?.media?.metadata?.title}")

        // CRITICAL FIX: Check if player has media items loaded, if not, prepare the player
        val hasMediaItems = audiobookMediaService.currentPlayer.mediaItemCount > 0
        Log.d(tag, "Player has ${audiobookMediaService.currentPlayer.mediaItemCount} media items")

        if (!hasMediaItems) {
          Log.w(tag, "Player has no media items! Preparing player with existing session...")
          // Get the saved playback rate to maintain consistency
          val currentPlaybackSpeed = try {
            audiobookMediaService.mediaManager.getSavedPlaybackRate()
          } catch (e: Exception) {
            Log.w(tag, "Could not get saved playback rate, using 1.0f: ${e.message}")
            1.0f
          }

          // Prepare the player with the existing session but don't auto-play
          audiobookMediaService.preparePlayer(playbackSession, false, currentPlaybackSpeed)
          Log.i(tag, "Player prepared with existing session at speed ${currentPlaybackSpeed}x")
        }

        notifyListeners("onPlaybackSession", JSObject(jacksonMapper.writeValueAsString(playbackSession)))

        // Create and emit metadata using the same pattern as the service
        val duration = playbackSession.duration
        val currentTime = audiobookMediaService.getCurrentTimeSeconds()
        val isPlaying = audiobookMediaService.currentPlayer.isPlaying

        // Use READY state for both playing and paused (when player is loaded)
        // Only use IDLE for truly idle states
        val playerState = PlayerState.READY
        val metadata = PlaybackMetadata(duration, currentTime, playerState)
        notifyListeners("onMetadata", JSObject(jacksonMapper.writeValueAsString(metadata)))

        // Also emit the current playing state to update play/pause button
        emit("onPlayingUpdate", isPlaying)

        // Emit current time to update progress bar
        val ret = JSObject()
        ret.put("value", currentTime)
        ret.put("bufferedTime", audiobookMediaService.getBufferedTimeSeconds())
        notifyListeners("onTimeUpdate", ret)

        Log.d(tag, "Synced state - Playing: $isPlaying, CurrentTime: $currentTime, Duration: $duration, PlayerState: READY")

        // Force a small delay then emit playing state again to ensure UI updates
        Handler(Looper.getMainLooper()).post {
          emit("onPlayingUpdate", isPlaying)
          Log.d(tag, "Re-emitted playing state: $isPlaying")
        }

      } else {
        Log.d(tag, "No active playback session - checking server for last session")
        resumeFromLastServerSession()
      }
    } catch (e: Exception) {
      Log.e(tag, "Failed to sync playback state: ${e.message}")
    }
  }

  // --- Resume from last server session when no active session ---
  private fun resumeFromLastServerSession() {
    try {
      Log.d(tag, "Querying server for current user to get last playback session")

      // Use getCurrentUser to get user data which should include current session
      apiHandler.getCurrentUser { user ->
        if (user != null) {
          Log.d(tag, "Got user data from server")

          try {
            // Get the most recent media progress
            if (user.mediaProgress.isNotEmpty()) {
              val latestProgress = user.mediaProgress.maxByOrNull { it.lastUpdate }

              if (latestProgress != null && latestProgress.currentTime > 0) {
                Log.d(tag, "Found recent progress: ${latestProgress.libraryItemId} at ${latestProgress.currentTime}s")

                // Check if this library item is downloaded locally
                val localLibraryItem = DeviceManager.dbManager.getLocalLibraryItemByLId(latestProgress.libraryItemId)

                if (localLibraryItem != null) {
                  Log.d(tag, "Found local download for ${localLibraryItem.title}, using local copy")

                  // Create a local playback session
                  val deviceInfo = audiobookMediaService.getDeviceInfo()
                  val episode = if (latestProgress.episodeId != null && localLibraryItem.isPodcast) {
                    val podcast = localLibraryItem.media as? Podcast
                    podcast?.episodes?.find { ep -> ep.id == latestProgress.episodeId }
                  } else null

                  val localPlaybackSession = localLibraryItem.getPlaybackSession(episode, deviceInfo)
                  // Override the current time with the server progress to sync position
                  localPlaybackSession.currentTime = latestProgress.currentTime

                  Log.d(tag, "Resuming from local download: ${localLibraryItem.title} at ${latestProgress.currentTime}s")

                  // Get current playbook speed from MediaManager (same as Android Auto implementation)
                  val currentPlaybackSpeed = audiobookMediaService.mediaManager.getSavedPlaybackRate()

                  // Determine if we should start playing based on Android Auto mode
                  val shouldStartPlaying = audiobookMediaService.isAndroidAuto

                  // Prepare the player with appropriate play state and saved playback speed
                  Handler(Looper.getMainLooper()).post {
                    if (audiobookMediaService.mediaProgressSyncer.listeningTimerRunning) {
                      audiobookMediaService.mediaProgressSyncer.stop {
                        PlayerListener.lazyIsPlaying = false
                        audiobookMediaService.preparePlayer(localPlaybackSession, shouldStartPlaying, currentPlaybackSpeed)
                      }
                    } else {
                      audiobookMediaService.mediaProgressSyncer.reset()
                      PlayerListener.lazyIsPlaying = false
                      audiobookMediaService.preparePlayer(localPlaybackSession, shouldStartPlaying, currentPlaybackSpeed)
                    }
                  }
                  return@getCurrentUser
                }

                // No local copy found, get the library item from server
                Log.d(tag, "No local download found, using server streaming")
                apiHandler.getLibraryItem(latestProgress.libraryItemId) { libraryItem ->
                  if (libraryItem != null) {
                    Log.d(tag, "Got library item: ${libraryItem.media?.metadata?.title}")

                    // Create a playback session from the library item and progress
                    Handler(Looper.getMainLooper()).post {
                      try {
                        val episode = if (latestProgress.episodeId != null) {
                          val podcastMedia = libraryItem.media as? Podcast
                          podcastMedia?.episodes?.find { ep -> ep.id == latestProgress.episodeId }
                        } else null

                        // Use the API to get a proper playback session but don't start playback
                        val playItemRequestPayload = audiobookMediaService.getPlayItemRequestPayload(false)

                        // Try to get the current playback speed from the player, default to 1.0f if not available
                        val currentPlaybackSpeed = try {
                          if (::audiobookMediaService.isInitialized && audiobookMediaService.currentPlayer != null) {
                            audiobookMediaService.currentPlayer.playbackParameters?.speed ?: 1.0f
                          } else {
                            1.0f
                          }
                        } catch (e: Exception) {
                          Log.d(tag, "Could not get current playback speed, using default: ${e.message}")
                          1.0f
                        }

                        Log.d(tag, "Using playback speed: $currentPlaybackSpeed")

                        apiHandler.playLibraryItem(latestProgress.libraryItemId, latestProgress.episodeId, playItemRequestPayload) { playbackSession ->
                          if (playbackSession != null) {
                            // Override the current time with the saved progress
                            playbackSession.currentTime = latestProgress.currentTime

                            // Determine if we should start playing based on Android Auto mode
                            val shouldStartPlaying = audiobookMediaService.isAndroidAuto
                            val playStateText = if (shouldStartPlaying) "playing" else "paused"

                            Log.d(tag, "Resuming from server session: ${libraryItem.media.metadata?.title} at ${latestProgress.currentTime}s in $playStateText state with speed ${currentPlaybackSpeed}x")

                            // Prepare the player with appropriate play state on main thread with correct playback speed
                            Handler(Looper.getMainLooper()).post {
                              if (audiobookMediaService.mediaProgressSyncer.listeningTimerRunning) {
                                audiobookMediaService.mediaProgressSyncer.stop {
                                  PlayerListener.lazyIsPlaying = false
                                  audiobookMediaService.preparePlayer(playbackSession, shouldStartPlaying, currentPlaybackSpeed) // Use correct speed
                                }
                              } else {
                                audiobookMediaService.mediaProgressSyncer.reset()
                                PlayerListener.lazyIsPlaying = false
                                audiobookMediaService.preparePlayer(playbackSession, shouldStartPlaying, currentPlaybackSpeed) // Use correct speed
                              }
                            }
                          } else {
                            Log.e(tag, "Failed to create playback session from server")
                          }
                        }

                      } catch (e: Exception) {
                        Log.e(tag, "Error creating playback session from server data: ${e.message}")
                      }
                    }
                  } else {
                    Log.d(tag, "Could not get library item ${latestProgress.libraryItemId} from server")
                  }
                }
              } else {
                Log.d(tag, "No recent progress found or progress is at beginning")
              }
            } else {
              Log.d(tag, "No media progress found in user data")
            }

          } catch (e: Exception) {
            Log.e(tag, "Error processing user session data: ${e.message}")
          }
        } else {
          Log.d(tag, "No user data found from server")
        }
      }
    } catch (e: Exception) {
      Log.e(tag, "Failed to resume from last server session: ${e.message}")
    }
  }

  // --- Smart sync that waits for web view to be ready ---
  fun syncCurrentPlaybackStateWhenReady(maxRetries: Int = 10, retryIntervalMs: Long = 500) {
    var retryCount = 0

    fun attemptSync() {
      try {
        // Check if bridge and web view are ready
        val webView = bridge?.webView
        if (webView != null && bridge != null) {
          // Additional check to see if web view has loaded content
          webView.evaluateJavascript("(function() { return document.readyState === 'complete' && window.Capacitor != null; })();") { result ->
            if (result == "true") {
              Log.d(tag, "Web view is ready, syncing playback state")
              syncCurrentPlaybackState()
            } else {
              retryCount++
              if (retryCount < maxRetries) {
                Log.d(tag, "Web view not ready yet, retry $retryCount/$maxRetries")
                Handler(Looper.getMainLooper()).post {
                  attemptSync()
                }
              } else {
                Log.w(tag, "Max retries reached, falling back to immediate sync")
                syncCurrentPlaybackState()
              }
            }
          }
          return
        }

        retryCount++
        if (retryCount < maxRetries) {
          Log.d(tag, "Bridge/WebView not ready yet, retry $retryCount/$maxRetries")
          Handler(Looper.getMainLooper()).post {
            attemptSync()
          }
        } else {
          Log.w(tag, "Max retries reached, falling back to immediate sync")
          syncCurrentPlaybackState()
        }
      } catch (e: Exception) {
        Log.e(tag, "Error checking web view readiness: ${e.message}")
        // Fallback to immediate sync
        syncCurrentPlaybackState()
      }
    }

    attemptSync()
  }

  fun emit(evtName: String, value: Any) {
    val ret = JSObject()
    ret.put("value", value)
    notifyListeners(evtName, ret)
  }

  // Legacy initCastManager removed - Cast functionality now handled by AudiobookMediaService

  /**
   * Initialize MediaController for proper Media3 interface
   * This provides the standard way to control media playback instead of direct service calls
   */
  private fun initializeMediaController() {
    try {
      Log.i(tag, "*** Initializing MediaController for proper Media3 interface ***")

      if (!::audiobookMediaService.isInitialized) {
        Log.w(tag, "AudiobookMediaService not initialized, cannot create MediaController")
        return
      }

      val sessionToken = audiobookMediaService.getSessionToken()
      if (sessionToken == null) {
        Log.w(tag, "Session token not available, cannot create MediaController")
        return
      }

      val controllerFuture = MediaController.Builder(context, sessionToken).buildAsync()

      controllerFuture.addListener({
        try {
          mediaController = controllerFuture.get()
          Log.i(tag, "*** MediaController connected - UI can now use standardized Media3 interface ***")
          Log.i(tag, "*** Benefits: Decoupled architecture, consistent with Android Auto, proper session management ***")
        } catch (e: Exception) {
          Log.e(tag, "*** Error connecting MediaController: ${e.message} ***")
        }
      }, MoreExecutors.directExecutor())

    } catch (e: Exception) {
      Log.e(tag, "*** Error creating MediaController: ${e.message} ***")
    }
  }

  private fun setupCastListeners() {
    try {
      // Monitor cast availability changes
      val castPlayerManager = audiobookMediaService.castPlayerManager

      // Since we can't use coroutines directly here, we'll check periodically
      // This is a simple approach - a better implementation would use coroutines
      val handler = Handler(Looper.getMainLooper())
      var lastCastAvailable = false

      val checkCastAvailability = object : Runnable {
        override fun run() {
          try {
            val currentCastAvailable = castPlayerManager.isCastAvailable.value
            if (currentCastAvailable != lastCastAvailable) {
              lastCastAvailable = currentCastAvailable
              isCastAvailable = currentCastAvailable
              emit("onCastAvailableUpdate", currentCastAvailable)
              Log.d(tag, "Cast availability changed: $currentCastAvailable")
            }
          } catch (e: Exception) {
            Log.e(tag, "Error checking cast availability: ${e.message}")
          }
          handler.postDelayed(this, 2000) // Check every 2 seconds
        }
      }

      handler.post(checkCastAvailability)
      Log.d(tag, "Cast listeners setup completed")
    } catch (e: Exception) {
      Log.e(tag, "Error setting up cast listeners: ${e.message}")
    }
  }

  @PluginMethod
  fun prepareLibraryItem(call: PluginCall) {
    val libraryItemId = call.getString("libraryItemId", "").toString()
    val episodeId = call.getString("episodeId", "").toString()
    val playWhenReady = call.getBoolean("playWhenReady") == true
    val playbackRate = call.getFloat("playbackRate",1f) ?: 1f
    val startTimeOverride = call.getDouble("startTime")

    AbsLogger.info("AbsAudioPlayer", "prepareLibraryItem: lid=$libraryItemId, startTimeOverride=$startTimeOverride, playbackRate=$playbackRate")

    if (libraryItemId.isEmpty()) {
      Log.e(tag, "Invalid call to play library item no library item id")
      return call.resolve(JSObject("{\"error\":\"Invalid request\"}"))
    }

    if (libraryItemId.startsWith("local")) { // Play local media item
      DeviceManager.dbManager.getLocalLibraryItem(libraryItemId)?.let {
        var episode: PodcastEpisode? = null
        if (episodeId.isNotEmpty()) {
          val podcastMedia = it.media as Podcast
          episode = podcastMedia.episodes?.find { ep -> ep.id == episodeId }
          if (episode == null) {
            Log.e(tag, "prepareLibraryItem: Podcast episode not found $episodeId")
            return call.resolve(JSObject("{\"error\":\"Podcast episode not found\"}"))
          }
        }
        if (!it.hasTracks(episode)) {
          return call.resolve(JSObject("{\"error\":\"No audio files found on device. Download book again to fix.\"}"))
        }

        Handler(Looper.getMainLooper()).post {
          Log.d(tag, "prepareLibraryItem: Preparing Local Media item ${jacksonMapper.writeValueAsString(it)}")
          val playbackSession = it.getPlaybackSession(episode, audiobookMediaService.getDeviceInfo())
          if (startTimeOverride != null) {
            Log.d(tag, "prepareLibraryItem: Using start time override $startTimeOverride")
            playbackSession.currentTime = startTimeOverride
          }

          if (audiobookMediaService.mediaProgressSyncer.listeningTimerRunning) { // If progress syncing then first stop before preparing next
            audiobookMediaService.mediaProgressSyncer.stop {
              Log.d(tag, "Media progress syncer was already syncing - stopped")
              PlayerListener.lazyIsPlaying = false

              Handler(Looper.getMainLooper()).post { // TODO: This was needed again which is probably a design a flaw
                audiobookMediaService.preparePlayer(
                  playbackSession,
                  playWhenReady,
                  playbackRate
                )
              }
            }
          } else {
            audiobookMediaService.mediaProgressSyncer.reset()
            audiobookMediaService.preparePlayer(playbackSession, playWhenReady, playbackRate)
          }
        }
        return call.resolve(JSObject())
      }
    } else { // Play library item from server
      val playItemRequestPayload = audiobookMediaService.getPlayItemRequestPayload(false)
      Handler(Looper.getMainLooper()).post {
        audiobookMediaService.mediaProgressSyncer.stop {
          apiHandler.playLibraryItem(libraryItemId, episodeId, playItemRequestPayload) {
            if (it == null) {
              call.resolve(JSObject("{\"error\":\"Server play request failed\"}"))
            } else {
              if (startTimeOverride != null) {
                Log.d(tag, "prepareLibraryItem: Using start time override $startTimeOverride")
                it.currentTime = startTimeOverride
              }

              Handler(Looper.getMainLooper()).post {
                Log.d(tag, "Preparing Player playback session ${jacksonMapper.writeValueAsString(it)}")
                PlayerListener.lazyIsPlaying = false
                audiobookMediaService.preparePlayer(it, playWhenReady, playbackRate)
              }
              call.resolve(JSObject(jacksonMapper.writeValueAsString(it)))
            }
          }
        }
      }
    }
  }

  @PluginMethod
  fun getCurrentTime(call: PluginCall) {
    Handler(Looper.getMainLooper()).post {
      val currentTime = audiobookMediaService.getCurrentTimeSeconds()
      val bufferedTime = audiobookMediaService.getBufferedTimeSeconds()
      val ret = JSObject()
      ret.put("value", currentTime)
      ret.put("bufferedTime", bufferedTime)
      call.resolve(ret)
    }
  }

  @PluginMethod
  fun pausePlayer(call: PluginCall) {
    Handler(Looper.getMainLooper()).post {
      // Use MediaController for proper Media3 interface
      if (mediaController != null) {
        Log.d(tag, "*** Using MediaController.pause() - proper Media3 interface ***")
        mediaController!!.pause()
      } else {
        Log.w(tag, "*** MediaController not available, falling back to direct service call ***")
        audiobookMediaService.pause()
      }
      call.resolve()
    }
  }

  @PluginMethod
  fun playPlayer(call: PluginCall) {
    Handler(Looper.getMainLooper()).post {
      // Use MediaController for proper Media3 interface
      if (mediaController != null) {
        Log.d(tag, "*** Using MediaController.play() - proper Media3 interface ***")
        mediaController!!.play()
      } else {
        Log.w(tag, "*** MediaController not available, falling back to direct service call ***")
        audiobookMediaService.play()
      }
      call.resolve()
    }
  }

  @PluginMethod
  fun playPause(call: PluginCall) {
    Handler(Looper.getMainLooper()).post {
      // Use MediaController for proper Media3 interface
      if (mediaController != null) {
        Log.d(tag, "*** Using MediaController.play/pause() - proper Media3 interface ***")
        val isPlaying = mediaController!!.isPlaying
        if (isPlaying) {
          mediaController!!.pause()
        } else {
          mediaController!!.play()
        }
        call.resolve(JSObject("{\"playing\":${!isPlaying}}"))
      } else {
        Log.w(tag, "*** MediaController not available, falling back to direct service call ***")
        val playing = audiobookMediaService.playPause()
        call.resolve(JSObject("{\"playing\":$playing}"))
      }
    }
  }

  @PluginMethod
  fun seek(call: PluginCall) {
    val time:Int = call.getInt("value", 0) ?: 0 // Value in seconds
    Log.d(tag, "seek action to $time")
    Handler(Looper.getMainLooper()).post {
      // Use MediaController for proper Media3 interface
      if (mediaController != null) {
        Log.d(tag, "*** Using MediaController.seekTo() - proper Media3 interface ***")
        mediaController!!.seekTo(time * 1000L) // convert to ms
      } else {
        Log.w(tag, "*** MediaController not available, falling back to direct service call ***")
        audiobookMediaService.seekPlayer(time * 1000L) // convert to ms
      }
      call.resolve()
    }
  }

  @PluginMethod
  fun seekForward(call: PluginCall) {
    val amount:Int = call.getInt("value", 0) ?: 0
    Handler(Looper.getMainLooper()).post {
      audiobookMediaService.seekForward(amount * 1000L) // convert to ms
      call.resolve()
    }
  }

  @PluginMethod
  fun seekBackward(call: PluginCall) {
    val amount:Int = call.getInt("value", 0) ?: 0 // Value in seconds
    Handler(Looper.getMainLooper()).post {
      audiobookMediaService.seekBackward(amount * 1000L) // convert to ms
      call.resolve()
    }
  }

  @PluginMethod
  fun setPlaybackSpeed(call: PluginCall) {
    val playbackSpeed:Float = call.getFloat("value", 1.0f) ?: 1.0f

    Handler(Looper.getMainLooper()).post {
      audiobookMediaService.setPlaybackSpeed(playbackSpeed)
      call.resolve()
    }
  }

  @PluginMethod
  fun closePlayback(call: PluginCall) {
    Handler(Looper.getMainLooper()).post {
      audiobookMediaService.closePlayback()
      call.resolve()
    }
  }

  @PluginMethod
  fun setSleepTimer(call: PluginCall) {
    val time:Long = call.getString("time", "360000")!!.toLong()
    val isChapterTime:Boolean = call.getBoolean("isChapterTime", false) == true

    Handler(Looper.getMainLooper()).post {
        val playbackSession: PlaybackSession? = audiobookMediaService.mediaProgressSyncer.currentPlaybackSession ?: audiobookMediaService.currentPlaybackSession
        val success:Boolean = audiobookMediaService.sleepTimerManager.setManualSleepTimer(playbackSession?.id ?: "", time, isChapterTime)
        val ret = JSObject()
        ret.put("success", success)
        call.resolve(ret)
    }
  }

  @PluginMethod
  fun getSleepTimerTime(call: PluginCall) {
    val time = audiobookMediaService.sleepTimerManager.getSleepTimerTime()
    val ret = JSObject()
    ret.put("value", time)
    call.resolve(ret)
  }

  @PluginMethod
  fun increaseSleepTime(call: PluginCall) {
    val time:Long = call.getString("time", "300000")!!.toLong()

    Handler(Looper.getMainLooper()).post {
      audiobookMediaService.sleepTimerManager.increaseSleepTime(time)
      val ret = JSObject()
      ret.put("success", true)
      call.resolve()
    }
  }

  @PluginMethod
  fun decreaseSleepTime(call: PluginCall) {
    val time:Long = call.getString("time", "300000")!!.toLong()

    Handler(Looper.getMainLooper()).post {
      audiobookMediaService.sleepTimerManager.decreaseSleepTime(time)
      val ret = JSObject()
      ret.put("success", true)
      call.resolve()
    }
  }

  @PluginMethod
  fun cancelSleepTimer(call: PluginCall) {
    Handler(Looper.getMainLooper()).post {
      audiobookMediaService.sleepTimerManager.cancelSleepTimer()
    }
    call.resolve()
  }

  @PluginMethod
  fun requestSession(call: PluginCall) {
    Log.d(tag, "CAST REQUEST SESSION - Using Media3 Cast integration")

    // AudiobookMediaService automatically handles cast player switching
    // when cast becomes available via CastPlayerManager
    // Cast availability and switching is managed automatically

    Log.d(tag, "Cast functionality is integrated into AudiobookMediaService - no manual session request needed")
    call.resolve()
  }

  @PluginMethod
  fun getIsCastAvailable(call: PluginCall) {
    val jsobj = JSObject()
    // Get cast availability from AudiobookMediaService's CastPlayerManager
    try {
      val castAvailable = audiobookMediaService.castPlayerManager.isCastAvailable.value
      jsobj.put("value", castAvailable)
      Log.d(tag, "Cast available: $castAvailable")
    } catch (e: Exception) {
      Log.e(tag, "Error getting cast availability: ${e.message}")
      jsobj.put("value", false)
    }
    call.resolve(jsobj)
  }

  @PluginMethod
  fun syncPlaybackState(call: PluginCall) {
    syncCurrentPlaybackState()
    call.resolve()
  }

  @PluginMethod
  fun getLastPlaybackSession(call: PluginCall) {
    val lastPlaybackSession = DeviceManager.deviceData.lastPlaybackSession
    if (lastPlaybackSession != null) {
      val jsObject = JSObject(jacksonMapper.writeValueAsString(lastPlaybackSession))
      call.resolve(jsObject)
    } else {
      call.resolve()
    }
  }

  @PluginMethod
  fun resumeLastPlaybackSession(call: PluginCall) {
    val lastPlaybackSession = DeviceManager.deviceData.lastPlaybackSession
    if (lastPlaybackSession != null) {
      // Check if session has meaningful progress (not at the very beginning)
      val progress = lastPlaybackSession.currentTime / lastPlaybackSession.duration
      if (progress > 0.01) {
        Log.d(tag, "Resuming last playback session: ${lastPlaybackSession.displayTitle}")

        // Ensure this runs on the main thread since ExoPlayer operations require it
        Handler(Looper.getMainLooper()).post {
          try {
            val savedPlaybackSpeed = audiobookMediaService.mediaManager.getSavedPlaybackRate()
            // Determine if we should start playing based on Android Auto mode
            val shouldStartPlaying = audiobookMediaService.isAndroidAuto
            audiobookMediaService.preparePlayer(lastPlaybackSession, shouldStartPlaying, savedPlaybackSpeed)
            call.resolve()
          } catch (e: Exception) {
            Log.e(tag, "Error resuming last playback session", e)
            call.reject("Failed to resume session: ${e.message}", "RESUME_FAILED")
          }
        }
      } else {
        call.reject("Session not resumable", "PROGRESS_INVALID")
      }
    } else {
      call.reject("No last session found", "NO_SESSION")
    }
  }

  @PluginMethod
  fun hasResumableSession(call: PluginCall) {
    val lastPlaybackSession = DeviceManager.deviceData.lastPlaybackSession
    val ret = JSObject()

    if (lastPlaybackSession != null) {
      val progress = lastPlaybackSession.currentTime / lastPlaybackSession.duration
      val isResumable = progress > 0.01
      ret.put("hasSession", true)
      ret.put("isResumable", isResumable)
      ret.put("progress", progress)
      ret.put("title", lastPlaybackSession.displayTitle ?: "Unknown")
    } else {
      ret.put("hasSession", false)
      ret.put("isResumable", false)
    }

    call.resolve(ret)
  }

  @PluginMethod
  fun navigateToChapter(call: PluginCall) {
    val chapterIndex: Int = call.getInt("chapterIndex", -1) ?: -1
    Log.d(tag, "navigateToChapter action to chapter $chapterIndex")
    if (chapterIndex < 0) {
      call.reject("Invalid chapter index")
      return
    }

    Handler(Looper.getMainLooper()).post {
      audiobookMediaService.navigateToChapter(chapterIndex)
      call.resolve()
    }
  }

  @PluginMethod
  fun skipToNextChapter(call: PluginCall) {
    Handler(Looper.getMainLooper()).post {
      audiobookMediaService.skipToNext()
      call.resolve()
    }
  }

  @PluginMethod
  fun skipToPreviousChapter(call: PluginCall) {
    Handler(Looper.getMainLooper()).post {
      audiobookMediaService.skipToPrevious()
      call.resolve()
    }
  }

  @PluginMethod
  fun getCurrentNavigationIndex(call: PluginCall) {
    Handler(Looper.getMainLooper()).post {
      val currentIndex = audiobookMediaService.getCurrentNavigationIndex()
      val ret = JSObject()
      ret.put("index", currentIndex)
      call.resolve(ret)
    }
  }

  @PluginMethod
  fun getNavigationItemCount(call: PluginCall) {
    Handler(Looper.getMainLooper()).post {
      val count = audiobookMediaService.getNavigationItemCount()
      val ret = JSObject()
      ret.put("count", count)
      call.resolve(ret)
    }
  }

  /**
   * Cleanup MediaController when plugin is destroyed
   */
  protected fun finalize() {
    try {
      mediaController?.release()
      mediaController = null
      Log.d(tag, "MediaController cleanup completed")
    } catch (e: Exception) {
      Log.e(tag, "Error during MediaController cleanup: ${e.message}")
    }
  }
}
