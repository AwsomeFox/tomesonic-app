import { DeviceEventEmitter } from "react-native";
import TrackPlayer, { Event } from "react-native-track-player";
import { usePlaybackStore, onNativeProgressSample } from "./usePlaybackStore";

// Cycles through the same set the in-app speed control offers.
const SPEEDS = [0.8, 1.0, 1.2, 1.5, 1.75, 2.0, 3.0];

export async function playbackService() {
  // HEADLESS BOOT (Android Auto cold start): this service can be the first —
  // and only — JS to run, with App.tsx never mounted. Load the downloads DB
  // here so preparePlaybackSession can prefer local files in the car (poor
  // signal is exactly when this matters). Idempotent and cheap (MMKV read).
  try {
    const { useDownloadStore } = require("./useDownloadStore");
    useDownloadStore.getState().loadDownloadsFromDb();
  } catch (e) {
    console.warn("[PlaybackService] headless downloads load failed", e);
  }

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

  // Route remote (notification / Android Auto / bluetooth) transport through the
  // store, not TrackPlayer directly, so play() applies auto-rewind and pause()
  // flushes a progress sync to the server (otherwise remote pauses never sync).
  TrackPlayer.addEventListener(Event.RemotePlay, () => {
    console.log("[PlaybackService] RemotePlay");
    const s = usePlaybackStore.getState();
    // While casting the LOCAL player sits paused, so the notification only
    // ever offers a play button — treat it as a toggle so the user can still
    // pause the receiver from the notification.
    if (s.isCasting && s.isPlaying) s.pause();
    else s.play();
  });

  TrackPlayer.addEventListener(Event.RemotePause, () => {
    console.log("[PlaybackService] RemotePause");
    usePlaybackStore.getState().pause();
  });

  // Stop = user dismissed playback: close the ABS session (final sync) and clear.
  TrackPlayer.addEventListener(Event.RemoteStop, () => {
    console.log("[PlaybackService] RemoteStop");
    usePlaybackStore.getState().closePlayback();
  });

  // Android Auto browse → tap-to-play. Native emits remote-play-id with the ABS
  // item id (or "itemId::episodeId" for podcasts); run the full JS startPlayback
  // so the car gets the real queue, chapters, title/subtitle, artwork, progress
  // sync and transport buttons — the same session the phone would build.
  TrackPlayer.addEventListener(Event.RemotePlayId, async (event: any) => {
    const raw = String(event?.id ?? "");
    console.log(`[PlaybackService] RemotePlayId ${raw}`);
    if (!raw) return;
    // A "@@<seconds>" suffix (from the Android Auto Bookmarks row) means: start
    // this book, then seek to the bookmark's time.
    const [main, bookmarkTime] = raw.split("@@");
    const [itemId, episodeId] = main.split("::");
    try {
      const ok = await usePlaybackStore.getState().startPlayback(itemId, episodeId || undefined);
      if (ok && bookmarkTime) {
        const t = Number(bookmarkTime);
        if (!isNaN(t) && t > 0) await usePlaybackStore.getState().seek(t);
      }
    } catch (e) {
      console.log("[PlaybackService] RemotePlayId failed", e);
    }
  });

  // Next/Previous map to chapters when the current book has them (matches the
  // original Android Auto behaviour), otherwise fall back to queue navigation.
  TrackPlayer.addEventListener(Event.RemoteNext, () => {
    console.log("[PlaybackService] RemoteNext");
    const st = usePlaybackStore.getState();
    if (st.chapters && st.chapters.length > 1) st.nextChapter();
    // No chapters + casting: skip the RECEIVER's queue item — skipping the
    // paused local player would silently desync the two.
    else if (st.isCasting && st.castClient) st.castClient.queueNext().catch(() => {});
    else TrackPlayer.skipToNext().catch(() => {});
  });

  TrackPlayer.addEventListener(Event.RemotePrevious, () => {
    console.log("[PlaybackService] RemotePrevious");
    const st = usePlaybackStore.getState();
    if (st.chapters && st.chapters.length > 1) st.previousChapter();
    else if (st.isCasting && st.castClient) st.castClient.queuePrev().catch(() => {});
    else TrackPlayer.skipToPrevious().catch(() => {});
  });

  TrackPlayer.addEventListener(Event.RemoteJumpForward, (event) => {
    console.log(`[PlaybackService] RemoteJumpForward by ${event.interval}s`);
    // Route through the store so chapter-queue absolute positioning is honored.
    usePlaybackStore.getState().seekForward(event.interval || 10);
  });

  TrackPlayer.addEventListener(Event.RemoteJumpBackward, (event) => {
    console.log(`[PlaybackService] RemoteJumpBackward by ${event.interval}s`);
    usePlaybackStore.getState().seekBackward(event.interval || 10);
  });

  // Notification/Auto seekbar. Route through the store (not TrackPlayer
  // directly) so the seek gets clamping, cast routing, and the crash-safe
  // immediate position save. In a chapter queue the remote seekbar is
  // CHAPTER-relative (each queue item is a clipped chapter), so map it to the
  // absolute book position the store expects.
  TrackPlayer.addEventListener(Event.RemoteSeek, async (event) => {
    console.log(`[PlaybackService] RemoteSeek to ${event.position}s`);
    const st = usePlaybackStore.getState();
    if (st.chapterQueue && st.chapters?.length) {
      // While casting the local active index is the stale handoff item —
      // currentChapterIndex tracks the RECEIVER's chapter, which is the one
      // the user is actually listening to.
      const active = st.isCasting
        ? st.currentChapterIndex
        : (await TrackPlayer.getActiveTrackIndex().catch(() => null)) ?? st.currentChapterIndex;
      const abs = (st.chapters[active]?.start || 0) + (event.position || 0);
      st.seek(abs);
    } else {
      st.seek(event.position || 0);
    }
  });
}
