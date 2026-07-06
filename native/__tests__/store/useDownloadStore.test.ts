jest.mock("../../utils/downloader", () => ({
  downloader: {
    abortBookParts: jest.fn().mockResolvedValue(undefined),
    resumeDownload: jest.fn().mockResolvedValue(undefined),
    sweepOrphanFolders: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock("../../utils/autoCreds", () => ({
  writeAutoCreds: jest.fn().mockResolvedValue(undefined),
  readAutoCreds: jest.fn().mockResolvedValue(null),
  writeAutoDownloads: jest.fn().mockResolvedValue(undefined),
  writeWidgetState: jest.fn().mockResolvedValue(undefined),
}));

import * as FileSystem from "expo-file-system/legacy";
import { downloader } from "../../utils/downloader";
import { db, dbStorage } from "../../utils/db";
import { storage, storageHelper, secureStorage } from "../../utils/storage";
import { useDownloadStore, DownloadItem } from "../../store/useDownloadStore";

const initial = useDownloadStore.getState();
const flush = () => new Promise((r) => setImmediate(r));

function baseItem(over: Partial<DownloadItem> = {}): DownloadItem {
  return {
    id: "item1",
    libraryItemId: "item1",
    title: "The Hobbit",
    author: "J.R.R. Tolkien",
    coverUrl: "https://server/cover.jpg",
    progress: 0,
    status: "pending",
    parts: [
      { id: "track_0", filename: "a.m4b", url: "u0", bytesDownloaded: 0, fileSize: 1000, completed: false },
      { id: "cover", filename: "cover.jpg", url: "u1", bytesDownloaded: 0, fileSize: 0, completed: false },
    ],
    localFolderPath: "file:///downloads/item1/",
    ...over,
  };
}

describe("useDownloadStore", () => {
  beforeEach(() => {
    dbStorage.getAllKeys().forEach((k) => dbStorage.remove(k));
    storage.getAllKeys().forEach((k) => storage.remove(k));
    secureStorage.getAllKeys().forEach((k) => secureStorage.remove(k));
    useDownloadStore.setState(initial, true);
    useDownloadStore.setState({ activeDownloads: {}, completedDownloads: {} });
  });

  describe("startDownload", () => {
    it("creates a pending item with zeroed parts, clears stale errors, and persists", () => {
      useDownloadStore.getState().startDownload(
        {
          id: "item1",
          libraryItemId: "item1",
          title: "The Hobbit",
          author: "J.R.R. Tolkien",
          coverUrl: "c",
          error: "old failure",
        } as any,
        [
          { id: "track_0", filename: "a.m4b", url: "u0", fileSize: 1000 },
          { id: "cover", filename: "cover.jpg", url: "u1", fileSize: 0 },
        ] as any
      );

      const item = useDownloadStore.getState().activeDownloads["item1"];
      expect(item.status).toBe("pending");
      expect(item.progress).toBe(0);
      expect(item.error).toBeUndefined();
      expect(item.parts).toHaveLength(2);
      expect(item.parts[0]).toMatchObject({ bytesDownloaded: 0, completed: false });
      // Persisted to the downloads DB.
      expect(db.getAllDownloads()).toHaveLength(1);
    });
  });

  describe("updateDownloadProgress", () => {
    beforeEach(() => {
      useDownloadStore.setState({ activeDownloads: { item1: baseItem() } });
    });

    it("computes progress across parts and flips status to downloading", () => {
      useDownloadStore.getState().updateDownloadProgress("item1", "track_0", 500, 1000);
      const item = useDownloadStore.getState().activeDownloads["item1"];
      expect(item.status).toBe("downloading");
      // 500 of 1000 expected (cover part has 0 expected and 0 written).
      expect(item.progress).toBeCloseTo(0.5, 5);
    });

    it("keeps the previous fileSize estimate when the callback reports unknown size", () => {
      useDownloadStore.getState().updateDownloadProgress("item1", "track_0", 100, -1);
      const part = useDownloadStore.getState().activeDownloads["item1"].parts[0];
      expect(part.fileSize).toBe(1000); // -1 must not clobber the server estimate
      expect(part.bytesDownloaded).toBe(100);
    });

    it("never counts expected bytes below what is already written (unknown-size parts)", () => {
      // Cover part: fileSize 0, 300 bytes written → expected for it = 300.
      useDownloadStore.getState().updateDownloadProgress("item1", "cover", 300, 0);
      const item = useDownloadStore.getState().activeDownloads["item1"];
      // 300 / (1000 + 300)
      expect(item.progress).toBeCloseTo(300 / 1300, 5);
    });

    it("caps progress at 0.99 until completion wraps up", () => {
      useDownloadStore.getState().updateDownloadProgress("item1", "track_0", 1000, 1000);
      const item = useDownloadStore.getState().activeDownloads["item1"];
      expect(item.progress).toBe(0.99);
    });

    it("ignores updates for unknown items", () => {
      useDownloadStore.getState().updateDownloadProgress("nope", "track_0", 10, 100);
      expect(useDownloadStore.getState().activeDownloads["nope"]).toBeUndefined();
    });
  });

  describe("completeDownloadPart", () => {
    beforeEach(() => {
      useDownloadStore.setState({ activeDownloads: { item1: baseItem() } });
    });

    it("marks the part complete and snaps bytesDownloaded to fileSize when known", () => {
      useDownloadStore.getState().completeDownloadPart("item1", "track_0", "/downloads/item1/a.m4b");
      const part = useDownloadStore.getState().activeDownloads["item1"].parts[0];
      expect(part.completed).toBe(true);
      expect(part.bytesDownloaded).toBe(1000);
      expect(part.localFilePath).toBe("/downloads/item1/a.m4b");
    });

    it("keeps bytesDownloaded for unknown-size parts (fileSize 0)", () => {
      useDownloadStore.getState().updateDownloadProgress("item1", "cover", 321, 0);
      useDownloadStore.getState().completeDownloadPart("item1", "cover", "/downloads/item1/cover.jpg");
      const part = useDownloadStore
        .getState()
        .activeDownloads["item1"].parts.find((p) => p.id === "cover")!;
      expect(part.completed).toBe(true);
      expect(part.bytesDownloaded).toBe(321); // not snapped back to 0
    });
  });

  describe("completeDownload", () => {
    it("moves the item from active to completed with progress 1 and clears errors", () => {
      useDownloadStore.setState({
        activeDownloads: { item1: baseItem({ status: "downloading", error: "flaky" }) },
      });

      useDownloadStore.getState().completeDownload("item1", "file:///downloads/item1/");

      const s = useDownloadStore.getState();
      expect(s.activeDownloads["item1"]).toBeUndefined();
      const done = s.completedDownloads["item1"];
      expect(done.status).toBe("completed");
      expect(done.progress).toBe(1);
      expect(done.error).toBeUndefined();
      expect(done.localFolderPath).toBe("file:///downloads/item1/");
      // Offline library mapping saved.
      expect(db.getLocalLibraryItem("item1")).toMatchObject({
        libraryItemId: "item1",
        isDownloaded: true,
      });
    });
  });

  describe("failDownload", () => {
    it("keeps the item active with a failure reason", () => {
      useDownloadStore.setState({ activeDownloads: { item1: baseItem({ status: "downloading" }) } });
      useDownloadStore.getState().failDownload("item1", "Not enough storage space");
      const item = useDownloadStore.getState().activeDownloads["item1"];
      expect(item.status).toBe("failed");
      expect(item.error).toBe("Not enough storage space");
      // Parts survive so retry can resume.
      expect(item.parts).toHaveLength(2);
    });

    it("defaults the error message when none is given", () => {
      useDownloadStore.setState({ activeDownloads: { item1: baseItem() } });
      useDownloadStore.getState().failDownload("item1", "");
      expect(useDownloadStore.getState().activeDownloads["item1"].error).toBe("Unknown error");
    });
  });

  describe("cancelDownload", () => {
    it("aborts in-flight parts, deletes the folder, and removes the record entirely", async () => {
      const item = baseItem({ status: "downloading" });
      db.saveDownloadItem(item);
      useDownloadStore.setState({ activeDownloads: { item1: item } });

      useDownloadStore.getState().cancelDownload("item1");
      await flush();

      expect(downloader.abortBookParts).toHaveBeenCalledWith("item1");
      // Folder deleted only after the abort settles.
      expect(FileSystem.deleteAsync).toHaveBeenCalledWith("file:///downloads/item1/", {
        idempotent: true,
      });
      // No ghost record anywhere: neither in memory nor in the DB.
      expect(useDownloadStore.getState().activeDownloads["item1"]).toBeUndefined();
      expect(db.getAllDownloads()).toHaveLength(0);
    });
  });

  describe("removeDownload", () => {
    it("deletes the folder and drops the item from both maps and the DB", async () => {
      const item = baseItem({ status: "completed" });
      db.saveDownloadItem(item);
      db.saveLocalLibraryItem({ id: "item1", libraryItemId: "item1" });
      useDownloadStore.setState({ completedDownloads: { item1: item } });

      await useDownloadStore.getState().removeDownload("item1");

      expect(FileSystem.deleteAsync).toHaveBeenCalledWith("file:///downloads/item1/", {
        idempotent: true,
      });
      expect(useDownloadStore.getState().completedDownloads["item1"]).toBeUndefined();
      expect(useDownloadStore.getState().activeDownloads["item1"]).toBeUndefined();
      expect(db.getAllDownloads()).toHaveLength(0);
      expect(db.getLocalLibraryItem("item1")).toBeNull();
    });

    it("derives the folder from a part's file path when localFolderPath is missing", async () => {
      const item = baseItem({ status: "failed", localFolderPath: undefined });
      item.parts[0].localFilePath = "file:///downloads/derived/a.m4b";
      useDownloadStore.setState({ activeDownloads: { item1: item } });

      await useDownloadStore.getState().removeDownload("item1");
      expect(FileSystem.deleteAsync).toHaveBeenCalledWith("file:///downloads/derived/", {
        idempotent: true,
      });
    });
  });

  describe("retryDownload", () => {
    it("flips a failed item back to pending and drives the downloader resume", async () => {
      storageHelper.setServerConfig({ address: "https://abs.example.com", token: "tok" });
      const item = baseItem({ status: "failed", error: "Interrupted" });
      useDownloadStore.setState({ activeDownloads: { item1: item } });

      await useDownloadStore.getState().retryDownload("item1");

      const pending = useDownloadStore.getState().activeDownloads["item1"];
      expect(pending.status).toBe("pending");
      expect(pending.error).toBeUndefined();
      expect(downloader.resumeDownload).toHaveBeenCalledWith(
        expect.objectContaining({ id: "item1", status: "pending" }),
        "https://abs.example.com",
        "tok"
      );
    });

    it("fails the download when server config is missing", async () => {
      const item = baseItem({ status: "failed" });
      useDownloadStore.setState({ activeDownloads: { item1: item } });

      await useDownloadStore.getState().retryDownload("item1");

      const failed = useDownloadStore.getState().activeDownloads["item1"];
      expect(failed.status).toBe("failed");
      expect(failed.error).toMatch(/Missing server config/);
      expect(downloader.resumeDownload).not.toHaveBeenCalled();
    });

    it("is a no-op for items already pending or downloading", async () => {
      useDownloadStore.setState({ activeDownloads: { item1: baseItem({ status: "downloading" }) } });
      await useDownloadStore.getState().retryDownload("item1");
      expect(downloader.resumeDownload).not.toHaveBeenCalled();
      expect(useDownloadStore.getState().activeDownloads["item1"].status).toBe("downloading");
    });
  });

  describe("removeAllDownloads", () => {
    it("aborts, deletes files, clears db rows, and empties both maps (completed AND active)", async () => {
      const done = baseItem({
        id: "done1",
        libraryItemId: "done1",
        status: "completed",
        localFolderPath: "file:///downloads/done1/",
      });
      const act = baseItem({
        id: "act1",
        libraryItemId: "act1",
        status: "downloading",
        localFolderPath: "file:///downloads/act1/",
      });
      db.saveDownloadItem(done);
      db.saveDownloadItem(act);
      db.saveLocalLibraryItem({ id: "done1", libraryItemId: "done1" });
      useDownloadStore.setState({
        completedDownloads: { done1: done },
        activeDownloads: { act1: act },
      });

      await useDownloadStore.getState().removeAllDownloads();

      // In-flight parts stopped for BOTH ids before their files are touched.
      expect(downloader.abortBookParts).toHaveBeenCalledWith("done1");
      expect(downloader.abortBookParts).toHaveBeenCalledWith("act1");
      // Both on-device folders deleted.
      expect(FileSystem.deleteAsync).toHaveBeenCalledWith("file:///downloads/done1/", {
        idempotent: true,
      });
      expect(FileSystem.deleteAsync).toHaveBeenCalledWith("file:///downloads/act1/", {
        idempotent: true,
      });
      // No db rows survive: download records nor the offline-library mapping.
      expect(db.getAllDownloads()).toHaveLength(0);
      expect(db.getLocalLibraryItem("done1")).toBeNull();
      // Orphan folders swept as a final pass.
      expect(downloader.sweepOrphanFolders).toHaveBeenCalled();
      const s = useDownloadStore.getState();
      expect(s.completedDownloads).toEqual({});
      expect(s.activeDownloads).toEqual({});
    });

    it("empties both maps SYNCHRONOUSLY before the aborts, while still deleting files and db rows", async () => {
      // An in-flight download loop checks its store entry after every part —
      // the store must already be empty by the time abortBookParts runs, or
      // the loop can throw into failDownload and resurrect a ghost db row.
      const done = baseItem({
        id: "done1",
        libraryItemId: "done1",
        status: "completed",
        localFolderPath: "file:///downloads/done1/",
      });
      const act = baseItem({
        id: "act1",
        libraryItemId: "act1",
        status: "downloading",
        localFolderPath: "file:///downloads/act1/",
      });
      db.saveDownloadItem(done);
      db.saveDownloadItem(act);
      useDownloadStore.setState({
        completedDownloads: { done1: done },
        activeDownloads: { act1: act },
      });

      const seenAtAbort: Array<{ active: any; completed: any }> = [];
      (downloader.abortBookParts as jest.Mock).mockImplementation(async () => {
        const s = useDownloadStore.getState();
        seenAtAbort.push({ active: s.activeDownloads, completed: s.completedDownloads });
      });

      await useDownloadStore.getState().removeAllDownloads();

      // One abort per id, and the store was ALREADY empty at each call.
      expect(seenAtAbort).toHaveLength(2);
      for (const snap of seenAtAbort) {
        expect(snap.active).toEqual({});
        expect(snap.completed).toEqual({});
      }
      // Items captured before the clear still get their folders deleted...
      expect(FileSystem.deleteAsync).toHaveBeenCalledWith("file:///downloads/done1/", {
        idempotent: true,
      });
      expect(FileSystem.deleteAsync).toHaveBeenCalledWith("file:///downloads/act1/", {
        idempotent: true,
      });
      // ...and their db rows removed.
      expect(db.getAllDownloads()).toHaveLength(0);
    });

    it("resolves safely with nothing downloaded", async () => {
      await useDownloadStore.getState().removeAllDownloads();
      expect(downloader.abortBookParts).not.toHaveBeenCalled();
      expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
      expect(useDownloadStore.getState().completedDownloads).toEqual({});
      expect(useDownloadStore.getState().activeDownloads).toEqual({});
    });
  });

  describe("downloadsLoaded", () => {
    it("is false until loadDownloadsFromDb hydrates, then true even with zero downloads", () => {
      expect(useDownloadStore.getState().downloadsLoaded).toBe(false);

      useDownloadStore.getState().loadDownloadsFromDb();

      expect(db.getAllDownloads()).toHaveLength(0); // nothing in the db
      expect(useDownloadStore.getState().downloadsLoaded).toBe(true);
    });
  });

  describe("loadDownloadsFromDb", () => {
    it("splits completed and active rows", () => {
      db.saveDownloadItem(baseItem({ id: "done1", status: "completed" }));
      db.saveDownloadItem(baseItem({ id: "fail1", status: "failed", error: "boom" }));

      useDownloadStore.getState().loadDownloadsFromDb();

      const s = useDownloadStore.getState();
      expect(s.completedDownloads["done1"].status).toBe("completed");
      expect(s.activeDownloads["fail1"].status).toBe("failed");
      expect(s.activeDownloads["fail1"].error).toBe("boom");
    });

    it("marks interrupted downloads as failed with a resume message, keeping parts", () => {
      const interrupted = baseItem({ id: "int1", status: "downloading" });
      interrupted.parts[0].completed = true;
      interrupted.parts[0].bytesDownloaded = 1000;
      db.saveDownloadItem(interrupted);

      useDownloadStore.getState().loadDownloadsFromDb();

      const item = useDownloadStore.getState().activeDownloads["int1"];
      expect(item.status).toBe("failed");
      expect(item.error).toBe("Interrupted — tap retry to resume");
      // Progress kept intact so retry resumes instead of restarting.
      expect(item.parts[0].completed).toBe(true);
      // The failed status is persisted back to the DB too.
      expect(db.getAllDownloads()[0].status).toBe("failed");
    });

    it("keeps the live in-memory item when a download loop is driving it right now", () => {
      const live = baseItem({ id: "live1", status: "downloading", progress: 0.7 });
      useDownloadStore.setState({ activeDownloads: { live1: live } });
      // The throttled DB copy is stale.
      db.saveDownloadItem({ ...live, progress: 0.2 });

      useDownloadStore.getState().loadDownloadsFromDb();

      const item = useDownloadStore.getState().activeDownloads["live1"];
      expect(item).toBe(live); // exact in-memory object wins
      expect(item.status).toBe("downloading");
      expect(item.progress).toBe(0.7);
    });

    it("cleans up legacy cancelled rows: deletes files and removes the record", () => {
      db.saveDownloadItem(baseItem({ id: "ghost1", status: "cancelled" }));

      useDownloadStore.getState().loadDownloadsFromDb();

      expect(FileSystem.deleteAsync).toHaveBeenCalledWith("file:///downloads/item1/", {
        idempotent: true,
      });
      expect(db.getAllDownloads()).toHaveLength(0);
      const s = useDownloadStore.getState();
      expect(s.activeDownloads["ghost1"]).toBeUndefined();
      expect(s.completedDownloads["ghost1"]).toBeUndefined();
    });

    it("sweeps orphan folders after hydration", () => {
      useDownloadStore.getState().loadDownloadsFromDb();
      expect(downloader.sweepOrphanFolders).toHaveBeenCalled();
    });
  });

  describe("setDownloadFolder", () => {
    it("backfills localFolderPath on an active item", () => {
      const item = baseItem({ localFolderPath: undefined });
      useDownloadStore.setState({ activeDownloads: { item1: item } });
      useDownloadStore.getState().setDownloadFolder("item1", "file:///downloads/new/");
      expect(useDownloadStore.getState().activeDownloads["item1"].localFolderPath).toBe(
        "file:///downloads/new/"
      );
    });

    it("is a no-op for unknown items or unchanged paths", () => {
      useDownloadStore.getState().setDownloadFolder("missing", "file:///x/");
      expect(useDownloadStore.getState().activeDownloads["missing"]).toBeUndefined();
    });
  });

  describe("Android Auto downloads mirror (resume-position write-through)", () => {
    // The mirror block runs at module load and keeps module-level _lastKeys
    // state, so each test loads a FRESH copy of the store. jest.resetModules
    // (not isolateModules) on purpose: the mirror resolves useUserStore and
    // utils/storage through LAZY requires at sync time — isolateModules only
    // isolates requires made during its callback, so those runtime requires
    // would escape to the stale outer registry. Resetting the registry keeps
    // every require (ours below and the store's lazy ones) on the same fresh
    // instances. Safe here because this describe is the LAST in the file.
    function loadFresh() {
      jest.resetModules();
      const writeAutoDownloads = require("../../utils/autoCreds").writeAutoDownloads as jest.Mock;
      const freshStorageHelper = require("../../utils/storage").storageHelper as typeof storageHelper;
      const userStore = require("../../store/useUserStore").useUserStore;
      const store = require("../../store/useDownloadStore").useDownloadStore as typeof useDownloadStore;
      return { writeAutoDownloads, storageHelper: freshStorageHelper, userStore, store };
    }

    // Completed AUDIO download (the mirror skips ebook-only items).
    function audioItem(id: string): DownloadItem {
      return {
        ...baseItem({ id, libraryItemId: id, status: "completed", progress: 1 }),
        meta: {
          duration: 3600,
          chapters: [],
          tracks: [{ index: 0, filename: "a.m4b", duration: 3600, startOffset: 0 }],
        },
      };
    }

    it("re-writes the car file when a resume position crosses a 15s bucket", () => {
      const m = loadFresh();
      m.userStore.setState({ mediaProgress: { book1: { currentTime: 10 } } });

      m.store.setState({ completedDownloads: { book1: audioItem("book1") } });
      expect(m.writeAutoDownloads).toHaveBeenCalledTimes(1);
      expect(m.writeAutoDownloads).toHaveBeenLastCalledWith([
        expect.objectContaining({ id: "book1", currentTime: 10 }),
      ]);

      // 10 → 40 crosses the 15s bucket boundary (bucket 0 → 2): re-emit with
      // the advanced position (this is the fix — the old ids-only key meant
      // listening progress never reached the car's cold-start file).
      m.userStore.setState({ mediaProgress: { book1: { currentTime: 40 } } });
      expect(m.writeAutoDownloads).toHaveBeenCalledTimes(2);
      expect(m.writeAutoDownloads).toHaveBeenLastCalledWith([
        expect.objectContaining({ id: "book1", currentTime: 40 }),
      ]);
    });

    it("does NOT re-write for movements inside the same 15s bucket", () => {
      const m = loadFresh();
      m.userStore.setState({ mediaProgress: { book1: { currentTime: 3 } } });
      m.store.setState({ completedDownloads: { book1: audioItem("book1") } });
      expect(m.writeAutoDownloads).toHaveBeenCalledTimes(1);

      // 3 → 14 stays in bucket 0 — file writes must stay rare while playing.
      m.userStore.setState({ mediaProgress: { book1: { currentTime: 14 } } });
      expect(m.writeAutoDownloads).toHaveBeenCalledTimes(1);
    });

    it("falls back to the disk progress cache when the in-memory map is cold", () => {
      const m = loadFresh();
      // Nothing hydrated the in-memory map (headless boot), but the durable
      // cache knows the position — the mirrored file must not regress to 0.
      m.storageHelper.setMediaProgressCache({ book1: { currentTime: 300 } });

      m.store.setState({ completedDownloads: { book1: audioItem("book1") } });

      expect(m.writeAutoDownloads).toHaveBeenCalledTimes(1);
      expect(m.writeAutoDownloads).toHaveBeenLastCalledWith([
        expect.objectContaining({ id: "book1", currentTime: 300 }),
      ]);
    });
  });
});
