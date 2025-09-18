package com.audiobookshelf.app.plugins

import android.os.Handler
import android.os.Looper
import android.util.Log
import com.audiobookshelf.app.MainActivity
import com.audiobookshelf.app.data.*
import com.audiobookshelf.app.device.DeviceManager
import com.audiobookshelf.app.media.MediaEventManager
import com.audiobookshelf.app.player.CastManager
import com.audiobookshelf.app.player.PlayerListener
import com.audiobookshelf.app.player.PlayerNotificationService
import com.audiobookshelf.app.server.ApiHandler
import com.fasterxml.jackson.core.json.JsonReadFeature
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.getcapacitor.*
import com.getcapacitor.annotation.CapacitorPlugin
// MIGRATION-DEFERRED: CAST - Commented out Cast imports
// import com.google.android.gms.cast.CastDevice
// import com.google.android.gms.common.ConnectionResult
// import com.google.android.gms.common.GoogleApiAvailability
import org.json.JSONObject

@CapacitorPlugin(name = "AbsAudioPlayer")
class AbsAudioPlayer : Plugin() {
  private val tag = "AbsAudioPlayer"
  private var jacksonMapper = jacksonObjectMapper().enable(JsonReadFeature.ALLOW_UNESCAPED_CONTROL_CHARS.mappedFeature())

  private lateinit var mainActivity: MainActivity
  private lateinit var apiHandler:ApiHandler

  // Rate limiting for socket updates to prevent overwhelming the player
  private var lastSocketUpdateTime = 0L
  private val SOCKET_UPDATE_MIN_INTERVAL = 1000L // Minimum 1 second between socket updates
  var castManager:CastManager? = null

  lateinit var playerNotificationService: PlayerNotificationService

  private var isCastAvailable:Boolean = false

  override fun load() {
    mainActivity = (activity as MainActivity)
    apiHandler = ApiHandler(mainActivity)

    try {
      initCastManager()
    } catch(e:Exception) {
      Log.e(tag, "initCastManager exception ${e.printStackTrace()}")
    }

    val foregroundServiceReady : () -> Unit = {
      Log.d(tag, "foregroundServiceReady callback called - service is now initialized")
      playerNotificationService = mainActivity.foregroundService

      playerNotificationService.clientEventEmitter = (object : PlayerNotificationService.ClientEventEmitter {
        override fun onPlaybackSession(playbackSession: PlaybackSession) {
          notifyListeners("onPlaybackSession", JSObject(jacksonMapper.writeValueAsString(playbackSession)))
        }

        override fun onPlaybackClosed() {
          emit("onPlaybackClosed", true)
          // Ensure progress is saved and synced when playback is closed (native-only sessions)
          try {
            Handler(Looper.getMainLooper()).post {
              try {
                playerNotificationService.mediaProgressSyncer.stop(true) { /* finished */ }
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
                  playerNotificationService.mediaProgressSyncer.forceSyncNow(true) { /* result ignored */ }
                } else {
                  // On pause, ensure local progress is saved and attempt to push to server
                  playerNotificationService.mediaProgressSyncer.pause { /* result ignored */ }
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
      })

      MediaEventManager.clientEventEmitter = playerNotificationService.clientEventEmitter
      // --- Sync playback state and metadata on service connection ---
      syncCurrentPlaybackState()
    }
    mainActivity.pluginCallback = foregroundServiceReady
  }

  // --- New function to sync playback state and metadata ---
  fun syncCurrentPlaybackState() {
    if (!::playerNotificationService.isInitialized) {
      Log.d(tag, "PlayerNotificationService not initialized yet, skipping sync")
      return
    }
    try {
      val playbackSession = playerNotificationService.currentPlaybackSession
      if (playbackSession != null) {
        Log.d(tag, "Syncing playback state: ${playbackSession.libraryItem?.media?.metadata?.title}")
        notifyListeners("onPlaybackSession", JSObject(jacksonMapper.writeValueAsString(playbackSession)))

        // Create and emit metadata using the same pattern as the service
        val duration = playbackSession.duration
        val isPlaying = playerNotificationService.currentPlayer.isPlaying

        // Get current time - prefer playback session time if player position seems incorrect
        // This prevents reporting stale player position during app resume
        val playerCurrentTime = playerNotificationService.getCurrentTimeSeconds()
        val sessionCurrentTime = playbackSession.currentTime

        // Use session time if player time is significantly different and player is not actively playing
        // This handles the case where player position hasn't been restored yet on app resume
        val currentTime = if (!isPlaying && Math.abs(playerCurrentTime - sessionCurrentTime) > 1.0) {
          Log.d(tag, "Using session time ($sessionCurrentTime) instead of player time ($playerCurrentTime) - likely stale position")
          sessionCurrentTime
        } else {
          playerCurrentTime
        }

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
        ret.put("bufferedTime", playerNotificationService.getBufferedTimeSeconds())
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

  // --- Helper method to check if player service is ready ---
  private fun isPlayerServiceReady(): Boolean {
    return ::playerNotificationService.isInitialized
  }

    // --- Helper method to determine if we should use server progress ---
  private fun shouldUseServerProgress(playbackSession: PlaybackSession, serverProgress: MediaProgress): Boolean {
    val localCurrentTime = playbackSession.currentTime
    val serverCurrentTime = serverProgress.currentTime
    val localUpdatedAt = playbackSession.updatedAt ?: 0L
    val serverUpdatedAt = serverProgress.lastUpdate

    // Check if server progress is newer (within a reasonable time window)
    val serverIsNewer = serverUpdatedAt > localUpdatedAt

    // Check if server progress is significantly farther ahead (more than 30 seconds)
    val serverIsFarther = serverCurrentTime > localCurrentTime + 30.0

    // Also check if server progress is significantly behind (more than 30 seconds)
    // In this case, we might want to use local progress if it's much further
    val serverIsMuchBehind = serverCurrentTime < localCurrentTime - 30.0

    val shouldUseServer = if (serverIsNewer) {
      // If server is newer, use it if it's not much behind local progress
      !serverIsMuchBehind
    } else {
      // If server is older, only use it if it's significantly farther ahead
      serverIsFarther
    }

    Log.d(tag, "Progress comparison - Local: ${localCurrentTime}s (updated: $localUpdatedAt), Server: ${serverCurrentTime}s (updated: $serverUpdatedAt)")
    Log.d(tag, "Decision: ${if (shouldUseServer) "USE SERVER" else "USE LOCAL"} (newer: $serverIsNewer, farther: $serverIsFarther, muchBehind: $serverIsMuchBehind)")

    return shouldUseServer
  }

  // --- Resume from last server session when no active session ---
  private fun resumeFromLastServerSession() {
    if (!::playerNotificationService.isInitialized) {
      Log.d(tag, "PlayerNotificationService not initialized yet, skipping resume")
      return
    }

    // Check if we have a valid server connection before making API calls
    if (!DeviceManager.isConnectedToServer) {
      Log.d(tag, "No valid server connection available, skipping resume from server session")
      return
    }

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
                  val deviceInfo = playerNotificationService.getDeviceInfo()
                  val episode = if (latestProgress.episodeId != null && localLibraryItem.isPodcast) {
                    val podcast = localLibraryItem.media as? Podcast
                    podcast?.episodes?.find { ep -> ep.id == latestProgress.episodeId }
                  } else null

                  val localPlaybackSession = localLibraryItem.getPlaybackSession(episode, deviceInfo)

                  // Check if we should use server progress or local progress
                  val shouldUseServerProgress = shouldUseServerProgress(localPlaybackSession, latestProgress)

                  if (shouldUseServerProgress) {
                    // Override the current time with the server progress to sync position
                    localPlaybackSession.currentTime = latestProgress.currentTime
                    Log.d(tag, "Using server progress: ${latestProgress.currentTime}s (newer/farther than local)")
                  } else {
                    Log.d(tag, "Using local progress: ${localPlaybackSession.currentTime}s (server progress not newer/farther)")
                  }

                  Log.d(tag, "Resuming from local download: ${localLibraryItem.title} at ${localPlaybackSession.currentTime}s")

                  // Get current playbook speed from MediaManager (same as Android Auto implementation)
                  val currentPlaybackSpeed = playerNotificationService.mediaManager.getSavedPlaybackRate()

                  // Determine if we should start playing based on Android Auto mode
                  val shouldStartPlaying = playerNotificationService.isAndroidAuto

                  // Prepare the player with appropriate play state and saved playback speed
                  Handler(Looper.getMainLooper()).post {
                    if (playerNotificationService.mediaProgressSyncer.listeningTimerRunning) {
                      playerNotificationService.mediaProgressSyncer.stop {
                        PlayerListener.lazyIsPlaying = false
                        playerNotificationService.preparePlayer(localPlaybackSession, shouldStartPlaying, currentPlaybackSpeed)
                      }
                    } else {
                      playerNotificationService.mediaProgressSyncer.reset()
                      PlayerListener.lazyIsPlaying = false
                      playerNotificationService.preparePlayer(localPlaybackSession, shouldStartPlaying, currentPlaybackSpeed)
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
                        val playItemRequestPayload = playerNotificationService.getPlayItemRequestPayload(false)

                        // Try to get the current playback speed from the player, default to 1.0f if not available
                        val currentPlaybackSpeed = try {
                          if (::playerNotificationService.isInitialized && playerNotificationService.currentPlayer != null) {
                            playerNotificationService.currentPlayer.playbackParameters?.speed ?: 1.0f
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
                            // Check if we should use server progress or local progress
                            val shouldUseServerProgress = shouldUseServerProgress(playbackSession, latestProgress)

                            if (shouldUseServerProgress) {
                              // Override the current time with the saved progress
                              playbackSession.currentTime = latestProgress.currentTime
                              Log.d(tag, "Using server progress: ${latestProgress.currentTime}s (newer/farther than local)")
                            } else {
                              Log.d(tag, "Using local progress: ${playbackSession.currentTime}s (server progress not newer/farther)")
                            }

                            // Determine if we should start playing based on Android Auto mode
                            val shouldStartPlaying = playerNotificationService.isAndroidAuto
                            val playStateText = if (shouldStartPlaying) "playing" else "paused"

                            Log.d(tag, "Resuming from server session: ${libraryItem.media.metadata?.title} at ${playbackSession.currentTime}s in $playStateText state with speed ${currentPlaybackSpeed}x")

                            // Prepare the player with appropriate play state on main thread with correct playback speed
                            Handler(Looper.getMainLooper()).post {
                              if (playerNotificationService.mediaProgressSyncer.listeningTimerRunning) {
                                playerNotificationService.mediaProgressSyncer.stop {
                                  PlayerListener.lazyIsPlaying = false
                                  playerNotificationService.preparePlayer(playbackSession, shouldStartPlaying, currentPlaybackSpeed) // Use correct speed
                                }
                              } else {
                                playerNotificationService.mediaProgressSyncer.reset()
                                PlayerListener.lazyIsPlaying = false
                                playerNotificationService.preparePlayer(playbackSession, shouldStartPlaying, currentPlaybackSpeed) // Use correct speed
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

  // --- Wait for player service to be ready before preparing library item ---
  private fun prepareLibraryItemWhenReady(call: PluginCall, libraryItem: LocalLibraryItem, episode: PodcastEpisode?, startTimeOverride: Double?, playbackRate: Float, retryCount: Int = 0) {
    val maxRetries = 50 // 5 seconds max wait time
    if (::playerNotificationService.isInitialized) {
      // Service is ready, proceed immediately
      Log.d(tag, "prepareLibraryItem: Service ready after $retryCount retries, preparing Local Media item")
      val playbackSession = libraryItem.getPlaybackSession(episode, playerNotificationService.getDeviceInfo())
      if (startTimeOverride != null) {
        Log.d(tag, "prepareLibraryItem: Using start time override $startTimeOverride")
        playbackSession.currentTime = startTimeOverride
      }

      if (playerNotificationService.mediaProgressSyncer.listeningTimerRunning) { // If progress syncing then first stop before preparing next
        playerNotificationService.mediaProgressSyncer.stop {
          Log.d(tag, "Media progress syncer was already syncing - stopped")
          PlayerListener.lazyIsPlaying = false

          Handler(Looper.getMainLooper()).post { // TODO: This was needed again which is probably a design a flaw
            playerNotificationService.preparePlayer(
              playbackSession,
              true, // playWhenReady for local items
              playbackRate
            )
          }
        }
      } else {
        playerNotificationService.mediaProgressSyncer.reset()
        playerNotificationService.preparePlayer(playbackSession, true, playbackRate) // playWhenReady for local items
      }
      call.resolve(JSObject())
    } else {
      // Service not ready yet
      if (retryCount == 0) {
        // First attempt - start the service if not already started
        Log.d(tag, "prepareLibraryItem: Service not initialized, starting service...")
        mainActivity.startMyService()
      }

      if (retryCount >= maxRetries) {
        // Timeout - service never initialized
        Log.e(tag, "prepareLibraryItem: Service initialization timeout after ${maxRetries * 100}ms")
        call.resolve(JSObject("{\"error\":\"Player service failed to initialize\"}"))
      } else {
        // Service not ready yet, wait and retry
        Log.d(tag, "prepareLibraryItem: PlayerNotificationService not ready yet, waiting... (attempt ${retryCount + 1}/$maxRetries)")
        Handler(Looper.getMainLooper()).postDelayed({
          prepareLibraryItemWhenReady(call, libraryItem, episode, startTimeOverride, playbackRate, retryCount + 1)
        }, 100) // Check again in 100ms
      }
    }
  }

  private fun initCastManager() {
    // MIGRATION-DEFERRED: CAST - Commented out Cast initialization
    /*
    val googleApi = GoogleApiAvailability.getInstance()
    val statusCode = googleApi.isGooglePlayServicesAvailable(mainActivity)

    if (statusCode != ConnectionResult.SUCCESS) {
        if (statusCode == ConnectionResult.SERVICE_MISSING) {
          Log.w(tag, "initCastManager: Google Api Missing")
        } else if (statusCode == ConnectionResult.SERVICE_DISABLED) {
          Log.w(tag, "initCastManager: Google Api Disabled")
        } else if (statusCode == ConnectionResult.SERVICE_INVALID) {
          Log.w(tag, "initCastManager: Google Api Invalid")
        } else if (statusCode == ConnectionResult.SERVICE_UPDATING) {
          Log.w(tag, "initCastManager: Google Api Updating")
        } else if (statusCode == ConnectionResult.SERVICE_VERSION_UPDATE_REQUIRED) {
          Log.w(tag, "initCastManager: Google Api Update Required")
        }
        return
    }

    val connListener = object: CastManager.ChromecastListener() {
      override fun onReceiverAvailableUpdate(available: Boolean) {
        Log.d(tag, "ChromecastListener: CAST Receiver Update Available $available")
        isCastAvailable = available
        emit("onCastAvailableUpdate", available)
      }

      override fun onSessionRejoin(jsonSession: JSONObject?) {
        Log.d(tag, "ChromecastListener: CAST onSessionRejoin")
      }

      override fun onMediaLoaded(jsonMedia: JSONObject?) {
        Log.d(tag, "ChromecastListener: CAST onMediaLoaded")
      }

      override fun onMediaUpdate(jsonMedia: JSONObject?) {
        Log.d(tag, "ChromecastListener: CAST onMediaUpdate")
      }

      override fun onSessionUpdate(jsonSession: JSONObject?) {
        Log.d(tag, "ChromecastListener: CAST onSessionUpdate")
      }

      override fun onSessionEnd(jsonSession: JSONObject?) {
        Log.d(tag, "ChromecastListener: CAST onSessionEnd")
      }

      override fun onMessageReceived(p0: CastDevice, p1: String, p2: String) {
        Log.d(tag, "ChromecastListener: CAST onMessageReceived")
      }
    }

    castManager = CastManager(mainActivity)
    castManager?.startRouteScan(connListener)
    */
  }

  @PluginMethod
  fun prepareLibraryItem(call: PluginCall) {
    val libraryItemId = call.getString("libraryItemId", "").toString()
    val episodeId = call.getString("episodeId", "").toString()
    val playWhenReady = call.getBoolean("playWhenReady") == true
    val playbackRate = call.getFloat("playbackRate",1f) ?: 1f
    val startTimeOverride = call.getDouble("startTime")

    Log.d(tag, "prepareLibraryItem: ===== STARTING PREPARATION =====")
    Log.d(tag, "prepareLibraryItem: Library Item ID: $libraryItemId")
    Log.d(tag, "prepareLibraryItem: Episode ID: $episodeId")
    Log.d(tag, "prepareLibraryItem: Play When Ready: $playWhenReady")
    Log.d(tag, "prepareLibraryItem: Playback Rate: $playbackRate")
    Log.d(tag, "prepareLibraryItem: Start Time Override: $startTimeOverride")

    AbsLogger.info("AbsAudioPlayer", "prepareLibraryItem: lid=$libraryItemId, startTimeOverride=$startTimeOverride, playbackRate=$playbackRate")

    if (libraryItemId.isEmpty()) {
      Log.e(tag, "prepareLibraryItem: Invalid call - no library item id")
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
          prepareLibraryItemWhenReady(call, it, episode, startTimeOverride, playbackRate)
        }
      }
    } else { // Play library item from server
      Handler(Looper.getMainLooper()).post {
        if (!::playerNotificationService.isInitialized) {
          Log.e(tag, "prepareLibraryItem: playerNotificationService not initialized yet for server item")
          call.resolve(JSObject("{\"error\":\"Player service not ready\"}"))
          return@post
        }
        val playItemRequestPayload = playerNotificationService.getPlayItemRequestPayload(false)
        playerNotificationService.mediaProgressSyncer.stop {
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
                playerNotificationService.preparePlayer(it, playWhenReady, playbackRate)
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
      val currentTime = playerNotificationService.getCurrentTimeSeconds()
      val bufferedTime = playerNotificationService.getBufferedTimeSeconds()
      val ret = JSObject()
      ret.put("value", currentTime)
      ret.put("bufferedTime", bufferedTime)

      // Note: Chapter information is intentionally NOT included here to avoid
      // the web UI using chapter-relative durations instead of total duration.
      // The web UI handles its own chapter management and expects absolute time/duration.
      // Chapter info is available separately via getChapterProgress() if needed.

      call.resolve(ret)
    }
  }

  @PluginMethod
  fun pausePlayer(call: PluginCall) {
    Handler(Looper.getMainLooper()).post {
      playerNotificationService.pause()
      call.resolve()
    }
  }

  @PluginMethod
  fun playPlayer(call: PluginCall) {
    Handler(Looper.getMainLooper()).post {
      Log.d(tag, "playPlayer: Called - checking player state...")

      if (!isPlayerServiceReady()) {
        Log.e(tag, "playPlayer: PlayerNotificationService not initialized yet")
        call.resolve(JSObject("{\"error\":\"Player service not ready\"}"))
        return@post
      }

      Log.d(tag, "playPlayer: PlayerNotificationService is ready")
      Log.d(tag, "playPlayer: Current playback session: ${playerNotificationService.currentPlaybackSession?.displayTitle ?: "null"}")
      Log.d(tag, "playPlayer: Current media item count: ${playerNotificationService.currentPlayer.mediaItemCount}")

      // Check if we have a valid playback session
      if (playerNotificationService.currentPlaybackSession == null) {
        Log.e(tag, "playPlayer: No playback session available")

        // Try to check if there's a last session we can resume
        val lastSession = DeviceManager.deviceData.lastPlaybackSession
        if (lastSession != null) {
          Log.w(tag, "playPlayer: Found last session '${lastSession.displayTitle}', but playback session is null")
          Log.w(tag, "playPlayer: This suggests prepareLibraryItem was not called or failed")
          // TODO: We could attempt to auto-prepare here, but we need the libraryItemId
        } else {
          Log.w(tag, "playPlayer: No last session available either")
        }

        call.resolve(JSObject("{\"error\":\"No playback session. Call prepareLibraryItem first.\"}"))
        return@post
      }

      // Check if we have media items loaded
      if (playerNotificationService.currentPlayer.mediaItemCount == 0) {
        Log.e(tag, "playPlayer: No media items loaded in player")
        Log.w(tag, "playPlayer: Session exists but no media items - this indicates preparePlayer was not called")
        Log.w(tag, "playPlayer: Session: ${playerNotificationService.currentPlaybackSession?.displayTitle}")
        Log.w(tag, "playPlayer: Session ID: ${playerNotificationService.currentPlaybackSession?.mediaItemId}")

        // DEFENSIVE FIX: Try to automatically prepare the current session
        val currentSession = playerNotificationService.currentPlaybackSession
        if (currentSession != null) {
          Log.i(tag, "playPlayer: Attempting automatic preparation of current session")
          try {
            // Get current playback speed from MediaManager
            val currentPlaybackSpeed = playerNotificationService.mediaManager.getSavedPlaybackRate()

            // Prepare the player with playWhenReady=true since user wants to play
            playerNotificationService.preparePlayer(currentSession, true, currentPlaybackSpeed)

            // Resolve immediately - the preparation will handle starting playback
            Log.i(tag, "playPlayer: Automatic preparation initiated for session: ${currentSession.displayTitle}")
            call.resolve()
            return@post
          } catch (e: Exception) {
            Log.e(tag, "playPlayer: Automatic preparation failed: ${e.message}")
            call.resolve(JSObject("{\"error\":\"Failed to prepare media items: ${e.message}\"}"))
            return@post
          }
        }

        // If no current session or preparation failed, return error
        call.resolve(JSObject("{\"error\":\"No media items loaded in player. Session exists but not prepared.\"}"))
        return@post
      }

      Log.d(tag, "playPlayer: All checks passed - starting playback for session: ${playerNotificationService.currentPlaybackSession?.displayTitle}")
      Log.d(tag, "playPlayer: Media items loaded: ${playerNotificationService.currentPlayer.mediaItemCount}")
      playerNotificationService.play()
      call.resolve()
    }
  }

  @PluginMethod
  fun playPause(call: PluginCall) {
    Handler(Looper.getMainLooper()).post {
      if (!isPlayerServiceReady()) {
        Log.e(tag, "playPause: PlayerNotificationService not initialized yet")
        call.resolve(JSObject("{\"error\":\"Player service not ready\"}"))
        return@post
      }
      val playing = playerNotificationService.playPause()
      call.resolve(JSObject("{\"playing\":$playing}"))
    }
  }

  @PluginMethod
  fun seek(call: PluginCall) {
    val time:Int = call.getInt("value", 0) ?: 0 // Value in seconds
    Log.d(tag, "seek action to $time")
    Handler(Looper.getMainLooper()).post {
      if (!isPlayerServiceReady()) {
        Log.e(tag, "seek: PlayerNotificationService not initialized yet")
        call.resolve(JSObject("{\"error\":\"Player service not ready\"}"))
        return@post
      }
      playerNotificationService.seekPlayer(time * 1000L) // convert to ms
      call.resolve()
    }
  }

  @PluginMethod
  fun seekForward(call: PluginCall) {
    val amount:Int = call.getInt("value", 0) ?: 0
    Handler(Looper.getMainLooper()).post {
      playerNotificationService.seekForward(amount * 1000L) // convert to ms
      call.resolve()
    }
  }

  @PluginMethod
  fun seekBackward(call: PluginCall) {
    val amount:Int = call.getInt("value", 0) ?: 0 // Value in seconds
    Handler(Looper.getMainLooper()).post {
      playerNotificationService.seekBackward(amount * 1000L) // convert to ms
      call.resolve()
    }
  }

  @PluginMethod
  fun setPlaybackSpeed(call: PluginCall) {
    val playbackSpeed:Float = call.getFloat("value", 1.0f) ?: 1.0f

    Handler(Looper.getMainLooper()).post {
      playerNotificationService.setPlaybackSpeed(playbackSpeed)
      call.resolve()
    }
  }

  @PluginMethod
  fun closePlayback(call: PluginCall) {
    Handler(Looper.getMainLooper()).post {
      playerNotificationService.closePlayback()
      call.resolve()
    }
  }

  @PluginMethod
  fun setSleepTimer(call: PluginCall) {
    val time:Long = call.getString("time", "360000")!!.toLong()
    val isChapterTime:Boolean = call.getBoolean("isChapterTime", false) == true

    Handler(Looper.getMainLooper()).post {
        val playbackSession: PlaybackSession? = playerNotificationService.mediaProgressSyncer.currentPlaybackSession ?: playerNotificationService.currentPlaybackSession
        val success:Boolean = playerNotificationService.sleepTimerManager.setManualSleepTimer(playbackSession?.id ?: "", time, isChapterTime)
        val ret = JSObject()
        ret.put("success", success)
        call.resolve(ret)
    }
  }

  @PluginMethod
  fun getSleepTimerTime(call: PluginCall) {
    val time = playerNotificationService.sleepTimerManager.getSleepTimerTime()
    val ret = JSObject()
    ret.put("value", time)
    call.resolve(ret)
  }

  @PluginMethod
  fun increaseSleepTime(call: PluginCall) {
    val time:Long = call.getString("time", "300000")!!.toLong()

    Handler(Looper.getMainLooper()).post {
      playerNotificationService.sleepTimerManager.increaseSleepTime(time)
      val ret = JSObject()
      ret.put("success", true)
      call.resolve()
    }
  }

  @PluginMethod
  fun decreaseSleepTime(call: PluginCall) {
    val time:Long = call.getString("time", "300000")!!.toLong()

    Handler(Looper.getMainLooper()).post {
      playerNotificationService.sleepTimerManager.decreaseSleepTime(time)
      val ret = JSObject()
      ret.put("success", true)
      call.resolve()
    }
  }

  @PluginMethod
  fun cancelSleepTimer(call: PluginCall) {
    Handler(Looper.getMainLooper()).post {
      playerNotificationService.sleepTimerManager.cancelSleepTimer()
    }
    call.resolve()
  }

  @PluginMethod
  fun requestSession(call: PluginCall) {
    // Need to make sure the player service has been started
    Log.d(tag, "CAST REQUEST SESSION PLUGIN")
    call.resolve()
    if (castManager == null) {
      Log.e(tag, "Cast Manager not initialized")
      return
    }
    castManager?.requestSession(playerNotificationService, object : CastManager.RequestSessionCallback() {
      override fun onError(errorCode: Int) {
        Log.e(tag, "CAST REQUEST SESSION CALLBACK ERROR $errorCode")
      }

      override fun onCancel() {
        Log.d(tag, "CAST REQUEST SESSION ON CANCEL")
      }

      override fun onJoin(jsonSession: JSONObject?) {
        Log.d(tag, "CAST REQUEST SESSION ON JOIN")
      }
    })
  }

  @PluginMethod
  fun getIsCastAvailable(call: PluginCall) {
    val jsobj = JSObject()
    jsobj.put("value", isCastAvailable)
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
            val savedPlaybackSpeed = playerNotificationService.mediaManager.getSavedPlaybackRate()
            // Determine if we should start playing based on Android Auto mode
            val shouldStartPlaying = playerNotificationService.isAndroidAuto
            playerNotificationService.preparePlayer(lastPlaybackSession, shouldStartPlaying, savedPlaybackSpeed)
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
      playerNotificationService.navigateToChapter(chapterIndex)
      call.resolve()
    }
  }

  @PluginMethod
  fun skipToNextChapter(call: PluginCall) {
    Handler(Looper.getMainLooper()).post {
      playerNotificationService.seekToNextChapter()
      call.resolve()
    }
  }

  @PluginMethod
  fun skipToPreviousChapter(call: PluginCall) {
    Handler(Looper.getMainLooper()).post {
      playerNotificationService.seekToPreviousChapter()
      call.resolve()
    }
  }

  @PluginMethod
  fun getCurrentNavigationIndex(call: PluginCall) {
    Handler(Looper.getMainLooper()).post {
      val currentIndex = playerNotificationService.getCurrentNavigationIndex()
      val ret = JSObject()
      ret.put("index", currentIndex)
      call.resolve(ret)
    }
  }

  @PluginMethod
  fun getNavigationItemCount(call: PluginCall) {
    Handler(Looper.getMainLooper()).post {
      val count = playerNotificationService.getNavigationItemCount()
      val ret = JSObject()
      ret.put("count", count)
      call.resolve(ret)
    }
  }

    @PluginMethod
    fun setChapterTrack(call: PluginCall) {
        val enabled = call.getBoolean("enabled") ?: false
        Log.d(tag, "setChapterTrack: enabled=$enabled")

        Handler(Looper.getMainLooper()).post {
            if (::playerNotificationService.isInitialized) {
                playerNotificationService.setUseChapterTrack(enabled)
                call.resolve()
            } else {
                call.reject("Player service not ready")
            }
        }
    }

    @PluginMethod
    fun seekInChapter(call: PluginCall) {
        val position: Double = call.getDouble("position") ?: 0.0 // Position in seconds within current chapter
        Log.d(tag, "seekInChapter action to $position seconds within current chapter")

        Handler(Looper.getMainLooper()).post {
            if (::playerNotificationService.isInitialized) {
                val playbackSession = playerNotificationService.getCurrentPlaybackSessionCopy()
                if (playbackSession != null && playbackSession.chapters.isNotEmpty()) {
                    // Calculate chapter boundaries using raw player data
                    val currentTimeMs = playerNotificationService.getCurrentTime()
                    val currentChapter = playbackSession.getChapterForTime(currentTimeMs)

                    if (currentChapter != null) {
                        // Convert chapter-relative position to absolute position
                        val positionMs = (position * 1000).toLong()
                        val absolutePositionMs = currentChapter.startMs + positionMs
                        // Ensure we don't seek beyond the chapter end
                        val clampedPositionMs = absolutePositionMs.coerceAtMost(currentChapter.endMs - 1)

                        Log.d(tag, "seekInChapter: Chapter-relative ${positionMs}ms -> absolute ${clampedPositionMs}ms in chapter '${currentChapter.title}'")
                        playerNotificationService.seekPlayer(clampedPositionMs)
                        call.resolve()
                    } else {
                        Log.w(tag, "seekInChapter: No current chapter found, falling back to regular seek")
                        // Fallback to regular seek
                        val currentTime = playerNotificationService.getCurrentTimeSeconds()
                        playerNotificationService.seekPlayer(((currentTime + position) * 1000).toLong())
                        call.resolve()
                    }
                } else {
                    Log.d(tag, "seekInChapter: No chapters available, falling back to regular seek")
                    // Fallback to regular seek
                    val currentTime = playerNotificationService.getCurrentTimeSeconds()
                    playerNotificationService.seekPlayer(((currentTime + position) * 1000).toLong())
                    call.resolve()
                }
            } else {
                call.reject("Player service not ready")
            }
        }
    }

    @PluginMethod
    fun getChapterInfo(call: PluginCall) {
        Handler(Looper.getMainLooper()).post {
            if (::playerNotificationService.isInitialized) {
                val playbackSession = playerNotificationService.getCurrentPlaybackSessionCopy()
                if (playbackSession != null && playbackSession.chapters.isNotEmpty()) {
                    // Calculate chapter info using raw player data and session chapters
                    val currentTimeMs = playerNotificationService.getCurrentTime()
                    val currentChapter = playbackSession.getChapterForTime(currentTimeMs)

                    val ret = JSObject()
                    ret.put("hasChapters", true)

                    if (currentChapter != null) {
                        val chapterIndex = playbackSession.chapters.indexOf(currentChapter)
                        val chapterPositionMs = currentTimeMs - currentChapter.startMs
                        val chapterDurationMs = currentChapter.endMs - currentChapter.startMs
                        val totalDurationMs = playbackSession.totalDurationMs

                        ret.put("currentChapterIndex", chapterIndex)
                        ret.put("currentChapterTitle", currentChapter.title ?: "Untitled Chapter")
                        ret.put("chapterPosition", chapterPositionMs / 1000.0) // Chapter-relative position in seconds
                        ret.put("chapterDuration", chapterDurationMs / 1000.0) // Chapter duration in seconds
                        ret.put("chapterProgress", if (chapterDurationMs > 0) chapterPositionMs.toFloat() / chapterDurationMs else 0f)
                        ret.put("totalProgress", if (totalDurationMs > 0) currentTimeMs.toFloat() / totalDurationMs else 0f)
                    }

                    // Include all chapters information from session data
                    val chaptersArray = playbackSession.chapters.map { chapter ->
                        val chapterObj = JSObject()
                        chapterObj.put("title", chapter.title ?: "Untitled Chapter")
                        chapterObj.put("start", chapter.start)
                        chapterObj.put("end", chapter.end)
                        chapterObj.put("startMs", chapter.startMs)
                        chapterObj.put("endMs", chapter.endMs)
                        chapterObj
                    }
                    ret.put("chapters", jacksonMapper.writeValueAsString(chaptersArray))

                    call.resolve(ret)
                } else {
                    val ret = JSObject()
                    ret.put("hasChapters", false)
                    call.resolve(ret)
                }
            } else {
                call.reject("Player service not ready")
            }
        }
    }

    @PluginMethod
    fun userMediaProgressUpdate(call: PluginCall) {
        val data = call.data
        val libraryItemId = data.getString("libraryItemId")
        val episodeId = data.getString("episodeId")

        // Rate limiting to prevent overwhelming the player with too frequent updates
        val currentTimeMillis = System.currentTimeMillis()
        if (currentTimeMillis - lastSocketUpdateTime < SOCKET_UPDATE_MIN_INTERVAL) {
            AbsLogger.info("AbsAudioPlayer", "userMediaProgressUpdate: Rate limiting socket update (too frequent)")
            call.resolve()
            return
        }
        lastSocketUpdateTime = currentTimeMillis

        val localLibraryItemId = playerNotificationService.currentPlaybackSession?.libraryItemId
        val localEpisodeId = playerNotificationService.currentPlaybackSession?.episodeId

        // Debug logging to understand the values
        AbsLogger.info("AbsAudioPlayer", "userMediaProgressUpdate: Received socket update - libraryItemId=$libraryItemId, episodeId=$episodeId")
        AbsLogger.info("AbsAudioPlayer", "userMediaProgressUpdate: Current session - localLibraryItemId=$localLibraryItemId, localEpisodeId=$localEpisodeId")
        AbsLogger.info("AbsAudioPlayer", "userMediaProgressUpdate: Current playback session exists: ${playerNotificationService.currentPlaybackSession != null}")

        // If there's no current playback session, we can't determine if this is for the currently playing item
        if (playerNotificationService.currentPlaybackSession == null) {
            AbsLogger.info("AbsAudioPlayer", "userMediaProgressUpdate: No current playback session, processing update")
            // Continue with the update
        }

        // Ignore socket updates for the currently playing item
        // Check if this is the same item we're currently playing
        val isCurrentlyPlayingItem = (libraryItemId == localLibraryItemId) &&
                                    (episodeId == localEpisodeId ||
                                     (episodeId.isNullOrEmpty() && localEpisodeId.isNullOrEmpty()) ||
                                     (episodeId == "" && localEpisodeId.isNullOrEmpty()) ||
                                     (localEpisodeId == "" && episodeId.isNullOrEmpty()))

        // Also check if the player is currently playing - if so, we should be more conservative about updates
        val isPlayerCurrentlyPlaying = playerNotificationService.currentPlayer.isPlaying

        // If this is the currently selected item, we should be very conservative about updates
        // This prevents interrupting active playback with socket updates
        if (isCurrentlyPlayingItem) {
            if (isPlayerCurrentlyPlaying) {
                AbsLogger.info("AbsAudioPlayer", "userMediaProgressUpdate: Ignoring socket progress update for actively playing item")
                call.resolve()
                return
            } else {
                AbsLogger.info("AbsAudioPlayer", "userMediaProgressUpdate: Current item is paused, allowing conservative progress update")
                // For paused items, we might still want to update progress, but let's be careful
            }
        }

        // For non-currently-playing items, we can be more aggressive with updates
        if (!isCurrentlyPlayingItem) {
            AbsLogger.info("AbsAudioPlayer", "userMediaProgressUpdate: Processing update for different item (not currently playing)")
        }

        val lastUpdate = data.getLong("lastUpdate")
        val currentTime = data.getDouble("currentTime")
        val duration = data.getDouble("duration")
        val isPlaying = data.getBoolean("isPlaying", false)
        val isBuffering = data.getBoolean("isBuffering", false)
        val ebookProgress = data.getDouble("ebookProgress")

        // Get local media progress
        val mediaItemId = if (episodeId != null) "$libraryItemId-$episodeId" else libraryItemId ?: ""
        val localMediaProgress = DeviceManager.dbManager.getLocalMediaProgress(mediaItemId)
        if (localMediaProgress != null) {
            // Convert timestamps to the same timezone for accurate comparison
            val serverLastUpdateMs = lastUpdate
            val localLastUpdateMs = localMediaProgress.lastUpdate

            // Convert currentTime to milliseconds for comparison
            val serverCurrentTimeMs = (currentTime * 1000).toLong()
            val localCurrentTimeMs = (localMediaProgress.currentTime * 1000).toLong()

            Log.d("AbsAudioPlayer", "userMediaProgressUpdate: Comparing server vs local progress")
            Log.d("AbsAudioPlayer", "userMediaProgressUpdate: Server - time: ${currentTime}s (${serverCurrentTimeMs}ms), lastUpdate: $serverLastUpdateMs")
            Log.d("AbsAudioPlayer", "userMediaProgressUpdate: Local  - time: ${localMediaProgress.currentTime}s (${localCurrentTimeMs}ms), lastUpdate: $localLastUpdateMs")

            // Only update if server timestamp is newer AND server progress is significantly ahead
            if (serverLastUpdateMs > localLastUpdateMs) {
                val timeDiffMs = serverCurrentTimeMs - localCurrentTimeMs
                val oneMinuteMs = 60 * 1000L // 1 minute in milliseconds

                Log.d("AbsAudioPlayer", "userMediaProgressUpdate: Server timestamp is newer. Progress difference: ${timeDiffMs}ms (${timeDiffMs/1000.0}s)")

                if (timeDiffMs > oneMinuteMs) {
                    AbsLogger.info("AbsAudioPlayer", "userMediaProgressUpdate: Syncing progress from server for \"$libraryItemId\" | server: ${currentTime}s vs local: ${localMediaProgress.currentTime}s (diff: ${timeDiffMs/1000.0}s)")

                    // Update local media progress with server data
                    localMediaProgress.currentTime = currentTime
                    localMediaProgress.duration = duration
                    localMediaProgress.ebookProgress = ebookProgress
                    localMediaProgress.lastUpdate = serverLastUpdateMs
                    DeviceManager.dbManager.saveLocalMediaProgress(localMediaProgress)
                } else {
                    AbsLogger.info("AbsAudioPlayer", "userMediaProgressUpdate: Server progress difference (${timeDiffMs/1000.0}s) is less than 1 minute threshold, keeping local progress")
                }
            } else {
                AbsLogger.info("AbsAudioPlayer", "userMediaProgressUpdate: Local timestamp is newer or equal, keeping local progress | server lastUpdate=$serverLastUpdateMs <= local lastUpdate=$localLastUpdateMs")
            }
        }
        call.resolve()
    }
}
