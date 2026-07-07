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
  recordLocalListening,
  hasAnyPendingSyncs,
} from "../../utils/progressSync";

jest.mock("../../utils/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

// recordLocalListening lazy-requires the download store for display metadata —
// mock it so the test doesn't pull in expo-file-system/db, and so we can
// assert the display fields land in the POSTed local session.
jest.mock("../../store/useDownloadStore", () => ({
  useDownloadStore: {
    getState: () => ({
      completedDownloads: { li1: { title: "Book One", author: "Author A" } },
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
