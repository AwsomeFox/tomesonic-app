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
    it("seekForward adds to the LIVE position, clamped to duration", async () => {
      // The store snapshot is deliberately stale — jumps must use the live
      // player position (the snapshot freezes while backgrounded).
      setupLocal({ position: 10 });
      jest.mocked(TrackPlayer.getProgress).mockResolvedValue({ position: 280, duration: 300, buffered: 0 } as any);
      await usePlaybackStore.getState().seekForward(30);
      expect(TrackPlayer.seekTo).toHaveBeenCalledWith(300);
    });

    it("seekBackward subtracts from the LIVE position, clamped to zero", async () => {
      setupLocal({ position: 250 });
      jest.mocked(TrackPlayer.getProgress).mockResolvedValue({ position: 5, duration: 300, buffered: 0 } as any);
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

    it("single item: advances from the LIVE chapter (snapshot index can be stale)", async () => {
      setupLocal({ currentChapterIndex: 0 }); // stale snapshot
      jest.mocked(TrackPlayer.getProgress).mockResolvedValue({ position: 150, duration: 300, buffered: 0 } as any); // live: chapter 1
      await usePlaybackStore.getState().nextChapter();
      expect(TrackPlayer.seekTo).toHaveBeenCalledWith(200);
    });

    it("single item: no-op past the last chapter", async () => {
      setupLocal({ currentChapterIndex: 2 });
      jest.mocked(TrackPlayer.getProgress).mockResolvedValue({ position: 250, duration: 300, buffered: 0 } as any);
      await usePlaybackStore.getState().nextChapter();
      expect(TrackPlayer.seekTo).not.toHaveBeenCalled();
    });
  });

  describe("previousChapter (restart-after-3s rule)", () => {
    it("chapter queue: >3s into the chapter restarts it", async () => {
      setupLocal({ chapterQueue: true, position: 150 });
      jest.mocked(TrackPlayer.getActiveTrackIndex).mockResolvedValue(1);
      // Live position: 50s into the chapter clip.
      jest.mocked(TrackPlayer.getProgress).mockResolvedValue({ position: 50, duration: 100, buffered: 0 } as any);

      await usePlaybackStore.getState().previousChapter();
      // Restart chapter 1, not skip to chapter 0.
      expect(TrackPlayer.skip).toHaveBeenCalledWith(1);
      expect(TrackPlayer.seekTo).toHaveBeenCalledWith(0);
      expect(usePlaybackStore.getState().position).toBe(100);
    });

    it("chapter queue: within 3s goes to the previous chapter", async () => {
      setupLocal({ chapterQueue: true, position: 102 });
      jest.mocked(TrackPlayer.getActiveTrackIndex).mockResolvedValue(1);
      jest.mocked(TrackPlayer.getProgress).mockResolvedValue({ position: 2, duration: 100, buffered: 0 } as any);

      await usePlaybackStore.getState().previousChapter();
      expect(TrackPlayer.skip).toHaveBeenCalledWith(0);
      expect(usePlaybackStore.getState().position).toBe(0);
    });

    it("chapter queue: within 3s of the first chapter restarts it", async () => {
      setupLocal({ chapterQueue: true, position: 2 });
      jest.mocked(TrackPlayer.getActiveTrackIndex).mockResolvedValue(0);
      jest.mocked(TrackPlayer.getProgress).mockResolvedValue({ position: 2, duration: 100, buffered: 0 } as any);

      await usePlaybackStore.getState().previousChapter();
      expect(TrackPlayer.skip).toHaveBeenCalledWith(0);
      expect(TrackPlayer.seekTo).toHaveBeenCalledWith(0);
    });

    it("single item: >3s restarts the current chapter", async () => {
      setupLocal({ currentChapterIndex: 1, position: 150 });
      jest.mocked(TrackPlayer.getProgress).mockResolvedValue({ position: 150, duration: 300, buffered: 0 } as any);
      await usePlaybackStore.getState().previousChapter();
      expect(TrackPlayer.seekTo).toHaveBeenCalledWith(100);
    });

    it("single item: within 3s jumps to the previous chapter's start", async () => {
      setupLocal({ currentChapterIndex: 1, position: 101 });
      jest.mocked(TrackPlayer.getProgress).mockResolvedValue({ position: 101, duration: 300, buffered: 0 } as any);
      await usePlaybackStore.getState().previousChapter();
      expect(TrackPlayer.seekTo).toHaveBeenCalledWith(0);
    });
  });

  // REGRESSION (CI flow 22): two-file book, chapter per file. RNTP positions
  // are FILE-relative, and getLiveAbsolutePosition didn't map them through
  // _trackOffsets — at the start of file 2 it reported book position 0, so
  // previousChapter resolved "chapter 1, prev = chapters[-1]" and no-oped.
  describe("multi-file live-position offset mapping", () => {
    const MULTI = {
      id: "sess1",
      libraryItemId: "item1",
      displayTitle: "The Test Book",
      displayAuthor: "Test Author",
      duration: 180,
      currentTime: 0,
      chapters: [
        { id: 0, title: "Chapter 1", start: 0, end: 90 },
        { id: 1, title: "Chapter 2", start: 90, end: 180 },
      ],
      audioTracks: [
        { index: 0, contentUrl: "/api/items/item1/file/0", duration: 90, startOffset: 0 },
        { index: 1, contentUrl: "/api/items/item1/file/1", duration: 90, startOffset: 90 },
      ],
    };

    beforeEach(async () => {
      const { storageHelper } = require("../../utils/storage");
      storageHelper.setServerConfig({ address: "https://abs.example.com", token: "tok" });
      // Skip the real initializePlayer: its 1s progress interval is a live
      // node handle that keeps an in-band jest process from exiting.
      usePlaybackStore.setState({ isInitialized: true } as any);
      await usePlaybackStore.getState().preparePlaybackSession(MULTI as any, false);
      jest.mocked(TrackPlayer.skip).mockClear();
      jest.mocked(TrackPlayer.seekTo).mockClear();
    });

    it("previousChapter at the start of file 2 goes back to chapter 1", async () => {
      jest.mocked(TrackPlayer.getActiveTrackIndex).mockResolvedValue(1);
      // File-relative 0s = book-absolute 90s (chapter 2's start).
      jest.mocked(TrackPlayer.getProgress).mockResolvedValue({ position: 0, duration: 90, buffered: 0 } as any);

      await usePlaybackStore.getState().previousChapter();

      expect(TrackPlayer.skip).toHaveBeenCalledWith(0);
      expect(usePlaybackStore.getState().position).toBe(0);
      expect(usePlaybackStore.getState().currentChapterIndex).toBe(0);
    });

    it("previousChapter >3s into file 2 restarts chapter 2", async () => {
      jest.mocked(TrackPlayer.getActiveTrackIndex).mockResolvedValue(1);
      jest.mocked(TrackPlayer.getProgress).mockResolvedValue({ position: 50, duration: 90, buffered: 0 } as any);

      await usePlaybackStore.getState().previousChapter();

      // Chapter 2 starts at file 2's 0s — no track change needed.
      expect(TrackPlayer.skip).not.toHaveBeenCalled();
      expect(TrackPlayer.seekTo).toHaveBeenCalledWith(0);
      expect(usePlaybackStore.getState().position).toBe(90);
    });

    it("seekBackward in file 2 stays near the live position instead of jumping to the book start", async () => {
      jest.mocked(TrackPlayer.getActiveTrackIndex).mockResolvedValue(1);
      jest.mocked(TrackPlayer.getProgress).mockResolvedValue({ position: 30, duration: 90, buffered: 0 } as any);

      await usePlaybackStore.getState().seekBackward(10);

      // Book-absolute 120 - 10 = 110 → file 2 relative 20.
      expect(TrackPlayer.seekTo).toHaveBeenCalledWith(20);
      expect(usePlaybackStore.getState().position).toBe(110);
    });

    // REGRESSION: the notification/Android Auto seekbar reports its position
    // relative to the ACTIVE file. remoteSeek must add the file's offset —
    // before the fix it passed the file-relative value straight to seek() as
    // absolute, so a drag in file 2 landed back in file 1.
    it("remoteSeek maps a file-relative seekbar drag to the absolute book position", async () => {
      jest.mocked(TrackPlayer.getActiveTrackIndex).mockResolvedValue(1);

      await usePlaybackStore.getState().remoteSeek(30); // 30s into file 2

      // 90 (file-2 offset) + 30 = 120 absolute; seek re-derives file-2-relative 30.
      expect(usePlaybackStore.getState().position).toBe(120);
      expect(TrackPlayer.seekTo).toHaveBeenCalledWith(30);
      expect(TrackPlayer.skip).not.toHaveBeenCalled(); // already on file 2
    });

    // REGRESSION: while CASTING the multi-file mapping used to be skipped —
    // the notification seekbar (relative to the paused local item) was passed
    // to seek() as absolute, so a drag while in file 2 sent the receiver back
    // into file 1.
    it("remoteSeek while casting still maps through the local file offset to the receiver", async () => {
      jest.mocked(TrackPlayer.getActiveTrackIndex).mockResolvedValue(1);
      const castClient = { seek: jest.fn().mockResolvedValue(undefined) };
      usePlaybackStore.setState({ isCasting: true, castClient } as any);

      await usePlaybackStore.getState().remoteSeek(30); // 30s into (paused local) file 2

      // Mapped to absolute 120 and routed to the RECEIVER, not the local player.
      expect(castClient.seek).toHaveBeenCalledWith({ position: 120 });
      expect(usePlaybackStore.getState().position).toBe(120);
      expect(TrackPlayer.seekTo).not.toHaveBeenCalled();
    });
  });
});
