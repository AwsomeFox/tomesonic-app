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
}));
jest.mock("../../utils/autoCreds", () => ({
  writeAutoCreds: jest.fn().mockResolvedValue(undefined),
  readAutoCreds: jest.fn().mockResolvedValue(null),
  writeAutoDownloads: jest.fn().mockResolvedValue(undefined),
  writeWidgetState: jest.fn().mockResolvedValue(undefined),
}));

import { DeviceEventEmitter } from "react-native";
import TrackPlayer, { State } from "react-native-track-player";
import { playbackService } from "../../store/playbackService";
import { usePlaybackStore } from "../../store/usePlaybackStore";
import { useUserStore } from "../../store/useUserStore";
import { storageHelper } from "../../utils/storage";

const initial = usePlaybackStore.getState();
const emit = (event: string, payload?: any) => (TrackPlayer as any).__emit(event, payload);
const flush = () => new Promise((r) => setImmediate(r));

const CH = [
  { id: 0, title: "Chapter 1", start: 0, end: 100 },
  { id: 1, title: "Chapter 2", start: 100, end: 200 },
  { id: 2, title: "Chapter 3", start: 200, end: 300 },
];

// Replace the store's action functions with spies — the service resolves them
// through getState() at event time, so routing is fully observable.
function spyActions() {
  const actions = {
    play: jest.fn().mockResolvedValue(undefined),
    pause: jest.fn().mockResolvedValue(undefined),
    closePlayback: jest.fn().mockResolvedValue(undefined),
    startPlayback: jest.fn().mockResolvedValue(true),
    seek: jest.fn().mockResolvedValue(undefined),
    seekForward: jest.fn().mockResolvedValue(undefined),
    seekBackward: jest.fn().mockResolvedValue(undefined),
    nextChapter: jest.fn().mockResolvedValue(undefined),
    previousChapter: jest.fn().mockResolvedValue(undefined),
    setPlaybackSpeed: jest.fn().mockResolvedValue(undefined),
    loadLastSession: jest.fn().mockResolvedValue(undefined),
  };
  // RemotePlay's headless-restore branch only runs when NO session is loaded;
  // these routing tests exercise the normal loaded-session path.
  usePlaybackStore.setState({ ...actions, currentSession: { id: "sess-loaded" } } as any);
  return actions;
}

function makeCastClient() {
  return {
    queueNext: jest.fn().mockResolvedValue(undefined),
    queuePrev: jest.fn().mockResolvedValue(undefined),
  };
}

// Register the remote handlers ONCE for the whole file — re-registering per
// test would stack duplicate listeners on the shared TrackPlayer mock.
beforeAll(async () => {
  await playbackService();
});

beforeEach(() => {
  usePlaybackStore.setState(initial, true);
  // Reset the configured jump increments between tests — they live in
  // useUserStore (not usePlaybackStore) and would otherwise leak across
  // describe blocks by run order, making the "falls back to default" tests
  // depend on whichever test set them last.
  useUserStore.setState({
    settings: { ...useUserStore.getState().settings, jumpForwardTime: undefined, jumpBackwardTime: undefined },
  } as any);
  // clearMocks resets calls but NOT implementations, so a mockResolvedValue set
  // by another test/file could leak in and make the tests that rely on the
  // default getActiveTrackIndex order-dependent — pin a deterministic default.
  jest.mocked(TrackPlayer.getActiveTrackIndex).mockResolvedValue(0);
});

describe("playbackService remote events", () => {
  describe("RemotePlay", () => {
    it("routes to store.play() (auto-rewind path) when not casting", async () => {
      const a = spyActions();
      emit("remote-play");
      await flush();
      expect(a.play).toHaveBeenCalledTimes(1);
      expect(a.pause).not.toHaveBeenCalled();
    });

    it("HEADLESS cold start: restores the last session, then plays", async () => {
      // Steering-wheel/BT play before App.tsx ever mounted: no session in the
      // store — the handler must loadLastSession() first (this used to be a
      // silent no-op in the car).
      const a = spyActions();
      usePlaybackStore.setState({ currentSession: null } as any);
      a.loadLastSession.mockImplementation(async () => {
        usePlaybackStore.setState({ currentSession: { id: "restored" } } as any);
      });
      emit("remote-play");
      await flush();
      expect(a.loadLastSession).toHaveBeenCalledTimes(1);
      expect(a.play).toHaveBeenCalledTimes(1);
    });

    it("HEADLESS cold start with nothing to restore stays a safe no-op", async () => {
      const a = spyActions();
      usePlaybackStore.setState({ currentSession: null } as any);
      emit("remote-play");
      await flush();
      expect(a.loadLastSession).toHaveBeenCalledTimes(1);
      expect(a.play).not.toHaveBeenCalled();
    });

    it("acts as a toggle while casting: playing → pause", async () => {
      const a = spyActions();
      usePlaybackStore.setState({ isCasting: true, isPlaying: true } as any);
      emit("remote-play");
      await flush();
      expect(a.pause).toHaveBeenCalledTimes(1);
      expect(a.play).not.toHaveBeenCalled();
    });

    it("acts as a toggle while casting: paused → play", async () => {
      const a = spyActions();
      usePlaybackStore.setState({ isCasting: true, isPlaying: false } as any);
      emit("remote-play");
      await flush();
      expect(a.play).toHaveBeenCalledTimes(1);
    });
  });

  describe("RemotePlayPause (the single toggle key — headset / AVRCP steering wheel)", () => {
    it("pauses a live PLAYING session", async () => {
      const a = spyActions();
      usePlaybackStore.setState({ isPlaying: true } as any);
      emit("remote-play-pause", {});
      await flush();
      expect(a.pause).toHaveBeenCalledTimes(1);
      expect(a.play).not.toHaveBeenCalled();
    });

    it("plays a live PAUSED session", async () => {
      const a = spyActions();
      usePlaybackStore.setState({ isPlaying: false } as any);
      emit("remote-play-pause", {});
      await flush();
      expect(a.play).toHaveBeenCalledTimes(1);
      expect(a.pause).not.toHaveBeenCalled();
    });

    it("HEADLESS cold start: restores the last session, then plays it", async () => {
      // BT toggle press before App.tsx ever mounted — no session loaded, so the
      // handler must loadLastSession() first (mirrors RemotePlay's restore).
      const a = spyActions();
      usePlaybackStore.setState({ currentSession: null, isPlaying: false } as any);
      a.loadLastSession.mockImplementation(async () => {
        usePlaybackStore.setState({ currentSession: { id: "restored" } } as any);
      });
      emit("remote-play-pause", {});
      await flush();
      expect(a.loadLastSession).toHaveBeenCalledTimes(1);
      expect(a.play).toHaveBeenCalledTimes(1);
      expect(a.pause).not.toHaveBeenCalled();
    });

    it("HEADLESS cold start with nothing to restore stays a safe no-op", async () => {
      const a = spyActions();
      usePlaybackStore.setState({ currentSession: null } as any);
      emit("remote-play-pause", {});
      await flush();
      expect(a.loadLastSession).toHaveBeenCalledTimes(1);
      expect(a.play).not.toHaveBeenCalled();
      expect(a.pause).not.toHaveBeenCalled();
    });
  });

  it("RemotePause routes to store.pause() (flushes the progress sync)", () => {
    const a = spyActions();
    emit("remote-pause");
    expect(a.pause).toHaveBeenCalledTimes(1);
  });

  it("RemoteStop closes playback (final sync + teardown)", () => {
    const a = spyActions();
    emit("remote-stop");
    expect(a.closePlayback).toHaveBeenCalledTimes(1);
  });

  describe("RemoteJumpForward / RemoteJumpBackward — configured increment", () => {
    const setJumps = (fwd: number, back: number) =>
      useUserStore.setState({
        settings: { ...useUserStore.getState().settings, jumpForwardTime: fwd, jumpBackwardTime: back },
      } as any);

    it("uses the event interval when the notification/on-screen button provides one", () => {
      const a = spyActions();
      setJumps(45, 20);
      emit("remote-jump-forward", { interval: 30 });
      expect(a.seekForward).toHaveBeenCalledWith(30);
    });

    it("falls back to the CONFIGURED increment for hardware/BT/steering-wheel keys (no interval)", () => {
      const a = spyActions();
      setJumps(45, 20);
      emit("remote-jump-forward", {});
      expect(a.seekForward).toHaveBeenCalledWith(45);
      emit("remote-jump-backward", {});
      expect(a.seekBackward).toHaveBeenCalledWith(20);
    });

    it("falls back to 10 only when neither an interval nor a configured value exists", () => {
      const a = spyActions();
      setJumps(0, 0);
      emit("remote-jump-forward", {});
      expect(a.seekForward).toHaveBeenCalledWith(10);
      emit("remote-jump-backward", {});
      expect(a.seekBackward).toHaveBeenCalledWith(10);
    });

    // CRASH REGRESSION: physical steering-wheel / car FF-RW keys deliver this
    // event with a NULL payload (the native onMediaKeyEvent path emitted it
    // bundle-less). Reading event.interval synchronously threw an uncaught
    // TypeError that was fatal and tore down the Android Auto playback service.
    // The handler must survive a null/undefined event and still fall back to the
    // configured increment.
    it("does NOT throw on a payload-less (null) event — hardware key crash guard", () => {
      const a = spyActions();
      setJumps(45, 20);
      expect(() => emit("remote-jump-forward", null)).not.toThrow();
      expect(a.seekForward).toHaveBeenCalledWith(45);
      expect(() => emit("remote-jump-backward", null)).not.toThrow();
      expect(a.seekBackward).toHaveBeenCalledWith(20);
    });

    it("does NOT throw on an undefined event either", () => {
      const a = spyActions();
      setJumps(45, 20);
      expect(() => emit("remote-jump-forward", undefined)).not.toThrow();
      expect(a.seekForward).toHaveBeenCalledWith(45);
      expect(() => emit("remote-jump-backward", undefined)).not.toThrow();
      expect(a.seekBackward).toHaveBeenCalledWith(20);
    });
  });

  describe("RemoteNext / RemotePrevious", () => {
    it("maps to chapter navigation when the book has chapters", () => {
      const a = spyActions();
      usePlaybackStore.setState({ chapters: CH } as any);
      emit("remote-next");
      emit("remote-previous");
      expect(a.nextChapter).toHaveBeenCalledTimes(1);
      expect(a.previousChapter).toHaveBeenCalledTimes(1);
      expect(TrackPlayer.skipToNext).not.toHaveBeenCalled();
      expect(TrackPlayer.skipToPrevious).not.toHaveBeenCalled();
    });

    it("chapterless while casting: skips the RECEIVER's queue, not the paused local player", () => {
      const a = spyActions();
      const client = makeCastClient();
      usePlaybackStore.setState({ chapters: [], isCasting: true, castClient: client } as any);

      emit("remote-next");
      expect(client.queueNext).toHaveBeenCalledTimes(1);
      expect(TrackPlayer.skipToNext).not.toHaveBeenCalled();
      expect(a.nextChapter).not.toHaveBeenCalled();

      emit("remote-previous");
      expect(client.queuePrev).toHaveBeenCalledTimes(1);
      expect(TrackPlayer.skipToPrevious).not.toHaveBeenCalled();
    });

    it("chapterless local playback falls back to TrackPlayer queue navigation", () => {
      spyActions();
      usePlaybackStore.setState({ chapters: [] } as any);
      emit("remote-next");
      emit("remote-previous");
      expect(TrackPlayer.skipToNext).toHaveBeenCalledTimes(1);
      expect(TrackPlayer.skipToPrevious).toHaveBeenCalledTimes(1);
    });

    it("a single chapter does not count as chapter navigation", () => {
      const a = spyActions();
      usePlaybackStore.setState({ chapters: [CH[0]] } as any);
      emit("remote-next");
      expect(a.nextChapter).not.toHaveBeenCalled();
      expect(TrackPlayer.skipToNext).toHaveBeenCalledTimes(1);
    });
  });

  describe("RemoteJump", () => {
    it("routes jumps through the store with the given interval", () => {
      const a = spyActions();
      emit("remote-jump-forward", { interval: 30 });
      emit("remote-jump-backward", { interval: 15 });
      expect(a.seekForward).toHaveBeenCalledWith(30);
      expect(a.seekBackward).toHaveBeenCalledWith(15);
    });

    it("defaults to 10s when the event has no interval", () => {
      const a = spyActions();
      emit("remote-jump-forward", {});
      emit("remote-jump-backward", {});
      expect(a.seekForward).toHaveBeenCalledWith(10);
      expect(a.seekBackward).toHaveBeenCalledWith(10);
    });
  });

  describe("RemoteSeek", () => {
    it("passes the position straight through without a chapter queue", async () => {
      const a = spyActions();
      usePlaybackStore.setState({ chapterQueue: false, chapters: [] } as any);
      emit("remote-seek", { position: 42 });
      await flush();
      expect(a.seek).toHaveBeenCalledWith(42);
    });

    it("maps the chapter-relative seekbar position to an absolute book position", async () => {
      const a = spyActions();
      usePlaybackStore.setState({ chapterQueue: true, chapters: CH } as any);
      jest.mocked(TrackPlayer.getActiveTrackIndex).mockResolvedValue(1);

      emit("remote-seek", { position: 30 }); // 30s into chapter 2
      await flush();
      expect(a.seek).toHaveBeenCalledWith(130);
    });

    it("while casting uses the receiver's chapter, not the stale local active index", async () => {
      const a = spyActions();
      usePlaybackStore.setState({
        chapterQueue: true,
        chapters: CH,
        isCasting: true,
        currentChapterIndex: 2,
      } as any);
      // Local player is parked on the handoff item — must not be consulted.
      jest.mocked(TrackPlayer.getActiveTrackIndex).mockResolvedValue(0);

      emit("remote-seek", { position: 10 });
      await flush();
      expect(a.seek).toHaveBeenCalledWith(210); // chapters[2].start + 10
      expect(TrackPlayer.getActiveTrackIndex).not.toHaveBeenCalled();
    });

    it("falls back to the store chapter index when the active index is unavailable", async () => {
      const a = spyActions();
      usePlaybackStore.setState({
        chapterQueue: true,
        chapters: CH,
        currentChapterIndex: 1,
      } as any);
      jest.mocked(TrackPlayer.getActiveTrackIndex).mockRejectedValue(new Error("not ready"));

      emit("remote-seek", { position: 5 });
      await flush();
      expect(a.seek).toHaveBeenCalledWith(105);
    });
  });

  describe("PlaybackState reconciliation (audio-focus loss in background)", () => {
    it("flips isPlaying false when the player reports paused", () => {
      spyActions();
      usePlaybackStore.setState({ isPlaying: true } as any);
      emit("playback-state", { state: State.Paused });
      expect(usePlaybackStore.getState().isPlaying).toBe(false);
    });

    it("flips isPlaying true when the player reports playing", () => {
      spyActions();
      usePlaybackStore.setState({ isPlaying: false } as any);
      emit("playback-state", { state: State.Playing });
      expect(usePlaybackStore.getState().isPlaying).toBe(true);
    });

    it("treats stopped/ended/error/none as not playing", () => {
      for (const s of [State.Stopped, State.Ended, State.Error, State.None]) {
        spyActions();
        usePlaybackStore.setState({ isPlaying: true } as any);
        emit("playback-state", { state: s });
        expect(usePlaybackStore.getState().isPlaying).toBe(false);
      }
    });

    it("leaves isPlaying untouched for transitional states", () => {
      for (const s of [State.Buffering, State.Loading, State.Ready]) {
        spyActions();
        usePlaybackStore.setState({ isPlaying: true } as any);
        emit("playback-state", { state: s });
        expect(usePlaybackStore.getState().isPlaying).toBe(true);
      }
    });

    it("is a no-op while casting (the receiver is the source of truth)", () => {
      spyActions();
      usePlaybackStore.setState({ isPlaying: true, isCasting: true } as any);
      emit("playback-state", { state: State.Paused });
      expect(usePlaybackStore.getState().isPlaying).toBe(true);
    });

    it("is a no-op with no session loaded", () => {
      usePlaybackStore.setState({ ...initial, isPlaying: true, currentSession: null } as any);
      emit("playback-state", { state: State.Paused });
      expect(usePlaybackStore.getState().isPlaying).toBe(true);
    });
  });

  describe("isBuffering (stall indicator)", () => {
    it("sets isBuffering true on Buffering / Loading", () => {
      for (const s of [State.Buffering, State.Loading]) {
        spyActions();
        usePlaybackStore.setState({ isBuffering: false } as any);
        emit("playback-state", { state: s });
        expect(usePlaybackStore.getState().isBuffering).toBe(true);
      }
    });

    it("clears isBuffering once the player reports a settled state", () => {
      for (const s of [State.Playing, State.Paused, State.Ready, State.Stopped, State.Ended]) {
        spyActions();
        usePlaybackStore.setState({ isBuffering: true } as any);
        emit("playback-state", { state: s });
        expect(usePlaybackStore.getState().isBuffering).toBe(false);
      }
    });

    it("does not touch isBuffering while casting (no session-local player)", () => {
      spyActions();
      usePlaybackStore.setState({ isBuffering: false, isCasting: true } as any);
      emit("playback-state", { state: State.Buffering });
      expect(usePlaybackStore.getState().isBuffering).toBe(false);
    });

    it("entering a cast session clears a stuck isBuffering (the state listener can no longer)", () => {
      // If a local stream is buffering when Cast starts, the PlaybackState
      // listener early-returns during casting and can never clear isBuffering —
      // the spinner would pin over the transport for the whole session.
      usePlaybackStore.setState({ isBuffering: true, isCasting: false } as any);
      usePlaybackStore.getState().setCastState({ id: "receiver" } as any);
      expect(usePlaybackStore.getState().isCasting).toBe(true);
      expect(usePlaybackStore.getState().isBuffering).toBe(false);
    });
  });

  describe("RemotePlayId (Android Auto browse / bookmarks)", () => {
    it("starts playback for a plain item id", async () => {
      const a = spyActions();
      emit("remote-play-id", { id: "item1" });
      await flush();
      expect(a.startPlayback).toHaveBeenCalledWith("item1", undefined);
      expect(a.seek).not.toHaveBeenCalled();
    });

    it("splits podcast ids into item + episode", async () => {
      const a = spyActions();
      emit("remote-play-id", { id: "pod1::ep1" });
      await flush();
      expect(a.startPlayback).toHaveBeenCalledWith("pod1", "ep1");
    });

    it("a @@seconds bookmark suffix seeks after a successful start", async () => {
      const a = spyActions();
      emit("remote-play-id", { id: "item1@@120" });
      await flush();
      expect(a.startPlayback).toHaveBeenCalledWith("item1", undefined);
      expect(a.seek).toHaveBeenCalledWith(120);
    });

    it("does not seek when startPlayback failed", async () => {
      const a = spyActions();
      a.startPlayback.mockResolvedValue(false);
      emit("remote-play-id", { id: "item1@@120" });
      await flush();
      expect(a.seek).not.toHaveBeenCalled();
    });

    it("adopts a native cold-start handoff (fractional absolute seconds)", async () => {
      // The RNTP patch hands a JS-dead Android Auto session off to JS on
      // setupPlayer via this same channel: id = "<itemId>[::episodeId]@@<absSec>"
      // carrying the LIVE fakePlayer position (fractional). Adopting it starts
      // the correct book and seeks to that position instead of a stale disk save.
      const a = spyActions();
      emit("remote-play-id", { id: "pod1::ep1@@1234.5" });
      await flush();
      expect(a.startPlayback).toHaveBeenCalledWith("pod1", "ep1");
      expect(a.seek).toHaveBeenCalledWith(1234.5);
    });

    it("ignores empty and zero-time bookmark payloads", async () => {
      const a = spyActions();
      emit("remote-play-id", { id: "" });
      await flush();
      expect(a.startPlayback).not.toHaveBeenCalled();

      emit("remote-play-id", { id: "item1@@0" });
      await flush();
      expect(a.startPlayback).toHaveBeenCalledWith("item1", undefined);
      expect(a.seek).not.toHaveBeenCalled();
    });

    it("a PAUSED handoff starts the session then pauses (does not auto-resume)", async () => {
      // setupPlayer adopting a car session the user PAUSED: the native side
      // tags the payload paused=true so we build the real JS session but never
      // auto-resume the audio the user had stopped.
      const a = spyActions();
      emit("remote-play-id", { id: "item1", paused: true });
      await flush();
      expect(a.startPlayback).toHaveBeenCalledWith("item1", undefined);
      expect(a.pause).toHaveBeenCalledTimes(1);
    });

    it("a PAUSED handoff still seeks to the handoff position before pausing", async () => {
      const a = spyActions();
      emit("remote-play-id", { id: "pod1::ep1@@1234.5", paused: true });
      await flush();
      expect(a.startPlayback).toHaveBeenCalledWith("pod1", "ep1");
      expect(a.seek).toHaveBeenCalledWith(1234.5);
      expect(a.pause).toHaveBeenCalledTimes(1);
    });

    it("a PLAYING handoff (no paused flag) is left playing", async () => {
      const a = spyActions();
      emit("remote-play-id", { id: "item1@@100", paused: false });
      await flush();
      expect(a.startPlayback).toHaveBeenCalledWith("item1", undefined);
      expect(a.seek).toHaveBeenCalledWith(100);
      expect(a.pause).not.toHaveBeenCalled();
    });

    it("does not pause when a paused handoff's startPlayback failed", async () => {
      const a = spyActions();
      a.startPlayback.mockResolvedValue(false);
      emit("remote-play-id", { id: "item1", paused: true });
      await flush();
      expect(a.pause).not.toHaveBeenCalled();
    });
  });

  describe("headless progress seed (Android Auto cold start)", () => {
    // The seed block runs on EVERY playbackService() call, before the
    // _serviceWired guard — so re-invoking the (already wired) service here
    // exercises exactly the headless-boot path without stacking listeners.
    const cached = {
      book1: { currentTime: 123.4, isFinished: false },
      book2: { currentTime: 45, isFinished: true },
    };

    afterEach(() => {
      // Restore the pristine never-initialized user store and wipe the disk
      // cache so these tests can't leak into each other (the useUserStore
      // write-through mirror persists mediaProgress on every setState).
      useUserStore.setState({ isInitialized: false, mediaProgress: {} });
      storageHelper.removeMediaProgressCache();
    });

    it("seeds mediaProgress from the disk cache when the store never initialized", async () => {
      useUserStore.setState({ isInitialized: false, mediaProgress: {} });
      storageHelper.setMediaProgressCache(cached);

      await playbackService();

      expect(useUserStore.getState().mediaProgress).toEqual(cached);
    });

    it("does NOT overwrite an already-initialized store", async () => {
      useUserStore.setState({ isInitialized: true, mediaProgress: {} });
      storageHelper.setMediaProgressCache(cached);

      await playbackService();

      expect(useUserStore.getState().mediaProgress).toEqual({});
    });

    it("does NOT clobber an in-memory map that already has entries", async () => {
      const live = { book9: { currentTime: 999 } };
      useUserStore.setState({ isInitialized: false, mediaProgress: live });
      storageHelper.setMediaProgressCache(cached);

      await playbackService();

      expect(useUserStore.getState().mediaProgress).toEqual(live);
    });

    it("leaves the map empty when the disk cache is empty too", async () => {
      useUserStore.setState({ isInitialized: false, mediaProgress: {} });
      storageHelper.removeMediaProgressCache();

      await playbackService();

      expect(useUserStore.getState().mediaProgress).toEqual({});
    });
  });

  describe("remote-playback-speed (Android Auto custom button)", () => {
    it("cycles to the next speed in the set", () => {
      const a = spyActions();
      usePlaybackStore.setState({ playbackSpeed: 1.0 } as any);
      DeviceEventEmitter.emit("remote-playback-speed");
      expect(a.setPlaybackSpeed).toHaveBeenCalledWith(1.2);
    });

    it("wraps around after the top speed", () => {
      const a = spyActions();
      usePlaybackStore.setState({ playbackSpeed: 3.0 } as any);
      DeviceEventEmitter.emit("remote-playback-speed");
      expect(a.setPlaybackSpeed).toHaveBeenCalledWith(0.8);
    });
  });
});
