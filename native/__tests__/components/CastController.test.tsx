/**
 * CastController — local ↔ Chromecast bridge:
 *  - null client → inert (no listeners, no loadMedia)
 *  - on connect with a session: builds the full-book queue with cumulative
 *    offsets, correct startIndex/startTime, pauses the LOCAL player first,
 *    autoplay mirrors isPlaying, re-applies playbackSpeed ≠ 1
 *  - registers castSeekAbs (same-track → client.seek; cross-track → loadMedia)
 *  - settle guard: progress callbacks near 0 right after load are NOT mirrored,
 *    near-target ones are
 *  - status updates re-map the base offset + mirror play state
 *  - disconnect seeks local to the last cast position and resumes play state
 */
import { render, act } from "@testing-library/react-native";
import TrackPlayer from "react-native-track-player";
import { useRemoteMediaClient } from "react-native-google-cast";
import CastController from "../../components/CastController";
import { usePlaybackStore } from "../../store/usePlaybackStore";
import { storageHelper } from "../../utils/storage";

const useClientMock = useRemoteMediaClient as jest.Mock;
const playbackInitial = usePlaybackStore.getState();

/** Fake cast client capturing the progress/status listeners so tests can
 *  drive receiver callbacks. */
function makeFakeClient() {
  const progressListeners: Array<(p: number) => void> = [];
  const statusListeners: Array<(s: any) => void> = [];
  const client = {
    onMediaProgressUpdated: jest.fn((cb: (p: number) => void, _interval?: number) => {
      progressListeners.push(cb);
      return { remove: jest.fn() };
    }),
    onMediaStatusUpdated: jest.fn((cb: (s: any) => void) => {
      statusListeners.push(cb);
      return { remove: jest.fn() };
    }),
    loadMedia: jest.fn().mockResolvedValue(undefined),
    seek: jest.fn().mockResolvedValue(undefined),
    setPlaybackRate: jest.fn().mockResolvedValue(undefined),
  };
  return {
    client,
    emitProgress: (p: number) => progressListeners.forEach((f) => f(p)),
    emitStatus: (s: any) => statusListeners.forEach((f) => f(s)),
  };
}

// 3 × 1000s tracks (multi-file book) — offsets 0 / 1000 / 2000.
const session = {
  id: "sess1",
  libraryItemId: "item1",
  displayTitle: "The Hobbit",
  displayAuthor: "J.R.R. Tolkien",
  coverUrl: "https://abs.example.com/cover.jpg",
  currentTime: 100,
  audioTracks: [
    { startOffset: 0, duration: 1000, contentUrl: "/t1.mp3", mimeType: "audio/mpeg" },
    { startOffset: 1000, duration: 1000, contentUrl: "/t2.mp3", mimeType: "audio/mpeg" },
    { startOffset: 2000, duration: 1000, contentUrl: "/t3.mp3", mimeType: "audio/mpeg" },
  ],
};

beforeEach(() => {
  usePlaybackStore.setState(playbackInitial, true);
  storageHelper.setServerConfig({ address: "https://abs.example.com/", token: "tok" });
  useClientMock.mockReturnValue(null);
});

async function mountWithClient(fake: ReturnType<typeof makeFakeClient>) {
  useClientMock.mockReturnValue(fake.client);
  const utils = await render(<CastController />);
  // Flush the async loadMedia IIFE.
  await act(async () => {});
  return utils;
}

describe("CastController — no client", () => {
  it("is inert when useRemoteMediaClient returns null", async () => {
    usePlaybackStore.setState({ currentSession: session, position: 100 } as any);
    await render(<CastController />);
    expect(usePlaybackStore.getState().isCasting).toBe(false);
    expect(usePlaybackStore.getState().castClient).toBeNull();
    expect(TrackPlayer.pause).not.toHaveBeenCalled();
  });

  it("registers no cast state without a session either", async () => {
    const fake = makeFakeClient();
    usePlaybackStore.setState({ currentSession: null } as any);
    await mountWithClient(fake);
    // Client registered for transport routing, but nothing loaded.
    expect(usePlaybackStore.getState().isCasting).toBe(true);
    expect(fake.client.loadMedia).not.toHaveBeenCalled();
  });
});

describe("CastController — connect + queue load", () => {
  it("loads the whole book as a queue with offsets, startIndex and startTime", async () => {
    usePlaybackStore.setState({
      currentSession: session,
      position: 1500, // inside track 2 → startIndex 1, within-track 500
      isPlaying: true,
      playbackSpeed: 1,
    } as any);
    const fake = await (async () => {
      const f = makeFakeClient();
      await mountWithClient(f);
      return f;
    })();

    expect(fake.client.loadMedia).toHaveBeenCalledTimes(1);
    const arg = fake.client.loadMedia.mock.calls[0][0];
    expect(arg.startTime).toBe(500);
    expect(arg.autoplay).toBe(true);
    expect(arg.queueData.startIndex).toBe(1);
    const items = arg.queueData.items;
    expect(items).toHaveLength(3);
    // URLs are absolutized against the server address with the token appended.
    expect(items[0].mediaInfo.contentUrl).toBe("https://abs.example.com/t1.mp3?token=tok");
    expect(items[2].mediaInfo.contentUrl).toBe("https://abs.example.com/t3.mp3?token=tok");
    // The starting item carries its within-track start time.
    expect(items[1].startTime).toBe(500);
    // Queue metadata mirrors the session.
    expect(items[0].mediaInfo.metadata.title).toBe("The Hobbit");
    expect(items[0].mediaInfo.metadata.subtitle).toBe("J.R.R. Tolkien");
  });

  it("a FINISHED book connects into the last track, not track 0", async () => {
    usePlaybackStore.setState({
      currentSession: session,
      position: 3000, // at the very end of the 3x1000s book
      isPlaying: false,
      playbackSpeed: 1,
    } as any);
    const fake = makeFakeClient();
    await mountWithClient(fake);

    const arg = fake.client.loadMedia.mock.calls[0][0];
    // startIndex used to collapse -1 → 0, restarting the cast from the start.
    expect(arg.queueData.startIndex).toBe(2);
    expect(arg.startTime).toBe(1000); // end of the last track
  });

  it("pauses the local player BEFORE loading the receiver (no double audio)", async () => {
    usePlaybackStore.setState({ currentSession: session, position: 0, isPlaying: true } as any);
    const fake = makeFakeClient();
    await mountWithClient(fake);
    expect(TrackPlayer.pause).toHaveBeenCalled();
    const pauseOrder = (TrackPlayer.pause as jest.Mock).mock.invocationCallOrder[0];
    const loadOrder = fake.client.loadMedia.mock.invocationCallOrder[0];
    expect(pauseOrder).toBeLessThan(loadOrder);
  });

  it("does not autoplay when the book was paused at connect time", async () => {
    usePlaybackStore.setState({ currentSession: session, position: 50, isPlaying: false } as any);
    const fake = makeFakeClient();
    await mountWithClient(fake);
    expect(fake.client.loadMedia.mock.calls[0][0].autoplay).toBe(false);
  });

  it("re-applies a non-1 playback speed after load", async () => {
    usePlaybackStore.setState({
      currentSession: session,
      position: 0,
      isPlaying: true,
      playbackSpeed: 1.3,
    } as any);
    const fake = makeFakeClient();
    await mountWithClient(fake);
    expect(fake.client.setPlaybackRate).toHaveBeenCalledWith(1.3);
  });

  it("leaves the receiver at 1× when the speed is 1", async () => {
    usePlaybackStore.setState({
      currentSession: session,
      position: 0,
      isPlaying: true,
      playbackSpeed: 1,
    } as any);
    const fake = makeFakeClient();
    await mountWithClient(fake);
    expect(fake.client.setPlaybackRate).not.toHaveBeenCalled();
  });

  it("skips loading when the session has no audio tracks", async () => {
    usePlaybackStore.setState({
      currentSession: { ...session, audioTracks: [] },
      position: 0,
    } as any);
    const fake = makeFakeClient();
    await mountWithClient(fake);
    expect(fake.client.loadMedia).not.toHaveBeenCalled();
  });
});

describe("CastController — castSeekAbs handler", () => {
  async function connect(position = 1500) {
    usePlaybackStore.setState({
      currentSession: session,
      position,
      isPlaying: true,
      playbackSpeed: 1,
    } as any);
    const fake = makeFakeClient();
    await mountWithClient(fake);
    const castSeekAbs = usePlaybackStore.getState().castSeekAbs!;
    expect(castSeekAbs).toBeTruthy();
    return { fake, castSeekAbs };
  }

  it("same-track target → client.seek at the within-track position", async () => {
    const { fake, castSeekAbs } = await connect(1500); // current idx 1
    await act(async () => {
      await castSeekAbs(1200); // still inside track 2 (1000–2000)
    });
    expect(fake.client.seek).toHaveBeenCalledWith({ position: 200 });
    expect(fake.client.loadMedia).toHaveBeenCalledTimes(1); // no reload
  });

  it("cross-track target → reloads the queue at the target index", async () => {
    const { fake, castSeekAbs } = await connect(1500); // current idx 1
    await act(async () => {
      await castSeekAbs(2500); // inside track 3
    });
    expect(fake.client.seek).not.toHaveBeenCalled();
    expect(fake.client.loadMedia).toHaveBeenCalledTimes(2);
    const arg = fake.client.loadMedia.mock.calls[1][0];
    expect(arg.queueData.startIndex).toBe(2);
    expect(arg.startTime).toBe(500);
    expect(arg.autoplay).toBe(true); // preserves play state
  });

  it("cross-track reload re-applies a non-1 speed", async () => {
    usePlaybackStore.setState({
      currentSession: session,
      position: 1500,
      isPlaying: true,
      playbackSpeed: 1.5,
    } as any);
    const fake = makeFakeClient();
    await mountWithClient(fake);
    fake.client.setPlaybackRate.mockClear();
    const castSeekAbs = usePlaybackStore.getState().castSeekAbs!;
    await act(async () => {
      await castSeekAbs(2500);
    });
    expect(fake.client.setPlaybackRate).toHaveBeenCalledWith(1.5);
  });

  it("clamps a negative target to the first track", async () => {
    const { fake, castSeekAbs } = await connect(1500);
    await act(async () => {
      await castSeekAbs(-10);
    });
    // idx 0 ≠ current idx 1 → reload at index 0, time 0.
    const arg = fake.client.loadMedia.mock.calls[1][0];
    expect(arg.queueData.startIndex).toBe(0);
    expect(arg.startTime).toBe(0);
  });
});

describe("CastController — receiver mirroring + settle guard", () => {
  async function connect(position = 1500) {
    usePlaybackStore.setState({
      currentSession: session,
      position,
      isPlaying: true,
      playbackSpeed: 1,
    } as any);
    const fake = makeFakeClient();
    await mountWithClient(fake);
    return fake;
  }

  it("suppresses pre-seek progress noise right after load, mirrors near-target", async () => {
    const fake = await connect(1500); // settle target 1500, base offset 1000
    // Receiver briefly reports from the track start (abs 1000+5=1005): NOT mirrored.
    await act(async () => {
      fake.emitProgress(5);
    });
    expect(usePlaybackStore.getState().position).toBe(1500);
    // Receiver lands near the target (abs 1495, within the 12s epsilon): mirrored.
    await act(async () => {
      fake.emitProgress(495);
    });
    expect(usePlaybackStore.getState().position).toBe(1495);
    // Guard is now cleared — every subsequent tick mirrors, even far ones.
    await act(async () => {
      fake.emitProgress(10);
    });
    expect(usePlaybackStore.getState().position).toBe(1010);
  });

  it("mirrors receiver play state via status updates", async () => {
    const fake = await connect(0);
    await act(async () => {
      fake.emitStatus({ playerState: "paused", queueItems: [], currentItemId: null });
    });
    expect(usePlaybackStore.getState().isPlaying).toBe(false);
    await act(async () => {
      fake.emitStatus({ playerState: "playing", queueItems: [], currentItemId: null });
    });
    expect(usePlaybackStore.getState().isPlaying).toBe(true);
    await act(async () => {
      fake.emitStatus({ playerState: "buffering", queueItems: [], currentItemId: null });
    });
    expect(usePlaybackStore.getState().isPlaying).toBe(true);
    await act(async () => {
      fake.emitStatus({ playerState: "idle", queueItems: [], currentItemId: null });
    });
    expect(usePlaybackStore.getState().isPlaying).toBe(false);
  });

  it("re-bases progress when the receiver advances to the next queue item", async () => {
    const fake = await connect(1500);
    // Clear the settle guard by reporting at the target first.
    await act(async () => {
      fake.emitProgress(500);
    });
    // Receiver moved to the 3rd queue item (offset 2000).
    await act(async () => {
      fake.emitStatus({
        playerState: "playing",
        queueItems: [{ itemId: 11 }, { itemId: 22 }, { itemId: 33 }],
        currentItemId: 33,
      });
      fake.emitProgress(30);
    });
    expect(usePlaybackStore.getState().position).toBe(2030);
  });
});

describe("CastController — disconnect", () => {
  async function connectThenDisconnect({ wasPlaying }: { wasPlaying: boolean }) {
    usePlaybackStore.setState({
      currentSession: session,
      position: 1500,
      isPlaying: true,
      playbackSpeed: 1,
    } as any);
    const fake = makeFakeClient();
    useClientMock.mockReturnValue(fake.client);
    const { rerender } = await render(<CastController />);
    await act(async () => {});

    // State at the moment the cast ends.
    const seek = jest.fn().mockResolvedValue(undefined);
    usePlaybackStore.setState({ position: 1750, isPlaying: wasPlaying, seek } as any);

    (TrackPlayer.play as jest.Mock).mockClear();
    useClientMock.mockReturnValue(null);
    // Client loss now sits out a SUSPEND grace window (wifi blips must not
    // blast local audio over a still-playing TV) — advance past it so the
    // deferred handback actually runs.
    jest.useFakeTimers();
    try {
      await rerender(<CastController />);
      await act(async () => {
        jest.advanceTimersByTime(5100);
        await Promise.resolve();
      });
    } finally {
      jest.useRealTimers();
    }
    await act(async () => {});
    return { seek };
  }

  it("seeks local playback to the last cast position and resumes when it was playing", async () => {
    const { seek } = await connectThenDisconnect({ wasPlaying: true });
    expect(seek).toHaveBeenCalledWith(1750);
    expect(TrackPlayer.play).toHaveBeenCalled();
    expect(usePlaybackStore.getState().isPlaying).toBe(true);
    // Cast routing is fully dropped.
    expect(usePlaybackStore.getState().isCasting).toBe(false);
    expect(usePlaybackStore.getState().castClient).toBeNull();
    expect(usePlaybackStore.getState().castSeekAbs).toBeNull();
  });

  it("stays paused locally when the receiver was paused at disconnect", async () => {
    const { seek } = await connectThenDisconnect({ wasPlaying: false });
    expect(seek).toHaveBeenCalledWith(1750);
    expect(TrackPlayer.play).not.toHaveBeenCalled();
    expect(usePlaybackStore.getState().isPlaying).toBe(false);
  });
});
