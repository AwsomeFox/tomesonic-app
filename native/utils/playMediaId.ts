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
   * Raw Number() parse of the "@@<seconds>" suffix:
   *   - undefined when the "@@" suffix is absent,
   *   - NaN when the suffix is non-numeric (e.g. "@@later"),
   *   - 0 for an empty suffix ("@@").
   * It is deliberately NOT normalised here — every seek caller already guards
   * with `!isNaN(bookmarkSeconds) && bookmarkSeconds > 0`, so a malformed suffix
   * simply skips the seek rather than being silently coerced to a valid number.
   */
  bookmarkSeconds?: number;
}

export function parsePlayMediaId(
  id: string,
  opts?: { hasPrefix?: boolean }
): ParsedPlayMediaId {
  let raw = id ?? "";
  if (opts?.hasPrefix && raw.startsWith("play:")) {
    raw = raw.slice("play:".length);
  }
  // Split the optional "@@<seconds>" bookmark/position suffix off first, so the
  // "::episodeId" split never sees it.
  const [main, bookmarkStr] = raw.split("@@");
  const segments = main.split("::");
  const itemId = segments[0];
  // Empty ("a::") or missing episode segment both collapse to undefined, which
  // is the shape startPlayback expects (no episode).
  const episodeId = segments[1] || undefined;
  const bookmarkSeconds = bookmarkStr !== undefined ? Number(bookmarkStr) : undefined;
  return { itemId, episodeId, bookmarkSeconds };
}
