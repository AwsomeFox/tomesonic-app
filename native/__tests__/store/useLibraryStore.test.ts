jest.mock("../../utils/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock("../../utils/autoCreds", () => ({
  writeAutoCreds: jest.fn().mockResolvedValue(undefined),
  readAutoCreds: jest.fn().mockResolvedValue(null),
  writeAutoDownloads: jest.fn().mockResolvedValue(undefined),
  writeWidgetState: jest.fn().mockResolvedValue(undefined),
}));

import { api } from "../../utils/api";
import { writeAutoCreds } from "../../utils/autoCreds";
import { storage, storageHelper, secureStorage } from "../../utils/storage";
import { useLibraryStore } from "../../store/useLibraryStore";

const initial = useLibraryStore.getState();
const mockGet = jest.mocked(api.get);

function clearStorage() {
  storage.getAllKeys().forEach((k) => storage.remove(k));
  secureStorage.getAllKeys().forEach((k) => secureStorage.remove(k));
}

describe("useLibraryStore", () => {
  beforeEach(() => {
    clearStorage();
    useLibraryStore.setState(initial, true);
    useLibraryStore.getState().reset();
  });

  describe("loadPersonalizedShelves", () => {
    it("does nothing without a current library", async () => {
      await useLibraryStore.getState().loadPersonalizedShelves();
      expect(mockGet).not.toHaveBeenCalled();
    });

    it("fetches shelves, stores them, and writes the cache", async () => {
      useLibraryStore.setState({ currentLibraryId: "lib1" } as any);
      const shelves = [{ id: "continue-listening", entities: [{ id: "b1" }] }];
      mockGet.mockResolvedValue({ data: { shelves } } as any);

      await useLibraryStore.getState().loadPersonalizedShelves();

      expect(mockGet).toHaveBeenCalledWith(
        "/api/libraries/lib1/personalized?minified=1&include=series"
      );
      expect(useLibraryStore.getState().personalizedShelves).toEqual(shelves);
      expect(JSON.parse(storage.getString("shelvesCache_lib1")!)).toEqual(shelves);
    });

    it("surfaces the cache immediately when the store is empty (stale-while-revalidate)", async () => {
      const cached = [{ id: "cached-shelf" }];
      storage.set("shelvesCache_lib1", JSON.stringify(cached));
      useLibraryStore.setState({ currentLibraryId: "lib1", personalizedShelves: [] } as any);

      // Fetch that never resolves within the test — the cache must already be up.
      let resolveFetch: (v: any) => void = () => {};
      mockGet.mockReturnValue(new Promise((res) => (resolveFetch = res)) as any);

      const p = useLibraryStore.getState().loadPersonalizedShelves();
      expect(useLibraryStore.getState().personalizedShelves).toEqual(cached);

      resolveFetch({ data: { shelves: [{ id: "fresh" }] } });
      await p;
      expect(useLibraryStore.getState().personalizedShelves).toEqual([{ id: "fresh" }]);
    });

    it("discards the response if the library switched mid-fetch (race guard)", async () => {
      useLibraryStore.setState({ currentLibraryId: "lib1" } as any);
      let resolveFetch: (v: any) => void = () => {};
      mockGet.mockReturnValue(new Promise((res) => (resolveFetch = res)) as any);

      const p = useLibraryStore.getState().loadPersonalizedShelves();
      // User switches library while the fetch is in flight.
      useLibraryStore.setState({ currentLibraryId: "lib2", personalizedShelves: [] } as any);

      resolveFetch({ data: { shelves: [{ id: "old-library-shelf" }] } });
      await p;

      // Old library's shelves must not land under the new library.
      expect(useLibraryStore.getState().personalizedShelves).toEqual([]);
      expect(storage.getString("shelvesCache_lib1")).toBeUndefined();
    });

    it("keeps existing shelves on fetch failure", async () => {
      const existing = [{ id: "existing" }];
      useLibraryStore.setState({ currentLibraryId: "lib1", personalizedShelves: existing } as any);
      mockGet.mockRejectedValue(new Error("network down"));

      await useLibraryStore.getState().loadPersonalizedShelves();
      expect(useLibraryStore.getState().personalizedShelves).toEqual(existing);
    });

    // REGRESSION: an EMPTY 200 (server still indexing / auth race) must not wipe
    // a populated home screen or poison the per-library cache — otherwise the
    // next cold open hydrates empty and shelves are gone before any fetch runs.
    it("keeps existing shelves and does NOT cache when a 200 returns an empty set", async () => {
      const existing = [{ id: "continue", entities: [{ id: "b1" }] }];
      storage.set("shelvesCache_lib1", JSON.stringify(existing));
      useLibraryStore.setState({ currentLibraryId: "lib1", personalizedShelves: existing } as any);
      mockGet.mockResolvedValue({ data: { shelves: [] } } as any);

      await useLibraryStore.getState().loadPersonalizedShelves();

      expect(useLibraryStore.getState().personalizedShelves).toEqual(existing);
      expect(useLibraryStore.getState().shelvesLoadError).toBe(true);
      // The good cache is preserved, not overwritten with [].
      expect(JSON.parse(storage.getString("shelvesCache_lib1")!)).toEqual(existing);
    });

    it("never writes an empty shelf set to the cache even on a genuinely empty library", async () => {
      useLibraryStore.setState({ currentLibraryId: "lib1", personalizedShelves: [] } as any);
      mockGet.mockResolvedValue({ data: { shelves: [] } } as any);

      await useLibraryStore.getState().loadPersonalizedShelves();

      expect(useLibraryStore.getState().personalizedShelves).toEqual([]);
      expect(storage.getString("shelvesCache_lib1")).toBeUndefined();
    });
  });

  describe("setCurrentLibraryId", () => {
    it("persists the id and swaps shelves to the new library's cache", () => {
      const lib2Cache = [{ id: "lib2-shelf" }];
      storage.set("shelvesCache_lib2", JSON.stringify(lib2Cache));
      useLibraryStore.setState({
        currentLibraryId: "lib1",
        personalizedShelves: [{ id: "lib1-shelf" }],
      } as any);

      useLibraryStore.getState().setCurrentLibraryId("lib2");

      expect(useLibraryStore.getState().currentLibraryId).toBe("lib2");
      expect(storageHelper.getLastLibraryId()).toBe("lib2");
      expect(useLibraryStore.getState().personalizedShelves).toEqual(lib2Cache);
    });

    it("swaps to empty shelves when the new library has no cache", () => {
      useLibraryStore.setState({
        currentLibraryId: "lib1",
        personalizedShelves: [{ id: "lib1-shelf" }],
      } as any);

      useLibraryStore.getState().setCurrentLibraryId("lib3");
      expect(useLibraryStore.getState().personalizedShelves).toEqual([]);
    });

    it("clears the persisted id when set to null", () => {
      storageHelper.setLastLibraryId("lib1");
      useLibraryStore.getState().setCurrentLibraryId(null);
      expect(storageHelper.getLastLibraryId()).toBeNull();
      expect(useLibraryStore.getState().currentLibraryId).toBeNull();
    });

    it("mirrors the selection into the Android Auto creds file when logged in", () => {
      storageHelper.setServerConfig({ address: "https://abs.example.com", token: "tok" });
      useLibraryStore.getState().setCurrentLibraryId("lib9");
      expect(writeAutoCreds).toHaveBeenCalledWith("https://abs.example.com", "tok", "lib9", undefined);
    });
  });

  describe("loadLibraries", () => {
    const LIBS = [
      { id: "lib1", name: "Books", mediaType: "book" },
      { id: "lib2", name: "Podcasts", mediaType: "podcast" },
    ];

    it("loads libraries and defaults to the first when nothing was saved", async () => {
      mockGet.mockResolvedValue({ data: { libraries: LIBS } } as any);
      const ok = await useLibraryStore.getState().loadLibraries();
      expect(ok).toBe(true);
      expect(useLibraryStore.getState().libraries).toEqual(LIBS);
      expect(useLibraryStore.getState().currentLibraryId).toBe("lib1");
    });

    it("re-picks the saved library when it still exists", async () => {
      storageHelper.setLastLibraryId("lib2");
      mockGet.mockResolvedValue({ data: { libraries: LIBS } } as any);
      await useLibraryStore.getState().loadLibraries();
      expect(useLibraryStore.getState().currentLibraryId).toBe("lib2");
    });

    it("falls back to the first library when the saved one is gone, swapping the shelves cache", async () => {
      storageHelper.setLastLibraryId("deleted-lib");
      useLibraryStore.setState({
        currentLibraryId: "deleted-lib",
        personalizedShelves: [{ id: "stale" }],
      } as any);
      storage.set("shelvesCache_lib1", JSON.stringify([{ id: "lib1-cache" }]));
      mockGet.mockResolvedValue({ data: { libraries: LIBS } } as any);

      await useLibraryStore.getState().loadLibraries();
      expect(useLibraryStore.getState().currentLibraryId).toBe("lib1");
      expect(useLibraryStore.getState().personalizedShelves).toEqual([{ id: "lib1-cache" }]);
    });

    // REGRESSION: an empty /api/libraries (transient blip, auth race, proxy
    // hiccup) must NOT null currentLibraryId — a null library makes
    // loadPersonalizedShelves early-return, blanking the home screen with no
    // way for pull-to-refresh to recover. Treat empty as a failed load.
    it("treats an empty libraries response as a failed load and keeps current state", async () => {
      useLibraryStore.setState({ libraries: LIBS, currentLibraryId: "lib2" } as any);
      mockGet.mockResolvedValue({ data: { libraries: [] } } as any);

      const ok = await useLibraryStore.getState().loadLibraries(true);

      expect(ok).toBe(false);
      expect(useLibraryStore.getState().currentLibraryId).toBe("lib2");
      expect(useLibraryStore.getState().libraries).toEqual(LIBS);
    });

    it("persists the auto-picked library so it survives the next launch", async () => {
      mockGet.mockResolvedValue({ data: { libraries: LIBS } } as any);
      await useLibraryStore.getState().loadLibraries();
      expect(storageHelper.getLastLibraryId()).toBe("lib1");
    });

    it("keeps the current (unsaved, auto-picked) library when it is still present", async () => {
      // No saved id, but lib2 is the live selection from a prior auto-pick.
      useLibraryStore.setState({ currentLibraryId: "lib2" } as any);
      mockGet.mockResolvedValue({ data: { libraries: LIBS } } as any);

      await useLibraryStore.getState().loadLibraries(true);

      expect(useLibraryStore.getState().currentLibraryId).toBe("lib2");
    });

    // REGRESSION: when the effective library changes (saved one deleted →
    // default to first), the per-library state must clear the same way
    // setCurrentLibraryId does — otherwise FilterModal serves the old
    // library's genres and the counts show the wrong library's numbers.
    it("clears per-library state when the effective library changes", async () => {
      storageHelper.setLastLibraryId("deleted-lib");
      useLibraryStore.setState({
        currentLibraryId: "deleted-lib",
        filterData: { genres: ["scifi"] },
        issues: 3,
        numUserPlaylists: 4,
        shelvesLoadError: true,
      } as any);
      mockGet.mockResolvedValue({ data: { libraries: LIBS } } as any);

      await useLibraryStore.getState().loadLibraries();

      const s = useLibraryStore.getState();
      expect(s.currentLibraryId).toBe("lib1");
      expect(s.filterData).toBeNull();
      expect(s.issues).toBe(0);
      expect(s.numUserPlaylists).toBe(0);
      expect(s.shelvesLoadError).toBe(false);
    });

    it("keeps per-library state when the effective library is unchanged", async () => {
      storageHelper.setLastLibraryId("lib2");
      useLibraryStore.setState({
        currentLibraryId: "lib2",
        filterData: { genres: ["scifi"] },
        issues: 2,
      } as any);
      mockGet.mockResolvedValue({ data: { libraries: LIBS } } as any);

      await useLibraryStore.getState().loadLibraries();

      const s = useLibraryStore.getState();
      expect(s.currentLibraryId).toBe("lib2");
      expect(s.filterData).toEqual({ genres: ["scifi"] });
      expect(s.issues).toBe(2);
    });

    it("keeps existing state on failure and returns false", async () => {
      useLibraryStore.setState({ libraries: LIBS, currentLibraryId: "lib2" } as any);
      mockGet.mockRejectedValue(new Error("offline"));

      const ok = await useLibraryStore.getState().loadLibraries(true);
      expect(ok).toBe(false);
      expect(useLibraryStore.getState().libraries).toEqual(LIBS);
      expect(useLibraryStore.getState().currentLibraryId).toBe("lib2");
    });

    it("throttles reloads within 5 minutes unless forced", async () => {
      mockGet.mockResolvedValue({ data: { libraries: LIBS } } as any);
      await useLibraryStore.getState().loadLibraries();
      expect(mockGet).toHaveBeenCalledTimes(1);

      // Immediate re-load: throttled.
      const again = await useLibraryStore.getState().loadLibraries();
      expect(again).toBe(false);
      expect(mockGet).toHaveBeenCalledTimes(1);

      // Forced: goes through.
      await useLibraryStore.getState().loadLibraries(true);
      expect(mockGet).toHaveBeenCalledTimes(2);
    });
  });

  describe("fetchLibraryDetails", () => {
    it("stores filter data, issues, and playlist count", async () => {
      useLibraryStore.setState({
        libraries: [{ id: "lib1", name: "Books" }] as any,
        // Details only install for the CURRENT library (stale-switch guard).
        currentLibraryId: "lib1",
      } as any);
      mockGet.mockResolvedValue({
        data: {
          library: { id: "lib1", name: "Books Renamed" },
          filterdata: { genres: ["scifi"] },
          issues: 2,
          numUserPlaylists: 3,
        },
      } as any);

      const data = await useLibraryStore.getState().fetchLibraryDetails("lib1");
      expect(data).toBeTruthy();
      const s = useLibraryStore.getState();
      expect(s.currentLibraryId).toBe("lib1");
      expect(s.filterData).toEqual({ genres: ["scifi"] });
      expect(s.issues).toBe(2);
      expect(s.numUserPlaylists).toBe(3);
      expect(s.libraries[0].name).toBe("Books Renamed");
    });

    it("returns null on failure without touching state", async () => {
      mockGet.mockRejectedValue(new Error("500"));
      const data = await useLibraryStore.getState().fetchLibraryDetails("libX");
      expect(data).toBeNull();
      expect(useLibraryStore.getState().currentLibraryId).toBeNull();
    });

    // REGRESSION: a slow details response landing after a library switch used
    // to force-revert currentLibraryId and install the OLD library's filters.
    it("discards a stale response after a library switch", async () => {
      useLibraryStore.setState({
        libraries: [{ id: "libA" }, { id: "libB" }] as any,
        currentLibraryId: "libB", // user already switched away from libA
      } as any);
      mockGet.mockResolvedValue({
        data: { library: { id: "libA" }, filterdata: { genres: ["old"] }, issues: 9 },
      } as any);

      await useLibraryStore.getState().fetchLibraryDetails("libA");

      const s = useLibraryStore.getState();
      expect(s.currentLibraryId).toBe("libB"); // not reverted
      expect(s.filterData).toBeNull(); // old library's filters not installed
    });
  });

  // REGRESSION: filterData is per-library; FilterModal only refetches when it
  // is null, so surviving a switch served the previous library's genres.
  it("setCurrentLibraryId clears per-library filter data on an actual change", () => {
    useLibraryStore.setState({
      currentLibraryId: "libA",
      filterData: { genres: ["scifi"] } as any,
      issues: 2,
      numUserPlaylists: 3,
      // Library A's failed shelves fetch must not paint library B's
      // (not-yet-fetched) home screen as an error.
      shelvesLoadError: true,
    } as any);

    useLibraryStore.getState().setCurrentLibraryId("libB");

    const s = useLibraryStore.getState();
    expect(s.filterData).toBeNull();
    expect(s.issues).toBe(0);
    expect(s.numUserPlaylists).toBe(0);
    expect(s.shelvesLoadError).toBe(false);
  });

  it("reset clears everything", () => {
    useLibraryStore.setState({
      libraries: [{ id: "l" }] as any,
      currentLibraryId: "l",
      lastLoad: 123,
      issues: 1,
      filterData: {},
      numUserPlaylists: 2,
      personalizedShelves: [{ id: "s" }],
      shelvesLoadError: true,
    } as any);
    useLibraryStore.getState().reset();
    const s = useLibraryStore.getState();
    expect(s.libraries).toEqual([]);
    expect(s.currentLibraryId).toBeNull();
    expect(s.lastLoad).toBe(0);
    expect(s.personalizedShelves).toEqual([]);
    expect(s.shelvesLoadError).toBe(false);
  });
});
