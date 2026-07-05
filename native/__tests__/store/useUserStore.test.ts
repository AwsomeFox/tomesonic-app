jest.mock("../../utils/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock("../../utils/autoCreds", () => ({
  writeAutoCreds: jest.fn().mockResolvedValue(undefined),
  readAutoCreds: jest.fn().mockResolvedValue(null),
  writeAutoDownloads: jest.fn().mockResolvedValue(undefined),
  writeWidgetState: jest.fn().mockResolvedValue(undefined),
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

import { api } from "../../utils/api";
import { readAutoCreds, writeAutoCreds } from "../../utils/autoCreds";
import { clearAllPending } from "../../utils/progressSync";
import { storage, storageHelper, secureStorage } from "../../utils/storage";
import { useUserStore } from "../../store/useUserStore";
import { useLibraryStore } from "../../store/useLibraryStore";

const initialUser = useUserStore.getState();
const initialLibrary = useLibraryStore.getState();
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

    it("keeps a local-only entry the server does not know about yet", async () => {
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

    it("wipes caches, pending syncs, and library selection when switching accounts", () => {
      storageHelper.setLastSessionKey("https://a.example.com::userA");
      seedPreviousSessionLeftovers();
      useLibraryStore.setState({ currentLibraryId: "lib1", libraries: [{ id: "lib1" }] } as any);

      useUserStore.getState().login(CONFIG_B, { id: "userB", mediaProgress: [] });

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

    it("keeps caches and pending syncs when the same account re-logs in", () => {
      storageHelper.setLastSessionKey("https://a.example.com::userA");
      seedPreviousSessionLeftovers();

      useUserStore.getState().login(CONFIG_A, { id: "userA" });

      expect(clearAllPending).not.toHaveBeenCalled();
      expect(storage.getString("shelvesCache_lib1")).toBeDefined();
      expect(storageHelper.getLastLibraryId()).toBe("lib1");
      expect(storageHelper.getLastPlaybackSession()).toEqual({ id: "sess1", libraryItemId: "item1" });
    });

    it("first-ever login (no previous key) does not wipe anything", () => {
      seedPreviousSessionLeftovers();
      useUserStore.getState().login(CONFIG_A, { id: "userA" });
      expect(clearAllPending).not.toHaveBeenCalled();
      expect(storage.getString("shelvesCache_lib1")).toBeDefined();
    });

    it("seeds mediaProgress from the login payload", () => {
      useUserStore.getState().login(CONFIG_A, {
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
});
