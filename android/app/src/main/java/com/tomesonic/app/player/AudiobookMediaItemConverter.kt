package com.tomesonic.app.player

import android.util.Log
import androidx.media3.cast.MediaItemConverter
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import com.google.android.gms.cast.MediaInfo
import com.google.android.gms.cast.MediaQueueItem
import com.google.android.gms.cast.MediaMetadata as CastMediaMetadata
import com.tomesonic.app.utils.MimeTypeUtil
import org.json.JSONObject

/**
 * Custom MediaItemConverter that properly handles ClippingConfiguration for audiobook chapters.
 * This ensures cast devices receive proper chapter timing information instead of full file duration.
 */
class AudiobookMediaItemConverter : MediaItemConverter {

    override fun toMediaItem(mediaQueueItem: MediaQueueItem): MediaItem {
        // Convert from Cast MediaQueueItem back to Media3 MediaItem
        // This is used when resuming cast sessions or receiving media from cast devices

        val mediaInfo = mediaQueueItem.media ?: throw IllegalArgumentException("MediaQueueItem must have MediaInfo")

        // ContentId is now the actual URI - no parsing needed
        val contentId = mediaInfo.contentId
        val customData = mediaInfo.customData

        Log.d("AudiobookConverter", "Converting Cast MediaInfo back to MediaItem - URI: $contentId")

        val mediaItemBuilder = MediaItem.Builder()
            .setUri(contentId)

        // Extract custom data if present
        if (customData != null) {
            val startMs = customData.optLong("startMs", 0)
            val endMs = customData.optLong("endMs", -1)

            if (endMs > startMs) {
                mediaItemBuilder.setClippingConfiguration(
                    MediaItem.ClippingConfiguration.Builder()
                        .setStartPositionMs(startMs)
                        .setEndPositionMs(endMs)
                        .build()
                )
                Log.d("AudiobookConverter", "Restored clipping config: ${startMs}ms to ${endMs}ms for URI: $contentId")
            }

            // Restore mediaId if available
            val mediaId = customData.optString("mediaId", null)
            if (!mediaId.isNullOrEmpty() && mediaId != "unknown") {
                mediaItemBuilder.setMediaId(mediaId)
            }
        }

        // Build MediaMetadata from Cast metadata
        val castMetadata = mediaInfo.metadata
        if (castMetadata != null) {
            val metadataBuilder = MediaMetadata.Builder()

            castMetadata.getString(CastMediaMetadata.KEY_TITLE)?.let {
                metadataBuilder.setTitle(it)
            }
            castMetadata.getString(CastMediaMetadata.KEY_SUBTITLE)?.let {
                metadataBuilder.setArtist(it)
            }
            castMetadata.getString(CastMediaMetadata.KEY_ALBUM_TITLE)?.let {
                metadataBuilder.setAlbumTitle(it)
            }

            // Extract track number and total from custom data
            customData?.let { data ->
                val trackNumber = data.optInt("trackNumber", 0)
                val totalTracks = data.optInt("totalTracks", 0)
                if (trackNumber > 0) metadataBuilder.setTrackNumber(trackNumber)
                if (totalTracks > 0) metadataBuilder.setTotalTrackCount(totalTracks)
            }

            mediaItemBuilder.setMediaMetadata(metadataBuilder.build())
        }

        return mediaItemBuilder.build()
    }

    override fun toMediaQueueItem(mediaItem: MediaItem): MediaQueueItem {
        // Convert from Media3 MediaItem to Cast MediaQueueItem
        // This is the critical part that fixes the chapter duration issue

        val uri = mediaItem.localConfiguration?.uri?.toString()
            ?: throw IllegalArgumentException("MediaItem must have a URI")

        val clippingConfig = mediaItem.clippingConfiguration

        // Use the actual URI as contentId so Cast receiver can load the file directly
        // Chapter uniqueness will be handled by the Cast framework via MediaQueueItem ordering
        // and custom data timing information
        Log.d("AudiobookConverter", "Using actual URI as contentId: $uri")

        // Use the actual URI - Cast receiver can load this directly
        val mediaInfoBuilder = MediaInfo.Builder(uri)
            .setStreamType(MediaInfo.STREAM_TYPE_BUFFERED)
            .setContentType(MimeTypeUtil.getMimeType(uri))

        // Handle ClippingConfiguration - this is the key fix
        val customData = JSONObject()

        if (clippingConfig != null) {
            // Pass chapter timing to cast device via custom data
            customData.put("startMs", clippingConfig.startPositionMs)
            customData.put("endMs", clippingConfig.endPositionMs)

            // Set the stream duration to the chapter duration for proper UI display
            val chapterDurationMs = clippingConfig.endPositionMs - clippingConfig.startPositionMs
            mediaInfoBuilder.setStreamDuration(chapterDurationMs)

            Log.d("AudiobookConverter", "Chapter clip: ${clippingConfig.startPositionMs}ms to ${clippingConfig.endPositionMs}ms (duration: ${chapterDurationMs}ms)")
        } else {
            // Fallback to full duration if no clipping
            mediaItem.mediaMetadata.durationMs?.let { durationMs ->
                if (durationMs > 0) {
                    mediaInfoBuilder.setStreamDuration(durationMs)
                    Log.d("AudiobookConverter", "No clipping - using full duration: ${durationMs}ms")
                }
            }
        }

        // Build Cast MediaMetadata from Media3 metadata
        val media3Metadata = mediaItem.mediaMetadata
        val castMetadata = CastMediaMetadata(CastMediaMetadata.MEDIA_TYPE_AUDIOBOOK_CHAPTER)

        media3Metadata.title?.let {
            castMetadata.putString(CastMediaMetadata.KEY_TITLE, it.toString())
        }
        media3Metadata.artist?.let {
            castMetadata.putString(CastMediaMetadata.KEY_SUBTITLE, it.toString())
        }
        media3Metadata.albumTitle?.let {
            castMetadata.putString(CastMediaMetadata.KEY_ALBUM_TITLE, it.toString())
        }

        // Add artwork images for Cast receiver display
        media3Metadata.artworkUri?.let { artworkUri ->
            val image = com.google.android.gms.common.images.WebImage(
                android.net.Uri.parse(artworkUri.toString())
            )
            castMetadata.addImage(image)
            Log.d("AudiobookConverter", "Added artwork image to Cast metadata: $artworkUri")
        }

        // Add track information to custom data for proper playlist handling
        media3Metadata.trackNumber?.let {
            customData.put("trackNumber", it)
        }
        media3Metadata.totalTrackCount?.let {
            customData.put("totalTracks", it)
        }

        // Add additional debugging information
        customData.put("isChapter", clippingConfig != null)
        customData.put("mediaId", mediaItem.mediaId ?: "unknown")

        // Add Media Browse API configuration for cast receiver
        // This enables the cast receiver to browse libraries, collections, etc.
        val serverUrl = com.tomesonic.app.device.DeviceManager.serverAddress

        Log.d("AudiobookConverter", "DeviceManager state - serverUrl: '$serverUrl'")
        Log.d("AudiobookConverter", "DeviceManager isConnectedToServer: ${com.tomesonic.app.device.DeviceManager.isConnectedToServer}")

        if (serverUrl.isEmpty()) {
            Log.w("AudiobookConverter", "Server URL is empty - Cast receiver Media Browse API will not work")
        }

        customData.put("serverUrl", serverUrl)
        // Note: Token authentication removed - v2.22.0+ uses session-based URLs

        // Extract libraryId from mediaId if available (format: libraryItemId_chapter_N)
        // For the Media Browse API, we need the library ID to browse content
        val mediaId = mediaItem.mediaId ?: ""
        if (mediaId.isNotEmpty()) {
            // Try to get library context from extras if available
            val extras = mediaItem.mediaMetadata.extras
            val libraryId = extras?.getString("libraryId")
            if (libraryId != null) {
                customData.put("libraryId", libraryId)
                Log.d("AudiobookConverter", "Added Media Browse API config: serverUrl=${com.tomesonic.app.device.DeviceManager.serverAddress}, libraryId=$libraryId")
            } else {
                // Fallback: use a default library ID if we can't determine it
                // The cast receiver can still function without this, but browsing may be limited
                customData.put("libraryId", "")
                Log.w("AudiobookConverter", "No libraryId found in metadata extras for mediaId: $mediaId")
            }
        }

        val mediaInfo = mediaInfoBuilder
            .setMetadata(castMetadata)
            .setCustomData(customData)
            .build()

        // Create MediaQueueItem with the MediaInfo
        val queueItem = MediaQueueItem.Builder(mediaInfo).build()

        Log.d("AudiobookConverter", "Created MediaQueueItem for '${media3Metadata.title}' with unique contentId, duration ${mediaInfo.streamDuration}ms")

        return queueItem
    }

}
