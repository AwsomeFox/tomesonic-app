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
}));
jest.mock("../../utils/autoCreds", () => ({
  writeAutoCreds: jest.fn().mockResolvedValue(undefined),
  readAutoCreds: jest.fn().mockResolvedValue(null),
  writeAutoDownloads: jest.fn().mockResolvedValue(undefined),
  writeWidgetState: jest.fn().mockResolvedValue(undefined),
}));
// Finishing a downloaded BOOK triggers auto-download-next-in-series via a lazy
// require of ../../utils/downloader (gated: books only, never episodes).
jest.mock("../../utils/downloader", () => ({
  downloader: {},
  autoDownloadNextAfterFinish: jest.fn().mockResolvedValue(undefined),
}));

import TrackPlayer, { State } from "react-native-track-player";
import { api } from "../../utils/api";
import { autoDownloadNextAfterFinish } from "../../utils/downloader";
import { syncProgress, queueProgressPatch } from "../../utils/progressSync";
import { storage, storageHelper, secureStorage } from "../../utils/storage";
import { usePlaybackStore, restoreLocalNowPlayingMeta } from "../../store/usePlaybackStore";
import { useUserStore } from "../../store/useUserStore";

const initialPlayback = usePlaybackStore.getState();
const initialUser = useUserStore.getState();

const BASE = new Date("2026-03-01T10:00:00Z").getTime();

const CH = [
  { id: 0, title: "Chapter 1", start: 0, end: 100 },
  { id: 1, title: "Chapter 2", start: 100, end: 200 },
  { id: 2, title: "Chapter 3", start: 200, end: 300 },
];

// Mutable fake player state driven by each test.
let playerPos = 0;

const tick = async (ms = 1000) => {
  await jest.advanceTimersByTimeAsync(ms);
};

function persistedSession() {
  const raw = storage.getString("lastPlaybackSession");
  return raw ? JSON.parse(raw) : null;
}

// Prepares a real session (which resets the module-level sync bookkeeping and
// arms the 1s loop created by initializePlayer). The loop skips its native
// polls entirely while the store says paused (energy: a paused session must
// not burn bridge calls) — production flips isPlaying via play(), native
// progress samples, or the PlaybackState event; these tests mirror that by
// stamping isPlaying after prepare.
async function startLoop(sessionOver: Record<string, any> = {}) {
  await doPrepare(sessionOver);
  usePlaybackStore.setState({ isPlaying: true });
}

async function doPrepare(sessionOver: Record<string, any> = {}) {
  await usePlaybackStore.getState().preparePlaybackSession(
    {
      id: "sess1",
      libraryItemId: "item1",
      displayTitle: "Book",
      displayAuthor: "Author",
      duration: 300,
      currentTime: 0,
      chapters: [],
      audioTracks: [{ index: 0, contentUrl: "/f0.mp3", duration: 300, startOffset: 0 }],
      ...sessionOver,
    },
    false
  );
}

describe("usePlaybackStore 1s progress loop", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(BASE);
    usePlaybackStore.setState(initialPlayback, true);
    useUserStore.setState(initialUser, true);
    storage.getAllKeys().forEach((k) => storage.remove(k));
    secureStorage.getAllKeys().forEach((k) => secureStorage.remove(k));
    storageHelper.setServerConfig({ address: "https://abs.example.com", token: "tok" });

    playerPos = 0;
    jest.mocked(TrackPlayer.getActiveTrack).mockResolvedValue({} as any);
    jest
      .mocked(TrackPlayer.getProgress)
      .mockImplementation(async () => ({ position: playerPos, duration: 300, buffered: 0 }));
    jest.mocked(TrackPlayer.getPlaybackState).mockResolvedValue({ state: State.Playing } as any);
    jest.mocked(TrackPlayer.getActiveTrackIndex).mockResolvedValue(0);
    jest.mocked(api.patch).mockResolvedValue({} as any);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("does not poll the player while no session is loaded", async () => {
    await usePlaybackStore.getState().initializePlayer();
    await tick(3000);
    expect(TrackPlayer.getActiveTrack).not.toHaveBeenCalled();
  });

  it("mirrors player position/play-state into the store and the user progress map", async () => {
    await startLoop();
    playerPos = 10;

    await tick(1000);

    const s = usePlaybackStore.getState();
    expect(s.position).toBe(10);
    expect(s.isPlaying).toBe(true);

    const entry = useUserStore.getState().mediaProgress["item1"];
    expect(entry).toMatchObject({
      libraryItemId: "item1",
      currentTime: 10,
      duration: 300,
      isFinished: false,
    });
    expect(entry.progress).toBeCloseTo(10 / 300, 5);
  });

  it("throttles the MMKV session save to ~5s while ticking every 1s", async () => {
    await startLoop();
    playerPos = 10;
    await tick(1000);
    expect(persistedSession().currentTime).toBe(10); // first tick saves

    playerPos = 11;
    await tick(1000);
    // In-memory map is current, MMKV still throttled.
    expect(useUserStore.getState().mediaProgress["item1"].currentTime).toBe(11);
    expect(persistedSession().currentTime).toBe(10);

    playerPos = 15;
    await tick(4000); // crosses the 5s save window
    expect(persistedSession().currentTime).toBe(15);
  });

  it("translates chapter-relative player positions to absolute book positions in chapter-queue mode", async () => {
    await startLoop({ chapters: CH }); // 1 file + 3 chapters → chapter queue
    expect(usePlaybackStore.getState().chapterQueue).toBe(true);

    jest.mocked(TrackPlayer.getActiveTrackIndex).mockResolvedValue(1);
    playerPos = 30; // 30s into chapter 2

    await tick(1000);

    const s = usePlaybackStore.getState();
    expect(s.position).toBe(130); // 100 + 30
    expect(s.currentChapterIndex).toBe(1);
    expect(s.duration).toBe(300); // whole-book duration kept
  });

  it("syncs listening time to the server on the 15s cadence", async () => {
    await startLoop();
    playerPos = 10;

    await tick(1000); // first tick establishes the baseline — nothing listened yet
    expect(syncProgress).not.toHaveBeenCalled();

    await tick(1000); // 1s of listening accumulated → first sync
    expect(syncProgress).toHaveBeenCalledTimes(1);
    expect(syncProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess1",
        libraryItemId: "item1",
        currentTime: 10,
        duration: 300,
        timeListened: 1,
      })
    );

    await tick(14000); // 14 more seconds — still inside the 15s window
    expect(syncProgress).toHaveBeenCalledTimes(1);

    await tick(1000); // window crossed → second sync with the accumulated time
    expect(syncProgress).toHaveBeenCalledTimes(2);
    const second = jest.mocked(syncProgress).mock.calls.at(-1)![0];
    expect(second.timeListened).toBe(15);
  });

  describe("Buffering/Loading stall", () => {
    it("folds a mid-stream Buffering tick into the playing UI flag (no pause glyph, scrubber keeps moving)", async () => {
      await startLoop();
      playerPos = 10;
      await tick(1000);
      expect(usePlaybackStore.getState().isPlaying).toBe(true);

      // The stream stalls: RNTP reports Buffering on this tick. A strict
      // `state === Playing` check would flip isPlaying:false → mini-player /
      // notification show the pause glyph over a frozen scrubber (looked hung)
      // and this tick would disarm itself (the paused early-return).
      jest.mocked(TrackPlayer.getPlaybackState).mockResolvedValue({ state: State.Buffering } as any);
      playerPos = 11;
      await tick(1000);

      const s = usePlaybackStore.getState();
      expect(s.isPlaying).toBe(true); // folded — stays "playing"
      expect(s.position).toBe(11); // scrubber still advances

      // A subsequent Loading tick is folded too.
      jest.mocked(TrackPlayer.getPlaybackState).mockResolvedValue({ state: State.Loading } as any);
      playerPos = 12;
      await tick(1000);
      expect(usePlaybackStore.getState().isPlaying).toBe(true);
    });

    it("accrues no listening time and never re-stamps progress while Buffering (strict-Playing gate)", async () => {
      await startLoop();
      playerPos = 10;
      await tick(1000); // Playing baseline — nothing listened yet
      await tick(1000); // 1s real listening → first sync
      expect(syncProgress).toHaveBeenCalledTimes(1);
      const savedBefore = persistedSession().currentTime;

      // Long buffering stretch: the UI flag stays "playing" (previous test) but
      // accrual/persistence must NOT run — buffering seconds aren't listening,
      // and a re-stamped updatedAt would poison freshest-wins.
      jest.mocked(TrackPlayer.getPlaybackState).mockResolvedValue({ state: State.Buffering } as any);
      playerPos = 50;
      await tick(20000); // >15s — WOULD cross the sync window if it accrued

      expect(syncProgress).toHaveBeenCalledTimes(1); // no extra sync
      expect(persistedSession().currentTime).toBe(savedBefore); // no MMKV re-stamp
    });
  });

  it("accrues no listening time while paused", async () => {
    await startLoop();
    jest.mocked(TrackPlayer.getPlaybackState).mockResolvedValue({ state: State.Paused } as any);

    await tick(5000);

    expect(syncProgress).not.toHaveBeenCalled();
    expect(usePlaybackStore.getState().isPlaying).toBe(false);
  });

  it("pause() flushes the accumulated listening time immediately", async () => {
    await startLoop();
    playerPos = 20;
    await tick(3000); // tick2 synced 1s; tick3 left 1s in the accumulator
    expect(syncProgress).toHaveBeenCalledTimes(1);

    await usePlaybackStore.getState().pause();

    expect(syncProgress).toHaveBeenCalledTimes(2);
    expect(jest.mocked(syncProgress).mock.calls.at(-1)![0]).toMatchObject({
      sessionId: "sess1",
      timeListened: 1,
    });
  });

  describe("auto mark-finished", () => {
    it("PATCHes the item finished exactly once per session", async () => {
      await startLoop();
      playerPos = 296; // within 5s of the 300s end

      await tick(1000);

      expect(api.patch).toHaveBeenCalledTimes(1);
      expect(api.patch).toHaveBeenCalledWith("/api/me/progress/item1", {
        currentTime: 300,
        duration: 300,
        progress: 1,
        isFinished: true,
      });
      expect(useUserStore.getState().mediaProgress["item1"]).toMatchObject({
        isFinished: true,
        progress: 1,
        currentTime: 300,
      });

      // More ticks near the end never re-fire the PATCH.
      await tick(3000);
      expect(api.patch).toHaveBeenCalledTimes(1);
    });

    it("later ticks preserve the finished flag in the progress map", async () => {
      await startLoop();
      playerPos = 296;
      await tick(1000); // marks finished

      playerPos = 297;
      await tick(1000); // per-tick write must not clobber isFinished back to false
      const entry = useUserStore.getState().mediaProgress["item1"];
      expect(entry.isFinished).toBe(true);
      expect(entry.currentTime).toBe(297);
    });

    it("queues the finish PATCH for later when offline", async () => {
      jest.mocked(api.patch).mockRejectedValue(new Error("Network Error"));
      await startLoop();
      playerPos = 296;

      await tick(1000);
      await Promise.resolve(); // let the .catch land

      expect(queueProgressPatch).toHaveBeenCalledWith("item1", 300, 300, null, {
        isFinished: true,
      });
    });

    it("uses the episode-scoped endpoint and composite key for podcast episodes", async () => {
      await startLoop({ id: "sess2", libraryItemId: "pod1", episodeId: "ep1" });
      playerPos = 296;

      await tick(1000);

      expect(api.patch).toHaveBeenCalledWith(
        "/api/me/progress/pod1/ep1",
        expect.objectContaining({ isFinished: true })
      );
      const map = useUserStore.getState().mediaProgress;
      expect(map["pod1-ep1"]).toMatchObject({ isFinished: true, episodeId: "ep1" });
      // No bogus item-level entry.
      expect(map["pod1"]).toBeUndefined();
    });

    it("kicks off auto-download-next when a plain book finishes", async () => {
      await startLoop();
      playerPos = 296; // within 5s of the 300s end

      await tick(1000);

      expect(autoDownloadNextAfterFinish).toHaveBeenCalledTimes(1);
      expect(autoDownloadNextAfterFinish).toHaveBeenCalledWith("item1");
    });

    it("does NOT auto-download-next when a podcast EPISODE finishes", async () => {
      await startLoop({ id: "sess2", libraryItemId: "pod1", episodeId: "ep1" });
      playerPos = 296;

      await tick(1000);

      // The finish PATCH still fires for the episode...
      expect(api.patch).toHaveBeenCalledWith(
        "/api/me/progress/pod1/ep1",
        expect.objectContaining({ isFinished: true })
      );
      // ...but auto-download-next is books-only.
      expect(autoDownloadNextAfterFinish).not.toHaveBeenCalled();
    });
  });

  it("keys podcast episode progress by the composite id on every tick", async () => {
    await startLoop({ id: "sess2", libraryItemId: "pod1", episodeId: "ep1" });
    playerPos = 25;

    await tick(1000);

    const map = useUserStore.getState().mediaProgress;
    expect(map["pod1-ep1"]).toMatchObject({ libraryItemId: "pod1", episodeId: "ep1", currentTime: 25 });
    expect(map["pod1"]).toBeUndefined();

    // The 15s server sync carries the episode id too.
    await tick(1000);
    expect(syncProgress).toHaveBeenCalledWith(expect.objectContaining({ episodeId: "ep1" }));
  });

  describe("casting ticks", () => {
    it("treats the receiver as source of truth and never overwrites the cast position", async () => {
      await startLoop({ chapters: CH });
      usePlaybackStore.getState().setCastState({ play: jest.fn(), pause: jest.fn() });
      // CastController mirrored the receiver here:
      usePlaybackStore.setState({ position: 150, duration: 300, isPlaying: true } as any);
      playerPos = 999; // paused local player must be ignored entirely

      await tick(1000);

      const s = usePlaybackStore.getState();
      expect(s.position).toBe(150);
      expect(s.currentChapterIndex).toBe(1); // derived from the RECEIVER's position
      // Local player state was never even read.
      expect(TrackPlayer.getProgress).not.toHaveBeenCalled();
    });

    it("rewrites the local item's metadata to the receiver's chapter and restores it on disconnect", async () => {
      await startLoop({ chapters: CH });
      usePlaybackStore.getState().setCastState({ play: jest.fn(), pause: jest.fn() });
      usePlaybackStore.setState({ position: 150, duration: 300, isPlaying: true } as any);

      await tick(1000);

      // The (paused) active local item now carries the receiver's chapter title.
      expect(TrackPlayer.updateMetadataForTrack).toHaveBeenCalledWith(
        0,
        expect.objectContaining({ title: "Chapter 2", artist: "Book • Author" })
      );

      // Cast disconnect: the chapter-queue item's true title is restored.
      jest.mocked(TrackPlayer.updateMetadataForTrack).mockClear();
      await restoreLocalNowPlayingMeta();
      expect(TrackPlayer.updateMetadataForTrack).toHaveBeenCalledWith(
        0,
        expect.objectContaining({ title: "Chapter 1" })
      );
    });

    it("keeps saving and syncing progress during a cast session", async () => {
      await startLoop();
      usePlaybackStore.getState().setCastState({ play: jest.fn(), pause: jest.fn() });
      usePlaybackStore.setState({ position: 42, duration: 300, isPlaying: true } as any);

      await tick(2000); // baseline + 1s listened → sync

      expect(persistedSession().currentTime).toBe(42);
      expect(syncProgress).toHaveBeenCalledWith(expect.objectContaining({ currentTime: 42 }));
      expect(useUserStore.getState().mediaProgress["item1"].currentTime).toBe(42);
    });
  });
});
