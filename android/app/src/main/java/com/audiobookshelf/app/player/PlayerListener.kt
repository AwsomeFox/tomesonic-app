package com.audiobookshelf.app.player

import android.util.Log
import com.audiobookshelf.app.data.PlaybackSession
import com.audiobookshelf.app.data.PlayerState
import com.audiobookshelf.app.device.DeviceManager
// Media3 imports
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player

//const val PAUSE_LEN_BEFORE_RECHECK = 30000 // 30 seconds

/**
 * Media3 Player.Listener implementation
 */
class PlayerListener(var audiobookMediaService: com.audiobookshelf.app.player.service.AudiobookMediaService) : Player.Listener {
  var tag = "PlayerListener"

  companion object {
    var lastPauseTime: Long = 0   //ms
    var lazyIsPlaying: Boolean = false
  }

  override fun onPlayerError(error: PlaybackException) {
    val errorMessage = error.message ?: "Unknown Error"
    Log.e(tag, "onPlayerError $errorMessage")
    audiobookMediaService.handlePlayerPlaybackError(errorMessage) // If was direct playing session, fallback to transcode
  }

  override fun onPositionDiscontinuity(
    oldPosition: Player.PositionInfo,
    newPosition: Player.PositionInfo,
    reason: Int
  ) {
    if (reason == Player.DISCONTINUITY_REASON_SEEK) {
      // If playing set seeking flag
      Log.d(tag, "onPositionDiscontinuity: oldPosition=${oldPosition.positionMs}/${oldPosition.mediaItemIndex}, newPosition=${newPosition.positionMs}/${newPosition.mediaItemIndex}, isPlaying=${audiobookMediaService.currentPlayer.isPlaying} reason=SEEK")
      audiobookMediaService.seek()
      lastPauseTime = 0 // When seeking while paused reset the auto-rewind
    } else {
      Log.d(tag, "onPositionDiscontinuity: oldPosition=${oldPosition.positionMs}/${oldPosition.mediaItemIndex}, newPosition=${newPosition.positionMs}/${newPosition.mediaItemIndex}, isPlaying=${audiobookMediaService.currentPlayer.isPlaying}, reason=$reason")
    }
  }

  override fun onIsPlayingChanged(isPlaying: Boolean) {
    Log.d(tag, "onIsPlayingChanged to $isPlaying | ${audiobookMediaService.getMediaPlayer()} | playbackState=${audiobookMediaService.currentPlayer.playbackState}")

    val player = audiobookMediaService.currentPlayer

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
    DeviceManager.widgetUpdater?.onPlayerChanged(audiobookMediaService)

    if (isPlaying) {
      Log.d(tag, "SeekBackTime: Player is playing")
      if (lastPauseTime > 0 && DeviceManager.deviceData.deviceSettings?.disableAutoRewind != true) {
        Log.d(tag, "SeekBackTime: playing started now set seek back time $lastPauseTime")
        var seekBackTime = calcPauseSeekBackTime()
        if (seekBackTime > 0) {
          // Current chapter is used so that seek back does not go back to the previous chapter
          val currentChapter = audiobookMediaService.getCurrentBookChapter()
          val minSeekBackTime = (currentChapter as? com.audiobookshelf.app.data.BookChapter)?.start?.toLong() ?: 0L

          val currentTime = audiobookMediaService.getCurrentTime()
          val newTime = currentTime - seekBackTime
          if (newTime < minSeekBackTime) {
            seekBackTime = currentTime - minSeekBackTime
          }
          Log.d(tag, "SeekBackTime $seekBackTime")
        }

        // TODO: this needs to be reworked so that the audio doesn't start playing before it checks for updated progress
        // Check if playback session still exists or sync media progress if updated
//        val pauseLength: Long = System.currentTimeMillis() - lastPauseTime
//        if (pauseLength > PAUSE_LEN_BEFORE_RECHECK) {
//          val shouldCarryOn = audiobookMediaService.checkCurrentSessionProgress(seekBackTime)
//          if (!shouldCarryOn) return
//        }

        if (seekBackTime > 0L) {
          audiobookMediaService.seekBackward(seekBackTime)
        }
      }
    } else {
      Log.d(tag, "SeekBackTime: Player not playing set last pause time | playbackState=${player.playbackState}")
      lastPauseTime = System.currentTimeMillis()
    }

    // Start/stop progress sync interval
    if (isPlaying) {
      val playbackSession: PlaybackSession? = audiobookMediaService.mediaProgressSyncer.currentPlaybackSession ?: audiobookMediaService.currentPlaybackSession
      playbackSession?.let {
        // Handles auto-starting sleep timer and resetting sleep timer
        audiobookMediaService.handleMediaPlayEvent(it.id)

        player.volume = 1F // Volume on sleep timer might have decreased this

        audiobookMediaService.play(it)
      }
    } else {
      audiobookMediaService.mediaProgressSyncer.pause {
        Log.d(tag, "Media Progress Syncer paused and synced")
      }
    }

    audiobookMediaService.clientEventEmitter?.onPlayingUpdate(isPlaying)
  }

  override fun onEvents(player: Player, events: Player.Events) {
    Log.d(tag, "onEvents ${audiobookMediaService.getMediaPlayer()} | ${events.size()}")

    if (events.contains(Player.EVENT_POSITION_DISCONTINUITY)) {
      Log.d(tag, "EVENT_POSITION_DISCONTINUITY")
    }

    if (events.contains(Player.EVENT_IS_LOADING_CHANGED)) {
      Log.d(tag, "EVENT_IS_LOADING_CHANGED : " + audiobookMediaService.currentPlayer.isLoading)
    }

    if (events.contains(Player.EVENT_PLAYBACK_STATE_CHANGED)) {
      Log.d(tag, "EVENT_PLAYBACK_STATE_CHANGED MediaPlayer = ${audiobookMediaService.getMediaPlayer()}")

      if (audiobookMediaService.currentPlayer.playbackState == Player.STATE_READY) {
        Log.d(tag, "STATE_READY : " + audiobookMediaService.currentPlayer.duration)

        if (lastPauseTime == 0L) {
          lastPauseTime = -1
        }
        audiobookMediaService.sendClientMetadata(PlayerState.READY)
      }
      if (audiobookMediaService.currentPlayer.playbackState == Player.STATE_BUFFERING) {
        Log.d(tag, "STATE_BUFFERING : " + audiobookMediaService.currentPlayer.currentPosition)
        audiobookMediaService.sendClientMetadata(PlayerState.BUFFERING)
      }
      if (audiobookMediaService.currentPlayer.playbackState == Player.STATE_ENDED) {
        Log.d(tag, "STATE_ENDED")
        audiobookMediaService.sendClientMetadata(PlayerState.ENDED)

        audiobookMediaService.handlePlaybackEnded()
      }
      if (audiobookMediaService.currentPlayer.playbackState == Player.STATE_IDLE) {
        Log.d(tag, "STATE_IDLE")
        audiobookMediaService.sendClientMetadata(PlayerState.IDLE)
      }
    }

    if (events.contains(Player.EVENT_MEDIA_METADATA_CHANGED)) {
      Log.d(tag, "EVENT_MEDIA_METADATA_CHANGED ${audiobookMediaService.getMediaPlayer()}")
    }
    if (events.contains(Player.EVENT_PLAYLIST_METADATA_CHANGED)) {
      Log.d(tag, "EVENT_PLAYLIST_METADATA_CHANGED ${audiobookMediaService.getMediaPlayer()}")
    }
  }

  private fun calcPauseSeekBackTime() : Long {
    if (lastPauseTime <= 0) return 0
    val time: Long = System.currentTimeMillis() - lastPauseTime
    val seekback: Long
    if (time < 10000) seekback = 0 // 10s or less = no seekback
    else if (time < 60000) seekback = 3000 // 10s to 1m = jump back 3s
    else if (time < 300000) seekback = 10000 // 1m to 5m = jump back 10s
    else if (time < 1800000) seekback = 20000 // 5m to 30m = jump back 20s
    else seekback = 29500 // 30m and up = jump back 30s
    return seekback
  }
}
