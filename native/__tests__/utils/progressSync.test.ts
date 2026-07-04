import { storage } from "../../utils/storage";
import { api } from "../../utils/api";
import {
  syncProgress,
  closeSession,
  flushPendingSyncs,
  clearAllPending,
  queueProgressPatch,
  queueEbookProgressPatch,
  queueFinishedPatch,
} from "../../utils/progressSync";

jest.mock("../../utils/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

const mockedPost = jest.mocked(api.post);
const mockedPatch = jest.mocked(api.patch);

const err404 = () => ({ response: { status: 404 } });
const errNetwork = () => new Error("Network Error");

const readJson = (key: string) => {
  const raw = storage.getString(key);
  return raw ? JSON.parse(raw) : null;
};
const pendingKeys = () => storage.getAllKeys().filter((k) => k.startsWith("pendingSync_"));
const patchKeys = () => storage.getAllKeys().filter((k) => k.startsWith("pendingPatch_"));

beforeEach(() => {
  storage.getAllKeys().forEach((k) => storage.remove(k));
  mockedPost.mockResolvedValue({ data: {} } as any);
  mockedPatch.mockResolvedValue({ data: {} } as any);
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
    });
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

  it("uses 0 progress when duration is 0 or negative", () => {
    queueProgressPatch("li1", 50, 0);
    expect(readJson("pendingPatch_li1").body.progress).toBe(0);
    queueProgressPatch("li2", 50, -10);
    expect(readJson("pendingPatch_li2").body.progress).toBe(0);
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
});
