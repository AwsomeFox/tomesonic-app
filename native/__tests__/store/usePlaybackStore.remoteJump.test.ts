/**
 * REGRESSION: notification jump buttons vs a stale store snapshot.
 *
 * The store's `position` is written by a 1s JS interval that Android
 * throttles while the app is backgrounded — the NATIVE player keeps playing
 * while the snapshot freezes. seekForward/seekBackward used to compute the
 * target from that snapshot, so a "back 10s" press from the notification
 * could leap back MINUTES (stale position − 10) instead of 10 seconds.
 * Relative seeks must read the live player position.
 */
import TrackPlayer from "react-native-track-player";
import { usePlaybackStore } from "../../store/usePlaybackStore";

const mockedTP = jest.mocked(TrackPlayer);

const initialState = usePlaybackStore.getState();

beforeEach(() => {
  jest.clearAllMocks();
  usePlaybackStore.setState(initialState, true);
  usePlaybackStore.setState({
    isInitialized: true,
    currentSession: { id: "s1", libraryItemId: "li1" },
    duration: 3600,
    isCasting: false,
  } as any);
});

describe("remote jumps read the LIVE player position", () => {
  it("seekBackward jumps 10s from the LIVE position, not the stale snapshot", async () => {
    // Store snapshot froze at 100s while the native player reached 500s
    // (backgrounded app, throttled interval).
    usePlaybackStore.setState({ position: 100, chapterQueue: false, chapters: [] } as any);
    mockedTP.getProgress.mockResolvedValue({ position: 500, duration: 3600, buffered: 0 } as any);

    await usePlaybackStore.getState().seekBackward(10);

    // 500 - 10 = 490 — NOT 100 - 10 = 90 (the old bug: a 400s leap).
    expect(mockedTP.seekTo).toHaveBeenCalledWith(490);
  });

  it("seekForward jumps from the LIVE position and clamps to duration", async () => {
    usePlaybackStore.setState({ position: 100, chapterQueue: false, chapters: [] } as any);
    mockedTP.getProgress.mockResolvedValue({ position: 3595, duration: 3600, buffered: 0 } as any);

    await usePlaybackStore.getState().seekForward(30);

    expect(mockedTP.seekTo).toHaveBeenCalledWith(3600); // clamped, not 130
  });

  it("chapter queues map the live chapter-relative position to absolute", async () => {
    const chapters = [
      { start: 0, end: 1000, title: "1" },
      { start: 1000, end: 2000, title: "2" },
      { start: 2000, end: 3600, title: "3" },
    ];
    usePlaybackStore.setState({ position: 50, chapterQueue: true, chapters } as any);
    // Native player: chapter 3 (index 2), 100s in → absolute 2100.
    mockedTP.getActiveTrackIndex.mockResolvedValue(2);
    mockedTP.getProgress.mockResolvedValue({ position: 100, duration: 1600, buffered: 0 } as any);

    await usePlaybackStore.getState().seekBackward(10);

    // Absolute target 2090 stays inside chapter 3 → seekTo(90), same item.
    expect(mockedTP.seekTo).toHaveBeenCalledWith(90);
    expect(mockedTP.skip).not.toHaveBeenCalled();
  });

  it("falls back to the store snapshot when the player is not readable", async () => {
    usePlaybackStore.setState({ position: 200, chapterQueue: false, chapters: [] } as any);
    mockedTP.getProgress.mockRejectedValue(new Error("no player"));

    await usePlaybackStore.getState().seekBackward(10);

    expect(mockedTP.seekTo).toHaveBeenCalledWith(190);
  });

  it("while casting, uses the store position (receiver mirror is the truth)", async () => {
    const castClient = { seek: jest.fn().mockResolvedValue(undefined) };
    usePlaybackStore.setState({
      position: 800,
      isCasting: true,
      castClient,
      chapterQueue: false,
      chapters: [],
    } as any);

    await usePlaybackStore.getState().seekBackward(10);

    // Cast path: raw client seek to the absolute target.
    expect(castClient.seek).toHaveBeenCalledWith({ position: 790 });
    expect(mockedTP.getProgress).not.toHaveBeenCalled();
  });
});
