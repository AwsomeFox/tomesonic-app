/**
 * JS → NATIVE BRIDGE ARG-SHAPE TRIPWIRES.
 *
 * These pin the exact shapes JS sends across bridges whose OTHER side lives in
 * the react-native-track-player Kotlin patch
 * (patches/react-native-track-player+5.0.0-alpha0.patch). There is NO shared
 * source of truth — the Kotlin side parses positionally / by JSON key, so a
 * JS-side reorder or rename compiles clean, passes every functional test, and
 * silently breaks the car / the doze-proof sleep timer on device.
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
}));

import { Platform, NativeModules } from "react-native";
import TrackPlayer from "react-native-track-player";
import { usePlaybackStore, reconcileWithNativePlayer } from "../../store/usePlaybackStore";
import { playbackService } from "../../store/playbackService";
import { useDownloadStore } from "../../store/useDownloadStore";
import { useUserStore } from "../../store/useUserStore";
import { storage } from "../../utils/storage";
import { writeAutoDownloads } from "../../utils/autoCreds";

const initialPlayback = usePlaybackStore.getState();
const initialUser = useUserStore.getState();
const initialDownloads = useDownloadStore.getState();
const origOS = Platform.OS;
const flush = () => new Promise((r) => setImmediate(r));
const emit = (event: string, payload?: any) => (TrackPlayer as any).__emit(event, payload);

afterEach(() => {
  (Platform as any).OS = origOS;
  delete (NativeModules as any).TrackPlayer;
});

// ---------------------------------------------------------------------------
// (1) Sleep timer → MusicModule.absSetSleepTimer(seconds, fadeSeconds,
//     shakeExtendSeconds). The Kotlin side (patch: `override fun
//     absSetSleepTimer(seconds: Double, fadeSeconds: Double,
//     shakeExtendSeconds: Double, ...)`) consumes these POSITIONALLY —
//     swapping fade and shake-extend would fade for 5 minutes and extend by
//     20 seconds, with no test or type error anywhere.
// ---------------------------------------------------------------------------
describe("native sleep timer bridge (absSetSleepTimer / absCancelSleepTimer)", () => {
  const injectNative = () => {
    const absSetSleepTimer = jest.fn().mockResolvedValue(undefined);
    const absCancelSleepTimer = jest.fn().mockResolvedValue(undefined);
    (Platform as any).OS = "android";
    (NativeModules as any).TrackPlayer = { absSetSleepTimer, absCancelSleepTimer };
    return { absSetSleepTimer, absCancelSleepTimer };
  };

  beforeEach(() => {
    jest.useFakeTimers();
    usePlaybackStore.setState(initialPlayback, true);
    usePlaybackStore.setState({
      isInitialized: true,
      currentSession: { id: "sess1", libraryItemId: "item1" },
      isPlaying: true,
      isCasting: false,
    } as any);
    storage.remove("sleepShakeToExtend");
  });

  afterEach(() => {
    usePlaybackStore.getState().cancelSleepTimer(); // never leak the interval / armed flag
    jest.useRealTimers();
  });

  it("setSleepTimer(600) arms native with (600, 20 [SLEEP_FADE_SECONDS], 300 [5min shake-extend, default ON])", () => {
    const { absSetSleepTimer } = injectNative();
    usePlaybackStore.getState().setSleepTimer(600);
    // 20 = SLEEP_FADE_SECONDS; 300 = SLEEP_SHAKE_MINUTES(5) * 60 — the shake
    // setting defaults ON when the key was never written.
    expect(absSetSleepTimer).toHaveBeenCalledTimes(1);
    expect(absSetSleepTimer).toHaveBeenCalledWith(600, 20, 300);
  });

  it("shake-to-extend OFF sends shakeExtendSeconds 0 (native must not own the sensor)", () => {
    const { absSetSleepTimer } = injectNative();
    storage.set("sleepShakeToExtend", false);
    usePlaybackStore.getState().setSleepTimer(600);
    expect(absSetSleepTimer).toHaveBeenCalledWith(600, 20, 0);
  });

  it("cancelSleepTimer cancels the armed native timer via absCancelSleepTimer", () => {
    const { absCancelSleepTimer } = injectNative();
    usePlaybackStore.getState().setSleepTimer(600);
    expect(absCancelSleepTimer).not.toHaveBeenCalled();
    usePlaybackStore.getState().cancelSleepTimer();
    expect(absCancelSleepTimer).toHaveBeenCalledTimes(1);
  });

  it("while CASTING the native enforcer is NOT armed (it would pause the local player, not the receiver)", () => {
    const { absSetSleepTimer } = injectNative();
    usePlaybackStore.setState({ isCasting: true } as any);
    usePlaybackStore.getState().setSleepTimer(600);
    expect(absSetSleepTimer).not.toHaveBeenCalled();
    // The JS countdown still runs for the receiver.
    expect(usePlaybackStore.getState().sleepTimer?.remaining).toBe(600);
  });
});

// ---------------------------------------------------------------------------
// (2) "play:" mediaId grammar — TWO-SIDED CONTRACT with the Kotlin patch.
//     Producers (Kotlin, patch lines ~1096/1119/1155/1191/1376 absPlayableItem
//     "play:$id", ~1409 "play:$itemId::$epId", plus the cold-start handoff
//     that appends "@@<absolute seconds>"). JS consumers:
//       a) reconcileWithNativePlayer (usePlaybackStore) parses the PREFIXED
//          mediaId straight off the native queue item;
//       b) playbackService's RemotePlayId handler receives the id with the
//          "play:" prefix ALREADY STRIPPED by the native side (patch ~1729:
//          `mid.removePrefix("play:").substringBefore("@@")`), i.e. grammar
//          "<itemId>[::episodeId][@@seconds]".
//     No shared grammar definition exists — these pin both parsers.
// ---------------------------------------------------------------------------
describe('mediaId grammar: reconcileWithNativePlayer ("play:<itemId>[::<episodeId>][@@<seconds>]")', () => {
  const arm = (mediaId: string, state = "playing") => {
    const startPlayback = jest.fn().mockResolvedValue(true);
    usePlaybackStore.setState(initialPlayback, true);
    usePlaybackStore.setState({ currentSession: null, isCasting: false, startPlayback } as any);
    jest.mocked(TrackPlayer.getPlaybackState).mockResolvedValue({ state } as any);
    jest.mocked(TrackPlayer.getActiveTrack).mockResolvedValue({ mediaId } as any);
    return startPlayback;
  };

  it('"play:a" → adopts item "a", no episode', async () => {
    const startPlayback = arm("play:a");
    await expect(reconcileWithNativePlayer()).resolves.toBe(true);
    expect(startPlayback).toHaveBeenCalledWith("a", undefined);
  });

  it('"play:a::e" → adopts item "a" episode "e"', async () => {
    const startPlayback = arm("play:a::e");
    await reconcileWithNativePlayer();
    expect(startPlayback).toHaveBeenCalledWith("a", "e");
  });

  it('"play:a@@123.5" → the @@position suffix is STRIPPED (native already owns the live position; adoption never seeks)', async () => {
    const startPlayback = arm("play:a@@123.5");
    await reconcileWithNativePlayer();
    expect(startPlayback).toHaveBeenCalledWith("a", undefined);
    expect(TrackPlayer.seekTo).not.toHaveBeenCalled();
  });

  it('"play:a::e@@0" → composite id parses through the @@ strip', async () => {
    const startPlayback = arm("play:a::e@@0");
    await reconcileWithNativePlayer();
    expect(startPlayback).toHaveBeenCalledWith("a", "e");
  });

  it("a non-'play:' mediaId is NOT ours to rebuild — no adoption", async () => {
    const startPlayback = arm("someOtherQueueItem");
    await expect(reconcileWithNativePlayer()).resolves.toBe(false);
    expect(startPlayback).not.toHaveBeenCalled();
  });

  it('a bare "play:" (empty itemId) is rejected', async () => {
    const startPlayback = arm("play:");
    await expect(reconcileWithNativePlayer()).resolves.toBe(false);
    expect(startPlayback).not.toHaveBeenCalled();
  });
});

describe('mediaId grammar: RemotePlayId ("<itemId>[::episodeId][@@seconds]", prefix pre-stripped by native)', () => {
  // Register the service handlers ONCE (module-level guard prevents re-wiring).
  beforeAll(async () => {
    await playbackService();
  });

  const spyActions = () => {
    const actions = {
      startPlayback: jest.fn().mockResolvedValue(true),
      seek: jest.fn().mockResolvedValue(undefined),
      pause: jest.fn().mockResolvedValue(undefined),
    };
    usePlaybackStore.setState(initialPlayback, true);
    usePlaybackStore.setState(actions as any);
    return actions;
  };

  it('"a@@123.5" → {itemId:"a", episodeId:undefined, position:123.5} (fractional seconds preserved)', async () => {
    const a = spyActions();
    emit("remote-play-id", { id: "a@@123.5" });
    await flush();
    expect(a.startPlayback).toHaveBeenCalledWith("a", undefined);
    expect(a.seek).toHaveBeenCalledWith(123.5);
  });

  it('"a::e@@0" → {itemId:"a", episodeId:"e"} and @@0 does NOT seek (t > 0 guard)', async () => {
    const a = spyActions();
    emit("remote-play-id", { id: "a::e@@0" });
    await flush();
    expect(a.startPlayback).toHaveBeenCalledWith("a", "e");
    // Position 0 means "no bookmark position" — seeking to 0 would discard the
    // server-side resume position startPlayback just restored.
    expect(a.seek).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// (3) writeAutoDownloads JS-writer schema. The native reader (patch ~800-830)
//     parses auto_downloads.json by EXACT key: optString("folder"),
//     optString("coverPath"), optDouble("currentTime"), optDouble("duration"),
//     tracks[] → optString("filename"), optDouble("startOffset"),
//     optDouble("duration"). A renamed JS key is silently absent on the
//     Kotlin side (optX defaults) — downloads would vanish from the car or
//     resume at 0 with every JS test still green.
// ---------------------------------------------------------------------------
describe("writeAutoDownloads payload schema (native auto_downloads.json reader contract)", () => {
  const mockedWrite = jest.mocked(writeAutoDownloads);

  beforeEach(() => {
    usePlaybackStore.setState(initialPlayback, true);
    useUserStore.setState(initialUser, true);
    useDownloadStore.setState(initialDownloads, true);
    mockedWrite.mockClear();
  });

  const completedBook = (id: string) => ({
    id,
    libraryItemId: id,
    title: "The Hobbit",
    author: "J.R.R. Tolkien",
    coverUrl: "https://server/cover.jpg",
    progress: 1,
    status: "completed",
    localFolderPath: `file:///downloads/${id}_The-Hobbit/`,
    parts: [
      { id: "track_0", filename: "a.m4b", url: "u", bytesDownloaded: 9, fileSize: 9, completed: true, localFilePath: `file:///downloads/${id}_The-Hobbit/a.m4b` },
      { id: "cover", filename: "cover.jpg", url: "u", bytesDownloaded: 1, fileSize: 1, completed: true, localFilePath: `file:///downloads/${id}_The-Hobbit/cover.jpg` },
    ],
    meta: {
      duration: 3600.5,
      chapters: [],
      tracks: [
        { index: 0, filename: "a.m4b", duration: 1800.25, startOffset: 0 },
        { index: 1, filename: "b.m4b", duration: 1800.25, startOffset: 1800.25 },
      ],
    },
  });

  it("emits EXACTLY the keys the native reader parses, with the resume position resolved", () => {
    // Resume position comes from the user store's progress map.
    useUserStore.setState({ mediaProgress: { "book-schema": { currentTime: 42.5 } } } as any);
    useDownloadStore.setState({
      completedDownloads: { "book-schema": completedBook("book-schema") },
    } as any);

    expect(mockedWrite).toHaveBeenCalled();
    const entries = mockedWrite.mock.calls.at(-1)![0] as any[];
    expect(entries).toHaveLength(1);
    const entry = entries[0];

    // The full schema, pinned as a sorted key list — adding a key is safe
    // (native ignores it), but RENAMING or DROPPING one of these breaks the
    // car's offline browse/play with no JS-side symptom.
    expect(Object.keys(entry).sort()).toEqual([
      "author",
      "coverPath",
      "currentTime",
      "duration",
      "folder",
      "id",
      "title",
      "tracks",
    ]);
    expect(entry.id).toBe("book-schema"); // the LIBRARY item id, not a composite
    expect(entry.title).toBe("The Hobbit");
    expect(entry.author).toBe("J.R.R. Tolkien");
    expect(entry.folder).toBe("file:///downloads/book-schema_The-Hobbit/");
    expect(entry.coverPath).toBe("file:///downloads/book-schema_The-Hobbit/cover.jpg");
    expect(entry.currentTime).toBe(42.5);
    expect(entry.duration).toBe(3600.5);

    expect(entry.tracks).toHaveLength(2);
    for (const t of entry.tracks) {
      expect(Object.keys(t).sort()).toEqual(["duration", "filename", "startOffset"]);
      expect(typeof t.filename).toBe("string");
      expect(typeof t.startOffset).toBe("number");
      expect(typeof t.duration).toBe("number");
    }
    expect(entry.tracks[1]).toEqual({ filename: "b.m4b", startOffset: 1800.25, duration: 1800.25 });
  });

  it("excludes podcast EPISODES and track-less (ebook-only) downloads from the car mirror", () => {
    const episode = {
      ...completedBook("pod-x"),
      id: "pod-x::ep-1",
      libraryItemId: "pod-x",
      episodeId: "ep-1",
    };
    const ebookOnly = { ...completedBook("ebook-y"), id: "ebook-y", libraryItemId: "ebook-y", meta: undefined };
    useDownloadStore.setState({
      completedDownloads: {
        "book-only": completedBook("book-only"),
        "pod-x::ep-1": episode,
        "ebook-y": ebookOnly,
      },
    } as any);

    expect(mockedWrite).toHaveBeenCalled();
    const entries = mockedWrite.mock.calls.at(-1)![0] as any[];
    expect(entries.map((e: any) => e.id)).toEqual(["book-only"]);
  });
});
