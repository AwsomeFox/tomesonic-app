import { createMMKV } from "react-native-mmkv";

// Standard storage for settings, library cache, UI state
export const storage = createMMKV({
  id: "tomesonic-settings",
});

// Secure storage for tokens, server configurations
export const secureStorage = createMMKV({
  id: "tomesonic-secure",
});

export const storageHelper = {
  // Settings
  getUserSettings: () => {
    const data = storage.getString("userSettings");
    return data ? JSON.parse(data) : null;
  },
  setUserSettings: (settings: any) => {
    storage.set("userSettings", JSON.stringify(settings));
  },

  // Auth / Server Configuration
  getServerConfig: () => {
    const data = secureStorage.getString("serverConfig");
    return data ? JSON.parse(data) : null;
  },
  setServerConfig: (config: any) => {
    secureStorage.set("serverConfig", JSON.stringify(config));
  },
  clearServerConfig: () => {
    secureStorage.remove("serverConfig");
  },

  // Refresh token helper
  getRefreshToken: () => {
    const config = storageHelper.getServerConfig();
    return config?.refreshToken || null;
  },

  // Theme mode ('light' | 'dark' | 'system')
  getThemeMode: () => {
    return storage.getString("themeMode") || null;
  },
  setThemeMode: (mode: string) => {
    storage.set("themeMode", mode);
  },

  // Use Dynamic Colors (Material You). Defaults to true.
  getUseDynamicColors: (): boolean => {
    if (!storage.contains("useDynamicColors")) return true;
    return storage.getBoolean("useDynamicColors") ?? true;
  },
  setUseDynamicColors: (value: boolean) => {
    storage.set("useDynamicColors", value);
  },

  // Last Library ID
  getLastLibraryId: () => {
    return storage.getString("lastLibraryId") || null;
  },
  setLastLibraryId: (libraryId: string) => {
    storage.set("lastLibraryId", libraryId);
  },
  removeLastLibraryId: () => {
    storage.remove("lastLibraryId");
  },

  // Last Playback Session
  getLastPlaybackSession: () => {
    const data = storage.getString("lastPlaybackSession");
    return data ? JSON.parse(data) : null;
  },
  setLastPlaybackSession: (session: any) => {
    storage.set("lastPlaybackSession", JSON.stringify(session));
  },
  removeLastPlaybackSession: () => {
    storage.remove("lastPlaybackSession");
  },

  // Global playback speed — persisted so resuming any book (in-app or via
  // Android Auto) restores the last speed the user set.
  getPlaybackRate: (): number => {
    const r = storage.getNumber("playbackRate");
    return r && r > 0 ? r : 1.0;
  },
  setPlaybackRate: (rate: number) => {
    if (rate && rate > 0) storage.set("playbackRate", rate);
  },
};
