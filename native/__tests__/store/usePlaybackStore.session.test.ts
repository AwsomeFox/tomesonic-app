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
  reconcileLinkedProgress: jest.fn(),
}));
jest.mock("../../utils/autoCreds", () => ({
  writeAutoCreds: jest.fn().mockResolvedValue(undefined),
  readAutoCreds: jest.fn().mockResolvedValue(null),
  writeAutoDownloads: jest.fn().mockResolvedValue(undefined),
  writeWidgetState: jest.fn().mockResolvedValue(undefined),
}));

import TrackPlayer from "react-native-track-player";
import { api } from "../../utils/api";
import { writeWidgetState } from "../../utils/autoCreds";
import { storage, storageHelper, secureStorage } from "../../utils/storage";
import { usePlaybackStore } from "../../store/usePlaybackStore";
import { useUserStore } from "../../store/useUserStore";
import { useDownloadStore } from "../../store/useDownloadStore";
import { reconcileLinkedProgress } from "../../utils/progressSync";

const initialPlayback = usePlaybackStore.getState();
const initialUser = useUserStore.getState();
const initialDownloads = useDownloadStore.getState();

const BASE = new Date("2026-02-01T08:00:00Z").getTime();
const mockPost = jest.mocked(api.post);
const mockGet = jest.mocked(api.get);

const CH = [
  { id: 0, title: "Chapter 1", start: 0, end: 100 },
  { id: 1, title: "Chapter 2", start: 100, end: 200 },
  { id: 2, title: "Chapter 3", start: 200, end: 300 },
];

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

describe("usePlaybackStore sessions", () => {
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
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("preparePlaybackSession", () => {
    it("builds absolute authenticated URLs and loads the queue", async () => {
      await usePlaybackStore.getState().preparePlaybackSession(serverSession());

      expect(TrackPlayer.reset).toHaveBeenCalled();
      const tracks = addedTracks();
      expect(tracks).toHaveLength(1);
      expect(tracks[0].url).toBe("https://abs.example.com/api/items/item1/file/0?token=tok");
      expect(tracks[0].title).toBe("The Hobbit");
      expect(tracks[0].artist).toBe("Tolkien");
      // Cover falls back to the server cover endpoint.
      expect(tracks[0].artwork).toContain("/api/items/item1/cover");

      const s = usePlaybackStore.getState();
      expect(s.currentSession.id).toBe("sess1");
      expect(s.duration).toBe(300);
      expect(s.chapterQueue).toBe(false);
      // Not asked to play.
      expect(TrackPlayer.play).not.toHaveBeenCalled();
      expect(s.isPlaying).toBe(false);
      // Home-screen widget + native AA resumption mirror the book (now also the
      // play state + cover for the mini-player widget).
      expect(writeWidgetState).toHaveBeenCalledWith({
        title: "The Hobbit",
        author: "Tolkien",
        itemId: "item1",
        isPlaying: false,
        coverPath: undefined,
      });
    });

    it("plays when asked and expands the player", async () => {
      await usePlaybackStore.getState().preparePlaybackSession(serverSession(), true);
      expect(TrackPlayer.play).toHaveBeenCalled();
      const s = usePlaybackStore.getState();
      expect(s.isPlaying).toBe(true);
      expect(s.isPlayerExpanded).toBe(true);
    });

    it("while casting, playWhenReady does NOT start the local player", async () => {
      usePlaybackStore.getState().setCastState({ play: jest.fn(), pause: jest.fn() });
      await usePlaybackStore.getState().preparePlaybackSession(serverSession(), true);
      expect(TrackPlayer.play).not.toHaveBeenCalled();
      expect(usePlaybackStore.getState().isPlaying).toBe(true);
    });

    it("builds a chapter queue for single-file books with chapters", async () => {
      await usePlaybackStore
        .getState()
        .preparePlaybackSession(serverSession({ chapters: CH, currentTime: 150 }));

      const tracks = addedTracks();
      expect(tracks).toHaveLength(3);
      expect(tracks[0]).toMatchObject({
        title: "Chapter 1",
        mediaId: "sess1_ch0",
        clipStartMs: 0,
        clipEndMs: 100_000,
        duration: 100,
      });
      expect(tracks[2].clipStartMs).toBe(200_000);
      // Resume position 150 maps into chapter 2, 50s in.
      expect(TrackPlayer.skip).toHaveBeenCalledWith(1);
      expect(TrackPlayer.seekTo).toHaveBeenCalledWith(50);

      const s = usePlaybackStore.getState();
      expect(s.chapterQueue).toBe(true);
      expect(s.position).toBe(150);
    });

    it("multi-file books keep a file-per-item queue even with chapters", async () => {
      await usePlaybackStore.getState().preparePlaybackSession(
        serverSession({
          chapters: CH,
          currentTime: 250,
          audioTracks: [
            { index: 0, contentUrl: "/f0.mp3", duration: 150, startOffset: 0 },
            { index: 1, contentUrl: "/f1.mp3", duration: 150, startOffset: 150 },
          ],
        })
      );

      const tracks = addedTracks();
      expect(tracks).toHaveLength(2);
      expect(tracks[0].clipStartMs).toBeUndefined();
      expect(usePlaybackStore.getState().chapterQueue).toBe(false);
      // RNTP positions are TRACK-relative: resume position 250 maps into
      // file 2 (startOffset 150), 100s in — a raw absolute seekTo(250) would
      // clamp at the end of file 1 (the multi-file bug the E2E flow caught).
      expect(TrackPlayer.skip).toHaveBeenCalledWith(1);
      expect(TrackPlayer.seekTo).toHaveBeenCalledWith(100);
    });

    it("prefers downloaded local files over streaming URLs", async () => {
      useDownloadStore.setState({
        completedDownloads: {
          item1: {
            id: "item1",
            libraryItemId: "item1",
            status: "completed",
            localFolderPath: "file:///downloads/item1/",
            parts: [
              { id: "track_0", filename: "a.m4b", localFilePath: "/downloads/item1/a.m4b" },
            ],
          } as any,
        },
      });

      await usePlaybackStore.getState().preparePlaybackSession(serverSession());
      expect(addedTracks()[0].url).toBe("file:///downloads/item1/a.m4b");
    });

    it("prefers a downloaded EPISODE's local file (composite key) even when streaming online", async () => {
      // A podcast episode is downloaded under the composite key. The server IS
      // reachable, so the session carries STREAMING urls — but prepare must
      // resolve the episode download by its composite key and swap in the local
      // file + local cover (else the episode streams and its offline art is
      // blank).
      useDownloadStore.setState({
        completedDownloads: {
          "item1::ep1": {
            id: "item1::ep1",
            libraryItemId: "item1",
            episodeId: "ep1",
            status: "completed",
            localFolderPath: "file:///downloads/item1::ep1/",
            parts: [
              { id: "cover", filename: "cover.jpg", localFilePath: "/downloads/item1::ep1/cover.jpg" },
              { id: "track_0", filename: "ep.mp3", localFilePath: "/downloads/item1::ep1/ep.mp3" },
            ],
          } as any,
          // A same-item BOOK-style bare-key download must NOT be picked for the
          // episode (that was the bug: bare-id lookup found the wrong / no row).
          item1: {
            id: "item1",
            libraryItemId: "item1",
            status: "completed",
            localFolderPath: "file:///downloads/item1/",
            parts: [{ id: "track_0", filename: "wrong.mp3", localFilePath: "/downloads/item1/wrong.mp3" }],
          } as any,
        },
      });

      await usePlaybackStore
        .getState()
        .preparePlaybackSession(
          serverSession({ episodeId: "ep1", audioTracks: [{ index: 0, contentUrl: "/api/items/item1/file/ep0", duration: 300, startOffset: 0 }] })
        );

      const track = addedTracks()[0];
      expect(track.url).toBe("file:///downloads/item1::ep1/ep.mp3");
      // Offline art resolves to the downloaded cover FILE, not a dead server url.
      expect(track.artwork).toBe("/downloads/item1::ep1/cover.jpg");
    });

    it("maps duplicate-index tracks to their uniquified local parts positionally", async () => {
      // Bad metadata: both files claim track.index 1, so the downloader
      // collision-uniquified the second part id to track_1_1. An id-only
      // lookup resolved BOTH logical tracks to the first file.
      useDownloadStore.setState({
        completedDownloads: {
          item1: {
            id: "item1",
            libraryItemId: "item1",
            status: "completed",
            localFolderPath: "file:///downloads/item1/",
            parts: [
              // Non-track part first: the positional lookup must skip it.
              { id: "cover", filename: "cover.jpg", localFilePath: "/downloads/item1/cover.jpg" },
              { id: "track_1", filename: "a.mp3", localFilePath: "/downloads/item1/a.mp3" },
              { id: "track_1_1", filename: "b.mp3", localFilePath: "/downloads/item1/b.mp3" },
            ],
          } as any,
        },
      });

      await usePlaybackStore.getState().preparePlaybackSession(
        serverSession({
          audioTracks: [
            { index: 1, contentUrl: "/f0.mp3", duration: 150, startOffset: 0 },
            { index: 1, contentUrl: "/f1.mp3", duration: 150, startOffset: 150 },
          ],
        })
      );

      const tracks = addedTracks();
      expect(tracks).toHaveLength(2);
      expect(tracks[0].url).toBe("file:///downloads/item1/a.mp3");
      // The second logical track plays the SECOND file, not track_1 again.
      expect(tracks[1].url).toBe("file:///downloads/item1/b.mp3");
    });

    it("falls back to exact-id lookup when parts are stored out of track order", async () => {
      useDownloadStore.setState({
        completedDownloads: {
          item1: {
            id: "item1",
            libraryItemId: "item1",
            status: "completed",
            localFolderPath: "file:///downloads/item1/",
            parts: [
              { id: "track_1", filename: "b.mp3", localFilePath: "/downloads/item1/b.mp3" },
              { id: "track_0", filename: "a.mp3", localFilePath: "/downloads/item1/a.mp3" },
            ],
          } as any,
        },
      });

      await usePlaybackStore.getState().preparePlaybackSession(
        serverSession({
          audioTracks: [
            { index: 0, contentUrl: "/f0.mp3", duration: 150, startOffset: 0 },
            { index: 1, contentUrl: "/f1.mp3", duration: 150, startOffset: 150 },
          ],
        })
      );

      const tracks = addedTracks();
      // Positional candidates mismatch (track_1 at position 0), so each track
      // resolves through the exact-id find instead.
      expect(tracks[0].url).toBe("file:///downloads/item1/a.mp3");
      expect(tracks[1].url).toBe("file:///downloads/item1/b.mp3");
    });

    it("restores the persisted global playback rate", async () => {
      storageHelper.setPlaybackRate(1.75);
      await usePlaybackStore.getState().preparePlaybackSession(serverSession());
      expect(TrackPlayer.setRate).toHaveBeenCalledWith(1.75);
      expect(usePlaybackStore.getState().playbackSpeed).toBe(1.75);
    });

    describe("freshest-wins resume", () => {
      it("resumes from the local save when it is meaningfully newer than the server's progress", async () => {
        // Offline listening reached 250s; the server still thinks 100s.
        storageHelper.setLastPlaybackSession({
          id: "old-sess",
          libraryItemId: "item1",
          currentTime: 250,
          updatedAt: BASE, // fresh local write
        });
        useUserStore.setState({
          mediaProgress: {
            item1: { libraryItemId: "item1", currentTime: 100, lastUpdate: BASE - 60_000 },
          },
        } as any);

        await usePlaybackStore.getState().preparePlaybackSession(serverSession({ currentTime: 100 }));

        expect(TrackPlayer.seekTo).toHaveBeenCalledWith(250);
        const s = usePlaybackStore.getState();
        expect(s.position).toBe(250);
        expect(s.currentSession.currentTime).toBe(250);
      });

      it("lets the server position win when its progress timestamp is newer (cross-device)", async () => {
        storageHelper.setLastPlaybackSession({
          id: "old-sess",
          libraryItemId: "item1",
          currentTime: 250,
          updatedAt: BASE - 120_000, // stale local save
        });
        useUserStore.setState({
          mediaProgress: {
            item1: { libraryItemId: "item1", currentTime: 100, lastUpdate: BASE },
          },
        } as any);

        await usePlaybackStore.getState().preparePlaybackSession(serverSession({ currentTime: 100 }));
        expect(TrackPlayer.seekTo).toHaveBeenCalledWith(100);
        expect(usePlaybackStore.getState().position).toBe(100);
      });

      it("a local save beats a server we know nothing about", async () => {
        storageHelper.setLastPlaybackSession({
          id: "old-sess",
          libraryItemId: "item1",
          currentTime: 42,
          updatedAt: BASE,
        });
        // No mediaProgress entry at all → serverUpdatedAt falls back to 0.
        await usePlaybackStore.getState().preparePlaybackSession(serverSession({ currentTime: 0 }));
        expect(TrackPlayer.seekTo).toHaveBeenCalledWith(42);
      });

      it("ignores a saved session for a different book", async () => {
        storageHelper.setLastPlaybackSession({
          id: "other",
          libraryItemId: "other-item",
          currentTime: 250,
          updatedAt: BASE,
        });
        await usePlaybackStore.getState().preparePlaybackSession(serverSession({ currentTime: 10 }));
        expect(TrackPlayer.seekTo).toHaveBeenCalledWith(10);
      });
    });
  });

  describe("startPlayback", () => {
    it("POSTs a play session and prepares it", async () => {
      mockPost.mockResolvedValue({ data: serverSession() } as any);

      const ok = await usePlaybackStore.getState().startPlayback("item1");

      expect(ok).toBe(true);
      expect(mockPost).toHaveBeenCalledWith(
        "/api/items/item1/play",
        expect.objectContaining({ mediaPlayer: "react-native-track-player" })
      );
      expect(usePlaybackStore.getState().currentSession.id).toBe("sess1");
      expect(usePlaybackStore.getState().isPlaying).toBe(true);
      // Records the listen interaction for the item detail screen.
      expect(storage.getString("last_interaction_item1")).toBe("listen");
    });

    it("uses the episode play endpoint for podcasts", async () => {
      mockPost.mockResolvedValue({
        data: serverSession({ id: "sess2", libraryItemId: "pod1", episodeId: "ep1" }),
      } as any);
      await usePlaybackStore.getState().startPlayback("pod1", "ep1");
      expect(mockPost).toHaveBeenCalledWith("/api/items/pod1/play/ep1", expect.anything());
    });

    it("dedupes rapid duplicate calls (Android Auto double-dispatch)", async () => {
      mockPost.mockResolvedValue({ data: serverSession() } as any);

      const first = await usePlaybackStore.getState().startPlayback("item1");
      const second = await usePlaybackStore.getState().startPlayback("item1");

      expect(first).toBe(true);
      expect(second).toBe(false);
      expect(mockPost).toHaveBeenCalledTimes(1);

      // After the 2s window a deliberate re-tap goes through.
      jest.setSystemTime(BASE + 3_000);
      const third = await usePlaybackStore.getState().startPlayback("item1");
      expect(third).toBe(true);
      expect(mockPost).toHaveBeenCalledTimes(2);
    });

    it("different items are never deduped", async () => {
      mockPost.mockResolvedValue({ data: serverSession() } as any);
      await usePlaybackStore.getState().startPlayback("itemA");
      await usePlaybackStore.getState().startPlayback("itemB");
      expect(mockPost).toHaveBeenCalledTimes(2);
    });

    it("returns false when the session has no audio tracks", async () => {
      mockPost.mockResolvedValue({ data: serverSession({ audioTracks: [] }) } as any);
      const ok = await usePlaybackStore.getState().startPlayback("item-ebook");
      expect(ok).toBe(false);
      expect(TrackPlayer.add).not.toHaveBeenCalled();
    });

    describe("offline fallback", () => {
      const downloaded = {
        id: "item1",
        libraryItemId: "item1",
        title: "The Hobbit",
        author: "Tolkien",
        coverUrl: "file:///downloads/item1/cover.jpg",
        status: "completed",
        localFolderPath: "file:///downloads/item1/",
        parts: [{ id: "track_0", filename: "a.m4b", localFilePath: "/downloads/item1/a.m4b" }],
        meta: {
          duration: 300,
          chapters: CH,
          tracks: [{ index: 0, filename: "a.m4b", duration: 300, startOffset: 0 }],
        },
      } as any;

      it("builds a local session from the download when the server is unreachable", async () => {
        mockPost.mockRejectedValue(new Error("Network Error"));
        useDownloadStore.setState({ completedDownloads: { item1: downloaded } });
        useUserStore.setState({
          mediaProgress: { item1: { libraryItemId: "item1", currentTime: 42 } },
        } as any);

        const ok = await usePlaybackStore.getState().startPlayback("item1");

        expect(ok).toBe(true);
        const s = usePlaybackStore.getState();
        expect(s.currentSession.id).toBe("local_item1");
        expect(s.duration).toBe(300);
        // Resumes from the last known local progress.
        expect(s.position).toBe(42);
        expect(s.chapterQueue).toBe(true); // meta chapters + 1 track
        // The queue is built from on-device files.
        expect(addedTracks()[0].url).toBe("file:///downloads/item1/a.m4b");
      });

      it("does not fall back for ebook-only downloads (no audio tracks)", async () => {
        mockPost.mockRejectedValue(new Error("Network Error"));
        useDownloadStore.setState({
          completedDownloads: {
            item1: { ...downloaded, meta: { duration: 0, chapters: [], tracks: [] } },
          },
        });
        const ok = await usePlaybackStore.getState().startPlayback("item1");
        expect(ok).toBe(false);
        expect(TrackPlayer.add).not.toHaveBeenCalled();
      });

      it("does not fall back for a non-downloaded podcast episode", async () => {
        // Only the BOOK-style bare-key download exists — an episode play must
        // not resolve it (episodes live under the composite key).
        mockPost.mockRejectedValue(new Error("Network Error"));
        useDownloadStore.setState({ completedDownloads: { item1: downloaded } });
        const ok = await usePlaybackStore.getState().startPlayback("item1", "ep1");
        expect(ok).toBe(false);
      });

      it("builds a local session from a DOWNLOADED episode (composite key)", async () => {
        // Past the 2s duplicate-start window: a sibling test starts the same
        // item1/ep1 at BASE, and the dedupe guard is module-scoped (not store
        // state) so it survives the per-test reset.
        jest.setSystemTime(BASE + 10_000);
        mockPost.mockRejectedValue(new Error("Network Error"));
        const epDownload = {
          id: "item1::ep1",
          libraryItemId: "item1",
          episodeId: "ep1",
          title: "Episode One",
          author: "Podcaster",
          coverUrl: "file:///downloads/item1::ep1/cover.jpg",
          status: "completed",
          localFolderPath: "file:///downloads/item1::ep1/",
          // A real download's part.localFilePath and localFolderPath+filename
          // resolve to the SAME on-device file. preparePlaybackSession now
          // resolves the episode download by its composite key too (so the
          // ONLINE path uses the local file / offline cover instead of
          // streaming), which means its canonical localForTrack resolution
          // (part.localFilePath first) also applies to this offline session —
          // hence the part path must match the folder path.
          parts: [{ id: "track_0", filename: "track_0.mp3", localFilePath: "/downloads/item1::ep1/track_0.mp3" }],
          meta: {
            duration: 1800,
            chapters: [],
            tracks: [{ index: 0, filename: "track_0.mp3", duration: 1800, startOffset: 0 }],
          },
        } as any;
        useDownloadStore.setState({ completedDownloads: { "item1::ep1": epDownload } });
        // Episode progress lives under the composite `${itemId}-${episodeId}` key.
        useUserStore.setState({
          mediaProgress: { "item1-ep1": { libraryItemId: "item1", episodeId: "ep1", currentTime: 90 } },
        } as any);

        const ok = await usePlaybackStore.getState().startPlayback("item1", "ep1");

        expect(ok).toBe(true);
        const s = usePlaybackStore.getState();
        expect(s.currentSession.id).toBe("local_item1::ep1");
        expect(s.currentSession.episodeId).toBe("ep1");
        expect(s.duration).toBe(1800);
        expect(s.position).toBe(90); // resumes from the composite-keyed progress
        // Queue built from the on-device episode file.
        expect(addedTracks()[0].url).toBe("file:///downloads/item1::ep1/track_0.mp3");
      });

      it("returns false when nothing is downloaded", async () => {
        mockPost.mockRejectedValue(new Error("Network Error"));
        const ok = await usePlaybackStore.getState().startPlayback("item-not-downloaded");
        expect(ok).toBe(false);
      });
    });
  });

  describe("loadLastSession", () => {
    it("does nothing without an authenticated server config", async () => {
      secureStorage.remove("serverConfig");
      storageHelper.setLastPlaybackSession({ id: "sess1", libraryItemId: "item1" });

      await usePlaybackStore.getState().loadLastSession();
      expect(mockGet).not.toHaveBeenCalled();
      expect(usePlaybackStore.getState().currentSession).toBeNull();
    });

    it("does nothing when no session was saved", async () => {
      await usePlaybackStore.getState().loadLastSession();
      expect(usePlaybackStore.getState().currentSession).toBeNull();
    });

    it("never restores over a LIVE session — reopening the app paused background playback", async () => {
      // Android reclaims the Activity while the foreground service keeps
      // playing; reopening remounts App.tsx on the living JS context and its
      // init re-runs loadLastSession. Restoring here reset the live queue and
      // re-prepared it paused — playback stopped the moment the app opened.
      storageHelper.setLastPlaybackSession({
        ...serverSession(),
        currentTime: 100,
        updatedAt: BASE,
      });
      usePlaybackStore.setState({
        currentSession: { id: "sess-live", libraryItemId: "item1" },
        isPlaying: true,
        position: 555,
      } as any);

      await usePlaybackStore.getState().loadLastSession();

      const s = usePlaybackStore.getState();
      expect(s.currentSession.id).toBe("sess-live");
      expect(s.isPlaying).toBe(true);
      expect(s.position).toBe(555);
      expect(TrackPlayer.reset).not.toHaveBeenCalled();
      expect(mockGet).not.toHaveBeenCalled();
    });

    it("bails if a book was tapped during the freshness GET (TOCTOU — must not clobber the live session)", async () => {
      // The top-of-function live-session guard runs BEFORE the up-to-3s
      // server-progress GET. A cold-start user tapping a book in that window
      // starts a real session while loadLastSession is blocked; restoring the
      // saved session over it would TrackPlayer.reset() the live queue and
      // re-prepare it paused. Simulate the tap landing as the GET resolves.
      storageHelper.setLastPlaybackSession({
        ...serverSession(),
        currentTime: 100,
        updatedAt: BASE - 60_000,
      });
      mockGet.mockImplementation(async () => {
        usePlaybackStore.setState({
          currentSession: { id: "tapped-sess", libraryItemId: "tapped" },
          isPlaying: true,
          position: 42,
        } as any);
        return { data: { currentTime: 222, lastUpdate: BASE } } as any;
      });

      await usePlaybackStore.getState().loadLastSession();

      const s = usePlaybackStore.getState();
      expect(s.currentSession.id).toBe("tapped-sess"); // freshly tapped session untouched
      expect(s.position).toBe(42);
      expect(TrackPlayer.reset).not.toHaveBeenCalled(); // saved session never prepared
    });

    it("restores the saved session paused", async () => {
      storageHelper.setLastPlaybackSession({
        ...serverSession(),
        currentTime: 100,
        updatedAt: BASE,
      });
      mockGet.mockRejectedValue(new Error("offline")); // server check fails → local stands

      await usePlaybackStore.getState().loadLastSession();

      const s = usePlaybackStore.getState();
      expect(s.currentSession.id).toBe("sess1");
      expect(s.position).toBe(100);
      expect(s.isPlaying).toBe(false);
      expect(TrackPlayer.play).not.toHaveBeenCalled();
    });

    it("adopts the server position when another device listened further", async () => {
      storageHelper.setLastPlaybackSession({
        ...serverSession(),
        currentTime: 100,
        updatedAt: BASE - 60_000,
      });
      mockGet.mockResolvedValue({ data: { currentTime: 222, lastUpdate: BASE } } as any);
      // Keep prepare()'s own freshest-wins from re-preferring the stale local save.
      useUserStore.setState({
        mediaProgress: { item1: { libraryItemId: "item1", currentTime: 222, lastUpdate: BASE } },
      } as any);

      await usePlaybackStore.getState().loadLastSession();

      expect(mockGet).toHaveBeenCalledWith("/api/me/progress/item1");
      expect(usePlaybackStore.getState().position).toBe(222);
    });

    it("hits the composite EPISODE progress endpoint for a restored podcast-episode session", async () => {
      // Podcast progress is keyed per episode server-side, so an episode
      // session must GET /api/me/progress/{itemId}/{episodeId}, not the
      // item-only URL (which returns nothing useful for the episode).
      storageHelper.setLastPlaybackSession({
        ...serverSession({ episodeId: "ep1" }),
        currentTime: 100,
        updatedAt: BASE - 60_000,
      });
      mockGet.mockResolvedValue({ data: { currentTime: 100, lastUpdate: BASE - 120_000 } } as any);

      await usePlaybackStore.getState().loadLastSession();

      expect(mockGet).toHaveBeenCalledWith("/api/me/progress/item1/ep1");
      expect(mockGet).not.toHaveBeenCalledWith("/api/me/progress/item1");
    });

    it("re-persists the adopted server position so prepare's freshest-wins can't reverse it", async () => {
      // Server is fresher by >10s AND >2s ahead: the adopted position must be
      // written back to the MMKV save, because preparePlaybackSession re-reads
      // that save and would otherwise re-prefer the stale local one.
      storageHelper.setLastPlaybackSession({
        ...serverSession(),
        currentTime: 100,
        updatedAt: BASE - 60_000,
      });
      mockGet.mockResolvedValue({ data: { currentTime: 222, lastUpdate: BASE } } as any);
      useUserStore.setState({
        mediaProgress: { item1: { libraryItemId: "item1", currentTime: 222, lastUpdate: BASE } },
      } as any);
      const setLast = jest.spyOn(storageHelper, "setLastPlaybackSession");

      await usePlaybackStore.getState().loadLastSession();

      expect(setLast).toHaveBeenCalledWith(
        expect.objectContaining({ currentTime: 222, updatedAt: BASE })
      );
      expect(usePlaybackStore.getState().position).toBe(222);
      setLast.mockRestore();
    });

    it("keeps the local position when the server progress is older", async () => {
      storageHelper.setLastPlaybackSession({
        ...serverSession(),
        currentTime: 100,
        updatedAt: BASE,
      });
      mockGet.mockResolvedValue({ data: { currentTime: 50, lastUpdate: BASE - 60_000 } } as any);

      await usePlaybackStore.getState().loadLastSession();
      expect(usePlaybackStore.getState().position).toBe(100);
    });
  });

  // LOCK ("Link reading & listening"): closing an audio session for a linked
  // item reconciles the OTHER medium up to the just-closed listening position.
  // The gating/furthest-wins logic is unit-tested in progressSync; here we only
  // assert the WIRING at the close boundary.
  describe("lock reconciliation on audio session close", () => {
    it("reconciles the ebook to the final audio fraction on closePlayback", async () => {
      (reconcileLinkedProgress as jest.Mock).mockClear();
      jest
        .mocked(TrackPlayer.getProgress)
        .mockResolvedValue({ position: 150, duration: 300, buffered: 0 } as any);
      usePlaybackStore.setState({
        isInitialized: true,
        currentSession: { id: "sess1", libraryItemId: "item1" },
        duration: 300,
        position: 150,
        isPlaying: true,
      } as any);

      await usePlaybackStore.getState().closePlayback();

      // 150 / 300 = 0.5, with the duration carried for the audio currentTime write.
      expect(reconcileLinkedProgress).toHaveBeenCalledWith(
        "item1",
        expect.objectContaining({ audioFraction: 0.5, duration: 300 })
      );
    });

    it("does NOT reconcile for a podcast episode session (books only)", async () => {
      (reconcileLinkedProgress as jest.Mock).mockClear();
      jest
        .mocked(TrackPlayer.getProgress)
        .mockResolvedValue({ position: 30, duration: 300, buffered: 0 } as any);
      usePlaybackStore.setState({
        isInitialized: true,
        currentSession: { id: "sess2", libraryItemId: "pod1", episodeId: "ep1" },
        duration: 300,
        position: 30,
        isPlaying: true,
      } as any);

      await usePlaybackStore.getState().closePlayback();

      expect(reconcileLinkedProgress).not.toHaveBeenCalled();
    });
  });
});
