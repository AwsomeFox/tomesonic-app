/**
 * Shared harness for the resilience suites: the persistent "MMKV disk", the
 * common jest.mock factories, and the process-death boot() helper.
 *
 * WHY `.cjs`: jest's resolved default testMatch includes
 * `**\/__tests__\/**\/*.[jt]s?(x)`, so a .ts/.js helper inside __tests__/
 * would be collected as a (test-less, failing) suite — and `npx jest
 * resilience` would match its path. `.cjs` is in moduleFileExtensions (so it
 * requires fine) but matches neither testMatch nor the babel transform, so
 * this file must stay plain CommonJS.
 *
 * KILL MODEL: boot() calls jest.resetModules(), wiping the module registry —
 * zustand stores, module-level throttle bookkeeping, every jest.setup mock
 * instance — while the MMKV maps live on globalThis and survive, exactly like
 * flash storage across a process kill. The consuming suites' jest.mock
 * factories re-run on the next require and reconnect to the same disk.
 *
 * NOTE: the expo-secure-store mock (jest.setup.ts) keeps its data in a
 * module-scoped Map, so it is WIPED by every boot() — the INVERSE of the real
 * OS Keystore, which outlives the process. Harmless today: everything these
 * suites persist (serverConfig included) lives in the "tomesonic-secure" /
 * "tomesonic-settings" MMKV instances on the globalThis disk map, and the
 * MMKV mock ignores the encryption key that a Keystore wipe would rotate.
 *
 * NOTE: the download-store db layer (utils/db) is MMKV-backed
 * (`createMMKV({ id: "tomesonic-db" })`), NOT SQLite — so mmkvDiskModule()
 * already persists it across boot() with no extra fake. completedDownloads
 * kill/rehydrate (plus namespace isolation and corrupt-record drop) is covered
 * by downloadStoreRehydrate.test.ts.
 */

/* eslint-disable */

// ---- the persistent MMKV "disk" --------------------------------------------
// Returned by `jest.mock("react-native-mmkv", () => require(...).mmkvDiskModule())`.
// The factory re-runs after every jest.resetModules(); the maps it reconnects
// to live on globalThis, keyed by MMKV instance id.
function mmkvDiskModule() {
  const g = globalThis;
  if (!g.__mmkvDisk) g.__mmkvDisk = new Map();
  class MMKV {
    constructor(config) {
      const id = (config && config.id) || "mmkv.default";
      if (!g.__mmkvDisk.has(id)) g.__mmkvDisk.set(id, new Map());
      this.map = g.__mmkvDisk.get(id);
    }
    set(key, value) {
      this.map.set(key, value);
    }
    getString(key) {
      const v = this.map.get(key);
      return typeof v === "string" ? v : undefined;
    }
    getNumber(key) {
      const v = this.map.get(key);
      return typeof v === "number" ? v : undefined;
    }
    getBoolean(key) {
      const v = this.map.get(key);
      return typeof v === "boolean" ? v : undefined;
    }
    contains(key) {
      return this.map.has(key);
    }
    delete(key) {
      this.map.delete(key);
    }
    remove(key) {
      this.map.delete(key);
    }
    getAllKeys() {
      return Array.from(this.map.keys());
    }
    clearAll() {
      this.map.clear();
    }
    recrypt() {}
  }
  return { MMKV, createMMKV: (config) => new MMKV(config) };
}

/** Wipe every MMKV instance's map — the only way tests may clear the "disk"
 *  (a kill must never do it). */
function wipeDisk() {
  const d = globalThis.__mmkvDisk;
  if (d) d.forEach((m) => m.clear());
}

// ---- shared jest.mock factories ---------------------------------------------
// Each returns a FRESH module with fresh jest.fn()s. jest.mock factories
// re-run after jest.resetModules(), so every boot() gets clean mocks —
// matching a fresh process. (`jest` is injected into every jest-loaded
// module's scope, including untransformed .cjs.)

function apiMockModule() {
  return {
    api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
  };
}

function progressSyncMockModule() {
  return {
    syncProgress: jest.fn().mockResolvedValue(undefined),
    closeSession: jest.fn().mockResolvedValue(undefined),
    queueProgressPatch: jest.fn(),
    queueFinishedPatch: jest.fn(),
    queueEbookProgressPatch: jest.fn(),
    flushPendingSyncs: jest.fn().mockResolvedValue(undefined),
    clearAllPending: jest.fn(),
    reconcileLinkedProgress: jest.fn(),
  };
}

function autoCredsMockModule() {
  return {
    writeAutoCreds: jest.fn().mockResolvedValue(undefined),
    readAutoCreds: jest.fn().mockResolvedValue(null),
    writeAutoDownloads: jest.fn().mockResolvedValue(undefined),
    writeWidgetState: jest.fn().mockResolvedValue(undefined),
  };
}

function upNextMockModule() {
  return {
    upNextAddItem: jest.fn().mockResolvedValue(undefined),
    upNextRemoveItem: jest.fn().mockResolvedValue(undefined),
    upNextListItems: jest.fn().mockResolvedValue([]),
  };
}

// ---- fresh "process" over the same disk --------------------------------------
/**
 * boot(opts?) → a fresh module registry (the "kill") re-required over the
 * SAME MMKV disk (the "reboot").
 *
 *   opts.stores       (default true)  require the zustand playback/user stores
 *   opts.progressSync (default false) require the REAL utils/progressSync
 *
 * References returned by a previous boot() are the DEAD process's modules —
 * always use the newest world object.
 */
function boot(opts = {}) {
  jest.resetModules();
  const rntp = require("react-native-track-player");
  const w = {
    rntp,
    TrackPlayer: rntp.default,
    api: require("../../utils/api").api,
    // storage, storageHelper, secureStorage
    ...require("../../utils/storage"),
  };
  if (opts.stores !== false) {
    w.playback = require("../../store/usePlaybackStore");
    w.user = require("../../store/useUserStore");
  }
  if (opts.progressSync) {
    w.ps = require("../../utils/progressSync");
  }
  return w;
}

module.exports = {
  mmkvDiskModule,
  wipeDisk,
  apiMockModule,
  progressSyncMockModule,
  autoCredsMockModule,
  upNextMockModule,
  boot,
};
