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

import TrackPlayer from "react-native-track-player";
import { usePlaybackStore, applyJumpOptions } from "../../store/usePlaybackStore";
import { useUserStore } from "../../store/useUserStore";
import { closeSession } from "../../utils/progressSync";
import { storage } from "../../utils/storage";

const initialPlayback = usePlaybackStore.getState();
const initialUser = useUserStore.getState();

const BASE = new Date("2026-01-01T12:00:00Z").getTime();

const SESSION = { id: "sess1", libraryItemId: "item1", displayTitle: "Book", displayAuthor: "Author" };

function setupLocal(over: Record<string, any> = {}) {
  usePlaybackStore.setState({
    isInitialized: true,
    currentSession: SESSION,
    duration: 300,
    position: 100,
    chapters: [],
    chapterQueue: false,
    ...over,
  } as any);
}

function makeCastClient() {
  return {
    play: jest.fn().mockResolvedValue(undefined),
    pause: jest.fn().mockResolvedValue(undefined),
    seek: jest.fn().mockResolvedValue(undefined),
    setPlaybackRate: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
  };
}

describe("usePlaybackStore transport", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(BASE);
    usePlaybackStore.setState(initialPlayback, true);
    useUserStore.setState(initialUser, true);
    storage.remove("lastPlaybackSession");
    storage.remove("playbackRate");
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("play() auto-rewind scaling", () => {
    // Each case pauses, advances the wall clock, plays, and asserts the rewind.
    const cases: Array<[pausedForMs: number, rewind: number]> = [
      [5_000, 0], // <10s → none
      [30_000, 2], // <60s → 2s
      [5 * 60_000, 10], // <30min → 10s
      [2 * 3_600_000, 20], // <6h → 20s
      [7 * 3_600_000, 30], // ≥6h → 30s
    ];

    it.each(cases)("pausing for %dms rewinds %ds on resume", async (pausedForMs, rewind) => {
      setupLocal({ isPlaying: true });
      // Auto-rewind (and pause persistence) read the LIVE player position —
      // the store snapshot can be stale after background throttling.
      jest.mocked(TrackPlayer.getProgress).mockResolvedValue({ position: 100, duration: 300, buffered: 0 } as any);
      await usePlaybackStore.getState().pause();
      jest.mocked(TrackPlayer.seekTo).mockClear();

      jest.setSystemTime(BASE + pausedForMs);
      await usePlaybackStore.getState().play();

      if (rewind === 0) {
        expect(TrackPlayer.seekTo).not.toHaveBeenCalled();
      } else {
        expect(TrackPlayer.seekTo).toHaveBeenCalledWith(100 - rewind);
      }
      expect(TrackPlayer.play).toHaveBeenCalled();
      expect(usePlaybackStore.getState().isPlaying).toBe(true);
    });

    it("clamps the rewind target at zero", async () => {
      setupLocal({ position: 1 });
      jest.mocked(TrackPlayer.getProgress).mockResolvedValue({ position: 1, duration: 300, buffered: 0 } as any);
      await usePlaybackStore.getState().pause();
      jest.setSystemTime(BASE + 30_000);
      await usePlaybackStore.getState().play();
      expect(TrackPlayer.seekTo).toHaveBeenCalledWith(0);
    });

    it("applies the rewind only once per pause", async () => {
      setupLocal();
      await usePlaybackStore.getState().pause();
      jest.setSystemTime(BASE + 30_000);
      await usePlaybackStore.getState().play();
      jest.mocked(TrackPlayer.seekTo).mockClear();

      // Play again without an intervening pause — no second rewind.
      await usePlaybackStore.getState().play();
      expect(TrackPlayer.seekTo).not.toHaveBeenCalled();
    });

    it("is disabled by the disableAutoRewind setting", async () => {
      setupLocal();
      useUserStore.setState({
        settings: { ...useUserStore.getState().settings, disableAutoRewind: true },
      } as any);
      await usePlaybackStore.getState().pause();
      jest.setSystemTime(BASE + 30_000);
      await usePlaybackStore.getState().play();
      expect(TrackPlayer.seekTo).not.toHaveBeenCalled();
      expect(TrackPlayer.play).toHaveBeenCalled();
    });
  });

  describe("pause()", () => {
    it("pauses the local player and persists the LIVE position immediately", async () => {
      // Snapshot deliberately stale (position: 5) — the persisted position
      // must come from the player, not the background-throttled snapshot.
      setupLocal({ isPlaying: true, position: 5 });
      jest.mocked(TrackPlayer.getProgress).mockResolvedValue({ position: 123, duration: 300, buffered: 0 } as any);
      await usePlaybackStore.getState().pause();
      expect(TrackPlayer.pause).toHaveBeenCalled();
      expect(usePlaybackStore.getState().isPlaying).toBe(false);
      const saved = JSON.parse(storage.getString("lastPlaybackSession")!);
      expect(saved.currentTime).toBe(123);
    });

    it("returns early (no persist) when not initialized and not casting", async () => {
      setupLocal({ isInitialized: false, isPlaying: true });
      await usePlaybackStore.getState().pause();
      expect(TrackPlayer.pause).not.toHaveBeenCalled();
      expect(storage.getString("lastPlaybackSession")).toBeUndefined();
    });
  });

  describe("cast transport routing", () => {
    it("play routes to the cast client, not TrackPlayer", async () => {
      setupLocal({ isPlaying: false });
      const client = makeCastClient();
      usePlaybackStore.getState().setCastState(client);

      await usePlaybackStore.getState().play();
      expect(client.play).toHaveBeenCalled();
      expect(TrackPlayer.play).not.toHaveBeenCalled();
      expect(usePlaybackStore.getState().isPlaying).toBe(true);
    });

    it("pause routes to the cast client and still persists position", async () => {
      setupLocal({ isPlaying: true, position: 77 });
      const client = makeCastClient();
      usePlaybackStore.getState().setCastState(client);

      await usePlaybackStore.getState().pause();
      expect(client.pause).toHaveBeenCalled();
      expect(TrackPlayer.pause).not.toHaveBeenCalled();
      expect(usePlaybackStore.getState().isPlaying).toBe(false);
      expect(JSON.parse(storage.getString("lastPlaybackSession")!).currentTime).toBe(77);
    });

    it("swallows cast client failures", async () => {
      setupLocal({ isPlaying: false });
      const client = makeCastClient();
      client.play.mockRejectedValue(new Error("receiver gone"));
      usePlaybackStore.getState().setCastState(client);

      await expect(usePlaybackStore.getState().play()).resolves.toBeUndefined();
      expect(usePlaybackStore.getState().isPlaying).toBe(true);
    });
  });

  describe("playPause()", () => {
    it("toggles from playing to paused and back", async () => {
      setupLocal({ isPlaying: true });
      await usePlaybackStore.getState().playPause();
      expect(TrackPlayer.pause).toHaveBeenCalled();
      expect(usePlaybackStore.getState().isPlaying).toBe(false);

      await usePlaybackStore.getState().playPause();
      expect(TrackPlayer.play).toHaveBeenCalled();
      expect(usePlaybackStore.getState().isPlaying).toBe(true);
    });
  });

  describe("setPlaybackSpeed routing", () => {
    it("local: sets the player rate, persists globally, and stamps the session", async () => {
      setupLocal();
      await usePlaybackStore.getState().setPlaybackSpeed(1.5);
      expect(TrackPlayer.setRate).toHaveBeenCalledWith(1.5);
      expect(storage.getNumber("playbackRate")).toBe(1.5);
      const s = usePlaybackStore.getState();
      expect(s.playbackSpeed).toBe(1.5);
      expect(s.currentSession.playbackRate).toBe(1.5);
    });

    it("cast: routes to the client's setPlaybackRate, not TrackPlayer", async () => {
      setupLocal();
      const client = makeCastClient();
      usePlaybackStore.getState().setCastState(client);

      await usePlaybackStore.getState().setPlaybackSpeed(2.0);
      expect(client.setPlaybackRate).toHaveBeenCalledWith(2.0);
      expect(TrackPlayer.setRate).not.toHaveBeenCalled();
      expect(storage.getNumber("playbackRate")).toBe(2.0);
      expect(usePlaybackStore.getState().playbackSpeed).toBe(2.0);
    });

    it("updates only the speed when no session is loaded", async () => {
      setupLocal({ currentSession: null });
      await usePlaybackStore.getState().setPlaybackSpeed(0.8);
      expect(usePlaybackStore.getState().playbackSpeed).toBe(0.8);
      expect(usePlaybackStore.getState().currentSession).toBeNull();
    });
  });

  describe("closePlayback", () => {
    it("closes the ABS session, stops the receiver, resets the player, and clears state", async () => {
      setupLocal({ position: 150, isPlaying: true });
      storage.set("lastPlaybackSession", JSON.stringify({ id: "sess1" }));
      const client = makeCastClient();
      usePlaybackStore.getState().setCastState(client);
      usePlaybackStore.getState().setCastSeekHandler(jest.fn());

      await usePlaybackStore.getState().closePlayback();

      expect(closeSession).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "sess1", currentTime: 150, libraryItemId: "item1" })
      );
      expect(client.stop).toHaveBeenCalled();
      expect(TrackPlayer.reset).toHaveBeenCalled();
      expect(storage.getString("lastPlaybackSession")).toBeUndefined();

      const s = usePlaybackStore.getState();
      expect(s.currentSession).toBeNull();
      expect(s.isPlaying).toBe(false);
      expect(s.position).toBe(0);
      expect(s.duration).toBe(0);
      expect(s.chapters).toEqual([]);
      expect(s.sleepTimer).toBeNull();
      expect(s.castSeekAbs).toBeNull();
    });

    it("is a no-op when the player was never initialized", async () => {
      setupLocal({ isInitialized: false });
      await usePlaybackStore.getState().closePlayback();
      expect(closeSession).not.toHaveBeenCalled();
      expect(TrackPlayer.reset).not.toHaveBeenCalled();
    });

    it("never blocks teardown on a failing closeSession", async () => {
      setupLocal();
      jest.mocked(closeSession).mockRejectedValueOnce(new Error("offline"));
      await usePlaybackStore.getState().closePlayback();
      expect(TrackPlayer.reset).toHaveBeenCalled();
      expect(usePlaybackStore.getState().currentSession).toBeNull();
    });
  });

  describe("initializePlayer", () => {
    it("sets up the player once and flags initialized", async () => {
      await usePlaybackStore.getState().initializePlayer();
      expect(TrackPlayer.setupPlayer).toHaveBeenCalledTimes(1);
      expect(TrackPlayer.updateOptions).toHaveBeenCalled();
      expect(usePlaybackStore.getState().isInitialized).toBe(true);

      // Second call is a no-op.
      await usePlaybackStore.getState().initializePlayer();
      expect(TrackPlayer.setupPlayer).toHaveBeenCalledTimes(1);
    });

    it("treats an 'already initialized' native error as success", async () => {
      jest
        .mocked(TrackPlayer.setupPlayer)
        .mockRejectedValueOnce(Object.assign(new Error("player already initialized")));
      await usePlaybackStore.getState().initializePlayer();
      expect(usePlaybackStore.getState().isInitialized).toBe(true);
    });

    it("leaves isInitialized false on a real setup failure so a retry can happen", async () => {
      jest.mocked(TrackPlayer.setupPlayer).mockRejectedValueOnce(new Error("no audio focus"));
      await usePlaybackStore.getState().initializePlayer();
      expect(usePlaybackStore.getState().isInitialized).toBe(false);

      // Retry succeeds (mock resolves again).
      await usePlaybackStore.getState().initializePlayer();
      expect(usePlaybackStore.getState().isInitialized).toBe(true);
    });

    it("shares one init across concurrent callers", async () => {
      const p1 = usePlaybackStore.getState().initializePlayer();
      const p2 = usePlaybackStore.getState().initializePlayer();
      await Promise.all([p1, p2]);
      expect(TrackPlayer.setupPlayer).toHaveBeenCalledTimes(1);
    });
  });

  describe("jump interval options", () => {
    it("applyJumpOptions pushes the full capability set with configured intervals", async () => {
      useUserStore.setState({
        settings: { ...useUserStore.getState().settings, jumpForwardTime: 45, jumpBackwardTime: 15 },
      } as any);
      await applyJumpOptions();
      const opts = jest.mocked(TrackPlayer.updateOptions).mock.calls.at(-1)![0] as any;
      expect(opts.forwardJumpInterval).toBe(45);
      expect(opts.backwardJumpInterval).toBe(15);
      // Full capability set must always be present (partial updates wipe AA buttons).
      expect(opts.capabilities.length).toBeGreaterThanOrEqual(8);
    });

    it("re-applies options when the jump settings change while initialized", () => {
      usePlaybackStore.setState({ isInitialized: true } as any);
      useUserStore.setState({
        settings: { ...useUserStore.getState().settings, jumpForwardTime: 60 },
      } as any);
      expect(TrackPlayer.updateOptions).toHaveBeenCalled();
    });
  });

  it("setPlayerExpanded / setOnTabScreen update UI flags", () => {
    usePlaybackStore.getState().setPlayerExpanded(true);
    expect(usePlaybackStore.getState().isPlayerExpanded).toBe(true);
    usePlaybackStore.getState().setOnTabScreen(false);
    expect(usePlaybackStore.getState().onTabScreen).toBe(false);
  });
});
