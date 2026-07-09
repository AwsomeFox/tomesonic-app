import { db, dbStorage } from "../../utils/db";

beforeEach(() => {
  dbStorage.getAllKeys().forEach((k) => dbStorage.remove(k));
});

describe("device data", () => {
  it("returns the empty default shape when nothing is saved", () => {
    expect(db.getDeviceData()).toEqual({
      serverConnectionConfigs: [],
      lastServerConnectionConfigId: null,
      currentLocalPlaybackSession: null,
      deviceSettings: {},
    });
  });

  it("round-trips saved device data", () => {
    db.saveDeviceData({ lastServerConnectionConfigId: "c1", deviceSettings: { x: 1 } });
    expect(db.getDeviceData()).toEqual({
      lastServerConnectionConfigId: "c1",
      deviceSettings: { x: 1 },
    });
  });
});

describe("local library items", () => {
  it("saves, lists, fetches and removes items", () => {
    db.saveLocalLibraryItem({ id: "a", mediaType: "book", title: "A" });
    db.saveLocalLibraryItem({ id: "b", mediaType: "podcast", title: "B" });

    expect(db.getLocalLibraryItem("a")).toMatchObject({ id: "a", title: "A" });
    expect(db.getLocalLibraryItem("nope")).toBeNull();

    const all = db.getLocalLibraryItems();
    expect(all.map((i: any) => i.id).sort()).toEqual(["a", "b"]);

    // mediaType filter
    expect(db.getLocalLibraryItems("book").map((i: any) => i.id)).toEqual(["a"]);

    db.removeLocalLibraryItem("a");
    expect(db.getLocalLibraryItem("a")).toBeNull();
  });

  it("looks up by libraryItemId", () => {
    db.saveLocalLibraryItem({ id: "local1", libraryItemId: "server1" });
    expect(db.getLocalLibraryItemByLId("server1")).toMatchObject({ id: "local1" });
    expect(db.getLocalLibraryItemByLId("missing")).toBeNull();
  });

  it("ignores items without an id", () => {
    db.saveLocalLibraryItem({ title: "no id" });
    db.saveLocalLibraryItem(null);
    expect(db.getLocalLibraryItems()).toHaveLength(0);
  });
});

describe("local folders", () => {
  it("saves, lists, fetches and removes folders", () => {
    db.saveLocalFolder({ id: "f1", name: "Folder 1" });
    db.saveLocalFolder({ id: "f2", name: "Folder 2" });
    db.saveLocalFolder({ name: "no id" }); // ignored

    expect(db.getAllLocalFolders()).toHaveLength(2);
    expect(db.getLocalFolder("f1")).toMatchObject({ name: "Folder 1" });
    expect(db.getLocalFolder("missing")).toBeNull();

    db.removeLocalFolder("f1");
    expect(db.getAllLocalFolders()).toHaveLength(1);
  });
});

describe("local media progress", () => {
  it("saves, lists, fetches and removes progress entries", () => {
    db.saveLocalMediaProgress({ id: "p1", currentTime: 10 });
    db.saveLocalMediaProgress({ id: "p2", currentTime: 20 });
    db.saveLocalMediaProgress({ currentTime: 30 }); // no id — ignored

    expect(db.getAllLocalMediaProgress()).toHaveLength(2);
    expect(db.getLocalMediaProgress("p1")).toMatchObject({ currentTime: 10 });
    expect(db.getLocalMediaProgress("missing")).toBeNull();

    db.removeLocalMediaProgress("p2");
    expect(db.getAllLocalMediaProgress()).toHaveLength(1);
  });
});

describe("downloads", () => {
  it("saves, lists and removes download records", () => {
    db.saveDownloadItem({ id: "d1", title: "Book 1" });
    db.saveDownloadItem({ id: "d2", title: "Book 2" });
    db.saveDownloadItem({ title: "no id" }); // ignored

    expect(db.getAllDownloads().map((d: any) => d.id).sort()).toEqual(["d1", "d2"]);
    db.removeDownloadItem("d1");
    expect(db.getAllDownloads().map((d: any) => d.id)).toEqual(["d2"]);
  });

  it("drops (and deletes) a corrupt download record instead of crashing", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    db.saveDownloadItem({ id: "good", title: "OK" });
    dbStorage.set("downloads_corrupt", "{not-json");

    const list = db.getAllDownloads();
    expect(list.map((d: any) => d.id)).toEqual(["good"]);
    // The corrupt record was removed from storage.
    expect(dbStorage.getString("downloads_corrupt")).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("logs", () => {
  it("saves logs (generating ids) and returns them sorted by timestamp", () => {
    db.saveLog({ message: "b", timestamp: 200 });
    db.saveLog({ message: "a", timestamp: 100 });
    db.saveLog({ id: "custom", message: "c", timestamp: 300 });

    const logs = db.getLogs();
    expect(logs.map((l: any) => l.message)).toEqual(["a", "b", "c"]);
    expect(logs.every((l: any) => !!l.id)).toBe(true);
    expect(logs[2].id).toBe("custom");
  });

  it("sorts logs deterministically even when some timestamps are missing/NaN", () => {
    // A record with no (or a non-numeric) timestamp must not poison the sort
    // with a NaN comparator — those records sort first (treated as 0) and the
    // valid ones stay in ascending order.
    db.saveLog({ id: "b", message: "b", timestamp: 200 });
    db.saveLog({ id: "missing", message: "missing" }); // no timestamp
    db.saveLog({ id: "a", message: "a", timestamp: 100 });
    db.saveLog({ id: "bad", message: "bad", timestamp: "oops" as any });

    const logs = db.getLogs();
    // The two valid timestamps keep their ascending order relative to each other.
    const ordered = logs.map((l: any) => l.message);
    expect(ordered.indexOf("a")).toBeLessThan(ordered.indexOf("b"));
    // Every input record is present (nothing dropped or lost by the sort).
    expect(ordered.sort()).toEqual(["a", "b", "bad", "missing"]);
  });

  it("cleanLogs removes entries older than the cutoff and keeps recent ones", () => {
    const now = Date.now();
    db.saveLog({ id: "old", message: "old", timestamp: now - 25 * 60 * 60 * 1000 });
    db.saveLog({ id: "fresh", message: "fresh", timestamp: now - 60 * 1000 });

    db.cleanLogs(24);

    const logs = db.getLogs();
    expect(logs.map((l: any) => l.id)).toEqual(["fresh"]);
  });

  it("cleanLogs honors a custom hoursToKeep", () => {
    const now = Date.now();
    db.saveLog({ id: "twoHours", message: "x", timestamp: now - 2 * 60 * 60 * 1000 });
    db.cleanLogs(1);
    expect(db.getLogs()).toHaveLength(0);
  });
});
