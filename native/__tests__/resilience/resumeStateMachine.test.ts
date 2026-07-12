/**
 * RESUME-AFTER-KILL STATE MACHINE — a fresh store init over persisted state
 * enters a sane state.
 *
 * HONESTY: no real doze/kill — "kill" = jest.resetModules() over a
 * globalThis-backed MMKV disk (see persistentMmkvDisk.cjs).
 *
 * Covers:
 *  - cold restore from the persisted session + queue (loadLastSession),
 *  - the playback-resumption adoption path: a live native "play:<itemId>" /
 *    "play:<itemId>::<episodeId>" queue item (Android Auto cold start /
 *    Media3 onPlaybackResumption) starts the RIGHT item at the RIGHT position,
 *  - corrupted/garbage persisted blobs degrade to a clean no-session state
 *    without crashing init.
 */

jest.mock("react-native-mmkv", () => require("./persistentMmkvDisk.cjs").mmkvDiskModule());
jest.mock("../../utils/api", () => require("./persistentMmkvDisk.cjs").apiMockModule());
jest.mock("../../utils/progressSync", () =>
  require("./persistentMmkvDisk.cjs").progressSyncMockModule()
);
jest.mock("../../utils/autoCreds", () => require("./persistentMmkvDisk.cjs").autoCredsMockModule());
jest.mock("../../utils/upNext", () => require("./persistentMmkvDisk.cjs").upNextMockModule());

const { boot, wipeDisk } = require("./persistentMmkvDisk.cjs");

const BASE = new Date("2026-04-03T07:00:00Z").getTime();

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

describe("resume-after-kill state machine (JS — kill = module reset, MMKV disk preserved)", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(BASE);
    wipeDisk();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("cold start over a persisted session + queue restores the same item at the saved position, PAUSED", async () => {
    // Persist state as a previous process would have left it.
    let w = boot();
    w.storageHelper.setServerConfig({ address: "https://abs.example.com", token: "tok" });
    w.storageHelper.setLastPlaybackSession({
      ...serverSession(),
      currentTime: 250,
      updatedAt: BASE - 3_600_000,
    });
    w.storage.set("playbackQueue", JSON.stringify([{ libraryItemId: "q1", title: "Queued" }]));

    // ---- PROCESS DEATH → fresh init ----
    w = boot();
    w.api.get.mockRejectedValue(new Error("offline")); // freshness GET fails → local save stands

    await w.playback.usePlaybackStore.getState().loadLastSession();

    const s = w.playback.usePlaybackStore.getState();
    expect(s.currentSession.id).toBe("sess1");
    expect(s.currentSession.libraryItemId).toBe("item1");
    expect(s.position).toBe(250);
    expect(w.TrackPlayer.seekTo).toHaveBeenCalledWith(250);
    // Restore never auto-starts audio.
    expect(s.isPlaying).toBe(false);
    expect(w.TrackPlayer.play).not.toHaveBeenCalled();
    // The queue rehydrated at store creation from the same disk.
    expect(s.queue).toEqual([expect.objectContaining({ libraryItemId: "q1" })]);
  });

  it('playback-resumption: a live native "play:<itemId>" track is adopted — the RIGHT item resumes at the freshest known position', async () => {
    let w = boot();
    w.storageHelper.setServerConfig({ address: "https://abs.example.com", token: "tok" });
    // Fresh local save: 450s, newer than anything the server knows.
    w.storageHelper.setLastPlaybackSession({
      id: "old-sess",
      libraryItemId: "item1",
      currentTime: 450,
      updatedAt: BASE,
    });

    // ---- PROCESS DEATH; Android Auto cold-started native playback ----
    w = boot();
    w.TrackPlayer.getPlaybackState.mockResolvedValue({ state: "playing" });
    w.TrackPlayer.getActiveTrack.mockResolvedValue({ mediaId: "play:item1" });
    w.api.post.mockResolvedValue({ data: serverSession({ currentTime: 300 }) });

    await w.playback.usePlaybackStore.getState().loadLastSession();

    // Adopted via the real /play flow for the parsed item id…
    expect(w.api.post).toHaveBeenCalledWith("/api/items/item1/play", expect.anything());
    // …skipping the disk-restore freshness GET entirely.
    expect(w.api.get).not.toHaveBeenCalled();
    const s = w.playback.usePlaybackStore.getState();
    expect(s.currentSession.id).toBe("sess1");
    // Freshest-wins: the local MMKV save (450 @ BASE) beats the server's 300.
    expect(s.position).toBe(450);
  });

  it('playback-resumption: "play:<itemId>::<episodeId>" (with an @@position suffix) resumes the RIGHT podcast episode', async () => {
    const w = boot();
    w.storageHelper.setServerConfig({ address: "https://abs.example.com", token: "tok" });
    w.TrackPlayer.getPlaybackState.mockResolvedValue({ state: "playing" });
    w.TrackPlayer.getActiveTrack.mockResolvedValue({ mediaId: "play:pod1::ep1@@123.5" });
    w.api.post.mockResolvedValue({
      data: serverSession({ id: "sess-ep", libraryItemId: "pod1", episodeId: "ep1" }),
    });

    await w.playback.usePlaybackStore.getState().loadLastSession();

    // Episode-scoped play endpoint — not the whole podcast item.
    expect(w.api.post).toHaveBeenCalledWith("/api/items/pod1/play/ep1", expect.anything());
    const s = w.playback.usePlaybackStore.getState();
    expect(s.currentSession.id).toBe("sess-ep");
    expect(s.currentSession.episodeId).toBe("ep1");
  });

  it("a live native track that is NOT a play:-tagged item is not adopted — falls back to the disk restore", async () => {
    let w = boot();
    w.storageHelper.setServerConfig({ address: "https://abs.example.com", token: "tok" });
    w.storageHelper.setLastPlaybackSession({
      ...serverSession(),
      currentTime: 250,
      updatedAt: BASE - 3_600_000,
    });

    w = boot();
    w.TrackPlayer.getPlaybackState.mockResolvedValue({ state: "playing" });
    w.TrackPlayer.getActiveTrack.mockResolvedValue({ mediaId: "sess1_ch0" }); // not ours to rebuild
    w.api.get.mockRejectedValue(new Error("offline"));

    await w.playback.usePlaybackStore.getState().loadLastSession();

    expect(w.api.post).not.toHaveBeenCalled(); // no /play adoption
    const s = w.playback.usePlaybackStore.getState();
    expect(s.currentSession.id).toBe("sess1"); // disk restore ran instead
    expect(s.position).toBe(250);
  });

  it("CORRUPT lastPlaybackSession JSON does not crash init — degrades to a clean no-session state", async () => {
    let w = boot();
    w.storageHelper.setServerConfig({ address: "https://abs.example.com", token: "tok" });
    w.storage.set("lastPlaybackSession", "{definitely not json!!!");

    w = boot();
    await expect(
      w.playback.usePlaybackStore.getState().loadLastSession()
    ).resolves.toBeUndefined();

    const s = w.playback.usePlaybackStore.getState();
    expect(s.currentSession).toBeNull();
    expect(s.isPlaying).toBe(false);
    // The player was never touched — no reset of whatever the native side holds.
    expect(w.TrackPlayer.reset).not.toHaveBeenCalled();
  });

  it("a persisted session MISSING its tracks degrades cleanly (no ghost session, no crash)", async () => {
    let w = boot();
    w.storageHelper.setServerConfig({ address: "https://abs.example.com", token: "tok" });
    w.storage.set(
      "lastPlaybackSession",
      JSON.stringify({ id: "sess-x", libraryItemId: "item1", currentTime: 50 }) // no audioTracks
    );

    w = boot();
    w.api.get.mockRejectedValue(new Error("offline"));
    await expect(
      w.playback.usePlaybackStore.getState().loadLastSession()
    ).resolves.toBeUndefined();

    const s = w.playback.usePlaybackStore.getState();
    expect(s.currentSession).toBeNull(); // prepare failed BEFORE any player mutation
    expect(s.isPlaying).toBe(false);
    expect(s.position).toBe(0);
  });

  it("truthy-garbage persisted blob (a bare JSON number) degrades cleanly", async () => {
    let w = boot();
    w.storageHelper.setServerConfig({ address: "https://abs.example.com", token: "tok" });
    w.storage.set("lastPlaybackSession", "42");

    w = boot();
    await expect(
      w.playback.usePlaybackStore.getState().loadLastSession()
    ).resolves.toBeUndefined();
    expect(w.playback.usePlaybackStore.getState().currentSession).toBeNull();
  });

  it("corrupt / malformed persisted queue rehydrates safely (bad JSON → empty; junk entries filtered)", () => {
    // Bad JSON → empty queue, store init does not throw.
    let w = boot();
    w.storage.set("playbackQueue", "[[[nope");
    w = boot();
    expect(w.playback.usePlaybackStore.getState().queue).toEqual([]);

    // Valid JSON, wrong shape → empty queue.
    w.storage.set("playbackQueue", JSON.stringify({ not: "an array" }));
    w = boot();
    expect(w.playback.usePlaybackStore.getState().queue).toEqual([]);

    // Mixed garbage → only well-formed entries survive.
    w.storage.set(
      "playbackQueue",
      JSON.stringify([{ libraryItemId: "good" }, { bogus: true }, null, 5, "str"])
    );
    w = boot();
    expect(w.playback.usePlaybackStore.getState().queue).toEqual([{ libraryItemId: "good" }]);
  });

  it("no persisted session at all → loadLastSession is a no-op (clean empty state)", async () => {
    let w = boot();
    w.storageHelper.setServerConfig({ address: "https://abs.example.com", token: "tok" });
    w = boot();
    await w.playback.usePlaybackStore.getState().loadLastSession();
    expect(w.playback.usePlaybackStore.getState().currentSession).toBeNull();
    expect(w.TrackPlayer.reset).not.toHaveBeenCalled();
  });
});
