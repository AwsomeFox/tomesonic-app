package com.audiobookshelf.app.player.mediasource

import android.content.Context
import android.net.Uri
import android.util.Log
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.MimeTypes
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.source.ClippingMediaSource
import androidx.media3.exoplayer.source.ConcatenatingMediaSource
import androidx.media3.exoplayer.source.MediaSource
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import androidx.media3.extractor.DefaultExtractorsFactory
import androidx.media3.extractor.mp3.Mp3Extractor
import androidx.media3.extractor.mp4.Mp4Extractor
import androidx.media3.extractor.wav.WavExtractor
import androidx.media3.extractor.flac.FlacExtractor
import androidx.media3.extractor.ogg.OggExtractor
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
        Log.d(TAG, "Creating enhanced DefaultExtractorsFactory with comprehensive audio format support")

        DefaultExtractorsFactory()
            .setConstantBitrateSeekingEnabled(true)  // Better seeking for audio files
            .setFlacExtractorFlags(FlacExtractor.FLAG_DISABLE_ID3_METADATA) // Better FLAC support
            .setMp3ExtractorFlags(Mp3Extractor.FLAG_ENABLE_CONSTANT_BITRATE_SEEKING) // Better MP3 support
    }

    // Store the last created chapter segments for external access
    private var lastChapterSegments: List<ChapterSegment> = emptyList()

    /**
     * Get the chapter segments from the last built MediaSource
     */
    fun getLastChapterSegments(): List<ChapterSegment> = lastChapterSegments

    /**
     * Builds a complete MediaSource for an audiobook with chapter-based MediaItems
     * @param playbackSession The playback session containing audiobook data
     * @param forCast Whether to build MediaSource for cast (uses server URIs) or local playback
     */
    fun buildMediaSource(playbackSession: PlaybackSession, forCast: Boolean = false): MediaSource? {
        Log.d("NUXT_SKIP_DEBUG", "buildMediaSource: Building for '${playbackSession.displayTitle}' (forCast: $forCast)")
        Log.d("NUXT_SKIP_DEBUG", "buildMediaSource: ${playbackSession.audioTracks.size} audio tracks, ${playbackSession.chapters.size} chapters")

        if (playbackSession.audioTracks.isEmpty()) {
            Log.e("NUXT_SKIP_DEBUG", "buildMediaSource: No audio tracks found in playback session")
            return null
        }

        // Log each audio track for format debugging
        playbackSession.audioTracks.forEachIndexed { index, track ->
            val uri = if (forCast) {
                playbackSession.getServerContentUri(track)
            } else {
                playbackSession.getContentUri(track)
            }
            Log.d("NUXT_SKIP_DEBUG", "buildMediaSource: Track $index: '${track.title}' URI: $uri")
        }

        // Create chapter segments from the playback session
        val chapterSegments = createChapterSegments(playbackSession, forCast)
        if (chapterSegments.isEmpty()) {
            Log.e("NUXT_SKIP_DEBUG", "buildMediaSource: No chapter segments could be created")
            return null
        }

        // Store segments for external access
        lastChapterSegments = chapterSegments

        Log.d("NUXT_SKIP_DEBUG", "buildMediaSource: Created ${chapterSegments.size} chapter segments")

        // Build the concatenating MediaSource
        val concatenatingMediaSource = ConcatenatingMediaSource()

        chapterSegments.forEach { segment ->
            Log.d("NUXT_SKIP_DEBUG", "buildMediaSource: Creating MediaSource for chapter ${segment.chapterIndex}: '${segment.displayTitle}'")
            try {
                val chapterMediaSource = createChapterMediaSource(segment, playbackSession)
                concatenatingMediaSource.addMediaSource(chapterMediaSource)
                Log.d("NUXT_SKIP_DEBUG", "buildMediaSource: Successfully added chapter ${segment.chapterIndex} MediaSource")
            } catch (e: Exception) {
                Log.e("NUXT_SKIP_DEBUG", "buildMediaSource: Failed to create MediaSource for chapter ${segment.chapterIndex}: ${e.javaClass.simpleName}: ${e.message}")
                Log.e("NUXT_SKIP_DEBUG", "buildMediaSource: Chapter ${segment.chapterIndex} exception:", e)
                throw e  // Re-throw to prevent partial MediaSource creation
            }

            Log.d(TAG, "Added chapter ${segment.chapterIndex}: '${segment.displayTitle}' " +
                    "(${segment.chapterStartMs}ms-${segment.chapterEndMs}ms, duration=${segment.durationMs}ms)")
        }

        Log.d("NUXT_SKIP_DEBUG", "buildMediaSource: Successfully built ConcatenatingMediaSource with ${concatenatingMediaSource.size} chapters")
        return concatenatingMediaSource
    }

    /**
     * Creates chapter segments based on the audiobook structure
     * @param playbackSession The playback session containing audiobook data
     * @param forCast Whether to use server URIs (for cast) or local URIs (for local playback)
     */
    private fun createChapterSegments(playbackSession: PlaybackSession, forCast: Boolean = false): List<ChapterSegment> {
        val segments = mutableListOf<ChapterSegment>()

        when {
            // Audiobook with chapters - create segments based purely on chapters
            playbackSession.chapters.isNotEmpty() -> {
                Log.d(TAG, "Processing audiobook with ${playbackSession.chapters.size} chapters")
                segments.addAll(createChapterBasedSegments(playbackSession, forCast))
            }

            // Audiobook without chapters - fallback to track-based segments
            playbackSession.chapters.isEmpty() -> {
                Log.d(TAG, "Processing audiobook without chapters, using ${playbackSession.audioTracks.size} tracks")
                segments.addAll(createTrackBasedSegments(playbackSession, forCast))
            }

            else -> {
                Log.e(TAG, "Unsupported audiobook structure")
            }
        }

        return segments
    }

    /**
     * Public method to access chapter segments for player navigation
     */
    fun getChapterSegments(playbackSession: PlaybackSession): List<ChapterSegment> {
        return createChapterSegments(playbackSession)
    }

    fun getChapterSegments(playbackSession: PlaybackSession, forCast: Boolean): List<ChapterSegment> {
        return createChapterSegments(playbackSession, forCast)
    }

    /**
     * Creates segments based purely on chapters, determining which audio tracks contain each chapter
     * @param playbackSession The playback session containing audiobook data
     * @param forCast Whether to use server URIs (for cast) or local URIs (for local playback)
     */
    private fun createChapterBasedSegments(playbackSession: PlaybackSession, forCast: Boolean = false): List<ChapterSegment> {
        val segments = mutableListOf<ChapterSegment>()

        playbackSession.chapters.forEachIndexed { index, chapter ->
            // Find which audio track(s) contain this chapter
            val containingTrack = findTrackContainingTime(playbackSession, chapter.startMs)

            if (containingTrack != null) {
                // Use appropriate URI method based on target player
                val audioFileUri = if (forCast) {
                    playbackSession.getServerContentUri(containingTrack)
                } else {
                    playbackSession.getContentUri(containingTrack)
                }

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
     * @param playbackSession The playback session containing audiobook data
     * @param forCast Whether to use server URIs (for cast) or local URIs (for local playback)
     */
    private fun createTrackBasedSegments(playbackSession: PlaybackSession, forCast: Boolean = false): List<ChapterSegment> {
        val segments = mutableListOf<ChapterSegment>()

        playbackSession.audioTracks.forEachIndexed { index, audioTrack ->
            // Use appropriate URI method based on target player
            val audioFileUri = if (forCast) {
                playbackSession.getServerContentUri(audioTrack)
            } else {
                playbackSession.getContentUri(audioTrack)
            }
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
        // Log detailed format information for debugging
        val audioFileUri = segment.audioFileUri
        val fileName = audioFileUri.lastPathSegment ?: audioFileUri.toString()
        val detectedMimeType = when {
            fileName.contains(".mp3", ignoreCase = true) -> MimeTypes.AUDIO_MPEG
            fileName.contains(".m4a", ignoreCase = true) -> MimeTypes.AUDIO_MP4
            fileName.contains(".mp4", ignoreCase = true) -> MimeTypes.AUDIO_MP4
            fileName.contains(".aac", ignoreCase = true) -> MimeTypes.AUDIO_AAC
            fileName.contains(".flac", ignoreCase = true) -> "audio/flac"
            fileName.contains(".ogg", ignoreCase = true) -> "audio/ogg"
            fileName.contains(".wav", ignoreCase = true) -> "audio/wav"
            else -> "audio/unknown"
        }

        Log.d("NUXT_SKIP_DEBUG", "createChapterMediaSource: Creating MediaSource for chapter ${segment.chapterIndex}:")
        Log.d("NUXT_SKIP_DEBUG", "createChapterMediaSource:   - URI: $audioFileUri")
        Log.d("NUXT_SKIP_DEBUG", "createChapterMediaSource:   - File: $fileName")
        Log.d("NUXT_SKIP_DEBUG", "createChapterMediaSource:   - Detected MIME type: $detectedMimeType")
        Log.d("NUXT_SKIP_DEBUG", "createChapterMediaSource:   - Spans entire file: ${segment.spansEntireFile}")
        Log.d("NUXT_SKIP_DEBUG", "createChapterMediaSource:   - Chapter range: ${segment.audioFileStartMs}ms - ${segment.audioFileEndMs}ms")

        // Create the base MediaSource for the audio file
        val mediaItemBuilder = MediaItem.Builder()
            .setMediaId("${playbackSession.mediaItemId}_chapter_${segment.chapterIndex}")
            .setUri(segment.audioFileUri)
            .setMediaMetadata(createChapterMetadata(segment, playbackSession))

        // Set MIME type if we can detect it to help the extractor
        if (detectedMimeType != "audio/unknown") {
            Log.d("NUXT_SKIP_DEBUG", "createChapterMediaSource:   - Setting MIME type hint: $detectedMimeType")
            mediaItemBuilder.setMimeType(detectedMimeType)
        }

        try {
            Log.d("NUXT_SKIP_DEBUG", "createChapterMediaSource: Creating ProgressiveMediaSource with enhanced extractors")
            val baseMediaSource = ProgressiveMediaSource.Factory(dataSourceFactory, extractorsFactory)
                .createMediaSource(mediaItemBuilder.build())
            Log.d("NUXT_SKIP_DEBUG", "createChapterMediaSource: ProgressiveMediaSource created successfully")

            // If the chapter spans the entire file, return the base MediaSource
            if (segment.spansEntireFile) {
                Log.d("NUXT_SKIP_DEBUG", "createChapterMediaSource: Chapter ${segment.chapterIndex} spans entire file, using base MediaSource")
                return baseMediaSource
            }

            // Otherwise, wrap in ClippingMediaSource to clip to chapter boundaries
            Log.d("NUXT_SKIP_DEBUG", "createChapterMediaSource: Chapter ${segment.chapterIndex} needs clipping: ${segment.audioFileStartMs}ms to ${segment.audioFileEndMs}ms")
            val clippingMediaSource = ClippingMediaSource(
                baseMediaSource,
                segment.audioFileStartMs * 1000, // Convert to microseconds
                segment.audioFileEndMs * 1000     // Convert to microseconds
            )
            Log.d("NUXT_SKIP_DEBUG", "createChapterMediaSource: ClippingMediaSource created successfully")
            return clippingMediaSource
        } catch (e: Exception) {
            Log.e("NUXT_SKIP_DEBUG", "createChapterMediaSource: Failed to create MediaSource for chapter ${segment.chapterIndex}: ${e.javaClass.simpleName}: ${e.message}")
            Log.e("NUXT_SKIP_DEBUG", "createChapterMediaSource: Full exception:", e)
            throw e
        }
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
