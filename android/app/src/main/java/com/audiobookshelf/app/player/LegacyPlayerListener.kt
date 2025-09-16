package com.audiobookshelf.app.player

import android.util.Log
import com.google.android.exoplayer2.PlaybackException
import com.google.android.exoplayer2.Player

/**
 * Legacy ExoPlayer2 Player.Listener wrapper for cast player during migration
 */
class LegacyPlayerListener(var playerNotificationService: PlayerNotificationService) : Player.Listener {
    var tag = "LegacyPlayerListener"

    override fun onPlayerError(error: PlaybackException) {
        val errorMessage = error.message ?: "Unknown Error"
        Log.e(tag, "onPlayerError $errorMessage")
        playerNotificationService.handlePlayerPlaybackError(errorMessage)
    }

    override fun onPositionDiscontinuity(
        oldPosition: Player.PositionInfo,
        newPosition: Player.PositionInfo,
        reason: Int
    ) {
        if (reason == Player.DISCONTINUITY_REASON_SEEK) {
            Log.d(tag, "onPositionDiscontinuity: SEEK - oldPosition=${oldPosition.positionMs}, newPosition=${newPosition.positionMs}")
            playerNotificationService.mediaProgressSyncer.seek()
            PlayerListener.lastPauseTime = 0
        } else {
            Log.d(tag, "onPositionDiscontinuity: reason=$reason - oldPosition=${oldPosition.positionMs}, newPosition=${newPosition.positionMs}")
        }
    }

    override fun onIsPlayingChanged(isPlaying: Boolean) {
        Log.d(tag, "onIsPlayingChanged to $isPlaying | Cast Player")
        // Delegate to the main PlayerListener's companion object for shared state
        PlayerListener.lazyIsPlaying = isPlaying

        if (isPlaying) {
            PlayerListener.lastPauseTime = -1
        } else {
            PlayerListener.lastPauseTime = System.currentTimeMillis()
        }

        playerNotificationService.clientEventEmitter?.onPlayingUpdate(isPlaying)
    }

    override fun onEvents(player: Player, events: Player.Events) {
        Log.d(tag, "onEvents Cast Player | ${events.size()}")

        if (events.contains(Player.EVENT_PLAYBACK_STATE_CHANGED)) {
            Log.d(tag, "EVENT_PLAYBACK_STATE_CHANGED Cast Player")

            when (player.playbackState) {
                Player.STATE_READY -> {
                    Log.d(tag, "STATE_READY : " + player.duration)
                    playerNotificationService.sendClientMetadata(com.audiobookshelf.app.data.PlayerState.READY)
                }
                Player.STATE_BUFFERING -> {
                    Log.d(tag, "STATE_BUFFERING : " + player.currentPosition)
                    playerNotificationService.sendClientMetadata(com.audiobookshelf.app.data.PlayerState.BUFFERING)
                }
                Player.STATE_ENDED -> {
                    Log.d(tag, "STATE_ENDED")
                    playerNotificationService.sendClientMetadata(com.audiobookshelf.app.data.PlayerState.ENDED)
                    playerNotificationService.handlePlaybackEnded()
                }
                Player.STATE_IDLE -> {
                    Log.d(tag, "STATE_IDLE")
                    playerNotificationService.sendClientMetadata(com.audiobookshelf.app.data.PlayerState.IDLE)
                }
            }
        }
    }
}
