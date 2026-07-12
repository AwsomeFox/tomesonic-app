/**
 * PERSISTENCE-IDENTITY TRIPWIRES.
 *
 * Why these literals must NEVER change: the app UPDATES IN PLACE. MMKV files
 * are named by instance id, and every persisted record lives inside the file
 * its id names. Rename an instance id (or a key inside it) and the next app
 * update silently opens a brand-new EMPTY store while the user's real data —
 * server login, listening positions, download registry, settings — sits
 * orphaned in the old file forever. No functional test models an update (they
 * all start from empty storage and use whatever the current code writes), so
 * a rename passes the whole suite while destroying every real install's data.
 * These tests pin the on-disk identity itself.
 *
 * If one of these fails, DO NOT update the expectation — you are about to
 * orphan user data. Either revert the rename or write an explicit migration
 * that copies the old namespace forward first.
 */

// Config-recording MMKV mock: same in-memory behavior as the global
// jest.setup.ts mock, plus it records every createMMKV(config) call so the
// instance IDS the app opens are assertable. (A plain array exposed on the
// mocked module — not a jest.fn's mock.calls, which `clearMocks: true` wipes
// before the first test, and not a module-level const, which initializes
// AFTER the hoisted imports already created the instances.)
jest.mock("react-native-mmkv", () => {
  const createdConfigs: any[] = [];
  class MMKV {
    private map = new Map<string, string | number | boolean | Uint8Array>();
    constructor(_config?: any) {}
    set(key: string, value: string | number | boolean | Uint8Array) {
      this.map.set(key, value);
    }
    getString(key: string) {
      const v = this.map.get(key);
      return typeof v === "string" ? v : undefined;
    }
    getNumber(key: string) {
      const v = this.map.get(key);
      return typeof v === "number" ? v : undefined;
    }
    getBoolean(key: string) {
      const v = this.map.get(key);
      return typeof v === "boolean" ? v : undefined;
    }
    contains(key: string) {
      return this.map.has(key);
    }
    delete(key: string) {
      this.map.delete(key);
    }
    remove(key: string) {
      this.map.delete(key);
    }
    getAllKeys() {
      return Array.from(this.map.keys());
    }
    clearAll() {
      this.map.clear();
    }
    recrypt(_key?: string) {}
  }
  return {
    MMKV,
    createMMKV: (config?: any) => {
      createdConfigs.push(config);
      return new MMKV(config);
    },
    __createdConfigs: createdConfigs,
  };
});

import * as fs from "fs";
import * as path from "path";
import * as SecureStore from "expo-secure-store";
import { storage, storageHelper } from "../../utils/storage";
import { dbStorage } from "../../utils/db";

const mockMmkvConfigs: any[] = (require("react-native-mmkv") as any).__createdConfigs;

const ROOT = path.resolve(__dirname, "../..");
const readSource = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("MMKV instance identity (on-disk file names)", () => {
  it('utils/storage.ts opens the settings store with id EXACTLY "tomesonic-settings"', () => {
    expect(mockMmkvConfigs.map((c) => c?.id)).toContain("tomesonic-settings");
    // The settings store is UNencrypted (no encryptionKey) — encrypting it in
    // place would also make the existing plaintext file unreadable.
    const cfg = mockMmkvConfigs.find((c) => c?.id === "tomesonic-settings");
    expect(cfg.encryptionKey).toBeUndefined();
  });

  it('utils/storage.ts opens the secure store with id EXACTLY "tomesonic-secure" (encrypted)', () => {
    const cfg = mockMmkvConfigs.find((c) => c?.id === "tomesonic-secure");
    expect(cfg).toBeDefined();
    // Encrypted with the keystore-held key (64-char hex, generated at first
    // launch). Dropping the encryptionKey — or changing how it's derived —
    // makes the existing encrypted file (auth token, server config)
    // undecryptable and force-logs-out every user on update.
    expect(cfg.encryptionKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the MMKV encryption key lives in SecureStore under EXACTLY "tomesonic-mmkv-encryption-key"', () => {
    // utils/storage.ts generated/fetched the key at module load through the
    // (memory-backed) SecureStore mock — the key must be findable under this
    // exact name. Rename it and every update regenerates a NEW key that cannot
    // decrypt the existing tomesonic-secure file.
    const stored = SecureStore.getItem("tomesonic-mmkv-encryption-key");
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    // And it is exactly the key the secure store was opened with.
    const cfg = mockMmkvConfigs.find((c) => c?.id === "tomesonic-secure");
    expect(cfg.encryptionKey).toBe(stored);
  });

  it('utils/db.ts opens the downloads/progress DB with id EXACTLY "tomesonic-db"', () => {
    // The download registry, local media progress, folders and logs all live
    // here. Renaming orphans every completed download's DB row — files remain
    // on disk but the app forgets it ever downloaded them.
    expect(mockMmkvConfigs.map((c) => c?.id)).toContain("tomesonic-db");
    expect(dbStorage).toBeDefined();
  });
});

describe("storageHelper key-name round-trips (raw key literals)", () => {
  beforeEach(() => {
    storage.clearAll();
  });

  it('lastLibraryId reads/writes the raw key "lastLibraryId"', () => {
    storageHelper.setLastLibraryId("lib42");
    expect(storage.getString("lastLibraryId")).toBe("lib42");
    // Reverse direction: a value persisted by the previous app version under
    // this key must be readable by the current helper.
    storage.clearAll();
    storage.set("lastLibraryId", "lib-old");
    expect(storageHelper.getLastLibraryId()).toBe("lib-old");
    storageHelper.removeLastLibraryId();
    expect(storage.contains("lastLibraryId")).toBe(false);
  });

  it('useDynamicColors reads/writes the raw boolean key "useDynamicColors" (absent → default true)', () => {
    // Default when never written — a renamed key would ALSO land here,
    // silently resetting the user's explicit "off" back to on.
    expect(storageHelper.getUseDynamicColors()).toBe(true);
    storageHelper.setUseDynamicColors(false);
    expect(storage.getBoolean("useDynamicColors")).toBe(false);
    storage.clearAll();
    storage.set("useDynamicColors", false);
    expect(storageHelper.getUseDynamicColors()).toBe(false);
  });

  it('libraryHubSegment reads/writes the raw key "libraryHubSegment"', () => {
    storageHelper.setLibraryHubSegment("authors");
    expect(storage.getString("libraryHubSegment")).toBe("authors");
    storage.clearAll();
    storage.set("libraryHubSegment", "series");
    expect(storageHelper.getLibraryHubSegment()).toBe("series");
    expect(storageHelper.getLibraryHubSegment()).not.toBeNull();
  });
});

describe('cross-module key "logout_reason" (api.ts writer ↔ ConnectScreen consumer)', () => {
  // Two independent modules share this raw MMKV key with NO shared constant:
  // utils/api.ts forceLogout() writes it (module-private, fired from the 401
  // interceptor) and ConnectScreen reads + clears it to explain the bounce.
  // Renaming either side silently kills the "session expired" banner. The
  // writer isn't directly invocable (private closure inside the axios
  // interceptor), so pin BOTH source literals.
  it("utils/api.ts writes logout_reason = session_expired", () => {
    const src = readSource("utils/api.ts");
    expect(src).toMatch(/storage\.set\(\s*["']logout_reason["']\s*,\s*["']session_expired["']\s*\)/);
  });

  it("screens/ConnectScreen.tsx reads the same literal and clears the key", () => {
    const src = readSource("screens/ConnectScreen.tsx");
    expect(src).toMatch(/getString\(\s*["']logout_reason["']\s*\)\s*===\s*["']session_expired["']/);
    expect(src).toMatch(/storage\.remove\(\s*["']logout_reason["']\s*\)/);
  });
});

describe("mediaProgressCache corrupt-blob degradation (storage.ts shape validation)", () => {
  // The disk progress cache seeds the in-memory progress map on an OFFLINE
  // cold start. Corrupted-but-valid JSON handed to callers that assume a plain
  // keyed object would crash the boot path — every corrupt shape must degrade
  // to {} without throwing.
  beforeEach(() => {
    storage.clearAll();
  });

  it("a stored ARRAY degrades to {}", () => {
    storage.set("mediaProgressCache", JSON.stringify([{ id: "a" }, 2]));
    expect(storageHelper.getMediaProgressCache()).toEqual({});
  });

  it("a stored bare NUMBER degrades to {}", () => {
    storage.set("mediaProgressCache", "42");
    expect(storageHelper.getMediaProgressCache()).toEqual({});
  });

  it("truncated JSON (torn write) degrades to {} without throwing", () => {
    storage.set("mediaProgressCache", '{"book1":{"currentTime":120');
    expect(() => storageHelper.getMediaProgressCache()).not.toThrow();
    expect(storageHelper.getMediaProgressCache()).toEqual({});
  });

  it('a stored "null" / missing key degrades to {}', () => {
    storage.set("mediaProgressCache", "null");
    expect(storageHelper.getMediaProgressCache()).toEqual({});
    storage.clearAll();
    expect(storageHelper.getMediaProgressCache()).toEqual({});
  });

  it("a valid keyed object round-trips intact (the raw key is 'mediaProgressCache')", () => {
    storageHelper.setMediaProgressCache({ book1: { currentTime: 120, isFinished: false } });
    expect(storage.getString("mediaProgressCache")).toBeDefined();
    expect(storageHelper.getMediaProgressCache()).toEqual({
      book1: { currentTime: 120, isFinished: false },
    });
  });
});
