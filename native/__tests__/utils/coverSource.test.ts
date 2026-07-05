/**
 * Guards the wake-up blank-covers fix: expo-image keys its disk cache by URI,
 * and cover URLs embed `?token=`, which ROTATES on every auth refresh. The
 * cacheKey must be the URL WITHOUT the token so rotation doesn't invalidate
 * the whole image cache (covers then paint from disk even offline/mid-refresh).
 */
import { coverSource } from "../../utils/coverSource";

describe("coverSource", () => {
  it("returns undefined for empty input", () => {
    expect(coverSource(undefined)).toBeUndefined();
    expect(coverSource(null)).toBeUndefined();
    expect(coverSource("")).toBeUndefined();
  });

  it("passes local files through without a cacheKey (the file IS the cache)", () => {
    expect(coverSource("file:///data/user/0/app/files/cover.webp")).toEqual({
      uri: "file:///data/user/0/app/files/cover.webp",
    });
  });

  it("strips a trailing token from the cacheKey", () => {
    const uri = "https://abs.local/api/items/li1/cover?width=400&format=webp&token=abc123";
    expect(coverSource(uri)).toEqual({
      uri,
      cacheKey: "https://abs.local/api/items/li1/cover?width=400&format=webp",
    });
  });

  it("strips a leading token while keeping later params", () => {
    const uri = "https://abs.local/api/items/li1/cover?token=abc&width=400";
    expect(coverSource(uri)!.cacheKey).toBe("https://abs.local/api/items/li1/cover?width=400");
  });

  it("strips a token that is the only param (no dangling '?')", () => {
    const uri = "https://abs.local/api/authors/a1/image?token=abc";
    expect(coverSource(uri)!.cacheKey).toBe("https://abs.local/api/authors/a1/image");
  });

  it("two urls differing only by token share ONE cacheKey", () => {
    const a = coverSource("https://abs.local/api/items/li1/cover?width=400&token=OLD")!;
    const b = coverSource("https://abs.local/api/items/li1/cover?width=400&token=NEW")!;
    expect(a.cacheKey).toBe(b.cacheKey);
  });

  it("urls without a token keep their full url as the cacheKey", () => {
    const uri = "https://abs.local/api/items/li1/cover?width=400";
    expect(coverSource(uri)!.cacheKey).toBe(uri);
  });
});
