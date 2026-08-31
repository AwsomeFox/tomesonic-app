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
  writeAutoChapters: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../utils/downloader", () => ({
  downloader: {},
  autoDownloadNextAfterFinish: jest.fn().mockResolvedValue(undefined),
}));

import TrackPlayer, { State } from "react-native-track-player";
import { storage, storageHelper, secureStorage } from "../../utils/storage";
import {
  usePlaybackStore,
  MAX_CAR_TILE_ITEMS,
  CHAPTER_QUEUE_MAX_SECONDS,
  onCarControllerConnected,
} from "../../store/usePlaybackStore";
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

  it("CAPS the tiny per-row bytes at MAX_CAR_TILE_ITEMS so a long book can't overflow the Binder limit", async () => {
    // Regression for the Android Auto skip crash: bytes on EVERY item made the
    // timeline bundle scale with book length and overflow the ~1MB Binder cap on
    // a skip re-bundle → the playback session crashed. The tiny tier is now
    // bounded to the first MAX_CAR_TILE_ITEMS items.
    const total = MAX_CAR_TILE_ITEMS + 6;
    const manyChapters = Array.from({ length: total }, (_, i) => ({
      id: i,
      title: `Chapter ${i + 1}`,
      start: i * 100,
      end: (i + 1) * 100,
    }));
    useDownloadStore.setState({
      completedDownloads: {
        item1: {
          id: "item1",
          title: "The Hobbit",
          status: "completed",
          localFolderPath: "file:///docs/downloads/item1_book/",
          parts: [
            { id: "cover", filename: "cover.jpg", localFilePath: COVER, completed: true },
            { id: "track_0", filename: "track_0.mp3", localFilePath: "file:///docs/downloads/item1_book/track_0.mp3", completed: true },
          ],
          meta: { duration: total * 100, chapters: manyChapters, tracks: [{ index: 0, filename: "track_0.mp3", duration: total * 100, startOffset: 0 }] },
        } as any,
      },
    });
    await usePlaybackStore.getState().preparePlaybackSession(
      {
        id: "sess1",
        libraryItemId: "item1",
        displayTitle: "The Hobbit",
        displayAuthor: "Tolkien",
        duration: total * 100,
        currentTime: 0,
        chapters: manyChapters,
        audioTracks: [{ index: 0, contentUrl: "/f0.mp3", duration: total * 100, startOffset: 0 }],
      },
      false
    );

    const tracks = addedTracks();
    expect(tracks).toHaveLength(total);
    // First MAX_CAR_TILE_ITEMS carry the tiny cover...
    for (let i = 0; i < MAX_CAR_TILE_ITEMS; i++) expect(tracks[i].localArtworkSmall).toBe(COVER);
    // ...the rest carry NONE (bounded payload).
    for (let i = MAX_CAR_TILE_ITEMS; i < total; i++) expect(tracks[i].localArtworkSmall).toBeUndefined();
  });

  it("stamps bytes onto the ACTIVE chapter item AND pre-stamps the NEXT one on the first tick", async () => {
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
    // LOOK-AHEAD: chapter 1 is pre-stamped with the same bytes (and its own
    // intrinsic title) so the auto-advance transition lands on an item that
    // already looks right — the now-playing artwork never flaps at a boundary.
    expect(TrackPlayer.updateMetadataForTrack).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ localArtwork: COVER, title: "Chapter 2" })
    );
  });

  it("slides the byte window on chapter change: strips the old item, pre-stamps the upcoming one, does NOT rewrite the new active item", async () => {
    await prepareChapterBook();
    usePlaybackStore.setState({ isPlaying: true });

    // Tick on chapter 0 first so the window is {0 active, 1 pre-stamped}.
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
    // The NEW active item (1) was pre-stamped on the previous tick and is NOT
    // rewritten at the boundary — that rewrite was one of the two per-chapter
    // queue re-broadcasts implicated in Bluetooth-stack crashes in cars.
    expect(calls.find((c) => c[0] === 1)).toBeUndefined();
    // The upcoming chapter (2) is pre-stamped with the bytes instead.
    const next = calls.find((c) => c[0] === 2);
    expect(next).toBeDefined();
    expect((next![1] as any).localArtwork).toBe(COVER);
  });

  it("does NO metadata writes at chapter changes for a STREAMING chapter-queue book (no local bytes)", async () => {
    // A streaming book has no local cover file at prepare (carArtworkLocal is
    // only populated later by cacheNowPlayingCoverLocally) — the queue items
    // already carry their intrinsic chapter titles and the artworkUri, so a
    // chapter change has NOTHING to rewrite. The old code re-wrote identical
    // metadata twice per chapter anyway (two full queue re-broadcasts to
    // Android Auto + Bluetooth AVRCP, for nothing).
    useDownloadStore.setState({ completedDownloads: {} });
    // Keep the fire-and-forget cover cache from minting a local file — this
    // test is about the window BEFORE any local bytes exist.
    const FileSystem = require("expo-file-system/legacy");
    jest.mocked(FileSystem.downloadAsync).mockRejectedValueOnce(new Error("offline"));
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
    expect(usePlaybackStore.getState().chapterQueue).toBe(true);
    usePlaybackStore.setState({ isPlaying: true });
    jest.mocked(TrackPlayer.updateMetadataForTrack).mockClear();

    jest.mocked(TrackPlayer.getActiveTrackIndex).mockResolvedValue(0);
    await jest.advanceTimersByTimeAsync(1000);
    jest.mocked(TrackPlayer.getActiveTrackIndex).mockResolvedValue(1);
    await jest.advanceTimersByTimeAsync(1000);

    expect(TrackPlayer.updateMetadataForTrack).not.toHaveBeenCalled();
  });

  it("re-stamps when session.coverUrl changes even though chapter and active index did not move", async () => {
    // A token refresh swaps session.coverUrl without moving the chapter or the
    // active item — the dedupe must not swallow it, or the stale artworkUri
    // sits in the MediaSession until the next chapter change.
    await prepareChapterBook();
    usePlaybackStore.setState({ isPlaying: true });
    jest.mocked(TrackPlayer.getActiveTrackIndex).mockResolvedValue(0);
    await jest.advanceTimersByTimeAsync(1000);
    jest.mocked(TrackPlayer.updateMetadataForTrack).mockClear();

    const s = usePlaybackStore.getState().currentSession;
    const freshUrl = "https://abs.example.com/cover.jpg?token=fresh";
    usePlaybackStore.setState({ currentSession: { ...s, coverUrl: freshUrl } });
    await jest.advanceTimersByTimeAsync(1000);

    expect(TrackPlayer.updateMetadataForTrack).toHaveBeenCalledWith(
      0,
      expect.objectContaining({ artwork: freshUrl })
    );
  });

  it("prepares a VERY long single-file book as ONE flat item (OOM guard), keeping chapters for the UI", async () => {
    // Each clipped item's prepare re-parses the whole file's moov sample
    // table (~34MB of arrays for a 28.5h m4b) — hours into a long book the
    // heap creeps to its cap and a chapter boundary dies with
    // OutOfMemoryError ("Source error"). Over the duration cap the book
    // plays as a single item; chapter UX runs on `chapters` + positions.
    const total = CHAPTER_QUEUE_MAX_SECONDS + 3600; // one hour over the cap
    const bigChapters = Array.from({ length: 40 }, (_, i) => ({
      id: i,
      title: `Chapter ${i + 1}`,
      start: (i * total) / 40,
      end: ((i + 1) * total) / 40,
    }));
    useDownloadStore.setState({ completedDownloads: {} });
    await usePlaybackStore.getState().preparePlaybackSession(
      {
        id: "sessBig",
        libraryItemId: "item1",
        displayTitle: "The Monster Book",
        displayAuthor: "Tolkien",
        duration: total,
        currentTime: 0,
        chapters: bigChapters,
        audioTracks: [{ index: 0, contentUrl: "/f0.m4b", duration: total, startOffset: 0 }],
      },
      false
    );
    expect(usePlaybackStore.getState().chapterQueue).toBe(false);
    expect(addedTracks()).toHaveLength(1);
    // The chapter UX still has its data.
    expect(usePlaybackStore.getState().chapters).toHaveLength(40);
  });

  it("mirrors the book's chapters for the native Android Auto Chapters section", async () => {
    // The AA browse tree's "Chapters" rows (play:<id>@@<start>) are fed by
    // this mirror — it is what keeps the chapter list in the car for books
    // the duration cap prepares FLAT.
    const { writeAutoChapters } = require("../../utils/autoCreds");
    jest.mocked(writeAutoChapters).mockClear();
    await prepareChapterBook();
    expect(writeAutoChapters).toHaveBeenCalledWith({
      itemId: "item1",
      title: "The Hobbit",
      chapters: [
        { title: "Chapter 1", start: 0, end: 100 },
        { title: "Chapter 2", start: 100, end: 200 },
        { title: "Chapter 3", start: 200, end: 300 },
      ],
    });
  });

  it("keeps the chapter queue for a book exactly AT the duration cap", async () => {
    const total = CHAPTER_QUEUE_MAX_SECONDS;
    const chapters = Array.from({ length: 10 }, (_, i) => ({
      id: i,
      title: `Chapter ${i + 1}`,
      start: (i * total) / 10,
      end: ((i + 1) * total) / 10,
    }));
    useDownloadStore.setState({ completedDownloads: {} });
    await usePlaybackStore.getState().preparePlaybackSession(
      {
        id: "sessCap",
        libraryItemId: "item1",
        displayTitle: "The Cap Book",
        displayAuthor: "Tolkien",
        duration: total,
        currentTime: 0,
        chapters,
        audioTracks: [{ index: 0, contentUrl: "/f0.m4b", duration: total, startOffset: 0 }],
      },
      false
    );
    expect(usePlaybackStore.getState().chapterQueue).toBe(true);
    expect(addedTracks()).toHaveLength(10);
  });

  describe("native chapter windows (ChapterForwardingPlayer bridge)", () => {
    // With the patched service's absSetChapterWindows present, single-file
    // chaptered books prepare FLAT at ANY length — one media source, one moov
    // parse — and the session's per-chapter presentation comes from the
    // window map pushed here. The clipped queue survives only as the
    // fallback for binaries without the method (every other test in this
    // file runs with NativeModules.TrackPlayer absent = that fallback).
    const { NativeModules, Platform } = require("react-native");
    let prevOS: string;
    const injectNative = () => {
      const absSetChapterWindows = jest.fn().mockResolvedValue(undefined);
      prevOS = Platform.OS;
      (Platform as any).OS = "android";
      (NativeModules as any).TrackPlayer = { absSetChapterWindows };
      return absSetChapterWindows;
    };
    afterEach(() => {
      delete (NativeModules as any).TrackPlayer;
      if (prevOS) (Platform as any).OS = prevOS;
    });

    it("prepares a single-file chaptered book FLAT and pushes millisecond windows", async () => {
      const absSetChapterWindows = injectNative();
      await prepareChapterBook();
      expect(usePlaybackStore.getState().chapterQueue).toBe(false);
      expect(addedTracks()).toHaveLength(1);
      // Two calls per prepare: the clear at reset (previous book's map must
      // not overlay the new item), then this book's windows after the add.
      expect(absSetChapterWindows).toHaveBeenCalledTimes(2);
      expect(JSON.parse(absSetChapterWindows.mock.calls[0][0])).toEqual([]);
      expect(JSON.parse(absSetChapterWindows.mock.calls.at(-1)![0])).toEqual([
        { title: "Chapter 1", startMs: 0, endMs: 100000 },
        { title: "Chapter 2", startMs: 100000, endMs: 200000 },
        { title: "Chapter 3", startMs: 200000, endMs: 300000 },
      ]);
      // Single-item queue may carry the LARGE bytes (no Timeline to overflow);
      // the native adapter strips artwork bytes off the synthetic windows.
      expect(addedTracks()[0].localArtwork).toBe(COVER);
    });

    it("ignores the legacy duration cap — a monster book still gets windows over a flat item", async () => {
      const absSetChapterWindows = injectNative();
      const total = CHAPTER_QUEUE_MAX_SECONDS + 3600;
      const bigChapters = Array.from({ length: 40 }, (_, i) => ({
        id: i,
        title: `Chapter ${i + 1}`,
        start: (i * total) / 40,
        end: ((i + 1) * total) / 40,
      }));
      useDownloadStore.setState({ completedDownloads: {} });
      await usePlaybackStore.getState().preparePlaybackSession(
        {
          id: "sessBigWin",
          libraryItemId: "item1",
          displayTitle: "The Monster Book",
          displayAuthor: "Tolkien",
          duration: total,
          currentTime: 0,
          chapters: bigChapters,
          audioTracks: [{ index: 0, contentUrl: "/f0.m4b", duration: total, startOffset: 0 }],
        },
        false
      );
      expect(usePlaybackStore.getState().chapterQueue).toBe(false);
      expect(addedTracks()).toHaveLength(1);
      const windows = JSON.parse(
        jest.mocked(NativeModules.TrackPlayer.absSetChapterWindows).mock.calls.at(-1)![0]
      );
      expect(windows).toHaveLength(40);
      expect(windows[39].endMs).toBe(total * 1000);
      expect(absSetChapterWindows).toHaveBeenCalled();
    });

    it("clears the window map when loading a multi-file book", async () => {
      const absSetChapterWindows = injectNative();
      useDownloadStore.setState({ completedDownloads: {} });
      await usePlaybackStore.getState().preparePlaybackSession(
        {
          id: "sessMulti",
          libraryItemId: "item1",
          displayTitle: "The Split Book",
          displayAuthor: "Tolkien",
          duration: 300,
          currentTime: 0,
          chapters: CHAPTERS,
          audioTracks: [
            { index: 0, contentUrl: "/f0.mp3", duration: 150, startOffset: 0 },
            { index: 1, contentUrl: "/f1.mp3", duration: 150, startOffset: 150 },
          ],
        },
        false
      );
      expect(addedTracks()).toHaveLength(2);
      // Clear at reset + the multi-file load's own [] — never a window map.
      expect(absSetChapterWindows).toHaveBeenCalledTimes(2);
      for (const call of absSetChapterWindows.mock.calls) {
        expect(JSON.parse(call[0])).toEqual([]);
      }
    });

    it("clears the window map when a Cast client attaches", () => {
      const absSetChapterWindows = injectNative();
      usePlaybackStore.getState().setCastState({} as any);
      expect(absSetChapterWindows).toHaveBeenCalledTimes(1);
      expect(JSON.parse(absSetChapterWindows.mock.calls[0][0])).toEqual([]);
    });

    it("subtracts the track startOffset so windows are in PLAYER coordinates", async () => {
      const absSetChapterWindows = injectNative();
      useDownloadStore.setState({ completedDownloads: {} });
      await usePlaybackStore.getState().preparePlaybackSession(
        {
          id: "sessOffset",
          libraryItemId: "item1",
          displayTitle: "The Offset Book",
          displayAuthor: "Tolkien",
          duration: 300,
          currentTime: 0,
          chapters: [
            { id: 0, title: "Chapter 1", start: 10, end: 150 },
            { id: 1, title: "Chapter 2", start: 150, end: 310 },
          ],
          audioTracks: [{ index: 0, contentUrl: "/f0.m4b", duration: 300, startOffset: 10 }],
        },
        false
      );
      expect(JSON.parse(absSetChapterWindows.mock.calls.at(-1)![0])).toEqual([
        { title: "Chapter 1", startMs: 0, endMs: 140000 },
        { title: "Chapter 2", startMs: 140000, endMs: 300000 },
      ]);
    });
  });

  it("SKIPS the look-ahead pre-stamp while the next item is already prebuffering (boundary safety)", async () => {
    // Buffered topping out at the clipped item's end means ExoPlayer is
    // loading the NEXT chapter. Replacing that item (the look-ahead stamp
    // goes through replaceMediaItems) recreates its media source and throws
    // the prebuffer away — a re-load over a slow link stalls the boundary,
    // over a background-denied one it dies there ("pauses at the end of
    // every chapter"). Short chapters are hot on every tick; long chapters
    // go hot when a background-throttled tick lands late in the chapter.
    await prepareChapterBook();
    jest.mocked(TrackPlayer.updateMetadataForTrack).mockClear();
    usePlaybackStore.setState({ isPlaying: true });

    jest.mocked(TrackPlayer.getActiveTrackIndex).mockResolvedValue(0);
    jest
      .mocked(TrackPlayer.getProgress)
      .mockResolvedValue({ position: 90, duration: 100, buffered: 95 } as any);
    await jest.advanceTimersByTimeAsync(1000);

    // The ACTIVE item still gets its bytes — updating the CURRENT item is a
    // seamless in-place metadata change.
    expect(TrackPlayer.updateMetadataForTrack).toHaveBeenCalledWith(
      0,
      expect.objectContaining({ localArtwork: COVER })
    );
    // The hot NEXT item is left completely untouched.
    const touchedNext = jest
      .mocked(TrackPlayer.updateMetadataForTrack)
      .mock.calls.some((c) => c[0] === 1);
    expect(touchedNext).toBe(false);
  });

  it("slides the window WITHOUT touching the upcoming item when it is hot at the boundary tick", async () => {
    await prepareChapterBook();
    usePlaybackStore.setState({ isPlaying: true });

    // Safe tick on chapter 0: window becomes {0 active, 1 pre-stamped}.
    jest.mocked(TrackPlayer.getActiveTrackIndex).mockResolvedValue(0);
    await jest.advanceTimersByTimeAsync(1000);
    jest.mocked(TrackPlayer.updateMetadataForTrack).mockClear();

    // Chapter change lands on a HOT tick (buffered at the clip end).
    jest.mocked(TrackPlayer.getActiveTrackIndex).mockResolvedValue(1);
    jest
      .mocked(TrackPlayer.getProgress)
      .mockResolvedValue({ position: 5, duration: 100, buffered: 100 } as any);
    await jest.advanceTimersByTimeAsync(1000);

    const calls = jest.mocked(TrackPlayer.updateMetadataForTrack).mock.calls;
    // Old item stripped, new active untouched (pre-stamped last tick) — and
    // the hot upcoming chapter 2 is NOT pre-stamped.
    const clear = calls.find((c) => c[0] === 0);
    expect(clear).toBeDefined();
    expect((clear![1] as any).localArtwork).toBe("");
    expect(calls.find((c) => c[0] === 1)).toBeUndefined();
    expect(calls.find((c) => c[0] === 2)).toBeUndefined();
  });

  it("stamps the tiny row tier when a STREAMED book's cover lands after the car connected", async () => {
    // A streamed book has no local cover at prepare — carArtworkLocal arrives
    // seconds later from the cover cache. The one-shot car-connect restamp has
    // already run by then, so the late-cover path must stamp the row tier
    // itself or Android Auto's queue rows stay artless for the whole session.
    useDownloadStore.setState({ completedDownloads: {} });
    await onCarControllerConnected(); // car seen before any session exists

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
    jest.mocked(TrackPlayer.getQueue).mockResolvedValue(addedTracks() as any);
    jest.mocked(TrackPlayer.updateMetadataForTrack).mockClear();

    // Let the fire-and-forget cover cache (downloadAsync default: 200) land.
    await jest.advanceTimersByTimeAsync(50);

    const rowStamps = jest
      .mocked(TrackPlayer.updateMetadataForTrack)
      .mock.calls.filter((c) => typeof (c[1] as any).localArtworkSmall === "string" && (c[1] as any).localArtworkSmall.length > 0);
    expect(rowStamps.map((c) => c[0])).toEqual([0, 1, 2]);
  });

  it("car-connect restamp PRESERVES each row's existing metadata alongside the tiny bytes", async () => {
    // The native setMetadata is replacement-style for the standard fields: a
    // restamp bundle carrying ONLY localArtworkSmall would null every row's
    // title/artist/mediaId (blank queue rows in Android Auto). The restamp
    // must echo the row's existing metadata back with the bytes.
    await prepareChapterBook();
    jest.mocked(TrackPlayer.getQueue).mockResolvedValue(addedTracks() as any);
    jest.mocked(TrackPlayer.updateMetadataForTrack).mockClear();

    await onCarControllerConnected();

    const restamps = jest
      .mocked(TrackPlayer.updateMetadataForTrack)
      .mock.calls.filter((c) => (c[1] as any).localArtworkSmall === COVER);
    expect(restamps.map((c) => c[0])).toEqual([0, 1, 2]);
    for (const [index, meta] of restamps as any[]) {
      expect(meta.title).toBe(`Chapter ${index + 1}`);
      expect(meta.artwork).toBe(COVER);
    }
  });
});
