package com.tomesonic.app.automotive.playback

import android.os.SystemClock
import androidx.media3.common.Player
import com.tomesonic.app.automotive.data.AbsApi
import com.tomesonic.app.automotive.data.ChapterMath
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/**
 * How many seconds were actually LISTENED since the last claimed sync.
 *
 * Wall-clock elapsed time while the player reports playing — NOT position
 * deltas, which a seek would inflate, and not raw elapsed time, which would
 * bill a parked car for the hours it sat paused in a driveway.
 *
 * Pure and clock-injected so play/pause/seek accounting is pinned by plain JVM
 * tests: this number is the only input to ABS's listening stats and streaks,
 * and getting it wrong is invisible in the car and permanent on the server.
 */
internal class ListenAccumulator(private val maxIntervalSeconds: Double = MAX_INTERVAL_SECONDS) {

    private var baselineMs: Long? = null
    private var seconds = 0.0

    /**
     * Fold the interval that just ended into the total, then re-baseline.
     *
     * `nowMs` MUST be MONOTONIC (SystemClock.elapsedRealtime), never wall clock:
     * an NTP correction mid-chapter would otherwise add — or subtract — minutes
     * nobody listened to.
     *
     * A baseline exists ONLY while playing, so its presence is itself the proof
     * that the whole interval was played. That is what lets a pause bank its
     * final partial interval (up to 15s of real listening) instead of discarding
     * it, while a resume after an hour paused banks nothing.
     */
    fun update(nowMs: Long, isPlaying: Boolean) {
        val since = baselineMs
        if (since != null) {
            val delta = (nowMs - since).coerceAtLeast(0L) / 1000.0
            // Capped: a deferred coroutine (a suspended process, a head unit that
            // slept with the ignition) can stretch one interval arbitrarily, and
            // an hour banked from a single tick is never a real reading.
            seconds += minOf(delta, maxIntervalSeconds)
        }
        baselineMs = if (isPlaying) nowMs else null
    }

    val pending: Double get() = seconds

    /**
     * Mark `delivered` seconds as claimed. Subtracts rather than zeroes: seconds
     * accrued while a request is in flight are still owed, and blind-clearing
     * them is the listening-time loss the phone's TOCTOU guard exists to stop.
     */
    fun consume(delivered: Double) {
        seconds = (seconds - delivered).coerceAtLeast(0.0)
    }

    fun reset() {
        seconds = 0.0
        baselineMs = null
    }

    companion object {
        const val MAX_INTERVAL_SECONDS = 120.0
    }
}

/**
 * Persists playback position and listening time for the ACTIVE session.
 *
 * Cadence mirrors the phone (utils/progressSync.ts + usePlaybackStore): every
 * 15s while playing, plus on pause, on seek, and on stop.
 *
 * Two destinations, chosen by the session's own kind:
 *  - SERVER session -> `POST /api/session/{id}/sync` (and `/close` on stop).
 *  - LOCAL session  -> [OfflineProgressQueue]: the position patch, the
 *    cumulative item+day listening record, and the `local_pos_` resume marker.
 *
 * A FAILED server sync falls back to the same offline queues rather than
 * holding the seconds in memory until the process dies. Nothing is double
 * counted: the seconds are claimed once, and ABS keys the queued record under an
 * `automotive-local_` id that upserts separately from the streaming session.
 *
 * The tick is a coroutine keyed to the player's isPlaying, not a Handler: a
 * timer would keep firing (and keep the process warm) through pauses and would
 * outlive the session it belongs to.
 */
class ProgressSyncer(
    private val player: Player,
    private val main: CoroutineDispatcher,
    private val scope: CoroutineScope,
    private val api: AbsApi,
    private val queue: OfflineProgressQueue,
    private val nowMs: () -> Long = SystemClock::elapsedRealtime,
    private val tickMs: Long = TICK_MS
) {

    private val accumulator = ListenAccumulator()

    // The player's isPlaying, mirrored so the tick loop can be CANCELLED on
    // pause rather than woken 4 times a minute to discover it has nothing to do.
    private val playing = MutableStateFlow(false)

    // Guards CLAIMING a sample (player read + accumulator arithmetic) — never
    // the network leg. Two claims interleaving would send the same seconds
    // twice; holding this across a request would make a book switch wait out an
    // offline client timeout.
    private val claimLock = Mutex()

    private var seekJob: Job? = null
    private var lastFlushAtMs = 0L

    private val listener = object : Player.Listener {
        override fun onIsPlayingChanged(isPlaying: Boolean) {
            // Fold the closing interval HERE, on the callback, not inside the
            // async sync below — that runs milliseconds later and would bill the
            // gap as listening.
            accumulator.update(nowMs(), isPlaying)
            playing.value = isPlaying
            if (!isPlaying) scope.launch { sync(closing = false) }
        }

        override fun onPositionDiscontinuity(
            oldPosition: Player.PositionInfo,
            newPosition: Player.PositionInfo,
            reason: Int
        ) {
            // Only a real seek. Automatic transitions between tracks are the
            // same book position and already covered by the tick.
            if (reason == Player.DISCONTINUITY_REASON_SEEK) scheduleSeekSync()
        }

        override fun onPlaybackStateChanged(playbackState: Int) {
            // End of book: close the session now rather than at a next tick that
            // will never come (isPlaying went false with nothing to resume).
            if (playbackState == Player.STATE_ENDED) scope.launch { finish() }
        }
    }

    init {
        scope.launch(main) { player.addListener(listener) }
        // The loop runs OFF the player's thread — it spends its life in delay()
        // and network calls, and only the claim hops to main.
        scope.launch {
            playing.collectLatest { isPlaying ->
                if (!isPlaying) return@collectLatest
                while (true) {
                    delay(tickMs)
                    sync(closing = false)
                }
            }
        }
    }

    /** A new session is loaded: nothing from the previous one is owed any more. */
    fun onSessionStarted() {
        accumulator.reset()
    }

    /** Final sync + closeSession for the outgoing session, awaited. */
    suspend fun finish() {
        val claimed = claimFinal() ?: return
        deliver(claimed, closing = true)
    }

    /**
     * [finish] for a book SWITCH: the position is claimed synchronously (so the
     * incoming queue can't be read as the outgoing one's) but the network leg
     * runs in the background. Awaiting it would make every switch wait out the
     * client's read timeout whenever the car is out of coverage.
     */
    suspend fun handOff() {
        val claimed = claimFinal() ?: return
        scope.launch { deliver(claimed, closing = true) }
    }

    /**
     * Service teardown. MUST be called on the player's thread — it reads the
     * position SYNCHRONOUSLY (onDestroy is the last moment the player is alive)
     * and delivers on a scope that outlives the service, because a network round
     * trip on the main thread during teardown is an ANR.
     *
     * Everything that matters has usually landed already: pause and stop both
     * sync before teardown can happen. This is the belt for what doesn't — a
     * service stopped while paused mid-book, which on a car is every trip that
     * ends with the ignition.
     */
    fun finishDetached() {
        stopTicking()
        val session = PlaybackState.active.value ?: return
        accumulator.update(nowMs(), false)
        val listened = accumulator.pending
        accumulator.consume(listened)
        val absolute = ChapterMath.absolutePosition(
            session.tracks,
            player.currentMediaItemIndex,
            player.currentPosition / 1000.0
        )
        PlaybackState.set(null)
        if (absolute == null) return
        val claimed = Claim(session, absolute, listened)
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch { deliver(claimed, closing = true) }
    }

    /** Deliver whatever the offline queues still owe, ignoring the rate limit. */
    suspend fun flushOfflineQueues(): Boolean {
        lastFlushAtMs = nowMs()
        return queue.flush(api)
    }

    /** Drop the player listener. Call on the player's thread. */
    fun release() {
        stopTicking()
        player.removeListener(listener)
    }

    // ---- internals ----------------------------------------------------------

    private fun stopTicking() {
        seekJob?.cancel()
        seekJob = null
        playing.value = false
    }

    private fun scheduleSeekSync() {
        // Debounced: scrubbing a car's progress bar fires a discontinuity per
        // step, and each one would otherwise be a request.
        seekJob?.cancel()
        seekJob = scope.launch {
            delay(SEEK_DEBOUNCE_MS)
            sync(closing = false)
        }
    }

    private suspend fun sync(closing: Boolean) {
        val claimed = claimLock.withLock { claim(closing) } ?: return
        deliver(claimed, closing)
    }

    private suspend fun claimFinal(): Claim? {
        stopTicking()
        val claimed = claimLock.withLock { claim(closing = true) }
        // Nothing playable to report, but the session is still over.
        if (claimed == null) PlaybackState.set(null)
        return claimed
    }

    /**
     * Read the player and take ownership of the seconds owed. Fast by
     * construction — no network, no DataStore — so the lock around it can never
     * hold up a play/stop.
     */
    private suspend fun claim(closing: Boolean): Claim? {
        val session = PlaybackState.active.value ?: return null
        val sample = withContext(main) {
            accumulator.update(nowMs(), player.isPlaying)
            Sample(
                trackIndex = player.currentMediaItemIndex,
                trackPositionMs = player.currentPosition,
                listened = accumulator.pending
            )
        }
        // Claim NOTHING when the position is unreadable (an empty or torn-down
        // queue) — the seconds stay owed to the next sync rather than vanishing.
        val absolute = ChapterMath.absolutePosition(
            session.tracks,
            sample.trackIndex,
            sample.trackPositionMs / 1000.0
        ) ?: return null
        withContext(main) { accumulator.consume(sample.listened) }
        // Clearing HERE, under the lock, is what stops an incoming book's queue
        // from being read as the outgoing session's position.
        if (closing) PlaybackState.set(null)
        return Claim(session, absolute, sample.listened)
    }

    private suspend fun deliver(claimed: Claim, closing: Boolean) {
        val session = claimed.session
        val sessionId = session.serverSessionId
        if (sessionId != null) {
            val delivered = if (closing) {
                api.closeSession(sessionId, claimed.absolute, claimed.listened, session.duration)
            } else {
                api.syncSession(sessionId, claimed.absolute, claimed.listened, session.duration)
            }
            if (delivered) {
                // An online moment is the cheapest flush trigger there is.
                flushOfflineQueues()
            } else {
                // Offline mid-stream. These seconds have no other durable home —
                // the queued `automotive-local_` record upserts independently of
                // the streaming session, so banking them here can't double count.
                bank(session, claimed, persistResume = false)
            }
        } else {
            bank(session, claimed, persistResume = true)
            // Opportunistic, like the phone's flushPendingSyncs after every local
            // sync — but rate limited, because offline this is a radio wake every
            // 15s for a request that cannot succeed.
            if (closing || nowMs() - lastFlushAtMs >= FLUSH_MIN_INTERVAL_MS) flushOfflineQueues()
        }
    }

    private suspend fun bank(session: ActiveSession, claimed: Claim, persistResume: Boolean) =
        queue.record(
            itemId = session.itemId,
            episodeId = session.episodeId,
            currentTime = claimed.absolute,
            duration = session.duration,
            secondsListened = claimed.listened,
            title = session.title,
            author = session.author,
            mediaType = session.mediaType,
            persistResume = persistResume
        )

    private class Sample(
        val trackIndex: Int,
        val trackPositionMs: Long,
        val listened: Double
    )

    private class Claim(
        val session: ActiveSession,
        val absolute: Double,
        val listened: Double
    )

    companion object {
        /** Same 15s the phone uses — ABS's own client cadence. */
        const val TICK_MS = 15_000L

        /** One request per scrub gesture, not one per step. */
        const val SEEK_DEBOUNCE_MS = 1_000L

        /** Offline, a flush is a failed radio wake; don't take one every tick. */
        const val FLUSH_MIN_INTERVAL_MS = 60_000L
    }
}
