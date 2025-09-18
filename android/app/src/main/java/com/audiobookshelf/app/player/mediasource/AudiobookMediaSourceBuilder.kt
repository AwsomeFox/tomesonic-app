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
            // Audiobook with chapters - create segments based purely on chapters
            playbackSession.chapters.isNotEmpty() -> {
                Log.d(TAG, "Processing audiobook with ${playbackSession.chapters.size} chapters")
                segments.addAll(createChapterBasedSegments(playbackSession))
            }

            // Audiobook without chapters - fallback to track-based segments
            playbackSession.chapters.isEmpty() -> {
                Log.d(TAG, "Processing audiobook without chapters, using ${playbackSession.audioTracks.size} tracks")
                segments.addAll(createTrackBasedSegments(playbackSession))
            }

            else -> {
                Log.e(TAG, "Unsupported audiobook structure")
            }
        }

        return segments
    }

    /**
     * Creates segments based purely on chapters, determining which audio tracks contain each chapter
     */
    private fun createChapterBasedSegments(playbackSession: PlaybackSession): List<ChapterSegment> {
        val segments = mutableListOf<ChapterSegment>()

        playbackSession.chapters.forEachIndexed { index, chapter ->
            // Find which audio track(s) contain this chapter
            val containingTrack = findTrackContainingTime(playbackSession, chapter.startMs)

            if (containingTrack != null) {
                val audioFileUri = playbackSession.getContentUri(containingTrack)

                // Calculate the chapter's position within the audio file
                val chapterStartInFile = chapter.startMs - containingTrack.startOffsetMs
                val chapterEndInFile = chapter.endMs - containingTrack.startOffsetMs

                segments.add(
                    ChapterSegment(
                        chapterIndex = index,
                        title = chapter.title,
                        audioFileUri = audioFileUri,
                        chapterStartMs = chapter.startMs,
                        chapterEndMs = chapter.endMs,
                        audioFileStartMs = chapterStartInFile,
                        audioFileEndMs = chapterEndInFile,
                        audioFileDurationMs = (containingTrack.duration * 1000).toLong()
                    )
                )

                Log.d(TAG, "Chapter $index '${chapter.title}' -> Track ${containingTrack.index} " +
                        "(${chapterStartInFile}ms-${chapterEndInFile}ms in file)")
            } else {
                Log.w(TAG, "Could not find audio track containing chapter $index at ${chapter.startMs}ms")
            }
        }

        return segments
    }

    /**
     * Find the audio track that contains the given absolute time position
     */
    private fun findTrackContainingTime(playbackSession: PlaybackSession, timeMs: Long): AudioTrack? {
        return playbackSession.audioTracks.find { track ->
            timeMs >= track.startOffsetMs && timeMs < track.startOffsetMs + (track.duration * 1000).toLong()
        }
    }

    /**
     * Creates segments based on tracks when no chapter metadata is available
     */
    private fun createTrackBasedSegments(playbackSession: PlaybackSession): List<ChapterSegment> {
        val segments = mutableListOf<ChapterSegment>()

        playbackSession.audioTracks.forEachIndexed { index, audioTrack ->
            val audioFileUri = playbackSession.getContentUri(audioTrack)
            val audioFileDurationMs = (audioTrack.duration * 1000).toLong()

            segments.add(
                ChapterSegment(
                    chapterIndex = index,
                    title = audioTrack.title ?: "Part ${index + 1}",
                    audioFileUri = audioFileUri,
                    chapterStartMs = audioTrack.startOffsetMs,
                    chapterEndMs = audioTrack.startOffsetMs + audioFileDurationMs,
                    audioFileStartMs = 0L,
                    audioFileEndMs = audioFileDurationMs,
                    audioFileDurationMs = audioFileDurationMs
                )
            )
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
     * Creates MediaMetadata for a chapter using the PlaybackSession's library metadata
     */
    private fun createChapterMetadata(
        segment: ChapterSegment,
        playbackSession: PlaybackSession
    ): MediaMetadata {
        // Get the base metadata from PlaybackSession which includes proper cover image and library metadata
        val chapter = playbackSession.chapters.getOrNull(segment.chapterIndex)
        val baseMetadata = playbackSession.getExoMediaMetadata(context, null, chapter, segment.chapterIndex)

        // Create a new metadata builder using the library metadata fields
        return MediaMetadata.Builder()
            .setTitle(baseMetadata.title)
            .setSubtitle(baseMetadata.subtitle)
            .setArtist(baseMetadata.artist)
            .setAlbumArtist(baseMetadata.albumArtist)
            .setAlbumTitle(baseMetadata.albumTitle)
            .setDescription(baseMetadata.description)
            .setArtworkUri(baseMetadata.artworkUri) // This includes the library cover image
            .setMediaType(baseMetadata.mediaType)
            .setTrackNumber(segment.chapterIndex + 1)
            .setDurationMs(segment.durationMs) // Set chapter duration for Android Auto timeline
            .setIsPlayable(true)
            .build()
    }
}
