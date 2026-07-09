jest.mock("../../utils/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock("../../utils/progressSync", () => ({
  syncProgress: jest.fn().mockResolvedValue(undefined),
  closeSession: jest.fn().mockResolvedValue(undefined),
  queueProgressPatch: jest.fn(),
  queueFinishedPatch: jest.fn(),
  queueEbookProgressPatch: jest.fn(),
  flushPendingSyncs: jest.fn().mockResolvedValue(undefined),
  clearAllPending: jest.fn(),
  reconcileLinkedProgress: jest.fn(),
}));
jest.mock("../../utils/autoCreds", () => ({
  writeAutoCreds: jest.fn().mockResolvedValue(undefined),
  readAutoCreds: jest.fn().mockResolvedValue(null),
  writeAutoDownloads: jest.fn().mockResolvedValue(undefined),
  writeWidgetState: jest.fn().mockResolvedValue(undefined),
}));
// Mock the server "Up Next" mirror so we can assert the store fires it without
// touching the network.
jest.mock("../../utils/upNext", () => ({
  upNextAddItem: jest.fn().mockResolvedValue(undefined),
  upNextRemoveItem: jest.fn().mockResolvedValue(undefined),
  upNextListItems: jest.fn().mockResolvedValue([]),
}));

import { storage } from "../../utils/storage";
import { upNextAddItem, upNextRemoveItem, upNextListItems } from "../../utils/upNext";
import { usePlaybackStore, syncUpNextFromServer } from "../../store/usePlaybackStore";

const initial = usePlaybackStore.getState();
const LIB = "lib1";

// The store derives the library id from useLibraryStore.currentLibraryId, then
// falls back to currentSession.libraryId. Seeding the session's libraryId keeps
// the test independent of the real library store.
function withLibrary() {
  usePlaybackStore.setState({ currentSession: { libraryId: LIB } } as any);
}

describe("usePlaybackStore ↔ server Up Next mirror", () => {
  beforeEach(() => {
    usePlaybackStore.setState(initial, true);
    storage.getAllKeys().forEach((k) => storage.remove(k));
    jest.mocked(upNextAddItem).mockClear();
    jest.mocked(upNextRemoveItem).mockClear();
    jest.mocked(upNextListItems).mockClear();
    jest.mocked(upNextAddItem).mockResolvedValue(undefined);
    jest.mocked(upNextRemoveItem).mockResolvedValue(undefined);
    jest.mocked(upNextListItems).mockResolvedValue([]);
  });

  it("addToQueue updates the local queue synchronously AND fires a server add", () => {
    withLibrary();
    const item = { libraryItemId: "b2", title: "Book 2" };
    usePlaybackStore.getState().addToQueue(item);

    // Local state + MMKV updated synchronously (instant UI, no await).
    expect(usePlaybackStore.getState().queue.map((q) => q.libraryItemId)).toEqual(["b2"]);
    expect(JSON.parse(storage.getString("playbackQueue")!)).toHaveLength(1);
    // Server mirror fired with the resolved library id + the item.
    expect(upNextAddItem).toHaveBeenCalledWith(LIB, item);
  });

  it("does not touch the server when no library id is resolvable", () => {
    // No session / library — local queue must still work exactly as before.
    usePlaybackStore.getState().addToQueue({ libraryItemId: "b2" });
    expect(usePlaybackStore.getState().queue.map((q) => q.libraryItemId)).toEqual(["b2"]);
    expect(upNextAddItem).not.toHaveBeenCalled();
  });

  it("a rejecting (offline) server add leaves the local queue intact and never throws", async () => {
    withLibrary();
    jest.mocked(upNextAddItem).mockRejectedValueOnce(new Error("offline"));

    expect(() => usePlaybackStore.getState().addToQueue({ libraryItemId: "b2" })).not.toThrow();
    // Fire-and-forget rejection is swallowed by .catch — flush microtasks to be sure.
    await Promise.resolve();
    await Promise.resolve();
    expect(usePlaybackStore.getState().queue.map((q) => q.libraryItemId)).toEqual(["b2"]);
  });

  it("removeFromQueue drains the server mirror", () => {
    withLibrary();
    usePlaybackStore.getState().addToQueue({ libraryItemId: "b2" });
    usePlaybackStore.getState().removeFromQueue("b2");
    expect(usePlaybackStore.getState().queue).toEqual([]);
    expect(upNextRemoveItem).toHaveBeenCalledWith(LIB, "b2");
  });

  it("clearQueue drains every server item", () => {
    withLibrary();
    usePlaybackStore.getState().addToQueue({ libraryItemId: "b2" });
    usePlaybackStore.getState().addToQueue({ libraryItemId: "b3" });
    jest.mocked(upNextRemoveItem).mockClear();

    usePlaybackStore.getState().clearQueue();
    expect(usePlaybackStore.getState().queue).toEqual([]);
    expect(upNextRemoveItem).toHaveBeenCalledWith(LIB, "b2");
    expect(upNextRemoveItem).toHaveBeenCalledWith(LIB, "b3");
  });

  it("playNextInQueue drains the started item from the server mirror", async () => {
    withLibrary();
    const startPlayback = jest.fn().mockResolvedValue(true);
    usePlaybackStore.setState({ startPlayback } as any);
    withLibrary();
    usePlaybackStore.getState().addToQueue({ libraryItemId: "b2" });
    usePlaybackStore.getState().addToQueue({ libraryItemId: "b3" });
    jest.mocked(upNextRemoveItem).mockClear();

    const ok = await usePlaybackStore.getState().playNextInQueue();
    expect(ok).toBe(true);
    expect(usePlaybackStore.getState().queue.map((q) => q.libraryItemId)).toEqual(["b3"]);
    expect(upNextRemoveItem).toHaveBeenCalledWith(LIB, "b2");
  });

  describe("syncUpNextFromServer", () => {
    it("merges server-only items into the local queue (local order preserved first)", async () => {
      withLibrary();
      usePlaybackStore.getState().addToQueue({ libraryItemId: "local1" });
      jest.mocked(upNextListItems).mockResolvedValue([
        { libraryItemId: "local1" }, // already local — deduped
        { libraryItemId: "server1", title: "From another device" },
      ] as any);

      await syncUpNextFromServer(LIB);
      expect(usePlaybackStore.getState().queue.map((q) => q.libraryItemId)).toEqual([
        "local1",
        "server1",
      ]);
    });

    it("leaves the local queue untouched when the server list is empty / offline", async () => {
      withLibrary();
      usePlaybackStore.getState().addToQueue({ libraryItemId: "local1" });
      jest.mocked(upNextListItems).mockResolvedValue([]);

      await syncUpNextFromServer(LIB);
      expect(usePlaybackStore.getState().queue.map((q) => q.libraryItemId)).toEqual(["local1"]);
    });
  });
});
