package com.tomesonic.app.wear.playback

import android.os.Handler
import android.os.Looper
import androidx.media3.common.C
import androidx.media3.common.ForwardingSimpleBasePlayer
import androidx.media3.common.Player
import androidx.media3.common.SimpleBasePlayer
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import android.util.Log

/** One synthetic queue entry: a chapter of the single underlying file. */
data class ChapterWindow(val title: String, val startMs: Long, val endMs: Long)

/**
 * Presents a single-file audiobook to the MediaSession as a per-chapter queue
 * WITHOUT per-chapter media sources. The underlying player keeps ONE item (one
 * moov parse, flat memory at any book length — the whole point, see the
 * chapter-queue OOM notes in usePlaybackStore); this wrapper re-maps only the
 * session-facing presentation: a timeline of N chapter windows, chapter-relative
 * position/duration, and chapter titles as the current metadata. Android Auto's
 * queue, Bluetooth AVRCP track info, the media notification and Wear OS remote
 * controls all read this player, so they see chapters; every read the app's own
 * code performs goes to the real player and stays absolute.
 *
 * Action routing: the wrapped player is the service's raw ExoPlayer, so
 * transport calls act directly. Chapter-window seeks are translated to
 * ABSOLUTE positions and issued as plain seekTo(ms) on the real single-item
 * queue; next/previous arrive here already resolved against the synthetic
 * timeline by BasePlayer, so a media-key "next" lands on the next chapter.
 *
 * Boundary mechanics: nothing in the underlying player emits an event when
 * playback rolls across a synthetic boundary (it is one continuous file), so a
 * self-armed Handler tick invalidates state just after each upcoming chapter
 * end. SimpleBasePlayer's state diff then sees the previous window's position
 * at/past its duration and synthesizes DISCONTINUITY_REASON_AUTO_TRANSITION +
 * MEDIA_ITEM_TRANSITION_REASON_AUTO — indistinguishable from a real queue
 * advance to every controller.
 */
class ChapterForwardingPlayer(player: Player) : ForwardingSimpleBasePlayer(player) {

    private val handler = Handler(player.applicationLooper)
    private var chapters: List<ChapterWindow> = emptyList()
    private val boundaryTick = Runnable { invalidateState() }

    /**
     * Swap the underlying player (fakePlayer → real player at setupPlayer).
     * Runs synchronously when already on the player looper so the caller can
     * release the old player immediately after this returns.
     */
    fun swapPlayer(newPlayer: Player) {
        val block = Runnable {
            try {
                setPlayer(newPlayer)
            } catch (t: Throwable) {
                Log.w(TAG, "ChapterForwardingPlayer swap failed", t)
            }
        }
        if (Looper.myLooper() == handler.looper) block.run() else handler.post(block)
    }

    /**
     * Install (or with an empty list clear) the chapter map. Windows only take
     * effect while the underlying timeline has exactly one item — multi-file
     * books and podcast queues pass through untouched.
     */
    fun setChapters(list: List<ChapterWindow>) {
        handler.post {
            chapters = list.filter { it.endMs > it.startMs }.sortedBy { it.startMs }
            Log.d(TAG, "windows=" + chapters.size)
            invalidateState()
        }
    }

    private fun chapterIndexAt(absMs: Long): Int {
        var idx = 0
        for (i in chapters.indices) {
            if (chapters[i].startMs <= absMs) idx = i else break
        }
        return idx
    }

    override fun getState(): SimpleBasePlayer.State {
        val s = super.getState()
        val map = chapters
        val active = map.isNotEmpty() && !s.timeline.isEmpty && s.timeline.windowCount == 1
        scheduleBoundaryTick(s, map, active)
        if (!active) {
            // SimpleBasePlayer drops any seek whose command is missing from
            // ITS state — union the next/previous commands so controller
            // presses keep reaching the wrapped player exactly as before.
            return s.buildUpon()
                .setAvailableCommands(
                    s.availableCommands.buildUpon().addAll(
                        Player.COMMAND_SEEK_TO_NEXT,
                        Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM,
                        Player.COMMAND_SEEK_TO_PREVIOUS,
                        Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM,
                    ).build()
                )
                .build()
        }

        val realItem = s.timeline.getWindow(0, androidx.media3.common.Timeline.Window()).mediaItem
        val baseMeta = realItem.mediaMetadata
        val absPositionSupplier = s.contentPositionMsSupplier
        val absBufferedSupplier = s.contentBufferedPositionMsSupplier
        val absNow = absPositionSupplier.get()
        val idx = chapterIndexAt(absNow)
        val chStart = map[idx].startMs
        val chDur = map[idx].endMs - map[idx].startMs

        val windows = map.mapIndexed { i, ch ->
            val meta = baseMeta.buildUpon()
                .setTitle(ch.title)
                .setDisplayTitle(ch.title)
                .setTrackNumber(i + 1)
                .setTotalTrackCount(map.size)
                // NO inline artwork bytes on windows: the real item may carry
                // the LARGE cover bytes (single-item queue is allowed to), and
                // inheriting them onto 100+ windows would rebuild the ~1MB
                // Binder Timeline overflow the clipped queue once hit. The
                // artworkUri survives and the session's bitmap loader resolves
                // it once for every row/notification (same URI → one bitmap).
                .setArtworkData(null, null)
                .build()
            SimpleBasePlayer.MediaItemData.Builder("abschap-$i")
                .setMediaItem(
                    realItem.buildUpon().setMediaId("abschap-$i").setMediaMetadata(meta).build()
                )
                .setMediaMetadata(meta)
                .setDurationUs((ch.endMs - ch.startMs) * 1000)
                .setIsSeekable(true)
                .apply { if (i == idx) setTracks(s.currentTracks) }
                .build()
        }

        val out = s.buildUpon()
            .setPlaylist(windows)
            .setCurrentMediaItemIndex(idx)
            // Live suppliers so positions advance between invalidations. No
            // upper clamp: a position past the window's duration is exactly what
            // lets the state diff infer AUTO_TRANSITION at a boundary.
            .setContentPositionMs { maxOf(0L, absPositionSupplier.get() - chStart) }
            .setContentBufferedPositionMs {
                (absBufferedSupplier.get() - chStart).coerceIn(0L, chDur)
            }
            .setAvailableCommands(
                s.availableCommands.buildUpon().addAll(
                    Player.COMMAND_SEEK_TO_NEXT,
                    Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM,
                    Player.COMMAND_SEEK_TO_PREVIOUS,
                    Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM,
                    Player.COMMAND_SEEK_TO_MEDIA_ITEM,
                    Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM,
                ).build()
            )
        if (s.hasPositionDiscontinuity) {
            // The wrapped player reported an absolute discontinuity position;
            // restate it relative to the chapter that contains it.
            val abs = s.discontinuityPositionMs
            val discIdx = chapterIndexAt(abs)
            out.setPositionDiscontinuity(
                s.positionDiscontinuityReason,
                maxOf(0L, abs - map[discIdx].startMs)
            )
        }
        return out.build()
    }

    private fun scheduleBoundaryTick(
        s: SimpleBasePlayer.State,
        map: List<ChapterWindow>,
        active: Boolean,
    ) {
        handler.removeCallbacks(boundaryTick)
        if (!active) return
        if (s.playbackState != Player.STATE_READY || !s.playWhenReady) return
        val absNow = s.contentPositionMsSupplier.get()
        val idx = chapterIndexAt(absNow)
        if (idx >= map.size - 1) return // real STATE_ENDED covers the last window
        val speed = s.playbackParameters.speed.takeIf { it > 0f } ?: 1f
        val delayMs = (((map[idx].endMs - absNow) / speed).toLong() + 60L).coerceAtLeast(60L)
        handler.postDelayed(boundaryTick, delayMs)
    }

    override fun handleSeek(
        mediaItemIndex: Int,
        positionMs: Long,
        seekCommand: Int,
    ): ListenableFuture<*> {
        val map = chapters
        val underlying = player
        val active =
            map.isNotEmpty() &&
                !underlying.currentTimeline.isEmpty &&
                underlying.currentTimeline.windowCount == 1
        if (!active) return super.handleSeek(mediaItemIndex, positionMs, seekCommand)
        when (seekCommand) {
            // Jump seeks act on the UNDERLYING single-item player, whose
            // window is the whole file — they cross chapter boundaries instead
            // of clamping at the synthetic window edge the way BasePlayer's
            // pre-clamped positionMs would.
            Player.COMMAND_SEEK_BACK -> underlying.seekBack()
            Player.COMMAND_SEEK_FORWARD -> underlying.seekForward()
            else -> {
                if (mediaItemIndex == C.INDEX_UNSET || mediaItemIndex >= map.size) {
                    return Futures.immediateVoidFuture()
                }
                val rel = if (positionMs == C.TIME_UNSET) 0L else maxOf(0L, positionMs)
                // Absolute single-arg seek → one JS SEEK event; JS applies it to
                // the real player like any other remote seek.
                underlying.seekTo(map[mediaItemIndex].startMs + rel)
            }
        }
        return Futures.immediateVoidFuture()
    }

    override fun handleSetPlayWhenReady(playWhenReady: Boolean): ListenableFuture<*> {
        // play()/pause() rather than setPlayWhenReady: identical on a raw
        // ExoPlayer, and it keeps this class line-for-line with the phone
        // (RNTP) copy, where the distinction is load-bearing.
        if (playWhenReady) player.play() else player.pause()
        return Futures.immediateVoidFuture()
    }

    private companion object {
        const val TAG = "ChapterFwdPlayer"
    }
}
