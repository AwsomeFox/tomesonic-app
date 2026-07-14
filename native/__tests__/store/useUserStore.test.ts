jest.mock("../../utils/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock("../../utils/autoCreds", () => ({
  writeAutoCreds: jest.fn().mockResolvedValue(undefined),
  readAutoCreds: jest.fn().mockResolvedValue(null),
  writeAutoDownloads: jest.fn().mockResolvedValue(undefined),
  writeWidgetState: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../utils/downloader", () => ({
  downloader: {
    abortBookParts: jest.fn().mockResolvedValue(undefined),
    resumeDownload: jest.fn().mockResolvedValue(undefined),
    sweepOrphanFolders: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock("../../utils/progressSync", () => ({
  syncProgress: jest.fn().mockResolvedValue(undefined),
  closeSession: jest.fn().mockResolvedValue(undefined),
  queueProgressPatch: jest.fn(),
  queueFinishedPatch: jest.fn(),
  queueEbookProgressPatch: jest.fn(),
  flushPendingSyncs: jest.fn().mockResolvedValue(undefined),
  clearAllPending: jest.fn(),
  remapPendingSids: jest.fn(),
  hasPendingWritesFor: jest.fn().mockReturnValue(false),
}));
// updateServerAddress probes the candidate address with RAW axios.
jest.mock("axios", () => {
  const mockAxios: any = {
    get: jest.fn(),
    post: jest.fn(),
    create: jest.fn(() => ({
      interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
      get: jest.fn(),
      post: jest.fn(),
      patch: jest.fn(),
      delete: jest.fn(),
      defaults: {},
    })),
    isAxiosError: (e: any) => !!e?.isAxiosError,
  };
  mockAxios.default = mockAxios;
  mockAxios.__esModule = true;
  return mockAxios;
});

import * as FileSystem from "expo-file-system/legacy";
import axios from "axios";
import { api } from "../../utils/api";
import { readAutoCreds, writeAutoCreds } from "../../utils/autoCreds";
import { downloader } from "../../utils/downloader";
import { clearAllPending } from "../../utils/progressSync";
import { storage, storageHelper, secureStorage } from "../../utils/storage";
import { db, dbStorage } from "../../utils/db";
import { useUserStore } from "../../store/useUserStore";
// Real module (api is mocked above): login/logout lazy-require it, and its
// cache lives in a module-level map + MMKV — both covered by the fakes here.
import { clearUpNextCache, findOrCreateUpNextPlaylist, upNextRemoveItem } from "../../utils/upNext";
import { useLibraryStore } from "../../store/useLibraryStore";
import { useDownloadStore } from "../../store/useDownloadStore";
// Real store (like useDownloadStore above): login/logout lazy-require it, and
// its disconnect() only touches the in-memory MMKV fakes — no network.
import { useRmabStore } from "../../store/useRmabStore";

const initialUser = useUserStore.getState();
const initialLibrary = useLibraryStore.getState();
const initialDownloads = useDownloadStore.getState();
const initialRmab = useRmabStore.getState();
const mockGet = jest.mocked(api.get);

function clearStorage() {
  storage.getAllKeys().forEach((k) => storage.remove(k));
  secureStorage.getAllKeys().forEach((k) => secureStorage.remove(k));
  // Downloads are namespaced by session in the DB now; login/logout touch it
  // (loadDownloadsFromDb re-adopts, deactivate aborts) — clear it between tests.
  dbStorage.getAllKeys().forEach((k) => dbStorage.remove(k));
}

describe("useUserStore", () => {
  beforeEach(() => {
    clearStorage();
    // The upNext playlist-id cache also lives in a module-level map that
    // clearStorage() can't reach — reset it so tests stay independent.
    clearUpNextCache();
    useUserStore.setState(initialUser, true);
    useLibraryStore.setState(initialLibrary, true);
    useDownloadStore.setState(initialDownloads, true);
    useRmabStore.setState(initialRmab, true);
    useDownloadStore.setState({ activeDownloads: {}, completedDownloads: {} });
    jest.mocked(readAutoCreds).mockResolvedValue(null);
  });

  describe("initialize", () => {
    it("stays logged out without a saved server config", async () => {
      await useUserStore.getState().initialize();
      const s = useUserStore.getState();
      expect(s.isInitialized).toBe(true);
      expect(s.user).toBeNull();
      expect(s.serverConnectionConfig).toBeNull();
      expect(writeAutoCreds).not.toHaveBeenCalled();
    });

    it("restores a saved session and records the session key", async () => {
      storageHelper.setServerConfig({
        address: "https://abs.example.com/",
        token: "tok",
        userId: "u1",
        username: "tony",
      });

      await useUserStore.getState().initialize();
      const s = useUserStore.getState();
      expect(s.user).toEqual({ id: "u1", username: "tony" });
      expect(storageHelper.getLastSessionKey()).toBe("https://abs.example.com::u1");
      expect(writeAutoCreds).toHaveBeenCalled();
    });

    it("adopts a fresher token pair from auto_creds.json", async () => {
      storageHelper.setServerConfig({
        address: "https://abs.example.com",
        token: "stale-token",
        refreshToken: "stale-refresh",
        userId: "u1",
        username: "tony",
      });
      jest.mocked(readAutoCreds).mockResolvedValue({
        server: "https://abs.example.com",
        token: "fresh-token",
        refreshToken: "fresh-refresh",
      });

      await useUserStore.getState().initialize();

      const persisted = storageHelper.getServerConfig();
      expect(persisted.token).toBe("fresh-token");
      expect(persisted.refreshToken).toBe("fresh-refresh");
      expect(useUserStore.getState().serverConnectionConfig.token).toBe("fresh-token");
    });

    it("ignores auto_creds for a different server", async () => {
      storageHelper.setServerConfig({
        address: "https://abs.example.com",
        token: "tok",
        userId: "u1",
      });
      jest.mocked(readAutoCreds).mockResolvedValue({
        server: "https://other.example.com",
        token: "other-token",
      });

      await useUserStore.getState().initialize();
      expect(storageHelper.getServerConfig().token).toBe("tok");
    });

    it("merges saved settings over the defaults", async () => {
      storageHelper.setUserSettings({ jumpForwardTime: 30 });
      await useUserStore.getState().initialize();
      const s = useUserStore.getState().settings;
      expect(s.jumpForwardTime).toBe(30);
      expect(s.jumpBackwardTime).toBe(10); // default preserved
    });

    it("is a no-op when already initialized", async () => {
      useUserStore.setState({ isInitialized: true, user: { id: "keep" } } as any);
      await useUserStore.getState().initialize();
      expect(useUserStore.getState().user).toEqual({ id: "keep" });
    });

    it("seeds user + isInitialized synchronously, before the auto_creds read resolves", async () => {
      storageHelper.setServerConfig({
        address: "https://abs.example.com",
        token: "tok",
        userId: "u1",
        username: "tony",
      });
      // Defer readAutoCreds so we can observe state BETWEEN the sync seed and
      // the async token adoption — this is the login-flash window.
      let resolveCreds: (v: any) => void = () => {};
      jest.mocked(readAutoCreds).mockReturnValue(
        new Promise((r) => {
          resolveCreds = r;
        }) as any
      );

      const pending = useUserStore.getState().initialize();
      // Synchronously (no await yet) the user must already be populated so the
      // navigator lands on Home, never flashing Connect.
      const mid = useUserStore.getState();
      expect(mid.isInitialized).toBe(true);
      expect(mid.user).toEqual({ id: "u1", username: "tony" });

      resolveCreds(null);
      await pending;
    });
  });

  describe("updateUserSettings", () => {
    it("merges and persists", async () => {
      await useUserStore.getState().updateUserSettings({ disableAutoRewind: true });
      expect(useUserStore.getState().settings.disableAutoRewind).toBe(true);
      expect(storageHelper.getUserSettings().disableAutoRewind).toBe(true);
      // Untouched keys survive.
      expect(useUserStore.getState().settings.mobileOrderBy).toBe("addedAt");
    });
  });

  describe("getMediaProgress composite keys", () => {
    it("looks up items by id and episodes by composite key", () => {
      useUserStore.setState({
        mediaProgress: {
          item1: { libraryItemId: "item1", progress: 0.5 },
          "pod1-ep1": { libraryItemId: "pod1", episodeId: "ep1", progress: 0.25 },
        },
      } as any);
      const g = useUserStore.getState().getMediaProgress;
      expect(g("item1")).toEqual({ libraryItemId: "item1", progress: 0.5 });
      expect(g("pod1", "ep1")).toEqual({ libraryItemId: "pod1", episodeId: "ep1", progress: 0.25 });
      expect(g("pod1")).toBeNull();
      expect(g("missing")).toBeNull();
    });
  });

  describe("loadMediaProgress freshest-wins merge", () => {
    it("indexes server progress by item id and composite episode key", async () => {
      mockGet.mockResolvedValue({
        data: {
          mediaProgress: [
            { libraryItemId: "item1", currentTime: 10, lastUpdate: 1000 },
            { libraryItemId: "pod1", episodeId: "ep1", currentTime: 20, lastUpdate: 1000 },
          ],
        },
      } as any);

      await useUserStore.getState().loadMediaProgress();
      const map = useUserStore.getState().mediaProgress;
      expect(map["item1"].currentTime).toBe(10);
      expect(map["pod1-ep1"].currentTime).toBe(20);
    });

    it("keeps a local entry that is meaningfully newer than the server's lastUpdate", async () => {
      const now = Date.now();
      useUserStore.setState({
        mediaProgress: {
          item1: { libraryItemId: "item1", currentTime: 500, updatedAt: now },
        },
      } as any);
      mockGet.mockResolvedValue({
        data: {
          mediaProgress: [
            // Server sync is stale (offline listening still queued locally).
            { libraryItemId: "item1", currentTime: 100, lastUpdate: now - 60_000, duration: 1000 },
          ],
        },
      } as any);

      await useUserStore.getState().loadMediaProgress();
      const entry = useUserStore.getState().mediaProgress["item1"];
      expect(entry.currentTime).toBe(500); // local position preserved
      expect(entry.duration).toBe(1000); // merged OVER the server entry, not replacing it
    });

    it("lets a newer server entry win", async () => {
      const now = Date.now();
      useUserStore.setState({
        mediaProgress: {
          item1: { libraryItemId: "item1", currentTime: 500, updatedAt: now - 60_000 },
        },
      } as any);
      mockGet.mockResolvedValue({
        data: {
          mediaProgress: [{ libraryItemId: "item1", currentTime: 900, lastUpdate: now }],
        },
      } as any);

      await useUserStore.getState().loadMediaProgress();
      expect(useUserStore.getState().mediaProgress["item1"].currentTime).toBe(900);
    });

    // REGRESSION: /api/me is built with the current account's token; if a
    // logout/account-switch lands while it's in flight, its response must not
    // write account A's progress into account B's (or a logged-out) store.
    it("bails without writing progress when the session changes during the /api/me await", async () => {
      useUserStore.setState({
        serverConnectionConfig: { address: "https://a.example.com", token: "tokA", userId: "uA" },
        mediaProgress: {},
      } as any);
      mockGet.mockImplementation(async () => {
        // Account B switches in while A's /api/me is in flight.
        useUserStore.setState({
          serverConnectionConfig: { address: "https://b.example.com", token: "tokB", userId: "uB" },
        } as any);
        return {
          data: { mediaProgress: [{ libraryItemId: "itemA", currentTime: 99, lastUpdate: 1 }] },
        } as any;
      });

      await useUserStore.getState().loadMediaProgress();
      expect(useUserStore.getState().mediaProgress["itemA"]).toBeUndefined();
    });

    it("keeps a local-only entry while its offline write is still queued", async () => {
      const { hasPendingWritesFor } = require("../../utils/progressSync");
      jest.mocked(hasPendingWritesFor).mockReturnValue(true);
      const now = Date.now();
      useUserStore.setState({
        mediaProgress: {
          "local-item": { libraryItemId: "local-item", currentTime: 42, updatedAt: now },
        },
      } as any);
      mockGet.mockResolvedValue({ data: { mediaProgress: [] } } as any);

      await useUserStore.getState().loadMediaProgress();
      expect(useUserStore.getState().mediaProgress["local-item"].currentTime).toBe(42);
    });

    it("drops a local-only entry with nothing queued (server deleted the progress)", async () => {
      // The map is disk-cached now: without this, a progress deletion made on
      // the web UI resurrected from the cache and re-uploaded forever.
      const { hasPendingWritesFor } = require("../../utils/progressSync");
      jest.mocked(hasPendingWritesFor).mockReturnValue(false);
      const now = Date.now();
      useUserStore.setState({
        mediaProgress: {
          "deleted-item": { libraryItemId: "deleted-item", currentTime: 42, updatedAt: now },
        },
      } as any);
      mockGet.mockResolvedValue({ data: { mediaProgress: [] } } as any);

      await useUserStore.getState().loadMediaProgress();
      expect(useUserStore.getState().mediaProgress["deleted-item"]).toBeUndefined();
    });

    it("skips setState when the merged result is identical (no re-render churn)", async () => {
      const entry = { libraryItemId: "item1", currentTime: 10, lastUpdate: 1000 };
      useUserStore.setState({ mediaProgress: { item1: entry } } as any);
      const before = useUserStore.getState().mediaProgress;
      mockGet.mockResolvedValue({ data: { mediaProgress: [entry] } } as any);

      await useUserStore.getState().loadMediaProgress();
      // Same object identity — setState was skipped.
      expect(useUserStore.getState().mediaProgress).toBe(before);
    });

    // REGRESSION (compare fix): `merged` is built in server-key order while
    // `prev` is in local-write order. A JSON.stringify compare reported
    // identical maps as DIFFERENT whenever the key order diverged, re-rendering
    // every card on every Home/Stats focus. The order-independent key-count +
    // per-entry shallow compare skips the setState for equal-but-reordered maps.
    it("skips setState for identical maps in a DIFFERENT key order (order-independent compare)", async () => {
      const a = { libraryItemId: "a", currentTime: 1, lastUpdate: 1000 };
      const b = { libraryItemId: "b", currentTime: 2, lastUpdate: 1000 };
      // prev in local-write order a,b.
      useUserStore.setState({ mediaProgress: { a, b } } as any);
      const before = useUserStore.getState().mediaProgress;
      // Server returns the SAME data in reverse order (b before a) as fresh
      // objects — JSON.stringify would have flagged this as changed.
      mockGet.mockResolvedValue({
        data: {
          mediaProgress: [
            { libraryItemId: "b", currentTime: 2, lastUpdate: 1000 },
            { libraryItemId: "a", currentTime: 1, lastUpdate: 1000 },
          ],
        },
      } as any);

      await useUserStore.getState().loadMediaProgress();
      // Same object identity — setState was skipped despite the key-order flip.
      expect(useUserStore.getState().mediaProgress).toBe(before);
    });

    it("still writes when an entry's VALUE changed (shallow compare catches it)", async () => {
      const a = { libraryItemId: "a", currentTime: 1, lastUpdate: 1000 };
      useUserStore.setState({ mediaProgress: { a } } as any);
      const before = useUserStore.getState().mediaProgress;
      mockGet.mockResolvedValue({
        data: { mediaProgress: [{ libraryItemId: "a", currentTime: 7, lastUpdate: 2000 }] },
      } as any);

      await useUserStore.getState().loadMediaProgress();
      expect(useUserStore.getState().mediaProgress).not.toBe(before);
      expect(useUserStore.getState().mediaProgress["a"].currentTime).toBe(7);
    });

    it("leaves state untouched when the fetch fails", async () => {
      const before = { item1: { libraryItemId: "item1", currentTime: 1 } };
      useUserStore.setState({ mediaProgress: before } as any);
      mockGet.mockRejectedValue(new Error("401"));
      await useUserStore.getState().loadMediaProgress();
      expect(useUserStore.getState().mediaProgress).toEqual(before);
    });
  });

  describe("login cross-account hygiene", () => {
    const CONFIG_A = { address: "https://a.example.com", token: "tokA", userId: "userA" };
    const CONFIG_B = { address: "https://b.example.com", token: "tokB", userId: "userB" };

    function seedPreviousSessionLeftovers() {
      storage.set("shelvesCache_lib1", JSON.stringify([{ id: "old" }]));
      storage.set("seriesListCache_lib1", JSON.stringify([{ id: "old" }]));
      storage.set("continueReadingCache_lib1", JSON.stringify([{ id: "old" }]));
      storageHelper.setLastLibraryId("lib1");
      storageHelper.setLastPlaybackSession({ id: "sess1", libraryItemId: "item1" });
    }

    it("wipes caches, pending syncs, and library selection when switching accounts", async () => {
      storageHelper.setLastSessionKey("https://a.example.com::userA");
      seedPreviousSessionLeftovers();
      useLibraryStore.setState({ currentLibraryId: "lib1", libraries: [{ id: "lib1" }] } as any);
      // "Want to Read" favorites + the cross-book play queue are per-account and
      // MUST NOT leak into a different account (item ids collide on a shared
      // server). Seed both so the switch's clear() / clearQueue() is verified
      // here, not only on the logout path.
      storage.set("favorites", JSON.stringify(["item1", "item2"]));
      storage.set("playbackQueue", JSON.stringify([{ libraryItemId: "item9" }]));
      // Seed the server "Up Next" playlist-id cache exactly as account A's
      // usage would: resolved from the server, cached in the module map + MMKV.
      // ABS playlists are per-user — account B reusing this id would aim its
      // first playlist POST/DELETE at A's playlist.
      mockGet.mockResolvedValueOnce({
        data: { results: [{ id: "plAccountA", name: "Up Next", items: [] }] },
      } as any);
      await findOrCreateUpNextPlaylist("lib1");
      expect(storage.getString("upNextPlaylistId_lib1")).toBe("plAccountA");

      await useUserStore.getState().login(CONFIG_B, { id: "userB", mediaProgress: [] });

      expect(clearAllPending).toHaveBeenCalled();
      expect(storage.getString("shelvesCache_lib1")).toBeUndefined();
      expect(storage.getString("seriesListCache_lib1")).toBeUndefined();
      expect(storage.getString("continueReadingCache_lib1")).toBeUndefined();
      expect(storageHelper.getLastLibraryId()).toBeNull();
      expect(storageHelper.getLastPlaybackSession()).toBeNull();
      expect(useLibraryStore.getState().currentLibraryId).toBeNull();
      expect(storageHelper.getLastSessionKey()).toBe("https://b.example.com::userB");
      expect(useUserStore.getState().user).toEqual({ id: "userB", mediaProgress: [] });
      // Favorites + queue cleared via their stores (key gone or emptied) so
      // account B can't inherit account A's Want-to-Read list or play queue.
      const favLeft = storage.getString("favorites");
      expect(favLeft === undefined || favLeft === "[]").toBe(true);
      const queueLeft = storage.getString("playbackQueue");
      expect(queueLeft === undefined || queueLeft === "[]").toBe(true);
      // The Up Next playlist-id cache is wiped: the persisted key is gone...
      expect(storage.getString("upNextPlaylistId_lib1")).toBeUndefined();
      // ...and the MODULE-LEVEL map too — B's first remove re-resolves from
      // the server (fresh GET) instead of DELETEing against A's playlist id.
      mockGet.mockClear();
      jest.mocked(api.delete).mockClear();
      mockGet.mockResolvedValueOnce({ data: { results: [] } } as any);
      await upNextRemoveItem("lib1", "item1");
      expect(mockGet).toHaveBeenCalledWith("/api/libraries/lib1/playlists");
      expect(api.delete).not.toHaveBeenCalled();
    });

    it("normalizes the persisted config to carry userId (falls back to user.id) so the stale-session guards work", async () => {
      await useUserStore
        .getState()
        .login({ address: "https://abs.test", token: "tok" } as any, { id: "userX", mediaProgress: [] });
      expect(useUserStore.getState().serverConnectionConfig.userId).toBe("userX");
      expect(storageHelper.getServerConfig()?.userId).toBe("userX");
    });

    it("clears the previous account's e-reader devices on account switch (no cross-account email leak)", async () => {
      storageHelper.setLastSessionKey("https://a.example.com::userA");
      // Account A's devices are in memory (a forced 401 logout doesn't clear
      // them); each carries an email that must not render under account B.
      useUserStore.setState({
        ereaderDevices: [{ name: "Kindle A", email: "a@example.com", users: ["userA"] }],
      } as any);
      // The async loadEReaderDevices() login fires returns nothing here.
      jest.mocked(api.post).mockResolvedValue({ data: {} } as any);

      await useUserStore.getState().login(CONFIG_B, { id: "userB", mediaProgress: [] });

      expect(useUserStore.getState().ereaderDevices).toEqual([]);
    });

    it("keeps caches and pending syncs when the same account re-logs in", async () => {
      storageHelper.setLastSessionKey("https://a.example.com::userA");
      seedPreviousSessionLeftovers();
      // Same-account re-login keeps the Up Next playlist-id cache too — it's
      // this account's own playlist, and the cache exists to avoid re-scans.
      storage.set("upNextPlaylistId_lib1", "plAccountA");

      await useUserStore.getState().login(CONFIG_A, { id: "userA" });

      expect(clearAllPending).not.toHaveBeenCalled();
      expect(storage.getString("shelvesCache_lib1")).toBeDefined();
      expect(storageHelper.getLastLibraryId()).toBe("lib1");
      expect(storageHelper.getLastPlaybackSession()).toEqual({ id: "sess1", libraryItemId: "item1" });
      expect(storage.getString("upNextPlaylistId_lib1")).toBe("plAccountA");
    });

    it("clears per-item link locks (linkedProgress) when switching accounts, keeping device prefs", async () => {
      storageHelper.setLastSessionKey("https://a.example.com::userA");
      storageHelper.setUserSettings({ jumpForwardTime: 20, linkedProgress: { book1: true } });
      useUserStore.setState({
        settings: { ...useUserStore.getState().settings, jumpForwardTime: 20, linkedProgress: { book1: true } },
      } as any);

      await useUserStore.getState().login(CONFIG_B, { id: "userB" });

      // B must not inherit A's per-item link locks (ids collide on a shared server).
      expect(storageHelper.getUserSettings().linkedProgress).toEqual({});
      expect(useUserStore.getState().settings.linkedProgress).toEqual({});
      // Device-level prefs are preserved.
      expect(storageHelper.getUserSettings().jumpForwardTime).toBe(20);
    });

    it("KEEPS per-item link locks on same-account re-login", async () => {
      storageHelper.setLastSessionKey("https://a.example.com::userA");
      storageHelper.setUserSettings({ linkedProgress: { book1: true } });
      useUserStore.setState({
        settings: { ...useUserStore.getState().settings, linkedProgress: { book1: true } },
      } as any);

      await useUserStore.getState().login(CONFIG_A, { id: "userA" });

      expect(storageHelper.getUserSettings().linkedProgress).toEqual({ book1: true });
    });

    it("first-ever login (no previous key) does not wipe anything", async () => {
      seedPreviousSessionLeftovers();
      await useUserStore.getState().login(CONFIG_A, { id: "userA" });
      expect(clearAllPending).not.toHaveBeenCalled();
      expect(storage.getString("shelvesCache_lib1")).toBeDefined();
    });

    it("seeds mediaProgress from the login payload", async () => {
      await useUserStore.getState().login(CONFIG_A, {
        id: "userA",
        mediaProgress: [
          { libraryItemId: "item1", progress: 0.3 },
          { libraryItemId: "pod1", episodeId: "ep2", progress: 0.7 },
        ],
      });
      const map = useUserStore.getState().mediaProgress;
      expect(map["item1"].progress).toBe(0.3);
      expect(map["pod1-ep2"].progress).toBe(0.7);
    });

    it("RETAINS the departing account's downloads on disk when switching accounts (no wipe), surfaces only B's", async () => {
      storageHelper.setLastSessionKey("https://a.example.com::userA");
      storageHelper.setMediaProgressCache({ item1: { libraryItemId: "item1", currentTime: 10 } });
      storage.set("ebookCfi_item1", "epubcfi(/6/4!/4/2)");
      storage.set("pdfPage_item1", "12");
      storage.set("last_interaction_item1", "listen");
      // A completed download AND an in-flight one, both belonging to account A,
      // persisted to the DB (as real downloads are).
      const aDone = {
        id: "item1",
        libraryItemId: "item1",
        status: "completed",
        localFolderPath: "file:///downloads/item1/",
        parts: [],
        sessionKey: "https://a.example.com::userA",
      } as any;
      const aActive = {
        id: "item2",
        libraryItemId: "item2",
        status: "downloading",
        localFolderPath: "file:///downloads/item2/",
        parts: [],
        sessionKey: "https://a.example.com::userA",
      } as any;
      db.saveDownloadItem(aDone);
      db.saveDownloadItem(aActive);
      useDownloadStore.setState({
        completedDownloads: { item1: aDone },
        activeDownloads: { item2: aActive },
      });

      await useUserStore.getState().login(CONFIG_B, { id: "userB" });

      // In-flight download is stopped (would 401 under B) — but NOT deleted.
      expect(downloader.abortBookParts).toHaveBeenCalledWith("item2");
      // A's files were never deleted on the switch.
      expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
      // A's rows survive on disk for re-adoption when the user returns.
      const ids = db.getAllDownloads().map((d) => d.id).sort();
      expect(ids).toEqual(["item1", "item2"]);
      // The store now surfaces only account B's downloads (none here).
      expect(useDownloadStore.getState().completedDownloads).toEqual({});
      expect(useDownloadStore.getState().activeDownloads).toEqual({});
      // Per-item reader/interaction keys are still wiped (item ids collide on a
      // shared server — unchanged behavior).
      expect(storage.getString("ebookCfi_item1")).toBeUndefined();
      expect(storage.getString("pdfPage_item1")).toBeUndefined();
      expect(storage.getString("last_interaction_item1")).toBeUndefined();
    });

    it("RE-ADOPTS the account's downloads on same-account re-login (no re-download)", async () => {
      storageHelper.setLastSessionKey("https://a.example.com::userA");
      storageHelper.setMediaProgressCache({ item1: { libraryItemId: "item1", currentTime: 10 } });
      storage.set("ebookCfi_item1", "epubcfi(/6/4!/4/2)");
      storage.set("pdfPage_item1", "12");
      storage.set("last_interaction_item1", "listen");
      const dl = {
        id: "item1",
        libraryItemId: "item1",
        status: "completed",
        localFolderPath: "file:///downloads/item1/",
        parts: [],
        sessionKey: "https://a.example.com::userA",
      } as any;
      db.saveDownloadItem(dl);
      useDownloadStore.setState({ completedDownloads: { item1: dl } });

      await useUserStore.getState().login(CONFIG_A, { id: "userA" });

      expect(downloader.abortBookParts).not.toHaveBeenCalled();
      expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
      // Re-surfaced from its namespace (re-adopted from the DB, same data).
      expect(useDownloadStore.getState().completedDownloads["item1"]).toMatchObject({
        id: "item1",
        status: "completed",
      });
      expect(storageHelper.getMediaProgressCache()).toEqual({
        item1: { libraryItemId: "item1", currentTime: 10 },
      });
      expect(storage.getString("ebookCfi_item1")).toBe("epubcfi(/6/4!/4/2)");
      expect(storage.getString("pdfPage_item1")).toBe("12");
      expect(storage.getString("last_interaction_item1")).toBe("listen");
    });

    it("switch A→B→A retains BOTH accounts' downloads end-to-end (no re-download)", async () => {
      // A's book and B's book both already on disk (previously downloaded).
      db.saveDownloadItem({
        id: "aBook", libraryItemId: "aBook", status: "completed", parts: [],
        localFolderPath: "file:///downloads/aBook/", sessionKey: "https://a.example.com::userA",
      } as any);
      db.saveDownloadItem({
        id: "bBook", libraryItemId: "bBook", status: "completed", parts: [],
        localFolderPath: "file:///downloads/bBook/", sessionKey: "https://b.example.com::userB",
      } as any);

      // Start on A.
      storageHelper.setLastSessionKey("https://a.example.com::userA");
      useDownloadStore.getState().loadDownloadsFromDb();
      expect(Object.keys(useDownloadStore.getState().completedDownloads)).toEqual(["aBook"]);

      // Switch A→B (real logout, then login to B).
      await useUserStore.getState().logout();
      await useUserStore.getState().login(CONFIG_B, { id: "userB" });
      expect(Object.keys(useDownloadStore.getState().completedDownloads)).toEqual(["bBook"]);

      // Switch B→A — A's download re-adopted from disk.
      await useUserStore.getState().logout();
      await useUserStore.getState().login(CONFIG_A, { id: "userA" });
      expect(Object.keys(useDownloadStore.getState().completedDownloads)).toEqual(["aBook"]);

      // Nothing was ever deleted; both rows survive.
      expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
      expect(db.getAllDownloads().map((d) => d.id).sort()).toEqual(["aBook", "bBook"]);
    });
  });

  describe("logout", () => {
    it("clears credentials, caches, session identity, and store state", async () => {
      storageHelper.setServerConfig({ address: "https://a.example.com", token: "tokA" });
      storageHelper.setLastSessionKey("https://a.example.com::userA");
      storageHelper.setLastLibraryId("lib1");
      storage.set("shelvesCache_lib1", "[]");
      useUserStore.setState({
        user: { id: "userA" },
        serverConnectionConfig: { address: "https://a.example.com", token: "tokA" },
        mediaProgress: { item1: {} },
      } as any);
      jest.mocked(api.post).mockResolvedValue({} as any);
      // Seed the Up Next playlist-id cache as this account's usage would
      // (module map + MMKV) — whoever logs in next must not inherit it.
      mockGet.mockResolvedValueOnce({
        data: { results: [{ id: "plAccountA", name: "Up Next", items: [] }] },
      } as any);
      await findOrCreateUpNextPlaylist("lib1");
      expect(storage.getString("upNextPlaylistId_lib1")).toBe("plAccountA");

      await useUserStore.getState().logout();

      expect(api.post).toHaveBeenCalledWith("/logout");
      expect(clearAllPending).toHaveBeenCalled();
      expect(storageHelper.getServerConfig()).toBeNull();
      expect(storageHelper.getLastSessionKey()).toBeNull();
      expect(storageHelper.getLastLibraryId()).toBeNull();
      expect(storage.getString("shelvesCache_lib1")).toBeUndefined();
      const s = useUserStore.getState();
      expect(s.user).toBeNull();
      expect(s.serverConnectionConfig).toBeNull();
      expect(s.mediaProgress).toEqual({});
      // Up Next playlist-id cache wiped: MMKV key gone AND the module map is
      // cold — the next account's first remove re-resolves (fresh GET) instead
      // of DELETEing against this account's playlist id.
      expect(storage.getString("upNextPlaylistId_lib1")).toBeUndefined();
      mockGet.mockClear();
      jest.mocked(api.delete).mockClear();
      mockGet.mockResolvedValueOnce({ data: { results: [] } } as any);
      await upNextRemoveItem("lib1", "item1");
      expect(mockGet).toHaveBeenCalledWith("/api/libraries/lib1/playlists");
      expect(api.delete).not.toHaveBeenCalled();
    });

    it("stops surfacing downloads (aborts in-flight) but RETAINS files on disk, and wipes reader keys", async () => {
      useUserStore.setState({
        user: { id: "userA" },
        serverConnectionConfig: { address: "https://a.example.com", token: "tokA" },
      } as any);
      storageHelper.setLastSessionKey("https://a.example.com::userA");
      jest.mocked(api.post).mockResolvedValue({} as any);
      const done = {
        id: "item1", libraryItemId: "item1", status: "completed", parts: [],
        localFolderPath: "file:///downloads/item1/", sessionKey: "https://a.example.com::userA",
      } as any;
      const active = {
        id: "item2", libraryItemId: "item2", status: "downloading", parts: [],
        localFolderPath: "file:///downloads/item2/", sessionKey: "https://a.example.com::userA",
      } as any;
      db.saveDownloadItem(done);
      db.saveDownloadItem(active);
      useDownloadStore.setState({
        completedDownloads: { item1: done },
        activeDownloads: { item2: active },
      });
      storage.set("ebookCfi_item1", "epubcfi(/6/4!/4/2)");
      storage.set("pdfPage_item1", "12");
      storage.set("last_interaction_item1", "listen");
      // New per-account state that must not leak to the next login: reader
      // highlights/speed + per-book rate (bare-id keyed), plus the favorites list
      // and cross-book play queue.
      storage.set("reader_highlights_item1", JSON.stringify([{ cfi: "x", text: "hi" }]));
      storage.set("reader_speed_item1", "260");
      storage.set("perBookRate", JSON.stringify({ item1: 1.5 }));
      storage.set("favorites", JSON.stringify(["item1", "item2"]));
      storage.set("playbackQueue", JSON.stringify([{ libraryItemId: "item9" }]));

      await useUserStore.getState().logout();

      // In-flight download is aborted (no dangling 401s)...
      expect(downloader.abortBookParts).toHaveBeenCalledWith("item2");
      // ...the store stops surfacing everything...
      expect(useDownloadStore.getState().completedDownloads).toEqual({});
      expect(useDownloadStore.getState().activeDownloads).toEqual({});
      // ...but the files + DB rows are RETAINED for re-adoption (a "Switch
      // Server/User" is a switch, not a data wipe).
      expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
      expect(db.getAllDownloads().map((d) => d.id).sort()).toEqual(["item1", "item2"]);
      // Per-item reader/interaction keys wiped.
      expect(storage.getString("ebookCfi_item1")).toBeUndefined();
      expect(storage.getString("pdfPage_item1")).toBeUndefined();
      expect(storage.getString("last_interaction_item1")).toBeUndefined();
      // New per-account state wiped so the next login can't inherit it.
      expect(storage.getString("reader_highlights_item1")).toBeUndefined();
      expect(storage.getString("reader_speed_item1")).toBeUndefined();
      expect(storage.getString("perBookRate")).toBeUndefined();
      // Favorites + queue cleared via their stores (key gone or emptied).
      const favLeft = storage.getString("favorites");
      expect(favLeft === undefined || favLeft === "[]").toBe(true);
      const queueLeft = storage.getString("playbackQueue");
      expect(queueLeft === undefined || queueLeft === "[]").toBe(true);
    });

    it("clears the PERSISTED per-item link locks (linkedProgress) but keeps other device settings", async () => {
      storageHelper.setServerConfig({ address: "https://a.example.com", token: "tokA" });
      // Persisted settings carry account A's per-item locks AND a device pref.
      storageHelper.setUserSettings({ jumpForwardTime: 30, linkedProgress: { book1: true, book2: true } });
      useUserStore.setState({
        user: { id: "userA" },
        serverConnectionConfig: { address: "https://a.example.com", token: "tokA" },
        settings: { ...useUserStore.getState().settings, jumpForwardTime: 30, linkedProgress: { book1: true } },
      } as any);
      jest.mocked(api.post).mockResolvedValue({} as any);

      await useUserStore.getState().logout();

      const persisted = storageHelper.getUserSettings();
      // linkedProgress wiped from the persisted blob (initialize would merge it back).
      expect(persisted.linkedProgress).toEqual({});
      // Device-level prefs survive the logout.
      expect(persisted.jumpForwardTime).toBe(30);
      // In-memory settings reset to defaults — no leftover locks.
      expect(useUserStore.getState().settings.linkedProgress).toEqual({});
    });

    it("still clears local state when the server logout call fails", async () => {
      useUserStore.setState({
        user: { id: "userA" },
        serverConnectionConfig: { address: "https://a.example.com", token: "tokA" },
      } as any);
      jest.mocked(api.post).mockRejectedValue(new Error("timeout"));

      await useUserStore.getState().logout();
      expect(useUserStore.getState().user).toBeNull();
    });
  });

  describe("RMAB hygiene (connection must not survive to the next account)", () => {
    const CONFIG_A = { address: "https://a.example.com", token: "tokA", userId: "userA" };
    const CONFIG_B = { address: "https://b.example.com", token: "tokB", userId: "userB" };

    function seedRmabConnection() {
      secureStorage.set(
        "rmab_config",
        JSON.stringify({ url: "https://rmab.test", accessToken: "a", refreshToken: "r" })
      );
      storage.set("rmab_requestedAsins", JSON.stringify({ B01: "pending" }));
      useRmabStore.setState({
        configured: true,
        serverUrl: "https://rmab.test",
        username: "tony",
        authMode: "jwt",
        isAdmin: true,
        requestedAsins: { B01: "pending" },
      } as any);
    }

    it("logout disconnects RMAB: config, requested-state, and store identity are gone", async () => {
      seedRmabConnection();
      useUserStore.setState({
        user: { id: "userA" },
        serverConnectionConfig: { address: "https://a.example.com", token: "tokA" },
      } as any);
      jest.mocked(api.post).mockResolvedValue({} as any);

      await useUserStore.getState().logout();

      const rmab = useRmabStore.getState();
      expect(rmab.configured).toBe(false);
      expect(rmab.serverUrl).toBeNull();
      expect(rmab.isAdmin).toBe(false);
      expect(rmab.requestedAsins).toEqual({});
      expect(secureStorage.getString("rmab_config")).toBeUndefined();
      expect(storage.getString("rmab_requestedAsins")).toBeUndefined();
    });

    it("switching accounts on login disconnects RMAB too", async () => {
      storageHelper.setLastSessionKey("https://a.example.com::userA");
      seedRmabConnection();

      await useUserStore.getState().login(CONFIG_B, { id: "userB" });

      const rmab = useRmabStore.getState();
      expect(rmab.configured).toBe(false);
      expect(rmab.requestedAsins).toEqual({});
      expect(secureStorage.getString("rmab_config")).toBeUndefined();
      expect(storage.getString("rmab_requestedAsins")).toBeUndefined();
    });

    it("SAME-account re-login keeps the RMAB connection", async () => {
      storageHelper.setLastSessionKey("https://a.example.com::userA");
      seedRmabConnection();

      await useUserStore.getState().login(CONFIG_A, { id: "userA" });

      const rmab = useRmabStore.getState();
      expect(rmab.configured).toBe(true);
      expect(rmab.serverUrl).toBe("https://rmab.test");
      expect(rmab.requestedAsins).toEqual({ B01: "pending" });
      expect(secureStorage.getString("rmab_config")).toBeDefined();
      expect(storage.getString("rmab_requestedAsins")).toBeDefined();
    });
  });

  describe("mediaProgress disk-mirror write-through (leading throttle + trailing flush)", () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    it("writes once on the leading edge and flushes the LATEST map after the window", () => {
      jest.useFakeTimers();
      // Push the fake clock well past any prior write window so the next
      // mutation takes the leading edge instead of scheduling a trailing flush.
      jest.advanceTimersByTime(5000);

      const setCache = jest.spyOn(storageHelper, "setMediaProgressCache");

      const map1 = { item1: { libraryItemId: "item1", currentTime: 10 } };
      useUserStore.setState({ mediaProgress: map1 } as any);
      // Leading edge: persisted immediately.
      expect(setCache).toHaveBeenCalledTimes(1);
      expect(setCache).toHaveBeenLastCalledWith(map1);

      // A second quick mutation inside the 3s window does NOT write immediately.
      const map2 = { item1: { libraryItemId: "item1", currentTime: 11 } };
      useUserStore.setState({ mediaProgress: map2 } as any);
      expect(setCache).toHaveBeenCalledTimes(1);

      // After the window elapses the trailing flush persists the LATEST map.
      jest.advanceTimersByTime(3000);
      expect(setCache).toHaveBeenCalledTimes(2);
      expect(setCache).toHaveBeenLastCalledWith(map2);

      setCache.mockRestore();
    });
  });

  describe("loadEReaderDevices", () => {
    it("stores the devices from /api/authorize", async () => {
      jest.mocked(api.post).mockResolvedValue({
        data: { ereaderDevices: [{ name: "My Kindle" }, { name: "Kobo" }] },
      } as any);
      await useUserStore.getState().loadEReaderDevices();
      expect(api.post).toHaveBeenCalledWith("/api/authorize");
      expect(useUserStore.getState().ereaderDevices.map((d: any) => d.name)).toEqual([
        "My Kindle",
        "Kobo",
      ]);
    });

    it("keeps the current list when the response has no device array", async () => {
      useUserStore.setState({ ereaderDevices: [{ name: "Existing" }] } as any);
      jest.mocked(api.post).mockResolvedValue({ data: {} } as any);
      await useUserStore.getState().loadEReaderDevices();
      expect(useUserStore.getState().ereaderDevices).toEqual([{ name: "Existing" }]);
    });

    it("drops a late response when the session changed underneath it (logout race)", async () => {
      useUserStore.setState({
        serverConnectionConfig: { address: "https://abs.test", token: "tok1" },
      } as any);
      let release: any;
      jest.mocked(api.post).mockReturnValue(
        new Promise((res) => (release = res)) as any
      );
      const pending = useUserStore.getState().loadEReaderDevices();
      // Logout (or account switch) lands before the response.
      useUserStore.setState({ serverConnectionConfig: null, ereaderDevices: [] } as any);
      release({ data: { ereaderDevices: [{ name: "Ghost Kindle" }] } });
      await pending;
      expect(useUserStore.getState().ereaderDevices).toEqual([]);
    });

    it("swallows request failures (devices only gate a secondary action)", async () => {
      jest.mocked(api.post).mockRejectedValue(new Error("500"));
      await expect(useUserStore.getState().loadEReaderDevices()).resolves.toBeUndefined();
    });

    it("keeps the freshly-fetched devices when the token ROTATES mid-request (same account)", async () => {
      useUserStore.setState({
        serverConnectionConfig: { address: "https://abs.test", token: "old", userId: "userA" },
        ereaderDevices: [],
      } as any);
      jest.mocked(api.post).mockImplementation(async () => {
        // The 401 interceptor rotated the access token for the SAME account
        // mid-flight — a strict-token guard would wrongly drop this valid list.
        useUserStore.setState({
          serverConnectionConfig: { address: "https://abs.test", token: "rotated", userId: "userA" },
        } as any);
        return { data: { ereaderDevices: [{ name: "Kindle" }] } } as any;
      });
      await useUserStore.getState().loadEReaderDevices();
      expect(useUserStore.getState().ereaderDevices.map((d: any) => d.name)).toEqual(["Kindle"]);
    });

    it("drops the devices when the ACCOUNT switches mid-request", async () => {
      useUserStore.setState({
        serverConnectionConfig: { address: "https://abs.test", token: "old", userId: "userA" },
        ereaderDevices: [],
      } as any);
      jest.mocked(api.post).mockImplementation(async () => {
        useUserStore.setState({
          serverConnectionConfig: { address: "https://b.test", token: "tokB", userId: "userB" },
        } as any);
        return { data: { ereaderDevices: [{ name: "A's Kindle" }] } } as any;
      });
      await useUserStore.getState().loadEReaderDevices();
      expect(useUserStore.getState().ereaderDevices).toEqual([]);
    });

    it("drops the devices on a token-only switch when the config has NO userId (legacy fallback)", async () => {
      // Legacy config without userId: the guard can't compare userId, so it must
      // fall back to token equality — a token-only cross-account switch still
      // blocks the late response (no device-email leak).
      useUserStore.setState({
        serverConnectionConfig: { address: "https://abs.test", token: "tokA" },
        ereaderDevices: [],
      } as any);
      jest.mocked(api.post).mockImplementation(async () => {
        useUserStore.setState({
          serverConnectionConfig: { address: "https://abs.test", token: "tokB" },
        } as any);
        return { data: { ereaderDevices: [{ name: "A's Kindle", email: "a@x.com" }] } } as any;
      });
      await useUserStore.getState().loadEReaderDevices();
      expect(useUserStore.getState().ereaderDevices).toEqual([]);
    });
  });

  describe("updateServerAddress (in-place, keeps downloads)", () => {
    const mockAxiosGet = (axios as any).get as jest.Mock;

    beforeEach(() => {
      mockAxiosGet.mockReset();
      useUserStore.setState({
        user: { id: "u1", username: "bob" },
        serverConnectionConfig: { address: "https://old.example.com", token: "tok", userId: "u1", refreshToken: "ref" },
      } as any);
      storageHelper.setServerConfig({ address: "https://old.example.com", token: "tok", userId: "u1", refreshToken: "ref" });
      storageHelper.setLastSessionKey("https://old.example.com::u1");
      useLibraryStore.setState({ currentLibraryId: "lib1" } as any);
    });

    it("moves the address in place without wiping downloads when the same account answers", async () => {
      const removeAllDownloads = jest.fn().mockResolvedValue(undefined);
      useDownloadStore.setState({ removeAllDownloads } as any);
      mockAxiosGet.mockResolvedValue({ data: { id: "u1", username: "bob" } });

      const res = await useUserStore.getState().updateServerAddress("https://new.example.com");

      expect(res.ok).toBe(true);
      expect(useUserStore.getState().serverConnectionConfig.address).toBe("https://new.example.com");
      expect(storageHelper.getServerConfig()?.address).toBe("https://new.example.com");
      // Re-keyed to the new address so a later restore isn't seen as an account switch.
      expect(storageHelper.getLastSessionKey()).toBe("https://new.example.com::u1");
      // The whole point: downloads/progress are NOT wiped.
      expect(removeAllDownloads).not.toHaveBeenCalled();
      // AA creds re-mirrored to the new host.
      expect(writeAutoCreds).toHaveBeenCalledWith("https://new.example.com", "tok", "lib1", "ref", true);
    });

    it("tries https:// first for a bare hostname", async () => {
      mockAxiosGet.mockResolvedValue({ data: { id: "u1" } });
      await useUserStore.getState().updateServerAddress("new.example.com");
      expect(mockAxiosGet).toHaveBeenCalledWith(
        "https://new.example.com/api/me",
        expect.objectContaining({ headers: { Authorization: "Bearer tok" } })
      );
    });

    it("refuses to switch in place when the server reports a DIFFERENT account", async () => {
      mockAxiosGet.mockResolvedValue({ data: { id: "someone-else" } });
      const res = await useUserStore.getState().updateServerAddress("https://new.example.com");
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/different account/i);
      // Config untouched.
      expect(useUserStore.getState().serverConnectionConfig.address).toBe("https://old.example.com");
      expect(storageHelper.getLastSessionKey()).toBe("https://old.example.com::u1");
    });

    it("returns an error and leaves the config untouched when the address is unreachable", async () => {
      mockAxiosGet.mockRejectedValue(new Error("network down"));
      const res = await useUserStore.getState().updateServerAddress("https://unreachable.example.com");
      expect(res.ok).toBe(false);
      expect(useUserStore.getState().serverConnectionConfig.address).toBe("https://old.example.com");
    });

    it("refuses a 200 that lacks a user id when the account has a known userId (proxy page)", async () => {
      // A proxy/error page can 200 without an ABS user id — that must not count
      // as proof of the same account, so the address is NOT switched.
      mockAxiosGet.mockResolvedValue({ data: { app: "not-abs" } });
      const res = await useUserStore.getState().updateServerAddress("https://proxy.example.com");
      expect(res.ok).toBe(false);
      expect(useUserStore.getState().serverConnectionConfig.address).toBe("https://old.example.com");
    });

    // DATA-LOSS REGRESSION: the address portion of the `${address}::${userId}`
    // session key changed, but download rows + queued sids still carried the OLD
    // key. Without an in-place migration, loadDownloadsFromDb filtered every
    // download out (files remain but "vanish") and the flush loops skipped the
    // stranded pending entries forever. The move must RE-STAMP them old → new.
    it("MIGRATES downloads + pending sids in place on an address change (re-stamps old→new, still adopted)", async () => {
      const { remapPendingSids } = require("../../utils/progressSync");
      jest.mocked(remapPendingSids).mockClear();
      mockAxiosGet.mockResolvedValue({ data: { id: "u1", username: "bob" } });

      // A completed download tagged with the OLD session key, both persisted and
      // surfaced in the store (as a real adopted download would be).
      const oldRow = {
        id: "item1",
        libraryItemId: "item1",
        status: "completed",
        parts: [],
        localFolderPath: "file:///downloads/item1/",
        sessionKey: "https://old.example.com::u1",
      } as any;
      db.saveDownloadItem(oldRow);
      useDownloadStore.setState({ completedDownloads: { item1: oldRow }, activeDownloads: {} });

      const res = await useUserStore.getState().updateServerAddress("https://new.example.com");
      expect(res.ok).toBe(true);

      // The persisted DB row is re-stamped to the NEW identity...
      const row = db.getAllDownloads().find((d) => d.id === "item1");
      expect(row.sessionKey).toBe("https://new.example.com::u1");
      // ...and so is the in-memory copy.
      expect(useDownloadStore.getState().completedDownloads["item1"].sessionKey).toBe(
        "https://new.example.com::u1"
      );

      // Loading under the NEW session STILL surfaces it (not orphaned).
      useDownloadStore.getState().loadDownloadsFromDb();
      expect(useDownloadStore.getState().completedDownloads["item1"]).toBeTruthy();

      // Queued offline sids were re-keyed old → new so the flush loops adopt them.
      expect(remapPendingSids).toHaveBeenCalledWith(
        "https://old.example.com::u1",
        "https://new.example.com::u1"
      );
    });

    it("does NOT migrate when the resolved address is unchanged (no redundant re-stamp)", async () => {
      const { remapPendingSids } = require("../../utils/progressSync");
      jest.mocked(remapPendingSids).mockClear();
      // Probe resolves to the SAME normalized address already configured.
      mockAxiosGet.mockResolvedValue({ data: { id: "u1" } });
      const res = await useUserStore.getState().updateServerAddress("https://old.example.com");
      expect(res.ok).toBe(true);
      expect(remapPendingSids).not.toHaveBeenCalled();
    });
  });

  describe("per-item progress link (Link reading & listening)", () => {
    it("persists the lock per item and reflects it via isProgressLinked", async () => {
      expect(useUserStore.getState().isProgressLinked("book1")).toBe(false);

      await useUserStore.getState().setProgressLinked("book1", true);
      expect(useUserStore.getState().isProgressLinked("book1")).toBe(true);
      // Written through to persisted settings (survives a reload).
      expect(storageHelper.getUserSettings()?.linkedProgress?.book1).toBe(true);
      // Scoped per item — a different book stays unlinked.
      expect(useUserStore.getState().isProgressLinked("book2")).toBe(false);
    });

    it("unlinking removes the entry rather than storing a false (map stays small)", async () => {
      await useUserStore.getState().setProgressLinked("book1", true);
      await useUserStore.getState().setProgressLinked("book1", false);
      expect(useUserStore.getState().isProgressLinked("book1")).toBe(false);
      expect("book1" in (useUserStore.getState().settings.linkedProgress || {})).toBe(false);
    });
  });
});
