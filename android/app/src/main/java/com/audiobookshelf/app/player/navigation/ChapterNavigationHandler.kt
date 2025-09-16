package com.audiobookshelf.app.player.navigation

import android.util.Log
import androidx.media3.common.C
import androidx.media3.common.Player
import com.audiobookshelf.app.player.repository.BookInfo
import com.audiobookshelf.app.player.repository.ChapterInfo
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Handles intelligent chapter navigation for both single-track and multi-track audiobooks
 */
@Singleton
class ChapterNavigationHandler @Inject constructor() {

    companion object {
        private const val TAG = "ChapterNavigation"
        private const val RESTART_THRESHOLD_MS = 3000L // 3 seconds
    }

    /**
     * Seeks to the next chapter, handling both single-track and multi-track books
     */
    fun seekToNextChapter(player: Player) {
        val currentItem = player.currentMediaItem ?: return
        val currentPosition = player.currentPosition

        Log.d(TAG, "Seeking to next chapter from position: ${currentPosition}ms")

        when (val tag = currentItem.localConfiguration?.tag) {
            is BookInfo -> {
                // Single-track book with chapters
                handleSingleTrackNextChapter(player, tag, currentPosition)
            }
            is ChapterInfo -> {
                // Multi-track book
                handleMultiTrackNextChapter(player, tag)
            }
            else -> {
                // Fallback to default behavior
                Log.d(TAG, "No chapter info found, using default next behavior")
                if (player.hasNextMediaItem()) {
                    player.seekToNextMediaItem()
                } else {
                    // Skip forward 30 seconds as fallback
                    skipForward(player, 30)
                }
            }
        }
    }

    /**
     * Seeks to the previous chapter, handling both single-track and multi-track books
     */
    fun seekToPreviousChapter(player: Player) {
        val currentItem = player.currentMediaItem ?: return
        val currentPosition = player.currentPosition

        Log.d(TAG, "Seeking to previous chapter from position: ${currentPosition}ms")

        when (val tag = currentItem.localConfiguration?.tag) {
            is BookInfo -> {
                // Single-track book with chapters
                handleSingleTrackPreviousChapter(player, tag, currentPosition)
            }
            is ChapterInfo -> {
                // Multi-track book
                handleMultiTrackPreviousChapter(player, tag, currentPosition)
            }
            else -> {
                // Fallback to default behavior
                Log.d(TAG, "No chapter info found, using default previous behavior")
                if (currentPosition > RESTART_THRESHOLD_MS) {
                    player.seekTo(0)
                } else if (player.hasPreviousMediaItem()) {
                    player.seekToPreviousMediaItem()
                } else {
                    player.seekTo(0)
                }
            }
        }
    }

    /**
     * Seeks to a specific chapter by index
     */
    fun seekToChapter(player: Player, chapterIndex: Int) {
        val currentItem = player.currentMediaItem ?: return

        Log.d(TAG, "Seeking to chapter index: $chapterIndex")

        when (val tag = currentItem.localConfiguration?.tag) {
            is BookInfo -> {
                // Single-track book - seek to chapter start position
                val chapter = tag.chapters.getOrNull(chapterIndex)
                if (chapter != null) {
                    Log.d(TAG, "Seeking to chapter ${chapterIndex} at ${chapter.startMs}ms")
                    player.seekTo(chapter.startMs)
                } else {
                    Log.w(TAG, "Chapter $chapterIndex not found in book with ${tag.chapters.size} chapters")
                }
            }
            is ChapterInfo -> {
                // Multi-track book - seek to different media item
                if (tag.isMultiTrack && chapterIndex >= 0 && chapterIndex < player.mediaItemCount) {
                    Log.d(TAG, "Seeking to media item $chapterIndex in multi-track book")
                    player.seekTo(chapterIndex, 0)
                } else {
                    Log.w(TAG, "Invalid chapter index $chapterIndex for multi-track book")
                }
            }
            else -> {
                Log.w(TAG, "Cannot seek to chapter: no chapter information available")
            }
        }
    }

    /**
     * Gets the current chapter index
     */
    fun getCurrentChapterIndex(player: Player): Int {
        val currentItem = player.currentMediaItem ?: return -1
        val currentPosition = player.currentPosition

        return when (val tag = currentItem.localConfiguration?.tag) {
            is BookInfo -> {
                // Single-track book - find chapter by position
                tag.chapters.indexOfFirst { chapter ->
                    currentPosition >= chapter.startMs && currentPosition < chapter.endMs
                }
            }
            is ChapterInfo -> {
                // Multi-track book - return chapter index from tag
                tag.chapterIndex
            }
            else -> -1
        }
    }

    /**
     * Gets the total number of chapters
     */
    fun getTotalChapters(player: Player): Int {
        val currentItem = player.currentMediaItem ?: return 0

        return when (val tag = currentItem.localConfiguration?.tag) {
            is BookInfo -> tag.chapters.size
            is ChapterInfo -> {
                if (tag.isMultiTrack) {
                    player.mediaItemCount
                } else {
                    1 // Single chapter in multi-track context doesn't make sense, but fallback
                }
            }
            else -> 0
        }
    }

    /**
     * Skips forward by specified seconds, with chapter boundary awareness
     */
    fun skipForward(player: Player, seconds: Int) {
        val newPosition = player.currentPosition + (seconds * 1000)
        val duration = player.duration

        // Check if we would skip past the current chapter end
        val currentItem = player.currentMediaItem
        val tag = currentItem?.localConfiguration?.tag

        if (tag is BookInfo) {
            val currentChapter = getCurrentChapter(tag, player.currentPosition)
            if (currentChapter != null && newPosition >= currentChapter.endMs) {
                Log.d(TAG, "Skip forward would exceed chapter boundary, moving to next chapter")
                seekToNextChapter(player)
                return
            }
        }

        if (duration != C.TIME_UNSET && newPosition >= duration) {
            Log.d(TAG, "Skip forward would exceed media duration, moving to next item")
            seekToNextChapter(player)
        } else {
            Log.d(TAG, "Skipping forward ${seconds}s to position: ${newPosition}ms")
            player.seekTo(newPosition)
        }
    }

    /**
     * Skips backward by specified seconds, with chapter boundary awareness
     */
    fun skipBackward(player: Player, seconds: Int) {
        val newPosition = player.currentPosition - (seconds * 1000)

        // Check if we would skip past the current chapter start
        val currentItem = player.currentMediaItem
        val tag = currentItem?.localConfiguration?.tag

        if (tag is BookInfo) {
            val currentChapter = getCurrentChapter(tag, player.currentPosition)
            if (currentChapter != null && newPosition < currentChapter.startMs) {
                Log.d(TAG, "Skip backward would exceed chapter boundary, moving to previous chapter")
                seekToPreviousChapter(player)
                return
            }
        }

        if (newPosition < 0) {
            Log.d(TAG, "Skip backward would exceed media start, moving to previous item or start")
            seekToPreviousChapter(player)
        } else {
            Log.d(TAG, "Skipping backward ${seconds}s to position: ${newPosition}ms")
            player.seekTo(newPosition)
        }
    }

    private fun handleSingleTrackNextChapter(player: Player, bookInfo: BookInfo, currentPosition: Long) {
        val currentChapter = getCurrentChapter(bookInfo, currentPosition)
        val currentIndex = bookInfo.chapters.indexOf(currentChapter)

        if (currentIndex < bookInfo.chapters.size - 1) {
            // Move to next chapter in same file
            val nextChapter = bookInfo.chapters[currentIndex + 1]
            Log.d(TAG, "Moving to next chapter ${nextChapter.chapterIndex} at ${nextChapter.startMs}ms")
            player.seekTo(nextChapter.startMs)
        } else if (player.hasNextMediaItem()) {
            // Move to next book if available
            Log.d(TAG, "End of book reached, moving to next media item")
            player.seekToNextMediaItem()
        } else {
            // No more chapters or items, skip forward
            Log.d(TAG, "No next chapter available, skipping forward")
            skipForward(player, 30)
        }
    }

    private fun handleSingleTrackPreviousChapter(player: Player, bookInfo: BookInfo, currentPosition: Long) {
        val currentChapter = getCurrentChapter(bookInfo, currentPosition)
        val currentIndex = bookInfo.chapters.indexOf(currentChapter)

        currentChapter?.let { chapter ->
            if (currentPosition - chapter.startMs > RESTART_THRESHOLD_MS) {
                // Restart current chapter
                Log.d(TAG, "Restarting current chapter at ${chapter.startMs}ms")
                player.seekTo(chapter.startMs)
            } else if (currentIndex > 0) {
                // Go to previous chapter
                val prevChapter = bookInfo.chapters[currentIndex - 1]
                Log.d(TAG, "Moving to previous chapter ${prevChapter.chapterIndex} at ${prevChapter.startMs}ms")
                player.seekTo(prevChapter.startMs)
            } else if (player.hasPreviousMediaItem()) {
                // Move to previous book if available
                Log.d(TAG, "Beginning of book reached, moving to previous media item")
                player.seekToPreviousMediaItem()
            } else {
                // Restart from beginning
                Log.d(TAG, "No previous chapter available, restarting from beginning")
                player.seekTo(0)
            }
        }
    }

    private fun handleMultiTrackNextChapter(player: Player, chapterInfo: ChapterInfo) {
        if (chapterInfo.isMultiTrack) {
            if (player.hasNextMediaItem()) {
                Log.d(TAG, "Moving to next media item in multi-track book")
                player.seekToNextMediaItem()
            } else {
                Log.d(TAG, "End of multi-track book reached")
                // Could implement end-of-book behavior here
            }
        } else {
            // Single track with chapter info - shouldn't happen in normal flow
            Log.w(TAG, "Unexpected single track with ChapterInfo tag")
            skipForward(player, 30)
        }
    }

    private fun handleMultiTrackPreviousChapter(player: Player, chapterInfo: ChapterInfo, currentPosition: Long) {
        if (chapterInfo.isMultiTrack) {
            if (currentPosition > RESTART_THRESHOLD_MS) {
                // Restart current chapter/track
                Log.d(TAG, "Restarting current track in multi-track book")
                player.seekTo(0)
            } else if (player.hasPreviousMediaItem()) {
                // Move to previous chapter/track
                Log.d(TAG, "Moving to previous media item in multi-track book")
                player.seekToPreviousMediaItem()
            } else {
                // Beginning of book
                Log.d(TAG, "Beginning of multi-track book reached, restarting current track")
                player.seekTo(0)
            }
        } else {
            // Single track with chapter info - shouldn't happen in normal flow
            Log.w(TAG, "Unexpected single track with ChapterInfo tag")
            if (currentPosition > RESTART_THRESHOLD_MS) {
                player.seekTo(0)
            } else {
                skipBackward(player, 30)
            }
        }
    }

    private fun getCurrentChapter(bookInfo: BookInfo, position: Long): ChapterInfo? {
        return bookInfo.chapters.find { chapter ->
            position >= chapter.startMs && position < chapter.endMs
        }
    }
}
