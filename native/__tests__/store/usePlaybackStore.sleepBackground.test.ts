/**
 * SLEEP TIMER × BACKGROUND — the scenarios behind "the sleep timer / end of
 * chapter timer doesn't work".
 *
 * With the screen off, Android stalls React Native's JS timers (they ride
 * frame callbacks), so the store's 1s sleep interval does NOT tick: the
 * Media3 service's native enforcer is the only thing that pauses a pocketed
 * phone. Native → JS events (remote controls, abs-sleep-*) still arrive.
 * Every test here therefore advances NO JS timers unless it says so, and
 * judges what JS handed the native enforcer — the target that will actually
 * fire with the screen off.
 *
 * The native side's arithmetic (position target → pause) is pinned on the
 * JVM in android/.../MusicServiceSleepTargetTest.kt; this file pins the JS
 * half of the contract.
 */
jest.mock("../../utils/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock("../../utils/progressSync", () => ({
  syncProgress: jest.fn().mockResolvedValue(undefined),
  closeSession: jest.fn().mockResolvedValue(undefined),
  queueProgressPatch: jest.fn(),
  queueFinishedPatch: jest.fn(),
  queueEbookProgressPatch: jest.fn(),
  flushPendingSyncs: jest.fn().mockResolvedValue(undefined),
  clearAllPending: jest.fn(),
  hasPendingWritesFor: jest.fn().mockReturnValue(false),
}));
jest.mock("../../utils/autoCreds", () => ({
  writeAutoCreds: jest.fn().mockResolvedValue(undefined),
  readAutoCreds: jest.fn().mockResolvedValue(null),
  writeAutoDownloads: jest.fn().mockResolvedValue(undefined),
  writeWidgetState: jest.fn().mockResolvedValue(undefined),
  writeAutoChapters: jest.fn().mockResolvedValue(undefined),
}));

import { DeviceEventEmitter, NativeModules, Platform } from "react-native";
import TrackPlayer, { State } from "react-native-track-player";
import {
  usePlaybackStore,
  nativeSleepTargetFor,
  onPlaybackError,
  recoverPlaybackIfNeeded,
  reconcileNativeSleepTimer,
} from "../../store/usePlaybackStore";
import { playbackService } from "../../store/playbackService";
import { useUserStore } from "../../store/useUserStore";
import { useDownloadStore } from "../../store/useDownloadStore";
import { storage, storageHelper, secureStorage } from "../../utils/storage";

const initialPlayback = usePlaybackStore.getState();
const initialUser = useUserStore.getState();
const initialDownloads = useDownloadStore.getState();
const origOS = Platform.OS;
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

// 3 × 100s chapters in ONE file.
const CH = [
  { id: 0, title: "Chapter 1", start: 0, end: 100 },
  { id: 1, title: "Chapter 2", start: 100, end: 200 },
  { id: 2, title: "Chapter 3", start: 200, end: 300 },
];

type NativeFake = {
  absSetSleepTimer: jest.Mock;
  absSetSleepTimerAt: jest.Mock;
  absCancelSleepTimer: jest.Mock;
  absGetSleepTimerRemaining: jest.Mock;
  absSetChapterWindows?: jest.Mock;
};

// The patched MusicModule as the installed binary exposes it. `windows`
// selects the queue shape single-file chaptered books prepare with: native
// chapter windows → ONE flat item; without → one clipped item per chapter.
function injectNative(opts: { windows?: boolean; remaining?: number } = {}): NativeFake {
  (Platform as any).OS = "android";
  const fake: NativeFake = {
    absSetSleepTimer: jest.fn().mockResolvedValue(undefined),
    absSetSleepTimerAt: jest.fn().mockResolvedValue(undefined),
    absCancelSleepTimer: jest.fn().mockResolvedValue(undefined),
    absGetSleepTimerRemaining: jest.fn().mockResolvedValue(opts.remaining ?? -1),
  };
  if (opts.windows) fake.absSetChapterWindows = jest.fn().mockResolvedValue(undefined);
  (NativeModules as any).TrackPlayer = fake;
  return fake;
}

function liveSession(over: Record<string, any> = {}) {
  usePlaybackStore.setState({
    isInitialized: true,
    currentSession: { id: "sess1", libraryItemId: "item1" },
    isPlaying: true,
    duration: 300,
    position: 10,
    chapters: CH,
    currentChapterIndex: 0,
    chapterQueue: false,
    playbackSpeed: 1,
    ...over,
  } as any);
}

function serverSession(over: Record<string, any> = {}) {
  return {
    id: "sess1",
    libraryItemId: "item1",
    displayTitle: "The Hobbit",
    displayAuthor: "Tolkien",
    duration: 300,
    currentTime: 10,
    chapters: CH,
    audioTracks: [
      { index: 0, contentUrl: "/api/items/item1/file/0", duration: 300, startOffset: 0 },
    ],
    ...over,
  };
}

const lastAt = (fake: NativeFake) => fake.absSetSleepTimerAt.mock.calls.at(-1);

beforeAll(async () => {
  // Wire the remote-control + abs-sleep-* listeners once (module guard).
  await playbackService();
});

beforeEach(() => {
  jest.useFakeTimers();
  usePlaybackStore.setState(initialPlayback, true);
  useUserStore.setState(initialUser, true);
  useDownloadStore.setState(initialDownloads, true);
  useDownloadStore.setState({ activeDownloads: {}, completedDownloads: {} });
  storage.getAllKeys().forEach((k) => storage.remove(k));
  secureStorage.getAllKeys().forEach((k) => secureStorage.remove(k));
  storageHelper.setServerConfig({ address: "https://abs.example.com", token: "tok" });
  jest.mocked(TrackPlayer.getPlaybackState).mockResolvedValue({ state: State.Playing } as any);
  jest.mocked(TrackPlayer.getActiveTrackIndex).mockResolvedValue(0);
  jest.mocked(TrackPlayer.getActiveTrack).mockResolvedValue({} as any);
  jest
    .mocked(TrackPlayer.getProgress)
    .mockResolvedValue({ position: 10, duration: 300, buffered: 0 } as any);
});

afterEach(() => {
  usePlaybackStore.getState().cancelSleepTimer();
  delete (NativeModules as any).TrackPlayer;
  (Platform as any).OS = origOS;
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
describe("nativeSleepTargetFor — absolute book seconds → (queue item, ms in item)", () => {
  it("flat single file: the absolute position IS the item position", () => {
    expect(
      nativeSleepTargetFor(200, { chapterQueue: false, chapters: CH, trackOffsets: [0] })
    ).toEqual({ index: 0, positionMs: 200000 });
  });

  it("chapter-clipped queue: a chapter end is the END of that chapter's clip, not 0ms into the next", () => {
    expect(
      nativeSleepTargetFor(200, { chapterQueue: true, chapters: CH, trackOffsets: [] })
    ).toEqual({ index: 1, positionMs: 100000 });
  });

  it("multi-file: maps into the owning file; a file-boundary end stays in the earlier file", () => {
    const trackOffsets = [0, 150];
    // Chapter end inside file 2.
    expect(nativeSleepTargetFor(200, { chapterQueue: false, chapters: CH, trackOffsets })).toEqual({
      index: 1,
      positionMs: 50000,
    });
    // Chapter end exactly at the file boundary → end of file 1 (the player
    // only enters file 2 after the boundary has passed).
    expect(nativeSleepTargetFor(150, { chapterQueue: false, chapters: CH, trackOffsets })).toEqual({
      index: 0,
      positionMs: 150000,
    });
  });

  it("rejects non-finite / negative targets", () => {
    const shape = { chapterQueue: false, chapters: CH, trackOffsets: [0] };
    expect(nativeSleepTargetFor(NaN, shape)).toBeNull();
    expect(nativeSleepTargetFor(-1, shape)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("end of chapter, screen off: native owns the pause at the chapter END POSITION", () => {
  it("arms a position target (not a wall-clock guess) — skip silence / speed can't drift it", () => {
    const fake = injectNative();
    liveSession({ position: 10, playbackSpeed: 1.5 });
    usePlaybackStore.getState().setSleepTimer(0, true);

    // The display countdown stays book-seconds…
    expect(usePlaybackStore.getState().sleepTimer).toMatchObject({
      endOfChapter: true,
      chapterIdx: 0,
      remaining: 90,
    });
    // …but native gets the chapter END as a player position. The old arm was
    // `absSetSleepTimer(90 / 1.5)` — a wall-clock deadline that skip silence
    // (position outruns the clock) pushed into the next chapter.
    expect(fake.absSetSleepTimerAt).toHaveBeenCalledTimes(1);
    expect(lastAt(fake)).toEqual([0, 100000, 20, 300]);
    expect(fake.absSetSleepTimer).not.toHaveBeenCalled();
  });

  it("chapter-clipped queue targets the chapter's own clip", () => {
    const fake = injectNative();
    liveSession({ chapterQueue: true, position: 150, currentChapterIndex: 1 });
    usePlaybackStore.getState().setSleepTimer(0, true);
    expect(lastAt(fake)).toEqual([1, 100000, 20, 300]);
  });

  it("a speed change with the screen off needs no JS at all (target is speed-independent)", async () => {
    const fake = injectNative();
    liveSession({ position: 10 });
    usePlaybackStore.getState().setSleepTimer(0, true);
    const armsBefore = fake.absSetSleepTimerAt.mock.calls.length;
    await usePlaybackStore.getState().setPlaybackSpeed(2);
    // Nothing to re-arm: native divides by the player's live speed itself.
    expect(fake.absSetSleepTimerAt.mock.calls.length).toBe(armsBefore);
    expect(fake.absSetSleepTimer).not.toHaveBeenCalled();
  });

  it("headset/notification NEXT (chapter skip) re-targets native BEFORE the player moves", async () => {
    const fake = injectNative();
    liveSession({ chapterQueue: true, position: 50 });
    usePlaybackStore.getState().setSleepTimer(0, true);
    fake.absSetSleepTimerAt.mockClear();

    // JS interval stalled (no timers advanced) — only the remote event runs.
    (TrackPlayer as any).__emit("remote-next");
    await flush();

    expect(usePlaybackStore.getState().sleepTimer).toMatchObject({ chapterIdx: 1, remaining: 100 });
    expect(lastAt(fake)).toEqual([1, 100000, 20, 300]);
    // Ordering is the whole point: a target left at chapter 1's end would see
    // the player in chapter 2 and pause right after the skip.
    expect(fake.absSetSleepTimerAt.mock.invocationCallOrder[0]).toBeLessThan(
      jest.mocked(TrackPlayer.skip).mock.invocationCallOrder[0]
    );
  });

  it("notification jump-forward across a boundary re-targets the destination chapter", async () => {
    const fake = injectNative();
    jest.mocked(TrackPlayer.getProgress).mockResolvedValue({ position: 95, duration: 300 } as any);
    liveSession({ position: 95 });
    usePlaybackStore.getState().setSleepTimer(0, true);
    fake.absSetSleepTimerAt.mockClear();

    (TrackPlayer as any).__emit("remote-jump-forward", { interval: 30 });
    await flush();

    expect(usePlaybackStore.getState().sleepTimer).toMatchObject({ chapterIdx: 1, remaining: 75 });
    expect(lastAt(fake)).toEqual([0, 200000, 20, 300]);
    expect(fake.absSetSleepTimerAt.mock.invocationCallOrder[0]).toBeLessThan(
      jest.mocked(TrackPlayer.seekTo).mock.invocationCallOrder.at(-1)!
    );
  });

  it("the native pause, delivered as an event while JS is stalled, clears the timer and arms rewind-on-wake", async () => {
    injectNative();
    liveSession();
    usePlaybackStore.getState().setSleepTimer(0, true);
    DeviceEventEmitter.emit("abs-sleep-fired");
    expect(usePlaybackStore.getState().sleepTimer).toBeNull();
  });

  it("a native shake-extend turns the chapter timer into a fixed one", () => {
    injectNative();
    liveSession();
    usePlaybackStore.getState().setSleepTimer(0, true, 2);
    DeviceEventEmitter.emit("abs-sleep-extended", { remaining: 412.4 });
    expect(usePlaybackStore.getState().sleepTimer).toEqual({
      endOfChapter: false,
      remaining: 412,
      chapterIdx: undefined,
    });
  });

  it("binaries without the position mode keep the wall-clock fallback (book-seconds / rate)", () => {
    const fake = injectNative();
    delete (fake as any).absSetSleepTimerAt;
    liveSession({ position: 10, playbackSpeed: 1.5 });
    usePlaybackStore.getState().setSleepTimer(0, true);
    expect(fake.absSetSleepTimer.mock.calls[0][0]).toBeCloseTo(60, 5);
  });
});

// ---------------------------------------------------------------------------
describe("stop after chapter N", () => {
  it("arms against the PICKED chapter's end", () => {
    const fake = injectNative();
    liveSession({ position: 10 });
    usePlaybackStore.getState().setSleepTimer(0, true, 2);
    expect(usePlaybackStore.getState().sleepTimer).toEqual({
      endOfChapter: true,
      untilChapter: true,
      chapterIdx: 2,
      remaining: 290,
    });
    expect(lastAt(fake)).toEqual([0, 300000, 20, 300]);
  });

  it("ignores a chapter that is already behind the listener, or doesn't exist", () => {
    injectNative();
    liveSession({ position: 150, currentChapterIndex: 1 });
    usePlaybackStore.getState().setSleepTimer(0, true, 0);
    expect(usePlaybackStore.getState().sleepTimer).toBeNull();
    usePlaybackStore.getState().setSleepTimer(0, true, 7);
    expect(usePlaybackStore.getState().sleepTimer).toBeNull();
  });

  it("playing THROUGH an earlier chapter boundary doesn't fire (JS tick, foreground)", async () => {
    injectNative();
    liveSession({ position: 10 });
    usePlaybackStore.getState().setSleepTimer(0, true, 2);
    // Now in chapter 2 — a plain end-of-chapter timer armed in chapter 1
    // would fire here.
    jest.mocked(TrackPlayer.getProgress).mockResolvedValue({ position: 120, duration: 300 } as any);
    await jest.advanceTimersByTimeAsync(1000);
    expect(TrackPlayer.pause).not.toHaveBeenCalled();
    expect(usePlaybackStore.getState().sleepTimer).toMatchObject({
      untilChapter: true,
      chapterIdx: 2,
      remaining: 180,
    });
  });

  it("fires once the picked chapter has played out", async () => {
    injectNative();
    liveSession({ position: 10 });
    usePlaybackStore.getState().setSleepTimer(0, true, 2);
    jest.mocked(TrackPlayer.getProgress).mockResolvedValue({ position: 300, duration: 300 } as any);
    await jest.advanceTimersByTimeAsync(1000);
    expect(TrackPlayer.pause).toHaveBeenCalled();
    expect(usePlaybackStore.getState().sleepTimer).toBeNull();
  });

  it("seeking around BEFORE the target keeps it; jumping PAST it falls back to end of that chapter", async () => {
    const fake = injectNative();
    liveSession({ position: 10 });
    usePlaybackStore.getState().setSleepTimer(0, true, 1);
    fake.absSetSleepTimerAt.mockClear();

    await usePlaybackStore.getState().seek(150); // inside the target chapter
    expect(usePlaybackStore.getState().sleepTimer).toMatchObject({ untilChapter: true, chapterIdx: 1 });
    expect(fake.absSetSleepTimerAt).not.toHaveBeenCalled();

    await usePlaybackStore.getState().seek(250); // past it
    expect(usePlaybackStore.getState().sleepTimer).toEqual({
      endOfChapter: true,
      chapterIdx: 2,
      remaining: 50,
    });
    expect(lastAt(fake)).toEqual([0, 300000, 20, 300]);
    // Never an instant pause after a deliberate skip.
    expect(TrackPlayer.pause).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe("same-book re-prepare (stream recovery) keeps the timer", () => {
  it("token-rotation recovery rebuilds the queue WITHOUT cancelling the sleep timer, and re-arms native", async () => {
    const fake = injectNative({ windows: true });
    await usePlaybackStore.getState().preparePlaybackSession(serverSession(), true);
    usePlaybackStore.getState().setSleepTimer(0, true);
    expect(lastAt(fake)).toEqual([0, 100000, 20, 300]);
    fake.absSetSleepTimerAt.mockClear();
    fake.absCancelSleepTimer.mockClear();

    // Overnight: the access token rotated (hourly on ABS ≥ 2.26), then the
    // stream dropped. Recovery must rebuild the queue with fresh-token URLs…
    storageHelper.setServerConfig({ address: "https://abs.example.com", token: "tok2" });
    jest.mocked(TrackPlayer.getPlaybackState).mockResolvedValue({ state: State.Error } as any);
    onPlaybackError({ code: "network", message: "dropped" });
    await recoverPlaybackIfNeeded("connectivity");

    expect(TrackPlayer.reset).toHaveBeenCalled();
    // …and the listener's timer must survive it (it used to be cancelled here,
    // so "recovered" playback ran all night).
    expect(usePlaybackStore.getState().sleepTimer).toMatchObject({ endOfChapter: true, chapterIdx: 0 });
    expect(fake.absCancelSleepTimer).not.toHaveBeenCalled();
    expect(lastAt(fake)).toEqual([0, 100000, 20, 300]);
  });

  it("re-arms against the REBUILT queue shape (chapter clips here)", async () => {
    const fake = injectNative(); // no chapter windows → clipped queue
    await usePlaybackStore.getState().preparePlaybackSession(serverSession({ currentTime: 150 }), true);
    expect(usePlaybackStore.getState().chapterQueue).toBe(true);
    usePlaybackStore.getState().setSleepTimer(0, true, 2);
    fake.absSetSleepTimerAt.mockClear();

    await usePlaybackStore
      .getState()
      .preparePlaybackSession(serverSession({ id: "sess2", currentTime: 150 }), true);
    expect(usePlaybackStore.getState().sleepTimer).toMatchObject({ untilChapter: true, chapterIdx: 2 });
    expect(lastAt(fake)).toEqual([2, 100000, 20, 300]);
  });

  it("a DIFFERENT book still cancels the timer", async () => {
    const fake = injectNative({ windows: true });
    await usePlaybackStore.getState().preparePlaybackSession(serverSession(), true);
    usePlaybackStore.getState().setSleepTimer(600);
    await usePlaybackStore
      .getState()
      .preparePlaybackSession(serverSession({ id: "sessB", libraryItemId: "item2" }), true);
    expect(usePlaybackStore.getState().sleepTimer).toBeNull();
    expect(fake.absCancelSleepTimer).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe("resume / foreground reconciliation with the native enforcer", () => {
  it("re-arms native when it lost the timer (service rebuilt while paused)", async () => {
    const fake = injectNative({ remaining: -1 });
    liveSession({ isPlaying: false });
    usePlaybackStore.getState().setSleepTimer(1800);
    fake.absSetSleepTimer.mockClear();

    await reconcileNativeSleepTimer();
    expect(fake.absSetSleepTimer).toHaveBeenCalledWith(1800, 20, 300);
  });

  it("adopts native's lower countdown for a fixed timer (JS ticks stalled in the background)", async () => {
    const fake = injectNative({ remaining: 600.4 });
    liveSession();
    usePlaybackStore.getState().setSleepTimer(1800);
    fake.absSetSleepTimer.mockClear();

    await reconcileNativeSleepTimer();
    expect(usePlaybackStore.getState().sleepTimer?.remaining).toBe(600);
    expect(fake.absSetSleepTimer).not.toHaveBeenCalled();
  });

  it("leaves a live native chapter target alone", async () => {
    const fake = injectNative({ remaining: 42 });
    liveSession();
    usePlaybackStore.getState().setSleepTimer(0, true);
    fake.absSetSleepTimerAt.mockClear();
    await reconcileNativeSleepTimer();
    expect(fake.absSetSleepTimerAt).not.toHaveBeenCalled();
    expect(usePlaybackStore.getState().sleepTimer?.remaining).toBe(90);
  });

  it("play() runs the reconciliation", async () => {
    const fake = injectNative({ remaining: -1 });
    liveSession({ isPlaying: false });
    usePlaybackStore.getState().setSleepTimer(0, true);
    fake.absSetSleepTimerAt.mockClear();
    await usePlaybackStore.getState().play();
    await flush();
    expect(fake.absGetSleepTimerRemaining).toHaveBeenCalled();
    expect(lastAt(fake)).toEqual([0, 100000, 20, 300]);
  });

  it("while casting the receiver owns playback — no native re-arm", async () => {
    const fake = injectNative({ remaining: -1 });
    liveSession({ isCasting: true });
    usePlaybackStore.getState().setSleepTimer(1800);
    await reconcileNativeSleepTimer();
    expect(fake.absSetSleepTimer).not.toHaveBeenCalled();
    expect(fake.absGetSleepTimerRemaining).not.toHaveBeenCalled();
  });
});
