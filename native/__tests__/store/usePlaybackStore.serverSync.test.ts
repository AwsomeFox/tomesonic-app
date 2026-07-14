/**
 * Cross-device server-position sync (issue #55 follow-up): the tablet ↔ phone
 * catch-up. Covers the manual `syncPositionFromServer()` action (adopted /
 * up-to-date / unavailable / no-session, book + podcast endpoints) and the
 * automatic pre-resume check wired into play() (gated on a real pause gap;
 * offline never blocks the resume).
 */
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
import { api } from "../../utils/api";
import { storageHelper, storage } from "../../utils/storage";

const mockGet = jest.mocked(api.get);
const initial = usePlaybackStore.getState();
const BASE = new Date("2026-01-01T12:00:00Z").getTime();

const SESSION = { id: "sess1", libraryItemId: "item1", displayTitle: "Book", displayAuthor: "Author" };

function setupLocal(over: Record<string, any> = {}) {
  usePlaybackStore.setState({
    isInitialized: true,
    currentSession: SESSION,
    duration: 3000,
    position: 100,
    chapters: [],
    chapterQueue: false,
    ...over,
  } as any);
}

describe("usePlaybackStore server-position sync", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(BASE);
    usePlaybackStore.setState(initial, true);
    storage.remove("lastPlaybackSession");
    mockGet.mockReset();
    // The live player position the freshest-wins compares the server against.
    jest.mocked(TrackPlayer.getProgress).mockResolvedValue({ position: 100, duration: 3000, buffered: 0 } as any);
    jest.mocked(TrackPlayer.seekTo).mockClear();
    jest.mocked(TrackPlayer.play).mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("syncPositionFromServer()", () => {
    it("adopts and seeks to a fresher server position (another device listened on)", async () => {
      setupLocal();
      storageHelper.setLastPlaybackSession({ libraryItemId: "item1", updatedAt: BASE - 60_000 });
      mockGet.mockResolvedValue({ data: { currentTime: 500, lastUpdate: BASE } } as any);

      const r = await usePlaybackStore.getState().syncPositionFromServer();

      expect(mockGet).toHaveBeenCalledWith("/api/me/progress/item1");
      expect(r).toEqual({ status: "adopted", position: 500 });
      expect(TrackPlayer.seekTo).toHaveBeenCalledWith(500);
      expect(usePlaybackStore.getState().position).toBe(500);
    });

    it("reports up-to-date and never seeks when the server is not fresher", async () => {
      setupLocal();
      storageHelper.setLastPlaybackSession({ libraryItemId: "item1", updatedAt: BASE });
      // Server progress is OLDER than this device's last save — local wins.
      mockGet.mockResolvedValue({ data: { currentTime: 500, lastUpdate: BASE - 60_000 } } as any);

      const r = await usePlaybackStore.getState().syncPositionFromServer();

      expect(r.status).toBe("up-to-date");
      expect(TrackPlayer.seekTo).not.toHaveBeenCalled();
    });

    it("reports up-to-date when the position barely differs (within epsilon)", async () => {
      setupLocal();
      storageHelper.setLastPlaybackSession({ libraryItemId: "item1", updatedAt: BASE - 60_000 });
      // Newer timestamp but only ~1s ahead of the live position (100) — no seek.
      mockGet.mockResolvedValue({ data: { currentTime: 101, lastUpdate: BASE } } as any);

      const r = await usePlaybackStore.getState().syncPositionFromServer();

      expect(r.status).toBe("up-to-date");
      expect(TrackPlayer.seekTo).not.toHaveBeenCalled();
    });

    it("reports unavailable when the server is unreachable (offline)", async () => {
      setupLocal();
      storageHelper.setLastPlaybackSession({ libraryItemId: "item1", updatedAt: BASE - 60_000 });
      mockGet.mockRejectedValue(new Error("offline"));

      const r = await usePlaybackStore.getState().syncPositionFromServer();

      expect(r.status).toBe("unavailable");
      expect(TrackPlayer.seekTo).not.toHaveBeenCalled();
    });

    it("reports up-to-date without hitting the network when there is no local stamp to compare against", async () => {
      // No on-disk save and no session.updatedAt → we cannot prove the server is
      // fresher, so we must NOT adopt (an ancient server row would jump backward).
      setupLocal();

      const r = await usePlaybackStore.getState().syncPositionFromServer();

      expect(r.status).toBe("up-to-date");
      expect(mockGet).not.toHaveBeenCalled();
      expect(TrackPlayer.seekTo).not.toHaveBeenCalled();
    });

    it("reports no-session and never hits the network when nothing is loaded", async () => {
      setupLocal({ currentSession: null });

      const r = await usePlaybackStore.getState().syncPositionFromServer();

      expect(r.status).toBe("no-session");
      expect(mockGet).not.toHaveBeenCalled();
    });

    it("hits the composite episode endpoint for a podcast-episode session", async () => {
      setupLocal({ currentSession: { id: "s", libraryItemId: "item1", episodeId: "ep1" } });
      storageHelper.setLastPlaybackSession({
        libraryItemId: "item1",
        episodeId: "ep1",
        updatedAt: BASE - 60_000,
      });
      mockGet.mockResolvedValue({ data: { currentTime: 10, lastUpdate: BASE - 120_000 } } as any);

      await usePlaybackStore.getState().syncPositionFromServer();

      expect(mockGet).toHaveBeenCalledWith("/api/me/progress/item1/ep1");
      expect(mockGet).not.toHaveBeenCalledWith("/api/me/progress/item1");
    });
  });

  describe("play() automatic pre-resume catch-up", () => {
    it("checks the live server position after a long pause and jumps to a fresher one", async () => {
      setupLocal({ isPlaying: true });
      await usePlaybackStore.getState().pause(); // stamps _lastPausedAt = BASE + writes the local save
      // Another device advanced well past this device's position + stamp.
      mockGet.mockResolvedValue({ data: { currentTime: 800, lastUpdate: BASE + 300_000 } } as any);
      jest.setSystemTime(BASE + 60_000); // paused 60s ≫ 15s threshold
      jest.mocked(TrackPlayer.seekTo).mockClear();

      await usePlaybackStore.getState().play();

      expect(mockGet).toHaveBeenCalledWith("/api/me/progress/item1");
      // Adopted the server position; the adopt supersedes the generic auto-rewind
      // (a single seek to exactly the other device's spot, not a nudge back).
      expect(TrackPlayer.seekTo).toHaveBeenCalledTimes(1);
      expect(TrackPlayer.seekTo).toHaveBeenCalledWith(800);
      expect(TrackPlayer.play).toHaveBeenCalled();
      expect(usePlaybackStore.getState().isPlaying).toBe(true);
    });

    it("does NOT hit the server on a quick pause/resume (below the gap threshold)", async () => {
      setupLocal({ isPlaying: true });
      await usePlaybackStore.getState().pause();
      jest.setSystemTime(BASE + 5_000); // 5s < 15s threshold
      mockGet.mockClear();

      await usePlaybackStore.getState().play();

      expect(mockGet).not.toHaveBeenCalled();
      expect(TrackPlayer.play).toHaveBeenCalled();
    });

    it("resumes normally when the pre-resume check is offline (never blocks playback)", async () => {
      setupLocal({ isPlaying: true });
      await usePlaybackStore.getState().pause();
      mockGet.mockRejectedValue(new Error("offline"));
      jest.setSystemTime(BASE + 60_000);

      await usePlaybackStore.getState().play();

      expect(TrackPlayer.play).toHaveBeenCalled();
      expect(usePlaybackStore.getState().isPlaying).toBe(true);
    });

    it("skips the server check entirely while casting", async () => {
      const client = {
        play: jest.fn().mockResolvedValue(undefined),
        pause: jest.fn().mockResolvedValue(undefined),
        seek: jest.fn().mockResolvedValue(undefined),
        setPlaybackRate: jest.fn().mockResolvedValue(undefined),
        stop: jest.fn().mockResolvedValue(undefined),
      };
      setupLocal({ isPlaying: true });
      await usePlaybackStore.getState().pause();
      usePlaybackStore.getState().setCastState(client);
      mockGet.mockClear();
      jest.setSystemTime(BASE + 60_000);

      await usePlaybackStore.getState().play();

      expect(mockGet).not.toHaveBeenCalled();
      expect(client.play).toHaveBeenCalled();
    });
  });
});
