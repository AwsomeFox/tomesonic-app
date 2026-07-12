/**
 * hasPendingWritesFor — REAL-IMPLEMENTATION CONTRACT.
 *
 * Every other suite MOCKS utils/progressSync, so the real
 * hasPendingWritesFor() has zero coverage — yet it single-handedly arbitrates
 * keep-vs-drop for LOCAL-ONLY progress entries in useUserStore's merge:
 * `true`  → "written here, still queued" → the local entry is KEPT;
 * `false` → "the server deleted it"      → the local entry is DROPPED.
 * A false negative silently discards un-synced offline listening; a false
 * positive resurrects progress the user deleted on another device. These
 * tests drive it against the real MMKV-backed queues.
 */
jest.mock("../../utils/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

import { api } from "../../utils/api";
import { storage, storageHelper, secureStorage } from "../../utils/storage";
import {
  queueProgressPatch,
  queueFinishedPatch,
  queueEbookProgressPatch,
  closeSession,
  hasPendingWritesFor,
} from "../../utils/progressSync";

describe("hasPendingWritesFor (real progressSync + real MMKV)", () => {
  beforeEach(() => {
    storage.clearAll();
    secureStorage.clearAll();
    // The queue writers refuse to enqueue with no stored token (a post-logout
    // straggler must not flush under the next account) — establish a session.
    storageHelper.setServerConfig({
      address: "https://srv.example.com",
      userId: "u1",
      token: "tok",
    });
  });

  it("empty queue → false", () => {
    expect(hasPendingWritesFor("itemX")).toBe(false);
    expect(hasPendingWritesFor("itemX", "ep1")).toBe(false);
  });

  it("a queued progress patch for item X → true for X, false for others", () => {
    queueProgressPatch("itemX", 120, 3600);
    expect(hasPendingWritesFor("itemX")).toBe(true);
    expect(hasPendingWritesFor("itemY")).toBe(false);
    // An episode-scoped query does NOT match the bare-item patch.
    expect(hasPendingWritesFor("itemX", "ep1")).toBe(false);
  });

  it("a queued finished toggle for item X → true", () => {
    queueFinishedPatch("itemX", true);
    expect(hasPendingWritesFor("itemX")).toBe(true);
  });

  it("a queued ebook patch for item X → true", () => {
    queueEbookProgressPatch("itemX", "epubcfi(/6/4!/4/2)", 0.42);
    expect(hasPendingWritesFor("itemX")).toBe(true);
  });

  it("composite scoping: pending for (pod1, ep1) matches ONLY that exact pair", () => {
    queueProgressPatch("pod1", 30, 1800, "ep1");
    expect(hasPendingWritesFor("pod1", "ep1")).toBe(true);
    expect(hasPendingWritesFor("pod1", "ep2")).toBe(false);
    // BY DESIGN the bare podcast id does NOT match an episode's pending write:
    // podcast progress is stored per-episode under the composite
    // `${itemId}-${episodeId}` key on both the queue side (pendingPatch_ key)
    // and the mediaProgress map side, so the merge only ever asks about the
    // exact pair it is deciding on. An episode write must not shield a
    // (nonexistent) book-level entry from deletion.
    expect(hasPendingWritesFor("pod1")).toBe(false);
  });

  it("a queued SESSION sync (closeSession failed offline) matches by item + episode identity", async () => {
    jest.mocked(api.post).mockRejectedValue(new Error("Network Error"));
    await closeSession({
      sessionId: "sess-live-1",
      currentTime: 99,
      timeListened: 60,
      duration: 3600,
      libraryItemId: "itemZ",
    });
    expect(hasPendingWritesFor("itemZ")).toBe(true);
    expect(hasPendingWritesFor("itemZ", "ep1")).toBe(false);
    expect(hasPendingWritesFor("other")).toBe(false);
  });

  it("a queued EPISODE session sync matches only the (item, episode) pair", async () => {
    jest.mocked(api.post).mockRejectedValue(new Error("Network Error"));
    await closeSession({
      sessionId: "sess-live-2",
      currentTime: 10,
      timeListened: 5,
      duration: 1800,
      libraryItemId: "pod2",
      episodeId: "ep1",
    });
    expect(hasPendingWritesFor("pod2", "ep1")).toBe(true);
    expect(hasPendingWritesFor("pod2", "ep2")).toBe(false);
    expect(hasPendingWritesFor("pod2")).toBe(false);
  });

  it("a CORRUPT pendingSync_ blob never throws and never matches (skipped defensively)", () => {
    storage.set("pendingSync_torn", '{"libraryItemId":"itemX","currentTi'); // torn write
    expect(() => hasPendingWritesFor("itemX")).not.toThrow();
    // The corrupt entry can't be attributed to any item — it must not vouch
    // for itemX's local-only progress.
    expect(hasPendingWritesFor("itemX")).toBe(false);
    // ...and it must not poison scans for other items either.
    storage.set("pendingPatch_itemGood", JSON.stringify({ libraryItemId: "itemGood", body: { currentTime: 1 } }));
    expect(hasPendingWritesFor("itemGood")).toBe(true);
  });

  it("a CORRUPT pendingPatch_ blob for the exact key still counts as pending (existence check, by design)", () => {
    // The patch branch tests key EXISTENCE without parsing — a torn patch blob
    // therefore reads as "something is queued for this item". That bias is the
    // SAFE direction: keeping a local entry too long is recoverable (the next
    // successful flush/merge settles it), silently dropping un-synced offline
    // progress is not. Pinned so a refactor to parse-and-validate here is a
    // conscious decision, not an accident.
    storage.set("pendingPatch_itemC", '{"libraryItemId":"itemC","body":{');
    expect(() => hasPendingWritesFor("itemC")).not.toThrow();
    expect(hasPendingWritesFor("itemC")).toBe(true);
  });
});
