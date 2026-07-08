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

import axios from "axios";
import { api } from "../../utils/api";
import { readAutoCreds, writeAutoCreds } from "../../utils/autoCreds";
import { downloader } from "../../utils/downloader";
import { clearAllPending } from "../../utils/progressSync";
import { storage, storageHelper, secureStorage } from "../../utils/storage";
import { useUserStore } from "../../store/useUserStore";
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
}

describe("useUserStore", () => {
  beforeEach(() => {
    clearStorage();
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
    });

    it("keeps caches and pending syncs when the same account re-logs in", async () => {
      storageHelper.setLastSessionKey("https://a.example.com::userA");
      seedPreviousSessionLeftovers();

      await useUserStore.getState().login(CONFIG_A, { id: "userA" });

      expect(clearAllPending).not.toHaveBeenCalled();
      expect(storage.getString("shelvesCache_lib1")).toBeDefined();
      expect(storageHelper.getLastLibraryId()).toBe("lib1");
      expect(storageHelper.getLastPlaybackSession()).toEqual({ id: "sess1", libraryItemId: "item1" });
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

    it("wipes downloads, the progress disk cache, and reader keys when switching accounts", async () => {
      storageHelper.setLastSessionKey("https://a.example.com::userA");
      storageHelper.setMediaProgressCache({ item1: { libraryItemId: "item1", currentTime: 10 } });
      storage.set("ebookCfi_item1", "epubcfi(/6/4!/4/2)");
      storage.set("pdfPage_item1", "12");
      storage.set("last_interaction_item1", "listen");
      useDownloadStore.setState({
        completedDownloads: {
          item1: {
            id: "item1",
            libraryItemId: "item1",
            status: "completed",
            localFolderPath: "file:///downloads/item1/",
            parts: [],
          } as any,
        },
      });

      await useUserStore.getState().login(CONFIG_B, { id: "userB" });

      // The previous account's downloads are gone (files aborted + store emptied).
      expect(downloader.abortBookParts).toHaveBeenCalledWith("item1");
      expect(useDownloadStore.getState().completedDownloads).toEqual({});
      expect(useDownloadStore.getState().activeDownloads).toEqual({});
      // Disk progress cache does not carry over to the new account.
      expect(storageHelper.getMediaProgressCache()).toEqual({});
      // Per-item reader/interaction keys are wiped.
      expect(storage.getString("ebookCfi_item1")).toBeUndefined();
      expect(storage.getString("pdfPage_item1")).toBeUndefined();
      expect(storage.getString("last_interaction_item1")).toBeUndefined();
    });

    it("keeps downloads, the progress cache, and reader keys on same-account re-login", async () => {
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
      } as any;
      useDownloadStore.setState({ completedDownloads: { item1: dl } });

      await useUserStore.getState().login(CONFIG_A, { id: "userA" });

      expect(downloader.abortBookParts).not.toHaveBeenCalled();
      expect(useDownloadStore.getState().completedDownloads["item1"]).toBe(dl);
      expect(storageHelper.getMediaProgressCache()).toEqual({
        item1: { libraryItemId: "item1", currentTime: 10 },
      });
      expect(storage.getString("ebookCfi_item1")).toBe("epubcfi(/6/4!/4/2)");
      expect(storage.getString("pdfPage_item1")).toBe("12");
      expect(storage.getString("last_interaction_item1")).toBe("listen");
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
    });

    it("removes all downloads and wipes reader keys", async () => {
      useUserStore.setState({
        user: { id: "userA" },
        serverConnectionConfig: { address: "https://a.example.com", token: "tokA" },
      } as any);
      jest.mocked(api.post).mockResolvedValue({} as any);
      useDownloadStore.setState({
        completedDownloads: {
          item1: {
            id: "item1",
            libraryItemId: "item1",
            status: "completed",
            localFolderPath: "file:///downloads/item1/",
            parts: [],
          } as any,
        },
        activeDownloads: {
          item2: {
            id: "item2",
            libraryItemId: "item2",
            status: "downloading",
            localFolderPath: "file:///downloads/item2/",
            parts: [],
          } as any,
        },
      });
      storage.set("ebookCfi_item1", "epubcfi(/6/4!/4/2)");
      storage.set("pdfPage_item1", "12");
      storage.set("last_interaction_item1", "listen");

      await useUserStore.getState().logout();

      // Both completed AND in-flight downloads are gone.
      expect(downloader.abortBookParts).toHaveBeenCalledWith("item1");
      expect(downloader.abortBookParts).toHaveBeenCalledWith("item2");
      expect(useDownloadStore.getState().completedDownloads).toEqual({});
      expect(useDownloadStore.getState().activeDownloads).toEqual({});
      // Per-item reader/interaction keys wiped.
      expect(storage.getString("ebookCfi_item1")).toBeUndefined();
      expect(storage.getString("pdfPage_item1")).toBeUndefined();
      expect(storage.getString("last_interaction_item1")).toBeUndefined();
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
  });
});
