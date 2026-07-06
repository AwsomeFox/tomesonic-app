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
import { api } from "../../utils/api";
import { closeSession, syncProgress } from "../../utils/progressSync";
import { storage, storageHelper, secureStorage } from "../../utils/storage";
import {
  usePlaybackStore,
  onPlaybackError,
  onNativeProgressSample,
  recoverPlaybackIfNeeded,
} from "../../store/usePlaybackStore";
import { useUserStore } from "../../store/useUserStore";
import { useDownloadStore } from "../../store/useDownloadStore";

const initialPlayback = usePlaybackStore.getState();
const initialUser = useUserStore.getState();
const initialDownloads = useDownloadStore.getState();

const BASE = new Date("2026-03-03T08:00:00Z").getTime();

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

function addedTracks(): any[] {
  return jest.mocked(TrackPlayer.add).mock.calls.at(-1)![0] as unknown as any[];
}

// Five-persona playback audit regressions: duration derivation, chapter
// normalization, resume mapping, session lifecycle, recovery hardening, and
// the disk-persisted progress map.
describe("usePlaybackStore audit fixes", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(BASE);
    usePlaybackStore.setState(initialPlayback, true);
    useUserStore.setState(initialUser, true);
    useDownloadStore.setState(initialDownloads, true);
    useDownloadStore.setState({ activeDownloads: {}, completedDownloads: {} });
    storage.getAllKeys().forEach((k) => storage.remove(k));
    secureStorage.getAllKeys().forEach((k) => secureStorage.remove(k));
    storageHelper.setServerConfig({ address: "https://abs.example.com", token: "tok" });
    jest.mocked(TrackPlayer.getPlaybackState).mockResolvedValue({ state: "paused" } as any);
    jest.mocked(TrackPlayer.getActiveTrackIndex).mockResolvedValue(0);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("whole-book duration derivation (false auto-finish)", () => {
    it("derives duration from summed track durations when the payload omits it", async () => {
      await usePlaybackStore.getState().preparePlaybackSession(
        serverSession({
          duration: undefined,
          audioTracks: [
            { index: 0, contentUrl: "/f0.mp3", duration: 300, startOffset: 0 },
            { index: 1, contentUrl: "/f1.mp3", duration: 300, startOffset: 300 },
          ],
        }),
        true
      );
      // A collapsed duration (300 = one file) auto-finished the book at the
      // end of file 1 and PATCHed progress:1 to the server.
      expect(usePlaybackStore.getState().duration).toBe(600);
    });

    it("ignores filtered-out garbage chapters when deriving duration", async () => {
      await usePlaybackStore.getState().preparePlaybackSession(
        serverSession({
          duration: undefined,
          chapters: [
            { id: 0, title: "c1", start: 0, end: 100 },
            // Non-finite start → excluded from playback; its huge end must
            // not inflate the book duration (auto-finish would become
            // unreachable and progress would pin near 0).
            { id: 1, title: "junk", start: "x", end: 999999 },
          ],
          audioTracks: [{ index: 0, contentUrl: "/f0.mp3", duration: undefined, startOffset: 0 }],
        }),
        true
      );
      expect(usePlaybackStore.getState().duration).toBe(100);
    });

    it("treats a negative session.duration as unknown", async () => {
      await usePlaybackStore.getState().preparePlaybackSession(
        serverSession({ duration: -5 }),
        true
      );
      expect(usePlaybackStore.getState().duration).toBe(300); // summed tracks
    });

    it("falls back to the chapter span for a single-file book", async () => {
      await usePlaybackStore.getState().preparePlaybackSession(
        serverSession({
          duration: 0,
          chapters: [
            { id: 0, title: "c1", start: 0, end: 150 },
            { id: 1, title: "c2", start: 150, end: 290 },
          ],
          audioTracks: [{ index: 0, contentUrl: "/f0.mp3", duration: undefined, startOffset: 0 }],
        }),
        true
      );
      expect(usePlaybackStore.getState().duration).toBe(290);
    });
  });

  describe("chapter normalization", () => {
    it("sorts unsorted chapters and fills gaps + the trailing tail", async () => {
      await usePlaybackStore.getState().preparePlaybackSession(
        serverSession({
          duration: 300,
          chapters: [
            // Out of order, a 20s gap after ch1, last chapter ends early.
            { id: 1, title: "Chapter 2", start: 120, end: 250 },
            { id: 0, title: "Chapter 1", start: 0, end: 100 },
          ],
        }),
        true
      );
      const st = usePlaybackStore.getState();
      expect(st.chapters.map((c: any) => c.title)).toEqual(["Chapter 1", "Chapter 2"]);
      // Gap 100→120 attributed to chapter 1; tail 250→300 to the last chapter
      // — otherwise that audio is unreachable in chapter-queue mode and the
      // auto-finish window can never be hit.
      expect(st.chapters[0].end).toBe(120);
      expect(st.chapters[1].end).toBe(300);
      const tracks = addedTracks();
      expect(tracks[0].title).toBe("Chapter 1");
      expect(tracks[1].clipEndMs).toBe(300000);
    });
  });

  describe("resume mapping", () => {
    it("a finished book resumes in the LAST chapter, not chapter 0", async () => {
      await usePlaybackStore.getState().preparePlaybackSession(
        serverSession({
          currentTime: 300, // at the very end
          chapters: [
            { id: 0, title: "c1", start: 0, end: 100 },
            { id: 1, title: "c2", start: 100, end: 200 },
            { id: 2, title: "c3", start: 200, end: 300 },
          ],
        }),
        false
      );
      // The old `-1 → 0` collapse seeked the whole book into chapter 0's clip.
      expect(jest.mocked(TrackPlayer.skip)).toHaveBeenCalledWith(2);
      expect(usePlaybackStore.getState().currentChapterIndex).toBe(2);
    });

    it("a mid-book resume maps to the owning chapter", async () => {
      await usePlaybackStore.getState().preparePlaybackSession(
        serverSession({
          currentTime: 150,
          chapters: [
            { id: 0, title: "c1", start: 0, end: 100 },
            { id: 1, title: "c2", start: 100, end: 200 },
            { id: 2, title: "c3", start: 200, end: 300 },
          ],
        }),
        false
      );
      expect(jest.mocked(TrackPlayer.skip)).toHaveBeenCalledWith(1);
      expect(usePlaybackStore.getState().currentChapterIndex).toBe(1);
    });

    it("resuming into what was a chapter GAP lands in the preceding chapter", async () => {
      await usePlaybackStore.getState().preparePlaybackSession(
        serverSession({
          currentTime: 110, // inside the original 100→120 gap
          duration: 250,
          chapters: [
            { id: 0, title: "c1", start: 0, end: 100 },
            { id: 1, title: "c2", start: 120, end: 250 },
          ],
        }),
        false
      );
      // Normalization attributed the gap to chapter 1 (end 100→120).
      expect(usePlaybackStore.getState().currentChapterIndex).toBe(0);
    });

    it("clamps a garbage past-the-end resume position", async () => {
      await usePlaybackStore.getState().preparePlaybackSession(
        serverSession({ currentTime: 99999 }),
        false
      );
      expect(usePlaybackStore.getState().position).toBe(300);
    });

    it("clamps negative and non-numeric resume positions to 0", async () => {
      await usePlaybackStore.getState().preparePlaybackSession(
        serverSession({ currentTime: -50 }),
        false
      );
      expect(usePlaybackStore.getState().position).toBe(0);

      await usePlaybackStore.getState().preparePlaybackSession(
        serverSession({ id: "sess-nan", currentTime: "abc" }),
        false
      );
      // A non-numeric string used to survive to the clamp and become NaN.
      expect(usePlaybackStore.getState().position).toBe(0);
    });

    it("adopts a meaningfully fresher SERVER position for restored sessions", async () => {
      // Another device listened further overnight; this session restore
      // carries yesterday evening's local position.
      useUserStore.setState({
        mediaProgress: {
          item1: { libraryItemId: "item1", currentTime: 200, lastUpdate: BASE - 1000 },
        },
      });
      await usePlaybackStore.getState().preparePlaybackSession(
        serverSession({ currentTime: 50, updatedAt: BASE - 60 * 60 * 1000 }),
        false
      );
      expect(usePlaybackStore.getState().position).toBe(200);
    });
  });

  describe("session lifecycle", () => {
    it("switching books closes the previous server session with its unsynced time", async () => {
      await usePlaybackStore.getState().preparePlaybackSession(serverSession(), true);
      // Accrue ~2s of UNSYNCED listening time via native samples: the first
      // sample fires the baseline 15s sync (fresh session), so accrue after
      // it. Put the live player at 42s so the close carries the real position.
      onNativeProgressSample({ position: 39, duration: 300 });
      jest.setSystemTime(BASE + 1000);
      onNativeProgressSample({ position: 40, duration: 300 }); // baseline sync consumes 1s
      jest.setSystemTime(BASE + 3000);
      onNativeProgressSample({ position: 42, duration: 300 }); // +2s, stays accumulated
      jest
        .mocked(TrackPlayer.getProgress)
        .mockResolvedValue({ position: 42, duration: 300, buffered: 0 } as any);
      jest.mocked(closeSession).mockClear();

      await usePlaybackStore
        .getState()
        .preparePlaybackSession(serverSession({ id: "sess2", libraryItemId: "item2" }), true);

      // Book switches used to leak the old ABS /play session forever and drop
      // up to 15s of accumulated listening stats.
      expect(closeSession).toHaveBeenCalledTimes(1);
      const payload = jest.mocked(closeSession).mock.calls[0][0] as any;
      expect(payload).toMatchObject({ sessionId: "sess1", libraryItemId: "item1" });
      expect(payload.currentTime).toBe(42);
      expect(payload.timeListened).toBeCloseTo(2, 1);
    });

    it("re-preparing the SAME session does not self-close it", async () => {
      await usePlaybackStore.getState().preparePlaybackSession(serverSession(), true);
      jest.mocked(closeSession).mockClear();
      await usePlaybackStore.getState().preparePlaybackSession(serverSession(), true);
      expect(closeSession).not.toHaveBeenCalled();
    });

    it("closePlayback removes the crash-restore save before the network close resolves", async () => {
      await usePlaybackStore.getState().preparePlaybackSession(serverSession(), true);
      usePlaybackStore.setState({ position: 42 });
      await usePlaybackStore.getState().pause(); // writes the MMKV save
      expect(storageHelper.getLastPlaybackSession()).toBeTruthy();

      // A close whose POST never resolves (process killed mid-flight) must
      // not leave the save behind — it resurrected the dismissed session.
      let resolveClose: () => void = () => {};
      jest.mocked(closeSession).mockImplementation(
        () => new Promise((res) => (resolveClose = () => res(undefined as any)))
      );
      const closing = usePlaybackStore.getState().closePlayback();
      await jest.advanceTimersByTimeAsync(0); // let closePlayback pass its position read
      expect(storageHelper.getLastPlaybackSession()).toBeNull();
      resolveClose();
      await closing;
    });

    it("a straggler native sample during a PLAYING dismiss cannot re-save the session", async () => {
      await usePlaybackStore.getState().preparePlaybackSession(serverSession(), true);
      usePlaybackStore.setState({ position: 42, isPlaying: true });

      let resolveClose: () => void = () => {};
      jest.mocked(closeSession).mockImplementation(
        () => new Promise((res) => (resolveClose = () => res(undefined as any)))
      );
      const closing = usePlaybackStore.getState().closePlayback();
      // Mid-close (during the pending network POST) a buffered native
      // progress sample lands — the drivers were disarmed synchronously, so
      // it must NOT re-write the crash-restore save that close just removed.
      onNativeProgressSample({ position: 43, duration: 300 });
      await jest.advanceTimersByTimeAsync(0);
      expect(storageHelper.getLastPlaybackSession()).toBeNull();
      resolveClose();
      await closing;
      expect(storageHelper.getLastPlaybackSession()).toBeNull();
    });
  });

  describe("recovery hardening", () => {
    it("play() still resumes when the auto-rewind seek throws on a dead player", async () => {
      await usePlaybackStore.getState().preparePlaybackSession(serverSession(), true);
      await usePlaybackStore.getState().pause(); // arms _lastPausedAt
      jest.setSystemTime(BASE + 60 * 60 * 1000); // away 1h → 20s rewind due

      // Player is errored: state Error, and seeks reject.
      jest.mocked(TrackPlayer.getPlaybackState).mockResolvedValue({ state: "error" } as any);
      jest.mocked(TrackPlayer.seekTo).mockRejectedValueOnce(new Error("player idle"));
      jest.mocked(TrackPlayer.retry).mockClear().mockResolvedValue(undefined);
      jest.mocked(TrackPlayer.play).mockClear();

      await usePlaybackStore.getState().play();
      // The throwing rewind used to abort everything: no retry, no play, and
      // a stranded pause stamp that produced a bogus rewind later.
      expect(TrackPlayer.retry).toHaveBeenCalled();
      expect(TrackPlayer.play).toHaveBeenCalled();
      expect(usePlaybackStore.getState().isPlaying).toBe(true);

      // Stamp cleared: an immediate pause+play cycle gets a fresh (tiny) gap,
      // not the stale hour-old one.
      await usePlaybackStore.getState().pause();
      jest.mocked(TrackPlayer.seekTo).mockClear();
      jest.mocked(TrackPlayer.getPlaybackState).mockResolvedValue({ state: "paused" } as any);
      await usePlaybackStore.getState().play();
      expect(TrackPlayer.seekTo).not.toHaveBeenCalled(); // <10s away → no rewind
    });

    it("token rotation escalates recovery to a full URL rebuild instead of retrying dead URLs", async () => {
      await usePlaybackStore.getState().preparePlaybackSession(serverSession(), true);
      usePlaybackStore.setState({ position: 123 });
      jest.mocked(TrackPlayer.getPlaybackState).mockResolvedValue({ state: "error" } as any);
      onPlaybackError({ code: "http-401", message: "auth" });

      // The server rotated the token after the queue was built.
      storageHelper.setServerConfig({ address: "https://abs.example.com", token: "tok2" });
      jest.mocked(TrackPlayer.retry).mockClear();
      jest.mocked(TrackPlayer.add).mockClear();

      await recoverPlaybackIfNeeded();
      // retry() would re-open the SAME 401ing URLs forever; recovery must
      // re-prepare with fresh-token URLs at the live position instead.
      expect(TrackPlayer.retry).not.toHaveBeenCalled();
      const tracks = addedTracks();
      expect(tracks[0].url).toContain("token=tok2");
      // The rebuild must RESUME: position preserved and playback restarted —
      // a rebuild that restarted at 0 (or stayed paused) would still pass a
      // URL-only assertion.
      expect(usePlaybackStore.getState().position).toBe(123);
      expect(usePlaybackStore.getState().isPlaying).toBe(true);
    });
  });

  describe("progress-map durability", () => {
    it("re-playing a finished book keeps its finished flag on progress ticks", async () => {
      useUserStore.setState({
        mediaProgress: {
          item1: { libraryItemId: "item1", currentTime: 300, isFinished: true, lastUpdate: 1 },
        },
      });
      await usePlaybackStore.getState().preparePlaybackSession(serverSession(), true);
      usePlaybackStore.setState({ isPlaying: true });
      jest.mocked(TrackPlayer.getActiveTrack).mockResolvedValue({} as any);
      jest.mocked(TrackPlayer.getProgress).mockResolvedValue({
        position: 10,
        duration: 300,
        buffered: 0,
      } as any);
      jest.mocked(TrackPlayer.getPlaybackState).mockResolvedValue({ state: "playing" } as any);

      await jest.advanceTimersByTimeAsync(1000);
      // The per-tick write used to flip isFinished back to false while the
      // server still said finished.
      expect(useUserStore.getState().mediaProgress["item1"].isFinished).toBe(true);
    });

    it("initialize seeds mediaProgress from the disk cache (offline cold start)", async () => {
      storageHelper.setMediaProgressCache({
        item9: { libraryItemId: "item9", currentTime: 1234, updatedAt: BASE - 5000 },
      });
      secureStorage.set(
        "serverConfig",
        JSON.stringify({ address: "https://abs.example.com", token: "tok", userId: "u1" })
      );
      await useUserStore.getState().initialize();
      // Without the seed, an offline cold start had an empty map and every
      // downloaded book that wasn't the last-played session resumed at 0 —
      // then PATCHed that 0 to the server, regressing every other device.
      expect(useUserStore.getState().getMediaProgress("item9")?.currentTime).toBe(1234);
    });

    it("mediaProgress writes mirror to disk (leading-edge throttle)", async () => {
      // Move past any earlier test's throttle window (real Date.now under
      // fake timers tracks setSystemTime).
      jest.setSystemTime(BASE + 60 * 60 * 1000);
      useUserStore.setState({
        mediaProgress: { itemX: { libraryItemId: "itemX", currentTime: 77, updatedAt: BASE } },
      });
      expect(storageHelper.getMediaProgressCache().itemX?.currentTime).toBe(77);
    });

    it("a burst's FINAL state lands via the trailing flush", async () => {
      jest.setSystemTime(BASE + 2 * 60 * 60 * 1000);
      // Leading write...
      useUserStore.setState({
        mediaProgress: { itemY: { libraryItemId: "itemY", currentTime: 10, updatedAt: BASE } },
      });
      expect(storageHelper.getMediaProgressCache().itemY?.currentTime).toBe(10);
      // ...then a change INSIDE the window (a finish toggle at the end of a
      // book is exactly this shape) with nothing after it — the leading-only
      // throttle dropped it forever.
      jest.setSystemTime(BASE + 2 * 60 * 60 * 1000 + 1000);
      useUserStore.setState({
        mediaProgress: {
          itemY: { libraryItemId: "itemY", currentTime: 300, isFinished: true, updatedAt: BASE },
        },
      });
      await jest.advanceTimersByTimeAsync(3000);
      expect(storageHelper.getMediaProgressCache().itemY?.isFinished).toBe(true);
      expect(storageHelper.getMediaProgressCache().itemY?.currentTime).toBe(300);
    });
  });

  describe("sleep-timer seek interaction", () => {
    it("seeking forward past the armed chapter re-arms instead of firing mid-chapter", async () => {
      await usePlaybackStore.getState().preparePlaybackSession(
        serverSession({
          currentTime: 10,
          chapters: [
            { id: 0, title: "c1", start: 0, end: 100 },
            { id: 1, title: "c2", start: 100, end: 200 },
            { id: 2, title: "c3", start: 200, end: 300 },
          ],
        }),
        true
      );
      usePlaybackStore.getState().setSleepTimer(0, true); // end of chapter 0
      expect(usePlaybackStore.getState().sleepTimer?.chapterIdx).toBe(0);

      // "Let me find my place" nudge into chapter 2 before falling asleep —
      // this used to read as a boundary crossing and pause instantly.
      await usePlaybackStore.getState().seek(150);
      expect(usePlaybackStore.getState().sleepTimer?.chapterIdx).toBe(1);
      expect(usePlaybackStore.getState().sleepTimer).not.toBeNull();
      expect(usePlaybackStore.getState().isPlaying).toBe(true);
    });
  });
});
