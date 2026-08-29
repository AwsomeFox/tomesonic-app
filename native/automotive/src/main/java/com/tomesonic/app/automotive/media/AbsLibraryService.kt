package com.tomesonic.app.automotive.media

import android.util.Log
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.LibraryResult
import androidx.media3.session.MediaLibraryService
import androidx.media3.session.MediaSession
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.SettableFuture
import com.tomesonic.app.automotive.Graph
import com.tomesonic.app.automotive.playback.ControllerOpen
import com.tomesonic.app.automotive.playback.PlaybackScope
import com.tomesonic.app.automotive.playback.SessionManager
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.distinctUntilChangedBy
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

private const val TAG = "AbsLibraryService"

/**
 * The car's one entry point — a [MediaLibraryService], which is the whole app
 * surface on AAOS: the Media Center renders the browse tree and now-playing
 * from this session, and nothing else in this module draws UI.
 *
 * This file is deliberately thin. Every browse callback below does the same
 * three things — hop off the main thread onto the browse pool, ask [BrowseTree]
 * for a list, and answer with the requested page — because media3 invokes all
 * of them on the MAIN thread and every one of them can touch the network or the
 * disk. The tree, its caches and its budgets live next door; what lives here is
 * the contract with media3 and the guarantee that no callback ever leaves its
 * future unset (an unset future hangs the controller, which on a head unit is a
 * spinner that never ends).
 *
 * Playback rides the FRAMEWORK path on AAOS: the Media Center (and the
 * Assistant) hand this session a media id through `onSetMediaItems` /
 * `onAddMediaItems`, and media3 applies whatever queue comes back. All the
 * session bookkeeping — resolve, hand-off, progress baseline, resume pointer —
 * lives in [SessionManager.openForController]; what lives here is the mapping
 * between media3's callback shapes and that one entry point.
 */
@androidx.annotation.OptIn(UnstableApi::class)
class AbsLibraryService : MediaLibraryService() {

    private var player: ExoPlayer? = null
    private var librarySession: MediaLibrarySession? = null
    private var browseTree: BrowseTree? = null
    private var sessions: SessionManager? = null

    /**
     * Command scope for playback work (resolves, flushes, the creds collector).
     * MUST come from [PlaybackScope]: its CoroutineExceptionHandler is what
     * keeps one bad command from taking down the only process making sound in
     * the cabin. Cancelled in [onDestroy].
     */
    private val scope = PlaybackScope.create()

    /**
     * Browse work outlives its callback: a fetch that started before teardown
     * can complete after the session was released, and touching a released
     * session throws. Volatile because the pool's threads read it.
     */
    @Volatile
    private var destroyed = false

    override fun onCreate() {
        super.onCreate()
        // Defensively, per Graph's own doc: the Media Center binds this service
        // directly, and while Application.onCreate does run first in every real
        // process start, a component the system starts on its own should not
        // depend on that ordering to resolve its graph. Idempotent.
        Graph.init(this)

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

        val tree = BrowseTree(
            context = this,
            api = AbsBrowseApi(Graph.absApi),
            // The browse half of the downloads seam: the tree asks for a list of
            // rows and knows nothing about the index, WorkManager or the files.
            // `snapshot()` is the in-memory view — no disk, no suspend — which
            // is what makes it safe to call once per uncached folder load.
            downloadsSource = {
                Graph.downloadRepository.index.snapshot().map { entry ->
                    BrowseDownload(
                        id = entry.id,
                        // An episode row is titled by the EPISODE; the podcast's
                        // own title is the show, and a Downloads folder full of
                        // one repeated show title is unusable.
                        title = entry.episodeTitle ?: entry.title,
                        author = entry.author,
                        coverPath = entry.coverPath,
                        libraryItemId = entry.libraryItemId,
                        episodeId = entry.episodeId,
                        playable = entry.tracks.isNotEmpty()
                    )
                }
            },
            onBrowseChanged = ::notifyBrowseChanged
        )
        browseTree = tree

        val manager = SessionManager(exo, mainExecutor.asCoroutineDispatcher(), scope)
        sessions = manager

        librarySession = MediaLibrarySession.Builder(this, exo, LibraryCallback(tree, manager)).build()

        // DR-2/DR-3: seed connectivity, restore the last-good root from disk and
        // warm the real one in the background, so the Media Center's first
        // browse is answered from memory rather than from a cold fetch.
        tree.prewarm()

        // Flush trigger: service start (the app-start flush in MainApplication
        // covers process starts; this covers a service recreated in a live
        // process). No-op when the queues are empty.
        scope.launch { manager.syncer.flushOfflineQueues() }

        // Cover URLs carry the access token in their query string, so a token
        // refresh — or a sign-out — makes every cached row's artwork stale.
        // The donor called absNotifyBrowseChanged from its refresh path; here
        // the tree invalidates itself whenever the credential IDENTITY changes.
        // distinctUntilChangedBy, because the creds flow re-emits on every
        // DataStore write (lastItem lands on every play) and only server/token
        // changes actually stale the tree. drop(1) skips the subscribe echo.
        scope.launch {
            Graph.credsRepository.creds
                .distinctUntilChangedBy { it?.let { c -> c.server to c.token } }
                .drop(1)
                .collect { browseTree?.invalidate("creds changed") }
        }
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaLibrarySession? =
        librarySession

    override fun onDestroy() {
        destroyed = true
        browseTree?.release()
        browseTree = null
        // Before the player: release() reads the final position synchronously
        // on the player's thread — which onDestroy is — and delivers it on a
        // scope that outlives the service (the donor's ordering, kept exactly).
        sessions?.release()
        sessions = null
        librarySession?.release()
        librarySession = null
        player?.release()
        player = null
        scope.cancel()
        super.onDestroy()
    }

    /**
     * "The tree changed" — connectivity flipped, or the persisted root was
     * replaced by a real fetch.
     *
     * The session is MAIN-THREAD-ONLY and this arrives from a ConnectivityManager
     * callback or a browse-pool thread, so it hops first. (The donor learned
     * this the hard way: the off-thread call threw, the catch swallowed it, and
     * the online/offline browse refresh silently never happened.)
     */
    private fun notifyBrowseChanged(reason: String) {
        // Most of these reasons are connectivity flips — the moment progress
        // banked offline can reach the server (the donor's dedicated network
        // callback, ridden here on the tree's existing signal). No-op when the
        // queues are empty, so the extra firings cost nothing.
        sessions?.let { s -> scope.launch { s.syncer.flushOfflineQueues() } }
        mainExecutor.execute {
            if (destroyed) return@execute
            val session = librarySession ?: return@execute
            try {
                Log.i(TAG, "notifyChildrenChanged ($reason)")
                session.notifyChildrenChanged(BrowseTree.ROOT_ID, Int.MAX_VALUE, null)
                session.notifyChildrenChanged(BrowseTree.DOWNLOADS_ID, Int.MAX_VALUE, null)
            } catch (t: Throwable) {
                Log.w(TAG, "notifyChildrenChanged failed", t)
            }
        }
    }

    private inner class LibraryCallback(
        private val tree: BrowseTree,
        private val sessions: SessionManager
    ) : MediaLibrarySession.Callback {

        // ---- playback: the framework path -------------------------------------

        /**
         * The tap-to-play path. The Media Center calls setMediaItem with the
         * browse row's `play:` id (no URI), and whatever this returns is what
         * media3 sets, prepares and plays. The donor resolved here for the same
         * reason: only the service can turn an id into tracks WITH the saved
         * resume position — the default pipeline cannot supply one.
         *
         * A controller-specified position wins over the saved one (a rare,
         * deliberate ask — e.g. a bookmark intent); C.TIME_UNSET, the normal
         * case, means "resume where the book left off".
         */
        override fun onSetMediaItems(
            mediaSession: MediaSession,
            controller: MediaSession.ControllerInfo,
            mediaItems: List<MediaItem>,
            startIndex: Int,
            startPositionMs: Long
        ): ListenableFuture<MediaSession.MediaItemsWithStartPosition> {
            val target = mediaItems.firstOrNull()
                ?: return Futures.immediateFailedFuture(IllegalArgumentException("empty setMediaItems"))
            return onScope {
                val open = openTarget(target)
                    ?: throw UnsupportedOperationException("unresolvable: ${target.mediaId}")
                when (open) {
                    is ControllerOpen.Failed ->
                        throw UnsupportedOperationException("play failed: ${open.result}")
                    is ControllerOpen.Ready -> {
                        val honourCaller =
                            startIndex != C.INDEX_UNSET && startPositionMs != C.TIME_UNSET
                        MediaSession.MediaItemsWithStartPosition(
                            open.items,
                            if (honourCaller) startIndex else open.startIndex,
                            if (honourCaller) startPositionMs else open.startPositionMs
                        )
                    }
                }
            }
        }

        /**
         * Controllers that ADD rather than SET (queueing surfaces, some AVRCP
         * bridges) still need ids resolved to playable items. Same entry point,
         * items only — the start position is the framework's problem on this
         * path.
         */
        override fun onAddMediaItems(
            mediaSession: MediaSession,
            controller: MediaSession.ControllerInfo,
            mediaItems: List<MediaItem>
        ): ListenableFuture<List<MediaItem>> {
            val target = mediaItems.firstOrNull { PlayMediaId.isPlayId(it.mediaId) }
                // Nothing resolvable: pass through untouched (URI-carrying items
                // stay playable; anything else fails downstream, visibly).
                ?: return Futures.immediateFuture(mediaItems)
            return onScope {
                when (val open = openTarget(target)) {
                    is ControllerOpen.Ready -> open.items
                    else -> throw UnsupportedOperationException("unresolvable: ${target.mediaId}")
                }
            }
        }

        /**
         * The Media Center's resume affordance — the ONLY autoplay path (MA-1),
         * and quality item EP-2's restore-previous-state. The target is what
         * [SessionManager] wrote on the last successful play.
         */
        override fun onPlaybackResumption(
            mediaSession: MediaSession,
            controller: MediaSession.ControllerInfo
        ): ListenableFuture<MediaSession.MediaItemsWithStartPosition> = onScope {
            val last = Graph.credsRepository.lastItem.first()
                ?: throw UnsupportedOperationException("nothing to resume")
            when (val open = sessions.openForController(last.itemId, last.episodeId)) {
                is ControllerOpen.Ready ->
                    MediaSession.MediaItemsWithStartPosition(open.items, open.startIndex, open.startPositionMs)
                is ControllerOpen.Failed ->
                    throw UnsupportedOperationException("resume failed: ${open.result}")
            }
        }

        /**
         * One target, three shapes: a `play:` id from our own browse tree, a
         * bare item id a controller echoed back, or an Assistant free-text
         * search riding requestMetadata (VC-1) — resolved through the tree so
         * "play <book title>" lands on the same rows browsing shows.
         */
        private suspend fun openTarget(target: MediaItem): ControllerOpen? {
            if (PlayMediaId.isPlayId(target.mediaId)) {
                val id = PlayMediaId.parse(target.mediaId)
                if (id.itemId.isBlank()) return null
                return sessions.openForController(id.itemId, id.episodeOrNull(), id.bookmarkSeconds)
            }
            if (target.mediaId.isNotBlank()) {
                return sessions.openForController(target.mediaId, null)
            }
            val query = target.requestMetadata.searchQuery?.takeIf { it.isNotBlank() } ?: return null
            val hit = tree.search(query).firstOrNull { PlayMediaId.isPlayId(it.mediaId) } ?: return null
            val id = PlayMediaId.parse(hit.mediaId)
            if (id.itemId.isBlank()) return null
            return sessions.openForController(id.itemId, id.episodeOrNull(), id.bookmarkSeconds)
        }

        /**
         * Coroutine → ListenableFuture bridge for the playback callbacks. A
         * thrown exception becomes a failed future — media3 surfaces it as the
         * controller's error — and the future is ALWAYS completed (§ the same
         * hung-controller rule the browse callbacks live by). Failures are
         * expected outcomes here (offline, signed out), so they log at INFO.
         * TODO(Wave 4): map PlayResult.NotConfigured to the §6 sign-in
         * resolution extras once SignInActivity exists to point the intent at.
         */
        private fun <T> onScope(block: suspend () -> T): ListenableFuture<T> {
            val future = SettableFuture.create<T>()
            scope.launch {
                try {
                    future.set(block())
                } catch (t: Throwable) {
                    Log.i(TAG, "playback callback declined: ${t.message}")
                    future.setException(t)
                }
            }
            return future
        }

        // ---- browse -----------------------------------------------------------

        override fun onGetLibraryRoot(
            session: MediaLibrarySession,
            browser: MediaSession.ControllerInfo,
            params: MediaLibraryService.LibraryParams?
        ): ListenableFuture<LibraryResult<MediaItem>> {
            // Global content-style defaults (ARCHITECTURE.md §4.3): playable
            // children render as cover grids, browsable children as category
            // lists. Folders override per level; these are only the defaults.
            val rootParams = MediaLibraryService.LibraryParams.Builder()
                .setExtras(BrowseStyles.rootExtras())
                .build()
            return Futures.immediateFuture(LibraryResult.ofItem(tree.rootItem(), rootParams))
        }

        override fun onGetChildren(
            session: MediaLibrarySession,
            browser: MediaSession.ControllerInfo,
            parentId: String,
            page: Int,
            pageSize: Int,
            params: MediaLibraryService.LibraryParams?
        ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> {
            val future = SettableFuture.create<LibraryResult<ImmutableList<MediaItem>>>()
            tree.submit(onReject = { future.set(emptyItems(params)) }) {
                // The type is spelled out because the catch branch's
                // emptyList() has nothing else to infer from.
                val children: List<MediaItem> = try {
                    tree.loadChildren(parentId)
                } catch (t: Throwable) {
                    // An empty folder is a bad answer; no answer at all is a
                    // hung controller.
                    Log.w(TAG, "loadChildren failed for $parentId", t)
                    emptyList()
                }
                // Honour the requested window. Returning the whole list for
                // every page made paginating head units append the same rows
                // again and again.
                val (from, to) = BrowseTree.pageWindow(children.size, page, pageSize)
                future.set(
                    LibraryResult.ofItemList(ImmutableList.copyOf(children.subList(from, to)), params)
                )
            }
            return future
        }

        override fun onGetItem(
            session: MediaLibrarySession,
            browser: MediaSession.ControllerInfo,
            mediaId: String
        ): ListenableFuture<LibraryResult<MediaItem>> {
            // Controllers (the Media Center, the Assistant) may resolve an id
            // straight to an item before playing it, so a "play:" id must come
            // back PLAYABLE rather than as a folder named after the raw id.
            if (!PlayMediaId.isPlayId(mediaId)) {
                return Futures.immediateFuture(
                    LibraryResult.ofItem(BrowseStyles.browsableItem(mediaId, mediaId), null)
                )
            }
            val future = SettableFuture.create<LibraryResult<MediaItem>>()
            // Resolving a play id reads the download index and can decode a
            // cover bitmap; media3 calls this on the main thread, and this is
            // the hot pre-play path on a cheap head unit.
            tree.submit(onReject = { future.set(minimalItem(mediaId)) }) {
                try {
                    future.set(LibraryResult.ofItem(tree.item(mediaId), null))
                } catch (t: Throwable) {
                    Log.w(TAG, "onGetItem failed for $mediaId", t)
                    future.set(minimalItem(mediaId))
                }
            }
            return future
        }

        override fun onSearch(
            session: MediaLibrarySession,
            browser: MediaSession.ControllerInfo,
            query: String,
            params: MediaLibraryService.LibraryParams?
        ): ListenableFuture<LibraryResult<Void>> {
            val future = SettableFuture.create<LibraryResult<Void>>()
            tree.submit(onReject = { future.set(LibraryResult.ofVoid(params)) }) {
                val results: List<MediaItem> = try {
                    tree.search(query)
                } catch (t: Throwable) {
                    Log.w(TAG, "search failed for '$query'", t)
                    emptyList()
                }
                // This runs on the browse pool and can complete AFTER onDestroy
                // released the session: touch it only while alive, and ALWAYS
                // complete the future so a search racing teardown never leaves
                // the controller hanging.
                try {
                    if (!destroyed) {
                        session.notifySearchResultChanged(browser, query, results.size, params)
                    }
                } catch (t: Throwable) {
                    Log.w(TAG, "notifySearchResultChanged failed", t)
                } finally {
                    future.set(LibraryResult.ofVoid(params))
                }
            }
            return future
        }

        override fun onGetSearchResult(
            session: MediaLibrarySession,
            browser: MediaSession.ControllerInfo,
            query: String,
            page: Int,
            pageSize: Int,
            params: MediaLibraryService.LibraryParams?
        ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> {
            // Reads the cache onSearch filled — no network, so no pool hop.
            val results = tree.searchResults(query)
            val (from, to) = BrowseTree.pageWindow(results.size, page, pageSize)
            return Futures.immediateFuture(
                LibraryResult.ofItemList(ImmutableList.copyOf(results.subList(from, to)), params)
            )
        }

        private fun emptyItems(
            params: MediaLibraryService.LibraryParams?
        ): LibraryResult<ImmutableList<MediaItem>> =
            LibraryResult.ofItemList(ImmutableList.of<MediaItem>(), params)

        /** The last-resort answer: a resolvable item, so the controller moves on. */
        private fun minimalItem(mediaId: String): LibraryResult<MediaItem> =
            LibraryResult.ofItem(BrowseStyles.browsableItem(mediaId, mediaId), null)
    }

    companion object {
        /** Frozen across all four clients — ARCHITECTURE.md §4.2. */
        const val ROOT_ID = BrowseTree.ROOT_ID
    }
}
