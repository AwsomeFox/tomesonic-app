import { DeviceEventEmitter } from "react-native";
import TrackPlayer, { Event, State } from "react-native-track-player";
import {
  usePlaybackStore,
  onNativeProgressSample,
  onPlaybackError,
  recoverPlaybackIfNeeded,
} from "./usePlaybackStore";
import { parsePlayMediaId } from "../utils/playMediaId";

// Cycles through the same set the in-app speed control offers.
const SPEEDS = [0.8, 1.0, 1.2, 1.5, 1.75, 2.0, 3.0];

// One NetInfo subscription per JS context (the service function can re-run).
let _netInfoSubscribed = false;
// One registration of the event handlers per JS context: a service re-entry
// (Fast Refresh, headless re-run) used to double-register every listener, so
// each remote button dispatched its action twice.
let _serviceWired = false;

// Connectivity-regained handler, exported for tests. Runs HEADLESS too
// (Android Auto cold start) — App.tsx, where the foreground recovery hooks
// live, never mounts there, so this subscription is the car's only
// reconnect-triggered recovery.
export function onConnectivityChanged(state: { isConnected?: boolean | null } | null | undefined) {
  if (!state?.isConnected) return;
  recoverPlaybackIfNeeded().catch(() => {});
  try {
    const { flushPendingSyncs } = require("../utils/progressSync");
    flushPendingSyncs().catch(() => {});
  } catch {}
}

export async function playbackService() {
  // HEADLESS BOOT (Android Auto cold start): this service can be the first —
  // and only — JS to run, with App.tsx never mounted, so useUserStore's
  // initialize() never seeds mediaProgress from disk. Left empty, the FIRST
  // progress tick would run the write-through mirror and overwrite the
  // durable mediaProgressCache with a single-entry map — wiping every other
  // downloaded book's offline resume position. Seed it here first. Must run
  // BEFORE loadDownloadsFromDb below, whose subscriber snapshots resume
  // positions for the Android Auto downloads mirror.
  try {
    const { useUserStore } = require("./useUserStore");
    const st = useUserStore.getState();
    if (!st.isInitialized && Object.keys(st.mediaProgress || {}).length === 0) {
      const { storageHelper } = require("../utils/storage");
      const cached = storageHelper.getMediaProgressCache();
      if (cached && Object.keys(cached).length) {
        useUserStore.setState({ mediaProgress: cached });
      }
    }
  } catch (e) {
    console.warn("[PlaybackService] headless progress seed failed", e);
  }

  // Load the downloads DB so preparePlaybackSession can prefer local files in
  // the car (poor signal is exactly when this matters). Idempotent and cheap
  // (MMKV read).
  try {
    const { useDownloadStore } = require("./useDownloadStore");
    useDownloadStore.getState().loadDownloadsFromDb();
  } catch (e) {
    console.warn("[PlaybackService] headless downloads load failed", e);
  }

  if (_serviceWired) return;
  _serviceWired = true;

  // Native sleep-timer events (the Media3 service enforces the timer through
  // doze — see armNativeSleepTimer in usePlaybackStore). JS may be frozen when
  // these fire; that's fine — native already paused/extended, and these
  // listeners just reconcile the UI whenever JS is alive to hear them.
  DeviceEventEmitter.addListener("abs-sleep-fired", () => {
    console.log("[PlaybackService] Native sleep timer fired");
    usePlaybackStore.getState().onNativeSleepFired();
  });
  DeviceEventEmitter.addListener("abs-sleep-extended", (e: any) => {
    const remaining = Number(e?.remaining);
    console.log(`[PlaybackService] Native sleep timer shake-extended to ${remaining}s`);
    usePlaybackStore.getState().onNativeSleepExtended(remaining);
  });

  // Android Auto "playback speed" button (native emits this custom event).
  DeviceEventEmitter.addListener("remote-playback-speed", () => {
    const st = usePlaybackStore.getState();
    const current = st.playbackSpeed || 1.0;
    const idx = SPEEDS.findIndex((s) => Math.abs(s - current) < 0.01);
    const next = SPEEDS[(idx + 1) % SPEEDS.length];
    console.log(`[PlaybackService] RemotePlaybackSpeed ${current} -> ${next}`);
    st.setPlaybackSpeed(next);
  });

  // NATIVE progress samples — emitted by the Media3 service's own timer, so
  // they keep arriving while Android throttles JS timers in the background.
  // This is what keeps local saves + server syncs flowing with the screen
  // off; the JS 1s interval only reliably covers the foreground.
  TrackPlayer.addEventListener(Event.PlaybackProgressUpdated, (event) => {
    onNativeProgressSample(event as any);
  });

  // Mid-stream player errors (network drop with the screen off is the classic
  // case) leave ExoPlayer IDLE — it never resumes on its own, and the store
  // would keep claiming isPlaying forever. Persist the position, fix the
  // state, and arm the bounded auto-retry (see usePlaybackStore).
  TrackPlayer.addEventListener(Event.PlaybackError, (event) => {
    onPlaybackError(event as any);
  });

  // Native play-state is the ground truth for isPlaying. ExoPlayer pauses
  // itself on audio-focus loss (alarm, assistant, another media app) — in the
  // background nothing else corrects the store (progress events only fire
  // WHILE playing, the JS interval is throttled), so the mini-player showed a
  // pause button over a silent player and the first tap did nothing.
  // Transitional states (buffering/loading/ready) leave the flag alone.
  TrackPlayer.addEventListener(Event.PlaybackState, (event: any) => {
    const st = usePlaybackStore.getState();
    if (!st.currentSession || st.isCasting) return;
    const s = event?.state;
    // Expose the stall state so the UI can show a spinner over the play/pause
    // control: the progress interval folds Buffering/Loading into "playing", so
    // a stalled stream otherwise shows the pause glyph over a frozen scrubber.
    const buffering = s === State.Buffering || s === State.Loading;
    if (buffering !== st.isBuffering) usePlaybackStore.setState({ isBuffering: buffering });
    if (s === State.Playing) {
      if (!st.isPlaying) usePlaybackStore.setState({ isPlaying: true });
    } else if (
      s === State.Paused ||
      s === State.Stopped ||
      s === State.Error ||
      s === State.Ended ||
      s === State.None
    ) {
      if (st.isPlaying) usePlaybackStore.setState({ isPlaying: false });
    }
  });

  // End of the book with the screen off: native playback stops, native
  // progress events stop, and nothing else corrects the store until the
  // throttled JS interval runs in the foreground — isPlaying was stuck true
  // (stale mini-player/notification state). While casting the local player's
  // queue isn't the source of truth, so leave the mirror alone.
  TrackPlayer.addEventListener(Event.PlaybackQueueEnded, () => {
    const st = usePlaybackStore.getState();
    if (!st.currentSession || st.isCasting) return;
    usePlaybackStore.setState({ isPlaying: false });
  });

  // Connectivity-regained recovery — see onConnectivityChanged. Without it,
  // a doze network flap that outlives the bounded error retries leaves
  // playback dead in the car until a manual play.
  if (!_netInfoSubscribed) {
    try {
      // Lazy require so a missing native module can't crash the service boot.
      const NetInfo = require("@react-native-community/netinfo").default;
      NetInfo.addEventListener(onConnectivityChanged);
      _netInfoSubscribed = true;
    } catch (e) {
      console.warn("[PlaybackService] NetInfo unavailable — no headless reconnect recovery", e);
    }
  }

  // Route remote (notification / Android Auto / bluetooth) transport through the
  // store, not TrackPlayer directly, so play() applies auto-rewind and pause()
  // flushes a progress sync to the server (otherwise remote pauses never sync).
  TrackPlayer.addEventListener(Event.RemotePlay, async () => {
    console.log("[PlaybackService] RemotePlay");
    let s = usePlaybackStore.getState();
    // HEADLESS cold start (steering-wheel/BT play before the app UI ever
    // mounted): no session is loaded — loadLastSession only runs from
    // App.tsx, so this press used to be a silent no-op in the car. Restore
    // the last session here, then play it.
    if (!s.currentSession) {
      try {
        await s.loadLastSession();
      } catch (e) {
        console.warn("[PlaybackService] headless session restore failed", e);
      }
      s = usePlaybackStore.getState();
      if (!s.currentSession) return;
    }
    // While casting the LOCAL player sits paused, so the notification only
    // ever offers a play button — treat it as a toggle so the user can still
    // pause the receiver from the notification.
    if (s.isCasting && s.isPlaying) s.pause().catch(() => {});
    else s.play().catch((e) => console.warn("[PlaybackService] play failed", e));
  });

  TrackPlayer.addEventListener(Event.RemotePause, () => {
    console.log("[PlaybackService] RemotePause");
    usePlaybackStore.getState().pause().catch(() => {});
  });

  // The single play/pause TOGGLE key — the most common headset / AVRCP
  // steering-wheel button (KEYCODE_MEDIA_PLAY_PAUSE). The native service
  // consumes it and emits this event, but no listener existed, so the button
  // was a silent no-op everywhere. Mirrors RemotePlay's headless restore so a
  // BT toggle press with no session loaded still resumes the last book.
  TrackPlayer.addEventListener(Event.RemotePlayPause, async () => {
    console.log("[PlaybackService] RemotePlayPause");
    let s = usePlaybackStore.getState();
    if (!s.currentSession) {
      try {
        await s.loadLastSession();
      } catch (e) {
        console.warn("[PlaybackService] headless session restore failed", e);
      }
      s = usePlaybackStore.getState();
      if (!s.currentSession) return;
    }
    if (s.isPlaying) s.pause().catch(() => {});
    else s.play().catch((e) => console.warn("[PlaybackService] play failed", e));
  });

  // Stop = user dismissed playback: close the ABS session (final sync) and clear.
  TrackPlayer.addEventListener(Event.RemoteStop, () => {
    console.log("[PlaybackService] RemoteStop");
    usePlaybackStore.getState().closePlayback().catch(() => {});
  });

  // Android Auto browse → tap-to-play. Native emits remote-play-id with the ABS
  // item id (or "itemId::episodeId" for podcasts); run the full JS startPlayback
  // so the car gets the real queue, chapters, title/subtitle, artwork, progress
  // sync and transport buttons — the same session the phone would build.
  TrackPlayer.addEventListener(Event.RemotePlayId, async (event: any) => {
    const raw = String(event?.id ?? "");
    console.log(`[PlaybackService] RemotePlayId ${raw}`);
    if (!raw) return;
    // A PAUSED cold-start handoff: the native setupPlayer hand-off (adopting an
    // Android Auto session the user had PAUSED before opening the app) tags the
    // payload so we start the real JS session but DON'T auto-resume audio the
    // user paused. Playing handoffs and browse taps omit the flag.
    const paused = event?.paused === true;
    // A "@@<seconds>" suffix (from the Android Auto Bookmarks row, or the
    // native handoff's live position) means: start this book, then seek to it.
    const { itemId, episodeId, bookmarkSeconds } = parsePlayMediaId(raw, { hasPrefix: false });
    try {
      const ok = await usePlaybackStore.getState().startPlayback(itemId, episodeId);
      if (ok && bookmarkSeconds !== undefined && !isNaN(bookmarkSeconds) && bookmarkSeconds > 0) {
        await usePlaybackStore.getState().seek(bookmarkSeconds);
      }
      // startPlayback always begins playing; a paused handoff must land paused.
      if (ok && paused) await usePlaybackStore.getState().pause();
    } catch (e) {
      console.log("[PlaybackService] RemotePlayId failed", e);
    }
  });

  // Next/Previous map to chapters when the current book has them (matches the
  // original Android Auto behaviour), otherwise fall back to queue navigation.
  TrackPlayer.addEventListener(Event.RemoteNext, () => {
    console.log("[PlaybackService] RemoteNext");
    const st = usePlaybackStore.getState();
    if (st.chapters && st.chapters.length > 1) st.nextChapter().catch(() => {});
    // No chapters + casting: skip the RECEIVER's queue item — skipping the
    // paused local player would silently desync the two.
    else if (st.isCasting && st.castClient) st.castClient.queueNext().catch(() => {});
    else TrackPlayer.skipToNext().catch(() => {});
  });

  TrackPlayer.addEventListener(Event.RemotePrevious, () => {
    console.log("[PlaybackService] RemotePrevious");
    const st = usePlaybackStore.getState();
    if (st.chapters && st.chapters.length > 1) st.previousChapter().catch(() => {});
    else if (st.isCasting && st.castClient) st.castClient.queuePrev().catch(() => {});
    else TrackPlayer.skipToPrevious().catch(() => {});
  });

  TrackPlayer.addEventListener(Event.RemoteJumpForward, (event) => {
    console.log(`[PlaybackService] RemoteJumpForward by ${event.interval}s`);
    // Route through the store so chapter-queue absolute positioning is honored.
    usePlaybackStore.getState().seekForward(event.interval || 10).catch(() => {});
  });

  TrackPlayer.addEventListener(Event.RemoteJumpBackward, (event) => {
    console.log(`[PlaybackService] RemoteJumpBackward by ${event.interval}s`);
    usePlaybackStore.getState().seekBackward(event.interval || 10).catch(() => {});
  });

  // Notification/Auto seekbar. Route through the store (not TrackPlayer
  // directly) so the seek gets clamping, cast routing, and the crash-safe
  // immediate position save. In a chapter queue the remote seekbar is
  // CHAPTER-relative (each queue item is a clipped chapter), so map it to the
  // absolute book position the store expects.
  TrackPlayer.addEventListener(Event.RemoteSeek, (event) => {
    console.log(`[PlaybackService] RemoteSeek to ${event.position}s`);
    // The store maps the (track-relative) seekbar position to an absolute book
    // position for both chapter queues AND multi-file books before seeking.
    usePlaybackStore.getState().remoteSeek(event.position || 0).catch(() => {});
  });
}
