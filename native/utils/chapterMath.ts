/**
 * Pure chapter/track position math shared by the playback pipelines.
 *
 * The same two derivations used to be copy-pasted inline across
 * usePlaybackStore's progress paths (native progress samples, the 1s tick
 * loop's cast + local branches, and the end-of-chapter sleep timer) — a
 * boundary bug fixed in one copy would silently desync the others (scrubber
 * vs notification title vs EOC pause vs Android Auto). Both helpers are pure
 * and side-effect free so the boundary semantics can be pinned by tests.
 */

/** Minimal chapter shape: absolute book-second boundaries. */
export interface ChapterLike {
  start?: number;
  end?: number;
  [key: string]: any;
}

/**
 * Index of the chapter containing `pos`, using HALF-OPEN intervals
 * [start, end): `pos === start` belongs to this chapter, `pos === end`
 * already belongs to the NEXT one — a boundary position can never match two
 * chapters. Returns -1 when `pos` falls outside every chapter, and for
 * empty/missing chapter lists. NaN/negative positions match nothing (-1)
 * without throwing.
 *
 * Missing/falsy start|end fall back to 0, matching the defensive
 * `findIndex((c) => pos >= (c.start || 0) && pos < (c.end || 0))` form used
 * by the sleep-timer/seek paths. (The progress-loop copies compared the raw
 * fields — identical behavior for well-formed numeric chapters; a chapter
 * with a MISSING start is now treated as starting at 0 instead of silently
 * never matching, which is the safer unification.)
 */
export function chapterIndexAt(
  chapters: readonly ChapterLike[] | null | undefined,
  pos: number
): number {
  if (!chapters || !chapters.length) return -1;
  for (let i = 0; i < chapters.length; i++) {
    const c = chapters[i];
    if (!c) continue;
    if (pos >= (c.start || 0) && pos < (c.end || 0)) return i;
  }
  return -1;
}

/**
 * Translate a PLAYER-relative position to an ABSOLUTE book position.
 *
 * Returns the absolute position when a translation applies, or `null` when it
 * does NOT — the caller decides the fallback (skip the sample, or keep its
 * raw/snapshot position). `null` rather than the raw position is load-bearing:
 * a track-0 offset of 0 is a SUCCESSFUL mapping that callers treat differently
 * (e.g. adopting the whole-book duration) from "could not map".
 *
 * - Chapter-clipped queue (`chapterQueue` with non-empty `chapters`): each
 *   queue item is one chapter, so `position` is chapter-relative and the
 *   track index IS the chapter index → `chapters[trackIndex].start + position`.
 *   Unknown/invalid index (mid track-transition) → null: a chapter-relative
 *   position would be wildly wrong as an absolute.
 * - Multi-file queue (`trackOffsets.length > 1`): `position` is FILE-relative
 *   → `trackOffsets[trackIndex] + position`. Unknown index/offset → null.
 * - Single-file (neither applies): null — the raw position is already
 *   absolute and the caller keeps it unchanged.
 */
export function absolutePositionFor(opts: {
  chapterQueue: boolean;
  chapters?: readonly ChapterLike[] | null;
  trackOffsets?: readonly number[] | null;
  trackIndex?: number | null;
  position: number;
}): number | null {
  const { chapterQueue, chapters, trackOffsets, trackIndex, position } = opts;
  if (chapterQueue && chapters && chapters.length) {
    if (typeof trackIndex === "number" && chapters[trackIndex]) {
      return (chapters[trackIndex].start || 0) + position;
    }
    return null;
  }
  if (
    trackOffsets &&
    trackOffsets.length > 1 &&
    typeof trackIndex === "number" &&
    trackOffsets[trackIndex] != null
  ) {
    return trackOffsets[trackIndex] + position;
  }
  return null;
}
