import * as SecureStore from "expo-secure-store";
import { storage, secureStorage, storageHelper } from "../../utils/storage";

beforeEach(() => {
  storage.getAllKeys().forEach((k) => storage.remove(k));
  secureStorage.getAllKeys().forEach((k) => secureStorage.remove(k));
});

describe("encryption key bootstrap", () => {
  it("generated and persisted a 64-char hex key in the OS keystore at module load", () => {
    // The key was created when utils/storage first loaded (import above).
    const key = SecureStore.getItem("tomesonic-mmkv-encryption-key");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reuses the existing key on subsequent loads instead of regenerating", () => {
    const before = SecureStore.getItem("tomesonic-mmkv-encryption-key");
    jest.isolateModules(() => {
      require("../../utils/storage");
    });
    expect(SecureStore.getItem("tomesonic-mmkv-encryption-key")).toBe(before);
  });

  it("falls back to an unencrypted store when the keystore is unavailable", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    (SecureStore.getItem as jest.Mock).mockImplementationOnce(() => {
      throw new Error("keystore down");
    });
    let mod: any;
    jest.isolateModules(() => {
      mod = require("../../utils/storage");
    });
    // The app still launches: the store exists and round-trips.
    mod.secureStorage.set("k", "v");
    expect(mod.secureStorage.getString("k")).toBe("v");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Encryption key unavailable"),
      expect.any(Error)
    );
    warn.mockRestore();
  });
});

describe("storageHelper", () => {
  it("round-trips user settings as JSON", () => {
    expect(storageHelper.getUserSettings()).toBeNull();
    storageHelper.setUserSettings({ hapticFeedback: "light", jumpForwardTime: 30 });
    expect(storageHelper.getUserSettings()).toEqual({
      hapticFeedback: "light",
      jumpForwardTime: 30,
    });
  });

  it("round-trips server config through the SECURE store", () => {
    expect(storageHelper.getServerConfig()).toBeNull();
    const config = { address: "http://abs.local", token: "t1", refreshToken: "r1" };
    storageHelper.setServerConfig(config);
    expect(storageHelper.getServerConfig()).toEqual(config);
    // Stored in secureStorage, not the plain store.
    expect(secureStorage.getString("serverConfig")).toBeTruthy();
    expect(storage.getString("serverConfig")).toBeUndefined();

    storageHelper.clearServerConfig();
    expect(storageHelper.getServerConfig()).toBeNull();
  });

  it("getRefreshToken reads from the stored server config", () => {
    expect(storageHelper.getRefreshToken()).toBeNull();
    storageHelper.setServerConfig({ address: "a", token: "t", refreshToken: "refresh-1" });
    expect(storageHelper.getRefreshToken()).toBe("refresh-1");
    storageHelper.setServerConfig({ address: "a", token: "t" });
    expect(storageHelper.getRefreshToken()).toBeNull();
  });

  it("round-trips the last session key in PLAIN storage (survives logout wipes)", () => {
    expect(storageHelper.getLastSessionKey()).toBeNull();
    storageHelper.setLastSessionKey("http://abs.local::user1");
    expect(storageHelper.getLastSessionKey()).toBe("http://abs.local::user1");
    expect(storage.getString("lastSessionKey")).toBe("http://abs.local::user1");
    storageHelper.removeLastSessionKey();
    expect(storageHelper.getLastSessionKey()).toBeNull();
  });

  it("round-trips theme mode", () => {
    expect(storageHelper.getThemeMode()).toBeNull();
    storageHelper.setThemeMode("dark");
    expect(storageHelper.getThemeMode()).toBe("dark");
  });

  it("useDynamicColors defaults to true and round-trips", () => {
    expect(storageHelper.getUseDynamicColors()).toBe(true);
    storageHelper.setUseDynamicColors(false);
    expect(storageHelper.getUseDynamicColors()).toBe(false);
    storageHelper.setUseDynamicColors(true);
    expect(storageHelper.getUseDynamicColors()).toBe(true);
  });

  it("round-trips the last library id", () => {
    expect(storageHelper.getLastLibraryId()).toBeNull();
    storageHelper.setLastLibraryId("lib1");
    expect(storageHelper.getLastLibraryId()).toBe("lib1");
    storageHelper.removeLastLibraryId();
    expect(storageHelper.getLastLibraryId()).toBeNull();
  });

  it("round-trips the last playback session as JSON", () => {
    expect(storageHelper.getLastPlaybackSession()).toBeNull();
    const session = { id: "s1", libraryItemId: "li1", currentTime: 42.5 };
    storageHelper.setLastPlaybackSession(session);
    expect(storageHelper.getLastPlaybackSession()).toEqual(session);
    storageHelper.removeLastPlaybackSession();
    expect(storageHelper.getLastPlaybackSession()).toBeNull();
  });

  it("playback rate defaults to 1.0 and rejects invalid values", () => {
    expect(storageHelper.getPlaybackRate()).toBe(1.0);

    storageHelper.setPlaybackRate(1.5);
    expect(storageHelper.getPlaybackRate()).toBe(1.5);

    // Invalid writes are ignored — the stored rate stays.
    storageHelper.setPlaybackRate(0);
    expect(storageHelper.getPlaybackRate()).toBe(1.5);
    storageHelper.setPlaybackRate(-2);
    expect(storageHelper.getPlaybackRate()).toBe(1.5);
    storageHelper.setPlaybackRate(NaN as any);
    expect(storageHelper.getPlaybackRate()).toBe(1.5);
  });

  it("playback rate falls back to 1.0 when a bad value is somehow stored", () => {
    storage.set("playbackRate", -1);
    expect(storageHelper.getPlaybackRate()).toBe(1.0);
  });
});
