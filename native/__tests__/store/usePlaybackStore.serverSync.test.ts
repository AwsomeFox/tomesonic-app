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
    jest.mocked(TrackPlayer.getActiveTrackIndex).mockResolvedValue(0 as any);
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

    it("does NOT adopt when the server is newer but within the freshness margin (unsynced-local safety)", async () => {
      setupLocal();
      storageHelper.setLastPlaybackSession({ libraryItemId: "item1", updatedAt: BASE });
      // Newer than local by only 5s (< 10s margin) — could be an in-flight sync
      // race; local unsynced progress must not be clobbered.
      mockGet.mockResolvedValue({ data: { currentTime: 500, lastUpdate: BASE + 5_000 } } as any);

      const r = await usePlaybackStore.getState().syncPositionFromServer();

      expect(r.status).toBe("up-to-date");
      expect(TrackPlayer.seekTo).not.toHaveBeenCalled();
    });

    it("maps the live absolute position through the ACTIVE chapter for the freshest-wins epsilon", async () => {
      setupLocal({
        chapterQueue: true,
        chapters: [
          { start: 0, end: 300 },
          { start: 300, end: 600 },
        ],
      });
      storageHelper.setLastPlaybackSession({ libraryItemId: "item1", updatedAt: BASE - 60_000 });
      jest.mocked(TrackPlayer.getActiveTrackIndex).mockResolvedValue(1 as any);
      jest.mocked(TrackPlayer.getProgress).mockResolvedValue({ position: 50, duration: 300, buffered: 0 } as any);
      // Mapped live position = chapters[1].start(300) + 50 = 350. Server is newer
      // but only 1s ahead of the MAPPED position → within epsilon → no adopt.
      // (A naive use of the raw store position 100 would wrongly adopt.)
      mockGet.mockResolvedValue({ data: { currentTime: 351, lastUpdate: BASE } } as any);

      const r = await usePlaybackStore.getState().syncPositionFromServer();

      expect(r.status).toBe("up-to-date");
      expect(TrackPlayer.seekTo).not.toHaveBeenCalled();
    });

    it("adopts and seeks for a fresher podcast-episode server position", async () => {
      setupLocal({ currentSession: { id: "s", libraryItemId: "item1", episodeId: "ep1" } });
      storageHelper.setLastPlaybackSession({
        libraryItemId: "item1",
        episodeId: "ep1",
        updatedAt: BASE - 60_000,
      });
      mockGet.mockResolvedValue({ data: { currentTime: 400, lastUpdate: BASE } } as any);

      const r = await usePlaybackStore.getState().syncPositionFromServer();

      expect(mockGet).toHaveBeenCalledWith("/api/me/progress/item1/ep1");
      expect(r).toEqual({ status: "adopted", position: 400 });
      expect(TrackPlayer.seekTo).toHaveBeenCalledWith(400);
    });

    it("reports no-session when the session has no item id", async () => {
      setupLocal({ currentSession: { id: "s" } });

      const r = await usePlaybackStore.getState().syncPositionFromServer();

      expect(r.status).toBe("no-session");
      expect(mockGet).not.toHaveBeenCalled();
    });

    it("bails to no-session when the book switches during the fetch (liveness re-check)", async () => {
      setupLocal();
      storageHelper.setLastPlaybackSession({ libraryItemId: "item1", updatedAt: BASE - 60_000 });
      mockGet.mockImplementation(async () => {
        usePlaybackStore.setState({ currentSession: { id: "s2", libraryItemId: "item2" } } as any);
        return { data: { currentTime: 500, lastUpdate: BASE } } as any;
      });

      const r = await usePlaybackStore.getState().syncPositionFromServer();

      expect(r.status).toBe("no-session");
      expect(TrackPlayer.seekTo).not.toHaveBeenCalled();
    });

    it("bails to no-session when the podcast EPISODE switches during the fetch (same item id)", async () => {
      setupLocal({ currentSession: { id: "s", libraryItemId: "item1", episodeId: "epA" } });
      storageHelper.setLastPlaybackSession({
        libraryItemId: "item1",
        episodeId: "epA",
        updatedAt: BASE - 60_000,
      });
      // The item id is unchanged (epA→epB share item1); only the episode moved.
      mockGet.mockImplementation(async () => {
        usePlaybackStore.setState({
          currentSession: { id: "s2", libraryItemId: "item1", episodeId: "epB" },
        } as any);
        return { data: { currentTime: 500, lastUpdate: BASE } } as any;
      });

      const r = await usePlaybackStore.getState().syncPositionFromServer();

      expect(r.status).toBe("no-session");
      expect(TrackPlayer.seekTo).not.toHaveBeenCalled();
    });

    it("does not issue the GET when the connectivity pre-check reports offline", async () => {
      setupLocal();
      storageHelper.setLastPlaybackSession({ libraryItemId: "item1", updatedAt: BASE - 60_000 });
      const NetInfo = require("@react-native-community/netinfo").default;
      jest
        .mocked(NetInfo.fetch)
        .mockResolvedValueOnce({ isConnected: false, isInternetReachable: false } as any);

      const r = await usePlaybackStore.getState().syncPositionFromServer();

      expect(r.status).toBe("unavailable");
      expect(mockGet).not.toHaveBeenCalled();
    });

    it("reports unavailable when the server returns no usable progress row", async () => {
      setupLocal();
      storageHelper.setLastPlaybackSession({ libraryItemId: "item1", updatedAt: BASE - 60_000 });
      mockGet.mockResolvedValue({ data: {} } as any); // no currentTime field

      const r = await usePlaybackStore.getState().syncPositionFromServer();

      expect(r.status).toBe("unavailable");
      expect(TrackPlayer.seekTo).not.toHaveBeenCalled();
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
      // OPTIMISTIC: audio starts first (no latency), THEN the catch-up seeks —
      // so the last seek lands on the fresher server position.
      expect(TrackPlayer.play).toHaveBeenCalled();
      expect(TrackPlayer.seekTo).toHaveBeenLastCalledWith(800);
      expect(usePlaybackStore.getState().position).toBe(800);
      expect(usePlaybackStore.getState().isPlaying).toBe(true);
    });

    it("starts audio BEFORE the server catch-up resolves (no resume latency)", async () => {
      setupLocal({ isPlaying: true });
      await usePlaybackStore.getState().pause();
      // Record call order: TrackPlayer.play must fire before the progress GET.
      const order: string[] = [];
      jest.mocked(TrackPlayer.play).mockImplementationOnce(async () => {
        order.push("play");
      });
      mockGet.mockImplementation(async () => {
        order.push("get");
        return { data: { currentTime: 800, lastUpdate: BASE + 300_000 } } as any;
      });
      jest.setSystemTime(BASE + 60_000);

      await usePlaybackStore.getState().play();

      expect(order).toEqual(["play", "get"]);
    });

    it("uses a strict pause-gap threshold — exactly 15s does not trigger, just over does", async () => {
      setupLocal({ isPlaying: true });
      await usePlaybackStore.getState().pause(); // _lastPausedAt = BASE
      mockGet.mockClear();
      jest.setSystemTime(BASE + 15_000); // exactly the threshold → NOT > threshold
      await usePlaybackStore.getState().play();
      expect(mockGet).not.toHaveBeenCalled();

      // Re-pause and cross just past the threshold.
      jest.mocked(TrackPlayer.getProgress).mockResolvedValue({ position: 100, duration: 3000, buffered: 0 } as any);
      await usePlaybackStore.getState().pause(); // _lastPausedAt = BASE + 15000
      storageHelper.setLastPlaybackSession({ libraryItemId: "item1", updatedAt: BASE - 60_000 });
      mockGet.mockResolvedValue({ data: { currentTime: 500, lastUpdate: BASE + 300_000 } } as any);
      jest.setSystemTime(BASE + 15_000 + 15_001); // gap = 15001 > threshold
      await usePlaybackStore.getState().play();
      expect(mockGet).toHaveBeenCalledWith("/api/me/progress/item1");
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
