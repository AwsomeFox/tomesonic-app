import { createMMKV } from "react-native-mmkv";
import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";

// Standard storage for settings, library cache, UI state
export const storage = createMMKV({
  id: "tomesonic-settings",
});

// The secure store (auth token + refresh token, server config) is encrypted at
// rest with a random key held in the OS keystore via expo-secure-store, so the
// tokens aren't readable in a plaintext MMKV file on a rooted device or backup.
// The key is fetched/generated synchronously at module load — SecureStore's
// getItem/setItem are sync (SDK 51+) and this store is only read after the
// module initializes — so every existing synchronous caller stays unchanged.
const MMKV_ENCRYPTION_KEY_NAME = "tomesonic-mmkv-encryption-key";

function getOrCreateEncryptionKey(): string | undefined {
  try {
    let key = SecureStore.getItem(MMKV_ENCRYPTION_KEY_NAME);
    if (!key) {
      // 32 random bytes -> 64-char hex. getRandomBytes is synchronous.
      const bytes = Crypto.getRandomBytes(32);
      key = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
      SecureStore.setItem(MMKV_ENCRYPTION_KEY_NAME, key);
    }
    return key;
  } catch (e) {
    // Keystore unavailable (extremely rare on a real device). Fall back to an
    // unencrypted store so the app still launches rather than bricking.
    console.warn("[storage] Encryption key unavailable; secure store is unencrypted", e);
    return undefined;
  }
}

// Secure storage for tokens / server configuration — encrypted at rest.
export const secureStorage = createMMKV({
  id: "tomesonic-secure",
  encryptionKey: getOrCreateEncryptionKey(),
});

// Corrupt stored values (truncated writes, bad backup restores) must never
// crash the startup/auth path — parse defensively, like progressSync does.
function safeParse(data: string | undefined): any | null {
  if (!data) return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export const storageHelper = {
  // Settings
  getUserSettings: () => {
    return safeParse(storage.getString("userSettings"));
  },
  setUserSettings: (settings: any) => {
    storage.set("userSettings", JSON.stringify(settings));
  },

  // Auth / Server Configuration
  getServerConfig: () => {
    return safeParse(secureStorage.getString("serverConfig"));
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

  // Identity of the last logged-in session ("address::userId" — no secrets, so
  // plain storage). Unlike serverConfig this SURVIVES a forced 401 logout, so
  // useUserStore.login can tell "same account re-logging in" (keep queued
  // progress syncs) apart from "different account/server" (wipe them).
  getLastSessionKey: () => {
    return storage.getString("lastSessionKey") || null;
  },
  setLastSessionKey: (key: string) => {
    storage.set("lastSessionKey", key);
  },
  removeLastSessionKey: () => {
    storage.remove("lastSessionKey");
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
    return safeParse(storage.getString("lastPlaybackSession"));
  },
  setLastPlaybackSession: (session: any) => {
    storage.set("lastPlaybackSession", JSON.stringify(session));
  },
  removeLastPlaybackSession: () => {
    storage.remove("lastPlaybackSession");
  },

  // Media-progress cache — the per-item progress map mirrored to disk so an
  // OFFLINE cold start still knows every book's position/finished state.
  // Without it the in-memory map started empty, and playing any downloaded
  // book that wasn't the single last-played session resumed at 0 — then
  // queued that 0 to the server, regressing every other device.
  getMediaProgressCache: (): Record<string, any> => {
    // Shape-validate: corrupted-but-valid JSON (array, number) must not be
    // handed to callers that assume a plain keyed object.
    const parsed = safeParse(storage.getString("mediaProgressCache"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  },
  setMediaProgressCache: (map: Record<string, any>) => {
    storage.set("mediaProgressCache", JSON.stringify(map || {}));
  },
  removeMediaProgressCache: () => {
    storage.remove("mediaProgressCache");
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
