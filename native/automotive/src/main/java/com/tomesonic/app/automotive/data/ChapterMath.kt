package com.tomesonic.app.automotive.data

/**
 * Pure chapter/track position math — the Kotlin port of native/utils/chapterMath.ts
 * plus the chapter-navigation rules the phone's usePlaybackStore applies around it.
 *
 * Kept side-effect free (no Android types, no player) so the boundary semantics
 * can be pinned by plain JVM tests, exactly like the TS original: the Media
 * Center's scrubber, the chapter title, prev/next chapter and the progress
 * syncer all derive from these two mappings, and a boundary fixed in one copy
 * but not the others is precisely the desync the TS extraction existed to
 * prevent.
 *
 * ARGUMENT ORDER differs from the TS (`chapterIndexAt(chapters, pos)`): every
 * function here takes the position FIRST, so the whole file reads consistently
 * with `chapterAt(absSeconds, chapters)`.
 */
object ChapterMath {

    /**
     * How far into a chapter the "previous chapter" action restarts it instead of
     * stepping back — usePlaybackStore.previousChapter's `within > 3` rule.
     */
    const val RESTART_WITHIN_SECONDS = 3.0

    /** Where an absolute book position lands inside a track queue. */
    data class TrackPosition(val trackIndex: Int, val positionSeconds: Double)

    /**
     * Index of the chapter containing `absSeconds`, using HALF-OPEN intervals
     * [start, end): a position equal to a chapter's `end` already belongs to the
     * NEXT chapter, so a boundary can never match twice. -1 when the position
     * falls outside every chapter, for empty/null lists, and for NaN/±Infinity
     * (which simply fail both comparisons — no special case, no throw).
     *
     * A zero-length chapter (start == end) can never match, matching the TS.
     */
    fun chapterIndexAt(absSeconds: Double, chapters: List<Chapter>?): Int {
        val list = chapters ?: return -1
        for (i in list.indices) {
            val c = list[i]
            if (absSeconds >= c.start && absSeconds < c.end) return i
        }
        return -1
    }

    /** The chapter containing `absSeconds`, or null when none does. */
    fun chapterAt(absSeconds: Double, chapters: List<Chapter>?): Chapter? {
        val idx = chapterIndexAt(absSeconds, chapters)
        return if (idx < 0) null else chapters?.get(idx)
    }

    /** Seconds elapsed inside the current chapter; 0.0 when no chapter matches. */
    fun chapterElapsed(absSeconds: Double, chapters: List<Chapter>?): Double {
        val c = chapterAt(absSeconds, chapters) ?: return 0.0
        val within = absSeconds - c.start
        return if (within > 0.0) within else 0.0
    }

    /**
     * 0..1 through the current chapter. 0.0 when no chapter matches AND when the
     * chapter has no length — a zero-duration chapter would otherwise divide by
     * zero into NaN and poison every progress bar downstream.
     */
    fun chapterProgress(absSeconds: Double, chapters: List<Chapter>?): Double {
        val c = chapterAt(absSeconds, chapters) ?: return 0.0
        val length = c.end - c.start
        if (length <= 0.0) return 0.0
        return ((absSeconds - c.start) / length).coerceIn(0.0, 1.0)
    }

    /** Start of the chapter AFTER the one holding `absSeconds`; null at/after the last. */
    fun nextChapterStart(absSeconds: Double, chapters: List<Chapter>?): Double? {
        val idx = chapterIndexAt(absSeconds, chapters)
        if (idx < 0) return null
        return chapters?.getOrNull(idx + 1)?.start
    }

    /**
     * Where "previous chapter" should seek — the phone's rule, ported whole:
     * more than [restartWithinSeconds] into the current chapter RESTARTS it;
     * otherwise step back one; with no previous chapter, restart the current one.
     * null when no chapter contains the position (nothing to step from).
     */
    fun prevChapterStart(
        absSeconds: Double,
        chapters: List<Chapter>?,
        restartWithinSeconds: Double = RESTART_WITHIN_SECONDS
    ): Double? {
        val idx = chapterIndexAt(absSeconds, chapters)
        if (idx < 0) return null
        val list = chapters ?: return null
        val current = list[idx]
        if (absSeconds - current.start > restartWithinSeconds) return current.start
        return list.getOrNull(idx - 1)?.start ?: current.start
    }

    /**
     * (trackIndex, track-relative seconds) -> ABSOLUTE book seconds.
     *
     * Deviates from the TS deliberately: `absolutePositionFor` returns null for
     * single-file books because the phone's raw player position is already
     * absolute there. The car always builds one media3 item PER TRACK, so a
     * one-track queue has startOffset 0 and the addition is the identity — a
     * null would force every caller into a branch that can't differ. Null here
     * means only "that track index doesn't exist".
     */
    fun absolutePosition(
        tracks: List<AudioTrack>?,
        trackIndex: Int,
        trackPositionSeconds: Double
    ): Double? {
        val track = tracks?.getOrNull(trackIndex) ?: return null
        if (trackPositionSeconds.isNaN()) return null
        val abs = track.startOffset + trackPositionSeconds
        return if (abs > 0.0) abs else 0.0
    }

    /**
     * ABSOLUTE book seconds -> (trackIndex, track-relative seconds), the inverse
     * of [absolutePosition]. Clamps at both ends rather than failing: before the
     * first track is track 0 at 0.0, at/after the end is the last track at its
     * own duration (which is where a completed book's resume lands). null only
     * for an empty/null queue or a NaN position.
     */
    fun trackPositionAt(tracks: List<AudioTrack>?, absSeconds: Double): TrackPosition? {
        val list = tracks ?: return null
        if (list.isEmpty() || absSeconds.isNaN()) return null
        if (absSeconds <= list[0].startOffset) return TrackPosition(0, 0.0)
        for (i in list.indices) {
            val t = list[i]
            // Half-open like the chapter mapping: a position exactly on a track's
            // end belongs to the NEXT track. Zero-duration tracks never match.
            if (absSeconds < t.startOffset + t.duration) {
                return TrackPosition(i, absSeconds - t.startOffset)
            }
        }
        return TrackPosition(list.lastIndex, list[list.lastIndex].duration)
    }
}
