/**
 * PROCESS-DEATH RESILIENCE — progress survives a background kill.
 *
 * HONESTY: no real doze or LMK kill can be simulated in JS. What CAN be
 * simulated faithfully is the state machine around one: the JS process dies
 * (module registry + zustand stores wiped) while the MMKV "disk" survives.
 * The shared harness (persistentMmkvDisk.cjs) models exactly that —
 * jest.resetModules() is the kill, a globalThis-backed MMKV mock is the flash
 * storage that persists across it.
 *
 * The persist path under test is the REAL one: onNativeProgressSample →
 * persistProgressSample → storageHelper.setLastPlaybackSession (throttled to
 * LOCAL_SAVE_INTERVAL_MS = 5000ms), plus the pause() fast-path
 * (saveSessionPositionNow) that bypasses the throttle.
 */

jest.mock("react-native-mmkv", () => require("./persistentMmkvDisk.cjs").mmkvDiskModule());
jest.mock("../../utils/api", () => require("./persistentMmkvDisk.cjs").apiMockModule());
jest.mock("../../utils/progressSync", () =>
  require("./persistentMmkvDisk.cjs").progressSyncMockModule()
);
jest.mock("../../utils/autoCreds", () => require("./persistentMmkvDisk.cjs").autoCredsMockModule());
jest.mock("../../utils/upNext", () => require("./persistentMmkvDisk.cjs").upNextMockModule());

const { boot, wipeDisk } = require("./persistentMmkvDisk.cjs");

const BASE = new Date("2026-04-01T08:00:00Z").getTime();

function serverSession(over: Record<string, any> = {}) {
  return {
    id: "sess1",
    libraryItemId: "item1",
    displayTitle: "The Hobbit",
    displayAuthor: "Tolkien",
    duration: 3600,
    currentTime: 0,
    chapters: [],
    audioTracks: [
      { index: 0, contentUrl: "/api/items/item1/file/0", duration: 3600, startOffset: 0 },
    ],
    ...over,
  };
}

describe("process-death resilience (JS state machine — kill = module reset, MMKV disk preserved)", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(BASE);
    wipeDisk();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("a kill mid-playback resumes from the last throttled MMKV save: position, session identity and queue all survive", async () => {
    let w = boot();
    w.storageHelper.setServerConfig({ address: "https://abs.example.com", token: "tok" });

    await w.playback.usePlaybackStore.getState().preparePlaybackSession(serverSession(), false);
    w.playback.usePlaybackStore.getState().addToQueue({
      libraryItemId: "next-book",
      title: "Next Book",
    });

    // Drive the REAL background persistence path (native 1 Hz samples).
    const feed = (tSec: number, pos: number) => {
      jest.setSystemTime(BASE + tSec * 1000);
      w.playback.onNativeProgressSample({ position: pos, duration: 3600, track: 0 });
    };
    feed(0, 600); // persisted (first playing sample; throttle window open)
    for (let t = 1; t <= 4; t++) feed(t, 600 + t); // throttled — not on disk
    feed(5, 605); // persisted (5s window elapsed)
    for (let t = 6; t <= 9; t++) feed(t, 600 + t); // throttled — killed here

    // ---- PROCESS DEATH: all JS memory gone, disk intact ----
    w = boot();

    const saved = w.storageHelper.getLastPlaybackSession();
    // The resumed store sees the last persisted sample, not the last heard one…
    expect(saved.currentTime).toBe(605);
    // …bounding the loss to the throttle window (last heard was 609).
    expect(609 - saved.currentTime).toBeLessThanOrEqual(5);
    // Session identity survives for resumption.
    expect(saved.id).toBe("sess1");
    expect(saved.libraryItemId).toBe("item1");
    expect(Number(saved.updatedAt)).toBe(BASE + 5000);
    // The cross-book queue rehydrates from the SAME storage (getStoredQueue
    // runs at store creation — this is the fresh store's initial state).
    expect(w.playback.usePlaybackStore.getState().queue).toEqual([
      expect.objectContaining({ libraryItemId: "next-book" }),
    ]);
    // And the fresh store starts with no live session (restore is explicit).
    expect(w.playback.usePlaybackStore.getState().currentSession).toBeNull();
  });

  it("persistence-loss bound: 1 Hz playing samples persist at least every 5s (LOCAL_SAVE_INTERVAL_MS) — a kill loses at most 4s of heard audio", async () => {
    const w = boot();
    w.storageHelper.setServerConfig({ address: "https://abs.example.com", token: "tok" });
    await w.playback.usePlaybackStore.getState().preparePlaybackSession(serverSession(), false);

    // Measure the worst-case gap between the live position and what a kill at
    // that instant would find on disk, over 30s of continuous playback.
    let maxLoss = -Infinity;
    for (let t = 0; t <= 30; t++) {
      jest.setSystemTime(BASE + t * 1000);
      const pos = 1000 + t;
      w.playback.onNativeProgressSample({ position: pos, duration: 3600, track: 0 });
      const onDisk = w.storageHelper.getLastPlaybackSession()?.currentTime;
      expect(typeof onDisk).toBe("number");
      maxLoss = Math.max(maxLoss, pos - onDisk);
    }

    // Two distinct assertions:
    //  - toBe(4): a phase CANARY specific to this 1 Hz sampling — saves land
    //    at t=0,5,10,…, so the worst gap right before a save is exactly 4
    //    one-second samples. It trips on ANY change to the throttle mechanics
    //    (window widened/narrowed, _lastLocalSaveAt reset moved, sampling
    //    assumptions broken) even if the change still fits the contract.
    //  - <=5: the actual CONTRACT — a kill may lose at most the
    //    LOCAL_SAVE_INTERVAL_MS window of listening.
    expect(maxLoss).toBe(4);
    expect(maxLoss).toBeLessThanOrEqual(5);
  });

  it("after a kill, freshest-wins resume picks the local MMKV save over a stale server position", async () => {
    let w = boot();
    w.storageHelper.setServerConfig({ address: "https://abs.example.com", token: "tok" });
    await w.playback.usePlaybackStore.getState().preparePlaybackSession(serverSession(), false);
    // Listen to 605s; the last durable save is at t=5s → currentTime 605.
    jest.setSystemTime(BASE);
    w.playback.onNativeProgressSample({ position: 600, duration: 3600, track: 0 });
    jest.setSystemTime(BASE + 5000);
    w.playback.onNativeProgressSample({ position: 605, duration: 3600, track: 0 });

    // ---- PROCESS DEATH ----
    w = boot();

    // The server still thinks 100s, last updated a minute BEFORE the local save.
    w.user.useUserStore.setState({
      mediaProgress: {
        item1: { libraryItemId: "item1", currentTime: 100, lastUpdate: BASE - 60_000 },
      },
    } as any);

    await w.playback.usePlaybackStore
      .getState()
      .preparePlaybackSession(serverSession({ currentTime: 100 }), false);

    // Local MMKV save (605 @ BASE+5s) beats the stale server position (100).
    expect(w.TrackPlayer.seekTo).toHaveBeenCalledWith(605);
    const s = w.playback.usePlaybackStore.getState();
    expect(s.position).toBe(605);
    expect(s.currentSession.currentTime).toBe(605);
  });

  it("a podcast EPISODE session preserves episodeId across a kill (resumption targets the right episode)", async () => {
    let w = boot();
    w.storageHelper.setServerConfig({ address: "https://abs.example.com", token: "tok" });
    await w.playback.usePlaybackStore
      .getState()
      .preparePlaybackSession(
        serverSession({ id: "sess-ep", libraryItemId: "pod1", episodeId: "ep1" }),
        false
      );
    w.playback.onNativeProgressSample({ position: 120, duration: 3600, track: 0 });

    // ---- PROCESS DEATH ----
    w = boot();

    const saved = w.storageHelper.getLastPlaybackSession();
    expect(saved.libraryItemId).toBe("pod1");
    expect(saved.episodeId).toBe("ep1");
    expect(saved.currentTime).toBe(120);
    // The media-progress disk mirror keyed the episode by its COMPOSITE key —
    // an offline cold start resumes the episode, not a bogus item-level row.
    expect(w.storageHelper.getMediaProgressCache()["pod1-ep1"]).toEqual(
      expect.objectContaining({ episodeId: "ep1", currentTime: 120 })
    );
  });

  it("pause persists the LIVE player position immediately (throttle bypass) — a kill right after pause loses nothing", async () => {
    let w = boot();
    w.storageHelper.setServerConfig({ address: "https://abs.example.com", token: "tok" });
    await w.playback.usePlaybackStore.getState().preparePlaybackSession(serverSession(), true);

    // A durable save lands at t=0 (700), then the throttle window opens.
    jest.setSystemTime(BASE);
    w.playback.onNativeProgressSample({ position: 700, duration: 3600, track: 0 });
    jest.setSystemTime(BASE + 3000);
    w.playback.onNativeProgressSample({ position: 703, duration: 3600, track: 0 });
    expect(w.storageHelper.getLastPlaybackSession().currentTime).toBe(700); // still throttled

    // Pause reads the live player position and persists it NOW.
    w.TrackPlayer.getProgress.mockResolvedValue({ position: 703.5, duration: 3600, buffered: 0 });
    await w.playback.usePlaybackStore.getState().pause();

    // ---- PROCESS DEATH right after the pause ----
    w = boot();
    expect(w.storageHelper.getLastPlaybackSession().currentTime).toBe(703.5);
  });

  it("an MMKV write failure never crashes the sample pipeline — in-memory playback state still advances (disk stays stale)", async () => {
    const w = boot();
    w.storageHelper.setServerConfig({ address: "https://abs.example.com", token: "tok" });
    await w.playback.usePlaybackStore.getState().preparePlaybackSession(serverSession(), false);
    jest.setSystemTime(BASE);
    w.playback.onNativeProgressSample({ position: 600, duration: 3600, track: 0 }); // durable save: 600

    // The disk rejects the next throttled save (full/IO error).
    jest.setSystemTime(BASE + 5000);
    const failingSet = jest.spyOn(w.storage, "set").mockImplementation(() => {
      throw new Error("MMKV write failed (disk full)");
    });
    expect(() =>
      w.playback.onNativeProgressSample({ position: 605, duration: 3600, track: 0 })
    ).not.toThrow();
    failingSet.mockRestore();

    // Playback itself is unharmed…
    expect(w.playback.usePlaybackStore.getState().position).toBe(605);
    expect(w.playback.usePlaybackStore.getState().isPlaying).toBe(true);
    // …but the crash-safe save is stale at the previous value.
    expect(w.storageHelper.getLastPlaybackSession().currentTime).toBe(600);
  });

  // BUG HISTORY (found by this suite, since fixed on master — the test below
  // now runs live as the regression pin). Original defect:
  //
  //   usePlaybackStore.ts:823-830 — persistProgressSample advanced
  //   `_lastLocalSaveAt = now` (line 824) BEFORE calling the UNGUARDED
  //   storageHelper.setLastPlaybackSession (line 830; storage.ts:125-127 is a
  //   bare `storage.set` with no try/catch). If that MMKV write throws (disk
  //   full / IO error), the exception unwinds persistProgressSample and is
  //   swallowed by onNativeProgressSample's blanket `catch {}`
  //   (usePlaybackStore.ts:1080). Because the throttle stamp was already
  //   advanced, the failed save is NOT retried on the next 1s tick — crash
  //   safety is silently disabled for a full LOCAL_SAVE_INTERVAL_MS window
  //   (the disk can be up to ~10s stale instead of the intended <=5s). The
  //   same unwind also skips the remainder of that tick's pipeline: the
  //   mediaProgress display mirror, the 15s server-sync block, and the
  //   auto-finish check (all after the save in persistProgressSample).
  //
  //   Scenario: screen off, native 1 Hz samples driving persistence, one MMKV
  //   write fails at t=5s, process killed before t=10s → the app resumes at
  //   t=0s instead of >=5s, doubling the guaranteed loss bound.
  //
  //   FIXED on master: the save is now wrapped in its own try/catch and
  //   _lastLocalSaveAt advances only on success, so a failed write neither
  //   consumes the window nor aborts the mirror/sync blocks. This suite found
  //   the bug (it failed `Expected: 606, Received: 600` against the old code)
  //   and now pins the fix as a live regression test.
  describe("regression: a failed MMKV save must not consume the 5s throttle window", () => {
    it("retries the crash-safe save on the next tick after a write failure", async () => {
      const w = boot();
      w.storageHelper.setServerConfig({ address: "https://abs.example.com", token: "tok" });
      await w.playback.usePlaybackStore.getState().preparePlaybackSession(serverSession(), false);
      jest.setSystemTime(BASE);
      w.playback.onNativeProgressSample({ position: 600, duration: 3600, track: 0 }); // save: 600

      // t=5s: the throttled save fires but the disk write FAILS once.
      jest.setSystemTime(BASE + 5000);
      const failingSet = jest.spyOn(w.storage, "set").mockImplementation(() => {
        throw new Error("MMKV write failed (disk full)");
      });
      w.playback.onNativeProgressSample({ position: 605, duration: 3600, track: 0 });
      failingSet.mockRestore();

      // t=6s: the disk is healthy again. DESIRED: the failed save is retried
      // now, so a kill anywhere in the (5s, 10s) window still loses <=5s.
      jest.setSystemTime(BASE + 6000);
      w.playback.onNativeProgressSample({ position: 606, duration: 3600, track: 0 });

      // ACTUAL today: 600 — the failed save consumed the window; nothing is
      // written again until t=10s.
      expect(w.storageHelper.getLastPlaybackSession().currentTime).toBe(606);
    });
  });
});
