/**
 * reconcileWithNativePlayer — adopt a session the NATIVE player is already
 * driving when JS has none (Android Auto cold start), or un-stick a known
 * session whose isPlaying was left false while the native player plays. This is
 * what keeps the main player's progress bars from sitting frozen at the pre-AA
 * position after playback was started from the car and the app is then opened.
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
}));
jest.mock("../../utils/autoCreds", () => ({
  writeAutoCreds: jest.fn().mockResolvedValue(undefined),
  readAutoCreds: jest.fn().mockResolvedValue(null),
  writeAutoDownloads: jest.fn().mockResolvedValue(undefined),
  writeWidgetState: jest.fn().mockResolvedValue(undefined),
}));

import TrackPlayer, { State } from "react-native-track-player";
import { usePlaybackStore, reconcileWithNativePlayer } from "../../store/usePlaybackStore";
import { storage, storageHelper, secureStorage } from "../../utils/storage";

const initialPlayback = usePlaybackStore.getState();
const mockState = jest.mocked(TrackPlayer.getPlaybackState);
const mockActive = jest.mocked(TrackPlayer.getActiveTrack);

describe("reconcileWithNativePlayer", () => {
  let startSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    usePlaybackStore.setState(initialPlayback, true);
    storage.getAllKeys().forEach((k) => storage.remove(k));
    secureStorage.getAllKeys().forEach((k) => secureStorage.remove(k));
    storageHelper.setServerConfig({ address: "https://abs.example.com/", token: "tok" });
    mockState.mockResolvedValue({ state: State.Paused } as any);
    mockActive.mockResolvedValue(null as any);
    // Stub the heavy queue rebuild — we only assert reconcile ROUTES to it.
    startSpy = jest
      .spyOn(usePlaybackStore.getState(), "startPlayback")
      .mockResolvedValue(true);
    usePlaybackStore.setState({ startPlayback: startSpy as any });
  });

  afterEach(() => {
    jest.useRealTimers();
    startSpy.mockRestore();
  });

  it("adopts an Android-Auto-originated native item when JS has no session", async () => {
    usePlaybackStore.setState({ currentSession: null } as any);
    mockState.mockResolvedValue({ state: State.Playing } as any);
    mockActive.mockResolvedValue({ mediaId: "play:item42" } as any);

    const adopted = await reconcileWithNativePlayer();

    expect(adopted).toBe(true);
    expect(startSpy).toHaveBeenCalledWith("item42", undefined);
  });

  it("parses the episode id out of a podcast play: mediaId", async () => {
    usePlaybackStore.setState({ currentSession: null } as any);
    mockState.mockResolvedValue({ state: State.Playing } as any);
    mockActive.mockResolvedValue({ mediaId: "play:pod1::ep7" } as any);

    await reconcileWithNativePlayer();

    expect(startSpy).toHaveBeenCalledWith("pod1", "ep7");
  });

  it("strips a bookmark @@ suffix before resolving the item id", async () => {
    usePlaybackStore.setState({ currentSession: null } as any);
    mockState.mockResolvedValue({ state: State.Playing } as any);
    mockActive.mockResolvedValue({ mediaId: "play:item9@@123.5" } as any);

    await reconcileWithNativePlayer();

    expect(startSpy).toHaveBeenCalledWith("item9", undefined);
  });

  it("does NOT adopt (autoplay) when the native player is paused/idle", async () => {
    // Foregrounding the app with a PAUSED Android Auto session must not start
    // playback — startPlayback always autoplays, so adoption is gated on
    // active playback; paused falls through to the disk restore.
    usePlaybackStore.setState({ currentSession: null } as any);
    mockState.mockResolvedValue({ state: State.Paused } as any);
    mockActive.mockResolvedValue({ mediaId: "play:item42" } as any);

    const adopted = await reconcileWithNativePlayer();

    expect(adopted).toBe(false);
    expect(startSpy).not.toHaveBeenCalled();
  });

  it("does NOT adopt a non-Android-Auto queue (no play: mediaId)", async () => {
    usePlaybackStore.setState({ currentSession: null } as any);
    mockActive.mockResolvedValue({ mediaId: "https://abs.example.com/stream.mp3" } as any);

    const adopted = await reconcileWithNativePlayer();

    expect(adopted).toBe(false);
    expect(startSpy).not.toHaveBeenCalled();
  });

  it("no-ops when there is no active native track (queue torn down on setup)", async () => {
    usePlaybackStore.setState({ currentSession: null } as any);
    mockActive.mockResolvedValue(null as any);

    expect(await reconcileWithNativePlayer()).toBe(false);
    expect(startSpy).not.toHaveBeenCalled();
  });

  it("flips a stuck isPlaying=false so the poll resumes advancing the bars", async () => {
    usePlaybackStore.setState({
      currentSession: { id: "s", libraryItemId: "item1" },
      isPlaying: false,
    } as any);
    mockState.mockResolvedValue({ state: State.Playing } as any);

    const adopted = await reconcileWithNativePlayer();

    // Not a new adoption, but the known session is un-stuck.
    expect(adopted).toBe(false);
    expect(usePlaybackStore.getState().isPlaying).toBe(true);
    // A known session is never rebuilt from scratch.
    expect(startSpy).not.toHaveBeenCalled();
  });

  it("leaves a known, already-playing session untouched", async () => {
    usePlaybackStore.setState({
      currentSession: { id: "s", libraryItemId: "item1" },
      isPlaying: true,
    } as any);
    mockState.mockResolvedValue({ state: State.Playing } as any);

    await reconcileWithNativePlayer();

    expect(usePlaybackStore.getState().isPlaying).toBe(true);
    expect(startSpy).not.toHaveBeenCalled();
  });

  it("does nothing while casting (the receiver is the source of truth)", async () => {
    usePlaybackStore.setState({ currentSession: null, isCasting: true } as any);
    mockState.mockResolvedValue({ state: State.Playing } as any);
    mockActive.mockResolvedValue({ mediaId: "play:item42" } as any);

    expect(await reconcileWithNativePlayer()).toBe(false);
    expect(startSpy).not.toHaveBeenCalled();
  });

  it("loadLastSession adopts the live native session instead of restoring the disk save", async () => {
    // A stale disk save exists for a DIFFERENT (pre-AA) book/position...
    storageHelper.setLastPlaybackSession({
      libraryItemId: "old-book",
      currentTime: 42,
      updatedAt: Date.now(),
    } as any);
    usePlaybackStore.setState({ currentSession: null } as any);
    // ...but Android Auto is live-playing item42.
    mockState.mockResolvedValue({ state: State.Playing } as any);
    mockActive.mockResolvedValue({ mediaId: "play:item42" } as any);

    await usePlaybackStore.getState().loadLastSession();

    // The live AA book is adopted; the stale "old-book" disk save is NOT restored.
    expect(startSpy).toHaveBeenCalledWith("item42", undefined);
    expect(startSpy).not.toHaveBeenCalledWith("old-book", expect.anything());
  });
});
