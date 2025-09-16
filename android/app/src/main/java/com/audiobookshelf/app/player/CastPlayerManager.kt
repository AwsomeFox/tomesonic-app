package com.audiobookshelf.app.player

import android.util.Log
import com.google.android.exoplayer2.ext.cast.CastPlayer
import com.google.android.exoplayer2.ui.PlayerNotificationManager
import com.google.android.gms.cast.framework.CastContext
import com.audiobookshelf.app.data.PlaybackSession

/**
 * Manages CastPlayer functionality and switching between cast and local players
 */
class CastPlayerManager(
    private val service: PlayerNotificationService
) {
    companion object {
        private const val TAG = "CastPlayerManager"
        const val PLAYER_CAST = "cast-player"
        const val PLAYER_EXO = "exo-player"
    }

    var castPlayer: CastPlayer? = null
    var isSwitchingPlayer = false // Used when switching between cast player and exoplayer

    /**
     * Initializes the cast player with CastContext
     */
    fun initializeCastPlayer(castContext: CastContext) {
        castPlayer = CastPlayer(castContext)
        Log.d(TAG, "Cast player initialized")
    }

    /**
     * Switches between cast player and ExoPlayer
     */
    fun switchToPlayer(
        useCastPlayer: Boolean,
        currentPlayer: com.google.android.exoplayer2.Player,
        mPlayer: com.google.android.exoplayer2.Player,
        playerNotificationManager: PlayerNotificationManager?,
        currentPlaybackSession: PlaybackSession?,
        mediaProgressSyncer: Any, // TODO: Define proper type
        preparePlayerCallback: (PlaybackSession, Boolean, Float?) -> Unit,
        onMediaPlayerChangedCallback: (String) -> Unit,
        onPlayingUpdateCallback: (Boolean) -> Unit
    ): com.google.android.exoplayer2.Player {

        val wasPlaying = currentPlayer.isPlaying

        if (useCastPlayer) {
            if (currentPlayer == castPlayer) {
                Log.d(TAG, "switchToPlayer: Already using Cast Player ${castPlayer?.deviceInfo}")
                return currentPlayer
            } else {
                Log.d(TAG, "switchToPlayer: Switching to cast player from exo player stop exo player")
                mPlayer.stop()
            }
        } else {
            if (currentPlayer == mPlayer) {
                Log.d(TAG, "switchToPlayer: Already using Exo Player ${mPlayer.deviceInfo}")
                return currentPlayer
            } else if (castPlayer != null) {
                Log.d(TAG, "switchToPlayer: Switching to exo player from cast player stop cast player")
                castPlayer?.stop()
            }
        }

        if (currentPlaybackSession == null) {
            Log.e(TAG, "switchToPlayer: No Current playback session")
        } else {
            isSwitchingPlayer = true
        }

        // TODO: Handle mediaProgressSyncer session copying
        // This needs to be handled in the calling service

        val newCurrentPlayer = if (useCastPlayer) {
            Log.d(TAG, "switchToPlayer: Using Cast Player ${castPlayer?.deviceInfo}")
            // Media3 MediaSession will handle player switching automatically
            playerNotificationManager?.setPlayer(castPlayer)
            castPlayer as CastPlayer
        } else {
            Log.d(TAG, "switchToPlayer: Using ExoPlayer")
            // Media3 MediaSession will handle player switching automatically
            playerNotificationManager?.setPlayer(mPlayer)
            mPlayer
        }

        onMediaPlayerChangedCallback(getMediaPlayer(newCurrentPlayer))

        currentPlaybackSession?.let { session ->
            Log.d(TAG, "switchToPlayer: Starting new playback session ${session.displayTitle}")
            if (wasPlaying) { // media is paused when switching players
                onPlayingUpdateCallback(false)
            }

            // TODO: Start a new playback session here instead of using the existing
            preparePlayerCallback(session, false, null)
        }

        return newCurrentPlayer
    }

    /**
     * Gets the current media player type
     */
    fun getMediaPlayer(currentPlayer: com.google.android.exoplayer2.Player): String {
        return if (currentPlayer == castPlayer) PLAYER_CAST else PLAYER_EXO
    }

    /**
     * Checks if cast player can handle the playback session (no local media)
     */
    fun canUseCastPlayer(playbackSession: PlaybackSession): Boolean {
        return !(playbackSession.mediaPlayer == PLAYER_CAST && playbackSession.isLocal)
    }

    /**
     * Sets up cast player for playback session
     */
    fun setupCastPlayer(
        playbackSession: PlaybackSession,
        playerNotificationManager: PlayerNotificationManager
    ) {
        if (playbackSession.mediaPlayer == PLAYER_CAST) {
            // Media3 MediaSession will handle player assignment automatically
            playerNotificationManager.setPlayer(castPlayer)
        }
    }

    /**
     * Loads media into cast player - implementation to be completed based on CastPlayer API
     */
    fun loadCastPlayer(
        mediaItems: List<com.google.android.exoplayer2.MediaItem>,
        currentTrackIndex: Int,
        currentTrackTime: Long,
        playWhenReady: Boolean,
        playbackRate: Float,
        mediaType: String
    ) {
        Log.d(TAG, "Loading cast player $currentTrackIndex $currentTrackTime $mediaType")

        // TODO: Implement proper CastPlayer loading based on API
        // The exact method signature needs to be verified
        // castPlayer?.load(mediaItems, currentTrackIndex, currentTrackTime, playWhenReady, playbackRate, mediaType)
    }

    /**
     * Releases cast player resources
     */
    fun release() {
        castPlayer?.release()
        Log.d(TAG, "Cast player released")
    }
}
