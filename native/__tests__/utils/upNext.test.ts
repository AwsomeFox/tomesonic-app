jest.mock("../../utils/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

import { storage, storageHelper } from "../../utils/storage";
import { api } from "../../utils/api";
import {
  UP_NEXT_PLAYLIST_NAME,
  findOrCreateUpNextPlaylist,
  upNextAddItem,
  upNextRemoveItem,
  upNextListItems,
  clearUpNextCache,
} from "../../utils/upNext";

// The module caches resolved playlist ids in a module-level Map keyed by
// libraryId (backed by MMKV). Wiping MMKV between tests can't clear that Map,
// so each test uses a UNIQUE libraryId — this keeps the cache-hit and
// cache-miss paths independent without a test-only reset hook in production.
let _libSeq = 0;
function freshLib(): string {
  return `lib_${++_libSeq}`;
}

beforeEach(() => {
  jest.mocked(api.get).mockReset();
  jest.mocked(api.post).mockReset();
  jest.mocked(api.delete).mockReset();
  storage.getAllKeys().forEach((k) => storage.remove(k));
});

describe("upNext utils", () => {
  describe("findOrCreateUpNextPlaylist", () => {
    it("matches an existing playlist by exact name and caches its id", async () => {
      const LIB = freshLib();
      jest.mocked(api.get).mockResolvedValue({
        data: {
          results: [
            { id: "other", name: "My List" },
            { id: "pl1", name: UP_NEXT_PLAYLIST_NAME, items: [] },
          ],
        },
      } as any);

      const pl = await findOrCreateUpNextPlaylist(LIB);
      expect(pl?.id).toBe("pl1");
      // Cached to MMKV for the next call.
      expect(storage.getString(`upNextPlaylistId_${LIB}`)).toBe("pl1");
      expect(api.post).not.toHaveBeenCalled();
    });

    it("creates the playlist when missing and a firstItem is supplied", async () => {
      const LIB = freshLib();
      jest.mocked(api.get).mockResolvedValue({ data: { results: [] } } as any);
      jest.mocked(api.post).mockResolvedValue({
        data: { id: "new1", name: UP_NEXT_PLAYLIST_NAME, items: [{ libraryItemId: "b1" }] },
      } as any);

      const pl = await findOrCreateUpNextPlaylist(LIB, { libraryItemId: "b1", title: "Book 1" });
      expect(pl?.id).toBe("new1");
      expect(api.post).toHaveBeenCalledWith("/api/playlists", {
        libraryId: LIB,
        name: UP_NEXT_PLAYLIST_NAME,
        items: [{ libraryItemId: "b1" }],
      });
      expect(storage.getString(`upNextPlaylistId_${LIB}`)).toBe("new1");
    });

    it("does NOT create when missing and no firstItem given", async () => {
      const LIB = freshLib();
      jest.mocked(api.get).mockResolvedValue({ data: { results: [] } } as any);
      const pl = await findOrCreateUpNextPlaylist(LIB);
      expect(pl).toBeNull();
      expect(api.post).not.toHaveBeenCalled();
    });

    it("returns null (no throw) when the network fails", async () => {
      const LIB = freshLib();
      jest.mocked(api.get).mockRejectedValue(new Error("offline"));
      await expect(findOrCreateUpNextPlaylist(LIB, { libraryItemId: "b1" })).resolves.toBeNull();
    });

    it("passes episodeId through when creating for a podcast episode", async () => {
      const LIB = freshLib();
      jest.mocked(api.get).mockResolvedValue({ data: { results: [] } } as any);
      jest.mocked(api.post).mockResolvedValue({ data: { id: "new2", items: [] } } as any);
      await findOrCreateUpNextPlaylist(LIB, { libraryItemId: "pod1", episodeId: "e1" });
      expect(api.post).toHaveBeenCalledWith("/api/playlists", {
        libraryId: LIB,
        name: UP_NEXT_PLAYLIST_NAME,
        items: [{ libraryItemId: "pod1", episodeId: "e1" }],
      });
    });
  });

  describe("upNextAddItem", () => {
    it("adds the item via POST /item when the playlist already exists without it", async () => {
      const LIB = freshLib();
      jest.mocked(api.get).mockResolvedValue({
        data: { results: [{ id: "pl1", name: UP_NEXT_PLAYLIST_NAME, items: [] }] },
      } as any);
      jest.mocked(api.post).mockResolvedValue({ data: { id: "pl1" } } as any);

      await upNextAddItem(LIB, { libraryItemId: "b2" });
      expect(api.post).toHaveBeenCalledWith("/api/playlists/pl1/item", { libraryItemId: "b2" });
    });

    it("skips the POST when the item is already present (dedupe)", async () => {
      const LIB = freshLib();
      jest.mocked(api.get).mockResolvedValue({
        data: {
          results: [
            { id: "pl1", name: UP_NEXT_PLAYLIST_NAME, items: [{ libraryItemId: "b2" }] },
          ],
        },
      } as any);

      await upNextAddItem(LIB, { libraryItemId: "b2" });
      // Only the find GET ran — no add POST, no create POST.
      expect(api.post).not.toHaveBeenCalled();
    });

    it("does not POST again for a freshly-created playlist (item seeded on create)", async () => {
      const LIB = freshLib();
      jest.mocked(api.get).mockResolvedValue({ data: { results: [] } } as any);
      jest.mocked(api.post).mockResolvedValue({
        data: { id: "new1", name: UP_NEXT_PLAYLIST_NAME, items: [{ libraryItemId: "b3" }] },
      } as any);

      await upNextAddItem(LIB, { libraryItemId: "b3" });
      // Exactly one POST (the create) — the item was seeded, so no /item POST.
      expect(api.post).toHaveBeenCalledTimes(1);
      expect(api.post).toHaveBeenCalledWith("/api/playlists", expect.anything());
    });

    it("swallows network errors (never throws)", async () => {
      const LIB = freshLib();
      jest.mocked(api.get).mockRejectedValue(new Error("offline"));
      await expect(upNextAddItem(LIB, { libraryItemId: "b2" })).resolves.toBeUndefined();
    });
  });

  describe("upNextRemoveItem", () => {
    it("DELETEs the item using a cached playlist id", async () => {
      const LIB = freshLib();
      storage.set(`upNextPlaylistId_${LIB}`, "plCached");
      jest.mocked(api.delete).mockResolvedValue({ data: {} } as any);

      await upNextRemoveItem(LIB, "b2");
      expect(api.delete).toHaveBeenCalledWith("/api/playlists/plCached/item/b2");
      // No scan needed — the id was cached.
      expect(api.get).not.toHaveBeenCalled();
    });

    it("resolves the playlist id via GET when nothing is cached", async () => {
      const LIB = freshLib();
      jest.mocked(api.get).mockResolvedValue({
        data: { results: [{ id: "pl9", name: UP_NEXT_PLAYLIST_NAME, items: [] }] },
      } as any);
      jest.mocked(api.delete).mockResolvedValue({ data: {} } as any);

      await upNextRemoveItem(LIB, "b2");
      expect(api.delete).toHaveBeenCalledWith("/api/playlists/pl9/item/b2");
    });

    it("tolerates a 404 and clears the cached id (playlist auto-deleted)", async () => {
      const LIB = freshLib();
      storage.set(`upNextPlaylistId_${LIB}`, "plGone");
      jest.mocked(api.delete).mockRejectedValue({ response: { status: 404 } });

      await expect(upNextRemoveItem(LIB, "b2")).resolves.toBeUndefined();
      // Stale id dropped so the next add re-creates the playlist.
      expect(storage.getString(`upNextPlaylistId_${LIB}`)).toBeUndefined();
    });

    it("no-ops when there is no playlist on the server", async () => {
      const LIB = freshLib();
      jest.mocked(api.get).mockResolvedValue({ data: { results: [] } } as any);
      await upNextRemoveItem(LIB, "b2");
      expect(api.delete).not.toHaveBeenCalled();
    });

    it("swallows offline errors (never throws)", async () => {
      const LIB = freshLib();
      storage.set(`upNextPlaylistId_${LIB}`, "plCached");
      jest.mocked(api.delete).mockRejectedValue(new Error("offline"));
      await expect(upNextRemoveItem(LIB, "b2")).resolves.toBeUndefined();
    });
  });

  describe("upNextListItems", () => {
    it("maps playlist items to QueueItem shape with a built coverUrl", async () => {
      const LIB = freshLib();
      storageHelper.setServerConfig({ address: "https://abs.test", token: "TOK" });
      jest.mocked(api.get).mockResolvedValue({
        data: {
          results: [
            {
              id: "pl1",
              name: UP_NEXT_PLAYLIST_NAME,
              items: [
                {
                  libraryItemId: "b1",
                  libraryItem: { id: "b1", media: { metadata: { title: "Book 1", authorName: "Auth" } } },
                },
                {
                  libraryItemId: "pod1",
                  episodeId: "e1",
                  libraryItem: { id: "pod1", media: { metadata: { title: "Pod" } } },
                },
              ],
            },
          ],
        },
      } as any);

      const items = await upNextListItems(LIB);
      expect(items).toHaveLength(2);
      expect(items[0]).toEqual({
        libraryItemId: "b1",
        title: "Book 1",
        author: "Auth",
        coverUrl: "https://abs.test/api/items/b1/cover?width=400&format=webp&token=TOK",
      });
      expect(items[1].episodeId).toBe("e1");
    });

    it("returns [] when there is no playlist", async () => {
      const LIB = freshLib();
      jest.mocked(api.get).mockResolvedValue({ data: { results: [] } } as any);
      await expect(upNextListItems(LIB)).resolves.toEqual([]);
    });

    it("returns [] (no throw) when offline", async () => {
      const LIB = freshLib();
      jest.mocked(api.get).mockRejectedValue(new Error("offline"));
      await expect(upNextListItems(LIB)).resolves.toEqual([]);
    });
  });

  describe("clearUpNextCache (cross-account contract)", () => {
    it("wipes every upNextPlaylistId_* MMKV key across libraries, leaving other keys alone", async () => {
      const LIB_A = freshLib();
      const LIB_B = freshLib();
      // Populate via the real find-or-create flow (memory + MMKV both set).
      jest.mocked(api.get).mockResolvedValue({
        data: { results: [{ id: "plA", name: UP_NEXT_PLAYLIST_NAME, items: [] }] },
      } as any);
      await findOrCreateUpNextPlaylist(LIB_A);
      jest.mocked(api.get).mockResolvedValue({
        data: { results: [{ id: "plB", name: UP_NEXT_PLAYLIST_NAME, items: [] }] },
      } as any);
      await findOrCreateUpNextPlaylist(LIB_B);
      storage.set("favorites", JSON.stringify(["item1"]));
      expect(storage.getString(`upNextPlaylistId_${LIB_A}`)).toBe("plA");
      expect(storage.getString(`upNextPlaylistId_${LIB_B}`)).toBe("plB");

      clearUpNextCache();

      expect(storage.getString(`upNextPlaylistId_${LIB_A}`)).toBeUndefined();
      expect(storage.getString(`upNextPlaylistId_${LIB_B}`)).toBeUndefined();
      // Unrelated keys survive.
      expect(storage.getString("favorites")).toBe(JSON.stringify(["item1"]));
    });

    // THE cross-account scenario: account A resolved the id, account B logs in
    // on the same server. Without the clear, B's first remove would DELETE
    // against A's playlist — trusting server-side per-user scoping (a 404) as
    // the only guard. After the clear, the module must re-resolve fresh.
    it("after clear, the next remove RE-RESOLVES via GET instead of DELETEing the stale id (memory AND MMKV cold)", async () => {
      const LIB = freshLib();
      // Account A resolves + caches its playlist id (memory + MMKV).
      jest.mocked(api.get).mockResolvedValue({
        data: { results: [{ id: "plAccountA", name: UP_NEXT_PLAYLIST_NAME, items: [] }] },
      } as any);
      await findOrCreateUpNextPlaylist(LIB);
      expect(storage.getString(`upNextPlaylistId_${LIB}`)).toBe("plAccountA");

      clearUpNextCache(); // account switch / logout

      // Under account B's credentials the server lists B's OWN playlist.
      jest.mocked(api.get).mockReset();
      jest.mocked(api.get).mockResolvedValue({
        data: {
          results: [
            { id: "plAccountB", name: UP_NEXT_PLAYLIST_NAME, items: [{ libraryItemId: "b2" }] },
          ],
        },
      } as any);
      jest.mocked(api.delete).mockResolvedValue({ data: {} } as any);

      await upNextRemoveItem(LIB, "b2");

      // A fresh list scan ran — proving BOTH cache layers were cold (a live
      // in-memory entry would have skipped the GET even with MMKV wiped)...
      expect(api.get).toHaveBeenCalledWith(`/api/libraries/${LIB}/playlists`);
      // ...and the DELETE targets B's freshly-resolved playlist, never A's.
      expect(api.delete).toHaveBeenCalledWith("/api/playlists/plAccountB/item/b2");
      expect(api.delete).not.toHaveBeenCalledWith(expect.stringContaining("plAccountA"));
    });

    it("after clear, the next add find-or-creates fresh instead of POSTing to the stale playlist", async () => {
      const LIB = freshLib();
      jest.mocked(api.get).mockResolvedValue({
        data: { results: [{ id: "plAccountA", name: UP_NEXT_PLAYLIST_NAME, items: [] }] },
      } as any);
      await findOrCreateUpNextPlaylist(LIB);

      clearUpNextCache();

      // Nothing exists yet under the new account — the add must create anew.
      jest.mocked(api.get).mockReset();
      jest.mocked(api.get).mockResolvedValue({ data: { results: [] } } as any);
      jest.mocked(api.post).mockReset();
      jest.mocked(api.post).mockResolvedValue({
        data: { id: "plAccountB", items: [{ libraryItemId: "b1" }] },
      } as any);

      await upNextAddItem(LIB, { libraryItemId: "b1" });

      expect(api.post).toHaveBeenCalledTimes(1);
      expect(api.post).toHaveBeenCalledWith("/api/playlists", expect.anything());
      expect(storage.getString(`upNextPlaylistId_${LIB}`)).toBe("plAccountB");
    });
  });

  describe("persistence across restarts (same account — the cache's purpose, unchanged)", () => {
    // The MMKV key deliberately survives an app kill for the SAME account: a
    // cold start reuses the persisted id without re-scanning the playlist
    // list. Simulate the restart with a FRESH module registry (empty in-memory
    // map) wired to the SAME persisted storage + api mocks — no regression
    // from adding clearUpNextCache.
    it("a fresh module load for the same account still uses the persisted id (no re-scan GET)", async () => {
      const LIB = freshLib();
      jest.mocked(api.get).mockResolvedValue({
        data: { results: [{ id: "plPersisted", name: UP_NEXT_PLAYLIST_NAME, items: [] }] },
      } as any);
      await findOrCreateUpNextPlaylist(LIB);
      expect(storage.getString(`upNextPlaylistId_${LIB}`)).toBe("plPersisted");

      const outerStorage = require("../../utils/storage");
      const outerApi = require("../../utils/api"); // the mocked module above
      let fresh: typeof import("../../utils/upNext") = undefined as any;
      jest.isolateModules(() => {
        // Re-wire the fresh registry's storage/api to the OUTER instances so
        // the persisted MMKV key (and the api spies) carry across the "kill".
        jest.doMock("../../utils/storage", () => outerStorage);
        jest.doMock("../../utils/api", () => outerApi);
        fresh = require("../../utils/upNext");
      });

      jest.mocked(api.get).mockClear();
      jest.mocked(api.delete).mockResolvedValue({ data: {} } as any);
      await fresh.upNextRemoveItem(LIB, "b1");

      // No playlist-list re-scan — the persisted id was adopted directly.
      expect(api.get).not.toHaveBeenCalled();
      expect(api.delete).toHaveBeenCalledWith(`/api/playlists/plPersisted/item/b1`);
    });
  });
});
