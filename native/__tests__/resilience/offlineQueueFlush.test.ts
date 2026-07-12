/**
 * OFFLINE-QUEUE RESILIENCE — offline listening is not lost across a kill.
 *
 * HONESTY: no real doze/kill is simulated — this covers the queue/flush state
 * machine in JS. "Kill" = jest.resetModules() over a globalThis-backed MMKV
 * disk (see persistentMmkvDisk.cjs).
 *
 * Under test: the REAL utils/progressSync — sample queueing while offline
 * (pendingSync_* merge, monotonic `at` stamping, sid scoping), kill+rehydrate
 * persistence (including a kill DURING an in-flight flush), the flush (server
 * POST/PATCH per queued sample, drain on success, keep on failure), and the
 * _flushInFlight mutex.
 */

jest.mock("react-native-mmkv", () => require("./persistentMmkvDisk.cjs").mmkvDiskModule());
jest.mock("../../utils/api", () => require("./persistentMmkvDisk.cjs").apiMockModule());

// recordLocalListening lazy-requires the download store for display metadata —
// mock it so the suite doesn't pull in expo-file-system/db (same as the
// existing progressSync unit tests). Suite-specific, so not in the harness.
jest.mock("../../store/useDownloadStore", () => ({
  episodeDownloadKey: (itemId: string, episodeId: string) => `${itemId}::${episodeId}`,
  useDownloadStore: {
    getState: () => ({ completedDownloads: {} }),
  },
}));

const { boot: bootHarness, wipeDisk } = require("./persistentMmkvDisk.cjs");

// This suite exercises the REAL progressSync over mocked api/storage — no
// zustand stores needed.
const boot = () => bootHarness({ stores: false, progressSync: true });

const BASE = new Date("2026-04-02T09:00:00Z").getTime();

const netErr = () => new Error("Network Error");

const CONFIG_A = {
  address: "https://abs.example.com",
  token: "tokA",
  userId: "userA",
  username: "a",
};
const CONFIG_B = {
  address: "https://abs.example.com",
  token: "tokB",
  userId: "userB",
  username: "b",
};

describe("offline-queue resilience (JS state machine — kill = module reset, MMKV disk preserved)", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(BASE);
    wipeDisk();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("samples queued offline MERGE durably, survive a kill, and flush to the server once online", async () => {
    // --- offline listening: every sync fails, samples must queue ---
    let w = boot();
    w.storageHelper.setServerConfig(CONFIG_A);
    w.api.post.mockRejectedValue(netErr());
    w.api.patch.mockRejectedValue(netErr());

    await w.ps.syncProgress({
      sessionId: "s1",
      currentTime: 100,
      timeListened: 15,
      duration: 3600,
      libraryItemId: "item1",
    });
    jest.setSystemTime(BASE + 30_000);
    await w.ps.syncProgress({
      sessionId: "s1",
      currentTime: 130,
      timeListened: 20,
      duration: 3600,
      libraryItemId: "item1",
    });

    // Offline-started (local_) session: banks the seconds + a direct PATCH.
    await w.ps.syncProgress({
      sessionId: "local_item2",
      currentTime: 50,
      timeListened: 10,
      duration: 600,
    });

    // One merged pendingSync entry: freshest position, accumulated seconds,
    // sid stamped with the enqueueing account.
    const pending = JSON.parse(w.storage.getString("pendingSync_s1")!);
    expect(pending).toMatchObject({
      sessionId: "s1",
      currentTime: 130,
      timeListened: 35,
      duration: 3600,
      libraryItemId: "item1",
      sid: "https://abs.example.com::userA",
    });
    // Monotonic `at` stamp is present (freshest-wins keying).
    expect(Number(pending.at)).toBeGreaterThanOrEqual(BASE + 30_000);
    expect(w.storage.getString("pendingPatch_item2")).toBeDefined();
    expect(w.storage.getString("pendingLocalSession_local_item2_2026-04-02")).toBeDefined();

    // ---- PROCESS DEATH: queue must persist ----
    w = boot();
    expect(w.storage.getString("pendingSync_s1")).toBeDefined();
    expect(w.storage.getString("pendingPatch_item2")).toBeDefined();
    expect(w.ps.hasAnyPendingSyncs()).toBe(true);

    // --- back online: flush drains everything to the server ---
    w.api.post.mockResolvedValue({ data: {} });
    w.api.patch.mockResolvedValue({ data: {} });
    await w.ps.flushPendingSyncs();

    expect(w.api.post).toHaveBeenCalledWith("/api/session/s1/sync", {
      currentTime: 130,
      timeListened: 35,
      duration: 3600,
    });
    expect(w.api.patch).toHaveBeenCalledWith(
      "/api/me/progress/item2",
      expect.objectContaining({ currentTime: 50, duration: 600 })
    );
    expect(w.api.post).toHaveBeenCalledWith(
      "/api/session/local",
      expect.objectContaining({ libraryItemId: "item2", timeListening: 10 })
    );

    // Queue drained: no pending syncs/patches left. (The local-session DAY
    // record intentionally stays for same-day accumulation, but is marked
    // delivered — nothing is still owed to the server.)
    expect(w.storage.getAllKeys().filter((k: string) => k.startsWith("pendingSync_"))).toEqual([]);
    expect(w.storage.getAllKeys().filter((k: string) => k.startsWith("pendingPatch_"))).toEqual([]);
    expect(w.ps.hasAnyPendingSyncs()).toBe(false);
  });

  it("a flush error leaves unflushed samples queued — no data loss, delivered on the next flush", async () => {
    const w = boot();
    w.storageHelper.setServerConfig(CONFIG_A);
    w.api.post.mockRejectedValue(netErr());
    await w.ps.syncProgress({
      sessionId: "s1",
      currentTime: 100,
      timeListened: 15,
      duration: 3600,
      libraryItemId: "item1",
    });

    // Still offline: the flush itself fails — the entry must remain intact.
    await w.ps.flushPendingSyncs();
    expect(JSON.parse(w.storage.getString("pendingSync_s1")!)).toMatchObject({
      currentTime: 100,
      timeListened: 15,
    });

    // Next flush (online) delivers and drains.
    w.api.post.mockResolvedValue({ data: {} });
    await w.ps.flushPendingSyncs();
    expect(w.api.post).toHaveBeenCalledWith("/api/session/s1/sync", {
      currentTime: 100,
      timeListened: 15,
      duration: 3600,
    });
    expect(w.storage.getString("pendingSync_s1")).toBeUndefined();
  });

  it("a kill DURING an in-flight flush loses nothing: entries clear only AFTER the POST resolves, and redeliver exactly once after reboot", async () => {
    let w = boot();
    w.storageHelper.setServerConfig(CONFIG_A);
    w.api.post.mockRejectedValue(netErr());
    await w.ps.syncProgress({
      sessionId: "s1",
      currentTime: 100,
      timeListened: 15,
      duration: 3600,
      libraryItemId: "item1",
    });
    w.api.post.mockClear();

    // Connectivity returns; hold the flush's POST open (on the wire, no
    // response yet).
    const resolvers: Array<(v: any) => void> = [];
    w.api.post.mockImplementation(() => new Promise((res) => resolvers.push(res)));
    const inFlight = w.ps.flushPendingSyncs();
    while (resolvers.length === 0) await Promise.resolve();

    // The POST is in flight but UNACKNOWLEDGED — the entry must still be on
    // disk. A refactor that clears the entry before awaiting the POST would
    // pass every quiescent-point test yet silently lose the sample on a kill
    // in exactly this window.
    expect(w.storage.getString("pendingSync_s1")).toBeDefined();

    // ---- PROCESS DEATH mid-flight: the response is never observed. ----
    // (The dead run's promise is deliberately left unresolved — that JS is
    // gone. Resolving it would model a zombie process still mutating disk.)
    void inFlight;
    w = boot();
    expect(w.storage.getString("pendingSync_s1")).toBeDefined();

    // The reboot flush delivers the sample exactly once and drains it.
    // Semantics are AT-LEAST-ONCE overall: the killed process's POST may also
    // have landed server-side; a resend of the same session sync is the
    // designed recovery, while clear-before-resolve would be at-most-once
    // (silent loss on kill).
    w.api.post.mockResolvedValue({ data: {} });
    await w.ps.flushPendingSyncs();
    const syncPosts = w.api.post.mock.calls.filter((c: any[]) => c[0] === "/api/session/s1/sync");
    expect(syncPosts).toHaveLength(1);
    expect(syncPosts[0][1]).toEqual({ currentTime: 100, timeListened: 15, duration: 3600 });
    expect(w.storage.getString("pendingSync_s1")).toBeUndefined();
  });

  it("the _flushInFlight mutex shares one in-flight run — concurrent callers cannot double-POST a sample", async () => {
    const w = boot();
    w.storageHelper.setServerConfig(CONFIG_A);
    w.api.post.mockRejectedValue(netErr());
    await w.ps.syncProgress({
      sessionId: "s1",
      currentTime: 100,
      timeListened: 15,
      duration: 3600,
      libraryItemId: "item1",
    });
    w.api.post.mockClear();

    // Hold the flush's POST open, then start two "concurrent" flushes.
    const resolvers: Array<(v: any) => void> = [];
    w.api.post.mockImplementation(() => new Promise((res) => resolvers.push(res)));

    const p1 = w.ps.flushPendingSyncs();
    const p2 = w.ps.flushPendingSyncs();
    // Same in-flight promise — the second caller joined the first run.
    expect(p2).toBe(p1);

    // Let the POST land and the run finish.
    while (resolvers.length === 0) await Promise.resolve();
    resolvers.forEach((res) => res({ data: {} }));
    await p1;

    // Exactly ONE sync POST for the entry, and the queue is drained.
    const syncPosts = w.api.post.mock.calls.filter((c: any[]) => c[0] === "/api/session/s1/sync");
    expect(syncPosts).toHaveLength(1);
    expect(w.storage.getString("pendingSync_s1")).toBeUndefined();

    // Mutex RELEASED: a NEW sample queued after the run must be delivered by
    // a fresh flush. (If the finally-release regressed, flushPendingSyncs
    // would keep returning the completed first run and s2 would never post —
    // an empty-queue third call would NOT catch that.)
    w.api.post.mockClear();
    w.api.post.mockRejectedValue(netErr());
    await w.ps.syncProgress({
      sessionId: "s2",
      currentTime: 10,
      timeListened: 5,
      duration: 600,
      libraryItemId: "item2",
    });
    expect(w.storage.getString("pendingSync_s2")).toBeDefined();

    w.api.post.mockClear();
    w.api.post.mockResolvedValue({ data: {} });
    await w.ps.flushPendingSyncs();
    expect(
      w.api.post.mock.calls.filter((c: any[]) => c[0] === "/api/session/s2/sync")
    ).toHaveLength(1);
    expect(w.storage.getString("pendingSync_s2")).toBeUndefined();
  });

  it("cross-account safety: samples stamped with account A's sid never flush under account B — even across a kill", async () => {
    // Account A queues offline listening (session sync + direct patch).
    let w = boot();
    w.storageHelper.setServerConfig(CONFIG_A);
    w.api.post.mockRejectedValue(netErr());
    w.api.patch.mockRejectedValue(netErr());
    await w.ps.syncProgress({
      sessionId: "sA",
      currentTime: 100,
      timeListened: 15,
      duration: 3600,
      libraryItemId: "itemA",
    });
    w.ps.queueProgressPatch("itemA", 100, 3600);
    expect(JSON.parse(w.storage.getString("pendingSync_sA")!).sid).toBe(
      "https://abs.example.com::userA"
    );
    expect(JSON.parse(w.storage.getString("pendingPatch_itemA")!).sid).toBe(
      "https://abs.example.com::userA"
    );

    // ---- PROCESS DEATH, then account B logs in on the same server ----
    w = boot();
    w.storageHelper.setServerConfig(CONFIG_B);
    w.api.post.mockResolvedValue({ data: {} });
    w.api.patch.mockResolvedValue({ data: {} });

    await w.ps.flushPendingSyncs();

    // Nothing of A's flushed under B's token…
    expect(w.api.post).not.toHaveBeenCalledWith("/api/session/sA/sync", expect.anything());
    expect(w.api.patch).not.toHaveBeenCalled();
    // …and A's samples are NOT dropped (they wait for A to be current again).
    expect(w.storage.getString("pendingSync_sA")).toBeDefined();
    expect(w.storage.getString("pendingPatch_itemA")).toBeDefined();

    // A logs back in: the same entries now deliver under A's identity.
    w.storageHelper.setServerConfig(CONFIG_A);
    await w.ps.flushPendingSyncs();
    expect(w.api.post).toHaveBeenCalledWith("/api/session/sA/sync", {
      currentTime: 100,
      timeListened: 15,
      duration: 3600,
    });
    expect(w.api.patch).toHaveBeenCalledWith(
      "/api/me/progress/itemA",
      expect.objectContaining({ currentTime: 100 })
    );
    expect(w.storage.getString("pendingSync_sA")).toBeUndefined();
    expect(w.storage.getString("pendingPatch_itemA")).toBeUndefined();
  });

  it("monotonic `at` stamping survives a kill: a backward wall clock after restart cannot let a stale entry outrank new samples", async () => {
    // Queue at BASE+60s under a failing network.
    let w = boot();
    w.storageHelper.setServerConfig(CONFIG_A);
    w.api.post.mockRejectedValue(netErr());
    jest.setSystemTime(BASE + 60_000);
    await w.ps.syncProgress({
      sessionId: "s1",
      currentTime: 200,
      timeListened: 10,
      duration: 3600,
      libraryItemId: "item1",
    });
    const atBefore = Number(JSON.parse(w.storage.getString("pendingSync_s1")!).at);
    expect(atBefore).toBeGreaterThanOrEqual(BASE + 60_000);

    // ---- PROCESS DEATH + the clock jumps BACKWARD (NTP correction) ----
    w = boot();
    jest.setSystemTime(BASE); // 60s before the persisted stamp
    w.api.post.mockRejectedValue(netErr());
    await w.ps.syncProgress({
      sessionId: "s1",
      currentTime: 230, // NEWER listening, older wall clock
      timeListened: 5,
      duration: 3600,
      libraryItemId: "item1",
    });

    const merged = JSON.parse(w.storage.getString("pendingSync_s1")!);
    // The new sample's stamp was seeded past the persisted one, so the NEWER
    // position won the merge (and the seconds accumulated).
    expect(merged.currentTime).toBe(230);
    expect(merged.timeListened).toBe(15);
    expect(Number(merged.at)).toBeGreaterThan(atBefore);
  });
});
