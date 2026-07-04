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
import { usePlaybackStore } from "../../store/usePlaybackStore";
import { storage } from "../../utils/storage";

const initial = usePlaybackStore.getState();

const CH = [
  { id: 0, title: "Chapter 1", start: 0, end: 100 },
  { id: 1, title: "Chapter 2", start: 100, end: 200 },
  { id: 2, title: "Chapter 3", start: 200, end: 300 },
];

function setup(over: Record<string, any> = {}) {
  usePlaybackStore.setState({
    isInitialized: true,
    currentSession: { id: "sess1", libraryItemId: "item1" },
    isPlaying: true,
    duration: 300,
    position: 0,
    chapters: CH,
    currentChapterIndex: 0,
    chapterQueue: false,
    ...over,
  } as any);
}

const tick = async (ms = 1000) => {
  await jest.advanceTimersByTimeAsync(ms);
};

describe("usePlaybackStore sleep timer", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    usePlaybackStore.setState(initial, true);
    storage.remove("lastPlaybackSession");
  });

  afterEach(() => {
    // Never leave a timer running into the next test.
    usePlaybackStore.getState().cancelSleepTimer();
    jest.useRealTimers();
  });

  describe("fixed countdown", () => {
    it("arms with the requested seconds and resets volume to full", () => {
      setup();
      usePlaybackStore.getState().setSleepTimer(600);
      expect(usePlaybackStore.getState().sleepTimer).toEqual({
        endOfChapter: false,
        remaining: 600,
        chapterIdx: undefined,
      });
      expect(TrackPlayer.setVolume).toHaveBeenCalledWith(1);
    });

    it("only counts down while playing", async () => {
      setup({ isPlaying: true });
      usePlaybackStore.getState().setSleepTimer(60);

      await tick(3000);
      expect(usePlaybackStore.getState().sleepTimer!.remaining).toBe(57);

      // Paused: a 20-minute pause must not eat the timer.
      usePlaybackStore.setState({ isPlaying: false } as any);
      await tick(5000);
      expect(usePlaybackStore.getState().sleepTimer!.remaining).toBe(57);

      usePlaybackStore.setState({ isPlaying: true } as any);
      await tick(2000);
      expect(usePlaybackStore.getState().sleepTimer!.remaining).toBe(55);
    });

    it("fades the volume over the final 20 seconds", async () => {
      setup();
      usePlaybackStore.getState().setSleepTimer(15);
      jest.mocked(TrackPlayer.setVolume).mockClear();

      await tick(1000); // remaining 14 → vol 14/20
      expect(TrackPlayer.setVolume).toHaveBeenCalledWith(14 / 20);
    });

    it("pauses playback at zero and restores full volume", async () => {
      setup();
      usePlaybackStore.getState().setSleepTimer(2);

      await tick(2000);

      expect(usePlaybackStore.getState().sleepTimer).toBeNull();
      expect(TrackPlayer.pause).toHaveBeenCalled();
      expect(usePlaybackStore.getState().isPlaying).toBe(false);
      // Fade undone so the next resume is audible.
      expect(jest.mocked(TrackPlayer.setVolume).mock.calls.at(-1)![0]).toBe(1);

      // The interval is gone — nothing else ticks.
      jest.mocked(TrackPlayer.pause).mockClear();
      await tick(5000);
      expect(TrackPlayer.pause).not.toHaveBeenCalled();
    });

    it("replacing a timer clears the previous interval (no double ticking)", async () => {
      setup();
      usePlaybackStore.getState().setSleepTimer(60);
      usePlaybackStore.getState().setSleepTimer(10);
      await tick(1000);
      expect(usePlaybackStore.getState().sleepTimer!.remaining).toBe(9);
    });
  });

  describe("end-of-chapter timer", () => {
    it("arms with the time remaining in the current chapter", () => {
      setup({ position: 95, currentChapterIndex: 0 });
      usePlaybackStore.getState().setSleepTimer(0, true);
      expect(usePlaybackStore.getState().sleepTimer).toEqual({
        endOfChapter: true,
        remaining: 5,
        chapterIdx: 0,
      });
    });

    it("recomputes remaining from the live position (follows seeks)", async () => {
      setup({ position: 50, currentChapterIndex: 0 });
      usePlaybackStore.getState().setSleepTimer(0, true);
      expect(usePlaybackStore.getState().sleepTimer!.remaining).toBe(50);

      usePlaybackStore.setState({ position: 90 } as any);
      await tick(1000);
      expect(usePlaybackStore.getState().sleepTimer!.remaining).toBe(10);
    });

    it("fires when the chapter boundary was crossed between ticks", async () => {
      setup({ position: 99, currentChapterIndex: 0 });
      usePlaybackStore.getState().setSleepTimer(0, true);

      // Playback rolled into chapter 2 before the next tick landed.
      usePlaybackStore.setState({ position: 101, currentChapterIndex: 1 } as any);
      await tick(1000);

      expect(usePlaybackStore.getState().sleepTimer).toBeNull();
      expect(TrackPlayer.pause).toHaveBeenCalled();
    });

    it("re-arms against an earlier chapter when the user seeks back", async () => {
      setup({ position: 150, currentChapterIndex: 1 });
      usePlaybackStore.getState().setSleepTimer(0, true); // armed in ch2, remaining 50

      usePlaybackStore.setState({ position: 30, currentChapterIndex: 0 } as any);
      await tick(1000);

      const t = usePlaybackStore.getState().sleepTimer!;
      expect(t.chapterIdx).toBe(0);
      expect(t.remaining).toBe(70); // 100 - 30
      expect(TrackPlayer.pause).not.toHaveBeenCalled();
    });

    it("holds without firing while the chapter is unknown", async () => {
      // Chapterless/transient state: currentChapterIndex -1 → remaining computes
      // to 0 at arm time but must NOT trip the pause.
      setup({ position: 50, currentChapterIndex: -1 });
      usePlaybackStore.getState().setSleepTimer(0, true);
      expect(usePlaybackStore.getState().sleepTimer!.remaining).toBe(0);

      await tick(3000);

      expect(usePlaybackStore.getState().sleepTimer).not.toBeNull();
      expect(TrackPlayer.pause).not.toHaveBeenCalled();
    });

    it("pauses at the chapter end", async () => {
      setup({ position: 98, currentChapterIndex: 0 });
      usePlaybackStore.getState().setSleepTimer(0, true); // remaining 2

      usePlaybackStore.setState({ position: 99 } as any);
      await tick(1000); // remaining 1
      expect(usePlaybackStore.getState().sleepTimer!.remaining).toBe(1);

      usePlaybackStore.setState({ position: 100, currentChapterIndex: 1 } as any);
      await tick(1000);
      expect(usePlaybackStore.getState().sleepTimer).toBeNull();
      expect(TrackPlayer.pause).toHaveBeenCalled();
    });
  });

  describe("cancelSleepTimer", () => {
    it("clears the timer and restores full volume", async () => {
      setup();
      usePlaybackStore.getState().setSleepTimer(10);
      await tick(1000); // mid-fade (remaining 9 < 20 → volume lowered)
      jest.mocked(TrackPlayer.setVolume).mockClear();

      usePlaybackStore.getState().cancelSleepTimer();

      expect(usePlaybackStore.getState().sleepTimer).toBeNull();
      expect(TrackPlayer.setVolume).toHaveBeenCalledWith(1);

      // No residual ticking.
      await tick(5000);
      expect(TrackPlayer.pause).not.toHaveBeenCalled();
    });

    it("does not touch the local volume while casting", () => {
      setup({ isCasting: true, castClient: { pause: jest.fn() } });
      usePlaybackStore.getState().cancelSleepTimer();
      expect(TrackPlayer.setVolume).not.toHaveBeenCalled();
    });
  });
});
