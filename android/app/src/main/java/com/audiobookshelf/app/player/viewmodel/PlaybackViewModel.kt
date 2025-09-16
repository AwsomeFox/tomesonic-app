package com.audiobookshelf.app.player.viewmodel

import android.net.Uri
import android.os.Bundle
import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.media3.common.MediaItem
import androidx.media3.session.MediaController
import androidx.media3.session.SessionCommand
import com.audiobookshelf.app.player.navigation.ChapterNavigationHandler
import com.audiobookshelf.app.player.repository.PlaybackRepository
import com.audiobookshelf.app.player.repository.ChapterInfo
import com.audiobookshelf.app.player.service.AudiobookMediaService
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * ViewModel that connects the UI to the PlaybackRepository and MediaController
 * Provides reactive state and handles user actions
 */
class PlaybackViewModel @Inject constructor(
    private val playbackRepository: PlaybackRepository,
    private val chapterNavigationHandler: ChapterNavigationHandler,
    private val mediaControllerManager: MediaControllerManager
) : ViewModel() {

    companion object {
        private const val TAG = "PlaybackViewModel"
    }

    // Expose repository state directly
    val playbackState = playbackRepository.playbackState
    val playbackProgress = playbackRepository.playbackProgress
    val currentChapter = playbackRepository.currentChapter
    val currentBook = playbackRepository.currentBook

    // UI-specific state
    private val _uiState = MutableStateFlow(PlaybackUiState())
    val uiState: StateFlow<PlaybackUiState> = _uiState.asStateFlow()

    // Chapter navigation state
    private val _chapterState = MutableStateFlow(ChapterUiState())
    val chapterState: StateFlow<ChapterUiState> = _chapterState.asStateFlow()

    // MediaController for sending commands
    private var mediaController: MediaController? = null

    init {
        // Observe MediaController availability
        viewModelScope.launch {
            mediaControllerManager.controller.collect { controller ->
                mediaController = controller
                controller?.let { setupControllerListeners(it) }
            }
        }

        // Combine repository states into UI state
        combine(
            playbackState,
            playbackProgress,
            currentChapter,
            currentBook
        ) { state, progress, chapter, book ->
            PlaybackUiState(
                isPlaying = state.isPlaying,
                isBuffering = state.isBuffering,
                title = state.title ?: "",
                artist = state.artist ?: "",
                artworkUri = state.artworkUri,
                positionMs = progress.positionMs,
                durationMs = progress.durationMs,
                bufferedPercentage = calculateBufferedPercentage(
                    progress.bufferedPositionMs,
                    progress.durationMs
                ),
                playbackSpeed = progress.playbackSpeed,
                canSeekToNext = hasNextChapter(chapter, book),
                canSeekToPrevious = hasPreviousChapter(chapter, book),
                canSkipForward = true,
                canSkipBackward = true
            )
        }.onEach { state ->
            _uiState.value = state
        }.launchIn(viewModelScope)

        // Update chapter state
        combine(
            currentChapter,
            currentBook,
            playbackProgress
        ) { chapter, book, progress ->
            ChapterUiState(
                currentChapterIndex = chapter?.chapterIndex ?: -1,
                totalChapters = book?.chapters?.size ?: 0,
                chapterTitle = chapter?.title ?: getDefaultChapterTitle(chapter),
                chapterProgress = calculateChapterProgress(progress.positionMs, chapter),
                chapters = book?.chapters?.map { chapterInfo ->
                    ChapterUiInfo(
                        index = chapterInfo.chapterIndex,
                        title = chapterInfo.title ?: "Chapter ${chapterInfo.chapterIndex + 1}",
                        startMs = chapterInfo.startMs,
                        endMs = chapterInfo.endMs,
                        durationMs = chapterInfo.endMs - chapterInfo.startMs,
                        isCurrentChapter = chapterInfo.chapterIndex == chapter?.chapterIndex
                    )
                } ?: emptyList()
            )
        }.onEach { state ->
            _chapterState.value = state
        }.launchIn(viewModelScope)
    }

    private fun setupControllerListeners(controller: MediaController) {
        // Additional controller-specific setup if needed
        Log.d(TAG, "MediaController connected: ${controller.isConnected}")
    }

    // === Playback Controls ===

    fun play() {
        Log.d(TAG, "Play requested")
        mediaController?.play()
    }

    fun pause() {
        Log.d(TAG, "Pause requested")
        mediaController?.pause()
    }

    fun seekToNext() {
        Log.d(TAG, "Seek to next chapter requested")
        sendCustomCommand(AudiobookMediaService.COMMAND_SEEK_TO_CHAPTER, Bundle().apply {
            putString("direction", "next")
        })
    }

    fun seekToPrevious() {
        Log.d(TAG, "Seek to previous chapter requested")
        sendCustomCommand(AudiobookMediaService.COMMAND_SEEK_TO_CHAPTER, Bundle().apply {
            putString("direction", "previous")
        })
    }

    fun seekTo(positionMs: Long) {
        Log.d(TAG, "Seek to position: ${positionMs}ms")
        mediaController?.seekTo(positionMs)
    }

    fun skipForward(seconds: Int = 30) {
        Log.d(TAG, "Skip forward ${seconds}s")
        sendCustomCommand(AudiobookMediaService.COMMAND_SKIP_FORWARD, Bundle().apply {
            putInt("seconds", seconds)
        })
    }

    fun skipBackward(seconds: Int = 30) {
        Log.d(TAG, "Skip backward ${seconds}s")
        sendCustomCommand(AudiobookMediaService.COMMAND_SKIP_BACKWARD, Bundle().apply {
            putInt("seconds", seconds)
        })
    }

    fun setPlaybackSpeed(speed: Float) {
        Log.d(TAG, "Set playback speed: $speed")
        sendCustomCommand(AudiobookMediaService.COMMAND_SET_PLAYBACK_SPEED, Bundle().apply {
            putFloat("speed", speed)
        })
    }

    fun seekToChapter(chapterIndex: Int) {
        Log.d(TAG, "Seek to chapter: $chapterIndex")
        sendCustomCommand(AudiobookMediaService.COMMAND_SEEK_TO_CHAPTER, Bundle().apply {
            putInt("chapter_index", chapterIndex)
        })
    }

    // === Smart Playback Controls ===

    /**
     * Smart skip that combines chapter navigation with time-based skipping
     */
    fun smartSkipForward() {
        val chapter = _chapterState.value
        val progress = _uiState.value

        if (chapter.totalChapters > 1) {
            // If we're near the end of a chapter, go to next chapter
            val remainingInChapter = chapter.currentChapterIndex.let { index ->
                if (index >= 0 && index < chapter.chapters.size) {
                    chapter.chapters[index].endMs - progress.positionMs
                } else null
            }

            if (remainingInChapter != null && remainingInChapter < 30000) { // Less than 30s remaining
                seekToNext()
            } else {
                skipForward()
            }
        } else {
            skipForward()
        }
    }

    /**
     * Smart skip that combines chapter navigation with time-based skipping
     */
    fun smartSkipBackward() {
        val chapter = _chapterState.value
        val progress = _uiState.value

        if (chapter.totalChapters > 1) {
            // If we're near the beginning of a chapter, go to previous chapter
            val elapsedInChapter = chapter.currentChapterIndex.let { index ->
                if (index >= 0 && index < chapter.chapters.size) {
                    progress.positionMs - chapter.chapters[index].startMs
                } else null
            }

            if (elapsedInChapter != null && elapsedInChapter < 30000) { // Less than 30s elapsed
                seekToPrevious()
            } else {
                skipBackward()
            }
        } else {
            skipBackward()
        }
    }

    // === Utility Methods ===

    private fun sendCustomCommand(command: String, args: Bundle = Bundle.EMPTY) {
        val sessionCommand = SessionCommand(command, Bundle.EMPTY)
        mediaController?.sendCustomCommand(sessionCommand, args)
    }

    private fun calculateBufferedPercentage(buffered: Long, duration: Long): Float {
        return if (duration > 0) {
            (buffered.toFloat() / duration * 100).coerceIn(0f, 100f)
        } else 0f
    }

    private fun calculateChapterProgress(position: Long, chapter: ChapterInfo?): Float {
        return chapter?.let {
            val chapterDuration = it.endMs - it.startMs
            val chapterPosition = position - it.startMs
            if (chapterDuration > 0) {
                (chapterPosition.toFloat() / chapterDuration).coerceIn(0f, 1f)
            } else 0f
        } ?: 0f
    }

    private fun hasNextChapter(chapter: ChapterInfo?, book: com.audiobookshelf.app.player.repository.BookInfo?): Boolean {
        return when {
            chapter?.isMultiTrack == true -> {
                // Multi-track book - check if there's a next media item
                mediaController?.hasNextMediaItem() ?: false
            }
            book != null && chapter != null -> {
                // Single-track book - check if there's a next chapter
                chapter.chapterIndex < book.chapters.size - 1
            }
            else -> false
        }
    }

    private fun hasPreviousChapter(chapter: ChapterInfo?, book: com.audiobookshelf.app.player.repository.BookInfo?): Boolean {
        return when {
            chapter?.isMultiTrack == true -> {
                // Multi-track book - check if there's a previous media item
                mediaController?.hasPreviousMediaItem() ?: false
            }
            book != null && chapter != null -> {
                // Single-track book - check if there's a previous chapter
                chapter.chapterIndex > 0
            }
            else -> false
        }
    }

    private fun getDefaultChapterTitle(chapter: ChapterInfo?): String {
        return chapter?.let { "Chapter ${it.chapterIndex + 1}" } ?: ""
    }

    fun getFormattedPosition(): String {
        val progress = _uiState.value
        return formatTime(progress.positionMs)
    }

    fun getFormattedDuration(): String {
        val progress = _uiState.value
        return formatTime(progress.durationMs)
    }

    fun getFormattedRemaining(): String {
        val progress = _uiState.value
        val remaining = progress.durationMs - progress.positionMs
        return "-${formatTime(remaining)}"
    }

    private fun formatTime(ms: Long): String {
        val totalSeconds = ms / 1000
        val hours = totalSeconds / 3600
        val minutes = (totalSeconds % 3600) / 60
        val seconds = totalSeconds % 60

        return if (hours > 0) {
            String.format("%d:%02d:%02d", hours, minutes, seconds)
        } else {
            String.format("%d:%02d", minutes, seconds)
        }
    }

    override fun onCleared() {
        super.onCleared()
        Log.d(TAG, "PlaybackViewModel cleared")
    }
}

/**
 * UI state for playback controls
 */
data class PlaybackUiState(
    val isPlaying: Boolean = false,
    val isBuffering: Boolean = false,
    val title: String = "",
    val artist: String = "",
    val artworkUri: Uri? = null,
    val positionMs: Long = 0,
    val durationMs: Long = 0,
    val bufferedPercentage: Float = 0f,
    val playbackSpeed: Float = 1f,
    val canSeekToNext: Boolean = false,
    val canSeekToPrevious: Boolean = false,
    val canSkipForward: Boolean = true,
    val canSkipBackward: Boolean = true
)

/**
 * UI state for chapter information
 */
data class ChapterUiState(
    val currentChapterIndex: Int = -1,
    val totalChapters: Int = 0,
    val chapterTitle: String = "",
    val chapterProgress: Float = 0f,
    val chapters: List<ChapterUiInfo> = emptyList()
)

/**
 * UI information for a single chapter
 */
data class ChapterUiInfo(
    val index: Int,
    val title: String,
    val startMs: Long,
    val endMs: Long,
    val durationMs: Long,
    val isCurrentChapter: Boolean = false
)

/**
 * Manager for MediaController connection
 * This would typically be injected and managed by your DI framework
 */
interface MediaControllerManager {
    val controller: StateFlow<MediaController?>
}
