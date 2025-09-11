package com.audiobookshelf.app.data

import android.content.Context
import android.graphics.ImageDecoder
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.support.v4.media.MediaDescriptionCompat
import android.support.v4.media.MediaMetadataCompat
import android.util.Log
import androidx.core.content.FileProvider
import androidx.core.net.toFile
import com.audiobookshelf.app.BuildConfig
import com.audiobookshelf.app.R
import com.audiobookshelf.app.device.DeviceManager
import com.audiobookshelf.app.media.MediaProgressSyncData
import com.audiobookshelf.app.player.*
import com.fasterxml.jackson.annotation.JsonIgnore
import com.fasterxml.jackson.annotation.JsonIgnoreProperties
import com.google.android.exoplayer2.MediaItem
import com.google.android.exoplayer2.MediaMetadata
import com.google.android.gms.cast.MediaInfo
import com.google.android.gms.cast.MediaQueueItem
import com.google.android.gms.common.images.WebImage

// Android Auto package names for URI permission granting
private const val ANDROID_AUTO_PKG_NAME = "com.google.android.projection.gearhead"
private const val ANDROID_AUTO_SIMULATOR_PKG_NAME = "com.google.android.projection.gearhead.emulator"
private const val ANDROID_AUTOMOTIVE_PKG_NAME = "com.google.android.projection.gearhead.phone"

@JsonIgnoreProperties(ignoreUnknown = true)
class PlaybackSession(
        var id: String,
        var userId: String?,
        var libraryItemId: String?,
        var episodeId: String?,
        var mediaType: String,
        var mediaMetadata: MediaTypeMetadata,
        var deviceInfo: DeviceInfo,
        var chapters: List<BookChapter>,
        var displayTitle: String?,
        var displayAuthor: String?,
        var coverPath: String?,
        var duration: Double,
        var playMethod: Int,
        var startedAt: Long,
        var updatedAt: Long,
        var timeListening: Long,
        var audioTracks: MutableList<AudioTrack>,
        var currentTime: Double,
        var libraryItem: LibraryItem?,
        var localLibraryItem: LocalLibraryItem?,
        var localEpisodeId: String?,
        var serverConnectionConfigId: String?,
        var serverAddress: String?,
        var mediaPlayer: String?
) {

  @get:JsonIgnore
  val isHLS
    get() = playMethod == PLAYMETHOD_TRANSCODE
  @get:JsonIgnore
  val isDirectPlay
    get() = playMethod == PLAYMETHOD_DIRECTPLAY
  @get:JsonIgnore
  val isLocal
    get() = playMethod == PLAYMETHOD_LOCAL
  @get:JsonIgnore
  val isPodcastEpisode
    get() = mediaType == "podcast"
  @get:JsonIgnore
  val currentTimeMs
    get() = (currentTime * 1000L).toLong()
  @get:JsonIgnore
  val totalDurationMs
    get() = (getTotalDuration() * 1000L).toLong()
  @get:JsonIgnore
  val localLibraryItemId
    get() = localLibraryItem?.id ?: ""
  @get:JsonIgnore
  val localMediaProgressId
    get() =
            if (localEpisodeId.isNullOrEmpty()) localLibraryItemId
            else "$localLibraryItemId-$localEpisodeId"
  @get:JsonIgnore
  val progress
    get() = currentTime / getTotalDuration()
  @get:JsonIgnore
  val mediaItemId
    get() = if (episodeId.isNullOrEmpty()) libraryItemId ?: "" else "$libraryItemId-$episodeId"

  @JsonIgnore
  fun getCurrentTrackIndex(): Int {
    for (i in 0 until audioTracks.size) {
      val track = audioTracks[i]
      if (currentTimeMs >= track.startOffsetMs && (track.endOffsetMs > currentTimeMs)) {
        return i
      }
    }
    return audioTracks.size - 1
  }

  @JsonIgnore
  fun getNextTrackIndex(): Int {
    for (i in 0 until audioTracks.size) {
      val track = audioTracks[i]
      if (currentTimeMs < track.startOffsetMs) {
        return i
      }
    }
    return audioTracks.size - 1
  }

  @JsonIgnore
  fun getChapterForTime(time: Long): BookChapter? {
    if (chapters.isEmpty()) return null
    return chapters.find { time >= it.startMs && it.endMs > time }
  }

  @JsonIgnore
  fun getCurrentTrackEndTime(): Long {
    val currentTrack = audioTracks[this.getCurrentTrackIndex()]
    return currentTrack.startOffsetMs + currentTrack.durationMs
  }

  @JsonIgnore
  fun getNextChapterForTime(time: Long): BookChapter? {
    if (chapters.isEmpty()) return null
    return chapters.find { time < it.startMs } // First chapter where start time is > then time
  }

  @JsonIgnore
  fun getNextTrackEndTime(): Long {
    val currentTrack = audioTracks[this.getNextTrackIndex()]
    return currentTrack.startOffsetMs + currentTrack.durationMs
  }

  @JsonIgnore
  fun getCurrentTrackTimeMs(): Long {
    val currentTrack = audioTracks[this.getCurrentTrackIndex()]
    val time = currentTime - currentTrack.startOffset
    return (time * 1000L).toLong()
  }

  @JsonIgnore
  fun getTrackStartOffsetMs(index: Int): Long {
    if (index < 0 || index >= audioTracks.size) return 0L
    val currentTrack = audioTracks[index]
    return (currentTrack.startOffset * 1000L).toLong()
  }

  @JsonIgnore
  fun getTotalDuration(): Double {
    var total = 0.0
    audioTracks.forEach { total += it.duration }
    return total
  }

  @JsonIgnore
  fun checkIsServerVersionGte(compareVersion: String): Boolean {
    // Safety check this playback session is the same one currently connected (should always be)
    if (DeviceManager.serverConnectionConfigId != serverConnectionConfigId) {
      return false
    }

    return DeviceManager.isServerVersionGreaterThanOrEqualTo(compareVersion)
  }

  @JsonIgnore
  fun getCoverUri(ctx: Context): Uri {
    Log.d("PlaybackSession", "getCoverUri called - localLibraryItem: ${localLibraryItem != null}, coverContentUrl: ${localLibraryItem?.coverContentUrl}")
    Log.d("PlaybackSession", "getCoverUri - coverPath: $coverPath, serverAddress: $serverAddress, libraryItemId: $libraryItemId")

    if (localLibraryItem?.coverContentUrl != null) {
      var coverUri = Uri.parse(localLibraryItem?.coverContentUrl.toString())
      Log.d("PlaybackSession", "getCoverUri - Using local cover URL: $coverUri")
      if (coverUri.toString().startsWith("file:")) {
        coverUri =
                FileProvider.getUriForFile(
                        ctx,
                        "${BuildConfig.APPLICATION_ID}.fileprovider",
                        coverUri.toFile()
                )
        Log.d("PlaybackSession", "getCoverUri - Converted file URI to content URI: $coverUri")

        // Grant URI permissions to Android Auto packages so they can access the content
        try {
          val androidAutoPackages = arrayOf(
            ANDROID_AUTO_PKG_NAME,
            ANDROID_AUTO_SIMULATOR_PKG_NAME,
            ANDROID_AUTOMOTIVE_PKG_NAME
          )

          for (packageName in androidAutoPackages) {
            ctx.grantUriPermission(packageName, coverUri, android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
            Log.d("PlaybackSession", "getCoverUri - Granted read permission to $packageName for URI: $coverUri")
          }
        } catch (e: Exception) {
          Log.w("PlaybackSession", "getCoverUri - Failed to grant URI permissions: ${e.message}")
        }
      }

      return coverUri
              ?: Uri.parse("android.resource://${BuildConfig.APPLICATION_ID}/" + R.drawable.icon)
    }

    if (coverPath == null) {
      Log.d("PlaybackSession", "getCoverUri - No cover path, using default icon")
      return Uri.parse("android.resource://${BuildConfig.APPLICATION_ID}/" + R.drawable.icon)
    }

    // As of v2.17.0 token is not needed with cover image requests
    if (checkIsServerVersionGte("2.17.0")) {
      val serverUri = Uri.parse("$serverAddress/api/items/$libraryItemId/cover")
      Log.d("PlaybackSession", "getCoverUri - Using server URI (v2.17.0+): $serverUri")
      return serverUri
    }
    val serverUriWithToken = Uri.parse("$serverAddress/api/items/$libraryItemId/cover?token=${DeviceManager.token}")
    Log.d("PlaybackSession", "getCoverUri - Using server URI with token: $serverUriWithToken")
    return serverUriWithToken
  }

  @JsonIgnore
  fun getContentUri(audioTrack: AudioTrack): Uri {
    if (isLocal) return Uri.parse(audioTrack.contentUrl) // Local content url
    // As of v2.22.0 tracks use a different endpoint
    // See: https://github.com/advplyr/audiobookshelf/pull/4263
    if (checkIsServerVersionGte("2.22.0")) {
      return if (isDirectPlay) {
        Uri.parse("$serverAddress/public/session/$id/track/${audioTrack.index}")
      } else {
        // Transcode uses HlsRouter on server
        Uri.parse("$serverAddress${audioTrack.contentUrl}")
      }
    }
    return Uri.parse("$serverAddress${audioTrack.contentUrl}?token=${DeviceManager.token}")
  }

  @JsonIgnore
  fun getMediaMetadataCompat(ctx: Context): MediaMetadataCompat {
    val coverUri = getCoverUri(ctx)
    // Prefer chapter/track title for now-playing if available
    val currentTrackIndex = try { getCurrentTrackIndex() } catch (e: Exception) { -1 }
    val currentTrack = if (currentTrackIndex >= 0 && currentTrackIndex < audioTracks.size) audioTracks[currentTrackIndex] else null
    val nowPlayingTitle = currentTrack?.title ?: displayTitle
    val nowPlayingSubtitle = if (currentTrack?.title != null) displayAuthor else displayAuthor

    // Create MediaDescriptionCompat with proper bitmap handling for Android Auto
    val descriptionBuilder = android.support.v4.media.MediaDescriptionCompat.Builder()
      .setMediaId(id)
      .setTitle(nowPlayingTitle)
      .setSubtitle(nowPlayingSubtitle)
      .setDescription(displayAuthor)

    // Handle images differently for local vs server books
    var bitmap: android.graphics.Bitmap? = null
    if (localLibraryItem?.coverContentUrl != null) {
      // Local books: Use bitmap approach for Android Auto compatibility
      // Note: In Android Auto for local cover images, setting the icon uri to a local path does not work (cover is blank)
      // so we create and set the bitmap here instead of letting AbMediaDescriptionAdapter handle it
      try {
        Log.d("PlaybackSession", "getMediaMetadataCompat - Loading bitmap for local book")
        bitmap = if (Build.VERSION.SDK_INT < 28) {
          MediaStore.Images.Media.getBitmap(ctx.contentResolver, coverUri)
        } else {
          val source: ImageDecoder.Source = ImageDecoder.createSource(ctx.contentResolver, coverUri)
          ImageDecoder.decodeBitmap(source)
        }
        Log.d("PlaybackSession", "getMediaMetadataCompat - Bitmap loaded successfully: ${bitmap != null}, size: ${bitmap?.width}x${bitmap?.height}")
        descriptionBuilder.setIconBitmap(bitmap)
        Log.d("PlaybackSession", "getMediaMetadataCompat - Set bitmap on description")
      } catch (e: Exception) {
        Log.w("PlaybackSession", "Failed to load bitmap for local book: ${e.message}")
        descriptionBuilder.setIconUri(coverUri)
      }
    } else {
      // Server books: Use URI approach (Android Auto can access HTTP URLs)
      Log.d("PlaybackSession", "getMediaMetadataCompat - Using URI approach for server book")
      descriptionBuilder.setIconUri(coverUri)
    }

    val description = descriptionBuilder.build()

    val metadataBuilder = MediaMetadataCompat.Builder()
      .putString(MediaMetadataCompat.METADATA_KEY_TITLE, nowPlayingTitle)
      .putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_TITLE, nowPlayingTitle)
      .putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_SUBTITLE, nowPlayingSubtitle)
      .putString(MediaMetadataCompat.METADATA_KEY_AUTHOR, displayAuthor)
      .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, displayAuthor)
      .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, displayAuthor)
      .putString(MediaMetadataCompat.METADATA_KEY_ALBUM_ARTIST, displayAuthor)
      .putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_DESCRIPTION, displayAuthor)
      .putString(MediaMetadataCompat.METADATA_KEY_MEDIA_ID, id)

    // Set the description with proper bitmap/URI handling
    metadataBuilder.putString(MediaMetadataCompat.METADATA_KEY_MEDIA_ID, description.mediaId)

    // Also set bitmap in metadata keys for fallback
    if (bitmap != null) {
      Log.d("PlaybackSession", "getMediaMetadataCompat - Setting bitmap in metadata keys")
      metadataBuilder.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, bitmap)
      metadataBuilder.putBitmap(MediaMetadataCompat.METADATA_KEY_ART, bitmap)
    } else {
      // Server books: Use URI approach
      Log.d("PlaybackSession", "getMediaMetadataCompat - No bitmap, using URI approach")
      metadataBuilder
        .putString(MediaMetadataCompat.METADATA_KEY_ALBUM_ART_URI, coverUri.toString())
        .putString(MediaMetadataCompat.METADATA_KEY_ART_URI, coverUri.toString())
        .putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_ICON_URI, coverUri.toString())
    }

    val metadata = metadataBuilder.build()
    Log.d("PlaybackSession", "getMediaMetadataCompat - Built metadata with bitmap: ${metadata.getBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART) != null}")

    // Use reflection to set the description with iconBitmap for Android Auto compatibility
    try {
      val descriptionField = MediaMetadataCompat::class.java.getDeclaredField("mDescription")
      descriptionField.isAccessible = true
      descriptionField.set(metadata, description)
      Log.d("PlaybackSession", "getMediaMetadataCompat - Set description with reflection")
    } catch (e: Exception) {
      Log.w("PlaybackSession", "Failed to set description with iconBitmap: ${e.message}")
    }

    Log.d("PlaybackSession", "getMediaMetadataCompat - Final metadata bitmap: ${metadata.getBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART) != null}")
    return metadata
  }

  @JsonIgnore
  fun getExoMediaMetadata(ctx: Context, audioTrack: AudioTrack? = null, chapter: BookChapter? = null, chapterIndex: Int = -1): MediaMetadata {
    val coverUri = getCoverUri(ctx)

    val titleToUse = when {
      chapter != null -> chapter.title ?: "Chapter ${chapterIndex + 1}"
      audioTrack?.title != null -> audioTrack.title
      else -> displayTitle
    }
    val subtitleToUse = when {
      chapter != null -> displayTitle
      audioTrack?.title != null -> displayAuthor
      else -> displayAuthor
    }

    val metadataBuilder =
            MediaMetadata.Builder()
                    .setTitle(titleToUse)
                    .setDisplayTitle(titleToUse)
                    .setArtist(displayAuthor)
                    .setAlbumArtist(displayAuthor)
                    .setSubtitle(subtitleToUse)
                    .setAlbumTitle(displayAuthor)
                    .setDescription(displayAuthor)
                    .setArtworkUri(coverUri)
                    .setMediaType(MediaMetadata.MEDIA_TYPE_AUDIO_BOOK)

    return metadataBuilder.build()
  }

  @JsonIgnore
  fun getMediaItems(ctx: Context): List<MediaItem> {
    val mediaItems: MutableList<MediaItem> = mutableListOf()

    // For chapter-based books (single track with multiple chapters), create media items for each chapter
    if (audioTracks.size == 1 && chapters.isNotEmpty()) {
      Log.d("PlaybackSession", "Creating media items for ${chapters.size} chapters")
      for ((index, chapter) in chapters.withIndex()) {
        val audioTrack = audioTracks[0]
        val mediaMetadata = this.getExoMediaMetadata(ctx, audioTrack, chapter, index)
        val mediaUri = this.getContentUri(audioTrack)
        val mimeType = audioTrack.mimeType

        // Create clipping configuration for this chapter
        val clippingConfig = MediaItem.ClippingConfiguration.Builder()
          .setStartPositionMs(chapter.startMs)
          .setEndPositionMs(if (index < chapters.size - 1) chapters[index + 1].startMs else Long.MAX_VALUE)
          .build()

        val queueItem = getQueueItem(audioTrack, chapter, index)
        val mediaItem = MediaItem.Builder()
          .setUri(mediaUri)
          .setTag(queueItem)
          .setMediaMetadata(mediaMetadata)
          .setMimeType(mimeType)
          .setClippingConfiguration(clippingConfig)
          .build()
        mediaItems.add(mediaItem)
      }
    } else {
      // For multi-track books, create media items for each track
      for (audioTrack in audioTracks) {
        val mediaMetadata = this.getExoMediaMetadata(ctx, audioTrack)
        val mediaUri = this.getContentUri(audioTrack)
        val mimeType = audioTrack.mimeType

        val queueItem = getQueueItem(audioTrack)
        val mediaItem = MediaItem.Builder()
          .setUri(mediaUri)
          .setTag(queueItem)
          .setMediaMetadata(mediaMetadata)
          .setMimeType(mimeType)
          .build()
        mediaItems.add(mediaItem)
      }
    }
    return mediaItems
  }

  @JsonIgnore
  fun getCastMediaMetadata(audioTrack: AudioTrack, chapter: BookChapter? = null, chapterIndex: Int = -1): com.google.android.gms.cast.MediaMetadata {
    val castMetadata =
            com.google.android.gms.cast.MediaMetadata(
                    com.google.android.gms.cast.MediaMetadata.MEDIA_TYPE_AUDIOBOOK_CHAPTER
            )

    // As of v2.17.0 token is not needed with cover image requests
    val coverUri = if (checkIsServerVersionGte("2.17.0")) {
      Uri.parse("$serverAddress/api/items/$libraryItemId/cover")
    } else {
      Uri.parse("$serverAddress/api/items/$libraryItemId/cover?token=${DeviceManager.token}")
    }

    // Cast always uses server cover uri
    coverPath?.let {
      castMetadata.addImage(WebImage(coverUri))
    }

    val titleToUse = chapter?.title ?: audioTrack.title ?: displayTitle ?: ""
    val chapterTitleToUse = if (chapter != null) chapter.title ?: "Chapter ${chapterIndex + 1}" else audioTrack.title

    castMetadata.putString(com.google.android.gms.cast.MediaMetadata.KEY_TITLE, titleToUse)
    castMetadata.putString(
            com.google.android.gms.cast.MediaMetadata.KEY_ARTIST,
            displayAuthor ?: ""
    )
    castMetadata.putString(
            com.google.android.gms.cast.MediaMetadata.KEY_ALBUM_TITLE,
            displayAuthor ?: ""
    )
    castMetadata.putString(
            com.google.android.gms.cast.MediaMetadata.KEY_CHAPTER_TITLE,
            chapterTitleToUse
    )

    castMetadata.putInt(
            com.google.android.gms.cast.MediaMetadata.KEY_TRACK_NUMBER,
            chapterIndex + 1
    )
    return castMetadata
  }

  fun getCastMediaMetadata(audioTrack: AudioTrack): com.google.android.gms.cast.MediaMetadata {
    return getCastMediaMetadata(audioTrack, null, -1)
  }

  @JsonIgnore
  fun getQueueItem(audioTrack: AudioTrack, chapter: BookChapter? = null, chapterIndex: Int = -1): MediaQueueItem {
    val castMetadata = if (chapter != null) {
      getCastMediaMetadata(audioTrack, chapter, chapterIndex)
    } else {
      getCastMediaMetadata(audioTrack)
    }

    val mediaUri = getContentUri(audioTrack)

    val mediaInfo =
            MediaInfo.Builder(mediaUri.toString())
                    .apply {
                      setContentUrl(mediaUri.toString())
                      setContentType(audioTrack.mimeType)
                      setMetadata(castMetadata)
                      setStreamType(MediaInfo.STREAM_TYPE_BUFFERED)
                    }
                    .build()

    return MediaQueueItem.Builder(mediaInfo)
            .apply { setPlaybackDuration(audioTrack.duration) }
            .build()
  }

  fun getQueueItem(audioTrack: AudioTrack): MediaQueueItem {
    return getQueueItem(audioTrack, null, -1)
  }

  @JsonIgnore
  fun clone(): PlaybackSession {
    return PlaybackSession(
            id,
            userId,
            libraryItemId,
            episodeId,
            mediaType,
            mediaMetadata,
            deviceInfo,
            chapters,
            displayTitle,
            displayAuthor,
            coverPath,
            duration,
            playMethod,
            startedAt,
            updatedAt,
            timeListening,
            audioTracks,
            currentTime,
            libraryItem,
            localLibraryItem,
            localEpisodeId,
            serverConnectionConfigId,
            serverAddress,
            mediaPlayer
    )
  }

  @JsonIgnore
  fun syncData(syncData: MediaProgressSyncData) {
    timeListening += syncData.timeListened
    updatedAt = System.currentTimeMillis()
    currentTime = syncData.currentTime
  }

  @JsonIgnore
  fun getNewLocalMediaProgress(): LocalMediaProgress {
    return LocalMediaProgress(
            localMediaProgressId,
            localLibraryItemId,
            localEpisodeId,
            getTotalDuration(),
            progress,
            currentTime,
            false,
            null,
            null,
            updatedAt,
            startedAt,
            null,
            serverConnectionConfigId,
            serverAddress,
            userId,
            libraryItemId,
            episodeId
    )
  }
}
