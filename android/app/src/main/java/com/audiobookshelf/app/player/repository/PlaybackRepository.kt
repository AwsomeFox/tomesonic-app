package com.audiobookshelf.app.player.repository

import android.net.Uri
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import javax.inject.Inject
import javax.inject.Singleton
import android.util.Log
import com.audiobookshelf.app.data.PlaybackSession
import com.audiobookshelf.app.managers.DbManager

/**
 * Single source of truth for playback state in the Media3 architecture.
 * This repository listens to Media3 Player events and exposes reactive state via Kotlin Flow.
 */
@Singleton
class PlaybackRepository @Inject constructor() {
    companion object {
        private const val TAG = "PlaybackRepository"
    }

    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())

    // Single source of truth for playback state
    private val _playbackState = MutableStateFlow(PlaybackState())
    val playbackState: StateFlow<PlaybackState> = _playbackState.asStateFlow()

    // Current chapter information
    private val _currentChapter = MutableStateFlow<ChapterInfo?>(null)
    val currentChapter: StateFlow<ChapterInfo?> = _currentChapter.asStateFlow()

    // Playback progress
    private val _playbackProgress = MutableStateFlow(PlaybackProgress())
    val playbackProgress: StateFlow<PlaybackProgress> = _playbackProgress.asStateFlow()

    // Book information
    private val _currentBook = MutableStateFlow<BookInfo?>(null)
    val currentBook: StateFlow<BookInfo?> = _currentBook.asStateFlow()

    private var currentPlayer: Player? = null
    private var progressUpdateJob: Job? = null

    fun onPlayerChanged(player: Player) {
        Log.d(TAG, "Player changed, updating listeners")
        currentPlayer?.removeListener(playerListener)
        currentPlayer = player
        player.addListener(playerListener)

        // Start progress updates
        startProgressUpdates()
    }

    private val playerListener = object : Player.Listener {
        override fun onPlaybackStateChanged(playbackState: Int) {
            Log.d(TAG, "Playback state changed: $playbackState")
            updatePlaybackState(playbackState)
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) {
            Log.d(TAG, "Is playing changed: $isPlaying")
            _playbackState.update { it.copy(isPlaying = isPlaying) }
            if (isPlaying) {
                startProgressUpdates()
            } else {
                stopProgressUpdates()
            }
        }

        override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
            Log.d(TAG, "Media item transition: ${mediaItem?.mediaId}")
            mediaItem?.let { item ->
                updateCurrentMediaItem(item)

                // Extract chapter info from MediaItem
                when (val tag = item.localConfiguration?.tag) {
                    is ChapterInfo -> {
                        Log.d(TAG, "Found chapter info: ${tag.chapterIndex}")
                        _currentChapter.value = tag
                    }
                    is BookInfo -> {
                        Log.d(TAG, "Found book info with ${tag.chapters.size} chapters")
                        _currentBook.value = tag
                        // For single-track books, determine current chapter by position
                        val position = currentPlayer?.currentPosition ?: 0
                        val chapter = tag.chapters.find {
                            position >= it.startMs && position < it.endMs
                        }
                        _currentChapter.value = chapter
                    }
                }
            }
        }

        override fun onPositionDiscontinuity(
            oldPosition: Player.PositionInfo,
            newPosition: Player.PositionInfo,
            reason: Int
        ) {
            Log.d(TAG, "Position discontinuity: ${newPosition.positionMs}")
            updatePosition(newPosition.positionMs)
            checkChapterBoundary(newPosition.positionMs)
        }

        override fun onPlaybackParametersChanged(playbackParameters: androidx.media3.common.PlaybackParameters) {
            Log.d(TAG, "Playback speed changed: ${playbackParameters.speed}")
            _playbackProgress.update {
                it.copy(playbackSpeed = playbackParameters.speed)
            }
        }
    }

    private fun startProgressUpdates() {
        progressUpdateJob?.cancel()
        progressUpdateJob = scope.launch {
            while (currentPlayer?.isPlaying == true) {
                val position = currentPlayer?.currentPosition ?: 0
                val duration = currentPlayer?.duration ?: 0
                val bufferedPosition = currentPlayer?.bufferedPosition ?: 0

                _playbackProgress.update {
                    PlaybackProgress(
                        positionMs = position,
                        durationMs = duration,
                        bufferedPositionMs = bufferedPosition,
                        playbackSpeed = currentPlayer?.playbackParameters?.speed ?: 1f
                    )
                }

                // Check if we've crossed a chapter boundary
                checkChapterBoundary(position)

                // Save progress to database
                saveProgress(position, duration)

                delay(1000) // Update every second
            }
        }
    }

    private fun stopProgressUpdates() {
        progressUpdateJob?.cancel()
    }

    private fun checkChapterBoundary(positionMs: Long) {
        val currentItem = currentPlayer?.currentMediaItem ?: return

        when (val tag = currentItem.localConfiguration?.tag) {
            is BookInfo -> {
                // Single-track book - check chapter boundaries
                val newChapter = tag.chapters.find {
                    positionMs >= it.startMs && positionMs < it.endMs
                }
                if (newChapter != _currentChapter.value) {
                    Log.d(TAG, "Chapter boundary crossed: ${newChapter?.chapterIndex}")
                    _currentChapter.value = newChapter
                    onChapterChanged(newChapter)
                }
            }
        }
    }

    private fun onChapterChanged(chapter: ChapterInfo?) {
        // Notify about chapter change
        // Could trigger notifications, analytics, etc.
        Log.i(TAG, "Chapter changed to: ${chapter?.chapterIndex}")
    }

    private suspend fun saveProgress(position: Long, duration: Long) {
        val mediaItem = currentPlayer?.currentMediaItem ?: return
        val bookId = mediaItem.mediaMetadata.extras?.getString("book_id") ?: return

        // Save progress using existing database manager
        // This will need to be adapted to your specific database implementation
        try {
            // DbManager.savePlaybackProgress(bookId, position, duration)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to save progress: ${e.message}")
        }
    }

    fun updatePlaybackState(state: Int) {
        _playbackState.update {
            it.copy(
                playerState = state,
                isBuffering = state == Player.STATE_BUFFERING
            )
        }
    }

    fun updateCurrentMediaItem(mediaItem: MediaItem) {
        _playbackState.update {
            it.copy(
                currentMediaItem = mediaItem,
                title = mediaItem.mediaMetadata.title?.toString(),
                artist = mediaItem.mediaMetadata.artist?.toString(),
                artworkUri = mediaItem.mediaMetadata.artworkUri
            )
        }
    }

    fun updatePosition(positionMs: Long) {
        _playbackProgress.update {
            it.copy(positionMs = positionMs)
        }
    }

    fun seekToChapter(chapterIndex: Int) {
        val currentItem = currentPlayer?.currentMediaItem ?: return

        when (val tag = currentItem.localConfiguration?.tag) {
            is BookInfo -> {
                // Single-track book - seek to chapter start
                val chapter = tag.chapters.getOrNull(chapterIndex) ?: return
                Log.d(TAG, "Seeking to chapter $chapterIndex at ${chapter.startMs}ms")
                currentPlayer?.seekTo(chapter.startMs)
            }
            is ChapterInfo -> {
                // Multi-track book - seek to different media item
                if (tag.isMultiTrack) {
                    Log.d(TAG, "Seeking to media item $chapterIndex")
                    currentPlayer?.seekTo(chapterIndex, 0)
                }
            }
        }
    }

    fun release() {
        Log.d(TAG, "Releasing PlaybackRepository")
        currentPlayer?.removeListener(playerListener)
        progressUpdateJob?.cancel()
        scope.cancel()
    }
}

/**
 * Represents the current playback state
 */
data class PlaybackState(
    val isPlaying: Boolean = false,
    val playerState: Int = Player.STATE_IDLE,
    val isBuffering: Boolean = false,
    val currentMediaItem: MediaItem? = null,
    val title: String? = null,
    val artist: String? = null,
    val artworkUri: Uri? = null
)

/**
 * Represents playback progress information
 */
data class PlaybackProgress(
    val positionMs: Long = 0,
    val durationMs: Long = 0,
    val bufferedPositionMs: Long = 0,
    val playbackSpeed: Float = 1f
)

/**
 * Represents chapter information for audiobooks
 */
data class ChapterInfo(
    val bookId: String,
    val chapterIndex: Int,
    val title: String? = null,
    val startMs: Long,
    val endMs: Long,
    val isMultiTrack: Boolean
)

/**
 * Represents book information with chapters
 */
data class BookInfo(
    val bookId: String,
    val title: String,
    val author: String? = null,
    val chapters: List<ChapterInfo>
)

/**
 * Represents the last playback session for resumption
 */
data class LastPlaybackSession(
    val mediaItems: List<MediaItem>,
    val startIndex: Int,
    val startPositionMs: Long
)
