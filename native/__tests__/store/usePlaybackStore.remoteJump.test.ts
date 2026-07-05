/**
 * REGRESSION: notification jump buttons vs a stale store snapshot.
 *
 * The store's `position` is written by a 1s JS interval that Android
 * throttles while the app is backgrounded — the NATIVE player keeps playing
 * while the snapshot freezes. seekForward/seekBackward used to compute the
 * target from that snapshot, so a "back 10s" press from the notification
 * could leap back MINUTES (stale position − 10) instead of 10 seconds.
 * Relative seeks must read the live player position.
 */
jest.mock("../../utils/progressSync", () => ({
  syncProgress: jest.fn().mockResolvedValue(undefined),
  closeSession: jest.fn().mockResolvedValue(undefined),
  queueProgressPatch: jest.fn(),
  queueFinishedPatch: jest.fn(),
  queueEbookProgressPatch: jest.fn(),
  flushPendingSyncs: jest.fn().mockResolvedValue(undefined),
  clearAllPending: jest.fn(),
}));

import TrackPlayer from "react-native-track-player";
import { closeSession } from "../../utils/progressSync";
import { storage } from "../../utils/storage";
import { usePlaybackStore } from "../../store/usePlaybackStore";

const mockedTP = jest.mocked(TrackPlayer);

const initialState = usePlaybackStore.getState();

beforeEach(() => {
  jest.clearAllMocks();
  usePlaybackStore.setState(initialState, true);
  usePlaybackStore.setState({
    isInitialized: true,
    currentSession: { id: "s1", libraryItemId: "li1" },
    duration: 3600,
    isCasting: false,
  } as any);
});

describe("remote jumps read the LIVE player position", () => {
  it("seekBackward jumps 10s from the LIVE position, not the stale snapshot", async () => {
    // Store snapshot froze at 100s while the native player reached 500s
    // (backgrounded app, throttled interval).
    usePlaybackStore.setState({ position: 100, chapterQueue: false, chapters: [] } as any);
    mockedTP.getProgress.mockResolvedValue({ position: 500, duration: 3600, buffered: 0 } as any);

    await usePlaybackStore.getState().seekBackward(10);

    // 500 - 10 = 490 — NOT 100 - 10 = 90 (the old bug: a 400s leap).
    expect(mockedTP.seekTo).toHaveBeenCalledWith(490);
  });

  it("seekForward jumps from the LIVE position and clamps to duration", async () => {
    usePlaybackStore.setState({ position: 100, chapterQueue: false, chapters: [] } as any);
    mockedTP.getProgress.mockResolvedValue({ position: 3595, duration: 3600, buffered: 0 } as any);

    await usePlaybackStore.getState().seekForward(30);

    expect(mockedTP.seekTo).toHaveBeenCalledWith(3600); // clamped, not 130
  });

  it("chapter queues map the live chapter-relative position to absolute", async () => {
    const chapters = [
      { start: 0, end: 1000, title: "1" },
      { start: 1000, end: 2000, title: "2" },
      { start: 2000, end: 3600, title: "3" },
    ];
    usePlaybackStore.setState({ position: 50, chapterQueue: true, chapters } as any);
    // Native player: chapter 3 (index 2), 100s in → absolute 2100.
    mockedTP.getActiveTrackIndex.mockResolvedValue(2);
    mockedTP.getProgress.mockResolvedValue({ position: 100, duration: 1600, buffered: 0 } as any);

    await usePlaybackStore.getState().seekBackward(10);

    // Absolute target 2090 stays inside chapter 3 → seekTo(90), same item.
    expect(mockedTP.seekTo).toHaveBeenCalledWith(90);
    expect(mockedTP.skip).not.toHaveBeenCalled();
  });

  it("falls back to the store snapshot when the player is not readable", async () => {
    usePlaybackStore.setState({ position: 200, chapterQueue: false, chapters: [] } as any);
    mockedTP.getProgress.mockRejectedValue(new Error("no player"));

    await usePlaybackStore.getState().seekBackward(10);

    expect(mockedTP.seekTo).toHaveBeenCalledWith(190);
  });

  it("pause() persists and corrects to the LIVE position, not the stale snapshot", async () => {
    // Pausing FROM THE NOTIFICATION after backgrounded playback is exactly
    // when the snapshot lags — persisting it rolled real progress back.
    usePlaybackStore.setState({ position: 100, chapterQueue: false, chapters: [], isPlaying: true } as any);
    mockedTP.getProgress.mockResolvedValue({ position: 500, duration: 3600, buffered: 0 } as any);

    await usePlaybackStore.getState().pause();

    expect(usePlaybackStore.getState().position).toBe(500); // snapshot corrected
    const saved = JSON.parse(storage.getString("lastPlaybackSession")!);
    expect(saved.currentTime).toBe(500); // NOT 100
  });

  it("closePlayback() closes the ABS session at the LIVE position", async () => {
    usePlaybackStore.setState({ position: 100, chapterQueue: false, chapters: [] } as any);
    mockedTP.getProgress.mockResolvedValue({ position: 500, duration: 3600, buffered: 0 } as any);

    await usePlaybackStore.getState().closePlayback();

    expect(closeSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "s1", currentTime: 500 }) // NOT 100
    );
  });

  it("play() auto-rewind rewinds from the LIVE position", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(1_000_000);
    try {
      usePlaybackStore.setState({ position: 100, chapterQueue: false, chapters: [], isPlaying: true } as any);
      mockedTP.getProgress.mockResolvedValue({ position: 500, duration: 3600, buffered: 0 } as any);

      await usePlaybackStore.getState().pause();
      mockedTP.seekTo.mockClear();

      jest.setSystemTime(1_000_000 + 5 * 60_000); // paused 5 min → 10s rewind
      await usePlaybackStore.getState().play();

      expect(mockedTP.seekTo).toHaveBeenCalledWith(490); // NOT 90
    } finally {
      jest.useRealTimers();
    }
  });

  it("a throttled sleep-timer tick consumes the REAL elapsed time", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(2_000_000);
    try {
      usePlaybackStore.setState({
        isPlaying: true,
        chapterQueue: false,
        chapters: [],
      } as any);
      usePlaybackStore.getState().setSleepTimer(60);

      await jest.advanceTimersByTimeAsync(1000); // normal tick: 60 → 59
      expect(usePlaybackStore.getState().sleepTimer!.remaining).toBe(59);

      // Background throttle: 30s of wall clock pass before the next tick
      // lands. The single late tick must consume all ~31s, not 1s.
      jest.setSystemTime(2_000_000 + 1000 + 31_000);
      await jest.advanceTimersByTimeAsync(1000);
      const remaining = usePlaybackStore.getState().sleepTimer!.remaining;
      expect(remaining).toBeLessThanOrEqual(28);
      expect(remaining).toBeGreaterThan(20);
    } finally {
      usePlaybackStore.getState().cancelSleepTimer();
      jest.useRealTimers();
    }
  });

  it("while casting, uses the store position (receiver mirror is the truth)", async () => {
    const castClient = { seek: jest.fn().mockResolvedValue(undefined) };
    usePlaybackStore.setState({
      position: 800,
      isCasting: true,
      castClient,
      chapterQueue: false,
      chapters: [],
    } as any);

    await usePlaybackStore.getState().seekBackward(10);

    // Cast path: raw client seek to the absolute target.
    expect(castClient.seek).toHaveBeenCalledWith({ position: 790 });
    expect(mockedTP.getProgress).not.toHaveBeenCalled();
  });
});
