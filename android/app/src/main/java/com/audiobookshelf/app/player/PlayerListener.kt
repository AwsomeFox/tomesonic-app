package com.audiobookshelf.app.player

import android.util.Log
import com.audiobookshelf.app.data.PlaybackSession
import com.audiobookshelf.app.data.PlayerState
import com.audiobookshelf.app.device.DeviceManager
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player

//const val PAUSE_LEN_BEFORE_RECHECK = 30000 // 30 seconds

class PlayerListener(var playerNotificationService:PlayerNotificationService) : Player.Listener {
  var tag = "PlayerListener"

  companion object {
    var lastPauseTime: Long = 0   //ms
    var lazyIsPlaying: Boolean = false
  }

  override fun onPlayerError(error: PlaybackException) {
    val errorMessage = error.message ?: "Unknown Error"
    Log.e(tag, "onPlayerError $errorMessage")
    playerNotificationService.handlePlayerPlaybackError(errorMessage) // If was direct playing session, fallback to transcode
  }

  override fun onPositionDiscontinuity(
    oldPosition: Player.PositionInfo,
    newPosition: Player.PositionInfo,
    reason: Int
  ) {
    // Reset track transition flag on any position discontinuity
    if (playerNotificationService.expectingTrackTransition) {
      Log.d(tag, "onPositionDiscontinuity: Resetting expectingTrackTransition flag")
      playerNotificationService.expectingTrackTransition = false
    }

    if (reason == Player.DISCONTINUITY_REASON_SEEK) {
      // If playing set seeking flag
      Log.d(tag, "onPositionDiscontinuity: oldPosition=${oldPosition.positionMs}/${oldPosition.mediaItemIndex}, newPosition=${newPosition.positionMs}/${newPosition.mediaItemIndex}, isPlaying=${playerNotificationService.currentPlayer.isPlaying} reason=SEEK")
      playerNotificationService.mediaProgressSyncer.seek()
      lastPauseTime = 0 // When seeking while paused reset the auto-rewind
    } else {
      Log.d(tag, "onPositionDiscontinuity: oldPosition=${oldPosition.positionMs}/${oldPosition.mediaItemIndex}, newPosition=${newPosition.positionMs}/${newPosition.mediaItemIndex}, isPlaying=${playerNotificationService.currentPlayer.isPlaying}, reason=$reason")
    }
  }

  override fun onIsPlayingChanged(isPlaying: Boolean) {
    Log.d(tag, "onIsPlayingChanged to $isPlaying | ${playerNotificationService.getMediaPlayer()} | playbackState=${playerNotificationService.currentPlayer.playbackState}")

    val player = playerNotificationService.currentPlayer

    // ENHANCED DEBUG: Log detailed state information
    Log.d(tag, "DETAILED_STATE: isPlaying=$isPlaying, playWhenReady=${player.playWhenReady}, playbackState=${player.playbackState}")
    Log.d(tag, "DETAILED_STATE: mediaItemCount=${player.mediaItemCount}, currentIndex=${player.currentMediaItemIndex}")
    Log.d(tag, "DETAILED_STATE: isLoading=${player.isLoading}, duration=${player.duration}, position=${player.currentPosition}")

    // Check for state inconsistencies that might indicate audio focus issues
    if (!isPlaying && player.playWhenReady && player.playbackState == Player.STATE_READY) {
      Log.w(tag, "POTENTIAL_ISSUE: playWhenReady=true, STATE_READY, but isPlaying=false - possible audio focus issue")
    }

    if (isPlaying && !player.playWhenReady) {
      Log.w(tag, "POTENTIAL_ISSUE: isPlaying=true but playWhenReady=false - inconsistent state")
    }

    // Goal of these 2 if statements and the lazyIsPlaying is to ignore this event when it is triggered by a seek
    //  When a seek occurs the player is paused and buffering, then plays again right afterwards.
    if (!isPlaying && player.playbackState == Player.STATE_BUFFERING) {
      Log.d(tag, "onIsPlayingChanged: Pause event when buffering is ignored")
      return
    }
    if (lazyIsPlaying == isPlaying) {
      Log.d(tag, "onIsPlayingChanged: Lazy is playing $lazyIsPlaying is already set to this so ignoring")
      return
    }

    lazyIsPlaying = isPlaying

    // Update widget
    DeviceManager.widgetUpdater?.onPlayerChanged(playerNotificationService)

    if (isPlaying) {
      Log.d(tag, "SeekBackTime: Player is playing")
      Log.d(tag, "SeekBackTime: isAndroidAuto=${playerNotificationService.isAndroidAuto}")
      Log.d(tag, "SeekBackTime: lastPauseTime=$lastPauseTime")
      Log.d(tag, "SeekBackTime: disableAutoRewind=${DeviceManager.deviceData.deviceSettings?.disableAutoRewind}")

      // Skip auto-rewind when Android Auto is connected to prevent unexpected position jumps
      if (playerNotificationService.isAndroidAuto) {
        Log.d(tag, "SeekBackTime: Android Auto detected, skipping auto-rewind")
      } else if (lastPauseTime > 0 && DeviceManager.deviceData.deviceSettings?.disableAutoRewind != true) {
        Log.d(tag, "SeekBackTime: playing started, checking if auto-rewind needed")

        // Only auto-rewind if paused for more than 10 seconds to avoid unnecessary seeks
        val pauseDuration = System.currentTimeMillis() - lastPauseTime
        if (pauseDuration > 10000) { // 10 seconds
          // Use the standard jump backward time configured by the user (default 10 seconds)
          val jumpBackwardTimeMs = DeviceManager.deviceData.deviceSettings?.jumpBackwardsTimeMs ?: 10000L
          Log.d(tag, "SeekBackTime: Paused for ${pauseDuration}ms, auto-rewinding by ${jumpBackwardTimeMs}ms")

          // Use the same seekBackward method that manual navigation uses
          playerNotificationService.seekBackward(jumpBackwardTimeMs)
        } else {
          Log.d(tag, "SeekBackTime: Short pause (${pauseDuration}ms), skipping auto-rewind")
        }
      } else {
        if (lastPauseTime <= 0) {
          Log.d(tag, "SeekBackTime: No previous pause time, skipping auto-rewind")
        }
        if (DeviceManager.deviceData.deviceSettings?.disableAutoRewind == true) {
          Log.d(tag, "SeekBackTime: Auto-rewind disabled in settings, skipping")
        }
      }
    } else {
      Log.d(tag, "SeekBackTime: Player not playing set last pause time | playbackState=${player.playbackState}")
      lastPauseTime = System.currentTimeMillis()
    }

    // Start/stop progress sync interval
    if (isPlaying) {
      val playbackSession: PlaybackSession? = playerNotificationService.mediaProgressSyncer.currentPlaybackSession ?: playerNotificationService.currentPlaybackSession
      playbackSession?.let {
        // Handles auto-starting sleep timer and resetting sleep timer
        playerNotificationService.sleepTimerManager.handleMediaPlayEvent(it.id)

        player.volume = 1F // Volume on sleep timer might have decreased this

        playerNotificationService.mediaProgressSyncer.play(it)
      }
    } else {
      playerNotificationService.mediaProgressSyncer.pause {
        Log.d(tag, "Media Progress Syncer paused and synced")
      }
    }

    playerNotificationService.clientEventEmitter?.onPlayingUpdate(isPlaying)
  }

  override fun onEvents(player: Player, events: Player.Events) {
    Log.d(tag, "onEvents ${playerNotificationService.getMediaPlayer()} | ${events.size()}")

    if (events.contains(Player.EVENT_POSITION_DISCONTINUITY)) {
      Log.d(tag, "EVENT_POSITION_DISCONTINUITY")
    }

    if (events.contains(Player.EVENT_IS_LOADING_CHANGED)) {
      Log.d(tag, "EVENT_IS_LOADING_CHANGED : " + playerNotificationService.currentPlayer.isLoading)
    }

    if (events.contains(Player.EVENT_PLAYBACK_STATE_CHANGED)) {
      Log.d(tag, "EVENT_PLAYBACK_STATE_CHANGED MediaPlayer = ${playerNotificationService.getMediaPlayer()}")

      if (playerNotificationService.currentPlayer.playbackState == Player.STATE_READY) {
        Log.d(tag, "STATE_READY : " + playerNotificationService.currentPlayer.duration)

        // ENHANCED DEBUG: Log comprehensive state when reaching STATE_READY
        val player = playerNotificationService.currentPlayer
        Log.d(tag, "STATE_READY_DEBUG: isPlaying=${player.isPlaying}, playWhenReady=${player.playWhenReady}")
        Log.d(tag, "STATE_READY_DEBUG: mediaItemCount=${player.mediaItemCount}, currentIndex=${player.currentMediaItemIndex}")
        Log.d(tag, "STATE_READY_DEBUG: duration=${player.duration}, position=${player.currentPosition}")
        Log.d(tag, "STATE_READY_DEBUG: isLoading=${player.isLoading}, volume=${player.volume}")

        // Check if this is the auto-start scenario
        if (player.playWhenReady && !player.isPlaying) {
          Log.w(tag, "STATE_READY_ISSUE: playWhenReady=true but isPlaying=false - auto-start failed!")
          Log.w(tag, "STATE_READY_ISSUE: This suggests audio focus loss, device audio routing issues, or ExoPlayer bug")

          // Try calling play() explicitly as a workaround
          Log.d(tag, "STATE_READY_WORKAROUND: Attempting explicit play() call")
          try {
            player.play()
            Log.d(tag, "STATE_READY_WORKAROUND: play() called - isPlaying now: ${player.isPlaying}")
          } catch (e: Exception) {
            Log.e(tag, "STATE_READY_WORKAROUND: Exception calling play(): ${e.message}")
          }
        } else if (player.playWhenReady && player.isPlaying) {
          Log.d(tag, "STATE_READY_SUCCESS: Auto-start working correctly!")
        }

        if (lastPauseTime == 0L) {
          lastPauseTime = -1
        }
        playerNotificationService.sendClientMetadata(PlayerState.READY)
      }
      if (playerNotificationService.currentPlayer.playbackState == Player.STATE_BUFFERING) {
        Log.d(tag, "STATE_BUFFERING : " + playerNotificationService.currentPlayer.currentPosition)
        playerNotificationService.sendClientMetadata(PlayerState.BUFFERING)
      }
      if (playerNotificationService.currentPlayer.playbackState == Player.STATE_ENDED) {
        Log.d(tag, "STATE_ENDED")

        // Check if we have a valid playback session
        // If not, this might be Android Auto trying to play on an empty player
        if (playerNotificationService.currentPlaybackSession != null) {
          Log.d(tag, "STATE_ENDED with valid session - handling playback completion")
          playerNotificationService.sendClientMetadata(PlayerState.ENDED)
          playerNotificationService.handlePlaybackEnded()
        } else {
          Log.d(tag, "STATE_ENDED with no session - likely empty player, ignoring")
        }
      }
      if (playerNotificationService.currentPlayer.playbackState == Player.STATE_IDLE) {
        Log.d(tag, "STATE_IDLE")
        playerNotificationService.sendClientMetadata(PlayerState.IDLE)
      }
    }

    if (events.contains(Player.EVENT_MEDIA_METADATA_CHANGED)) {
      Log.d(tag, "EVENT_MEDIA_METADATA_CHANGED ${playerNotificationService.getMediaPlayer()}")
    }
    if (events.contains(Player.EVENT_PLAYLIST_METADATA_CHANGED)) {
      Log.d(tag, "EVENT_PLAYLIST_METADATA_CHANGED ${playerNotificationService.getMediaPlayer()}")
    }
  }

}
