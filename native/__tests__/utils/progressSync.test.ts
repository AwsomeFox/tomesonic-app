import { storage, storageHelper } from "../../utils/storage";
import { api } from "../../utils/api";
import {
  syncProgress,
  closeSession,
  flushPendingSyncs,
  clearAllPending,
  queueProgressPatch,
  queueEbookProgressPatch,
  queueFinishedPatch,
  queueBookmark,
  queueBookmarkDeletion,
  pendingBookmarkDeletionsFor,
  queueBookmarkRename,
  pendingBookmarkRenamesFor,
  recordLocalListening,
  hasAnyPendingSyncs,
  syncBothProgressFraction,
  reconcileLinkedProgress,
  isProgressLinked,
  remapPendingSids,
} from "../../utils/progressSync";
import { useUserStore } from "../../store/useUserStore";

jest.mock("../../utils/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

// recordLocalListening lazy-requires the download store for display metadata —
// mock it so the test doesn't pull in expo-file-system/db, and so we can
// assert the display fields land in the POSTed local session.
jest.mock("../../store/useDownloadStore", () => ({
  // Episodes key by the composite `${itemId}::${episodeId}` (real signature) —
  // recordLocalListening must resolve display metadata via this key for an
  // episode, not the bare libraryItemId.
  episodeDownloadKey: (itemId: string, episodeId: string) => `${itemId}::${episodeId}`,
  useDownloadStore: {
    getState: () => ({
      completedDownloads: {
        li1: { title: "Book One", author: "Author A" },
        // A downloaded podcast episode, stored under the COMPOSITE key.
        "pod1::ep1": { title: "Episode One", author: "Podcaster P" },
      },
    }),
  },
}));

const mockedPost = jest.mocked(api.post);
const mockedPatch = jest.mocked(api.patch);
const mockedDelete = jest.mocked(api.delete);

const err404 = () => ({ response: { status: 404 } });
const errNetwork = () => new Error("Network Error");

const readJson = (key: string) => {
  const raw = storage.getString(key);
  return raw ? JSON.parse(raw) : null;
};
const pendingKeys = () => storage.getAllKeys().filter((k) => k.startsWith("pendingSync_"));
const patchKeys = () => storage.getAllKeys().filter((k) => k.startsWith("pendingPatch_"));
const bookmarkDeleteKeys = () =>
  storage.getAllKeys().filter((k) => k.startsWith("pendingBookmarkDelete_"));
// "pendingBookmarkDelete_*" does NOT match the "pendingBookmark_" prefix
// (the char after "pendingBookmark" is "D", not "_"), so this is create-only.
const bookmarkKeys = () => storage.getAllKeys().filter((k) => k.startsWith("pendingBookmark_"));
const bookmarkRenameKeys = () =>
  storage.getAllKeys().filter((k) => k.startsWith("pendingBookmarkRename_"));
const localSessionKeys = () =>
  storage.getAllKeys().filter((k) => k.startsWith("pendingLocalSession_"));

beforeEach(() => {
  storage.getAllKeys().forEach((k) => storage.remove(k));
  // Queuing is gated on a stored session (a logged-out device must never bank
  // offline syncs) — these tests exercise the logged-IN paths.
  storageHelper.setServerConfig({ address: "http://abs.local", token: "tok" });
  mockedPost.mockResolvedValue({ data: {} } as any);
  mockedPatch.mockResolvedValue({ data: {} } as any);
  mockedDelete.mockResolvedValue({ data: {} } as any);
});

describe("syncProgress", () => {
  it("posts to /api/session/:id/sync on the happy path and queues nothing", async () => {
    await syncProgress({ sessionId: "s1", currentTime: 100, timeListened: 10, duration: 3600 });
    expect(mockedPost).toHaveBeenCalledWith("/api/session/s1/sync", {
      currentTime: 100,
      timeListened: 10,
      duration: 3600,
    });
    expect(pendingKeys()).toHaveLength(0);
  });

  it("is a no-op without a session id", async () => {
    await syncProgress({ sessionId: "", currentTime: 1, timeListened: 1, duration: 1 });
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it("queues the payload on failure instead of throwing", async () => {
    mockedPost.mockRejectedValue(errNetwork());
    await expect(
      syncProgress({ sessionId: "s1", currentTime: 50, timeListened: 5, duration: 3600 })
    ).resolves.toBeUndefined();
    expect(readJson("pendingSync_s1")).toEqual({
      sessionId: "s1",
      currentTime: 50,
      duration: 3600,
      timeListened: 5,
      at: expect.any(Number),
    });
  });

  it("merges repeated offline ticks: timeListened accumulates, latest position wins", async () => {
    mockedPost.mockRejectedValue(errNetwork());
    await syncProgress({ sessionId: "s1", currentTime: 50, timeListened: 5, duration: 3600 });
    await syncProgress({ sessionId: "s1", currentTime: 65, timeListened: 15, duration: 3601 });
    await syncProgress({ sessionId: "s1", currentTime: 80, timeListened: 15, duration: 3602 });
    expect(readJson("pendingSync_s1")).toEqual({
      sessionId: "s1",
      currentTime: 80, // latest wins
      duration: 3602, // latest wins
      timeListened: 35, // 5 + 15 + 15 accumulates
      at: expect.any(Number),
    });
  });

  it("an OLDER sync failing AFTER a newer close cannot regress the queued position", async () => {
    // Failures are observed out of request order: the close (position 105)
    // fails fast and queues first; the earlier tick's sync (position 100)
    // times out later. Last-caller-wins used to let 100 overwrite 105.
    mockedPost.mockRejectedValue(errNetwork());
    await closeSession({
      sessionId: "s1",
      currentTime: 105,
      timeListened: 5,
      duration: 3600,
      at: 2000,
    } as any);
    await syncProgress({
      sessionId: "s1",
      currentTime: 100,
      timeListened: 1,
      duration: 3600,
      at: 1000,
    } as any);
    const queued = readJson("pendingSync_s1");
    expect(queued.currentTime).toBe(105); // freshest position wins
    expect(queued.timeListened).toBe(6); // both contributions kept
  });

  it("converts a 404 (session dropped server-side) to a queued progress PATCH", async () => {
    mockedPost.mockRejectedValue(err404());
    mockedPatch.mockRejectedValue(errNetwork()); // keep the patch queued for inspection
    await syncProgress({
      sessionId: "s1",
      currentTime: 120,
      timeListened: 10,
      duration: 600,
      libraryItemId: "li1",
    });
    expect(pendingKeys()).toHaveLength(0); // NOT queued as a session sync
    expect(readJson("pendingPatch_li1")).toEqual({
      libraryItemId: "li1",
      body: { currentTime: 120, duration: 600, progress: 0.2 },
    });
  });

  it("queues a pending sync on 404 when the library item is unknown", async () => {
    mockedPost.mockRejectedValue(err404());
    await syncProgress({ sessionId: "s1", currentTime: 120, timeListened: 10, duration: 600 });
    expect(readJson("pendingSync_s1")).toMatchObject({ currentTime: 120, timeListened: 10 });
    expect(patchKeys()).toHaveLength(0);
  });

  it("routes local_ sessions to a direct progress PATCH keyed by the bare item id", async () => {
    mockedPatch.mockRejectedValue(errNetwork());
    await syncProgress({
      sessionId: "local_item9",
      currentTime: 30,
      timeListened: 30,
      duration: 120,
    });
    expect(mockedPost).not.toHaveBeenCalled();
    expect(readJson("pendingPatch_item9")).toEqual({
      libraryItemId: "item9",
      body: { currentTime: 30, duration: 120, progress: 0.25 },
    });
  });

  it("local_ session with an episode queues under a composite key with the episode path", async () => {
    mockedPatch.mockRejectedValue(errNetwork());
    await syncProgress({
      sessionId: "local_pod1",
      currentTime: 10,
      timeListened: 10,
      duration: 100,
      episodeId: "ep1",
    });
    expect(readJson("pendingPatch_pod1-ep1")).toEqual({
      libraryItemId: "pod1",
      episodeId: "ep1",
      body: { currentTime: 10, duration: 100, progress: 0.1 },
    });

    // Join the fire-and-forget flush syncProgress kicked off (patch rejects,
    // entry stays queued), then flush again with connectivity restored.
    await flushPendingSyncs();
    mockedPatch.mockResolvedValue({ data: {} } as any);
    await flushPendingSyncs();
    expect(mockedPatch).toHaveBeenCalledWith("/api/me/progress/pod1/ep1", {
      currentTime: 10,
      duration: 100,
      progress: 0.1,
    });
    expect(patchKeys()).toHaveLength(0);
  });
});

describe("closeSession", () => {
  it("posts to /api/session/:id/close on the happy path", async () => {
    await closeSession({ sessionId: "s1", currentTime: 99, timeListened: 9, duration: 900 });
    expect(mockedPost).toHaveBeenCalledWith("/api/session/s1/close", {
      currentTime: 99,
      timeListened: 9,
      duration: 900,
    });
  });

  it("is a no-op without a session id", async () => {
    await closeSession({ sessionId: "", currentTime: 1, timeListened: 1, duration: 1 });
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it("queues a pending sync on failure", async () => {
    mockedPost.mockRejectedValue(errNetwork());
    await closeSession({ sessionId: "s2", currentTime: 40, timeListened: 4, duration: 400 });
    expect(readJson("pendingSync_s2")).toMatchObject({ currentTime: 40, timeListened: 4 });
  });

  it("converts a 404 close to a queued progress PATCH when the item is known", async () => {
    mockedPost.mockRejectedValue(err404());
    mockedPatch.mockRejectedValue(errNetwork());
    await closeSession({
      sessionId: "s2",
      currentTime: 200,
      timeListened: 20,
      duration: 400,
      libraryItemId: "li2",
    });
    expect(pendingKeys()).toHaveLength(0);
    expect(readJson("pendingPatch_li2")).toEqual({
      libraryItemId: "li2",
      body: { currentTime: 200, duration: 400, progress: 0.5 },
    });
  });

  it("routes local_ sessions to a direct progress PATCH", async () => {
    mockedPatch.mockRejectedValue(errNetwork());
    await closeSession({ sessionId: "local_b1", currentTime: 5, timeListened: 5, duration: 50 });
    expect(mockedPost).not.toHaveBeenCalled();
    expect(readJson("pendingPatch_b1")).toMatchObject({ libraryItemId: "b1" });
  });
});

describe("queueProgressPatch / queueFinishedPatch / queueEbookProgressPatch", () => {
  it("computes progress from currentTime/duration and clamps to 1", () => {
    queueProgressPatch("li1", 50, 100);
    expect(readJson("pendingPatch_li1").body).toEqual({
      currentTime: 50,
      duration: 100,
      progress: 0.5,
    });
    queueProgressPatch("li1", 500, 100);
    expect(readJson("pendingPatch_li1").body.progress).toBe(1);
  });

  it("omits duration/progress when duration is 0 or negative (keeps position)", () => {
    // Writing progress:0 for an unknown duration could REGRESS real server
    // progress — the sanitized queue keeps only the trustworthy field.
    queueProgressPatch("li1", 50, 0);
    expect(readJson("pendingPatch_li1").body.currentTime).toBe(50);
    expect(readJson("pendingPatch_li1").body.progress).toBeUndefined();
    expect(readJson("pendingPatch_li1").body.duration).toBeUndefined();
    queueProgressPatch("li2", 50, -10);
    expect(readJson("pendingPatch_li2").body.currentTime).toBe(50);
    expect(readJson("pendingPatch_li2").body.progress).toBeUndefined();
  });

  it("is a no-op with an empty libraryItemId", () => {
    queueProgressPatch("", 50, 100);
    expect(patchKeys()).toHaveLength(0);
  });

  it("merges extra fields into the body", () => {
    queueProgressPatch("li1", 50, 100, null, { isFinished: true });
    expect(readJson("pendingPatch_li1").body).toEqual({
      currentTime: 50,
      duration: 100,
      progress: 0.5,
      isFinished: true,
    });
  });

  it("ebook patches NEVER include audio progress/currentTime fields", () => {
    queueEbookProgressPatch("li1", "epubcfi(/6/4!/2)", 0.42);
    const body = readJson("pendingPatch_li1").body;
    expect(body).toEqual({ ebookLocation: "epubcfi(/6/4!/2)", ebookProgress: 0.42 });
    expect(body).not.toHaveProperty("progress");
    expect(body).not.toHaveProperty("currentTime");
  });

  it("ebook patch adds a one-way isFinished:true only when finished", () => {
    queueEbookProgressPatch("li1", "cfi", 1, true);
    expect(readJson("pendingPatch_li1").body).toEqual({
      ebookLocation: "cfi",
      ebookProgress: 1,
      isFinished: true,
    });
    // finished=false must not write isFinished:false (one-way flag)
    queueEbookProgressPatch("li2", "cfi", 0.5, false);
    expect(readJson("pendingPatch_li2").body).not.toHaveProperty("isFinished");
  });

  it("queueFinishedPatch queues a bare isFinished toggle (both directions)", () => {
    queueFinishedPatch("li1", true);
    expect(readJson("pendingPatch_li1").body).toEqual({ isFinished: true });
    queueFinishedPatch("li1", false);
    expect(readJson("pendingPatch_li1").body).toEqual({ isFinished: false });
  });

  it("merges audio and ebook writers into ONE body (latest per field wins)", () => {
    queueProgressPatch("li1", 100, 200);
    queueEbookProgressPatch("li1", "cfiA", 0.3);
    queueProgressPatch("li1", 150, 200); // newer audio position
    const body = readJson("pendingPatch_li1").body;
    expect(body).toEqual({
      currentTime: 150,
      duration: 200,
      progress: 0.75,
      ebookLocation: "cfiA",
      ebookProgress: 0.3,
    });
  });

  it("merges on top of a legacy top-level-field entry", () => {
    // Legacy shape: audio fields at the top level + extra
    storage.set(
      "pendingPatch_li1",
      JSON.stringify({
        libraryItemId: "li1",
        currentTime: 10,
        duration: 100,
        progress: 0.1,
        extra: { isFinished: true },
      })
    );
    queueEbookProgressPatch("li1", "cfiB", 0.9);
    expect(readJson("pendingPatch_li1")).toEqual({
      libraryItemId: "li1",
      body: {
        currentTime: 10,
        duration: 100,
        progress: 0.1,
        isFinished: true,
        ebookLocation: "cfiB",
        ebookProgress: 0.9,
      },
    });
  });
});

describe("flushPendingSyncs", () => {
  it("re-POSTs queued syncs and clears them on success", async () => {
    storage.set(
      "pendingSync_s1",
      JSON.stringify({ sessionId: "s1", currentTime: 10, timeListened: 5, duration: 100 })
    );
    await flushPendingSyncs();
    expect(mockedPost).toHaveBeenCalledWith("/api/session/s1/sync", {
      currentTime: 10,
      timeListened: 5,
      duration: 100,
    });
    expect(pendingKeys()).toHaveLength(0);
  });

  it("TOCTOU: seconds merged into an entry DURING the flush POST survive the clear", async () => {
    // Regression for the listening-time-loss race: flush snapshots an entry,
    // POSTs it, and used to blind-clear the key on success — eating any new
    // timeListened a concurrent failed sync merged in while the POST was in
    // flight. The fix subtracts only what was actually delivered.
    storage.set(
      "pendingSync_s1",
      JSON.stringify({ sessionId: "s1", currentTime: 10, timeListened: 7, duration: 100 })
    );
    let releasePost!: () => void;
    const gate = new Promise<void>((resolve) => (releasePost = resolve));
    mockedPost.mockImplementationOnce(() => gate);
    const flushP = flushPendingSyncs();
    // Drain microtasks until the flush has read its snapshot and started the POST.
    for (let i = 0; i < 50 && mockedPost.mock.calls.length === 0; i++) {
      await Promise.resolve();
    }
    expect(mockedPost).toHaveBeenCalledTimes(1);
    // Concurrent failed sync merges 5 new seconds while the POST is in flight.
    storage.set(
      "pendingSync_s1",
      JSON.stringify({ sessionId: "s1", currentTime: 20, timeListened: 12, duration: 100 })
    );
    releasePost();
    await flushP;
    // 7 delivered, 5 must remain queued (with the newer position).
    expect(readJson("pendingSync_s1")).toMatchObject({ timeListened: 5, currentTime: 20 });
  });

  it("TOCTOU: a FRESHER position (at-stamp) with NO new seconds merged during the POST is not cleared", async () => {
    // closeSession after a seek passes timeListened 0 but a newer `at` — the
    // guard used to key only on timeListened growth, so the final position was
    // blind-cleared with the delivered entry.
    storage.set(
      "pendingSync_s1",
      JSON.stringify({ sessionId: "s1", currentTime: 10, timeListened: 7, duration: 100, at: 1000 })
    );
    mockedPost.mockImplementationOnce(async () => {
      // While the POST is in flight, a failed close merges a FRESHER position
      // with the SAME accumulated timeListened (no new seconds).
      storage.set(
        "pendingSync_s1",
        JSON.stringify({ sessionId: "s1", currentTime: 55, timeListened: 7, duration: 100, at: 2000 })
      );
      return { data: {} } as any;
    });
    await flushPendingSyncs();
    expect(mockedPost).toHaveBeenCalledWith("/api/session/s1/sync", {
      currentTime: 10,
      timeListened: 7,
      duration: 100,
    });
    // The fresher position stays queued; delivered seconds are subtracted and
    // clamped to >= 0.
    expect(readJson("pendingSync_s1")).toMatchObject({
      currentTime: 55,
      timeListened: 0,
      at: 2000,
    });

    // The next flush delivers the final position and clears the entry.
    await flushPendingSyncs();
    expect(mockedPost).toHaveBeenLastCalledWith("/api/session/s1/sync", {
      currentTime: 55,
      timeListened: 0,
      duration: 100,
    });
    expect(pendingKeys()).toHaveLength(0);
  });

  it("keeps queued syncs on non-404 failure", async () => {
    storage.set(
      "pendingSync_s1",
      JSON.stringify({ sessionId: "s1", currentTime: 10, timeListened: 5, duration: 100 })
    );
    mockedPost.mockRejectedValue(errNetwork());
    await flushPendingSyncs();
    expect(readJson("pendingSync_s1")).toMatchObject({ timeListened: 5 });
  });

  it("converts a 404 sync into a progress PATCH when the item id is known", async () => {
    storage.set(
      "pendingSync_s1",
      JSON.stringify({
        sessionId: "s1",
        currentTime: 25,
        timeListened: 5,
        duration: 100,
        libraryItemId: "li1",
      })
    );
    mockedPost.mockRejectedValue(err404());
    mockedPatch.mockRejectedValue(errNetwork()); // patch flush already ran; keep queued
    await flushPendingSyncs();
    expect(pendingKeys()).toHaveLength(0); // stop retrying forever
    expect(readJson("pendingPatch_li1")).toEqual({
      libraryItemId: "li1",
      body: { currentTime: 25, duration: 100, progress: 0.25 },
    });
  });

  // QA#3: the WEAK merge that converts a dead-session (404) sync into a PATCH
  // must only FILL fields — it must never clobber a newer position already
  // queued for the same item.
  it("a 404 dead-session sync does NOT regress a newer position already queued for the item", async () => {
    // A fresher position is already queued for li1...
    queueProgressPatch("li1", 200, 3600);
    // ...then a STALE session sync for the same item 404s carrying an OLDER
    // position 50 (it queued before the session died).
    storage.set(
      "pendingSync_s1",
      JSON.stringify({
        sessionId: "s1",
        currentTime: 50,
        timeListened: 5,
        duration: 3600,
        libraryItemId: "li1",
      })
    );
    mockedPost.mockRejectedValue(err404());
    mockedPatch.mockRejectedValue(errNetwork()); // keep the patch queued for inspection
    await flushPendingSyncs();
    // The weak merge fills only missing fields — the newer 200 survives.
    expect(readJson("pendingPatch_li1").body.currentTime).toBe(200);
    expect(pendingKeys()).toHaveLength(0); // stale session dropped
  });

  it("drops a 404 sync with no item id without queuing anything", async () => {
    storage.set(
      "pendingSync_s1",
      JSON.stringify({ sessionId: "s1", currentTime: 25, timeListened: 5, duration: 100 })
    );
    mockedPost.mockRejectedValue(err404());
    await flushPendingSyncs();
    expect(pendingKeys()).toHaveLength(0);
    expect(patchKeys()).toHaveLength(0);
  });

  it("removes corrupt pending entries", async () => {
    storage.set("pendingSync_bad", "{not json");
    await flushPendingSyncs();
    expect(pendingKeys()).toHaveLength(0);
    expect(mockedPost).not.toHaveBeenCalled();
  });

  // REGRESSION: a straggler queued under account A must never sync/PATCH under
  // account B's token on a shared server (colliding item ids → cross-account
  // progress corruption). The entry is stamped with A's identity at enqueue
  // and skipped (left in place) while a different account is current.
  it("skips a pending sync stamped for a different account, then delivers it when that account is current again", async () => {
    storageHelper.setServerConfig({ address: "http://abs.local", token: "tokA", userId: "uA" });
    mockedPost.mockRejectedValue(errNetwork());
    await syncProgress({ sessionId: "s1", currentTime: 50, timeListened: 5, duration: 3600 });
    expect(readJson("pendingSync_s1").sid).toBe("http://abs.local::uA");

    // Switch to account B (same server) and flush — A's entry must not POST.
    storageHelper.setServerConfig({ address: "http://abs.local", token: "tokB", userId: "uB" });
    mockedPost.mockReset();
    mockedPost.mockResolvedValue({ data: {} } as any);
    await flushPendingSyncs();
    expect(mockedPost).not.toHaveBeenCalled();
    expect(readJson("pendingSync_s1")).not.toBeNull(); // left in place, not dropped

    // Switch back to A — now it delivers (guard isn't a blanket skip).
    storageHelper.setServerConfig({ address: "http://abs.local", token: "tokA2", userId: "uA" });
    await flushPendingSyncs();
    expect(mockedPost).toHaveBeenCalledWith("/api/session/s1/sync", expect.objectContaining({ currentTime: 50 }));
    expect(readJson("pendingSync_s1")).toBeNull();
  });

  it("skips a pending PATCH stamped for a different account", async () => {
    storageHelper.setServerConfig({ address: "http://abs.local", token: "tokA", userId: "uA" });
    queueProgressPatch("li1", 30, 100);
    expect(readJson("pendingPatch_li1").sid).toBe("http://abs.local::uA");

    storageHelper.setServerConfig({ address: "http://abs.local", token: "tokB", userId: "uB" });
    mockedPatch.mockReset();
    mockedPatch.mockResolvedValue({ data: {} } as any);
    await flushPendingSyncs();
    expect(mockedPatch).not.toHaveBeenCalled();
    expect(readJson("pendingPatch_li1")).not.toBeNull();
  });

  it("flushes queued PATCHes (new body shape) before syncs and clears on success", async () => {
    queueProgressPatch("li1", 10, 100);
    storage.set(
      "pendingSync_s1",
      JSON.stringify({ sessionId: "s1", currentTime: 1, timeListened: 1, duration: 10 })
    );
    const order: string[] = [];
    mockedPatch.mockImplementation(async (url: any) => {
      order.push(`patch:${url}`);
      return { data: {} } as any;
    });
    mockedPost.mockImplementation(async (url: any) => {
      order.push(`post:${url}`);
      return { data: {} } as any;
    });
    await flushPendingSyncs();
    expect(order).toEqual(["patch:/api/me/progress/li1", "post:/api/session/s1/sync"]);
    expect(patchKeys()).toHaveLength(0);
  });

  it("flushes legacy top-level-field PATCH entries", async () => {
    storage.set(
      "pendingPatch_li9",
      JSON.stringify({
        libraryItemId: "li9",
        currentTime: 33,
        duration: 66,
        progress: 0.5,
        extra: { isFinished: true },
      })
    );
    await flushPendingSyncs();
    expect(mockedPatch).toHaveBeenCalledWith("/api/me/progress/li9", {
      currentTime: 33,
      duration: 66,
      progress: 0.5,
      isFinished: true,
    });
    expect(patchKeys()).toHaveLength(0);
  });

  it("keeps queued PATCHes on failure", async () => {
    queueProgressPatch("li1", 10, 100);
    mockedPatch.mockRejectedValue(errNetwork());
    await flushPendingSyncs();
    expect(patchKeys()).toEqual(["pendingPatch_li1"]);
  });

  it("MUTEX: concurrent callers share one in-flight run (no double-POST)", async () => {
    storage.set(
      "pendingSync_s1",
      JSON.stringify({ sessionId: "s1", currentTime: 10, timeListened: 5, duration: 100 })
    );
    let release: (() => void) | undefined;
    mockedPost.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ data: {} } as any);
        }) as any
    );

    const p1 = flushPendingSyncs();
    const p2 = flushPendingSyncs();
    expect(p2).toBe(p1); // same in-flight promise

    // Let the (async) flush advance to the blocked POST before releasing it.
    for (let i = 0; i < 50 && !release; i++) await Promise.resolve();
    expect(release).toBeDefined();
    release!();
    await Promise.all([p1, p2]);
    expect(mockedPost).toHaveBeenCalledTimes(1);
    expect(pendingKeys()).toHaveLength(0);

    // After settling, a new flush starts a fresh run.
    mockedPost.mockResolvedValue({ data: {} } as any);
    const p3 = flushPendingSyncs();
    expect(p3).not.toBe(p1);
    await p3;
  });
});

describe("flushPendingSyncs — storage failure", () => {
  it("logs and recovers when the flush itself throws, releasing the mutex", async () => {
    jest.spyOn(storage, "getAllKeys").mockImplementationOnce(() => {
      throw new Error("mmkv broken");
    });
    await expect(flushPendingSyncs()).resolves.toBeUndefined();

    // The mutex was released — a later flush runs normally.
    storage.set(
      "pendingSync_s1",
      JSON.stringify({ sessionId: "s1", currentTime: 1, timeListened: 1, duration: 10 })
    );
    await flushPendingSyncs();
    expect(pendingKeys()).toHaveLength(0);
  });
});

describe("clearAllPending", () => {
  it("wipes queued syncs and patches but nothing else", () => {
    storage.set("pendingSync_s1", JSON.stringify({ sessionId: "s1" }));
    queueProgressPatch("li1", 1, 10);
    storage.set("unrelatedKey", "keep-me");

    clearAllPending();

    expect(pendingKeys()).toHaveLength(0);
    expect(patchKeys()).toHaveLength(0);
    expect(storage.getString("unrelatedKey")).toBe("keep-me");
  });

  it("wipes queued bookmark deletions on logout", () => {
    queueBookmarkDeletion("li1", 42);
    queueBookmarkDeletion("li2", 7);
    expect(bookmarkDeleteKeys()).toHaveLength(2);

    clearAllPending();

    expect(bookmarkDeleteKeys()).toHaveLength(0);
    expect(pendingBookmarkDeletionsFor("li1")).toEqual([]);
  });
});

describe("remapPendingSids (in-place server-address change)", () => {
  const OLD = "https://old.example.com::u1";
  const NEW = "https://new.example.com::u1";

  it("re-keys sids on pending syncs, patches, and local-session records old→new", () => {
    storage.set("pendingSync_s1", JSON.stringify({ sessionId: "s1", currentTime: 10, sid: OLD }));
    storage.set(
      "pendingPatch_li1",
      JSON.stringify({ libraryItemId: "li1", body: { currentTime: 5 }, sid: OLD })
    );
    storage.set(
      "pendingLocalSession_local_li1_2026-07-08",
      JSON.stringify({ id: "local_li1_2026-07-08", libraryItemId: "li1", timeListening: 30, sid: OLD })
    );

    remapPendingSids(OLD, NEW);

    expect(JSON.parse(storage.getString("pendingSync_s1")!).sid).toBe(NEW);
    expect(JSON.parse(storage.getString("pendingPatch_li1")!).sid).toBe(NEW);
    expect(
      JSON.parse(storage.getString("pendingLocalSession_local_li1_2026-07-08")!).sid
    ).toBe(NEW);
  });

  it("leaves entries stamped with a DIFFERENT sid untouched", () => {
    storage.set("pendingSync_s1", JSON.stringify({ sessionId: "s1", currentTime: 10, sid: OLD }));
    storage.set(
      "pendingSync_s2",
      JSON.stringify({ sessionId: "s2", currentTime: 20, sid: "https://other::u2" })
    );

    remapPendingSids(OLD, NEW);

    expect(JSON.parse(storage.getString("pendingSync_s1")!).sid).toBe(NEW);
    // Another account's straggler keeps its own sid (never adopted here).
    expect(JSON.parse(storage.getString("pendingSync_s2")!).sid).toBe("https://other::u2");
  });

  it("is a no-op when oldSid === newSid", () => {
    storage.set("pendingSync_s1", JSON.stringify({ sessionId: "s1", currentTime: 10, sid: OLD }));
    remapPendingSids(OLD, OLD);
    expect(JSON.parse(storage.getString("pendingSync_s1")!).sid).toBe(OLD);
  });
});

describe("flushPendingSyncs — patch TOCTOU guard", () => {
  it("keeps an entry that was merged into WHILE its PATCH was in flight (removes only byte-identical entries)", async () => {
    // Regression for the one-shot-field-loss race: flush snapshots a queued
    // PATCH, sends it, and used to blind-remove the key on success — deleting
    // any fields merged into the SAME key during the await (e.g. the finish
    // toggle, which never re-queues).
    queueProgressPatch("li1", 10, 100);
    let releasePatch!: () => void;
    const gate = new Promise<void>((resolve) => (releasePatch = resolve));
    mockedPatch.mockImplementationOnce(() => gate as any);

    const flushP = flushPendingSyncs();
    // Drain microtasks until the flush has read its snapshot and started the PATCH.
    for (let i = 0; i < 50 && mockedPatch.mock.calls.length === 0; i++) {
      await Promise.resolve();
    }
    expect(mockedPatch).toHaveBeenCalledTimes(1);
    expect(mockedPatch).toHaveBeenCalledWith("/api/me/progress/li1", {
      currentTime: 10,
      duration: 100,
      progress: 0.1,
    });

    // New progress merges into the same key while the PATCH is in flight.
    queueProgressPatch("li1", 25, 100);
    releasePatch();
    await flushP;

    // The merged entry survives the successful PATCH (kept for the next pass).
    expect(readJson("pendingPatch_li1")).toEqual({
      libraryItemId: "li1",
      body: { currentTime: 25, duration: 100, progress: 0.25 },
    });

    // The next flush delivers the merged entry and clears it.
    await flushPendingSyncs();
    expect(mockedPatch).toHaveBeenLastCalledWith("/api/me/progress/li1", {
      currentTime: 25,
      duration: 100,
      progress: 0.25,
    });
    expect(patchKeys()).toHaveLength(0);
  });

  it("removes an untouched entry after a successful PATCH (guard does not over-keep)", async () => {
    queueProgressPatch("li1", 10, 100);
    await flushPendingSyncs();
    expect(mockedPatch).toHaveBeenCalledTimes(1);
    expect(patchKeys()).toHaveLength(0);
  });
});

describe("bookmark deletion queue", () => {
  it("queueBookmarkDeletion floors the time; pendingBookmarkDeletionsFor returns only that item's times", () => {
    queueBookmarkDeletion("li1", 12.9);
    queueBookmarkDeletion("li1", 30);
    queueBookmarkDeletion("li2", 5);
    expect(pendingBookmarkDeletionsFor("li1").sort((a, b) => a - b)).toEqual([12, 30]);
    expect(pendingBookmarkDeletionsFor("li2")).toEqual([5]);
    expect(pendingBookmarkDeletionsFor("other")).toEqual([]);
  });

  it("replays a fractional-time deletion with the RAW time (server keys bookmarks exactly)", async () => {
    queueBookmarkDeletion("li1", 90.7);
    // UI filter compares floored values...
    expect(pendingBookmarkDeletionsFor("li1")).toEqual([90]);
    // ...but the replayed DELETE must hit the server's exact time.
    await flushPendingSyncs();
    expect(mockedDelete).toHaveBeenCalledWith("/api/me/item/li1/bookmark/90.7");
    expect(bookmarkDeleteKeys()).toHaveLength(0);
  });

  it("ignores invalid deletions (empty id, negative or non-finite time)", () => {
    queueBookmarkDeletion("", 5);
    queueBookmarkDeletion("li1", -1);
    queueBookmarkDeletion("li1", NaN);
    queueBookmarkDeletion("li1", Infinity);
    expect(bookmarkDeleteKeys()).toHaveLength(0);
  });

  it("flushPendingSyncs DELETEs each queued deletion and clears the queue on success", async () => {
    queueBookmarkDeletion("li1", 12.9);
    queueBookmarkDeletion("li1", 30);
    await flushPendingSyncs();
    expect(mockedDelete).toHaveBeenCalledTimes(2);
    // Raw time in the replay — the server keys bookmarks by exact time.
    expect(mockedDelete).toHaveBeenCalledWith("/api/me/item/li1/bookmark/12.9");
    expect(mockedDelete).toHaveBeenCalledWith("/api/me/item/li1/bookmark/30");
    expect(bookmarkDeleteKeys()).toHaveLength(0);
    expect(pendingBookmarkDeletionsFor("li1")).toEqual([]);
  });

  it("drops the queue entry on 404 (bookmark already gone server-side)", async () => {
    queueBookmarkDeletion("li1", 42);
    mockedDelete.mockRejectedValue(err404());
    await flushPendingSyncs();
    expect(bookmarkDeleteKeys()).toHaveLength(0);
  });

  it("keeps the queue entry on network failure and delivers it on the next flush", async () => {
    queueBookmarkDeletion("li1", 42);
    mockedDelete.mockRejectedValue(errNetwork());
    await flushPendingSyncs();
    expect(pendingBookmarkDeletionsFor("li1")).toEqual([42]);

    // Connectivity returns — the queued deletion lands and clears.
    mockedDelete.mockResolvedValue({ data: {} } as any);
    await flushPendingSyncs();
    expect(mockedDelete).toHaveBeenLastCalledWith("/api/me/item/li1/bookmark/42");
    expect(bookmarkDeleteKeys()).toHaveLength(0);
  });

  it("drops corrupt deletion entries without calling the API", async () => {
    storage.set("pendingBookmarkDelete_bad", "{not json");
    await flushPendingSyncs();
    expect(mockedDelete).not.toHaveBeenCalled();
    expect(bookmarkDeleteKeys()).toHaveLength(0);
  });

  it("flushes deletions BEFORE creations so a re-added bookmark at the same time survives", async () => {
    // Offline: delete the synced bookmark at 42s, then bookmark the same spot
    // again. Creations-first would POST the new bookmark and immediately
    // DELETE it server-side — the user's last action loses.
    queueBookmarkDeletion("li1", 42);
    queueBookmark("li1", 42, "re-added");

    await flushPendingSyncs();

    expect(mockedDelete).toHaveBeenCalledWith("/api/me/item/li1/bookmark/42");
    expect(mockedPost).toHaveBeenCalledWith("/api/me/item/li1/bookmark", {
      title: "re-added",
      time: 42,
    });
    // The DELETE must land strictly before the POST create.
    expect(mockedDelete.mock.invocationCallOrder[0]).toBeLessThan(
      mockedPost.mock.invocationCallOrder[0]
    );
    // Both queues drained.
    expect(bookmarkDeleteKeys()).toHaveLength(0);
    expect(bookmarkKeys()).toHaveLength(0);
  });
});

describe("bookmark rename queue", () => {
  it("queueBookmarkRename keys floored but stores the RAW time + title; pendingBookmarkRenamesFor scopes by item", () => {
    queueBookmarkRename("li1", 90.7, "Best quote");
    queueBookmarkRename("li2", 30, "Chapter");
    // Key floored (dedupe per second)...
    expect(bookmarkRenameKeys()).toContain("pendingBookmarkRename_li1_90");
    // ...but the stored time is exact (the PATCH matches the server bookmark by time).
    expect(pendingBookmarkRenamesFor("li1")).toEqual([{ libraryItemId: "li1", time: 90.7, title: "Best quote" }]);
    expect(pendingBookmarkRenamesFor("li2")).toEqual([{ libraryItemId: "li2", time: 30, title: "Chapter" }]);
    expect(pendingBookmarkRenamesFor("other")).toEqual([]);
  });

  it("pendingBookmarkRenamesFor drops corrupt blobs (missing/invalid time or title)", () => {
    queueBookmarkRename("li1", 42, "good");
    // Hand-write malformed entries under the rename prefix (a truncated/corrupt
    // MMKV blob) — these must not reach the UI merge.
    storage.set("pendingBookmarkRename_li1_10", JSON.stringify({ libraryItemId: "li1", time: 10 })); // no title
    storage.set("pendingBookmarkRename_li1_20", JSON.stringify({ libraryItemId: "li1", title: "x" })); // no time
    storage.set("pendingBookmarkRename_li1_30", JSON.stringify({ libraryItemId: "li1", time: "nope", title: "x" }));
    expect(pendingBookmarkRenamesFor("li1")).toEqual([
      { libraryItemId: "li1", time: 42, title: "good" },
    ]);
  });

  it("ignores invalid renames (empty id, negative or non-finite time)", () => {
    queueBookmarkRename("", 5, "x");
    queueBookmarkRename("li1", -1, "x");
    queueBookmarkRename("li1", NaN, "x");
    queueBookmarkRename("li1", Infinity, "x");
    expect(bookmarkRenameKeys()).toHaveLength(0);
  });

  it("does NOT match the create-only prefix (pendingBookmark_)", () => {
    queueBookmarkRename("li1", 42, "renamed");
    // The rename key must not be swept up by the create queue's prefix filter.
    expect(bookmarkKeys()).toHaveLength(0);
    expect(bookmarkRenameKeys()).toHaveLength(1);
  });

  it("flushPendingSyncs PATCHes each queued rename with { time, title } and clears on success", async () => {
    queueBookmarkRename("li1", 90.7, "Best quote");
    queueBookmarkRename("li1", 30, "Intro");
    await flushPendingSyncs();
    expect(mockedPatch).toHaveBeenCalledWith("/api/me/item/li1/bookmark", {
      time: 90.7,
      title: "Best quote",
    });
    expect(mockedPatch).toHaveBeenCalledWith("/api/me/item/li1/bookmark", {
      time: 30,
      title: "Intro",
    });
    expect(bookmarkRenameKeys()).toHaveLength(0);
    expect(pendingBookmarkRenamesFor("li1")).toEqual([]);
  });

  it("keeps the entry on network failure and delivers it on the next flush", async () => {
    queueBookmarkRename("li1", 42, "renamed");
    mockedPatch.mockRejectedValue(errNetwork());
    await flushPendingSyncs();
    expect(pendingBookmarkRenamesFor("li1")).toEqual([{ libraryItemId: "li1", time: 42, title: "renamed" }]);

    mockedPatch.mockResolvedValue({ data: {} } as any);
    await flushPendingSyncs();
    expect(mockedPatch).toHaveBeenLastCalledWith("/api/me/item/li1/bookmark", { time: 42, title: "renamed" });
    expect(bookmarkRenameKeys()).toHaveLength(0);
  });

  it("drops the entry on 404 (bookmark/item gone server-side)", async () => {
    queueBookmarkRename("li1", 42, "renamed");
    mockedPatch.mockRejectedValue(err404());
    await flushPendingSyncs();
    expect(bookmarkRenameKeys()).toHaveLength(0);
  });

  it("drops corrupt rename entries without calling the API", async () => {
    storage.set("pendingBookmarkRename_bad", "{not json");
    await flushPendingSyncs();
    expect(mockedPatch).not.toHaveBeenCalled();
    expect(bookmarkRenameKeys()).toHaveLength(0);
  });

  it("flushes a create BEFORE its rename so the PATCH's time-match finds a server bookmark", async () => {
    // Bookmark a spot offline, then rename it offline. The create must POST
    // first, otherwise the rename PATCH would target a bookmark that doesn't
    // exist server-side yet.
    queueBookmark("li1", 42, "original");
    queueBookmarkRename("li1", 42, "renamed");

    await flushPendingSyncs();

    expect(mockedPost).toHaveBeenCalledWith("/api/me/item/li1/bookmark", { title: "original", time: 42 });
    expect(mockedPatch).toHaveBeenCalledWith("/api/me/item/li1/bookmark", { time: 42, title: "renamed" });
    // The create POST lands strictly before the rename PATCH.
    expect(mockedPost.mock.invocationCallOrder[0]).toBeLessThan(
      mockedPatch.mock.invocationCallOrder[0]
    );
    expect(bookmarkKeys()).toHaveLength(0);
    expect(bookmarkRenameKeys()).toHaveLength(0);
  });

  it("clearAllPending wipes queued bookmark renames on logout", () => {
    queueBookmarkRename("li1", 42, "renamed");
    queueBookmarkRename("li2", 7, "x");
    expect(bookmarkRenameKeys()).toHaveLength(2);

    clearAllPending();

    expect(bookmarkRenameKeys()).toHaveLength(0);
    expect(pendingBookmarkRenamesFor("li1")).toEqual([]);
  });
});

describe("monotonic at stamps", () => {
  it("queued at stamps strictly increase even when Date.now() goes BACKWARD", async () => {
    // Clock adjustment mid-playback: Date.now() returns a decreasing
    // sequence. The queue's freshest-wins merge keys on `at`, so stamps must
    // still strictly increase or a stale position could beat a newer close.
    mockedPost.mockRejectedValue(errNetwork());
    let t = 10_000_000;
    const nowSpy = jest.spyOn(Date, "now").mockImplementation(() => (t -= 1000));
    try {
      await syncProgress({ sessionId: "sa", currentTime: 1, timeListened: 1, duration: 10 });
      await syncProgress({ sessionId: "sb", currentTime: 2, timeListened: 1, duration: 10 });
    } finally {
      nowSpy.mockRestore();
    }
    const atA = readJson("pendingSync_sa").at;
    const atB = readJson("pendingSync_sb").at;
    expect(typeof atA).toBe("number");
    expect(atB).toBeGreaterThan(atA);
  });
});

describe("hasAnyPendingSyncs", () => {
  it("is false when nothing is queued", () => {
    expect(hasAnyPendingSyncs()).toBe(false);
  });

  it("is true when a pending session sync carries listened seconds", () => {
    storage.set("pendingSync_s1", JSON.stringify({ sessionId: "s1", timeListened: 4 }));
    expect(hasAnyPendingSyncs()).toBe(true);
  });

  it("ignores position-only session remainders (timeListened 0 after a flush)", () => {
    storage.set("pendingSync_s1", JSON.stringify({ sessionId: "s1", currentTime: 500, timeListened: 0 }));
    expect(hasAnyPendingSyncs()).toBe(false);
  });

  it("ignores pending progress PATCHes (position/finished only — no listening seconds)", () => {
    queueProgressPatch("li1", 1, 10);
    expect(hasAnyPendingSyncs()).toBe(false);
  });

  it("ignores bookmark queues (bookmarks are not listening progress)", () => {
    storage.set("pendingBookmark_li1_5", JSON.stringify({ libraryItemId: "li1", time: 5 }));
    queueBookmarkDeletion("li1", 9);
    expect(hasAnyPendingSyncs()).toBe(false);
  });

  it("returns false instead of throwing when storage fails", () => {
    jest.spyOn(storage, "getAllKeys").mockImplementationOnce(() => {
      throw new Error("mmkv broken");
    });
    expect(hasAnyPendingSyncs()).toBe(false);
  });
});

describe("offline local-session listening bank", () => {
  // Fixed local-time instant: 2026-01-15 (a Thursday) at noon, so the
  // per-day record key is deterministic regardless of the host timezone.
  const T = new Date(2026, 0, 15, 12, 0, 0).getTime();
  const DAY_KEY = "pendingLocalSession_local_li1_2026-01-15";

  // clearMocks would strip a spy's implementation but NOT restore the
  // original, leaving Date.now() returning undefined for later tests —
  // always restore explicitly.
  const withFixedNow = async (fn: () => Promise<void> | void) => {
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(T);
    try {
      await fn();
    } finally {
      nowSpy.mockRestore();
    }
  };

  it("recordLocalListening accumulates seconds into ONE per-item+day record; currentTime tracks the latest call", async () => {
    await withFixedNow(() => {
      recordLocalListening("li1", undefined, 100, 3600, 30);
      recordLocalListening("li1", undefined, 130, 3600, 30);
    });
    expect(localSessionKeys()).toEqual([DAY_KEY]);
    expect(readJson(DAY_KEY)).toMatchObject({
      id: "local_li1_2026-01-15",
      libraryItemId: "li1",
      date: "2026-01-15",
      dayOfWeek: "Thursday",
      timeListening: 60, // 30 + 30 accumulates
      syncedTimeListening: 0,
      currentTime: 130, // latest call wins
      duration: 3600,
      displayTitle: "Book One", // from the (mocked) download store
      displayAuthor: "Author A",
    });
  });

  it("records nothing for zero or negative timeListened", () => {
    recordLocalListening("li1", undefined, 100, 3600, 0);
    recordLocalListening("li1", undefined, 100, 3600, -5);
    expect(localSessionKeys()).toHaveLength(0);
  });

  it("syncProgress on a local_ session banks the seconds AND queues the progress patch when offline", async () => {
    mockedPost.mockRejectedValue(errNetwork());
    mockedPatch.mockRejectedValue(errNetwork());
    await withFixedNow(async () => {
      await syncProgress({
        sessionId: "local_li1",
        currentTime: 100,
        timeListened: 30,
        duration: 3600,
        libraryItemId: "li1",
      });
      // Join the fire-and-forget flush syncProgress kicked off (everything
      // rejects, so both records survive it).
      await flushPendingSyncs();
    });
    expect(readJson(DAY_KEY)).toMatchObject({ libraryItemId: "li1", timeListening: 30 });
    expect(readJson("pendingPatch_li1")).toMatchObject({
      libraryItemId: "li1",
      body: { currentTime: 100, duration: 3600 },
    });
  });

  it("flush POSTs the cumulative day total to /api/session/local and KEEPS today's record marked delivered", async () => {
    await withFixedNow(async () => {
      recordLocalListening("li1", undefined, 100, 3600, 30);
      recordLocalListening("li1", undefined, 130, 3600, 30);
      await flushPendingSyncs();
    });
    expect(mockedPost).toHaveBeenCalledTimes(1);
    expect(mockedPost).toHaveBeenCalledWith(
      "/api/session/local",
      expect.objectContaining({
        id: "local_li1_2026-01-15",
        libraryItemId: "li1",
        episodeId: null,
        playMethod: 3, // LOCAL
        date: "2026-01-15",
        dayOfWeek: "Thursday",
        timeListening: 60,
        currentTime: 130,
        displayTitle: "Book One",
        displayAuthor: "Author A",
      })
    );
    // Today's record REMAINS (further listening accumulates into the same
    // server session), with exactly what was sent marked as delivered.
    expect(readJson(DAY_KEY)).toMatchObject({
      timeListening: 60,
      syncedTimeListening: 60,
    });
    // A book session (no episodeId) is labeled as such.
    expect(mockedPost).toHaveBeenCalledWith(
      "/api/session/local",
      expect.objectContaining({ mediaType: "book" })
    );
  });

  it("labels episode sessions as podcasts", async () => {
    await withFixedNow(async () => {
      recordLocalListening("li1", "ep1", 100, 3600, 30);
      await flushPendingSyncs();
    });
    expect(mockedPost).toHaveBeenCalledWith(
      "/api/session/local",
      expect.objectContaining({
        id: "local_li1-ep1_2026-01-15",
        episodeId: "ep1",
        mediaType: "podcast",
      })
    );
  });

  // REGRESSION (SE#2): an offline downloaded EPISODE session used to POST a
  // blank displayTitle because it looked up completedDownloads by the bare
  // libraryItemId — but episodes are keyed by the composite `${id}::${episodeId}`.
  // The lookup now uses episodeDownloadKey so the real title/author land.
  it("SE#2: an offline episode session resolves its display fields via the COMPOSITE download key", async () => {
    await withFixedNow(async () => {
      recordLocalListening("pod1", "ep1", 10, 100, 30);
      await flushPendingSyncs();
    });
    expect(mockedPost).toHaveBeenCalledWith(
      "/api/session/local",
      expect.objectContaining({
        id: "local_pod1-ep1_2026-01-15",
        episodeId: "ep1",
        mediaType: "podcast",
        displayTitle: "Episode One", // NOT "" — resolved via pod1::ep1
        displayAuthor: "Podcaster P",
      })
    );
  });

  it("fully-synced local record is NOT pending; more listening makes it pending again and re-POSTs the GROWN total", async () => {
    await withFixedNow(async () => {
      recordLocalListening("li1", undefined, 100, 3600, 30);
      await flushPendingSyncs();
      expect(mockedPost).toHaveBeenLastCalledWith(
        "/api/session/local",
        expect.objectContaining({ timeListening: 30 })
      );
      // Delivered in full — the surviving record must not count as pending.
      expect(hasAnyPendingSyncs()).toBe(false);

      recordLocalListening("li1", undefined, 145, 3600, 15);
      expect(hasAnyPendingSyncs()).toBe(true);

      await flushPendingSyncs();
      // ABS upserts by session id REPLACING timeListening — the grown
      // cumulative total is re-sent, not the delta.
      expect(mockedPost).toHaveBeenLastCalledWith(
        "/api/session/local",
        expect.objectContaining({ id: "local_li1_2026-01-15", timeListening: 45 })
      );
      expect(readJson(DAY_KEY)).toMatchObject({ timeListening: 45, syncedTimeListening: 45 });
      expect(hasAnyPendingSyncs()).toBe(false);
    });
  });

  it("a 4xx rejection drops the record (retry can never succeed)", async () => {
    await withFixedNow(() => {
      recordLocalListening("li1", undefined, 100, 3600, 30);
    });
    mockedPost.mockRejectedValue(err404());
    await flushPendingSyncs();
    expect(localSessionKeys()).toHaveLength(0);
  });

  it("transient statuses keep the record queued (401/403 token rotation, 429/408 proxies, 5xx)", async () => {
    await withFixedNow(() => {
      recordLocalListening("li1", undefined, 100, 3600, 30);
    });
    for (const status of [401, 403, 408, 429, 500, 503]) {
      mockedPost.mockRejectedValue({ response: { status } });
      await flushPendingSyncs();
      expect(readJson(DAY_KEY)).toMatchObject({ timeListening: 30, syncedTimeListening: 0 });
    }
    expect(hasAnyPendingSyncs()).toBe(true);
  });

  it("a network error (no response) keeps the record queued for the next flush", async () => {
    await withFixedNow(() => {
      recordLocalListening("li1", undefined, 100, 3600, 30);
    });
    mockedPost.mockRejectedValue(errNetwork());
    await flushPendingSyncs();
    expect(readJson(DAY_KEY)).toMatchObject({ timeListening: 30, syncedTimeListening: 0 });
    expect(hasAnyPendingSyncs()).toBe(true);

    // Connectivity returns — it lands.
    mockedPost.mockResolvedValue({ data: {} } as any);
    await flushPendingSyncs();
    expect(mockedPost).toHaveBeenLastCalledWith(
      "/api/session/local",
      expect.objectContaining({ id: "local_li1_2026-01-15", timeListening: 30 })
    );
  });

  it("removes a fully-synced record from a PREVIOUS day without re-POSTing it", async () => {
    // Real "today" is not 2026-01-14, so this record is an older day's.
    storage.set(
      "pendingLocalSession_local_li1_2026-01-14",
      JSON.stringify({
        id: "local_li1_2026-01-14",
        libraryItemId: "li1",
        date: "2026-01-14",
        dayOfWeek: "Wednesday",
        timeListening: 30,
        syncedTimeListening: 30,
      })
    );
    await flushPendingSyncs();
    expect(mockedPost).not.toHaveBeenCalled();
    expect(localSessionKeys()).toHaveLength(0);
  });

  it("an OLD-day record with unsynced seconds still POSTs (then is removed once fully delivered)", async () => {
    storage.set(
      "pendingLocalSession_local_li1_2026-01-14",
      JSON.stringify({
        id: "local_li1_2026-01-14",
        libraryItemId: "li1",
        date: "2026-01-14",
        dayOfWeek: "Wednesday",
        timeListening: 30,
        syncedTimeListening: 0,
      })
    );
    await flushPendingSyncs();
    expect(mockedPost).toHaveBeenCalledWith(
      "/api/session/local",
      expect.objectContaining({ id: "local_li1_2026-01-14", timeListening: 30 })
    );
    // Marked delivered on this pass; the NEXT flush removes the stale-day record.
    expect(readJson("pendingLocalSession_local_li1_2026-01-14")).toMatchObject({
      syncedTimeListening: 30,
    });
    await flushPendingSyncs();
    expect(localSessionKeys()).toHaveLength(0);
  });

  it("clearAllPending wipes pendingLocalSession_ records", async () => {
    await withFixedNow(() => {
      recordLocalListening("li1", undefined, 100, 3600, 30);
    });
    expect(localSessionKeys()).toHaveLength(1);
    clearAllPending();
    expect(localSessionKeys()).toHaveLength(0);
  });

  // REGRESSION (A1): local-session records lacked the account/sid scoping every
  // other offline queue enforces. On a shared server a per-item+day record
  // collides across accounts — a straggler could POST A's minutes under B's
  // token. The record is now stamped with the identity at creation and the
  // flush skips (leaves in place) any record for a different current account.
  it("stamps the record with the session identity (sid) and skips it under a different account", async () => {
    storageHelper.setServerConfig({ address: "http://abs.local", token: "tokA", userId: "uA" });
    await withFixedNow(() => {
      recordLocalListening("li1", undefined, 100, 3600, 30);
    });
    expect(readJson(DAY_KEY).sid).toBe("http://abs.local::uA");

    // Switch to account B (same server) — the flush must NOT POST A's minutes.
    storageHelper.setServerConfig({ address: "http://abs.local", token: "tokB", userId: "uB" });
    await flushPendingSyncs();
    expect(mockedPost).not.toHaveBeenCalled();
    expect(readJson(DAY_KEY)).not.toBeNull(); // left in place, not dropped

    // Back to A — now it delivers (the guard isn't a blanket skip).
    storageHelper.setServerConfig({ address: "http://abs.local", token: "tokA2", userId: "uA" });
    await flushPendingSyncs();
    expect(mockedPost).toHaveBeenCalledWith(
      "/api/session/local",
      expect.objectContaining({ id: "local_li1_2026-01-15", timeListening: 30 })
    );
  });

  it("records with no userId (can't discriminate) carry no sid and flush as before", async () => {
    // config in beforeEach has a token but NO userId.
    await withFixedNow(() => {
      recordLocalListening("li1", undefined, 100, 3600, 30);
    });
    expect(readJson(DAY_KEY).sid).toBeUndefined();
    await flushPendingSyncs();
    expect(mockedPost).toHaveBeenCalledWith(
      "/api/session/local",
      expect.objectContaining({ id: "local_li1_2026-01-15" })
    );
  });
});

// REGRESSION (A3): a straggler closeSession/syncProgress that FAILS after an
// account switch must queue under the account that OPENED the session, not
// whichever is current when the failure is finally observed. The sid is now
// captured at the top of closeSession/syncProgress (session still current),
// before any await, and carried into queuePending via the payload.
describe("sid captured at session-open (A3)", () => {
  it("a close failing AFTER an account switch queues under the OPENING account, and the flush skips it under the new one", async () => {
    storageHelper.setServerConfig({ address: "http://abs.local", token: "tokA", userId: "uA" });
    // The close POST rejects — but only after account B has switched in.
    mockedPost.mockImplementationOnce(async () => {
      storageHelper.setServerConfig({ address: "http://abs.local", token: "tokB", userId: "uB" });
      throw errNetwork();
    });
    await closeSession({ sessionId: "s1", currentTime: 300, timeListened: 30, duration: 3600 });

    // Stamped with A (the opener), NOT B (current when the failure landed).
    expect(readJson("pendingSync_s1").sid).toBe("http://abs.local::uA");

    // B is current — the flush leaves A's entry in place (does not POST).
    mockedPost.mockReset();
    mockedPost.mockResolvedValue({ data: {} } as any);
    await flushPendingSyncs();
    expect(mockedPost).not.toHaveBeenCalled();
    expect(readJson("pendingSync_s1")).not.toBeNull();
  });

  it("syncProgress captures the opening account's sid when it fails after a switch", async () => {
    storageHelper.setServerConfig({ address: "http://abs.local", token: "tokA", userId: "uA" });
    mockedPost.mockImplementationOnce(async () => {
      // syncProgress flushes first (nothing queued), then POSTs the sync.
      storageHelper.setServerConfig({ address: "http://abs.local", token: "tokB", userId: "uB" });
      throw errNetwork();
    });
    await syncProgress({ sessionId: "s2", currentTime: 40, timeListened: 4, duration: 400 });
    expect(readJson("pendingSync_s2").sid).toBe("http://abs.local::uA");
  });
});

describe("monotonic stamp cross-restart seeding", () => {
  // monotonicNow is only monotonic within one JS lifetime; on first use it
  // seeds from the freshest `at` persisted in the queue so a backward clock
  // adjustment across a RESTART can't let an old on-disk entry outrank every
  // new stamp. Needs a fresh module copy (the seed is once-per-boot).
  it("a new stamp beats a persisted entry stamped before a backward clock jump", async () => {
    jest.resetModules();
    const freshStorage = require("../../utils/storage").storage;
    const freshApi = require("../../utils/api").api;
    const ps = require("../../utils/progressSync");
    freshStorage.getAllKeys().forEach((k: string) => freshStorage.remove(k));
    // Queuing is gated on a stored session (fresh module copy = fresh storage).
    require("../../utils/storage").storageHelper.setServerConfig({
      address: "http://abs.local",
      token: "tok",
    });
    // Persisted by a previous boot, stamped BEFORE the wall clock was set back.
    freshStorage.set(
      "pendingSync_sess1",
      JSON.stringify({
        sessionId: "sess1",
        currentTime: 100,
        timeListened: 5,
        duration: 3600,
        at: 5_000_000,
      })
    );
    (freshApi.post as jest.Mock).mockRejectedValue(new Error("Network Error"));
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(1_000_000); // clock now BEHIND the stamp
    try {
      await ps.syncProgress({ sessionId: "sess1", currentTime: 200, timeListened: 1, duration: 3600 });
      const rec = JSON.parse(freshStorage.getString("pendingSync_sess1")!);
      // The NEW position won the freshest-wins merge despite the backward clock...
      expect(rec.currentTime).toBe(200);
      expect(rec.at).toBeGreaterThan(5_000_000);
      // ...and listened seconds still accumulated.
      expect(rec.timeListened).toBe(6);
    } finally {
      nowSpy.mockRestore();
    }
  });
});

// --- Cross-medium progress sync (listening ↔ reading) -----------------------
// NOTE: a test above calls jest.resetModules() without restoring, so this block
// captures a CONSISTENT fresh module set (progressSync + useUserStore + storage
// resolved from the same registry) in beforeEach — otherwise progressSync's
// lazy require of useUserStore would diverge from the store we assert against.
describe("syncBothProgressFraction / reconcileLinkedProgress", () => {
  const ITEM = "li1";
  let ps: any;
  let store: any;
  let freshStorage: any;
  const readBody = (item: string) => {
    const raw = freshStorage.getString(`pendingPatch_${item}`);
    return raw ? JSON.parse(raw).body : null;
  };
  const freshPatchKeys = () =>
    freshStorage.getAllKeys().filter((k: string) => k.startsWith("pendingPatch_"));

  beforeEach(() => {
    jest.resetModules();
    ps = require("../../utils/progressSync");
    store = require("../../store/useUserStore").useUserStore;
    const s = require("../../utils/storage");
    freshStorage = s.storage;
    freshStorage.getAllKeys().forEach((k: string) => freshStorage.remove(k));
    s.storageHelper.setServerConfig({ address: "http://abs.local", token: "tok" });
    // api is mocked (hoisted) but a reset registry hands out a fresh mock object.
    require("../../utils/api").api.patch.mockRejectedValue(new Error("Network Error"));
    store.setState({
      mediaProgress: {},
      settings: { ...store.getState().settings, linkedProgress: {} },
    });
  });

  it("writes BOTH media to the target fraction and preserves the CFI (offline → queued)", () => {
    store.setState({
      mediaProgress: {
        [ITEM]: {
          libraryItemId: ITEM,
          progress: 0.2,
          ebookProgress: 0.2,
          ebookLocation: "epubcfi(/6/4)",
          duration: 3600,
        },
      },
    });
    ps.syncBothProgressFraction(ITEM, 0.5, { duration: 3600, ebookLocation: "epubcfi(/6/4)" });
    const body = readBody(ITEM);
    // Audio: currentTime = fraction*duration, plus the derived progress.
    expect(body.currentTime).toBe(1800);
    expect(body.duration).toBe(3600);
    expect(body.progress).toBe(0.5);
    // Ebook: fraction only, CFI preserved (page NOT recomputed from a fraction).
    expect(body.ebookProgress).toBe(0.5);
    expect(body.ebookLocation).toBe("epubcfi(/6/4)");
    // In-memory map updated immediately for the UI.
    const p = store.getState().mediaProgress[ITEM];
    expect(p.progress).toBe(0.5);
    expect(p.ebookProgress).toBe(0.5);
  });

  it("does NOT write ebookLocation when none is known (never clobbers a server CFI)", () => {
    ps.syncBothProgressFraction(ITEM, 0.4, { duration: 1000, ebookLocation: "" });
    const body = readBody(ITEM);
    expect(body.ebookProgress).toBe(0.4);
    expect("ebookLocation" in body).toBe(false);
  });

  // QA#1: the finished branch (f >= 0.99) marks isFinished on BOTH the queued
  // PATCH body and the in-memory entry.
  it("QA#1: a target fraction >= 0.99 marks the item finished (queued body + in-memory)", () => {
    ps.syncBothProgressFraction(ITEM, 1, { duration: 3600 });
    const body = readBody(ITEM);
    expect(body.isFinished).toBe(true);
    expect(store.getState().mediaProgress[ITEM].isFinished).toBe(true);
  });

  // QA#2: unknown duration cannot place a timestamp — the queued body and the
  // in-memory entry must carry ebookProgress WITHOUT any bogus audio fields
  // (a currentTime=0 would regress real server progress).
  it("QA#2: unknown duration queues ebookProgress only — no bogus currentTime/duration/progress", () => {
    ps.syncBothProgressFraction(ITEM, 0.6, { duration: 0 });
    const body = readBody(ITEM);
    expect(body.ebookProgress).toBe(0.6);
    expect("currentTime" in body).toBe(false);
    expect("duration" in body).toBe(false);
    expect("progress" in body).toBe(false);
    const p = store.getState().mediaProgress[ITEM];
    expect(p.ebookProgress).toBe(0.6);
    expect("currentTime" in p).toBe(false);
    expect("progress" in p).toBe(false);
  });

  it("reconcileLinkedProgress is a no-op when the item is NOT linked", () => {
    store.setState({
      mediaProgress: { [ITEM]: { libraryItemId: ITEM, progress: 0.5, ebookProgress: 0.1, duration: 3600 } },
    });
    expect(ps.isProgressLinked(ITEM)).toBe(false);
    expect(ps.reconcileLinkedProgress(ITEM)).toBe(false);
    expect(freshPatchKeys()).toHaveLength(0);
  });

  it("locked reconcile pulls the lagging medium UP to the furthest fraction (never backward)", () => {
    store.setState({
      mediaProgress: {
        [ITEM]: { libraryItemId: ITEM, progress: 0.3, ebookProgress: 0.7, ebookLocation: "epubcfi(/6/9)", duration: 3600 },
      },
      settings: { ...store.getState().settings, linkedProgress: { [ITEM]: true } },
    });
    expect(ps.reconcileLinkedProgress(ITEM)).toBe(true);
    const p = store.getState().mediaProgress[ITEM];
    // Furthest = 0.7 (the ebook); audio moves FORWARD to match, ebook unchanged.
    expect(p.progress).toBe(0.7);
    expect(p.ebookProgress).toBe(0.7);
    expect(readBody(ITEM).ebookLocation).toBe("epubcfi(/6/9)");
  });

  // Fix #2: enabling the lock on a read-but-unlistened both-format book must NOT
  // silently mark the untouched audiobook finished. reconcileLinkedProgress runs
  // on the manual toggle-ON (directly AND via ItemDetail's focus-effect re-run),
  // so the guard lives here: skip when the lagging side is unstarted (≈0) and the
  // target is a finish (>=0.99).
  it("does NOT silently finish an UNSTARTED audiobook when the lock is enabled (ebook 100%, audio 0%)", () => {
    store.setState({
      mediaProgress: {
        [ITEM]: { libraryItemId: ITEM, progress: 0, ebookProgress: 1.0, duration: 3600 },
      },
      settings: { ...store.getState().settings, linkedProgress: { [ITEM]: true } },
    });

    // No reconciling write, no queued PATCH, and the audio stays UNstarted.
    expect(ps.reconcileLinkedProgress(ITEM)).toBe(false);
    expect(freshPatchKeys()).toHaveLength(0);
    const p = store.getState().mediaProgress[ITEM];
    expect(p.progress).toBe(0);
    expect(p.isFinished).toBeUndefined();
  });

  it("also guards the reverse: enabling on read-0%/listened-100% does not finish the unopened ebook", () => {
    store.setState({
      mediaProgress: {
        [ITEM]: { libraryItemId: ITEM, progress: 1.0, ebookProgress: 0, duration: 3600 },
      },
      settings: { ...store.getState().settings, linkedProgress: { [ITEM]: true } },
    });
    expect(ps.reconcileLinkedProgress(ITEM)).toBe(false);
    expect(freshPatchKeys()).toHaveLength(0);
    expect(store.getState().mediaProgress[ITEM].ebookProgress).toBe(0);
  });

  it("STILL reconciles an unstarted side to a NON-finished percentage (listen-only linking works)", () => {
    // Audio at 50%, ebook never opened (0). Target 0.5 is NOT a finish, so the
    // ebook percentage still moves up — only the destructive finish jump is guarded.
    store.setState({
      mediaProgress: { [ITEM]: { libraryItemId: ITEM, progress: 0.5, ebookProgress: 0, duration: 3600 } },
      settings: { ...store.getState().settings, linkedProgress: { [ITEM]: true } },
    });
    expect(ps.reconcileLinkedProgress(ITEM)).toBe(true);
    expect(store.getState().mediaProgress[ITEM].ebookProgress).toBe(0.5);
  });

  it("locked reconcile is a no-op when the two are already aligned", () => {
    store.setState({
      mediaProgress: { [ITEM]: { libraryItemId: ITEM, progress: 0.5, ebookProgress: 0.5, duration: 3600 } },
      settings: { ...store.getState().settings, linkedProgress: { [ITEM]: true } },
    });
    expect(ps.reconcileLinkedProgress(ITEM)).toBe(false);
    expect(freshPatchKeys()).toHaveLength(0);
  });

  it("locked reconcile honors a fresh hint over the stored map (a just-closed audio position)", () => {
    store.setState({
      mediaProgress: { [ITEM]: { libraryItemId: ITEM, progress: 0.1, ebookProgress: 0.2, duration: 3600 } },
      settings: { ...store.getState().settings, linkedProgress: { [ITEM]: true } },
    });
    // Audio just closed at 0.8 (not yet in the map) → both reconcile to 0.8.
    expect(ps.reconcileLinkedProgress(ITEM, { audioFraction: 0.8, duration: 3600 })).toBe(true);
    const p = store.getState().mediaProgress[ITEM];
    expect(p.progress).toBeCloseTo(0.8, 5);
    expect(p.ebookProgress).toBeCloseTo(0.8, 5);
  });

  // REGRESSION (SE#3): locked item, ebook furthest, audio duration UNKNOWN. The
  // audio timestamp can never be placed, so audio stays behind and the two can
  // never converge — every ItemDetail focus used to re-queue a redundant PATCH
  // + flush forever. "Audio can't move" is now treated as un-reconcilable: the
  // reconcile is a stable no-op instead of an endless re-queue loop.
  it("SE#3: locked item, ebook ahead, unknown duration — reconcile is a stable no-op (no re-queue loop)", () => {
    store.setState({
      mediaProgress: {
        [ITEM]: {
          libraryItemId: ITEM,
          progress: 0.2,
          ebookProgress: 0.7,
          ebookLocation: "epubcfi(/6/9)",
          duration: 0, // unknown — no audio timestamp derivable
        },
      },
      settings: { ...store.getState().settings, linkedProgress: { [ITEM]: true } },
    });
    // First call: audio is the lagging side and can't advance → no write.
    expect(ps.reconcileLinkedProgress(ITEM)).toBe(false);
    expect(freshPatchKeys()).toHaveLength(0);
    // Repeated calls (repeated focus) stay no-ops — the loop converges.
    expect(ps.reconcileLinkedProgress(ITEM)).toBe(false);
    expect(ps.reconcileLinkedProgress(ITEM)).toBe(false);
    expect(freshPatchKeys()).toHaveLength(0);
    // The in-memory progress is untouched (audio not dragged, ebook not moved).
    const p = store.getState().mediaProgress[ITEM];
    expect(p.progress).toBe(0.2);
    expect(p.ebookProgress).toBe(0.7);
  });

  // The audio-AHEAD counterpart still reconciles with unknown duration: the
  // ebook side moves regardless of duration, so the two converge.
  it("SE#3 counterpart: audio ahead with unknown duration still pulls the ebook up", () => {
    store.setState({
      mediaProgress: {
        [ITEM]: { libraryItemId: ITEM, progress: 0.6, ebookProgress: 0.2, duration: 0 },
      },
      settings: { ...store.getState().settings, linkedProgress: { [ITEM]: true } },
    });
    expect(ps.reconcileLinkedProgress(ITEM)).toBe(true);
    // Ebook caught up to the audio fraction; audio (in-memory) unchanged.
    expect(store.getState().mediaProgress[ITEM].ebookProgress).toBe(0.6);
  });
});
