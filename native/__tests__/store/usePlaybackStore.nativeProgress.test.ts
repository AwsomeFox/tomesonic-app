/**
 * REGRESSION: progress persistence stalling in the background.
 *
 * ALL persistence (5s MMKV saves, 15s server syncs) used to ride on the
 * store's 1s JS interval — which Android throttles while the app is
 * backgrounded. Listening with the screen off could go MINUTES without a
 * save or sync, so a process kill (app update, LMK) resumed way behind.
 * PlaybackProgressUpdated is emitted by the Media3 service's own timer and
 * keeps flowing in the background; onNativeProgressSample feeds it through
 * the same persistence pipeline.
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

import { syncProgress } from "../../utils/progressSync";
import { storage, storageHelper, secureStorage } from "../../utils/storage";
import { usePlaybackStore, onNativeProgressSample } from "../../store/usePlaybackStore";
import { useUserStore } from "../../store/useUserStore";
import { useDownloadStore } from "../../store/useDownloadStore";

const initialPlayback = usePlaybackStore.getState();
const initialUser = useUserStore.getState();
const initialDownloads = useDownloadStore.getState();

const BASE = new Date("2026-03-01T08:00:00Z").getTime();

function serverSession(over: Record<string, any> = {}) {
  return {
    id: "sess1",
    libraryItemId: "item1",
    displayTitle: "The Hobbit",
    displayAuthor: "Tolkien",
    duration: 3600,
    currentTime: 0,
    chapters: [],
    audioTracks: [
      { index: 0, contentUrl: "/api/items/item1/file/0", duration: 3600, startOffset: 0 },
    ],
    ...over,
  };
}

const savedSession = () => {
  const raw = storage.getString("lastPlaybackSession");
  return raw ? JSON.parse(raw) : null;
};

describe("onNativeProgressSample (background-proof persistence)", () => {
  beforeEach(async () => {
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

  it("persists the sample to MMKV (survives a process kill mid-background)", async () => {
    await usePlaybackStore.getState().preparePlaybackSession(serverSession(), false);

    onNativeProgressSample({ position: 1234, duration: 3600, track: 0 });

    expect(usePlaybackStore.getState().position).toBe(1234);
    expect(savedSession()?.currentTime).toBe(1234); // saved — not waiting on the JS interval
  });

  it("maps chapter-queue samples to the absolute book position", async () => {
    const chapters = [
      { id: 0, title: "1", start: 0, end: 1000 },
      { id: 1, title: "2", start: 1000, end: 2000 },
      { id: 2, title: "3", start: 2000, end: 3600 },
    ];
    await usePlaybackStore.getState().preparePlaybackSession(serverSession({ chapters }), false);

    // Native event: chapter 3 clip (track 2), 100s in → absolute 2100.
    onNativeProgressSample({ position: 100, duration: 1600, track: 2 });

    expect(usePlaybackStore.getState().position).toBe(2100);
    expect(usePlaybackStore.getState().currentChapterIndex).toBe(2);
    expect(savedSession()?.currentTime).toBe(2100);
  });

  it("syncs to the server once ~15s of listening has accumulated", async () => {
    await usePlaybackStore.getState().preparePlaybackSession(serverSession(), false);

    onNativeProgressSample({ position: 100, duration: 3600, track: 0 }); // seeds tick clock
    jest.setSystemTime(BASE + 16_000);
    onNativeProgressSample({ position: 116, duration: 3600, track: 0 });

    expect(syncProgress).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess1", currentTime: 116, libraryItemId: "item1" })
    );
  });

  it("ignores samples while casting (receiver mirror is the truth)", async () => {
    await usePlaybackStore.getState().preparePlaybackSession(serverSession(), false);
    usePlaybackStore.setState({ isCasting: true, position: 500 } as any);
    storage.remove("lastPlaybackSession");

    onNativeProgressSample({ position: 42, duration: 3600, track: 0 });

    expect(usePlaybackStore.getState().position).toBe(500); // untouched
    expect(savedSession()).toBeNull(); // no write
  });

  it("ignores a straggler sample right after a local pause (must not re-stamp a paused book)", async () => {
    await usePlaybackStore.getState().preparePlaybackSession(serverSession(), false);
    onNativeProgressSample({ position: 100, duration: 3600, track: 0 });
    expect(savedSession()?.currentTime).toBe(100);

    // User pauses locally — records _lastPausedAt.
    await usePlaybackStore.getState().pause();
    expect(usePlaybackStore.getState().isPlaying).toBe(false);

    // A native PlaybackProgressUpdated for already-stopped audio lands moments
    // later (events are delivered slightly out of band). Accepting it would
    // hard-set isPlaying:true, accrue listening time and re-stamp updatedAt on
    // a paused book — poisoning freshest-wins.
    jest.setSystemTime(BASE + 500);
    onNativeProgressSample({ position: 5000, duration: 3600, track: 0 });

    const s = usePlaybackStore.getState();
    expect(s.isPlaying).toBe(false); // NOT flipped back to playing
    expect(s.position).not.toBe(5000); // straggler position not adopted
    expect(savedSession()?.currentTime).not.toBe(5000); // not re-stamped
  });

  it("accepts native samples again once the post-pause window has elapsed", async () => {
    await usePlaybackStore.getState().preparePlaybackSession(serverSession(), false);
    await usePlaybackStore.getState().pause();

    // Past the short straggler window — the guard is bounded so it never
    // permanently silences the background persistence path.
    jest.setSystemTime(BASE + 3000);
    onNativeProgressSample({ position: 1500, duration: 3600, track: 0 });

    expect(usePlaybackStore.getState().position).toBe(1500);
  });

  it("ignores bogus samples (NaN/negative) and no-session states", async () => {
    usePlaybackStore.setState({ currentSession: null } as any);
    expect(() => onNativeProgressSample({ position: 10, duration: 100, track: 0 })).not.toThrow();

    await usePlaybackStore.getState().preparePlaybackSession(serverSession(), false);
    const before = usePlaybackStore.getState().position;
    onNativeProgressSample({ position: Number.NaN, duration: 3600, track: 0 });
    onNativeProgressSample({ position: -5, duration: 3600, track: 0 });
    expect(usePlaybackStore.getState().position).toBe(before);
  });
});
