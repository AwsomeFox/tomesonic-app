/**
 * REGRESSION: missing notification album art.
 *
 * Media3 fetches the artwork URL NATIVELY — no axios interceptor, no token
 * refresh — so any cover URL carrying a stale baked-in token silently 401s
 * and the notification renders without art. Three paths used to do that:
 *  1. restored MMKV sessions carry the token that was current at save time,
 *     and prepare() PREFERRED that stale URL over rebuilding;
 *  2. downloaded books pointed artwork at the REMOTE cover URL (stale token
 *     + dead offline) instead of the downloaded cover file;
 *  3. a mid-session token rotation left the live notification's artwork URL
 *     pointing at the rotated-out token.
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
import { api } from "../../utils/api";
import { storage, storageHelper, secureStorage } from "../../utils/storage";
import { usePlaybackStore, refreshNowPlayingArtwork } from "../../store/usePlaybackStore";
import { useUserStore } from "../../store/useUserStore";
import { useDownloadStore } from "../../store/useDownloadStore";

const initialPlayback = usePlaybackStore.getState();
const initialUser = useUserStore.getState();
const initialDownloads = useDownloadStore.getState();
const mockPost = jest.mocked(api.post);

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

describe("notification artwork sources", () => {
  beforeEach(() => {
    // Fake timers: preparePlaybackSession starts the store's 1s progress
    // interval, which would otherwise hold the jest process open forever.
    jest.useFakeTimers();
    usePlaybackStore.setState(initialPlayback, true);
    useUserStore.setState(initialUser, true);
    useDownloadStore.setState(initialDownloads, true);
    useDownloadStore.setState({ activeDownloads: {}, completedDownloads: {} });
    storage.getAllKeys().forEach((k) => storage.remove(k));
    secureStorage.getAllKeys().forEach((k) => secureStorage.remove(k));
    storageHelper.setServerConfig({ address: "https://abs.example.com/", token: "tok_CURRENT" });
    jest.mocked(TrackPlayer.getActiveTrackIndex).mockResolvedValue(0);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("builds artwork with the CURRENT token even when the restored session carries a stale one", async () => {
    // A session restored from MMKV embeds the token that was current when it
    // was saved — after a rotation that URL 401s natively.
    await usePlaybackStore.getState().preparePlaybackSession(
      serverSession({
        coverUrl: "https://abs.example.com/api/items/item1/cover?width=800&format=webp&token=tok_OLD",
      }),
      false
    );

    const art = addedTracks()[0].artwork as string;
    expect(art).toContain("token=tok_CURRENT");
    expect(art).not.toContain("tok_OLD");
    expect(usePlaybackStore.getState().currentSession.coverUrl).toContain("token=tok_CURRENT");
  });

  it("prefers the DOWNLOADED cover file over any remote URL", async () => {
    useDownloadStore.setState({
      completedDownloads: {
        item1: {
          id: "item1",
          status: "completed",
          localFolderPath: "file:///docs/downloads/item1_book/",
          parts: [
            { id: "cover", filename: "cover.jpg", localFilePath: "file:///docs/downloads/item1_book/cover.jpg", completed: true },
          ],
          meta: { duration: 300, chapters: [], tracks: [] },
        } as any,
      },
    });

    await usePlaybackStore.getState().preparePlaybackSession(serverSession(), false);

    expect(addedTracks()[0].artwork).toBe("file:///docs/downloads/item1_book/cover.jpg");
  });

  it("offline fallback sessions use the downloaded cover file, not the remote URL", async () => {
    mockPost.mockRejectedValue(new Error("offline"));
    useDownloadStore.setState({
      completedDownloads: {
        item1: {
          id: "item1",
          title: "The Hobbit",
          author: "Tolkien",
          status: "completed",
          coverUrl: "https://abs.example.com/api/items/item1/cover?token=tok_DOWNLOADTIME",
          localFolderPath: "file:///docs/downloads/item1_book/",
          parts: [
            { id: "cover", filename: "cover.jpg", localFilePath: "file:///docs/downloads/item1_book/cover.jpg", completed: true },
            { id: "track_0", filename: "track_0.mp3", localFilePath: "file:///docs/downloads/item1_book/track_0.mp3", completed: true },
          ],
          meta: {
            duration: 300,
            chapters: [],
            tracks: [{ index: 0, filename: "track_0.mp3", duration: 300, startOffset: 0 }],
          },
        } as any,
      },
    });

    const ok = await usePlaybackStore.getState().startPlayback("item1");

    expect(ok).toBe(true);
    expect(usePlaybackStore.getState().currentSession.coverUrl).toBe(
      "file:///docs/downloads/item1_book/cover.jpg"
    );
  });

  describe("refreshNowPlayingArtwork (mid-session token rotation)", () => {
    it("swaps the rotated-out token for the current one on the live session", () => {
      usePlaybackStore.setState({
        currentSession: {
          id: "sess1",
          libraryItemId: "item1",
          coverUrl: "https://abs.example.com/api/items/item1/cover?width=800&token=tok_OLD",
        },
      } as any);
      storageHelper.setServerConfig({ address: "https://abs.example.com/", token: "tok_NEW" });

      refreshNowPlayingArtwork();

      expect(usePlaybackStore.getState().currentSession.coverUrl).toBe(
        "https://abs.example.com/api/items/item1/cover?width=800&token=tok_NEW"
      );
    });

    it("leaves local-file artwork alone", () => {
      usePlaybackStore.setState({
        currentSession: { id: "sess1", coverUrl: "file:///docs/downloads/item1/cover.jpg" },
      } as any);

      refreshNowPlayingArtwork();

      expect(usePlaybackStore.getState().currentSession.coverUrl).toBe(
        "file:///docs/downloads/item1/cover.jpg"
      );
    });

    it("no-ops when there is no session", () => {
      usePlaybackStore.setState({ currentSession: null } as any);
      expect(() => refreshNowPlayingArtwork()).not.toThrow();
    });
  });
});
