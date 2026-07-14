/**
 * REGRESSION: TransactionTooLargeException on long chaptered books.
 *
 * A chapter-queue book builds one clipped RNTP item per chapter. The old code
 * set `localArtwork = carArtworkLocal` on EVERY chapter item, so toMediaItem
 * inlined the ~40KB cover into each item's MediaMetadata. On a 100+ chapter
 * book, when Media3 bundles the whole Timeline across the Binder to Android
 * Auto, the ~1MB transaction limit is exceeded → the queue drops / the
 * controller crashes.
 *
 * Fix: inline artwork bytes live on the ACTIVE chapter item ONLY. Inactive
 * items carry an EMPTY-STRING localArtwork (which also blocks the toMediaItem
 * `localArtwork ?: artwork` byte fallback). As chapters advance the bytes are
 * MOVED — stamped on the newly-active item and stripped off the previous one.
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

const CHAPTERS = [
  { id: 0, title: "Chapter 1", start: 0, end: 100 },
  { id: 1, title: "Chapter 2", start: 100, end: 200 },
  { id: 2, title: "Chapter 3", start: 200, end: 300 },
];

function addedTracks(): any[] {
  return jest.mocked(TrackPlayer.add).mock.calls.at(-1)![0] as unknown as any[];
}

// A downloaded, single-FILE, multi-CHAPTER book → chapter-queue mode, with a
// local cover so carArtworkLocal is populated (bytes source for the compact card).
async function prepareChapterBook() {
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
        ],
        meta: {
          duration: 300,
          chapters: CHAPTERS,
          tracks: [{ index: 0, filename: "track_0.mp3", duration: 300, startOffset: 0 }],
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
      chapters: CHAPTERS,
      audioTracks: [{ index: 0, contentUrl: "/f0.mp3", duration: 300, startOffset: 0 }],
    },
    false
  );
}

describe("chapter-queue artwork: bytes on the ACTIVE item only", () => {
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
    jest
      .mocked(TrackPlayer.getProgress)
      .mockResolvedValue({ position: 10, duration: 300, buffered: 0 });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("builds a chapter queue with no LARGE bytes but a TINY per-row cover on every item", async () => {
    await prepareChapterBook();

    expect(usePlaybackStore.getState().chapterQueue).toBe(true);
    const tracks = addedTracks();
    expect(tracks).toHaveLength(3);
    for (const t of tracks) {
      // No LARGE bytes at build — that is what blew the Binder limit on long
      // books. Empty string (not the cover, not undefined).
      expect(t.localArtwork).toBe("");
      // TINY (≈128px) per-row bytes on EVERY item so all Android Auto queue rows
      // render the cover (media3 makes each row icon from its own artworkData).
      expect(t.localArtworkSmall).toBe(COVER);
      expect(t.artwork).toBe(COVER); // full-card URI is fine on every item
    }
    // The bytes source is still available on the session for the active item.
    expect(usePlaybackStore.getState().currentSession.carArtworkLocal).toBe(COVER);
  });

  it("stamps bytes onto the ACTIVE chapter item on the first tick", async () => {
    await prepareChapterBook();
    jest.mocked(TrackPlayer.updateMetadataForTrack).mockClear();
    usePlaybackStore.setState({ isPlaying: true });

    jest.mocked(TrackPlayer.getActiveTrackIndex).mockResolvedValue(0);
    await jest.advanceTimersByTimeAsync(1000);

    // Active chapter 0 gets the cover bytes as localArtwork.
    expect(TrackPlayer.updateMetadataForTrack).toHaveBeenCalledWith(
      0,
      expect.objectContaining({ localArtwork: COVER })
    );
  });

  it("MOVES the bytes on chapter change: clears the old item, stamps the new one", async () => {
    await prepareChapterBook();
    usePlaybackStore.setState({ isPlaying: true });

    // Tick on chapter 0 first so the persister marks index 0 as the byte holder.
    jest.mocked(TrackPlayer.getActiveTrackIndex).mockResolvedValue(0);
    await jest.advanceTimersByTimeAsync(1000);

    jest.mocked(TrackPlayer.updateMetadataForTrack).mockClear();

    // Advance to chapter 1.
    jest.mocked(TrackPlayer.getActiveTrackIndex).mockResolvedValue(1);
    await jest.advanceTimersByTimeAsync(1000);

    const calls = jest.mocked(TrackPlayer.updateMetadataForTrack).mock.calls;
    // Previous active item (0) had its bytes STRIPPED (empty-string localArtwork).
    const clear = calls.find((c) => c[0] === 0);
    expect(clear).toBeDefined();
    expect((clear![1] as any).localArtwork).toBe("");
    // New active item (1) got the bytes.
    const set = calls.find((c) => c[0] === 1);
    expect(set).toBeDefined();
    expect((set![1] as any).localArtwork).toBe(COVER);
  });
});
