package com.audiobookshelf.app.player.builder

import android.net.Uri
import android.os.Bundle
import android.util.Log
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.MimeTypes
import com.audiobookshelf.app.data.*
import com.audiobookshelf.app.player.repository.BookInfo
import com.audiobookshelf.app.player.repository.ChapterInfo
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Builds MediaItem objects with chapter metadata for both single-track and multi-track audiobooks
 */
@Singleton
class MediaItemBuilder @Inject constructor() {
    companion object {
        private const val TAG = "MediaItemBuilder"
    }

    /**
     * Builds MediaItems for an audiobook, handling both single-track and multi-track types
     */
    fun buildBookMediaItems(
        libraryItem: LibraryItem,
        playbackSession: PlaybackSession
    ): List<MediaItem> {
        Log.d(TAG, "Building MediaItems for ${libraryItem.id}")

        val media = libraryItem.media
        if (media !is Book) {
            Log.e(TAG, "Media is not a book: ${media?.javaClass?.simpleName}")
            return emptyList()
        }

        val chapters = media.chapters ?: emptyList()
        Log.d(TAG, "Book has ${chapters.size} chapters")

        return if (chapters.size > 1 && hasMultipleAudioFiles(playbackSession)) {
            buildMultiTrackBook(libraryItem, media, chapters, playbackSession)
        } else {
            buildSingleTrackBook(libraryItem, media, chapters, playbackSession)
        }
    }

    /**
     * Builds MediaItems for a multi-track audiobook (one file per chapter)
     */
    private fun buildMultiTrackBook(
        libraryItem: LibraryItem,
        book: Book,
        chapters: List<BookChapter>,
        playbackSession: PlaybackSession
    ): List<MediaItem> {
        Log.d(TAG, "Building multi-track book with ${chapters.size} chapters")

        return playbackSession.audioTracks.mapIndexed { index, audioTrack ->
            val chapter = chapters.getOrNull(index)

            MediaItem.Builder()
                .setMediaId("${libraryItem.id}_chapter_$index")
                .setUri(playbackSession.getContentUri(audioTrack))
                .setMimeType(getMimeType(audioTrack.contentUrl))
                .setMediaMetadata(
                    MediaMetadata.Builder()
                        .setTitle(chapter?.title ?: "Chapter ${index + 1}")
                        .setSubtitle((book.metadata as? BookMetadata)?.title ?: "Unknown Title")
                        .setArtist((book.metadata as? BookMetadata)?.authorName ?: "Unknown Author")
                        .setAlbumTitle((book.metadata as? BookMetadata)?.title ?: "Unknown Title")
                        .setArtworkUri(getArtworkUri(libraryItem))
                        .setTrackNumber(index + 1)
                        .setTotalTrackCount(chapters.size)
                        .setIsPlayable(true)
                        .setExtras(Bundle().apply {
                            putString("book_id", libraryItem.id)
                            putInt("chapter_index", index)
                            putLong("chapter_start_ms", 0)
                            putLong("chapter_end_ms", (audioTrack.duration * 1000).toLong())
                            putString("book_type", "multi_track")
                            putString("chapter_title", chapter?.title)
                        })
                        .build()
                )
                .setTag(ChapterInfo(
                    bookId = libraryItem.id,
                    chapterIndex = index,
                    title = chapter?.title,
                    startMs = 0,
                    endMs = (audioTrack.duration * 1000).toLong(),
                    isMultiTrack = true
                ))
                .build()
        }
    }

    /**
     * Builds MediaItems for a single-track audiobook (one file with chapter metadata)
     */
    private fun buildSingleTrackBook(
        libraryItem: LibraryItem,
        book: Book,
        chapters: List<BookChapter>,
        playbackSession: PlaybackSession
    ): List<MediaItem> {
        Log.d(TAG, "Building single-track book with ${chapters.size} chapters")

        if (playbackSession.audioTracks.isEmpty()) {
            Log.e(TAG, "No audio tracks found in playback session")
            return emptyList()
        }

        val primaryTrack = playbackSession.audioTracks.first()
        val chapterInfoList = chapters.mapIndexed { index, chapter ->
            ChapterInfo(
                bookId = libraryItem.id,
                chapterIndex = index,
                title = chapter.title,
                startMs = (chapter.start * 1000).toLong(),
                endMs = (chapter.end * 1000).toLong(),
                isMultiTrack = false
            )
        }

        val mediaItem = MediaItem.Builder()
            .setMediaId(libraryItem.id)
            .setUri(playbackSession.getContentUri(primaryTrack))
            .setMimeType(getMimeType(primaryTrack.contentUrl))
            .setMediaMetadata(
                MediaMetadata.Builder()
                    .setTitle((book.metadata as? BookMetadata)?.title ?: "Unknown Title")
                    .setArtist((book.metadata as? BookMetadata)?.authorName ?: "Unknown Author")
                    .setAlbumTitle((book.metadata as? BookMetadata)?.title ?: "Unknown Title")
                    .setArtworkUri(getArtworkUri(libraryItem))
                    .setIsPlayable(true)
                    .setExtras(Bundle().apply {
                        putString("book_id", libraryItem.id)
                        putString("book_type", "single_track")
                        putInt("total_chapters", chapters.size)
                        // Store chapter data as a bundle
                        val chapterBundle = Bundle()
                        chapters.forEachIndexed { index, chapter ->
                            chapterBundle.putBundle("chapter_$index", Bundle().apply {
                                putString("title", chapter.title)
                                putLong("start_ms", (chapter.start * 1000).toLong())
                                putLong("end_ms", (chapter.end * 1000).toLong())
                            })
                        }
                        putBundle("chapters", chapterBundle)
                    })
                    .build()
            )
            .setTag(BookInfo(
                bookId = libraryItem.id,
                title = (book.metadata as? BookMetadata)?.title ?: "Unknown Title",
                author = (book.metadata as? BookMetadata)?.authorName ?: "Unknown Author",
                chapters = chapterInfoList
            ))
            .build()

        return listOf(mediaItem)
    }

    /**
     * Builds chapter items for browsing (Android Auto, etc.)
     */
    fun buildChapterBrowsableItems(
        libraryItem: LibraryItem,
        chapters: List<BookChapter>
    ): List<MediaItem> {
        Log.d(TAG, "Building browsable chapter items for ${libraryItem.id}")

        val book = libraryItem.media as? Book ?: return emptyList()

        return chapters.mapIndexed { index, chapter ->
            MediaItem.Builder()
                .setMediaId("${libraryItem.id}_chapter_browse_$index")
                .setMediaMetadata(
                    MediaMetadata.Builder()
                        .setTitle(chapter.title ?: "Chapter ${index + 1}")
                        .setSubtitle(formatDuration(((chapter.end - chapter.start) * 1000).toLong()))
                        .setArtworkUri(getArtworkUri(libraryItem))
                        .setIsPlayable(true)
                        .setIsBrowsable(false)
                        .setExtras(Bundle().apply {
                            putString("book_id", libraryItem.id)
                            putInt("chapter_index", index)
                            putLong("start_position_ms", (chapter.start * 1000).toLong())
                        })
                        .build()
                )
                .build()
        }
    }

    /**
     * Builds MediaItems for podcast episodes
     */
    fun buildPodcastMediaItems(
        libraryItem: LibraryItem,
        playbackSession: PlaybackSession
    ): List<MediaItem> {
        Log.d(TAG, "Building MediaItems for podcast ${libraryItem.id}")

        val media = libraryItem.media
        if (media !is Podcast) {
            Log.e(TAG, "Media is not a podcast: ${media?.javaClass?.simpleName}")
            return emptyList()
        }

        return playbackSession.audioTracks.map { audioTrack ->
            MediaItem.Builder()
                .setMediaId("${libraryItem.id}_episode")
                .setUri(playbackSession.getContentUri(audioTrack))
                .setMimeType(getMimeType(audioTrack.contentUrl))
                .setMediaMetadata(
                    MediaMetadata.Builder()
                        .setTitle(playbackSession.displayTitle ?: (media.metadata as? PodcastMetadata)?.title)
                        .setArtist(playbackSession.displayAuthor ?: (media.metadata as? PodcastMetadata)?.author)
                        .setAlbumTitle((media.metadata as? PodcastMetadata)?.title)
                        .setArtworkUri(getArtworkUri(libraryItem))
                        .setIsPlayable(true)
                        .setExtras(Bundle().apply {
                            putString("item_id", libraryItem.id)
                            putString("media_type", "podcast")
                        })
                        .build()
                )
                .build()
        }
    }

    /**
     * Determines if the playback session has multiple audio files
     */
    private fun hasMultipleAudioFiles(playbackSession: PlaybackSession): Boolean {
        return playbackSession.audioTracks.size > 1
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
            else -> MimeTypes.AUDIO_UNKNOWN
        }
    }

    /**
     * Gets the artwork URI for a library item
     */
    private fun getArtworkUri(libraryItem: LibraryItem): Uri? {
        return try {
            if (!libraryItem.media?.coverPath.isNullOrEmpty()) {
                Uri.parse(libraryItem.media?.coverPath)
            } else {
                null
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to parse artwork URI: ${e.message}")
            null
        }
    }

    /**
     * Formats duration in milliseconds to readable format
     */
    private fun formatDuration(durationMs: Long): String {
        val totalSeconds = durationMs / 1000
        val hours = totalSeconds / 3600
        val minutes = (totalSeconds % 3600) / 60
        val seconds = totalSeconds % 60

        return if (hours > 0) {
            String.format("%d:%02d:%02d", hours, minutes, seconds)
        } else {
            String.format("%d:%02d", minutes, seconds)
        }
    }
}
