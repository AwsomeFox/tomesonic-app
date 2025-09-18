package com.audiobookshelf.app.player

import android.net.Uri
import android.util.Log
import androidx.media3.cast.CastPlayer
import androidx.media3.cast.SessionAvailabilityListener
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.MimeTypes
import androidx.media3.common.Player
import androidx.media3.session.MediaSession
import com.google.android.gms.cast.framework.CastContext
import com.google.android.gms.cast.framework.CastSession
import com.audiobookshelf.app.data.PlaybackSession
import com.audiobookshelf.app.device.DeviceManager
import com.audiobookshelf.app.player.mediasource.ChapterSegment

/**
 * Manages Media3 CastPlayer functionality and switching between cast and local players
 * This is the Media3 migration version that integrates with MediaLibrarySession
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

    private var castContext: CastContext? = null
    private var sessionAvailabilityListener: CastSessionAvailabilityListener? = null

    /**
     * Initializes the cast player with CastContext and custom MediaItemConverter
     * The custom converter ensures ClippingConfiguration is properly handled for cast devices
     */
    fun initializeCastPlayer(castContext: CastContext) {
        this.castContext = castContext

        // Create CastPlayer with custom MediaItemConverter for proper chapter handling
        castPlayer = CastPlayer(castContext, AudiobookMediaItemConverter())

        // Add the same PlayerListener that the ExoPlayer uses
        castPlayer?.addListener(PlayerListener(service))

        // Set up session availability listener
        sessionAvailabilityListener = CastSessionAvailabilityListener()
        castPlayer?.setSessionAvailabilityListener(sessionAvailabilityListener!!)

        Log.d(TAG, "Cast player initialized with Media3 and PlayerListener attached")
    }

    /**
     * Switches between cast player and ExoPlayer for Media3
     */
    fun switchToPlayer(useCastPlayer: Boolean): Player? {
        val currentPlayer = service.currentPlayer
        val exoPlayer = service.rawPlayer

        if (useCastPlayer) {
            if (currentPlayer == castPlayer) {
                Log.d(TAG, "switchToPlayer: Already using Cast Player")
                return currentPlayer
            } else {
                Log.d(TAG, "switchToPlayer: Switching to cast player from exo player")
                exoPlayer.stop()
                return castPlayer
            }
        } else {
            if (currentPlayer == exoPlayer) {
                Log.d(TAG, "switchToPlayer: Already using Exo Player")
                return currentPlayer
            } else if (castPlayer != null) {
                Log.d(TAG, "switchToPlayer: Switching to exo player from cast player")
                castPlayer?.stop()
                return exoPlayer
            }
        }

        return null
    }

    /**
     * Gets the current media player type
     */
    fun getMediaPlayer(currentPlayer: Player): String {
        return if (currentPlayer == castPlayer) PLAYER_CAST else PLAYER_EXO
    }

    /**
     * Checks if cast player can handle the playback session
     * Downloaded books can be cast using their server URLs
     */
    fun canUseCastPlayer(playbackSession: PlaybackSession): Boolean {
        // Cast cannot play purely local media files without server equivalents
        if (playbackSession.isLocal) {
            // Check if this local item has a server equivalent for casting
            val localLibraryItem = playbackSession.localLibraryItem
            if (localLibraryItem != null && !localLibraryItem.libraryItemId.isNullOrEmpty()) {
                // This is a downloaded book with a server ID - can be cast using server URLs
                Log.d(TAG, "Local item ${localLibraryItem.id} has server ID ${localLibraryItem.libraryItemId} - can cast")
                return true
            }
            // Purely local items without server equivalents cannot be cast
            Log.d(TAG, "Purely local item cannot be cast")
            return false
        }
        // Server items can always be cast
        return true
    }

    /**
     * Creates MediaItems for cast player using the exact same chapter segments as ExoPlayer
     * This ensures cast player has identical timeline structure and metadata as local playback
     */
    fun createCastMediaItems(playbackSession: PlaybackSession): List<MediaItem> {
        val mediaItems = mutableListOf<MediaItem>()

        // Use the exact same chapter segments as AudiobookMediaSourceBuilder to ensure consistency
        // Use forCast=true to get server URIs appropriate for cast devices
        val audiobookBuilder = service.getAudiobookMediaSourceBuilder()
        val chapterSegments = audiobookBuilder.getChapterSegments(playbackSession, forCast = true)

        Log.d(TAG, "Creating ${chapterSegments.size} MediaItems for cast using AudiobookMediaSourceBuilder segments")

        chapterSegments.forEach { segment ->
            val mediaItem = createSegmentMediaItem(playbackSession, segment)
            mediaItems.add(mediaItem)
        }

        return mediaItems
    }

    /**
     * Finds the audio track that contains the given time position
     */
    private fun findTrackContainingTime(playbackSession: PlaybackSession, timeMs: Long): com.audiobookshelf.app.data.AudioTrack? {
        return playbackSession.audioTracks.find { track ->
            val trackEndMs = track.startOffsetMs + (track.duration * 1000).toLong()
            timeMs >= track.startOffsetMs && timeMs < trackEndMs
        }
    }

    /**
     * Creates a MediaItem from a chapter segment with proper metadata and clipping
     * CastPlayer properly supports ClippingConfiguration, so we use the same approach as ExoPlayer
     * but with server URIs for cast compatibility
     */
    private fun createSegmentMediaItem(
        playbackSession: PlaybackSession,
        segment: ChapterSegment
    ): MediaItem {
        // Get the chapter object if available
        val chapter = if (segment.chapterIndex < playbackSession.chapters.size) {
            playbackSession.chapters[segment.chapterIndex]
        } else null

        // Find the corresponding audio track
        val containingTrack = findTrackContainingTime(playbackSession, segment.chapterStartMs)
            ?: playbackSession.audioTracks.first()

        // For cast, ensure we use server content URI even if the segment originally used local URI
        val castUri = playbackSession.getServerContentUri(containingTrack)

        val mediaItemBuilder = MediaItem.Builder()
            .setUri(castUri)
            .setMediaId("${playbackSession.libraryItemId}_chapter_${segment.chapterIndex}")
            .setMimeType(getMimeType(castUri.toString()))
            .setMediaMetadata(
                playbackSession.createCastMediaMetadata(
                    track = containingTrack,
                    chapter = chapter,
                    chapterIndex = segment.chapterIndex
                )
            )

        // Add clipping configuration - CastPlayer properly supports this
        if (segment.audioFileStartMs != 0L || segment.audioFileEndMs != segment.audioFileDurationMs) {
            mediaItemBuilder.setClippingConfiguration(
                MediaItem.ClippingConfiguration.Builder()
                    .setStartPositionMs(segment.audioFileStartMs)
                    .setEndPositionMs(segment.audioFileEndMs)
                    .build()
            )
        }

        return mediaItemBuilder.build()
    }

    /**
     * Loads media into cast player using MediaItems
     */
    fun loadCastPlayer(
        mediaItems: List<MediaItem>,
        startIndex: Int,
        startPositionMs: Long,
        playWhenReady: Boolean
    ) {
        castPlayer?.let { player ->
            Log.d(TAG, "Loading ${mediaItems.size} MediaItems into cast player as a complete playlist")
            Log.d(TAG, "Starting at index $startIndex, position ${startPositionMs}ms, playWhenReady=$playWhenReady")

            // Log each MediaItem being loaded to verify playlist structure
            mediaItems.forEachIndexed { index, mediaItem ->
                val title = mediaItem.mediaMetadata.title ?: "Chapter ${index + 1}"
                val hasClipping = mediaItem.clippingConfiguration != null
                val clipInfo = if (hasClipping) {
                    val clip = mediaItem.clippingConfiguration!!
                    "clipped ${clip.startPositionMs}-${clip.endPositionMs}ms"
                } else {
                    "no clipping"
                }
                Log.d(TAG, "  [$index] $title - $clipInfo - URI: ${mediaItem.localConfiguration?.uri}")
            }

            // Load the complete playlist at once - this creates the Cast queue
            player.setMediaItems(mediaItems, startIndex, startPositionMs)
            player.prepare()
            player.playWhenReady = playWhenReady

            Log.d(TAG, "Cast playlist loaded successfully with ${mediaItems.size} chapters")
        } ?: Log.e(TAG, "Cannot load cast player - player is null")
    }

    /**
     * Gets the current cast session if available
     * Note: Must be called from main thread
     */
    fun getCurrentCastSession(): CastSession? {
        return castContext?.sessionManager?.currentCastSession
    }

    /**
     * Checks if there's an active cast session
     * Note: Must be called from main thread
     */
    fun isConnected(): Boolean {
        val session = getCurrentCastSession()
        val isConnected = session?.isConnected == true
        Log.d(TAG, "isConnected: session=$session, isConnected=$isConnected")
        return isConnected
    }

    /**
     * Thread-safe check if there's an active cast session
     * Can be called from any thread
     */
    fun isConnectedSafe(callback: (Boolean) -> Unit) {
        if (android.os.Looper.myLooper() == android.os.Looper.getMainLooper()) {
            // Already on main thread
            callback(isConnected())
        } else {
            // Post to main thread
            android.os.Handler(android.os.Looper.getMainLooper()).post {
                try {
                    callback(isConnected())
                } catch (e: Exception) {
                    android.util.Log.w(TAG, "Failed to check cast connection: ${e.message}")
                    callback(false)
                }
            }
        }
    }

    /**
     * Checks for cast session with polling for delayed session availability
     * Sometimes the session exists but takes time to become ready for media
     */
    fun checkCastSessionWithPolling(callback: (Boolean) -> Unit, maxAttempts: Int = 10) {
        var attempts = 0
        val handler = android.os.Handler(android.os.Looper.getMainLooper())

        fun pollForConnection() {
            attempts++
            val session = getCurrentCastSession()
            val isConnected = session?.isConnected == true

            Log.d(TAG, "checkCastSessionWithPolling: attempt $attempts/$maxAttempts, session=$session, isConnected=$isConnected")

            if (isConnected) {
                Log.d(TAG, "Cast session is now ready after $attempts attempts")
                callback(true)
            } else if (attempts >= maxAttempts) {
                Log.d(TAG, "Cast session polling timed out after $maxAttempts attempts")
                callback(false)
            } else {
                // Try again in 500ms
                handler.postDelayed({ pollForConnection() }, 500)
            }
        }

        // Start polling
        pollForConnection()
    }

    /**
     * Synchronizes playback speed with the cast player
     */
    fun setPlaybackSpeed(speed: Float) {
        castPlayer?.let { player ->
            if (isConnected()) {
                Log.d(TAG, "Setting cast player speed to $speed")
                player.setPlaybackSpeed(speed)
            }
        }
    }

    /**
     * Sends a skip forward command to the cast receiver
     */
    fun skipForward(skipTimeMs: Long = 30000) {
        castPlayer?.let { player ->
            if (isConnected()) {
                Log.d(TAG, "Sending skip forward command to cast receiver: ${skipTimeMs}ms")
                val currentPosition = player.currentPosition
                player.seekTo(currentPosition + skipTimeMs)
            }
        }
    }

    /**
     * Sends a skip backward command to the cast receiver
     */
    fun skipBackward(skipTimeMs: Long = 10000) {
        castPlayer?.let { player ->
            if (isConnected()) {
                Log.d(TAG, "Sending skip backward command to cast receiver: ${skipTimeMs}ms")
                val currentPosition = player.currentPosition
                val newPosition = maxOf(0, currentPosition - skipTimeMs)
                player.seekTo(newPosition)
            }
        }
    }

    /**
     * Gets the MIME type for an audio URL
     */
    private fun getMimeType(url: String): String {
        return when {
            url.contains(".mp3", ignoreCase = true) -> MimeTypes.AUDIO_MPEG
            url.contains(".m4a", ignoreCase = true) -> MimeTypes.AUDIO_MP4
            url.contains(".mp4", ignoreCase = true) -> MimeTypes.AUDIO_MP4
            url.contains(".aac", ignoreCase = true) -> MimeTypes.AUDIO_AAC
            url.contains(".flac", ignoreCase = true) -> "audio/flac"
            url.contains(".ogg", ignoreCase = true) -> "audio/ogg"
            url.contains(".wav", ignoreCase = true) -> "audio/wav"
            url.contains(".m3u8", ignoreCase = true) -> MimeTypes.APPLICATION_M3U8
            else -> MimeTypes.AUDIO_MPEG // Default to MP3 for unknown audio types
        }
    }

    /**
     * Releases cast player resources
     */
    fun release() {
        sessionAvailabilityListener?.let { listener ->
            castPlayer?.setSessionAvailabilityListener(null)
        }
        castPlayer?.release()
        castPlayer = null
        Log.d(TAG, "Cast player released")
    }

    /**
     * Session availability listener for cast connections
     */
    private inner class CastSessionAvailabilityListener : SessionAvailabilityListener {
        override fun onCastSessionAvailable() {
            Log.w(TAG, "===== CAST SESSION AVAILABLE TRIGGERED =====")
            Log.d(TAG, "Cast session available - switching to cast player")
            Log.d(TAG, "onCastSessionAvailable: isConnected=${isConnected()}, castPlayer=${castPlayer}")
            // Switch to cast player when cast session becomes available
            service.switchToPlayer(true)
        }

        override fun onCastSessionUnavailable() {
            Log.d(TAG, "Cast session unavailable - switching to local player")
            // Switch back to local player when cast session becomes unavailable
            service.switchToPlayer(false)
        }
    }
}
