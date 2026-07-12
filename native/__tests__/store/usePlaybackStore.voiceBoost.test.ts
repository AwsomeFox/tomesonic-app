// "Enhance voice" (skip-silence + voice-boost) + the Android Auto local-cover
// offline fallback. These exercise the JS pieces added for the two settings and
// the cover backfill; the native LoudnessEnhancer / skipSilence wiring lives in
// the RNTP patch and needs on-device verification.
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

import * as FileSystem from "expo-file-system/legacy";
import { Platform, NativeModules } from "react-native";
import TrackPlayer from "react-native-track-player";
import {
  usePlaybackStore,
  applyJumpOptions,
  applyVoiceBoost,
  cacheNowPlayingCoverLocally,
} from "../../store/usePlaybackStore";
import { useUserStore } from "../../store/useUserStore";
import { useDownloadStore } from "../../store/useDownloadStore";

const initialPlayback = usePlaybackStore.getState();
const initialUser = useUserStore.getState();
const initialDownloads = useDownloadStore.getState();

const setSettings = (over: Record<string, any>) =>
  useUserStore.setState({ settings: { ...useUserStore.getState().settings, ...over } } as any);

describe('usePlaybackStore "Enhance voice" + AA cover fallback', () => {
  const origOS = Platform.OS;

  beforeEach(() => {
    usePlaybackStore.setState(initialPlayback, true);
    useUserStore.setState(initialUser, true);
    useDownloadStore.setState(initialDownloads, true);
    jest.clearAllMocks();
    (FileSystem.downloadAsync as jest.Mock).mockResolvedValue({
      uri: "file:///test-cache/dl",
      status: 200,
    });
  });

  afterEach(() => {
    // Restore Platform + remove any injected native module.
    (Platform as any).OS = origOS;
    delete (NativeModules as any).TrackPlayer;
  });

  // ---- (1a) SKIP SILENCE → buildPlayerOptions.android.androidSkipSilence ----
  describe("skip silence in player options", () => {
    it("sets androidSkipSilence true when the setting is on", async () => {
      setSettings({ skipSilence: true });
      await applyJumpOptions();
      const opts = (TrackPlayer.updateOptions as jest.Mock).mock.calls.at(-1)![0];
      expect(opts.android.androidSkipSilence).toBe(true);
    });

    it("sets androidSkipSilence false when the setting is off (default)", async () => {
      setSettings({ skipSilence: false });
      await applyJumpOptions();
      const opts = (TrackPlayer.updateOptions as jest.Mock).mock.calls.at(-1)![0];
      expect(opts.android.androidSkipSilence).toBe(false);
      // Full capability set must still be present (partial options wipe the AA layout).
      expect(opts.capabilities.length).toBeGreaterThan(4);
    });
  });

  // ---- (1b) VOICE BOOST → NativeModules.TrackPlayer.absSetVoiceBoost ----
  describe("voice boost native bridge", () => {
    const injectNative = () => {
      const absSetVoiceBoost = jest.fn().mockResolvedValue(undefined);
      (Platform as any).OS = "android";
      (NativeModules as any).TrackPlayer = { absSetVoiceBoost };
      return absSetVoiceBoost;
    };

    it("calls absSetVoiceBoost(true, 700) when the setting is on", () => {
      const absSetVoiceBoost = injectNative();
      setSettings({ voiceBoost: true });
      applyVoiceBoost();
      expect(absSetVoiceBoost).toHaveBeenCalledWith(true, 700);
    });

    it("calls absSetVoiceBoost(false, 0) when the setting is off", () => {
      const absSetVoiceBoost = injectNative();
      setSettings({ voiceBoost: false });
      applyVoiceBoost();
      expect(absSetVoiceBoost).toHaveBeenCalledWith(false, 0);
    });

    it("no-ops (no throw) when the native module is not bound", () => {
      (Platform as any).OS = "android";
      // No NativeModules.TrackPlayer injected.
      setSettings({ voiceBoost: true });
      expect(() => applyVoiceBoost()).not.toThrow();
    });

    it("no-ops off Android even if a module is present", () => {
      const absSetVoiceBoost = jest.fn().mockResolvedValue(undefined);
      (Platform as any).OS = "ios";
      (NativeModules as any).TrackPlayer = { absSetVoiceBoost };
      setSettings({ voiceBoost: true });
      applyVoiceBoost();
      expect(absSetVoiceBoost).not.toHaveBeenCalled();
    });
  });

  // ---- (2) AA cover: cacheNowPlayingCoverLocally prefers a local cover part ----
  describe("cacheNowPlayingCoverLocally offline fallback", () => {
    it("prefers an already-downloaded local cover part without any network fetch", async () => {
      const itemId = "item-local-cover";
      const localCoverPath = "file:///test-documents/downloads/item-local-cover_Book/cover.jpg";
      useDownloadStore.setState({
        completedDownloads: {
          [itemId]: {
            id: itemId,
            libraryItemId: itemId,
            status: "completed",
            parts: [{ id: "cover", filename: "cover.jpg", completed: true, localFilePath: localCoverPath }],
          },
        },
      } as any);
      usePlaybackStore.setState({ currentSession: { id: "s1", libraryItemId: itemId } } as any);

      // gen 0 matches the module's initial _sessionGen (no prepare ran here).
      await cacheNowPlayingCoverLocally(itemId, "http://server/api/items/x/cover?token=t", 0);

      expect(FileSystem.downloadAsync).not.toHaveBeenCalled();
      expect(usePlaybackStore.getState().currentSession?.carArtworkLocal).toBe(localCoverPath);
    });

    it("falls back to caching the remote url when there is no local cover part", async () => {
      const itemId = "item-no-cover";
      (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: false });
      usePlaybackStore.setState({ currentSession: { id: "s2", libraryItemId: itemId } } as any);

      await cacheNowPlayingCoverLocally(itemId, "http://server/api/items/x/cover?token=t", 0);

      expect(FileSystem.downloadAsync).toHaveBeenCalled();
      expect(usePlaybackStore.getState().currentSession?.carArtworkLocal).toContain(
        "nowplaying/cover_"
      );
    });
  });
});
