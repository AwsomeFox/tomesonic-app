/**
 * useFavoritesStore — the device-local "Want to Read" / favorites overlay (ABS
 * has no server favorites flag). Verifies toggle/add/remove, the point-read
 * helpers, MMKV persistence under its own `favorites` key, defensive loading of
 * corrupt persisted values, and clear().
 */
import { storage } from "../../utils/storage";
import { useFavoritesStore } from "../../store/useFavoritesStore";

const readPersisted = (): unknown => {
  const raw = storage.getString("favorites");
  return raw ? JSON.parse(raw) : null;
};

beforeEach(() => {
  storage.getAllKeys().forEach((k) => storage.remove(k));
  useFavoritesStore.setState({ favorites: [] });
});

describe("useFavoritesStore", () => {
  it("toggleFavorite adds an id, and isFavorite/list reflect it", () => {
    const { toggleFavorite, isFavorite, list } = useFavoritesStore.getState();
    expect(isFavorite("book1")).toBe(false);

    toggleFavorite("book1");

    expect(useFavoritesStore.getState().isFavorite("book1")).toBe(true);
    expect(useFavoritesStore.getState().list()).toEqual(["book1"]);
    expect(useFavoritesStore.getState().favorites).toEqual(["book1"]);
  });

  it("toggleFavorite removes an already-favorited id", () => {
    const { toggleFavorite } = useFavoritesStore.getState();
    toggleFavorite("book1");
    toggleFavorite("book1");
    expect(useFavoritesStore.getState().isFavorite("book1")).toBe(false);
    expect(useFavoritesStore.getState().favorites).toEqual([]);
  });

  it("persists the list to the `favorites` MMKV key on every toggle", () => {
    const { toggleFavorite } = useFavoritesStore.getState();
    toggleFavorite("a");
    toggleFavorite("b");
    expect(readPersisted()).toEqual(["a", "b"]);

    toggleFavorite("a"); // remove
    expect(readPersisted()).toEqual(["b"]);
  });

  it("ignores empty / non-string ids", () => {
    const { toggleFavorite } = useFavoritesStore.getState();
    toggleFavorite("");
    // @ts-expect-error — exercising the runtime guard
    toggleFavorite(undefined);
    // @ts-expect-error — exercising the runtime guard
    toggleFavorite(42);
    expect(useFavoritesStore.getState().favorites).toEqual([]);
  });

  it("clear() empties the list and persists the empty array", () => {
    const { toggleFavorite, clear } = useFavoritesStore.getState();
    toggleFavorite("a");
    toggleFavorite("b");
    clear();
    expect(useFavoritesStore.getState().favorites).toEqual([]);
    expect(readPersisted()).toEqual([]);
  });

  it("loads persisted favorites on module init (deduped, strings only)", () => {
    // resetModules gives the re-required store a FRESH storage instance, so seed
    // that same instance (not the top-level one) before requiring the store.
    jest.resetModules();
    const { storage: freshStorage } = require("../../utils/storage");
    freshStorage.set("favorites", JSON.stringify(["x", "y", "x", 7, null, "z"]));
    const { useFavoritesStore: fresh } = require("../../store/useFavoritesStore");
    expect(fresh.getState().favorites).toEqual(["x", "y", "z"]);
  });

  it("falls back to an empty list when the persisted value is corrupt", () => {
    jest.resetModules();
    const { storage: freshStorage } = require("../../utils/storage");
    freshStorage.set("favorites", "{not json");
    const { useFavoritesStore: fresh } = require("../../store/useFavoritesStore");
    expect(fresh.getState().favorites).toEqual([]);
  });
});
