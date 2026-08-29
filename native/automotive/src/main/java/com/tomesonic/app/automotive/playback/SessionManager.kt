package com.tomesonic.app.automotive.playback

import android.net.Uri
import android.util.Log
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import com.tomesonic.app.automotive.Graph
import com.tomesonic.app.automotive.data.AbsApi
import com.tomesonic.app.automotive.data.AbsClient
import com.tomesonic.app.automotive.data.AudioTrack
import com.tomesonic.app.automotive.data.Chapter
import com.tomesonic.app.automotive.data.ChapterMath
import com.tomesonic.app.automotive.data.CredsRepository
import com.tomesonic.app.automotive.data.PlaySession
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext

/**
 * What a play attempt did. Sealed rather than a boolean because the three
 * failures resolve DIFFERENTLY on a car — "no connection" and "no audio" are
 * session errors the Media Center shows as text, while [NotConfigured] is the
 * one that must carry the sign-in resolution extras (ARCHITECTURE.md §6) — and
 * the caller must not have to guess which it got.
 */
sealed interface PlayResult {
    data object Ok : PlayResult
    data object NeedsNetwork : PlayResult
    data object NoTracks : PlayResult
    data object NotConfigured : PlayResult
}

/**
 * What [SessionManager.openForController] produced: a queue for MEDIA3 to
 * apply, or the failure the service maps to a controller-visible error. The
 * framework path returns the queue instead of setting it (media3 sets whatever
 * `onSetMediaItems`/`onAddMediaItems` answer), which is why this exists apart
 * from [PlayResult].
 */
sealed interface ControllerOpen {
    data class Ready(
        val items: List<MediaItem>,
        val startIndex: Int,
        val startPositionMs: Long
    ) : ControllerOpen

    data class Failed(val result: PlayResult) : ControllerOpen
}

/**
 * A downloaded book as PLAYBACK sees it. Deliberately playback's own type: it
 * keeps the whole resolution path JVM-testable (and compilable) with nothing
 * but this — no downloads package, no WorkManager, no disk.
 *
 * `tracks[i].contentUrl` is an ABSOLUTE `file://` uri; everything else about a
 * track is reused from the data package so ChapterMath works unchanged for both
 * local and streamed queues.
 */
data class LocalBook(
    val itemId: String,
    val title: String,
    val author: String?,
    val duration: Double,
    val coverUri: String?,
    val tracks: List<AudioTrack>
)

/** The one thing playback needs from downloads. See DownloadsLocalSource. */
fun interface LocalPlaybackSource {
    fun localBook(itemId: String): LocalBook?

    /**
     * One downloaded EPISODE, as the same [LocalBook] shape (its `itemId` is the
     * podcast's — the episode id stays with the caller, which is what keeps the
     * progress ids right).
     *
     * Defaulted, so this stays a `fun interface` with one abstract member and
     * every SAM lambda keeps meaning "books only, nothing episodic on disk".
     */
    fun localEpisode(itemId: String, episodeId: String): LocalBook? = null
}

/** Where the downloads package plugs itself in — see DownloadsLocalSource. */
object PlaybackWiring {
    /**
     * Null means "nothing is downloaded", which is the correct behaviour for a
     * process where the downloads index hasn't been warmed yet: playback streams.
     */
    @Volatile
    var localSource: LocalPlaybackSource? = null
}

/**
 * The scope [SessionManager]'s fire-and-forget command handlers run on.
 *
 * Extracted from the donor's PlaybackService (whose own service body does NOT
 * port — the car's service is media/AbsLibraryService.kt), because the handler
 * is load-bearing rather than decorative: children of this scope are
 * fire-and-forget command handlers, and an uncaught exception in one would reach
 * the DEFAULT handler and take the whole process down mid-listen. One bad play
 * must cost that tap, never the process — and on a car this process is the only
 * thing making sound in the cabin.
 *
 * Dispatchers.IO, not Main: everything here either sleeps in `delay()` or waits
 * on a socket, and the only hop to the player's thread is the explicit
 * `withContext(main)` inside [SessionManager] and [ProgressSyncer].
 *
 * AbsLibraryService builds its command scope from here and passes it to
 * [SessionManager]; a bare `CoroutineScope(SupervisorJob())` is NOT a
 * substitute — SupervisorJob keeps siblings alive, it does not stop an uncaught
 * throwable from reaching the process handler.
 */
object PlaybackScope {

    fun create(): CoroutineScope = CoroutineScope(
        SupervisorJob() + Dispatchers.IO +
            CoroutineExceptionHandler { _, t -> Log.w(TAG, "playback command failed", t) }
    )

    private const val TAG = "AbsPlayback"
}

/**
 * The session currently loaded into the player. `serverSessionId == null` is
 * the LOCAL marker — the only place the local/stream distinction survives past
 * [SessionManager.play], because after that both are just a queue of tracks.
 */
data class ActiveSession(
    val serverSessionId: String?,
    val itemId: String,
    val episodeId: String?,
    val mediaType: String,
    val title: String,
    val author: String?,
    val duration: Double,
    val chapters: List<Chapter>,
    val tracks: List<AudioTrack>,
    val coverUri: String?
) {
    val isLocal: Boolean get() = serverSessionId == null
}

/**
 * Process-wide handle on [ActiveSession].
 *
 * A MediaController — the Media Center's, the Assistant's, an AVRCP bridge's —
 * carries no chapter table or track offsets: everything the player reports is
 * (mediaItemIndex, position-in-item). Rather than smuggle the whole chapter list
 * through MediaItem extras and re-parse it per query, whatever needs book-
 * absolute numbers reads them from here. Null when nothing has been played this
 * process; callers degrade to the controller's own metadata.
 */
object PlaybackState {
    private val _active = MutableStateFlow<ActiveSession?>(null)
    val active: StateFlow<ActiveSession?> = _active.asStateFlow()

    internal fun set(session: ActiveSession?) {
        _active.value = session
    }
}

/** Builds the player queue. One MediaItem PER TRACK, always, in track order. */
object MediaItems {

    /** Streamed: server-relative contentUrls joined against the server origin. */
    fun forSession(
        session: PlaySession,
        resolveUrl: (String) -> String?,
        artworkUri: String?
    ): List<MediaItem> = build(
        itemId = session.libraryItemId,
        tracks = session.audioTracks,
        title = session.displayTitle,
        artist = session.displayAuthor,
        artworkUri = artworkUri,
        urlOf = { resolveUrl(it.contentUrl) }
    )

    /** Downloaded: the on-disk files, which already carry absolute file:// uris. */
    fun forLocal(book: LocalBook): List<MediaItem> = build(
        itemId = book.itemId,
        tracks = book.tracks,
        title = book.title,
        artist = book.author,
        artworkUri = book.coverUri,
        urlOf = { it.contentUrl }
    )

    /**
     * Metadata is per ITEM, not per track: the book's title and author, so the
     * car's now-playing screen and every controller name the BOOK. The chapter
     * title is derived from ChapterMath by whoever renders it — media3 would
     * have to rewrite the queue to change per-item metadata, which resets scroll
     * in every connected controller.
     *
     * A track whose url can't be resolved is DROPPED, not turned into a broken
     * item: one unplayable entry mid-queue stalls the whole book.
     */
    private fun build(
        itemId: String,
        tracks: List<AudioTrack>,
        title: String,
        artist: String?,
        artworkUri: String?,
        urlOf: (AudioTrack) -> String?
    ): List<MediaItem> {
        val metadata = MediaMetadata.Builder()
            .setTitle(title)
            .setArtist(artist)
            .setAlbumTitle(title)
            .setIsBrowsable(false)
            .setIsPlayable(true)
            .apply { artworkUri?.let { setArtworkUri(Uri.parse(it)) } }
            .build()
        val out = ArrayList<MediaItem>(tracks.size)
        tracks.forEachIndexed { position, track ->
            val url = urlOf(track)?.takeIf { it.isNotBlank() } ?: return@forEachIndexed
            out.add(
                MediaItem.Builder()
                    .setUri(url)
                    .setMediaId("$itemId:${track.index}:$position")
                    .setMediaMetadata(metadata)
                    .build()
            )
        }
        return out
    }
}

/**
 * Opens and closes playback for one item.
 *
 * The local-vs-stream decision is made ONCE, here, and never revisited:
 *  - downloaded  -> ALWAYS the local files, progress into OfflineProgressQueue.
 *                   Never streams a book (or an episode) we already have; never
 *                   needs the network.
 *  - otherwise   -> requires the network. `POST /api/items/{id}/play`, stream the
 *                   session's tracks, progress via `/api/session/{id}/sync`.
 *
 * Player mutations all go through [main] because media3 requires every call on
 * the thread the player was built on. [scope] must come from [PlaybackScope] —
 * see its comment for why the exception handler is not optional.
 */
class SessionManager(
    private val player: Player,
    private val main: CoroutineDispatcher,
    scope: CoroutineScope,
    private val api: AbsApi = Graph.absApi,
    private val absClient: AbsClient = Graph.absClient,
    private val credsRepository: CredsRepository = Graph.credsRepository,
    private val queue: OfflineProgressQueue = OfflineProgressQueue.shared,
    private val localSource: () -> LocalPlaybackSource? = { PlaybackWiring.localSource }
) {

    /**
     * Owned here, not by the service: the syncer's every decision keys off the
     * ACTIVE session, and a switch has to close the old one before the new one
     * exists — an ordering only this class can guarantee.
     */
    val syncer: ProgressSyncer = ProgressSyncer(
        player = player,
        main = main,
        scope = scope,
        api = api,
        queue = queue
    )

    /**
     * Serialises [play] and [stop]. The service answers browse/session commands
     * with fire-and-forget coroutines, so without this a double-tap (a car
     * touchscreen bounces exactly like a watch does, and a voice command can
     * land on top of one) interleaves two teardown/rebuild sequences over one
     * player — handOffs, setMediaItems and PlaybackState writes in whatever
     * order the dispatcher felt like.
     */
    private val commandMutex = Mutex()

    suspend fun play(itemId: String, episodeId: String? = null): PlayResult {
        if (itemId.isBlank()) return PlayResult.NoTracks
        // Unlocked fast path, READS ONLY: re-tapping the book that is already
        // audibly playing answers Ok without queueing behind a switch that is
        // mid-resolve (the mutex is held across a network round trip — a
        // deliberate trade: a stop tapped during a slow resolve waits a few
        // seconds and then wins, which beats the interleaving the mutex
        // prevents). EVERY player MUTATION stays under the mutex — a paused
        // same-target resume takes the locked path below, so this can never
        // race a stop()'s teardown with a play() call.
        if (isSameTargetPlaying(itemId, episodeId)) return PlayResult.Ok
        return commandMutex.withLock { playLocked(itemId, episodeId) }
    }

    /** True only when the target is active, loaded AND told to play — no writes. */
    private suspend fun isSameTargetPlaying(itemId: String, episodeId: String?): Boolean {
        if (!isSameTarget(PlaybackState.active.value, itemId, episodeId)) return false
        return withContext(main) { player.mediaItemCount > 0 && player.playWhenReady }
    }

    /**
     * The no-teardown short-circuit (user-reported on-device: one tap on the
     * playing book broke playback — the full path opens a SECOND server session
     * for the same book, hands off the healthy one mid-flight and replaces a
     * queue that was fine). Same target = surface what's playing: resume if
     * paused, change nothing else. The mediaItemCount check is what makes this
     * safe against a stopped player: stop() clears the queue (PlaybackState
     * only after), and an empty queue answers false so the caller runs the
     * full play path rather than "resuming" nothing. Called with [commandMutex]
     * HELD — the resume is a player mutation.
     */
    private suspend fun resumeIfSameTarget(itemId: String, episodeId: String?): Boolean {
        if (!isSameTarget(PlaybackState.active.value, itemId, episodeId)) return false
        return withContext(main) {
            val loaded = player.mediaItemCount > 0
            if (loaded && !player.playWhenReady) player.play()
            loaded
        }
    }

    private suspend fun playLocked(itemId: String, episodeId: String?): PlayResult {
        // Re-checked under the lock: the play that was in flight while this one
        // waited may have just made its target the active one.
        if (resumeIfSameTarget(itemId, episodeId)) return PlayResult.Ok

        // Resolve BEFORE touching the outgoing session: a `/play` round trip can
        // take seconds, and closing the current book only to fail on the new one
        // would leave it playing with nothing tracking its progress.
        val resolution = resolve(
            itemId = itemId,
            episodeId = episodeId,
            credsRepository = credsRepository,
            queue = queue,
            local = localSource(),
            openSession = { id, ep -> api.startPlaySession(id, ep) },
            coverUrl = { api.coverUrl(it) },
            resolveUrl = { absClient.resolve(it) }
        )
        val ready = when (resolution) {
            is Resolution.Failed -> return resolution.result
            is Resolution.Ready -> resolution
        }

        // A switch is an implicit stop of the outgoing session — claim its final
        // position (plus the seconds still owed toward the next 15s tick) before
        // the queue is replaced. The phone's preparePlaybackSession does the
        // same; skipping it leaks an open ABS session per switch and drops up to
        // 15s of listening stats. handOff, not finish: the position is taken
        // synchronously but its delivery is not awaited, so an offline switch
        // isn't held up by a closeSession that has to time out first.
        syncer.handOff()
        // Before the player starts: the first isPlaying callback establishes the
        // accumulator's baseline, and resetting after it would discard the new
        // book's first tick.
        syncer.onSessionStarted()

        val speed = credsRepository.playbackSpeed.first()
        val start = ChapterMath.trackPositionAt(ready.session.tracks, ready.startSeconds)
            ?: ChapterMath.TrackPosition(0, 0.0)
        withContext(main) {
            player.setMediaItems(ready.items, start.trackIndex, (start.positionSeconds * 1000.0).toLong())
            player.setPlaybackSpeed(speed)
            player.prepare()
            player.play()
        }

        PlaybackState.set(ready.session)
        // The Media Center's playback-resumption affordance resolves its target
        // from this (ARCHITECTURE.md §8, quality item EP-2); write it only once
        // the queue is actually loaded so a failed play can't repoint it.
        credsRepository.setLastItem(itemId, episodeId, ready.session.title, ready.session.author)
        // SEAM (donor divergence): wear pokes its Continue-Listening tile here.
        // The car draws no surface of its own — the equivalent refresh is
        // notifyChildrenChanged on the browse tree, which belongs to
        // AbsLibraryService because it owns the tree and its cache. Nothing to
        // call from here.
        return PlayResult.Ok
    }

    /**
     * The media3-driven play path. On AAOS the Media Center (and the Assistant)
     * start playback THROUGH the session: the controller hands over a media id,
     * `onSetMediaItems`/`onAddMediaItems` must answer with a resolved queue, and
     * media3 applies it to the player itself. So unlike [play], this performs
     * every side effect EXCEPT the player's queue mutation — same mutex, same
     * [resolve], same hand-off and state writes, so the two paths cannot drift.
     *
     * A same-target request answers the CURRENT queue at the LIVE position: no
     * second server session, no rebuilt queue — media3 re-applies an identical
     * list, which is the framework path's closest equivalent of [play]'s
     * no-teardown short-circuit (the syncer's seek handling absorbs the
     * position re-assertion).
     */
    suspend fun openForController(
        itemId: String,
        episodeId: String? = null,
        /**
         * A `play:…@@seconds` bookmark start. Null — every id the browse tree
         * emits today — means "the saved resume position". Only consulted on a
         * full resolve; a same-target request keeps the live position, because
         * a bookmark id for the playing book is not an emitter that exists.
         */
        startSecondsOverride: Double? = null
    ): ControllerOpen {
        if (itemId.isBlank()) return ControllerOpen.Failed(PlayResult.NoTracks)
        return commandMutex.withLock { openForControllerLocked(itemId, episodeId, startSecondsOverride) }
    }

    private suspend fun openForControllerLocked(
        itemId: String,
        episodeId: String?,
        startSecondsOverride: Double? = null
    ): ControllerOpen {
        if (isSameTarget(PlaybackState.active.value, itemId, episodeId)) {
            val current = withContext(main) {
                val count = player.mediaItemCount
                if (count == 0) {
                    // Stopped player: the queue is gone (stop() clears it before
                    // PlaybackState), so fall through to a full resolve.
                    null
                } else {
                    ControllerOpen.Ready(
                        items = (0 until count).map { player.getMediaItemAt(it) },
                        startIndex = player.currentMediaItemIndex,
                        startPositionMs = player.currentPosition.coerceAtLeast(0L)
                    )
                }
            }
            if (current != null) return current
        }

        val resolution = resolve(
            itemId = itemId,
            episodeId = episodeId,
            credsRepository = credsRepository,
            queue = queue,
            local = localSource(),
            openSession = { id, ep -> api.startPlaySession(id, ep) },
            coverUrl = { api.coverUrl(it) },
            resolveUrl = { absClient.resolve(it) }
        )
        val ready = when (resolution) {
            is Resolution.Failed -> return ControllerOpen.Failed(resolution.result)
            is Resolution.Ready -> resolution
        }

        // Identical bookkeeping to playLocked, in the same order: the outgoing
        // session's final position is claimed before the queue changes hands,
        // and the accumulator baseline is reset before the first isPlaying.
        syncer.handOff()
        syncer.onSessionStarted()

        // The speed is not part of what onSetMediaItems can return, and
        // setMediaItems does not reset playbackParameters — setting it here is
        // both safe and the only place it can happen on this path.
        val speed = credsRepository.playbackSpeed.first()
        withContext(main) { player.setPlaybackSpeed(speed) }

        PlaybackState.set(ready.session)
        credsRepository.setLastItem(itemId, episodeId, ready.session.title, ready.session.author)

        val start = ChapterMath.trackPositionAt(
            ready.session.tracks,
            startSecondsOverride ?: ready.startSeconds
        ) ?: ChapterMath.TrackPosition(0, 0.0)
        return ControllerOpen.Ready(
            items = ready.items,
            startIndex = start.trackIndex,
            startPositionMs = (start.positionSeconds * 1000.0).toLong()
        )
    }

    /** Final sync + closeSession, then an empty player. Safe with nothing playing. */
    suspend fun stop() = commandMutex.withLock {
        syncer.finish()
        withContext(main) {
            player.stop()
            player.clearMediaItems()
        }
        PlaybackState.set(null)
    }

    /**
     * Service teardown. Call on the player's thread — the final position is read
     * synchronously there and delivered on a scope that outlives the service.
     */
    fun release() {
        syncer.finishDetached()
        syncer.release()
    }

    /** What [resolve] decided, with the player queue already built. */
    internal sealed interface Resolution {
        data class Ready(
            val session: ActiveSession,
            val items: List<MediaItem>,
            val startSeconds: Double
        ) : Resolution

        data class Failed(val result: PlayResult) : Resolution
    }

    companion object {

        /**
         * Whether a play request names what is ALREADY the active session — the
         * decision [play]'s no-teardown short-circuit rides on, pure so the
         * blank-vs-null episode normalisation is a test row, not a field bug.
         */
        internal fun isSameTarget(active: ActiveSession?, itemId: String, episodeId: String?): Boolean {
            if (active == null) return false
            return active.itemId == itemId &&
                active.episodeId == episodeId?.takeIf { it.isNotBlank() }
        }

        /**
         * The whole local-vs-stream decision, with no player attached so it can
         * be tested on its own.
         *
         * Order matters: the download check comes FIRST and short-circuits, so a
         * downloaded book — or a downloaded EPISODE — never touches the network,
         * not for the session and not for the cover, and plays identically
         * whether or not the car has a connection.
         */
        internal suspend fun resolve(
            itemId: String,
            episodeId: String?,
            credsRepository: CredsRepository,
            queue: OfflineProgressQueue,
            local: LocalPlaybackSource?,
            openSession: suspend (String, String?) -> PlaySession?,
            coverUrl: (String) -> String?,
            resolveUrl: (String) -> String?
        ): Resolution {
            // An episode resolves against ITS OWN entry, never the podcast's:
            // asking for an episode the car doesn't have must still stream that
            // episode even when some other episode (or the item) is downloaded.
            val episode = episodeId?.takeIf { it.isNotBlank() }
            val book = if (episode == null) {
                local?.localBook(itemId)
            } else {
                local?.localEpisode(itemId, episode)
            }
            if (book != null) {
                if (book.tracks.isEmpty()) return Resolution.Failed(PlayResult.NoTracks)
                val duration = if (book.duration > 0.0) {
                    book.duration
                } else {
                    book.tracks.sumOf { if (it.duration > 0.0) it.duration else 0.0 }
                }
                val session = ActiveSession(
                    serverSessionId = null,
                    itemId = book.itemId,
                    // Carried into the session because the syncer reads it: the
                    // offline queues key on (item, episode), which is what makes
                    // the `automotive-local_<item>-<ep>_<date>` stats id and the
                    // per-episode resume marker come out right.
                    episodeId = episode,
                    mediaType = if (episode == null) "book" else "podcast",
                    title = book.title,
                    author = book.author,
                    duration = duration,
                    chapters = localChapters(book.tracks),
                    tracks = book.tracks,
                    coverUri = book.coverUri
                )
                return Resolution.Ready(
                    session = session,
                    items = MediaItems.forLocal(book),
                    // No server session offline: the syncer's own `local_pos_`
                    // marker is the resume point.
                    startSeconds = queue.resumePosition(book.itemId, episode) ?: 0.0
                )
            }

            // Streaming needs credentials AND a reachable server; the two failures
            // resolve differently in the car (a sign-in affordance vs. an error
            // message), so they stay distinct.
            if (credsRepository.creds.first() == null) return Resolution.Failed(PlayResult.NotConfigured)
            val playSession = openSession(itemId, episodeId)
                ?: return Resolution.Failed(PlayResult.NeedsNetwork)
            if (playSession.audioTracks.isEmpty()) return Resolution.Failed(PlayResult.NoTracks)

            val artwork = coverUrl(playSession.libraryItemId)
            val items = MediaItems.forSession(playSession, resolveUrl, artwork)
            if (items.isEmpty()) return Resolution.Failed(PlayResult.NeedsNetwork)
            val session = ActiveSession(
                serverSessionId = playSession.id,
                itemId = playSession.libraryItemId,
                episodeId = playSession.episodeId,
                mediaType = playSession.mediaType,
                title = playSession.displayTitle,
                author = playSession.displayAuthor,
                duration = playSession.duration,
                chapters = playSession.chapters,
                tracks = playSession.audioTracks,
                coverUri = artwork
            )
            return Resolution.Ready(session, items, playSession.currentTime)
        }

        /**
         * Offline chapter navigation, derived from the track table.
         *
         * DownloadEntry (the frozen cross-wave shape) carries no chapter list, so
         * a downloaded book has none to show. For a multi-file audiobook the
         * files ARE the chapters, which makes prev/next chapter behave offline
         * exactly as it does online. A single-file download gets an EMPTY list
         * rather than one bogus whole-book "chapter" — a caller with no chapter
         * table falls back to track stepping, which for one track is a no-op.
         */
        internal fun localChapters(tracks: List<AudioTrack>): List<Chapter> {
            if (tracks.size < 2) return emptyList()
            return tracks.mapIndexed { i, t ->
                Chapter(i, t.startOffset, t.startOffset + t.duration, "Part ${i + 1}")
            }
        }
    }
}
