package com.audiobookshelf.app.player

import android.content.Context
import android.util.Log
import com.google.android.exoplayer2.*
import com.google.android.exoplayer2.audio.AudioAttributes
import com.google.android.exoplayer2.ext.mediasession.MediaSessionConnector
import com.google.android.exoplayer2.ui.PlayerNotificationManager
import com.audiobookshelf.app.data.DeviceSettings
import com.audiobookshelf.app.data.PlaybackSession

/**
 * Manages ExoPlayer and Cast player instances and their lifecycle
 */
class PlayerManager(
    private val context: Context,
    private val deviceSettings: DeviceSettings,
    private val service: PlayerNotificationService
) {
    companion object {
        private const val TAG = "PlayerManager"
    }

    // Player instances
    lateinit var mPlayer: ExoPlayer
        private set
    lateinit var currentPlayer: Player
        private set

    // Dependencies that will be injected
    private lateinit var playerNotificationManager: PlayerNotificationManager
    private lateinit var mediaSessionConnector: MediaSessionConnector

    fun setDependencies(
        playerNotificationManager: PlayerNotificationManager,
        mediaSessionConnector: MediaSessionConnector
    ) {
        this.playerNotificationManager = playerNotificationManager
        this.mediaSessionConnector = mediaSessionConnector
    }

    fun initializeExoPlayer() {
        val customLoadControl: LoadControl =
            DefaultLoadControl.Builder()
                .setBufferDurationsMs(
                    1000 * 20, // 20s min buffer
                    1000 * 45, // 45s max buffer
                    1000 * 5,  // 5s playback start
                    1000 * 20  // 20s playback rebuffer
                )
                .build()

        mPlayer = ExoPlayer.Builder(context)
            .setLoadControl(customLoadControl)
            .setSeekBackIncrementMs(deviceSettings.jumpBackwardsTimeMs)
            .setSeekForwardIncrementMs(deviceSettings.jumpForwardTimeMs)
            .build()

        mPlayer.setHandleAudioBecomingNoisy(true)
        mPlayer.addListener(PlayerListener(service))

        val audioAttributes: AudioAttributes =
            AudioAttributes.Builder()
                .setUsage(C.USAGE_MEDIA)
                .setContentType(C.AUDIO_CONTENT_TYPE_SPEECH)
                .build()
        mPlayer.setAudioAttributes(audioAttributes, true)

        // Set as current player
        currentPlayer = mPlayer

        // Connect to notification and media session
        playerNotificationManager.setPlayer(mPlayer)
        mediaSessionConnector.setPlayer(mPlayer)

        Log.d(TAG, "ExoPlayer initialized successfully")
    }

    fun releasePlayer() {
        if (::mPlayer.isInitialized) {
            mPlayer.release()
            Log.d(TAG, "ExoPlayer released")
        }
    }

    // Basic player controls
    fun play() {
        if (currentPlayer.isPlaying) {
            Log.d(TAG, "Already playing")
            return
        }
        currentPlayer.volume = 1F
        currentPlayer.play()
    }

    fun pause() {
        currentPlayer.pause()
    }

    fun seekToPosition(time: Long) {
        var timeToSeek = time
        Log.d(TAG, "seekPlayer mediaCount = ${currentPlayer.mediaItemCount} | $timeToSeek")
        
        if (timeToSeek < 0) {
            Log.w(TAG, "seekPlayer invalid time $timeToSeek - setting to 0")
            timeToSeek = 0L
        } else if (timeToSeek > getDuration()) {
            Log.w(TAG, "seekPlayer invalid time $timeToSeek - setting to MAX - 2000")
            timeToSeek = getDuration() - 2000L
        }
        
        currentPlayer.seekTo(timeToSeek)
    }

    // Player state queries
    fun isPlaying(): Boolean = currentPlayer.isPlaying

    fun getCurrentPosition(): Long {
        return currentPlayer.currentPosition
    }

    fun getDuration(): Long {
        return currentPlayer.duration
    }

    fun getPlaybackSpeed(): Float {
        return currentPlayer.playbackParameters.speed
    }

    fun setPlaybackSpeed(speed: Float) {
        currentPlayer.setPlaybackSpeed(speed)
    }

    // Media item management
    fun getMediaItemCount(): Int = currentPlayer.mediaItemCount

    fun getCurrentMediaItemIndex(): Int = currentPlayer.currentMediaItemIndex

    fun addMediaItems(mediaItems: List<MediaItem>) {
        currentPlayer.addMediaItems(mediaItems)
    }

    fun setMediaItems(mediaItems: List<MediaItem>) {
        currentPlayer.setMediaItems(mediaItems)
    }

    fun seekToMediaItem(index: Int, position: Long = 0) {
        currentPlayer.seekTo(index, position)
    }

    fun prepare() {
        currentPlayer.prepare()
    }

    fun setPlayWhenReady(playWhenReady: Boolean) {
        currentPlayer.playWhenReady = playWhenReady
    }
}

