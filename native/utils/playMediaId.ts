/**
 * The ONE parser for the "play:" media-id grammar shared with the Kotlin patch
 * (Android Auto). A queue item's id is:
 *
 *     play:<itemId>[::<episodeId>][@@<seconds>]
 *
 * Two JS consumers exist and they see the id in slightly different shapes, so
 * this parser handles both via `opts.hasPrefix`:
 *
 *   - reconcileWithNativePlayer (usePlaybackStore) reads the mediaId straight
 *     off the native queue item, so the "play:" prefix is still attached
 *     (hasPrefix: true). It uses only itemId/episodeId — native already owns the
 *     live position, so the @@seconds suffix is parsed but ignored by that
 *     caller (adoption never seeks).
 *
 *   - the RemotePlayId handler (playbackService) receives the id with ONLY the
 *     "play:" prefix stripped by the native side (`mediaId.removePrefix("play:")`
 *     in onAddMediaItems / the cold-start handoff) — the "::episodeId" and any
 *     "@@<seconds>" stay INLINE in the single forwarded "id" string, i.e.
 *     grammar "<itemId>[::episodeId][@@seconds]" (hasPrefix: false). This parser
 *     does the "@@" and "::" splits, and the caller seeks to bookmarkSeconds
 *     when present and > 0.
 *
 * The grammar contract is pinned in
 * __tests__/contracts/nativeBridgeShapes.test.ts (two-sided with the patch) and
 * unit-tested in __tests__/utils/playMediaId.test.ts.
 */
export interface ParsedPlayMediaId {
  itemId: string;
  /** undefined when there is no "::episodeId" segment (or it is empty). */
  episodeId?: string;
  /**
   * Seconds from the "@@<seconds>" suffix, mirroring the Kotlin parser's
   * `substringAfter("@@", "").toDoubleOrNull()`: a finite number when the suffix
   * is numeric (0 included, for a literal "@@0"), otherwise undefined — an
   * absent, empty, or non-numeric suffix ("@@", "@@later", "@@1@@2") all collapse
   * to undefined, matching Kotlin's null. Seek callers still guard with
   * `bookmarkSeconds !== undefined && bookmarkSeconds > 0`.
   */
  bookmarkSeconds?: number;
}

/**
 * JS equivalent of Kotlin's `String.toDoubleOrNull()` for the "@@<seconds>"
 * suffix: a finite number, else undefined. It explicitly guards the JS footgun
 * where `Number("")` and `Number(" ")` are 0 — an empty or whitespace-only
 * suffix must read as absent (Kotlin's `substringAfter("@@", "")` yields "",
 * and `"".toDoubleOrNull()` is null), not as a bookmark of 0.
 */
function toFiniteSecondsOrUndefined(suffix: string | undefined): number | undefined {
  if (suffix === undefined || suffix.trim() === "") return undefined;
  const n = Number(suffix);
  return Number.isFinite(n) ? n : undefined;
}

export function parsePlayMediaId(
  id: string,
  opts?: { hasPrefix?: boolean }
): ParsedPlayMediaId {
  let raw = id ?? "";
  if (opts?.hasPrefix && raw.startsWith("play:")) {
    raw = raw.slice("play:".length);
  }
  // FIRST-occurrence splits, mirroring the Kotlin parser exactly (its
  // substringBefore/substringAfter both cut at the FIRST delimiter): everything
  // after the first "@@" is the bookmark suffix, everything after the first "::"
  // is the episode id. String.split() would instead cut at EVERY occurrence and
  // diverge from Kotlin on an id carrying a repeated delimiter
  // (e.g. "a@@1@@2" → suffix "1@@2" here vs "1" under split; "a::e::x" →
  // episode "e::x" here vs "e" under split).
  // Take the "@@<seconds>" bookmark/position suffix off first, so the
  // "::episodeId" split never sees it.
  const atIdx = raw.indexOf("@@");
  const main = atIdx === -1 ? raw : raw.slice(0, atIdx);
  const bookmarkStr = atIdx === -1 ? undefined : raw.slice(atIdx + 2);
  const colonIdx = main.indexOf("::");
  const itemId = colonIdx === -1 ? main : main.slice(0, colonIdx);
  // Empty ("a::") or missing episode segment both collapse to undefined, which
  // is the shape startPlayback expects (no episode).
  const episodeId = colonIdx === -1 ? undefined : main.slice(colonIdx + 2) || undefined;
  const bookmarkSeconds = toFiniteSecondsOrUndefined(bookmarkStr);
  return { itemId, episodeId, bookmarkSeconds };
}
