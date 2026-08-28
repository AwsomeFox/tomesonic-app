package com.tomesonic.app.automotive.media

import android.os.Bundle
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.LibraryResult
import androidx.media3.session.MediaLibraryService
import androidx.media3.session.MediaSession
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture

/**
 * The car's one entry point — a [MediaLibraryService], which is the whole app
 * surface on AAOS: the Media Center renders the browse tree and now-playing
 * from this session, and nothing else in this module draws UI.
 *
 * WAVE-1 SKELETON. It exists so the manifest can declare its `<service>` in the
 * same wave (a component naming a missing class fails `lintVitalRelease` on the
 * first release build — ARCHITECTURE.md §5), and so the emulator spike has
 * something bindable to point the Media Center at. It answers the root with an
 * empty tree and holds a player that never gets media.
 *
 * Wave 3 replaces the callback below with the ported browse tree (BrowseTree /
 * BrowseStyles / PlayMediaId) and wires SessionManager in for playback; the
 * root extras and the "__ROOT__" id are already the frozen ones (§4.2, §4.3)
 * so that swap does not move the contract.
 */
@androidx.annotation.OptIn(UnstableApi::class)
class AbsLibraryService : MediaLibraryService() {

    private var player: ExoPlayer? = null
    private var librarySession: MediaLibrarySession? = null

    override fun onCreate() {
        super.onCreate()

        val exo = ExoPlayer.Builder(this)
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(C.USAGE_MEDIA)
                    // SPEECH, not MUSIC: it is what gives an audiobook the right
                    // ducking behaviour against turn-by-turn navigation.
                    .setContentType(C.AUDIO_CONTENT_TYPE_SPEECH)
                    .build(),
                /* handleAudioFocus= */ true
            )
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_NETWORK)
            .build()
        player = exo

        librarySession = MediaLibrarySession.Builder(this, exo, LibraryCallback()).build()
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaLibrarySession? =
        librarySession

    override fun onDestroy() {
        librarySession?.release()
        librarySession = null
        player?.release()
        player = null
        super.onDestroy()
    }

    private inner class LibraryCallback : MediaLibrarySession.Callback {

        override fun onGetLibraryRoot(
            session: MediaLibrarySession,
            browser: MediaSession.ControllerInfo,
            params: MediaLibraryService.LibraryParams?
        ): ListenableFuture<LibraryResult<MediaItem>> {
            // Global content-style defaults, carried verbatim from the shipped
            // Android Auto service (ARCHITECTURE.md §4.3): playable children
            // render as cover grids, browsable children as category lists.
            // These key strings are NOT guessable — the "obvious"
            // android.media.description.extra.* spellings render nothing.
            val rootExtras = Bundle().apply {
                putBoolean(CONTENT_STYLE_SUPPORTED, true)
                putInt(CONTENT_STYLE_PLAYABLE_HINT, STYLE_GRID)
                putInt(CONTENT_STYLE_BROWSABLE_HINT, STYLE_CATEGORY_LIST)
            }
            val rootParams = MediaLibraryService.LibraryParams.Builder()
                .setExtras(rootExtras)
                .build()
            return Futures.immediateFuture(LibraryResult.ofItem(rootItem(), rootParams))
        }

        override fun onGetChildren(
            session: MediaLibrarySession,
            browser: MediaSession.ControllerInfo,
            parentId: String,
            page: Int,
            pageSize: Int,
            params: MediaLibraryService.LibraryParams?
        ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> =
            // Wave 3: absLoadChildren + absPageWindow on the browse pool. An
            // empty list (not an error) keeps the Media Center on an "empty
            // library" state rather than an error card during the spike.
            Futures.immediateFuture(
                LibraryResult.ofItemList(ImmutableList.of<MediaItem>(), params)
            )
    }

    private fun rootItem(): MediaItem {
        val metadata = MediaMetadata.Builder()
            .setTitle(ROOT_TITLE)
            .setIsBrowsable(true)
            .setIsPlayable(false)
            .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
            .build()
        return MediaItem.Builder()
            .setMediaId(ROOT_ID)
            .setMediaMetadata(metadata)
            .build()
    }

    companion object {
        /** Frozen across all four clients — ARCHITECTURE.md §4.2. */
        const val ROOT_ID = "__ROOT__"
        private const val ROOT_TITLE = "TomeSonic"

        // §4.3, verbatim.
        private const val CONTENT_STYLE_SUPPORTED = "android.media.browse.CONTENT_STYLE_SUPPORTED"
        private const val CONTENT_STYLE_PLAYABLE_HINT = "android.media.browse.CONTENT_STYLE_PLAYABLE_HINT"
        private const val CONTENT_STYLE_BROWSABLE_HINT = "android.media.browse.CONTENT_STYLE_BROWSABLE_HINT"

        private const val STYLE_GRID = 2
        private const val STYLE_CATEGORY_LIST = 3
    }
}
