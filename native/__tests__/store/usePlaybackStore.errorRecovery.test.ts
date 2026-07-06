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
import { storage, storageHelper, secureStorage } from "../../utils/storage";
import {
  usePlaybackStore,
  onPlaybackError,
  recoverPlaybackIfNeeded,
} from "../../store/usePlaybackStore";
import { playbackService } from "../../store/playbackService";
import { useUserStore } from "../../store/useUserStore";
import { useDownloadStore } from "../../store/useDownloadStore";

const initialPlayback = usePlaybackStore.getState();
const initialUser = useUserStore.getState();
const initialDownloads = useDownloadStore.getState();

const BASE = new Date("2026-03-01T08:00:00Z").getTime();
const mockRetry = jest.mocked(TrackPlayer.retry);
const mockPlay = jest.mocked(TrackPlayer.play);
const mockState = jest.mocked(TrackPlayer.getPlaybackState);

function serverSession(over: Record<string, any> = {}) {
  return {
    id: "sess1",
    libraryItemId: "item1",
    displayTitle: "The Hobbit",
    displayAuthor: "Tolkien",
    duration: 300,
    currentTime: 0,
    chapters: [],
    audioTracks: [
      { index: 0, contentUrl: "/api/items/item1/file/0", duration: 300, startOffset: 0 },
    ],
    ...over,
  };
}

// The device-sleep failure: streaming playback dies mid-stream (network
// suspended by doze), ExoPlayer errors out and sits IDLE forever. These tests
// cover the whole recovery surface: doze-proof player setup, the error
// handler, bounded auto-retry, foreground/manual recovery, and the guards.
describe("usePlaybackStore playback-error recovery", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(BASE);
    usePlaybackStore.setState(initialPlayback, true);
    useUserStore.setState(initialUser, true);
    useDownloadStore.setState(initialDownloads, true);
    useDownloadStore.setState({ activeDownloads: {}, completedDownloads: {} });
    storage.getAllKeys().forEach((k) => storage.remove(k));
    secureStorage.getAllKeys().forEach((k) => secureStorage.remove(k));
    storageHelper.setServerConfig({ address: "https://abs.example.com/", token: "tok" });
    mockRetry.mockClear().mockResolvedValue(undefined);
    mockPlay.mockClear().mockResolvedValue(undefined);
    mockState.mockClear().mockResolvedValue({ state: "paused" } as any);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("player setup (doze-proofing)", () => {
    it("requests WAKE_MODE_NETWORK and streaming buffer headroom", async () => {
      await usePlaybackStore.getState().initializePlayer();
      const opts = jest.mocked(TrackPlayer.setupPlayer).mock.calls.at(-1)![0] as any;
      // 2 = ExoPlayer C.WAKE_MODE_NETWORK — wake + wifi lock while playing.
      // Without it, doze suspends the network mid-stream and playback dies
      // with the screen off (the reported bug).
      expect(opts.androidWakeMode).toBe(2);
      // Enough buffered audio to ride out doze-window network flaps, and a
      // back-buffer covering the largest auto-rewind nudge (30s).
      expect(opts.minBuffer).toBe(60);
      expect(opts.maxBuffer).toBe(300);
      expect(opts.backBuffer).toBe(30);
      // Disk cache: chapter-boundary loads re-open the same file URL — served
      // from cache they can't die on a doze-flaky network.
      expect(opts.maxCacheSize).toBe(256 * 1024);
    });
  });

  describe("onPlaybackError", () => {
    it("persists the position, marks not playing, and arms auto-retry", async () => {
      await usePlaybackStore.getState().preparePlaybackSession(serverSession(), true);
      usePlaybackStore.setState({ position: 123 });
      mockState.mockResolvedValue({ state: "error" } as any);

      onPlaybackError({ code: "android-io-network-connection-failed", message: "boom" });

      // Store reflects reality immediately (no more phantom isPlaying).
      expect(usePlaybackStore.getState().isPlaying).toBe(false);
      // Crash-safe: the position where the stream died is on disk.
      expect(storageHelper.getLastPlaybackSession().currentTime).toBe(123);

      // First automatic retry fires after 2s and resumes playback.
      mockPlay.mockClear();
      await jest.advanceTimersByTimeAsync(2000);
      expect(mockRetry).toHaveBeenCalledTimes(1);
      expect(mockPlay).toHaveBeenCalled();
      expect(usePlaybackStore.getState().isPlaying).toBe(true);
    });

    it("does not auto-resume when the error hit an already-paused player", async () => {
      await usePlaybackStore.getState().preparePlaybackSession(serverSession(), false);
      mockState.mockResolvedValue({ state: "error" } as any);

      onPlaybackError({ message: "boom" });
      mockPlay.mockClear();
      await jest.advanceTimersByTimeAsync(60000);
      expect(mockRetry).not.toHaveBeenCalled();
      expect(mockPlay).not.toHaveBeenCalled();
      expect(usePlaybackStore.getState().isPlaying).toBe(false);
    });

    it("ignores errors with no session or while casting", async () => {
      // No session at all: nothing to recover.
      onPlaybackError({ message: "boom" });
      await jest.advanceTimersByTimeAsync(60000);
      expect(mockRetry).not.toHaveBeenCalled();

      // Casting: the receiver owns playback; the paused local player's error
      // must not flip the store or schedule anything.
      await usePlaybackStore.getState().preparePlaybackSession(serverSession(), true);
      usePlaybackStore.getState().setCastState({ play: jest.fn(), pause: jest.fn() });
      usePlaybackStore.setState({ isPlaying: true });
      onPlaybackError({ message: "boom" });
      expect(usePlaybackStore.getState().isPlaying).toBe(true);
      await jest.advanceTimersByTimeAsync(60000);
      expect(mockRetry).not.toHaveBeenCalled();
    });
  });

  describe("bounded backoff", () => {
    it("retries at 2s/10s/30s while the network is still down, then stops", async () => {
      await usePlaybackStore.getState().preparePlaybackSession(serverSession(), true);
      mockState.mockResolvedValue({ state: "error" } as any);
      mockRetry.mockRejectedValue(new Error("still offline"));

      onPlaybackError({ message: "boom" });
      await jest.advanceTimersByTimeAsync(2000);
      expect(mockRetry).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(10000);
      expect(mockRetry).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(30000);
      expect(mockRetry).toHaveBeenCalledTimes(3);
      // Bounded: no fourth automatic attempt, ever.
      await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(mockRetry).toHaveBeenCalledTimes(3);
      expect(usePlaybackStore.getState().isPlaying).toBe(false);
    });

    it("a later attempt succeeding resumes playback", async () => {
      await usePlaybackStore.getState().preparePlaybackSession(serverSession(), true);
      mockState.mockResolvedValue({ state: "error" } as any);
      mockRetry.mockRejectedValueOnce(new Error("still offline")).mockResolvedValue(undefined);

      onPlaybackError({ message: "boom" });
      await jest.advanceTimersByTimeAsync(2000); // fails
      expect(usePlaybackStore.getState().isPlaying).toBe(false);
      mockPlay.mockClear();
      await jest.advanceTimersByTimeAsync(10000); // succeeds
      expect(mockRetry).toHaveBeenCalledTimes(2);
      expect(mockPlay).toHaveBeenCalled();
      expect(usePlaybackStore.getState().isPlaying).toBe(true);
    });
  });

  describe("recoverPlaybackIfNeeded (foreground / connectivity hook)", () => {
    it("recovers immediately without waiting for the backoff timer", async () => {
      await usePlaybackStore.getState().preparePlaybackSession(serverSession(), true);
      mockState.mockResolvedValue({ state: "error" } as any);
      onPlaybackError({ message: "boom" });

      mockPlay.mockClear();
      await recoverPlaybackIfNeeded();
      expect(mockRetry).toHaveBeenCalledTimes(1);
      expect(mockPlay).toHaveBeenCalled();
      expect(usePlaybackStore.getState().isPlaying).toBe(true);
      // The pending 2s timer was consumed — no double retry later.
      await jest.advanceTimersByTimeAsync(60000);
      expect(mockRetry).toHaveBeenCalledTimes(1);
    });

    it("no-ops when there is no pending error", async () => {
      await usePlaybackStore.getState().preparePlaybackSession(serverSession(), true);
      expect(await recoverPlaybackIfNeeded()).toBe(false);
      expect(mockRetry).not.toHaveBeenCalled();
    });

    it("stands down if the player recovered on its own", async () => {
      await usePlaybackStore.getState().preparePlaybackSession(serverSession(), true);
      mockState.mockResolvedValue({ state: "error" } as any);
      onPlaybackError({ message: "boom" });
      // Media3's own load-error handling brought it back before we acted.
      mockState.mockResolvedValue({ state: "playing" } as any);

      expect(await recoverPlaybackIfNeeded()).toBe(false);
      expect(mockRetry).not.toHaveBeenCalled();
      // Recovery is cleared — the backoff timer won't fire a retry either.
      await jest.advanceTimersByTimeAsync(60000);
      expect(mockRetry).not.toHaveBeenCalled();
    });
  });

  describe("manual play() on an errored player", () => {
    it("re-prepares (retry) before playing so the tap actually resumes", async () => {
      await usePlaybackStore.getState().preparePlaybackSession(serverSession(), false);
      mockState.mockResolvedValue({ state: "error" } as any);

      await usePlaybackStore.getState().play();
      expect(mockRetry).toHaveBeenCalledTimes(1);
      expect(mockPlay).toHaveBeenCalled();
      // retry must run BEFORE play — play() on an IDLE player is a no-op.
      expect(mockRetry.mock.invocationCallOrder[0]).toBeLessThan(
        mockPlay.mock.invocationCallOrder.at(-1)!
      );
      expect(usePlaybackStore.getState().isPlaying).toBe(true);
    });

    it("healthy player: play() does not touch retry", async () => {
      await usePlaybackStore.getState().preparePlaybackSession(serverSession(), false);
      mockState.mockResolvedValue({ state: "paused" } as any);
      await usePlaybackStore.getState().play();
      expect(mockRetry).not.toHaveBeenCalled();
      expect(mockPlay).toHaveBeenCalled();
    });
  });

  describe("lifecycle guards", () => {
    it("preparing a new session cancels the previous session's pending retry", async () => {
      await usePlaybackStore.getState().preparePlaybackSession(serverSession(), true);
      mockState.mockResolvedValue({ state: "error" } as any);
      onPlaybackError({ message: "boom" });

      await usePlaybackStore
        .getState()
        .preparePlaybackSession(serverSession({ id: "sess2", libraryItemId: "item2" }), true);
      await jest.advanceTimersByTimeAsync(60000);
      expect(mockRetry).not.toHaveBeenCalled();
    });

    it("closePlayback cancels a pending retry", async () => {
      await usePlaybackStore.getState().preparePlaybackSession(serverSession(), true);
      mockState.mockResolvedValue({ state: "error" } as any);
      onPlaybackError({ message: "boom" });

      await usePlaybackStore.getState().closePlayback();
      await jest.advanceTimersByTimeAsync(60000);
      expect(mockRetry).not.toHaveBeenCalled();
    });
  });

  describe("service wiring", () => {
    it("playbackService routes Event.PlaybackError into the store handler", async () => {
      await playbackService();
      await usePlaybackStore.getState().preparePlaybackSession(serverSession(), true);
      usePlaybackStore.setState({ position: 77 });
      mockState.mockResolvedValue({ state: "error" } as any);

      (TrackPlayer as any).__emit("playback-error", { code: "x", message: "net down" });

      expect(usePlaybackStore.getState().isPlaying).toBe(false);
      expect(storageHelper.getLastPlaybackSession().currentTime).toBe(77);
    });
  });
});
