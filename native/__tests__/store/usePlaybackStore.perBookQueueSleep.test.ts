jest.mock("../../utils/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock("../../utils/progressSync", () => ({
  syncProgress: jest.fn().mockResolvedValue(undefined),
  closeSession: jest.fn().mockResolvedValue(undefined),
  queueProgressPatch: jest.fn(),
  queueFinishedPatch: jest.fn(),
  queueEbookProgressPatch: jest.fn(),
  flushPendingSyncs: jest.fn().mockResolvedValue(undefined),
  clearAllPending: jest.fn(),
  reconcileLinkedProgress: jest.fn(),
}));
jest.mock("../../utils/autoCreds", () => ({
  writeAutoCreds: jest.fn().mockResolvedValue(undefined),
  readAutoCreds: jest.fn().mockResolvedValue(null),
  writeAutoDownloads: jest.fn().mockResolvedValue(undefined),
  writeWidgetState: jest.fn().mockResolvedValue(undefined),
}));

// Capture the accelerometer listener so the shake-to-extend test can drive
// samples through it. expo-sensors is a real dependency but native-only, so the
// store's runtime require("expo-sensors") resolves to this factory mock. The
// holder is `mock`-prefixed as babel-plugin-jest-hoist requires.
const mockAccel: {
  listener: ((d: { x: number; y: number; z: number }) => void) | null;
  remove: jest.Mock;
} = { listener: null, remove: jest.fn() };
jest.mock("expo-sensors", () => ({
  Accelerometer: {
    setUpdateInterval: jest.fn(),
    addListener: (cb: (d: { x: number; y: number; z: number }) => void) => {
      mockAccel.listener = cb;
      return { remove: mockAccel.remove };
    },
  },
}));

import { AppState } from "react-native";
import TrackPlayer from "react-native-track-player";
import { api } from "../../utils/api";
import { storage, storageHelper } from "../../utils/storage";
import {
  usePlaybackStore,
  autoAdvanceAfterFinish,
  resolveNextInSeries,
  persistCastProgressSample,
} from "../../store/usePlaybackStore";
import { useDownloadStore } from "../../store/useDownloadStore";

const initial = usePlaybackStore.getState();
const initialDownloads = useDownloadStore.getState();

// A minimal single-file server session (no chapters → one queue item, so
// _trackOffsets stays length 1 and live-position reads pass through cleanly).
function singleTrackSession(over: Record<string, any> = {}) {
  return {
    id: "sess1",
    libraryItemId: "item1",
    displayTitle: "Book One",
    displayAuthor: "Author",
    duration: 300,
    currentTime: 0,
    chapters: [],
    audioTracks: [{ index: 0, contentUrl: "file:///a.mp3", duration: 300, startOffset: 0 }],
    ...over,
  };
}

const tick = async (ms = 1000) => {
  await jest.advanceTimersByTimeAsync(ms);
};

describe("usePlaybackStore per-book rate / queue / sleep rewind", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    usePlaybackStore.setState(initial, true);
    useDownloadStore.setState(initialDownloads, true);
    useDownloadStore.setState({ activeDownloads: {}, completedDownloads: {} } as any);
    storage.getAllKeys().forEach((k) => storage.remove(k));
    jest.mocked(TrackPlayer.getPlaybackState).mockResolvedValue({ state: "playing" } as any);
    jest.mocked(TrackPlayer.getProgress).mockResolvedValue({
      position: 0,
      duration: 300,
      buffered: 0,
    } as any);
    jest.mocked(api.get).mockReset();
    jest.mocked(api.post).mockReset();
  });

  afterEach(async () => {
    // Tear down any live session (stops the progress interval + sleep interval).
    try {
      usePlaybackStore.getState().cancelSleepTimer();
      if (usePlaybackStore.getState().currentSession) {
        await usePlaybackStore.getState().closePlayback();
      }
    } catch {}
    jest.useRealTimers();
  });

  // --------------------------------------------------------------------------
  // Per-book playback-speed memory
  // --------------------------------------------------------------------------
  describe("per-book playback speed", () => {
    it("applies the remembered per-book rate on prepare (default ON)", async () => {
      storage.set("perBookRate", JSON.stringify({ item1: 1.5 }));
      await usePlaybackStore.getState().preparePlaybackSession(singleTrackSession(), false);
      expect(TrackPlayer.setRate).toHaveBeenCalledWith(1.5);
      expect(usePlaybackStore.getState().playbackSpeed).toBe(1.5);
    });

    it("writes the per-book rate when the speed changes while a book is active", async () => {
      usePlaybackStore.setState({
        isInitialized: true,
        currentSession: { id: "s", libraryItemId: "item1" },
      } as any);
      await usePlaybackStore.getState().setPlaybackSpeed(1.75);
      // Global rate still updated…
      expect(storageHelper.getPlaybackRate()).toBe(1.75);
      // …and remembered for this book.
      expect(JSON.parse(storage.getString("perBookRate")!)).toEqual({ item1: 1.75 });
    });

    it("caps the per-book rate map (LRU) so it can't grow unbounded", async () => {
      // Pre-seed 200 entries (the cap); the 201st write must evict the oldest.
      const seed: Record<string, number> = {};
      for (let i = 0; i < 200; i++) seed[`old${i}`] = 1.0;
      storage.set("perBookRate", JSON.stringify(seed));

      usePlaybackStore.setState({
        isInitialized: true,
        currentSession: { id: "s", libraryItemId: "newBook" },
      } as any);
      await usePlaybackStore.getState().setPlaybackSpeed(1.5);

      const map = JSON.parse(storage.getString("perBookRate")!);
      expect(Object.keys(map)).toHaveLength(200);
      expect(map.newBook).toBe(1.5); // newest kept
      expect(map.old0).toBeUndefined(); // oldest evicted
      expect(map.old199).toBe(1.0); // recent entry retained
    });

    it("toggle OFF falls back to the global rate and stops writing per-book", async () => {
      // Feature off + a stale per-book entry that must be ignored.
      usePlaybackStore.getState().setRememberSpeedPerBook(false);
      storage.set("perBookRate", JSON.stringify({ item1: 2.0 }));
      storageHelper.setPlaybackRate(1.0);

      await usePlaybackStore.getState().preparePlaybackSession(singleTrackSession(), false);
      // Global (1.0) wins over the ignored per-book 2.0.
      expect(TrackPlayer.setRate).toHaveBeenCalledWith(1.0);

      // Changing speed must NOT record a per-book entry while OFF.
      await usePlaybackStore.getState().setPlaybackSpeed(1.25);
      expect(JSON.parse(storage.getString("perBookRate")!)).toEqual({ item1: 2.0 });
    });
  });

  // --------------------------------------------------------------------------
  // Cross-book play queue + advance
  // --------------------------------------------------------------------------
  describe("play queue", () => {
    it("add / remove / clear persist to MMKV", () => {
      const s = usePlaybackStore.getState();
      s.addToQueue({ libraryItemId: "b2", title: "Book 2" });
      s.addToQueue({ libraryItemId: "b3", title: "Book 3" });
      s.addToQueue({ libraryItemId: "b2", title: "Book 2 (dupe)" }); // de-duped
      expect(usePlaybackStore.getState().queue.map((q) => q.libraryItemId)).toEqual(["b2", "b3"]);
      expect(JSON.parse(storage.getString("playbackQueue")!)).toHaveLength(2);

      usePlaybackStore.getState().removeFromQueue("b2");
      expect(usePlaybackStore.getState().queue.map((q) => q.libraryItemId)).toEqual(["b3"]);

      usePlaybackStore.getState().clearQueue();
      expect(usePlaybackStore.getState().queue).toEqual([]);
      expect(JSON.parse(storage.getString("playbackQueue")!)).toEqual([]);
    });

    it("playNextInQueue pops the head and starts it", async () => {
      const startPlayback = jest.fn().mockResolvedValue(true);
      usePlaybackStore.setState({ startPlayback } as any);
      usePlaybackStore.getState().addToQueue({ libraryItemId: "b2", title: "Book 2" });
      usePlaybackStore.getState().addToQueue({ libraryItemId: "b3", title: "Book 3" });

      const ok = await usePlaybackStore.getState().playNextInQueue();
      expect(ok).toBe(true);
      expect(startPlayback).toHaveBeenCalledWith("b2", undefined);
      expect(usePlaybackStore.getState().queue.map((q) => q.libraryItemId)).toEqual(["b3"]);
    });

    it("retains the queued item when startPlayback resolves false", async () => {
      // startPlayback failing (offline, bad item) must NOT drop the next book —
      // popping before the await used to lose it AND leave playback stopped.
      const startPlayback = jest.fn().mockResolvedValue(false);
      usePlaybackStore.setState({ startPlayback } as any);
      usePlaybackStore.getState().addToQueue({ libraryItemId: "b2", title: "Book 2" });
      usePlaybackStore.getState().addToQueue({ libraryItemId: "b3", title: "Book 3" });

      const ok = await usePlaybackStore.getState().playNextInQueue();
      expect(ok).toBe(false);
      // Both books still queued (nothing removed on failure).
      expect(usePlaybackStore.getState().queue.map((q) => q.libraryItemId)).toEqual(["b2", "b3"]);
      expect(JSON.parse(storage.getString("playbackQueue")!).map((q: any) => q.libraryItemId)).toEqual([
        "b2",
        "b3",
      ]);
    });

    it("retains the queued item when startPlayback rejects", async () => {
      const startPlayback = jest.fn().mockRejectedValue(new Error("boom"));
      usePlaybackStore.setState({ startPlayback } as any);
      usePlaybackStore.getState().addToQueue({ libraryItemId: "b2", title: "Book 2" });

      const ok = await usePlaybackStore.getState().playNextInQueue();
      expect(ok).toBe(false);
      expect(usePlaybackStore.getState().queue.map((q) => q.libraryItemId)).toEqual(["b2"]);
    });

    it("in-flight guard: a racing second call can't pop+start two items", async () => {
      // First call is still awaiting startPlayback when the second fires; the
      // second must no-op so only ONE item is started and popped.
      let resolveFirst: (v: boolean) => void = () => {};
      const startPlayback = jest
        .fn()
        .mockImplementationOnce(() => new Promise<boolean>((r) => (resolveFirst = r)))
        .mockResolvedValue(true);
      usePlaybackStore.setState({ startPlayback } as any);
      usePlaybackStore.getState().addToQueue({ libraryItemId: "b2", title: "Book 2" });
      usePlaybackStore.getState().addToQueue({ libraryItemId: "b3", title: "Book 3" });

      const p1 = usePlaybackStore.getState().playNextInQueue();
      const secondWhileInFlight = await usePlaybackStore.getState().playNextInQueue();
      expect(secondWhileInFlight).toBe(false);

      resolveFirst(true);
      await p1;
      // Exactly one item started, exactly one popped.
      expect(startPlayback).toHaveBeenCalledTimes(1);
      expect(startPlayback).toHaveBeenCalledWith("b2", undefined);
      expect(usePlaybackStore.getState().queue.map((q) => q.libraryItemId)).toEqual(["b3"]);
    });

    it("removeFromQueue with an episodeId removes only that episode (siblings kept)", async () => {
      const s = usePlaybackStore.getState();
      // Two episodes of ONE podcast — addToQueue de-dupes by item+episode, so
      // both are queued under the same libraryItemId.
      s.addToQueue({ libraryItemId: "pod1", episodeId: "e1", title: "Ep 1" });
      s.addToQueue({ libraryItemId: "pod1", episodeId: "e2", title: "Ep 2" });
      expect(usePlaybackStore.getState().queue).toHaveLength(2);

      usePlaybackStore.getState().removeFromQueue("pod1", "e1");
      const q = usePlaybackStore.getState().queue;
      expect(q).toHaveLength(1);
      expect(q[0].episodeId).toBe("e2");
      // Persisted too.
      expect(JSON.parse(storage.getString("playbackQueue")!)).toHaveLength(1);
    });

    it("removeFromQueue without an episodeId still drops every entry for the item", () => {
      const s = usePlaybackStore.getState();
      s.addToQueue({ libraryItemId: "pod1", episodeId: "e1" });
      s.addToQueue({ libraryItemId: "pod1", episodeId: "e2" });
      s.addToQueue({ libraryItemId: "book9" });

      usePlaybackStore.getState().removeFromQueue("pod1");
      expect(usePlaybackStore.getState().queue.map((q) => q.libraryItemId)).toEqual(["book9"]);
    });

    it("playNextInQueue is a no-op when the queue is empty", async () => {
      const startPlayback = jest.fn().mockResolvedValue(true);
      usePlaybackStore.setState({ startPlayback } as any);
      const ok = await usePlaybackStore.getState().playNextInQueue();
      expect(ok).toBe(false);
      expect(startPlayback).not.toHaveBeenCalled();
    });

    it("finish auto-advance prefers the queue when non-empty", async () => {
      const startPlayback = jest.fn().mockResolvedValue(true);
      usePlaybackStore.setState({ startPlayback } as any);
      usePlaybackStore.getState().addToQueue({ libraryItemId: "queued1", title: "Queued" });

      await autoAdvanceAfterFinish("item1", null);
      expect(startPlayback).toHaveBeenCalledWith("queued1", undefined);
      // Series resolution must not run when the queue supplied a next book.
      expect(api.get).not.toHaveBeenCalled();
    });

    it("does NOT pull from the queue when the user already switched books", async () => {
      // The finish callback fires fire-and-forget; if the user manually started
      // a DIFFERENT book in the meantime, the queue must not yank them off it.
      const startPlayback = jest.fn().mockResolvedValue(true);
      usePlaybackStore.setState({
        startPlayback,
        currentSession: { libraryItemId: "otherBook" },
      } as any);
      usePlaybackStore.getState().addToQueue({ libraryItemId: "queued1", title: "Queued" });

      await autoAdvanceAfterFinish("item1", null);
      expect(startPlayback).not.toHaveBeenCalled();
      // The queue is left intact for a later, legitimate advance.
      expect(usePlaybackStore.getState().queue.map((q) => q.libraryItemId)).toEqual(["queued1"]);
    });
  });

  // --------------------------------------------------------------------------
  // Series auto-next + empty-queue stop
  // --------------------------------------------------------------------------
  describe("series auto-next", () => {
    const seriesMocks = () => {
      jest.mocked(api.get).mockImplementation(async (path: string) => {
        if (path.startsWith("/api/items/item1")) {
          return {
            data: { libraryId: "lib1", media: { metadata: { series: [{ id: "s1", sequence: "1" }] } } },
          } as any;
        }
        if (path.startsWith("/api/libraries/lib1/series/s1")) {
          return {
            data: {
              books: [
                { id: "item1", media: { metadata: { series: [{ id: "s1", sequence: "1" }] } } },
                { id: "item2", media: { metadata: { series: [{ id: "s1", sequence: "2" }] } } },
                { id: "item3", media: { metadata: { series: [{ id: "s1", sequence: "3" }] } } },
              ],
            },
          } as any;
        }
        return { data: {} } as any;
      });
    };

    it("resolveNextInSeries returns the immediate next by sequence", async () => {
      seriesMocks();
      await expect(resolveNextInSeries("item1")).resolves.toBe("item2");
    });

    it("resolveNextInSeries prefers a downloaded next book (offline-friendly)", async () => {
      seriesMocks();
      useDownloadStore.setState({ completedDownloads: { item3: { id: "item3" } } } as any);
      await expect(resolveNextInSeries("item1")).resolves.toBe("item3");
    });

    it("finish auto-advance plays the next in series when the queue is empty", async () => {
      seriesMocks();
      const startPlayback = jest.fn().mockResolvedValue(true);
      usePlaybackStore.setState({ startPlayback, currentSession: { libraryItemId: "item1" } } as any);

      await autoAdvanceAfterFinish("item1", null);
      expect(startPlayback).toHaveBeenCalledWith("item2");
    });

    it("empty queue + no series next → playback stops (no advance)", async () => {
      // No series metadata → resolveNextInSeries yields null.
      jest.mocked(api.get).mockResolvedValue({ data: {} } as any);
      const startPlayback = jest.fn().mockResolvedValue(true);
      usePlaybackStore.setState({ startPlayback, currentSession: { libraryItemId: "item1" } } as any);

      await autoAdvanceAfterFinish("item1", null);
      expect(startPlayback).not.toHaveBeenCalled();
    });

    it("does not advance for podcast episodes", async () => {
      seriesMocks();
      const startPlayback = jest.fn().mockResolvedValue(true);
      usePlaybackStore.setState({ startPlayback } as any);
      await autoAdvanceAfterFinish("item1", "ep1");
      expect(startPlayback).not.toHaveBeenCalled();
      expect(api.get).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // Sleep-timer rewind-on-wake plumbing
  // --------------------------------------------------------------------------
  describe("sleep timer rewind on wake", () => {
    function armAndFire() {
      usePlaybackStore.setState({
        isInitialized: true,
        currentSession: { id: "s", libraryItemId: "item1" },
        isPlaying: true,
        duration: 300,
        position: 100,
        chapters: [],
        currentChapterIndex: -1,
        chapterQueue: false,
        seek: jest.fn().mockResolvedValue(undefined),
      } as any);
      jest.mocked(TrackPlayer.getProgress).mockResolvedValue({
        position: 100,
        duration: 300,
        buffered: 0,
      } as any);
      usePlaybackStore.getState().setSleepTimer(2);
    }

    it("rewinds by the configured seconds on the next resume (default ON)", async () => {
      armAndFire();
      await tick(2000); // fires: pauses playback, arms rewind-on-wake
      expect(usePlaybackStore.getState().sleepTimer).toBeNull();
      expect(usePlaybackStore.getState().isPlaying).toBe(false);

      await usePlaybackStore.getState().play();
      // Default rewind is 30s from the live position (100 → 70).
      expect(usePlaybackStore.getState().seek).toHaveBeenCalledWith(70);
    });

    it("honors a custom rewind amount", async () => {
      storage.set("sleepRewindSeconds", 10);
      armAndFire();
      await tick(2000);
      await usePlaybackStore.getState().play();
      expect(usePlaybackStore.getState().seek).toHaveBeenCalledWith(90);
    });

    it("does not rewind when the toggle is OFF", async () => {
      usePlaybackStore.getState().setSleepRewindOnWake(false);
      armAndFire();
      await tick(2000);
      await usePlaybackStore.getState().play();
      // Timer fired just now, so the generic auto-rewind is 0s → no seek at all.
      expect(usePlaybackStore.getState().seek).not.toHaveBeenCalled();
    });

    it("setSleepRewindSeconds persists, updates state, and drives the rewind", async () => {
      // The setter (previously missing — the value was read but never settable)
      // persists to MMKV and is what the next resume rewinds by.
      usePlaybackStore.getState().setSleepRewindSeconds(15);
      expect(usePlaybackStore.getState().sleepRewindSeconds).toBe(15);
      expect(storage.getNumber("sleepRewindSeconds")).toBe(15);

      armAndFire();
      await tick(2000);
      await usePlaybackStore.getState().play();
      // 100 → 85 (15s rewind on wake).
      expect(usePlaybackStore.getState().seek).toHaveBeenCalledWith(85);
    });

    it("setSleepRewindSeconds rejects non-finite / non-positive values", () => {
      usePlaybackStore.getState().setSleepRewindSeconds(20);
      usePlaybackStore.getState().setSleepRewindSeconds(NaN);
      usePlaybackStore.getState().setSleepRewindSeconds(0);
      usePlaybackStore.getState().setSleepRewindSeconds(-5);
      // Only the valid 20 stuck.
      expect(usePlaybackStore.getState().sleepRewindSeconds).toBe(20);
      expect(storage.getNumber("sleepRewindSeconds")).toBe(20);
    });
  });

  // --------------------------------------------------------------------------
  // Auto mark-finished lower-bound guard (short items)
  // --------------------------------------------------------------------------
  describe("auto mark-finished guard", () => {
    it("a <5s item does NOT auto-finish at position 0", () => {
      // duration - 5 is negative for a <5s item, so position 0 used to satisfy
      // `>= duration - 5` and instantly mark it finished on the first sample.
      usePlaybackStore.setState({
        currentSession: { id: "shortSess", libraryItemId: "shortItem" },
        isCasting: true, // route through persistCastProgressSample (no straggler gate)
        isPlaying: true,
        duration: 4,
        position: 0,
        chapters: [],
        currentChapterIndex: -1,
        chapterQueue: false,
      } as any);

      persistCastProgressSample(0);
      // No finish PATCH fired at position 0.
      expect(api.patch).not.toHaveBeenCalled();
      const mp = require("../../store/useUserStore").useUserStore.getState().mediaProgress[
        "shortItem"
      ];
      expect(mp?.isFinished).not.toBe(true);
    });

    it("a <5s item DOES auto-finish once it has actually played to the end", () => {
      jest.mocked(api.patch).mockResolvedValue({ data: {} } as any);
      usePlaybackStore.setState({
        currentSession: { id: "shortSess2", libraryItemId: "shortItem2" },
        isCasting: true,
        isPlaying: true,
        duration: 4,
        position: 0,
        chapters: [],
        currentChapterIndex: -1,
        chapterQueue: false,
      } as any);

      // Played to 4s (>= max(1, 4-5)=1 and > 0) → finish fires.
      persistCastProgressSample(4);
      expect(api.patch).toHaveBeenCalledWith(
        "/api/me/progress/shortItem2",
        expect.objectContaining({ isFinished: true })
      );
    });
  });

  // --------------------------------------------------------------------------
  // setSleepTimer input guard + teardown safety
  // --------------------------------------------------------------------------
  describe("setSleepTimer input guard", () => {
    function armable() {
      usePlaybackStore.setState({
        isInitialized: true,
        currentSession: { id: "s", libraryItemId: "item1" },
        isPlaying: true,
        duration: 300,
        position: 0,
        chapters: [],
        currentChapterIndex: -1,
        chapterQueue: false,
      } as any);
    }

    it("rejects NaN / 0 / negative fixed durations (no timer armed)", () => {
      armable();
      usePlaybackStore.getState().setSleepTimer(NaN);
      expect(usePlaybackStore.getState().sleepTimer).toBeNull();
      usePlaybackStore.getState().setSleepTimer(0);
      expect(usePlaybackStore.getState().sleepTimer).toBeNull();
      usePlaybackStore.getState().setSleepTimer(-1);
      expect(usePlaybackStore.getState().sleepTimer).toBeNull();
      // A valid duration still arms.
      usePlaybackStore.getState().setSleepTimer(60);
      expect(usePlaybackStore.getState().sleepTimer!.remaining).toBe(60);
    });

    it("a teardown before a fixed tick performs no fade setVolume", async () => {
      armable();
      usePlaybackStore.getState().setSleepTimer(15); // in the fade zone (<20)
      await tick(1000); // one fade tick
      // Tear the timer down (interval cleared, volume restored to 1).
      usePlaybackStore.getState().cancelSleepTimer();
      jest.mocked(TrackPlayer.setVolume).mockClear();
      // No further ticks should fade the volume.
      await tick(5000);
      const faded = jest
        .mocked(TrackPlayer.setVolume)
        .mock.calls.some(([v]) => typeof v === "number" && v < 1);
      expect(faded).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Shake-to-extend (G3): the accelerometer listener adds SLEEP_SHAKE_MINUTES
  // to an armed timer, debounced so one shake can't fire twice.
  // --------------------------------------------------------------------------
  describe("shake to extend", () => {
    const SLEEP_SHAKE_SECONDS = 5 * 60; // SLEEP_SHAKE_MINUTES * 60

    beforeEach(() => {
      mockAccel.listener = null;
      mockAccel.remove.mockClear();
      // armShakeListener only registers the sensor while the app is foreground.
      (AppState as any).currentState = "active";
      jest.spyOn(AppState, "addEventListener").mockReturnValue({ remove: jest.fn() } as any);
      // Deterministic clock far past any prior test's shake timestamp, so the
      // first shake below is never swallowed by the 1.5s debounce.
      jest.setSystemTime(new Date("2035-01-01T00:00:00Z"));
    });

    function armTimer(seconds: number) {
      usePlaybackStore.setState({
        isInitialized: true,
        currentSession: { id: "s", libraryItemId: "item1" },
        isPlaying: true,
        duration: 3000,
        position: 0,
        chapters: [],
        currentChapterIndex: -1,
        chapterQueue: false,
      } as any);
      usePlaybackStore.getState().setSleepTimer(seconds);
    }

    it("a shake above threshold extends the timer, and a second within 1.5s is debounced", () => {
      armTimer(600);
      // setSleepTimer arms the accelerometer listener (foreground + default ON).
      expect(mockAccel.listener).toBeTruthy();
      expect(usePlaybackStore.getState().sleepTimer!.remaining).toBe(600);

      // Total acceleration 2g (> SHAKE_G_THRESHOLD 1.8) → +5 min.
      mockAccel.listener!({ x: 2, y: 0, z: 0 });
      expect(usePlaybackStore.getState().sleepTimer!.remaining).toBe(600 + SLEEP_SHAKE_SECONDS);

      // A second shake at the same instant is inside the 1.5s debounce window
      // (extending re-armed the listener; it shares the module-level debounce
      // stamp) — no further extension.
      mockAccel.listener!({ x: 2, y: 0, z: 0 });
      expect(usePlaybackStore.getState().sleepTimer!.remaining).toBe(600 + SLEEP_SHAKE_SECONDS);
    });

    it("ignores a sub-threshold jostle (resting ~1g)", () => {
      armTimer(600);
      // Magnitude 1.0 < 1.8 threshold → no extension.
      mockAccel.listener!({ x: 1, y: 0, z: 0 });
      expect(usePlaybackStore.getState().sleepTimer!.remaining).toBe(600);
    });

    it("does not register the accelerometer when shake-to-extend is OFF", () => {
      usePlaybackStore.getState().setSleepShakeToExtend(false);
      mockAccel.listener = null;
      armTimer(600);
      expect(mockAccel.listener).toBeNull();
    });
  });
});
