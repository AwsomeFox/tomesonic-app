/**
 * Harness smoke test — proves the three layers every real test builds on:
 *  1. pure TS unit imports (utils)
 *  2. MMKV-backed storage round-trips (in-memory mock)
 *  3. @testing-library/react-native component rendering with themed context
 */
import { render, screen } from "@testing-library/react-native";
import { normalizeTitle, isEbookOnly, hasAudio } from "../utils/bookMatch";
import { storage } from "../utils/storage";
import BookProgressBadge from "../components/BookProgressBadge";
import { useUserStore } from "../store/useUserStore";

describe("test harness", () => {
  it("runs pure util code", () => {
    expect(normalizeTitle("The Hobbit: There and Back Again (Unabridged)")).toBe("hobbit");
    expect(isEbookOnly({ mediaType: "book", media: {} })).toBe(true);
    expect(hasAudio({ media: { numTracks: 3 } })).toBe(true);
  });

  it("round-trips MMKV storage", () => {
    storage.set("smoke_key", JSON.stringify({ ok: true }));
    expect(JSON.parse(storage.getString("smoke_key")!)).toEqual({ ok: true });
    storage.remove("smoke_key");
    expect(storage.getString("smoke_key")).toBeUndefined();
  });

  it("renders a component against store state", async () => {
    useUserStore.setState({
      mediaProgress: {
        item1: { libraryItemId: "item1", progress: 0.5, currentTime: 1800, duration: 3600 },
      },
    } as any);
    // NOTE: RNTL v14 API is async — always `await render(...)` / `await fireEvent...`.
    await render(
      <BookProgressBadge itemId="item1" item={{ mediaType: "book", media: { numTracks: 1 } }} />
    );
    // 50% of a 1h book → "30m" remaining label.
    expect(screen.getByText("30m")).toBeTruthy();
  });
});
