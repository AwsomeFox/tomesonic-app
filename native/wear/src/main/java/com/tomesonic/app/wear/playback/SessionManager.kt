package com.tomesonic.app.wear.playback

import android.net.Uri
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import com.tomesonic.app.wear.Graph
import com.tomesonic.app.wear.data.AbsApi
import com.tomesonic.app.wear.data.AbsClient
import com.tomesonic.app.wear.data.AudioTrack
import com.tomesonic.app.wear.data.Chapter
import com.tomesonic.app.wear.data.ChapterMath
import com.tomesonic.app.wear.data.CredsRepository
import com.tomesonic.app.wear.data.PlaySession
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext

/**
 * What a play attempt did. Sealed rather than a boolean because the watch's
 * only useful error UI is three distinct sentences ("no connection", "no
 * audio", "reconnect from phone") and a caller must not have to guess which.
 */
sealed interface PlayResult {
    data object Ok : PlayResult
    data object NeedsNetwork : PlayResult
    data object NoTracks : PlayResult
    data object NotConfigured : PlayResult
}

/**
 * A downloaded book as PLAYBACK sees it. Deliberately Wave 3A's own type: the
 * downloads package is being written in parallel, and SessionManager's whole
 * resolution path stays JVM-testable (and compilable) with nothing but this.
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
}

/** Where the downloads package plugs itself in — see DownloadsLocalSource. */
object PlaybackWiring {
    /**
     * Null means "nothing is downloaded", which is the correct behaviour for a
     * build where the downloads package hasn't been wired yet: playback streams.
     */
    @Volatile
    var localSource: LocalPlaybackSource? = null
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
 * The service and the UI share ONE process on the watch, and a MediaController
 * carries no chapter table or track offsets — everything the player reports is
 * (mediaItemIndex, position-in-item). Rather than smuggle the whole chapter
 * list through MediaItem extras and re-parse it per poll, PlayerConnection
 * reads it from here. Null when nothing has been played this process; the UI
 * degrades to the controller's own metadata.
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
     * media notification and every controller name the BOOK. The chapter title
     * belongs to the UI (PlayerConnection derives it from ChapterMath) — media3
     * would have to rewrite the queue to change it, which resets scroll in every
     * connected controller.
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
 *                   Never streams a book we already have; never needs the network.
 *  - otherwise   -> requires the network. `POST /api/items/{id}/play`, stream the
 *                   session's tracks, progress via `/api/session/{id}/sync`.
 *
 * Player mutations all go through [main] because media3 requires every call on
 * the thread the player was built on.
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

    suspend fun play(itemId: String, episodeId: String? = null): PlayResult {
        if (itemId.isBlank()) return PlayResult.NoTracks

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
        // The home screen's resume card reads this; write it only once the queue
        // is actually loaded so a failed play can't repoint it.
        credsRepository.setLastItem(itemId, episodeId)
        return PlayResult.Ok
    }

    /** Final sync + closeSession, then an empty player. Safe with nothing playing. */
    suspend fun stop() {
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
         * The whole local-vs-stream decision, with no player attached so it can
         * be tested on its own.
         *
         * Order matters: the download check comes FIRST and short-circuits, so a
         * downloaded book never touches the network — not for the session, not
         * for the cover — and plays identically whether the watch is online.
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
            // Podcast EPISODES are never downloaded in v1 (contract non-goal), so
            // only a bare item id can resolve locally — asking for a downloaded
            // podcast's episode must still stream that episode.
            val book = if (episodeId.isNullOrBlank()) local?.localBook(itemId) else null
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
                    episodeId = null,
                    mediaType = "book",
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
                    startSeconds = queue.resumePosition(book.itemId, null) ?: 0.0
                )
            }

            // Streaming needs credentials AND a reachable server; the two failures
            // read differently to the user, so they stay distinct.
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
         * rather than one bogus whole-book "chapter" — PlayerConnection falls
         * back to track stepping there, which for one track is a no-op.
         */
        internal fun localChapters(tracks: List<AudioTrack>): List<Chapter> {
            if (tracks.size < 2) return emptyList()
            return tracks.mapIndexed { i, t ->
                Chapter(i, t.startOffset, t.startOffset + t.duration, "Part ${i + 1}")
            }
        }
    }
}
