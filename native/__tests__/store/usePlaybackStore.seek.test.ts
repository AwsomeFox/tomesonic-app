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

// Three 100s chapters spanning a 300s book (absolute start/end, ABS-style).
const CH = [
  { id: 0, title: "Chapter 1", start: 0, end: 100 },
  { id: 1, title: "Chapter 2", start: 100, end: 200 },
  { id: 2, title: "Chapter 3", start: 200, end: 300 },
];

const SESSION = { id: "sess1", libraryItemId: "item1", displayTitle: "Book", displayAuthor: "Author" };

function setupLocal(over: Record<string, any> = {}) {
  usePlaybackStore.setState({
    isInitialized: true,
    currentSession: SESSION,
    duration: 300,
    position: 0,
    chapters: CH,
    chapterQueue: false,
    currentChapterIndex: 0,
    ...over,
  } as any);
}

function persistedSession() {
  const raw = storage.getString("lastPlaybackSession");
  return raw ? JSON.parse(raw) : null;
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

describe("usePlaybackStore seek + chapter navigation", () => {
  beforeEach(() => {
    usePlaybackStore.setState(initial, true);
    storage.remove("lastPlaybackSession");
    jest.mocked(TrackPlayer.getActiveTrackIndex).mockResolvedValue(0);
  });

  describe("seek clamping", () => {
    it("clamps past-the-end seeks to the duration", async () => {
      setupLocal();
      await usePlaybackStore.getState().seek(9999);
      expect(TrackPlayer.seekTo).toHaveBeenCalledWith(300);
      expect(usePlaybackStore.getState().position).toBe(300);
    });

    it("clamps negative seeks to zero", async () => {
      setupLocal();
      await usePlaybackStore.getState().seek(-42);
      expect(TrackPlayer.seekTo).toHaveBeenCalledWith(0);
      expect(usePlaybackStore.getState().position).toBe(0);
    });

    it("passes the value through when duration is unknown", async () => {
      setupLocal({ duration: 0 });
      await usePlaybackStore.getState().seek(1234);
      expect(TrackPlayer.seekTo).toHaveBeenCalledWith(1234);
    });

    it("is a no-op when the player is not initialized", async () => {
      setupLocal({ isInitialized: false });
      await usePlaybackStore.getState().seek(50);
      expect(TrackPlayer.seekTo).not.toHaveBeenCalled();
    });
  });

  describe("plain (single-item) seek", () => {
    it("seeks absolutely and persists the position to MMKV immediately", async () => {
      setupLocal();
      await usePlaybackStore.getState().seek(150);
      expect(TrackPlayer.seekTo).toHaveBeenCalledWith(150);
      expect(usePlaybackStore.getState().position).toBe(150);
      const saved = persistedSession();
      expect(saved.currentTime).toBe(150);
      expect(saved.id).toBe("sess1");
      expect(typeof saved.updatedAt).toBe("number");
    });
  });

  describe("chapter-queue seek mapping", () => {
    it("skips to the owning chapter and seeks chapter-relative", async () => {
      setupLocal({ chapterQueue: true });
      jest.mocked(TrackPlayer.getActiveTrackIndex).mockResolvedValue(0);

      await usePlaybackStore.getState().seek(150); // chapter 2, 50s in

      expect(TrackPlayer.skip).toHaveBeenCalledWith(1);
      expect(TrackPlayer.seekTo).toHaveBeenCalledWith(50);
      const s = usePlaybackStore.getState();
      expect(s.position).toBe(150);
      expect(s.currentChapterIndex).toBe(1);
      expect(persistedSession().currentTime).toBe(150);
    });

    it("does not skip when the target lies in the active chapter", async () => {
      setupLocal({ chapterQueue: true });
      jest.mocked(TrackPlayer.getActiveTrackIndex).mockResolvedValue(1);

      await usePlaybackStore.getState().seek(170);

      expect(TrackPlayer.skip).not.toHaveBeenCalled();
      expect(TrackPlayer.seekTo).toHaveBeenCalledWith(70);
    });

    it("maps an at-the-end seek into the last chapter", async () => {
      setupLocal({ chapterQueue: true });
      jest.mocked(TrackPlayer.getActiveTrackIndex).mockResolvedValue(0);

      // 300 is not < any chapter end → falls back to the last chapter.
      await usePlaybackStore.getState().seek(300);

      expect(TrackPlayer.skip).toHaveBeenCalledWith(2);
      expect(TrackPlayer.seekTo).toHaveBeenCalledWith(100);
    });
  });

  describe("cast seek routing", () => {
    it("prefers the registered absolute cast seek handler", async () => {
      setupLocal();
      const client = makeCastClient();
      usePlaybackStore.getState().setCastState(client);
      const castSeekAbs = jest.fn().mockResolvedValue(undefined);
      usePlaybackStore.getState().setCastSeekHandler(castSeekAbs);

      await usePlaybackStore.getState().seek(150);

      expect(castSeekAbs).toHaveBeenCalledWith(150);
      expect(client.seek).not.toHaveBeenCalled();
      expect(TrackPlayer.seekTo).not.toHaveBeenCalled();
      // Optimistic scrubber move + crash-safe persist.
      expect(usePlaybackStore.getState().position).toBe(150);
      expect(persistedSession().currentTime).toBe(150);
    });

    it("falls back to the raw client seek when no handler is registered", async () => {
      setupLocal();
      const client = makeCastClient();
      usePlaybackStore.getState().setCastState(client);

      await usePlaybackStore.getState().seek(80);

      expect(client.seek).toHaveBeenCalledWith({ position: 80 });
      expect(TrackPlayer.seekTo).not.toHaveBeenCalled();
    });

    it("swallows cast seek failures (position already moved optimistically)", async () => {
      setupLocal();
      const client = makeCastClient();
      client.seek.mockRejectedValue(new Error("receiver gone"));
      usePlaybackStore.getState().setCastState(client);

      await expect(usePlaybackStore.getState().seek(60)).resolves.toBeUndefined();
      expect(usePlaybackStore.getState().position).toBe(60);
    });

    it("dropping the cast client also drops the seek handler", () => {
      const client = makeCastClient();
      usePlaybackStore.getState().setCastState(client);
      usePlaybackStore.getState().setCastSeekHandler(jest.fn());
      expect(usePlaybackStore.getState().isCasting).toBe(true);
      expect(usePlaybackStore.getState().castSeekAbs).toBeTruthy();

      usePlaybackStore.getState().setCastState(null);
      expect(usePlaybackStore.getState().isCasting).toBe(false);
      expect(usePlaybackStore.getState().castClient).toBeNull();
      expect(usePlaybackStore.getState().castSeekAbs).toBeNull();
    });
  });

  describe("seekForward / seekBackward", () => {
    it("seekForward adds to the position, clamped to duration", async () => {
      setupLocal({ position: 280 });
      await usePlaybackStore.getState().seekForward(30);
      expect(TrackPlayer.seekTo).toHaveBeenCalledWith(300);
    });

    it("seekBackward subtracts, clamped to zero", async () => {
      setupLocal({ position: 5 });
      await usePlaybackStore.getState().seekBackward(30);
      expect(TrackPlayer.seekTo).toHaveBeenCalledWith(0);
    });

    it("funnels through seek() so cast routing is inherited", async () => {
      setupLocal({ position: 100 });
      const client = makeCastClient();
      usePlaybackStore.getState().setCastState(client);

      await usePlaybackStore.getState().seekForward(10);
      expect(client.seek).toHaveBeenCalledWith({ position: 110 });
      expect(TrackPlayer.seekTo).not.toHaveBeenCalled();
    });
  });

  describe("seekToChapter", () => {
    it("chapter queue: jumps straight to the clip and persists", async () => {
      setupLocal({ chapterQueue: true });
      await usePlaybackStore.getState().seekToChapter(2);
      expect(TrackPlayer.skip).toHaveBeenCalledWith(2);
      expect(TrackPlayer.seekTo).toHaveBeenCalledWith(0);
      const s = usePlaybackStore.getState();
      expect(s.currentChapterIndex).toBe(2);
      expect(s.position).toBe(200);
      expect(persistedSession().currentTime).toBe(200);
    });

    it("single item: seeks to the chapter's absolute start", async () => {
      setupLocal();
      await usePlaybackStore.getState().seekToChapter(1);
      expect(TrackPlayer.seekTo).toHaveBeenCalledWith(100);
      expect(usePlaybackStore.getState().currentChapterIndex).toBe(1);
    });

    it("casting: routes through seek to the cast client", async () => {
      setupLocal({ chapterQueue: true });
      const client = makeCastClient();
      usePlaybackStore.getState().setCastState(client);

      await usePlaybackStore.getState().seekToChapter(1);
      expect(client.seek).toHaveBeenCalledWith({ position: 100 });
      expect(TrackPlayer.skip).not.toHaveBeenCalled();
      expect(usePlaybackStore.getState().currentChapterIndex).toBe(1);
    });

    it("ignores out-of-range chapter indexes", async () => {
      setupLocal();
      await usePlaybackStore.getState().seekToChapter(99);
      expect(TrackPlayer.seekTo).not.toHaveBeenCalled();
      expect(TrackPlayer.skip).not.toHaveBeenCalled();
    });
  });

  describe("nextChapter", () => {
    it("chapter queue: uses the real active index, not the possibly-stale store index", async () => {
      setupLocal({ chapterQueue: true, currentChapterIndex: 0 });
      jest.mocked(TrackPlayer.getActiveTrackIndex).mockResolvedValue(1);

      await usePlaybackStore.getState().nextChapter();
      expect(TrackPlayer.skip).toHaveBeenCalledWith(2);
    });

    it("chapter queue: no-op at the last chapter", async () => {
      setupLocal({ chapterQueue: true });
      jest.mocked(TrackPlayer.getActiveTrackIndex).mockResolvedValue(2);

      await usePlaybackStore.getState().nextChapter();
      expect(TrackPlayer.skip).not.toHaveBeenCalled();
      expect(TrackPlayer.seekTo).not.toHaveBeenCalled();
    });

    it("single item: advances from the store's chapter index", async () => {
      setupLocal({ currentChapterIndex: 1 });
      await usePlaybackStore.getState().nextChapter();
      expect(TrackPlayer.seekTo).toHaveBeenCalledWith(200);
    });

    it("single item: no-op past the last chapter", async () => {
      setupLocal({ currentChapterIndex: 2 });
      await usePlaybackStore.getState().nextChapter();
      expect(TrackPlayer.seekTo).not.toHaveBeenCalled();
    });
  });

  describe("previousChapter (restart-after-3s rule)", () => {
    it("chapter queue: >3s into the chapter restarts it", async () => {
      setupLocal({ chapterQueue: true, position: 150 });
      jest.mocked(TrackPlayer.getActiveTrackIndex).mockResolvedValue(1);

      await usePlaybackStore.getState().previousChapter();
      // Restart chapter 1, not skip to chapter 0.
      expect(TrackPlayer.skip).toHaveBeenCalledWith(1);
      expect(TrackPlayer.seekTo).toHaveBeenCalledWith(0);
      expect(usePlaybackStore.getState().position).toBe(100);
    });

    it("chapter queue: within 3s goes to the previous chapter", async () => {
      setupLocal({ chapterQueue: true, position: 102 });
      jest.mocked(TrackPlayer.getActiveTrackIndex).mockResolvedValue(1);

      await usePlaybackStore.getState().previousChapter();
      expect(TrackPlayer.skip).toHaveBeenCalledWith(0);
      expect(usePlaybackStore.getState().position).toBe(0);
    });

    it("chapter queue: within 3s of the first chapter restarts it", async () => {
      setupLocal({ chapterQueue: true, position: 2 });
      jest.mocked(TrackPlayer.getActiveTrackIndex).mockResolvedValue(0);

      await usePlaybackStore.getState().previousChapter();
      expect(TrackPlayer.skip).toHaveBeenCalledWith(0);
      expect(TrackPlayer.seekTo).toHaveBeenCalledWith(0);
    });

    it("single item: >3s restarts the current chapter", async () => {
      setupLocal({ currentChapterIndex: 1, position: 150 });
      await usePlaybackStore.getState().previousChapter();
      expect(TrackPlayer.seekTo).toHaveBeenCalledWith(100);
    });

    it("single item: within 3s jumps to the previous chapter's start", async () => {
      setupLocal({ currentChapterIndex: 1, position: 101 });
      await usePlaybackStore.getState().previousChapter();
      expect(TrackPlayer.seekTo).toHaveBeenCalledWith(0);
    });
  });
});
