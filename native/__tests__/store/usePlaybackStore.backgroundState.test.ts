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
import { storage, storageHelper, secureStorage } from "../../utils/storage";
import { flushPendingSyncs } from "../../utils/progressSync";
import {
  usePlaybackStore,
  onPlaybackError,
  persistCastProgressSample,
} from "../../store/usePlaybackStore";
import { playbackService, onConnectivityChanged } from "../../store/playbackService";
import { useUserStore } from "../../store/useUserStore";
import { useDownloadStore } from "../../store/useDownloadStore";

const initialPlayback = usePlaybackStore.getState();
const initialUser = useUserStore.getState();
const initialDownloads = useDownloadStore.getState();

const BASE = new Date("2026-03-02T08:00:00Z").getTime();
const emit = (event: string, payload?: any) => (TrackPlayer as any).__emit(event, payload);

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

// Background/state-correctness fallout from the device-sleep audit: queue-end
// with the screen off, cast persistence without JS timers, and the headless
// (Android Auto) connectivity recovery path.
describe("usePlaybackStore background state correctness", () => {
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

  describe("end of book while backgrounded (PlaybackQueueEnded)", () => {
    it("corrects isPlaying when the queue ends", async () => {
      await playbackService();
      await usePlaybackStore.getState().preparePlaybackSession(serverSession(), true);
      expect(usePlaybackStore.getState().isPlaying).toBe(true);

      // Native playback finished the last item with the screen off — no
      // native progress events follow, and the JS interval is throttled.
      emit("playback-queue-ended");
      expect(usePlaybackStore.getState().isPlaying).toBe(false);
    });

    it("leaves the cast mirror alone (local queue is not the source of truth)", async () => {
      await playbackService();
      await usePlaybackStore.getState().preparePlaybackSession(serverSession(), true);
      usePlaybackStore.getState().setCastState({ play: jest.fn(), pause: jest.fn() });
      usePlaybackStore.setState({ isPlaying: true });

      emit("playback-queue-ended");
      expect(usePlaybackStore.getState().isPlaying).toBe(true);
    });
  });

  describe("cast persistence without JS timers", () => {
    it("persistCastProgressSample saves the mirrored receiver position", async () => {
      await usePlaybackStore.getState().preparePlaybackSession(serverSession(), true);
      usePlaybackStore.getState().setCastState({ play: jest.fn(), pause: jest.fn() });
      usePlaybackStore.setState({ isPlaying: true });

      // Receiver progress callback (native event) — the throttled JS interval
      // never runs with the screen off, so this must drive the MMKV save.
      persistCastProgressSample(142);
      expect(storageHelper.getLastPlaybackSession().currentTime).toBe(142);
    });

    it("no-ops when not casting (native events already drive persistence)", async () => {
      await usePlaybackStore.getState().preparePlaybackSession(serverSession(), true);
      storageHelper.setLastPlaybackSession({ ...serverSession(), currentTime: 10 });
      persistCastProgressSample(250);
      expect(storageHelper.getLastPlaybackSession().currentTime).toBe(10);
    });
  });

  describe("headless connectivity recovery (Android Auto cold start)", () => {
    it("reconnect recovers an errored player and flushes queued syncs", async () => {
      await usePlaybackStore.getState().preparePlaybackSession(serverSession(), true);
      jest.mocked(TrackPlayer.getPlaybackState).mockResolvedValue({ state: "error" } as any);
      jest.mocked(TrackPlayer.retry).mockResolvedValue(undefined);
      onPlaybackError({ message: "net down" });

      // Network returns — no App.tsx hooks exist headless; the service's
      // NetInfo subscription (this handler) is the only reconnect trigger
      // in the car.
      onConnectivityChanged({ isConnected: true });
      await jest.advanceTimersByTimeAsync(0);
      expect(TrackPlayer.retry).toHaveBeenCalledTimes(1);
      expect(flushPendingSyncs).toHaveBeenCalled();
      expect(usePlaybackStore.getState().isPlaying).toBe(true);
    });

    it("a disconnect event does not trigger recovery", async () => {
      await usePlaybackStore.getState().preparePlaybackSession(serverSession(), true);
      jest.mocked(TrackPlayer.getPlaybackState).mockResolvedValue({ state: "error" } as any);
      onPlaybackError({ message: "net down" });

      onConnectivityChanged({ isConnected: false });
      await jest.advanceTimersByTimeAsync(0);
      expect(TrackPlayer.retry).not.toHaveBeenCalled();
    });
  });
});
