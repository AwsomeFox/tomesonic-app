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

    it("sets currentLibraryId null when the server has no libraries", async () => {
      mockGet.mockResolvedValue({ data: { libraries: [] } } as any);
      await useLibraryStore.getState().loadLibraries();
      expect(useLibraryStore.getState().currentLibraryId).toBeNull();
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
    } as any);
    useLibraryStore.getState().reset();
    const s = useLibraryStore.getState();
    expect(s.libraries).toEqual([]);
    expect(s.currentLibraryId).toBeNull();
    expect(s.lastLoad).toBe(0);
    expect(s.personalizedShelves).toEqual([]);
  });
});
