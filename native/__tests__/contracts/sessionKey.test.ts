/**
 * SESSION-KEY DERIVATION CONTRACT.
 *
 * Downloads are namespaced on disk by `${serverAddress}::${userId}`. TWO
 * independent producers build that string with no shared helper:
 *
 *   1. useUserStore — login()/initialize() stamp it into MMKV as
 *      `lastSessionKey` (`${(address).replace(/\/$/, "")}::${userId||user.id||""}`).
 *   2. useDownloadStore.currentSessionKey() — prefers the stamped
 *      lastSessionKey, but FALLS BACK to deriving the same string from the
 *      live server config (`${address minus trailing slash}::${userId}`).
 *
 * If the two ever diverge byte-for-byte (a normalization tweak on one side, a
 * separator change, a different fallback), loadDownloadsFromDb filters every
 * existing download row out of the "current" namespace: files stay on disk
 * but the whole offline library silently vanishes from the UI. These tests
 * drive BOTH real code paths with the same config and assert equality.
 */
jest.mock("../../utils/api", () => ({
  api: {
    get: jest.fn().mockResolvedValue({ data: {} }),
    post: jest.fn().mockResolvedValue({ data: {} }),
    patch: jest.fn().mockResolvedValue({ data: {} }),
    delete: jest.fn().mockResolvedValue({ data: {} }),
  },
}));
jest.mock("../../utils/autoCreds", () => ({
  writeAutoCreds: jest.fn().mockResolvedValue(undefined),
  readAutoCreds: jest.fn().mockResolvedValue(null),
  writeAutoDownloads: jest.fn().mockResolvedValue(undefined),
  writeWidgetState: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../utils/downloader", () => ({
  downloader: {
    abortBookParts: jest.fn().mockResolvedValue(undefined),
    resumeDownload: jest.fn().mockResolvedValue(undefined),
    sweepOrphanFolders: jest.fn().mockResolvedValue(undefined),
  },
}));

import { db, dbStorage } from "../../utils/db";
import { storage, storageHelper, secureStorage } from "../../utils/storage";
import { useUserStore } from "../../store/useUserStore";
import { useDownloadStore } from "../../store/useDownloadStore";

const initialUser = useUserStore.getState();
const initialDownloads = useDownloadStore.getState();

let seq = 0;

/** Producer 1: the key useUserStore.login stamps into lastSessionKey. */
async function loginStampedKey(config: any, user: any): Promise<string | undefined> {
  // No prior key → login's account-switch wipe branch is skipped; we only
  // exercise the derivation.
  storage.remove("lastSessionKey");
  await useUserStore.getState().login(config, user);
  return storage.getString("lastSessionKey");
}

/**
 * Producer 2: the key useDownloadStore.currentSessionKey() derives FROM THE
 * CONFIG ALONE (lastSessionKey removed so the fallback path runs). Observed
 * through the real store: a legacy (un-namespaced) DB row is migrated by
 * loadDownloadsFromDb and stamped with the derived key. Returns null when the
 * store derived no key (row left untagged, nothing surfaced).
 */
function downloadConfigDerivedKey(config: any): string | null {
  storage.remove("lastSessionKey");
  storageHelper.setServerConfig(config);
  const rowId = `legacy-${seq++}`;
  db.saveDownloadItem({ id: rowId, libraryItemId: rowId, title: "T", parts: [] });
  useDownloadStore.getState().loadDownloadsFromDb();
  const row = db.getAllDownloads().find((r: any) => r.id === rowId);
  return row?.sessionKey ?? null;
}

/** Producer 2, durable path: currentSessionKey() when lastSessionKey EXISTS. */
function downloadStampedKey(): string | null {
  const rowId = `legacy-${seq++}`;
  db.saveDownloadItem({ id: rowId, libraryItemId: rowId, title: "T", parts: [] });
  useDownloadStore.getState().loadDownloadsFromDb();
  const row = db.getAllDownloads().find((r: any) => r.id === rowId);
  return row?.sessionKey ?? null;
}

const flush = () => new Promise((r) => setImmediate(r));

describe("session-key derivation: useUserStore vs useDownloadStore", () => {
  beforeEach(() => {
    useUserStore.setState(initialUser, true);
    useDownloadStore.setState(initialDownloads, true);
    storage.clearAll();
    secureStorage.clearAll();
    dbStorage.clearAll();
  });

  afterEach(async () => {
    // Let login's fire-and-forget loadEReaderDevices settle inside the test.
    await flush();
  });

  it("trailing-slash address: both producers strip it and agree", async () => {
    const config = { address: "https://abs.example.com/", userId: "u1", token: "tok" };
    const stamped = await loginStampedKey(config, { id: "u1" });
    expect(stamped).toBe("https://abs.example.com::u1");

    dbStorage.clearAll();
    const derived = downloadConfigDerivedKey(config);
    expect(derived).toBe(stamped);
  });

  it("no trailing slash: both producers agree unchanged", async () => {
    const config = { address: "https://abs.example.com", userId: "u1", token: "tok" };
    const stamped = await loginStampedKey(config, { id: "u1" });
    expect(stamped).toBe("https://abs.example.com::u1");

    dbStorage.clearAll();
    const derived = downloadConfigDerivedKey(config);
    expect(derived).toBe(stamped);
  });

  it("config missing userId: login falls back to user.id; the download store's CONFIG path deliberately derives NOTHING", async () => {
    const config = { address: "https://abs.example.com", token: "tok" }; // no userId
    const stamped = await loginStampedKey(config, { id: "u9" });
    expect(stamped).toBe("https://abs.example.com::u9");

    // BY DESIGN (see currentSessionKey's doc comment): the config fallback
    // requires BOTH address AND userId — a userId-less config would mint an
    // ambiguous "addr::" namespace that could permanently mis-scope downloads,
    // so the store returns null, defers migration, and surfaces nothing.
    dbStorage.clearAll();
    const derived = downloadConfigDerivedKey(config);
    expect(derived).toBeNull();
    expect(useDownloadStore.getState().completedDownloads).toEqual({});
    expect(useDownloadStore.getState().activeDownloads).toEqual({});
    // downloadsLoaded still flips (hydration finished, namespace just empty).
    expect(useDownloadStore.getState().downloadsLoaded).toBe(true);

    // The CONTRACT still holds through the durable path: with login's stamped
    // key present, currentSessionKey() adopts it verbatim.
    dbStorage.clearAll();
    storage.set("lastSessionKey", stamped!);
    storageHelper.setServerConfig(config);
    expect(downloadStampedKey()).toBe(stamped);
  });

  it("empty address: login stamps '::<userId>'; download store agrees via the stamped key (config path yields null)", async () => {
    const config = { address: "", userId: "u1", token: "tok" };
    const stamped = await loginStampedKey(config, { id: "u1" });
    expect(stamped).toBe("::u1");

    // Config fallback requires a truthy address → null, nothing migrated.
    dbStorage.clearAll();
    expect(downloadConfigDerivedKey(config)).toBeNull();

    // Durable path: the two stores still agree on the (degenerate) key.
    dbStorage.clearAll();
    storage.set("lastSessionKey", stamped!);
    storageHelper.setServerConfig(config);
    expect(downloadStampedKey()).toBe(stamped);
  });

  it("both producers use the same '::' separator (a download row stamped by one is adopted by the other)", async () => {
    // End-to-end: login stamps the key, a fresh row saved WITH that key is
    // surfaced by loadDownloadsFromDb under the same account.
    const config = { address: "https://abs.example.com", userId: "u1", token: "tok" };
    const stamped = await loginStampedKey(config, { id: "u1" });
    dbStorage.clearAll();
    db.saveDownloadItem({
      id: "bookA",
      libraryItemId: "bookA",
      title: "Book A",
      status: "completed",
      progress: 1,
      parts: [],
      sessionKey: stamped,
    });
    useDownloadStore.getState().loadDownloadsFromDb();
    expect(useDownloadStore.getState().completedDownloads.bookA).toBeDefined();
  });

  // NOTE (near-miss, not asserted): login()/currentSessionKey() strip ONE
  // trailing slash (/\/$/) while progressSync.currentSid() and
  // updateServerAddress's oldKey fallback strip ALL (/\/+$/). With a config
  // address ending in MULTIPLE slashes the two families disagree
  // ("https://x/::u1" vs "https://x::u1"). In practice ConnectScreen
  // normalizes addresses with /\/+$/ before saving, so multi-slash configs
  // shouldn't exist — but if address normalization ever loosens, this is the
  // first place downloads/pending-syncs would strand.
});
