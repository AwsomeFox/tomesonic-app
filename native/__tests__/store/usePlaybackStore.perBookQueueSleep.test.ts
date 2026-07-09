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
