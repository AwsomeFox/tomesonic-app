/**
 * Car compatibility mode (settings.carCompatibilityMode).
 *
 * Some car head units' Bluetooth stacks crash on the MediaSession churn a
 * chapter-per-item queue produces over AVRCP — every chapter boundary is a
 * "track change" plus queue-item rewrites, and the whole 100+ item queue is
 * mirrored to the car (the phone's Bluetooth toggles off/on mid-drive; see
 * issue #105). With the mode ON, a book prepares as a FLAT queue (no chapter
 * items) with static, plain-music-app-style metadata: no per-chapter title
 * rewrites, no byte moves — the session looks like any music app the head
 * unit already handles fine.
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

// A downloaded, single-FILE, multi-CHAPTER book — chapter-queue eligible, so
// the mode's opt-out is what's under test.
async function prepareBook() {
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

describe("car compatibility mode", () => {
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

  it("OFF (default): a single-file chaptered book builds a chapter queue", async () => {
    await prepareBook();
    expect(usePlaybackStore.getState().chapterQueue).toBe(true);
    expect(usePlaybackStore.getState().carCompatActive).toBe(false);
    expect(addedTracks()).toHaveLength(3);
  });

  it("ON: the same book builds a FLAT single-item queue titled by the book", async () => {
    useUserStore.setState({
      settings: { ...initialUser.settings, carCompatibilityMode: true },
    });
    await prepareBook();

    expect(usePlaybackStore.getState().chapterQueue).toBe(false);
    expect(usePlaybackStore.getState().carCompatActive).toBe(true);
    const tracks = addedTracks();
    expect(tracks).toHaveLength(1);
    expect(tracks[0].title).toBe("The Hobbit");
  });

  it("ON: chapter changes produce NO further metadata rewrites after the initial stamp", async () => {
    useUserStore.setState({
      settings: { ...initialUser.settings, carCompatibilityMode: true },
    });
    await prepareBook();
    usePlaybackStore.setState({ isPlaying: true });

    // First tick may stamp the active item once (book title + cover bytes).
    await jest.advanceTimersByTimeAsync(1000);
    jest.mocked(TrackPlayer.updateMetadataForTrack).mockClear();

    // Cross into chapter 2, then chapter 3 — the store tracks the chapter for
    // the UI, but the MediaSession must stay SILENT (no title rewrites, no
    // byte moves): that churn is what crashes the affected head units.
    jest
      .mocked(TrackPlayer.getProgress)
      .mockResolvedValue({ position: 150, duration: 300, buffered: 0 });
    await jest.advanceTimersByTimeAsync(1000);
    jest
      .mocked(TrackPlayer.getProgress)
      .mockResolvedValue({ position: 250, duration: 300, buffered: 0 });
    await jest.advanceTimersByTimeAsync(1000);

    expect(usePlaybackStore.getState().currentChapterIndex).toBe(2);
    expect(TrackPlayer.updateMetadataForTrack).not.toHaveBeenCalled();
  });

  it("ON: the in-app UI still tracks chapters (position/currentChapterIndex)", async () => {
    useUserStore.setState({
      settings: { ...initialUser.settings, carCompatibilityMode: true },
    });
    await prepareBook();
    usePlaybackStore.setState({ isPlaying: true });

    jest
      .mocked(TrackPlayer.getProgress)
      .mockResolvedValue({ position: 120, duration: 300, buffered: 0 });
    await jest.advanceTimersByTimeAsync(1000);

    const st = usePlaybackStore.getState();
    expect(st.position).toBe(120);
    expect(st.currentChapterIndex).toBe(1);
  });
});
