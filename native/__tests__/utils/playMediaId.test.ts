/**
 * Unit contract for parsePlayMediaId — the single "play:" media-id grammar
 * parser extracted from reconcileWithNativePlayer (usePlaybackStore, prefixed
 * form) and the RemotePlayId handler (playbackService, prefix-stripped form).
 *
 * These mirror the two-sided cases pinned against the Kotlin patch in
 * __tests__/contracts/nativeBridgeShapes.test.ts, but exercise the parser
 * directly (equality on the parsed shape) rather than through the store.
 */
import { parsePlayMediaId } from "../../utils/playMediaId";

describe("parsePlayMediaId — prefixed form (hasPrefix: true, from the native queue item)", () => {
  it('"play:a" → item only', () => {
    expect(parsePlayMediaId("play:a", { hasPrefix: true })).toEqual({ itemId: "a" });
  });

  it('"play:a::e" → item + episode', () => {
    expect(parsePlayMediaId("play:a::e", { hasPrefix: true })).toEqual({
      itemId: "a",
      episodeId: "e",
    });
  });

  it('"play:a@@123.5" → fractional @@seconds preserved (caller may ignore it)', () => {
    expect(parsePlayMediaId("play:a@@123.5", { hasPrefix: true })).toEqual({
      itemId: "a",
      bookmarkSeconds: 123.5,
    });
  });

  it('"play:a::e@@0" → composite id parses through the @@ split; bookmark 0', () => {
    expect(parsePlayMediaId("play:a::e@@0", { hasPrefix: true })).toEqual({
      itemId: "a",
      episodeId: "e",
      bookmarkSeconds: 0,
    });
  });

  it('a bare "play:" → empty itemId (the caller rejects it)', () => {
    expect(parsePlayMediaId("play:", { hasPrefix: true })).toEqual({ itemId: "" });
  });

  it('an empty "::" episode segment collapses to undefined ("play:a::")', () => {
    expect(parsePlayMediaId("play:a::", { hasPrefix: true })).toEqual({ itemId: "a" });
  });
});

describe("parsePlayMediaId — stripped form (hasPrefix: false, from RemotePlayId)", () => {
  it('"a::e@@5" → item + episode + bookmark', () => {
    expect(parsePlayMediaId("a::e@@5")).toEqual({
      itemId: "a",
      episodeId: "e",
      bookmarkSeconds: 5,
    });
  });

  it('"a@@123.5" → item + fractional bookmark (matches RemotePlayId seek contract)', () => {
    expect(parsePlayMediaId("a@@123.5")).toEqual({ itemId: "a", bookmarkSeconds: 123.5 });
  });

  it('"a::e@@0" → item + episode, bookmark 0 (caller\'s t > 0 guard skips the seek)', () => {
    expect(parsePlayMediaId("a::e@@0")).toEqual({
      itemId: "a",
      episodeId: "e",
      bookmarkSeconds: 0,
    });
  });

  it('"a" → item only, no episode, no bookmark', () => {
    expect(parsePlayMediaId("a")).toEqual({ itemId: "a" });
  });

  it('a non-numeric "@@" suffix yields NaN (caller\'s !isNaN guard skips the seek)', () => {
    const parsed = parsePlayMediaId("a@@later");
    expect(parsed.itemId).toBe("a");
    expect(Number.isNaN(parsed.bookmarkSeconds)).toBe(true);
  });

  it('an empty "@@" suffix parses to 0 ("a@@")', () => {
    expect(parsePlayMediaId("a@@")).toEqual({ itemId: "a", bookmarkSeconds: 0 });
  });
});

describe("parsePlayMediaId — bare/edge inputs", () => {
  it("an empty string → empty itemId, nothing else", () => {
    expect(parsePlayMediaId("")).toEqual({ itemId: "" });
  });

  it('hasPrefix on an id WITHOUT the "play:" prefix leaves it untouched', () => {
    // The prefix is only stripped when actually present, so a stripped-form id
    // passed with hasPrefix still parses correctly.
    expect(parsePlayMediaId("a::e", { hasPrefix: true })).toEqual({
      itemId: "a",
      episodeId: "e",
    });
  });
});
