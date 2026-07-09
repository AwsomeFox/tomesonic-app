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
});
