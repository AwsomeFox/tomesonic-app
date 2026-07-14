/**
 * DOWNLOAD-STORE REHYDRATE ACROSS A PROCESS KILL.
 *
 * The download library persists through utils/db, which is MMKV-backed
 * (`createMMKV({ id: "tomesonic-db" })`) — NOT a separate SQLite layer. So the
 * shared persistentMmkvDisk harness already models its durability: every
 * `createMMKV({id})` map lives on globalThis and survives boot()'s
 * jest.resetModules() "kill", exactly like flash storage across a real process
 * death. These pin that a completed download saved before the kill rehydrates
 * into completedDownloads after it, and that the loader's namespace + corruption
 * guarantees hold across the boundary.
 *
 * WHAT loadDownloadsFromDb GUARANTEES (read the loader before asserting more):
 *   - Only the CURRENT session's rows surface (namespaced by sessionKey); other
 *     accounts' rows stay on disk, untouched, unsurfaced.
 *   - status "completed" → completedDownloads[id].
 *   - A corrupt/garbage downloads_ record is DROPPED by db.getAllDownloads and
 *     never crashes the restore; the healthy rows still load.
 */
jest.mock("react-native-mmkv", () => require("./persistentMmkvDisk.cjs").mmkvDiskModule());
jest.mock("../../utils/api", () => require("./persistentMmkvDisk.cjs").apiMockModule());
jest.mock("../../utils/progressSync", () =>
  require("./persistentMmkvDisk.cjs").progressSyncMockModule()
);
jest.mock("../../utils/autoCreds", () => require("./persistentMmkvDisk.cjs").autoCredsMockModule());
jest.mock("../../utils/upNext", () => require("./persistentMmkvDisk.cjs").upNextMockModule());
// The loader's best-effort orphan sweep at the end of hydration must not pull in
// the real (native-heavy) downloader; it's fire-and-forget and irrelevant here.
jest.mock("../../utils/downloader", () => ({
  downloader: { sweepOrphanFolders: jest.fn(), sweepStaleZipArtifacts: jest.fn() },
}));

const { boot, wipeDisk } = require("./persistentMmkvDisk.cjs");

const SESSION_A = "https://abs.example.com::userA";
const SESSION_B = "https://abs.example.com::userB";

/** A completed-download DB row for the given account. */
function completedRow(id: string, sessionKey: string) {
  return {
    id,
    libraryItemId: id,
    sessionKey,
    title: `Book ${id}`,
    author: "Author",
    coverUrl: "",
    progress: 1,
    status: "completed",
    parts: [],
  };
}

/** A fresh "process" over the same MMKV disk, exposing the download surface. */
function bootDownloads() {
  const w = boot(); // fresh module registry, same globalThis disk
  return {
    ...w,
    db: require("../../utils/db").db,
    dbStorage: require("../../utils/db").dbStorage,
    useDownloadStore: require("../../store/useDownloadStore").useDownloadStore,
  };
}

describe("download-store rehydrate across a process kill (MMKV-backed db)", () => {
  beforeEach(() => {
    wipeDisk();
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("a completed download saved before the kill rehydrates into completedDownloads", () => {
    // Boot 1: sign in (persist the session key) and save a completed download.
    let w = bootDownloads();
    w.storageHelper.setLastSessionKey(SESSION_A);
    w.db.saveDownloadItem(completedRow("bookA", SESSION_A));

    // KILL: fresh module registry (stores/db re-required) over the same disk.
    w = bootDownloads();

    // The session key survived on the "tomesonic-settings" MMKV instance…
    expect(w.storageHelper.getLastSessionKey()).toBe(SESSION_A);

    // …and the download row survived on the "tomesonic-db" instance and
    // rehydrates on load.
    w.useDownloadStore.getState().loadDownloadsFromDb();
    const state = w.useDownloadStore.getState();
    expect(state.downloadsLoaded).toBe(true);
    expect(state.completedDownloads.bookA).toBeDefined();
    expect(state.completedDownloads.bookA.title).toBe("Book bookA");
  });

  it("namespace isolation: another account's completed row is NOT surfaced under the current session", () => {
    let w = bootDownloads();
    w.storageHelper.setLastSessionKey(SESSION_A);
    w.db.saveDownloadItem(completedRow("mine", SESSION_A));
    w.db.saveDownloadItem(completedRow("theirs", SESSION_B));

    // KILL.
    w = bootDownloads();
    w.useDownloadStore.getState().loadDownloadsFromDb();
    const state = w.useDownloadStore.getState();

    expect(state.completedDownloads.mine).toBeDefined();
    // Belongs to account B — left on disk, not surfaced for A.
    expect(state.completedDownloads.theirs).toBeUndefined();

    // And the other account's row is still on disk (only unsurfaced), so
    // switching back to B would re-adopt it.
    const onDisk = w.db.getAllDownloads().map((d: any) => d.id).sort();
    expect(onDisk).toEqual(["mine", "theirs"]);
  });

  it("a corrupt/garbage downloads_ record is dropped and never crashes the restore", () => {
    let w = bootDownloads();
    w.storageHelper.setLastSessionKey(SESSION_A);
    w.db.saveDownloadItem(completedRow("good", SESSION_A));
    // A truncated/garbage write under the downloads_ namespace (flash corruption
    // or an interrupted save) sitting next to a healthy record.
    w.dbStorage.set("downloads_corrupt", "{not-json");

    // KILL.
    w = bootDownloads();
    expect(() => w.useDownloadStore.getState().loadDownloadsFromDb()).not.toThrow();

    const state = w.useDownloadStore.getState();
    // The healthy record still hydrated…
    expect(state.completedDownloads.good).toBeDefined();
    // …and the corrupt record was dropped from disk so it can't re-break the
    // next boot (db.getAllDownloads removes it in place).
    expect(w.dbStorage.getString("downloads_corrupt")).toBeUndefined();
  });
});
