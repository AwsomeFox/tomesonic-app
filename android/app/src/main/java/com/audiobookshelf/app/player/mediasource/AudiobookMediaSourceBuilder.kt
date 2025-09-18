package com.audiobookshelf.app.player.mediasource

import android.content.Context
import android.net.Uri
import android.util.Log
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.source.ClippingMediaSource
import androidx.media3.exoplayer.source.ConcatenatingMediaSource
import androidx.media3.exoplayer.source.MediaSource
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import androidx.media3.extractor.DefaultExtractorsFactory
import com.audiobookshelf.app.data.AudioTrack
import com.audiobookshelf.app.data.BookChapter
import com.audiobookshelf.app.data.PlaybackSession

/**
 * Builds a Media3 MediaSource architecture for audiobooks using ConcatenatingMediaSource
 * with ClippingMediaSource for each chapter to create a single unified timeline.
 */
class AudiobookMediaSourceBuilder(private val context: Context) {

    companion object {
        private const val TAG = "AudiobookMediaSourceBuilder"
    }

    private val dataSourceFactory by lazy {
        DefaultDataSource.Factory(context, DefaultHttpDataSource.Factory())
    }

    private val extractorsFactory by lazy {
        DefaultExtractorsFactory()
    }

    // Store the last created chapter segments for external access
    private var lastChapterSegments: List<ChapterSegment> = emptyList()

    /**
     * Get the chapter segments from the last built MediaSource
     */
    fun getLastChapterSegments(): List<ChapterSegment> = lastChapterSegments

    /**
     * Builds a complete MediaSource for an audiobook with chapter-based MediaItems
     */
    fun buildMediaSource(playbackSession: PlaybackSession): MediaSource? {
        Log.d(TAG, "Building MediaSource for ${playbackSession.displayTitle}")

        if (playbackSession.audioTracks.isEmpty()) {
            Log.e(TAG, "No audio tracks found in playback session")
            return null
        }

        // Create chapter segments from the playback session
        val chapterSegments = createChapterSegments(playbackSession)
        if (chapterSegments.isEmpty()) {
            Log.e(TAG, "No chapter segments could be created")
            return null
        }

        // Store segments for external access
        lastChapterSegments = chapterSegments

        Log.d(TAG, "Created ${chapterSegments.size} chapter segments")

        // Build the concatenating MediaSource
        val concatenatingMediaSource = ConcatenatingMediaSource()

        chapterSegments.forEach { segment ->
            val chapterMediaSource = createChapterMediaSource(segment, playbackSession)
            concatenatingMediaSource.addMediaSource(chapterMediaSource)

            Log.d(TAG, "Added chapter ${segment.chapterIndex}: '${segment.displayTitle}' " +
                    "(${segment.chapterStartMs}ms-${segment.chapterEndMs}ms, duration=${segment.durationMs}ms)")
        }

        Log.d(TAG, "Built ConcatenatingMediaSource with ${concatenatingMediaSource.size} chapters")
        return concatenatingMediaSource
    }

    /**
     * Creates chapter segments based on the audiobook structure
     */
    private fun createChapterSegments(playbackSession: PlaybackSession): List<ChapterSegment> {
        val segments = mutableListOf<ChapterSegment>()

        when {
            // Multi-file audiobook: each audio file corresponds to a chapter
            playbackSession.audioTracks.size > 1 && playbackSession.chapters.isNotEmpty() -> {
                Log.d(TAG, "Processing multi-file audiobook with ${playbackSession.audioTracks.size} files and ${playbackSession.chapters.size} chapters")
                segments.addAll(createMultiFileSegments(playbackSession))
            }

            // Single-file audiobook with chapter metadata
            playbackSession.audioTracks.size == 1 && playbackSession.chapters.isNotEmpty() -> {
                Log.d(TAG, "Processing single-file audiobook with ${playbackSession.chapters.size} chapters")
                segments.addAll(createSingleFileSegments(playbackSession))
            }

            // Single-file audiobook without chapters (treat as one chapter)
            playbackSession.audioTracks.size == 1 && playbackSession.chapters.isEmpty() -> {
                Log.d(TAG, "Processing single-file audiobook without chapters")
                segments.addAll(createSingleChapterSegment(playbackSession))
            }

            // Multi-file audiobook without chapter metadata (each file is a chapter)
            playbackSession.audioTracks.size > 1 && playbackSession.chapters.isEmpty() -> {
                Log.d(TAG, "Processing multi-file audiobook without chapter metadata")
                segments.addAll(createFileBasedSegments(playbackSession))
            }

            else -> {
                Log.e(TAG, "Unsupported audiobook structure: ${playbackSession.audioTracks.size} files, ${playbackSession.chapters.size} chapters")
            }
        }

        return segments
    }

    /**
     * Creates segments for multi-file audiobooks where files and chapters correspond
     */
    private fun createMultiFileSegments(playbackSession: PlaybackSession): List<ChapterSegment> {
        val segments = mutableListOf<ChapterSegment>()
        var absoluteStartTime = 0L

        playbackSession.audioTracks.forEachIndexed { index, audioTrack ->
            val chapter = playbackSession.chapters.getOrNull(index)
            val audioFileUri = playbackSession.getContentUri(audioTrack)
            val audioFileDurationMs = (audioTrack.duration * 1000).toLong()

            segments.add(
                ChapterSegment(
                    chapterIndex = index,
                    title = chapter?.title,
                    audioFileUri = audioFileUri,
                    chapterStartMs = absoluteStartTime,
                    chapterEndMs = absoluteStartTime + audioFileDurationMs,
                    audioFileStartMs = 0L,
                    audioFileEndMs = audioFileDurationMs,
                    audioFileDurationMs = audioFileDurationMs
                )
            )

            absoluteStartTime += audioFileDurationMs
        }

        return segments
    }

    /**
     * Creates segments for single-file audiobooks with chapter timings
     */
    private fun createSingleFileSegments(playbackSession: PlaybackSession): List<ChapterSegment> {
        val segments = mutableListOf<ChapterSegment>()
        val audioTrack = playbackSession.audioTracks.first()
        val audioFileUri = playbackSession.getContentUri(audioTrack)
        val audioFileDurationMs = (audioTrack.duration * 1000).toLong()

        playbackSession.chapters.forEachIndexed { index, chapter ->
            segments.add(
                ChapterSegment(
                    chapterIndex = index,
                    title = chapter.title,
                    audioFileUri = audioFileUri,
                    chapterStartMs = chapter.startMs,
                    chapterEndMs = chapter.endMs,
                    audioFileStartMs = chapter.startMs,
                    audioFileEndMs = chapter.endMs,
                    audioFileDurationMs = audioFileDurationMs
                )
            )
        }

        return segments
    }

    /**
     * Creates a single segment for audiobooks without chapters
     */
    private fun createSingleChapterSegment(playbackSession: PlaybackSession): List<ChapterSegment> {
        val audioTrack = playbackSession.audioTracks.first()
        val audioFileUri = playbackSession.getContentUri(audioTrack)
        val audioFileDurationMs = (audioTrack.duration * 1000).toLong()

        return listOf(
            ChapterSegment(
                chapterIndex = 0,
                title = playbackSession.displayTitle,
                audioFileUri = audioFileUri,
                chapterStartMs = 0L,
                chapterEndMs = audioFileDurationMs,
                audioFileStartMs = 0L,
                audioFileEndMs = audioFileDurationMs,
                audioFileDurationMs = audioFileDurationMs
            )
        )
    }

    /**
     * Creates segments for multi-file audiobooks without chapter metadata
     */
    private fun createFileBasedSegments(playbackSession: PlaybackSession): List<ChapterSegment> {
        val segments = mutableListOf<ChapterSegment>()
        var absoluteStartTime = 0L

        playbackSession.audioTracks.forEachIndexed { index, audioTrack ->
            val audioFileUri = playbackSession.getContentUri(audioTrack)
            val audioFileDurationMs = (audioTrack.duration * 1000).toLong()

            segments.add(
                ChapterSegment(
                    chapterIndex = index,
                    title = audioTrack.title ?: "Part ${index + 1}",
                    audioFileUri = audioFileUri,
                    chapterStartMs = absoluteStartTime,
                    chapterEndMs = absoluteStartTime + audioFileDurationMs,
                    audioFileStartMs = 0L,
                    audioFileEndMs = audioFileDurationMs,
                    audioFileDurationMs = audioFileDurationMs
                )
            )

            absoluteStartTime += audioFileDurationMs
        }

        return segments
    }

    /**
     * Creates a MediaSource for a single chapter using ClippingMediaSource
     */
    private fun createChapterMediaSource(
        segment: ChapterSegment,
        playbackSession: PlaybackSession
    ): MediaSource {
        // Create the base MediaSource for the audio file
        val baseMediaSource = ProgressiveMediaSource.Factory(dataSourceFactory, extractorsFactory)
            .createMediaSource(
                MediaItem.Builder()
                    .setMediaId("${playbackSession.mediaItemId}_chapter_${segment.chapterIndex}")
                    .setUri(segment.audioFileUri)
                    .setMediaMetadata(createChapterMetadata(segment, playbackSession))
                    .build()
            )

        // If the chapter spans the entire file, return the base MediaSource
        if (segment.spansEntireFile) {
            Log.d(TAG, "Chapter ${segment.chapterIndex} spans entire file, using base MediaSource")
            return baseMediaSource
        }

        // Otherwise, wrap in ClippingMediaSource to clip to chapter boundaries
        Log.d(TAG, "Chapter ${segment.chapterIndex} needs clipping: ${segment.audioFileStartMs}ms to ${segment.audioFileEndMs}ms")
        return ClippingMediaSource(
            baseMediaSource,
            segment.audioFileStartMs * 1000, // Convert to microseconds
            segment.audioFileEndMs * 1000     // Convert to microseconds
        )
    }

    /**
     * Creates MediaMetadata for a chapter
     */
    private fun createChapterMetadata(
        segment: ChapterSegment,
        playbackSession: PlaybackSession
    ): MediaMetadata {
        return MediaMetadata.Builder()
            .setTitle(segment.displayTitle)
            .setSubtitle(playbackSession.displayTitle ?: "Unknown Book")
            .setArtist(playbackSession.displayAuthor ?: "Unknown Author")
            .setAlbumTitle(playbackSession.displayTitle ?: "Unknown Book")
            .setTrackNumber(segment.chapterIndex + 1)
            .setDurationMs(segment.durationMs) // Set chapter duration for Android Auto timeline
            .setIsPlayable(true)
            .build()
    }
}
