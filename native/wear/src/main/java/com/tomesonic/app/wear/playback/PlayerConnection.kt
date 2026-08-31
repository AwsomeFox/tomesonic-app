package com.tomesonic.app.wear.playback

import android.content.ComponentName
import android.content.Context
import android.os.Bundle
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionToken
import com.tomesonic.app.wear.Graph
import com.tomesonic.app.wear.data.AudioTrack
import com.tomesonic.app.wear.data.Chapter
import com.tomesonic.app.wear.data.ChapterMath
import com.tomesonic.app.wear.data.CredsRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlin.coroutines.resume

/**
 * Everything the player UI renders, in ONE value. `positionMs`/`durationMs` are
 * BOOK-absolute, not track-relative — the queue is one media item per track, so
 * the player's own numbers are meaningless to a scrubber.
 */
data class PlayerUiState(
    val isPlaying: Boolean = false,
    val itemId: String? = null,
    val episodeId: String? = null,
    val title: String = "",
    val author: String = "",
    val chapterTitle: String? = null,
    val positionMs: Long = 0L,
    val durationMs: Long = 0L,
    val chapterIndex: Int = -1,
    val chapterCount: Int = 0,
    val speed: Float = CredsRepository.DEFAULT_SPEED,
    val coverUri: String? = null
)

/**
 * Where the transport buttons actually point, as pure functions.
 *
 * Split out from the controller so the boundary rules — the phone's >3s
 * restart, clamping at both ends of the book, and the track fallback for a
 * download with no chapter list — are pinned by JVM tests instead of by tapping
 * a watch.
 */
object PlaybackMath {

    /** The contract's transport: −30s / +30s, matching the seek increments. */
    const val SEEK_SECONDS = 30.0

    fun clamp(target: Double, durationSeconds: Double): Double = when {
        !target.isFinite() -> 0.0
        durationSeconds > 0.0 -> target.coerceIn(0.0, durationSeconds)
        else -> target.coerceAtLeast(0.0)
    }

    fun seekTarget(currentSeconds: Double, deltaSeconds: Double, durationSeconds: Double): Double =
        clamp(currentSeconds + deltaSeconds, durationSeconds)

    /**
     * Start of the next chapter — or, for a download with no chapter table, of
     * the next TRACK. Null at the end of the book: "next" with nothing after it
     * must not silently restart anything.
     */
    fun nextTarget(
        currentSeconds: Double,
        chapters: List<Chapter>,
        tracks: List<AudioTrack>,
        durationSeconds: Double
    ): Double? {
        if (chapters.isNotEmpty()) {
            return ChapterMath.nextChapterStart(currentSeconds, chapters)?.let { clamp(it, durationSeconds) }
        }
        val here = ChapterMath.trackPositionAt(tracks, currentSeconds) ?: return null
        val next = tracks.getOrNull(here.trackIndex + 1) ?: return null
        return clamp(next.startOffset, durationSeconds)
    }

    /**
     * The phone's previousChapter rule, ported whole: more than
     * [ChapterMath.RESTART_WITHIN_SECONDS] in restarts the current unit,
     * otherwise step back one; at the very first, restart it.
     */
    fun prevTarget(
        currentSeconds: Double,
        chapters: List<Chapter>,
        tracks: List<AudioTrack>,
        durationSeconds: Double
    ): Double? {
        if (chapters.isNotEmpty()) {
            return ChapterMath.prevChapterStart(currentSeconds, chapters)?.let { clamp(it, durationSeconds) }
        }
        val here = ChapterMath.trackPositionAt(tracks, currentSeconds) ?: return null
        val current = tracks.getOrNull(here.trackIndex) ?: return null
        if (here.positionSeconds > ChapterMath.RESTART_WITHIN_SECONDS) {
            return clamp(current.startOffset, durationSeconds)
        }
        val previous = tracks.getOrNull(here.trackIndex - 1) ?: current
        return clamp(previous.startOffset, durationSeconds)
    }
}

/**
 * The UI's ONLY door to playback (Wave 4A consumes nothing else).
 *
 * Wraps a MediaController over [PlaybackService]'s session and republishes it
 * as a single [PlayerUiState]. Two properties it must never lose:
 *  - constructible BEFORE the service exists — connecting is what starts it;
 *  - survives a disconnect — every command re-checks the controller and
 *    reconnects, because the service dies with playback and the player screen
 *    can outlive it.
 *
 * Everything runs on the app's main thread: media3 requires a controller to be
 * touched only from the thread it was built on, and honouring that with a
 * dispatcher is cheaper than a lock around every call. The dispatcher is built
 * from Context.getMainExecutor rather than Dispatchers.Main so it depends on
 * nothing but coroutines-core.
 */
class PlayerConnection(
    context: Context,
    private val credsRepository: CredsRepository = Graph.credsRepository
) {

    private val appContext: Context = context.applicationContext
    private val main = appContext.mainExecutor.asCoroutineDispatcher()
    private val scope = CoroutineScope(SupervisorJob() + main)

    private val _state = MutableStateFlow(PlayerUiState())
    val state: StateFlow<PlayerUiState> = _state.asStateFlow()

    private val connectLock = Mutex()
    private var controller: MediaController? = null

    init {
        // Poll only while something is actually observing: on a watch, a 1s loop
        // nobody reads is a measurable amount of battery.
        scope.launch {
            _state.subscriptionCount
                .map { it > 0 }
                .distinctUntilChanged()
                .collectLatest { observed ->
                    if (!observed) return@collectLatest
                    ensureController()
                    while (true) {
                        refresh()
                        delay(POLL_MS)
                    }
                }
        }
        // Speed is a PERSISTED setting, not a player property: it has to render
        // before any service exists and survive every reconnect.
        scope.launch {
            credsRepository.playbackSpeed.collect { speed ->
                _state.value = _state.value.copy(speed = speed)
            }
        }
        // The chapter table lives with the session, not the controller — refresh
        // the moment a new book is loaded rather than up to a poll later.
        scope.launch { PlaybackState.active.collect { refresh() } }
    }

    // ---- commands -----------------------------------------------------------

    fun playPause() = command { controller ->
        if (controller.isPlaying) {
            controller.pause()
        } else {
            // A stopped service leaves an IDLE player holding the queue; play()
            // alone does nothing there.
            if (controller.playbackState == Player.STATE_IDLE) controller.prepare()
            controller.play()
        }
    }

    /** ±seconds across TRACK boundaries — the player's own seek is item-local. */
    fun seekBy(seconds: Int) = command { controller ->
        seekToAbsolute(
            controller,
            PlaybackMath.seekTarget(absolutePosition(controller), seconds.toDouble(), durationSeconds())
        )
    }

    fun nextChapter() = command { controller ->
        val session = PlaybackState.active.value
        PlaybackMath.nextTarget(
            absolutePosition(controller),
            session?.chapters.orEmpty(),
            session?.tracks.orEmpty(),
            durationSeconds()
        )?.let { seekToAbsolute(controller, it) }
    }

    fun prevChapter() = command { controller ->
        val session = PlaybackState.active.value
        PlaybackMath.prevTarget(
            absolutePosition(controller),
            session?.chapters.orEmpty(),
            session?.tracks.orEmpty(),
            durationSeconds()
        )?.let { seekToAbsolute(controller, it) }
    }

    /** Applies now and persists — the next book must open at the same rate. */
    fun setSpeed(speed: Float) {
        if (!speed.isFinite() || speed <= 0f) return
        _state.value = _state.value.copy(speed = speed)
        scope.launch { credsRepository.setPlaybackSpeed(speed) }
        command { it.setPlaybackSpeed(speed) }
    }

    /**
     * Start (or switch to) an item. Connecting is what STARTS the service —
     * media3 binds with BIND_AUTO_CREATE — so there is no separate start here.
     */
    fun playItem(itemId: String, episodeId: String? = null) {
        if (itemId.isBlank()) return
        command { controller ->
            val args = Bundle().apply {
                putString(PlaybackService.EXTRA_ITEM_ID, itemId)
                if (!episodeId.isNullOrBlank()) putString(PlaybackService.EXTRA_EPISODE_ID, episodeId)
            }
            controller.sendCustomCommand(SessionCommand(PlaybackService.ACTION_PLAY_ITEM, Bundle.EMPTY), args)
        }
    }

    /**
     * A custom command rather than Player.stop(): stopping must also deliver the
     * final position and CLOSE the ABS session, which only SessionManager can do.
     */
    fun stop() = command { controller ->
        controller.sendCustomCommand(SessionCommand(PlaybackService.ACTION_STOP, Bundle.EMPTY), Bundle.EMPTY)
    }

    /** Drop the controller. The service and its playback are untouched. */
    fun release() {
        scope.launch {
            connectLock.withLock {
                controller?.release()
                controller = null
            }
        }
    }

    // ---- controller plumbing ------------------------------------------------

    private fun command(block: (MediaController) -> Unit) {
        scope.launch {
            val controller = ensureController() ?: return@launch
            try {
                block(controller)
            } catch (t: Throwable) {
                // The session can die between the isConnected check and the call.
                // A dead transport button is better than a crashed watch face.
            }
            refresh()
        }
    }

    private suspend fun ensureController(): MediaController? = connectLock.withLock {
        controller?.let { existing ->
            if (existing.isConnected) return@withLock existing
            try {
                existing.release()
            } catch (t: Throwable) {
                // Already gone.
            }
            controller = null
        }
        val connected = connect()
        controller = connected
        connected
    }

    /**
     * Bridges media3's ListenableFuture without kotlinx-coroutines-guava (not a
     * dependency). A failure — no service, a bind refused — resolves to null:
     * the UI shows nothing playing rather than throwing into a composable.
     */
    private suspend fun connect(): MediaController? = suspendCancellableCoroutine { continuation ->
        val future = try {
            val token = SessionToken(appContext, ComponentName(appContext, PlaybackService::class.java))
            MediaController.Builder(appContext, token).buildAsync()
        } catch (t: Throwable) {
            continuation.resume(null)
            return@suspendCancellableCoroutine
        }
        future.addListener({
            val result = try {
                future.get()
            } catch (t: Throwable) {
                null
            }
            if (continuation.isActive) continuation.resume(result)
        }, appContext.mainExecutor)
        continuation.invokeOnCancellation { MediaController.releaseFuture(future) }
    }

    private fun refresh() {
        val controller = this.controller
        val session = PlaybackState.active.value
        if (controller == null || !controller.isConnected) {
            // Keep the last known book on screen; only the transport is stale.
            _state.value = _state.value.copy(isPlaying = false)
            return
        }

        val absoluteSeconds = absolutePosition(controller)
        val duration = durationSeconds()
        val chapters = session?.chapters.orEmpty()
        val chapterIndex = ChapterMath.chapterIndexAt(absoluteSeconds, chapters)
        val metadata = controller.mediaMetadata

        _state.value = PlayerUiState(
            isPlaying = controller.isPlaying,
            itemId = session?.itemId,
            episodeId = session?.episodeId,
            title = session?.title ?: metadata.title?.toString() ?: "",
            author = session?.author ?: metadata.artist?.toString() ?: "",
            chapterTitle = chapters.getOrNull(chapterIndex)?.title,
            positionMs = (absoluteSeconds * 1000.0).toLong(),
            durationMs = (duration * 1000.0).toLong(),
            chapterIndex = chapterIndex,
            chapterCount = chapters.size,
            speed = _state.value.speed,
            coverUri = session?.coverUri ?: metadata.artworkUri?.toString()
        )
    }

    /**
     * The ChapterForwardingPlayer presents a single-file chaptered book as
     * per-chapter windows, so the controller's (itemIndex, position) is
     * CHAPTER-relative there — recognizable by the windows' "abschap-<n>"
     * mediaIds — and translates via the chapter table instead of the track
     * table. Track startOffset cancels out of both directions
     * (rel = abs - chapter.start regardless of the file's offset).
     */
    private fun windowChapterIndex(controller: MediaController): Int? {
        val id = controller.currentMediaItem?.mediaId ?: return null
        if (!id.startsWith("abschap-")) return null
        return id.removePrefix("abschap-").toIntOrNull() ?: controller.currentMediaItemIndex
    }

    /** Book-absolute seconds. Falls back to the raw position with no session. */
    private fun absolutePosition(controller: MediaController): Double {
        val session = PlaybackState.active.value ?: return controller.currentPosition / 1000.0
        windowChapterIndex(controller)?.let { idx ->
            val chapter = session.chapters.getOrNull(idx)
                ?: return controller.currentPosition / 1000.0
            return chapter.start + controller.currentPosition / 1000.0
        }
        return ChapterMath.absolutePosition(
            session.tracks,
            controller.currentMediaItemIndex,
            controller.currentPosition / 1000.0
        ) ?: 0.0
    }

    private fun durationSeconds(): Double {
        PlaybackState.active.value?.let { if (it.duration > 0.0) return it.duration }
        val controller = this.controller ?: return 0.0
        val ms = controller.contentDuration
        return if (ms > 0L) ms / 1000.0 else 0.0
    }

    private fun seekToAbsolute(controller: MediaController, absoluteSeconds: Double) {
        val session = PlaybackState.active.value
        if (windowChapterIndex(controller) != null) {
            // Chapter-window timeline: address the seek to the window that
            // contains the target, positioned relative to that chapter.
            val chapters = session?.chapters.orEmpty()
            val idx = ChapterMath.chapterIndexAt(absoluteSeconds, chapters)
            val chapterStart = chapters.getOrNull(idx)?.start
            if (chapterStart != null) {
                val relMs = ((absoluteSeconds - chapterStart).coerceAtLeast(0.0) * 1000.0).toLong()
                controller.seekTo(idx, relMs)
                return
            }
        }
        val tracks = session?.tracks
        if (tracks.isNullOrEmpty()) {
            controller.seekTo((absoluteSeconds * 1000.0).toLong())
            return
        }
        val target = ChapterMath.trackPositionAt(tracks, absoluteSeconds) ?: return
        controller.seekTo(target.trackIndex, (target.positionSeconds * 1000.0).toLong())
    }

    companion object {
        /** Fast enough for a moving scrubber, slow enough for a watch battery. */
        const val POLL_MS = 1_000L
    }
}
