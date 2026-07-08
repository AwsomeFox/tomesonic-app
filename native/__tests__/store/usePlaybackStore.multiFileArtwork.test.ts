/**
 * REGRESSION: TransactionTooLargeException on multi-FILE downloaded books.
 *
 * A downloaded book split into many per-chapter FILES builds a file-per-item
 * queue (not a chapter queue). The old code set `localArtwork = carArtworkLocal`
 * on EVERY file item, so toMediaItem inlined the ~40KB cover into each item's
 * MediaMetadata. On a many-file book, when Media3 bundles the whole Timeline
 * across the Binder to Android Auto, the ~1MB transaction limit is exceeded →
 * the queue drops / the controller crashes (exactly the chapter-queue bug, on
 * the other branch).
 *
 * Fix: mirror the chapter-queue handling. Inline artwork bytes live on the
 * ACTIVE file item ONLY. Inactive file items carry an EMPTY-STRING localArtwork
 * (which also blocks the toMediaItem `localArtwork ?: artwork` byte fallback).
 * As the active file changes at a file boundary the bytes are MOVED — stamped
 * on the newly-active item and stripped off the previous one. A single-FILE
 * book keeps carrying its one item's bytes at build time (no Timeline to
 * overflow) — behavior unchanged.
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
jest.mock("../../utils/downloader", () => ({
  downloader: {},
  autoDownloadNextAfterFinish: jest.fn().mockResolvedValue(undefined),
}));

import TrackPlayer, { State } from "react-native-track-player";
import { storage, storageHelper, secureStorage } from "../../utils/storage";
import { usePlaybackStore } from "../../store/usePlaybackStore";
import { useUserStore } from "../../store/useUserStore";
import { useDownloadStore } from "../../store/useDownloadStore";

const initialPlayback = usePlaybackStore.getState();
const initialUser = useUserStore.getState();
const initialDownloads = useDownloadStore.getState();

const COVER = "file:///docs/downloads/item1_book/cover.jpg";

function addedTracks(): any[] {
  return jest.mocked(TrackPlayer.add).mock.calls.at(-1)![0] as unknown as any[];
}

// A downloaded, MULTI-FILE (one file per chapter), CHAPTERLESS book → file
// queue mode (not chapter queue), with a local cover so carArtworkLocal is
// populated (the bytes source for the compact card).
async function prepareMultiFileBook() {
  useDownloadStore.setState({
    completedDownloads: {
      item1: {
        id: "item1",
        title: "The Hobbit",
        author: "Tolkien",
        status: "completed",
        localFolderPath: "file:///docs/downloads/item1_book/",
        parts: [
          { id: "cover", filename: "cover.jpg", localFilePath: COVER, completed: true },
          {
            id: "track_0",
            filename: "track_0.mp3",
            localFilePath: "file:///docs/downloads/item1_book/track_0.mp3",
            completed: true,
          },
          {
            id: "track_1",
            filename: "track_1.mp3",
            localFilePath: "file:///docs/downloads/item1_book/track_1.mp3",
            completed: true,
          },
        ],
        meta: {
          duration: 300,
          chapters: [],
          tracks: [
            { index: 0, filename: "track_0.mp3", duration: 150, startOffset: 0 },
            { index: 1, filename: "track_1.mp3", duration: 150, startOffset: 150 },
          ],
        },
      } as any,
    },
  });

  await usePlaybackStore.getState().preparePlaybackSession(
    {
      id: "sess1",
      libraryItemId: "item1",
      displayTitle: "The Hobbit",
      displayAuthor: "Tolkien",
      duration: 300,
      currentTime: 0,
      chapters: [],
      audioTracks: [
        { index: 0, contentUrl: "/f0.mp3", duration: 150, startOffset: 0 },
        { index: 1, contentUrl: "/f1.mp3", duration: 150, startOffset: 150 },
      ],
    },
    false
  );
}

describe("multi-file artwork: bytes on the ACTIVE file item only", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    usePlaybackStore.setState(initialPlayback, true);
    useUserStore.setState(initialUser, true);
    useDownloadStore.setState(initialDownloads, true);
    useDownloadStore.setState({ activeDownloads: {}, completedDownloads: {} });
    storage.getAllKeys().forEach((k) => storage.remove(k));
    secureStorage.getAllKeys().forEach((k) => secureStorage.remove(k));
    storageHelper.setServerConfig({ address: "https://abs.example.com", token: "tok" });
    jest.mocked(TrackPlayer.getActiveTrack).mockResolvedValue({} as any);
    jest.mocked(TrackPlayer.getPlaybackState).mockResolvedValue({ state: State.Playing } as any);
    jest.mocked(TrackPlayer.getActiveTrackIndex).mockResolvedValue(0);
    // File-relative position; the loop maps it through the track offsets.
    jest
      .mocked(TrackPlayer.getProgress)
      .mockResolvedValue({ position: 10, duration: 150, buffered: 0 });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("builds a file queue with NO inline bytes on any item (empty-string localArtwork)", async () => {
    await prepareMultiFileBook();

    // Multiple files → file queue, NOT a chapter queue.
    expect(usePlaybackStore.getState().chapterQueue).toBe(false);
    const tracks = addedTracks();
    expect(tracks).toHaveLength(2);
    // No file item carries the cover bytes at build time — that is what blew
    // the Binder limit on many-file books. Empty string, not the cover.
    for (const t of tracks) {
      expect(t.localArtwork).toBe("");
      expect(t.artwork).toBe(COVER); // full-card URI is fine on every item
    }
    // The bytes source is still available on the session for the active item.
    expect(usePlaybackStore.getState().currentSession.carArtworkLocal).toBe(COVER);
  });

  it("stamps bytes onto the ACTIVE file item on the first tick", async () => {
    await prepareMultiFileBook();
    jest.mocked(TrackPlayer.updateMetadataForTrack).mockClear();
    usePlaybackStore.setState({ isPlaying: true });

    jest.mocked(TrackPlayer.getActiveTrackIndex).mockResolvedValue(0);
    await jest.advanceTimersByTimeAsync(1000);

    // Active file 0 gets the cover bytes as localArtwork.
    expect(TrackPlayer.updateMetadataForTrack).toHaveBeenCalledWith(
      0,
      expect.objectContaining({ localArtwork: COVER })
    );
  });

  it("MOVES the bytes on a file-boundary track change: clears the old file item, stamps the new one", async () => {
    await prepareMultiFileBook();
    usePlaybackStore.setState({ isPlaying: true });

    // Tick on file 0 first so the persister marks index 0 as the byte holder.
    jest.mocked(TrackPlayer.getActiveTrackIndex).mockResolvedValue(0);
    await jest.advanceTimersByTimeAsync(1000);

    jest.mocked(TrackPlayer.updateMetadataForTrack).mockClear();

    // Cross the file boundary → RNTP reports file 1 active (chapterIndex stays
    // -1 for this chapterless book, so this move is driven purely by the
    // active-track change).
    jest.mocked(TrackPlayer.getActiveTrackIndex).mockResolvedValue(1);
    await jest.advanceTimersByTimeAsync(1000);

    const calls = jest.mocked(TrackPlayer.updateMetadataForTrack).mock.calls;
    // Previous active file (0) had its bytes STRIPPED (empty-string localArtwork).
    const clear = calls.find((c) => c[0] === 0);
    expect(clear).toBeDefined();
    expect((clear![1] as any).localArtwork).toBe("");
    // New active file (1) got the bytes.
    const set = calls.find((c) => c[0] === 1);
    expect(set).toBeDefined();
    expect((set![1] as any).localArtwork).toBe(COVER);
  });
});
