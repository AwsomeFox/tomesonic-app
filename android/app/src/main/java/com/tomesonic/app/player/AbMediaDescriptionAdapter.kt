package com.tomesonic.app.player

import android.app.PendingIntent
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.net.Uri
import android.os.Build
import androidx.media3.ui.PlayerNotificationManager
import androidx.media3.common.Player
import android.util.Log
import com.tomesonic.app.MainActivity
import com.bumptech.glide.Glide
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class AbMediaDescriptionAdapter(
    private val service: PlayerNotificationService
) : PlayerNotificationManager.MediaDescriptionAdapter {

    companion object {
        private const val TAG = "AbMediaDescriptionAdapter"
        // Max size for notification artwork – keeps memory bounded
        private const val ART_SIZE_PX = 512
    }

    private var currentIconUri: Uri? = null
    private var currentBitmap: Bitmap? = null
    private val scopeJob = SupervisorJob()
    private val serviceScope = CoroutineScope(Dispatchers.Main + scopeJob)
    private var loadArtworkJob: Job? = null

    /** Call from MediaSessionManager.release() to cancel any in-flight IO. */
    fun release() {
        loadArtworkJob?.cancel()
        serviceScope.cancel()
        currentBitmap = null
        currentIconUri = null
    }

    override fun createCurrentContentIntent(player: Player): PendingIntent? {
        val intent = Intent(service, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        return PendingIntent.getActivity(
            service,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    override fun getCurrentContentText(player: Player): CharSequence {
        val currentMediaItem = player.currentMediaItem
        val metadata = currentMediaItem?.mediaMetadata
        val playbackSession = service.currentPlaybackSession
        val sessionAuthor = playbackSession?.displayAuthor?.takeIf { it.isNotBlank() }
        val sessionTitle = playbackSession?.displayTitle?.takeIf { it.isNotBlank() }

        return when {
            metadata?.artist != null -> metadata.artist.toString()
            metadata?.albumArtist != null -> metadata.albumArtist.toString()
            metadata?.subtitle != null -> metadata.subtitle.toString()
            sessionAuthor != null -> sessionAuthor
            sessionTitle != null -> sessionTitle
            else -> ""
        }.also {
            Log.d(TAG, "getCurrentContentText: '$it' (mediaItem=${currentMediaItem != null}, metadata=${metadata != null})")
        }
    }

    override fun getCurrentContentTitle(player: Player): CharSequence {
        val currentMediaItem = player.currentMediaItem
        val metadata = currentMediaItem?.mediaMetadata
        val playbackSession = service.currentPlaybackSession
        val sessionTitle = playbackSession?.displayTitle?.takeIf { it.isNotBlank() }

        return when {
            metadata?.title != null -> metadata.title.toString()
            metadata?.displayTitle != null -> metadata.displayTitle.toString()
            sessionTitle != null -> sessionTitle
            currentMediaItem?.mediaId != null -> "Audiobook"
            else -> "Unknown"
        }.also {
            Log.d(TAG, "getCurrentContentTitle: '$it' (mediaItem=${currentMediaItem != null}, metadata=${metadata != null})")
        }
    }

    override fun getCurrentLargeIcon(
        player: Player,
        callback: PlayerNotificationManager.BitmapCallback
    ): Bitmap? {
        val metadata = player.currentMediaItem?.mediaMetadata
        val artworkData = metadata?.artworkData
        val artworkUri = metadata?.artworkUri ?: service.currentPlaybackSession?.getCoverUri(service)

        Log.d(
            TAG,
            "getCurrentLargeIcon: artworkData=${artworkData != null}, artworkUri=${artworkUri != null}"
        )

        // Use in-memory artwork when available for immediate notification rendering.
        if (artworkData != null) {
            return try {
                BitmapFactory.decodeByteArray(artworkData, 0, artworkData.size)
            } catch (e: Exception) {
                Log.w(TAG, "getCurrentLargeIcon: failed decoding artworkData", e)
                null
            }
        }

        if (artworkUri == null) {
            return null
        }

        if (currentIconUri == artworkUri && currentBitmap != null) {
            return currentBitmap
        }

        // Only cancel/restart when URI actually changes; this prevents a cancel loop
        // when PlayerNotificationManager polls repeatedly during the same load.
        if (currentIconUri != artworkUri) {
            loadArtworkJob?.cancel()
            currentBitmap = null
            currentIconUri = artworkUri
        } else if (loadArtworkJob?.isActive == true) {
            // Same URI, load already in progress – let it complete
            return null
        }

        loadArtworkJob = serviceScope.launch {
            val bitmap = resolveArtworkUri(artworkUri)
            if (bitmap != null && currentIconUri == artworkUri) {
                currentBitmap = bitmap
                callback.onBitmap(bitmap)
            }
        }

        return null
    }

    private suspend fun resolveArtworkUri(uri: Uri): Bitmap? {
        return withContext(Dispatchers.IO) {
            try {
                when (uri.scheme?.lowercase()) {
                    "content", "file", "android.resource" -> {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                            val source = ImageDecoder.createSource(service.contentResolver, uri)
                            ImageDecoder.decodeBitmap(source) { decoder, _, _ ->
                                decoder.setTargetSize(ART_SIZE_PX, ART_SIZE_PX)
                            }
                        } else {
                            service.contentResolver.openInputStream(uri)?.use { stream ->
                                val opts = BitmapFactory.Options().apply {
                                    inJustDecodeBounds = true
                                }
                                BitmapFactory.decodeStream(stream, null, opts)
                                opts.inSampleSize = maxOf(
                                    opts.outWidth / ART_SIZE_PX,
                                    opts.outHeight / ART_SIZE_PX
                                ).coerceAtLeast(1)
                                opts.inJustDecodeBounds = false
                                service.contentResolver.openInputStream(uri)?.use {
                                    BitmapFactory.decodeStream(it, null, opts)
                                }
                            }
                        }
                    }
                    "http", "https" -> {
                        Glide.with(service)
                            .asBitmap()
                            .load(uri)
                            .override(ART_SIZE_PX, ART_SIZE_PX)
                            .submit()
                            .get()
                    }
                    else -> null
                }
            } catch (e: Exception) {
                Log.w(TAG, "resolveArtworkUri: failed for uri=$uri", e)
                null
            }
        }
    }
}
