import { create } from "zustand";
import { storageHelper } from "../utils/storage";
import { api } from "../utils/api";
import { writeAutoCreds } from "../utils/autoCreds";
import { useLibraryStore } from "./useLibraryStore";

type HapticLevel = "off" | "light" | "medium" | "heavy";

interface UserSettings {
  // Library sort/filter — persisted so the user's choices survive restarts.
  // (Global playback rate lives in storageHelper.getPlaybackRate, and the
  // dynamic-colors toggle lives in useThemeStore — not duplicated here.)
  mobileOrderBy: string;
  mobileOrderDesc: boolean;
  mobileFilterBy: string;
  hideNonAudiobooksGlobal: boolean;
  // Device settings (wired into the Settings screen).
  lockOrientation: boolean;
  hapticFeedback: HapticLevel;
  disableAutoRewind: boolean;
  jumpForwardTime: number; // seconds
  jumpBackwardTime: number; // seconds
  // When on, finishing a downloaded book auto-queues a download of the next
  // book in the same series.
  autoDownloadNextInSeries: boolean;
}

interface UserState {
  user: any | null;
  serverConnectionConfig: any | null;
  settings: UserSettings;
  isInitialized: boolean;
  // Map of libraryItemId (or `${libraryItemId}-${episodeId}`) -> media progress.
  // Mirrors the original app's global user progress store so any card/screen
  // can look up progress by id (the shelf/list payloads don't include it).
  mediaProgress: Record<string, any>;

  // Actions
  initialize: () => Promise<void>;
  setUser: (user: any) => void;
  setServerConnectionConfig: (config: any) => void;
  updateUserSettings: (updates: Partial<UserSettings>) => Promise<void>;
  loadMediaProgress: () => Promise<void>;
  getMediaProgress: (libraryItemId: string, episodeId?: string) => any | null;
  login: (config: any, user: any) => void;
  logout: () => Promise<void>;
}

function indexMediaProgress(list: any[]): Record<string, any> {
  const map: Record<string, any> = {};
  (list || []).forEach((p) => {
    if (!p) return;
    const key = p.episodeId ? `${p.libraryItemId}-${p.episodeId}` : p.libraryItemId;
    if (key) map[key] = p;
  });
  return map;
}

const DEFAULT_SETTINGS: UserSettings = {
  mobileOrderBy: "addedAt",
  mobileOrderDesc: true,
  mobileFilterBy: "all",
  hideNonAudiobooksGlobal: false,
  lockOrientation: true,
  hapticFeedback: "medium",
  disableAutoRewind: false,
  jumpForwardTime: 10,
  jumpBackwardTime: 10,
  autoDownloadNextInSeries: false,
};

export const useUserStore = create<UserState>((set, get) => ({
  user: null,
  serverConnectionConfig: null,
  settings: DEFAULT_SETTINGS,
  isInitialized: false,
  mediaProgress: {},

  initialize: async () => {
    if (get().isInitialized) return;

    const savedConfig = storageHelper.getServerConfig();
    const savedSettings = storageHelper.getUserSettings();

    // Only restore an authenticated session when we have a saved server + token.
    const hasSession = !!(savedConfig?.address && savedConfig?.token);

    set({
      user: hasSession
        ? { id: savedConfig.userId, username: savedConfig.username }
        : null,
      serverConnectionConfig: savedConfig || null,
      settings: savedSettings ? { ...DEFAULT_SETTINGS, ...savedSettings } : DEFAULT_SETTINGS,
      isInitialized: true,
    });
    // Mirror creds for the native Android Auto browse service.
    if (hasSession) writeAutoCreds(savedConfig.address, savedConfig.token, useLibraryStore.getState().currentLibraryId, savedConfig.refreshToken);
  },

  setUser: (user) => set({ user }),

  setServerConnectionConfig: (config) => {
    storageHelper.setServerConfig(config);
    set({ serverConnectionConfig: config });
  },

  updateUserSettings: async (updates) => {
    const currentSettings = get().settings;
    const newSettings = { ...currentSettings, ...updates };
    
    storageHelper.setUserSettings(newSettings);
    set({ settings: newSettings });
  },

  loadMediaProgress: async () => {
    try {
      const res = await api.get("/api/me");
      const list = res.data?.mediaProgress || [];
      set({ mediaProgress: indexMediaProgress(list) });
    } catch (err) {
      console.error("[UserStore] Failed to load media progress:", err);
    }
  },

  getMediaProgress: (libraryItemId, episodeId) => {
    const map = get().mediaProgress;
    const key = episodeId ? `${libraryItemId}-${episodeId}` : libraryItemId;
    return map[key] || null;
  },

  login: (config, user) => {
    storageHelper.setServerConfig(config);
    writeAutoCreds(config?.address, config?.token, useLibraryStore.getState().currentLibraryId, config?.refreshToken);
    set({
      serverConnectionConfig: config,
      user: user,
      // Seed progress from the login payload; refreshed later via loadMediaProgress.
      mediaProgress: indexMediaProgress(user?.mediaProgress || []),
    });
  },

  logout: async () => {
    // Stop playback + close the ABS session BEFORE tearing down credentials,
    // and wipe queued offline syncs so a previous account's listening time can
    // never be flushed under the next account. (Lazy requires: circular imports.)
    try {
      const { usePlaybackStore } = require("./usePlaybackStore");
      await usePlaybackStore.getState().closePlayback();
    } catch (e) {
      console.warn("[UserStore] closePlayback on logout failed", e);
    }
    try {
      const { clearAllPending } = require("../utils/progressSync");
      clearAllPending();
    } catch {}
    try {
      const { writeWidgetState } = require("../utils/autoCreds");
      writeWidgetState(null);
    } catch {}

    // Call server to invalidate session if config exists
    const config = get().serverConnectionConfig;
    if (config) {
      try {
        await api.post("/logout");
      } catch (err) {
        console.error("[UserStore] Logout API call failed:", err);
      }
    }

    storageHelper.clearServerConfig();
    writeAutoCreds(null, null, null);
    storageHelper.removeLastLibraryId();
    storageHelper.removeLastPlaybackSession();

    // Wipe cached shelves/series lists so the next account never sees the
    // previous account's home content (stale-while-revalidate caches).
    try {
      const { storage } = require("../utils/storage");
      storage
        .getAllKeys()
        .filter(
          (k: string) =>
            k.startsWith("shelvesCache_") ||
            k.startsWith("seriesListCache_") ||
            k.startsWith("continueReadingCache_")
        )
        .forEach((k: string) => storage.remove(k));
    } catch {}
    try {
      const { useLibraryStore } = require("./useLibraryStore");
      useLibraryStore.getState().reset();
    } catch {}

    set({
      user: null,
      serverConnectionConfig: null,
      mediaProgress: {},
      settings: DEFAULT_SETTINGS,
    });
  },
}));
