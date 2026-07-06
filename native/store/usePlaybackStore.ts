import { create } from "zustand";
import TrackPlayer, { Capability, State, AppKilledPlaybackBehavior } from "react-native-track-player";
import { storageHelper, storage } from "../utils/storage";
import { api } from "../utils/api";
import { useUserStore } from "./useUserStore";
import { syncProgress, closeSession, queueProgressPatch } from "../utils/progressSync";
import { writeWidgetState } from "../utils/autoCreds";

// Records when playback was paused so play() can apply the "auto rewind" nudge
// (rewind a little on resume, scaled by how long you were away).
let _lastPausedAt: number | null = null;

// --- Server progress sync bookkeeping (module-level, one active session at a time) ---
// Seconds of actual listening accumulated since the last successful/queued sync.
let _timeListenedAccum = 0;
// Wall-clock timestamp (ms) of the previous progress tick, used to measure real
// elapsed time between ticks (capped so backgrounding doesn't inflate it).
let _lastTickAt: number | null = null;
// Wall-clock timestamp (ms) this session's accumulator last flushed to the server.
let _lastSyncAt = 0;
// Throttle the MMKV setLastPlaybackSession write (currently called every tick).
let _lastLocalSaveAt = 0;
// Session id that has already been marked finished server-side, so we don't
// re-fire the PATCH every tick once the book is done.
let _finishedSessionId: string | null = null;
// In-flight initializePlayer() — shared so concurrent callers can't each
// start their own progress interval.
let _initPromise: Promise<void> | null = null;
// Session generation: bumped by every preparePlaybackSession and closePlayback.
// In-flight prepares check it after each await so a concurrent prepare of a
// DIFFERENT book (or a close) can't interleave player mutations — previously
// two rapid taps on different books merged both queues, and a close during a
// slow prepare resurrected the closed session.
let _sessionGen = 0;
// Absolute start offset (s) per queue item for MULTI-FILE (non-chapter-queue)
// books. RNTP's getProgress/seekTo are per-active-track; without these the
// tick treated track-relative positions as book-absolute (duration collapsed
// to the current file, auto-finish fired at the end of file 1).
let _trackOffsets: number[] = [];
// Handle for the 1s player→store sync loop, kept module-level so a double init
// can't leak a second interval (which would double-count listened time).
let progressInterval: ReturnType<typeof setInterval> | null = null;

const SYNC_INTERVAL_MS = 15000;
const LOCAL_SAVE_INTERVAL_MS = 5000;
const MAX_TICK_DELTA_S = 2;
// How many seconds before the sleep timer fires we start fading the volume out.
const SLEEP_FADE_SECONDS = 20;
function autoRewindSeconds(pausedForMs: number): number {
  const s = pausedForMs / 1000;
  if (s < 10) return 0;
  if (s < 60) return 2;
  if (s < 60 * 30) return 10;
  if (s < 60 * 60 * 6) return 20;
  return 30;
}

// The full RNTP options object. IMPORTANT: RNTP rebuilds the entire Android Auto
// custom layout on every updateOptions call, so we must ALWAYS pass the complete
// capabilities set — a partial call (e.g. just jump intervals) would wipe the
// transport/chapter buttons, leaving only the speed button.
function buildPlayerOptions() {
  const s = useUserStore.getState().settings;
  return {
    android: {
      appKilledPlaybackBehavior: AppKilledPlaybackBehavior.StopPlaybackAndRemoveNotification,
    },
    // NOTE: no icon/notificationIcon here — RNTP 5 (Media3) ignores those JS
    // options entirely. The media-notification small icon is set by overriding
    // the media3_notification_small_icon drawable at the app level (see
    // plugins/withMedia3NotificationIcon.js).
    forwardJumpInterval: s.jumpForwardTime ?? 10,
    backwardJumpInterval: s.jumpBackwardTime ?? 10,
    // Native progress events every second — the background-proof persistence
    // driver (see onNativeProgressSample). Emitted by the Media3 service's
    // own timer, so they keep flowing while Android throttles JS timers.
    progressUpdateEventInterval: 1,
    capabilities: [
      Capability.Play,
      Capability.Pause,
      Capability.Stop,
      Capability.SeekTo,
      Capability.JumpForward,
      Capability.JumpBackward,
      // Enables the Next/Previous buttons in Android Auto, which we repurpose
      // as next/previous chapter (handled in playbackService).
      Capability.SkipToNext,
      Capability.SkipToPrevious,
    ],
  };
}

// Re-push the configured jump intervals (plus the full capability set) to RNTP.
export async function applyJumpOptions() {
  try {
    await TrackPlayer.updateOptions(buildPlayerOptions());
  } catch {}
}


// Pushes the current chapter as the now-playing title so Android Auto / the
// notification show "Chapter N" with a "Book • Author" subtitle (matching the
// original app), instead of the raw audio file name. No-op when the book has
// no chapters. Tracks the last-applied chapter to avoid redundant native calls.
let _lastMetaChapter = -2;
// Local queue index whose metadata applyNowPlayingChapter last overrode — so a
// cast disconnect can restore that item's true chapter title (while casting the
// paused LOCAL item gets rewritten to whatever chapter the RECEIVER is in).
let _metaAppliedIndex = -1;
// Dedupe rapid duplicate startPlayback calls (Android Auto double-dispatch).
let _lastStartKey = "";
let _lastStartAt = 0;
async function applyNowPlayingChapter(session: any, chapters: any[], chapterIndex: number) {
  if (!session) return;
  if (chapterIndex === _lastMetaChapter) return;
  try {
    const activeIndex = await TrackPlayer.getActiveTrackIndex();
    if (activeIndex == null) return;
    const book = session.displayTitle || "Audiobook";
    const author = session.displayAuthor || "";
    const ch = chapters?.[chapterIndex];
    const title = ch?.title || book;
    const subtitle = ch ? [book, author].filter(Boolean).join(" • ") : author;
    const meta: any = { title, artist: subtitle };
    if (session.coverUrl) meta.artwork = session.coverUrl;
    await TrackPlayer.updateMetadataForTrack(activeIndex, meta);
    // Mark applied only AFTER the native call succeeds — marking up front
    // meant a throw here (track not ready yet) was never retried, leaving the
    // previous chapter's title stuck for the whole chapter.
    _lastMetaChapter = chapterIndex;
    _metaAppliedIndex = activeIndex;
  } catch (e) {
    // Track not ready yet — the progress loop retries on the next tick.
  }
}

// Undo the cast-time metadata override on the local queue: with a chapter
// queue each item's intrinsic title IS its chapter, but while casting the
// progress loop rewrites the paused active item to track the receiver's
// chapter. Called by CastController on disconnect so the local notification
// doesn't show a stale (wrong-chapter) title after handback.
export async function restoreLocalNowPlayingMeta() {
  const st = usePlaybackStore.getState();
  _lastMetaChapter = -2; // single-track fallback: progress loop re-applies next tick
  const idx = _metaAppliedIndex;
  _metaAppliedIndex = -1;
  if (idx < 0 || !st.chapterQueue) return;
  const s = st.currentSession;
  const ch = st.chapters?.[idx];
  if (!s || !ch) return;
  try {
    const book = s.displayTitle || "Audiobook";
    const author = s.displayAuthor || "";
    const meta: any = {
      title: ch.title || `Chapter ${idx + 1}`,
      artist: [book, author].filter(Boolean).join(" • "),
    };
    if (s.coverUrl) meta.artwork = s.coverUrl;
    await TrackPlayer.updateMetadataForTrack(idx, meta);
  } catch {}
}

// Surfaces a play failure to the user — every play button in the app funnels
// through startPlayback, and a silent `return false` read as "tap did
// nothing". Alert is the app's established feedback pattern; in headless
// contexts (Android Auto) there's no activity, so it safely no-ops.
function alertPlayFailure(message: string) {
  try {
    const { Alert } = require("react-native");
    Alert.alert("Couldn't play", message);
  } catch {}
}

// Called after a token refresh (see api.ts applyRefreshedConfig): the live
// session's coverUrl — and the artwork Media3 is showing — may carry the
// ROTATED-OUT token, so its next fetch 401s and the notification loses its
// album art. Rebuild the URL with the fresh token and force the progress
// loop to re-push the now-playing metadata (which includes the artwork).
export function refreshNowPlayingArtwork() {
  try {
    const st = usePlaybackStore.getState();
    const session = st.currentSession;
    if (!session) return;
    const coverUrl: string | undefined = session.coverUrl;
    // Local file artwork can't go stale.
    if (!coverUrl || !coverUrl.startsWith("http")) return;
    const config = storageHelper.getServerConfig();
    const token = config?.token;
    if (!token || coverUrl.includes(`token=${token}`)) return;
    const freshened = coverUrl.replace(/([?&])token=[^&]*/, `$1token=${token}`);
    usePlaybackStore.setState({ currentSession: { ...session, coverUrl: freshened } });
    _lastMetaChapter = -2; // next 1s tick re-applies metadata incl. artwork
  } catch {}
}

// Persists one playback progress sample: listening-time accounting, the
// crash-safe MMKV save (throttled), the global mediaProgress mirror, the
// periodic server sync, and the near-end auto-finish. Shared by BOTH drivers:
// the JS 1s interval (foreground) and the NATIVE PlaybackProgressUpdated
// event (see onNativeProgressSample) — Android throttles JS timers in the
// background, so with only the interval a backgrounded session could go
// MINUTES without a save/sync and a process kill lost all of it.
function persistProgressSample(
  currentSession: any,
  absolutePosition: number,
  bookDuration: number,
  isPlayerPlaying: boolean
) {
  // Accumulate real elapsed listening time (only while actually playing),
  // capped per tick so backgrounding/suspension doesn't inflate it into a
  // huge jump once ticks resume.
  const now = Date.now();
  if (isPlayerPlaying && _lastTickAt != null) {
    const deltaS = Math.min(MAX_TICK_DELTA_S, Math.max(0, (now - _lastTickAt) / 1000));
    _timeListenedAccum += deltaS;
  }
  _lastTickAt = now;

  // Auto-save progress to local storage, throttled to ~5s to reduce
  // flash wear (this loop ticks every 1s). ONLY WHILE PLAYING: a
  // paused player's position isn't new information, and re-stamping
  // `updatedAt` every tick made a device idling on the last-played
  // book "fresher" than real listening happening on another device,
  // poisoning every freshest-wins comparison (resume + shelf
  // display could never adopt the other device's progress).
  // User-initiated changes while paused (seeks) persist through
  // saveSessionPositionNow, where a fresh stamp IS correct.
  if (currentSession && isPlayerPlaying) {
    if (now - _lastLocalSaveAt >= LOCAL_SAVE_INTERVAL_MS) {
      _lastLocalSaveAt = now;
      const updatedSession = {
        ...currentSession,
        currentTime: absolutePosition,
        updatedAt: now,
      };
      storageHelper.setLastPlaybackSession(updatedSession);
    }

    // Update global mediaProgress map in useUserStore for UI binding.
    // Preserve the finished flag once this session has been marked
    // finished, otherwise this per-tick write would clobber it back
    // to false on the next tick. NOTE: merged over the existing entry
    // below — replacing it wholesale would drop the EBOOK fields
    // (ebookProgress/ebookLocation) while listening to a both-format
    // book.
    const alreadyFinished = _finishedSessionId === currentSession.id;
    // Podcast EPISODES key the map by `${itemId}-${episodeId}` (the
    // same convention as /api/me) — a plain-itemId write for an
    // episode would pollute the map with a bogus item-level entry.
    const sessionEpisodeId = currentSession.episodeId || null;
    const progressMapKey = sessionEpisodeId
      ? `${currentSession.libraryItemId}-${sessionEpisodeId}`
      : currentSession.libraryItemId;
    const progressObj = {
      libraryItemId: currentSession.libraryItemId,
      ...(sessionEpisodeId ? { episodeId: sessionEpisodeId } : {}),
      currentTime: absolutePosition,
      duration: bookDuration,
      progress: bookDuration > 0 ? Math.min(1, absolutePosition / bookDuration) : 0,
      isFinished: alreadyFinished,
      updatedAt: now,
    };
    useUserStore.setState({
      mediaProgress: {
        ...useUserStore.getState().mediaProgress,
        [progressMapKey]: {
          ...useUserStore.getState().mediaProgress[progressMapKey],
          ...progressObj,
        },
      },
    });

    // Periodic server sync — every ~15s of accumulated listening.
    if (currentSession.id && now - _lastSyncAt >= SYNC_INTERVAL_MS && _timeListenedAccum > 0) {
      const toSync = _timeListenedAccum;
      _timeListenedAccum = 0;
      _lastSyncAt = now;
      syncProgress({
        sessionId: currentSession.id,
        currentTime: absolutePosition,
        timeListened: toSync,
        duration: bookDuration,
        libraryItemId: currentSession.libraryItemId,
        episodeId: sessionEpisodeId || undefined,
      }).catch(() => {});
    }

    // Auto mark-finished: within 5s of the end of the book/episode,
    // once per session. Fires the isFinished PATCH and updates local
    // state. Podcast episodes PATCH the episode-scoped endpoint and
    // key the map by the composite id — an item-level PATCH would
    // create bogus whole-podcast progress on the server.
    const libraryItemId = currentSession.libraryItemId;
    if (
      bookDuration > 0 &&
      absolutePosition >= bookDuration - 5 &&
      libraryItemId &&
      _finishedSessionId !== currentSession.id
    ) {
      _finishedSessionId = currentSession.id;
      const patchPath = sessionEpisodeId
        ? `/api/me/progress/${encodeURIComponent(libraryItemId)}/${encodeURIComponent(sessionEpisodeId)}`
        : `/api/me/progress/${encodeURIComponent(libraryItemId)}`;
      api
        .patch(patchPath, {
          currentTime: bookDuration,
          duration: bookDuration,
          progress: 1,
          isFinished: true,
        })
        .catch(() => {
          // Offline finish must still land once connectivity returns —
          // otherwise a book finished on a plane never gets marked.
          queueProgressPatch(libraryItemId, bookDuration, bookDuration, sessionEpisodeId, {
            isFinished: true,
          });
        });
      useUserStore.setState({
        mediaProgress: {
          ...useUserStore.getState().mediaProgress,
          [progressMapKey]: {
            ...useUserStore.getState().mediaProgress[progressMapKey],
            libraryItemId,
            ...(sessionEpisodeId ? { episodeId: sessionEpisodeId } : {}),
            currentTime: bookDuration,
            duration: bookDuration,
            progress: 1,
            isFinished: true,
            updatedAt: now,
          },
        },
      });
    }
  }
}

// NATIVE-driven progress persistence. RNTP emits PlaybackProgressUpdated
// from the Media3 service's own timer, which keeps firing while Android
// throttles JS timers in the background — the same delivery path that keeps
// notification buttons working. Feeding those samples through the SAME
// persistence pipeline as the JS interval means a backgrounded session keeps
// saving locally and syncing to the server, so a process kill (app update,
// LMK) can no longer lose minutes of listening. Both drivers share the
// throttling bookkeeping (_lastLocalSaveAt/_lastSyncAt/_lastTickAt), so
// running together in the foreground double-drives nothing.
export function onNativeProgressSample(e: {
  position: number;
  duration: number;
  track?: number;
}) {
  try {
    const st = usePlaybackStore.getState();
    const currentSession = st.currentSession;
    // While casting the receiver is the source of truth — the local player's
    // progress events (paused handoff item) must not clobber the mirror.
    if (!currentSession || st.isCasting) return;
    if (!Number.isFinite(e?.position) || e.position < 0) return;

    const chapters = st.chapters;
    let absolutePosition = e.position;
    let bookDuration = e.duration || st.duration;
    let chapterIndex = -1;

    if (st.chapterQueue && chapters.length) {
      // Chapter-clipped queue: the event position is chapter-relative and the
      // track index IS the chapter.
      if (typeof e.track === "number" && chapters[e.track]) {
        chapterIndex = e.track;
        absolutePosition = (chapters[e.track].start || 0) + e.position;
      } else {
        return; // can't map reliably mid-transition — skip this sample
      }
      bookDuration = st.duration || bookDuration;
    } else {
      if (
        _trackOffsets.length > 1 &&
        typeof e.track === "number" &&
        _trackOffsets[e.track] != null
      ) {
        absolutePosition = _trackOffsets[e.track] + e.position;
        bookDuration = st.duration || bookDuration;
      }
      for (let i = 0; i < chapters.length; i++) {
        if (absolutePosition >= chapters[i].start && absolutePosition < chapters[i].end) {
          chapterIndex = i;
          break;
        }
      }
    }

    usePlaybackStore.setState({
      position: absolutePosition,
      duration: bookDuration,
      isPlaying: true, // the event only fires while playing
      currentChapterIndex: chapterIndex,
    });
    persistProgressSample(currentSession, absolutePosition, bookDuration, true);
  } catch {}
}

// The store's `position` is written by a 1s JS interval that Android
// throttles while the app is backgrounded/dozing — the native player keeps
// advancing while the snapshot freezes, so a notification jump computed from
// it can leap MINUTES instead of one interval. Relative seeks must read the
// LIVE player position (mapped to absolute book seconds for chapter queues).
// While casting, the receiver mirror in the store is the only truth we have.
async function getLiveAbsolutePosition(get: () => PlaybackState): Promise<number> {
  const { isCasting, chapterQueue, chapters } = get();
  if (isCasting) return get().position;
  try {
    const progress = await TrackPlayer.getProgress();
    if (chapterQueue && chapters.length) {
      const activeIndex = await TrackPlayer.getActiveTrackIndex();
      if (activeIndex != null && chapters[activeIndex]) {
        return (chapters[activeIndex].start || 0) + progress.position;
      }
      // Mid track-transition the index can be unknown — a chapter-relative
      // position would be wildly wrong as an absolute, so fall back.
      return get().position;
    }
    // Multi-file queue: RNTP's position is FILE-relative — map it through the
    // active track's offset (same as the 1s loop), or chapter navigation and
    // seekForward/Backward in file 2+ act on a near-book-start position.
    if (_trackOffsets.length > 1) {
      const activeIndex = await TrackPlayer.getActiveTrackIndex();
      if (activeIndex != null && _trackOffsets[activeIndex] != null) {
        return _trackOffsets[activeIndex] + progress.position;
      }
      return get().position;
    }
    return progress.position;
  } catch {
    return get().position; // player not ready — the snapshot is the best we have
  }
}

// Immediately persist the current session position to MMKV, bypassing the 5s
// throttle — called on seek/pause so an app kill right after either can lose
// at most a moment of progress (the 1s loop alone leaves a 5s window).
function saveSessionPositionNow(position: number) {
  try {
    const s = usePlaybackStore.getState().currentSession;
    if (!s) return;
    const now = Date.now();
    _lastLocalSaveAt = now;
    storageHelper.setLastPlaybackSession({ ...s, currentTime: position, updatedAt: now });
  } catch {}
}

// --- Playback-error recovery -------------------------------------------------
// A mid-stream ExoPlayer error (network drop during doze, server blip) leaves
// the player IDLE: it will NOT resume by itself, and a plain play() on an
// errored player is a no-op — historically playback just died silently with
// the screen off. On PlaybackError we persist the position, correct the
// store's isPlaying, and arm a bounded retry (TrackPlayer.retry() re-prepares
// the current item at its current position). App foreground / connectivity
// regained also funnel into recoverPlaybackIfNeeded, since background JS
// timers are throttled and may fire late.
const ERROR_RETRY_DELAYS_MS = [2000, 10000, 30000];
let _errorRecovery: {
  resume: boolean; // was playback active when the error hit?
  attempts: number;
  timer: ReturnType<typeof setTimeout> | null;
} | null = null;

function clearErrorRecovery() {
  if (_errorRecovery?.timer) clearTimeout(_errorRecovery.timer);
  _errorRecovery = null;
}

function scheduleErrorRetry() {
  if (!_errorRecovery) return;
  // Out of automatic attempts — a manual play (see play()) or a
  // foreground/connectivity recover call can still finish the job.
  if (_errorRecovery.attempts >= ERROR_RETRY_DELAYS_MS.length) return;
  const delay = ERROR_RETRY_DELAYS_MS[_errorRecovery.attempts++];
  _errorRecovery.timer = setTimeout(() => {
    recoverPlaybackIfNeeded().catch(() => {});
  }, delay);
}

// Called by playbackService on Event.PlaybackError.
export function onPlaybackError(e?: { code?: string; message?: string }) {
  const st = usePlaybackStore.getState();
  // No session to recover, or the receiver owns playback (a local player
  // error while casting is irrelevant — it sits paused on the handoff item).
  if (!st.currentSession || st.isCasting) return;
  console.warn("[PlaybackStore] PlaybackError", e?.code, e?.message);
  const wasPlaying = st.isPlaying;
  // The store position stays ~1s fresh even backgrounded (native progress
  // events) — persist it now so a process kill during the outage can't lose
  // it, and so a cold-start restore resumes where the stream died.
  saveSessionPositionNow(st.position);
  usePlaybackStore.setState({ isPlaying: false });
  clearErrorRecovery();
  // Auto-retry only when the error interrupted ACTIVE listening — an errored
  // player that was already paused stays down until the user's next play()
  // (which re-prepares an errored player itself).
  if (wasPlaying) {
    _errorRecovery = { resume: true, attempts: 0, timer: null };
    scheduleErrorRetry();
  }
}

// Re-prepares an errored player and resumes if the error interrupted active
// playback. Safe to call any time — it no-ops unless an unrecovered error is
// pending. Returns true when a recovery actually ran.
export async function recoverPlaybackIfNeeded(): Promise<boolean> {
  const rec = _errorRecovery;
  const st = usePlaybackStore.getState();
  if (!rec || !st.currentSession || st.isCasting) return false;
  if (rec.timer) {
    clearTimeout(rec.timer);
    rec.timer = null;
  }
  try {
    // Only intervene if the player is actually dead — it can recover on its
    // own (Media3 retries some load errors internally) between the error and
    // this call.
    const ps: any = await TrackPlayer.getPlaybackState().catch(() => null);
    if (ps && ps.state !== State.Error && ps.state !== State.None) {
      _errorRecovery = null;
      return false;
    }
    await TrackPlayer.retry();
    if (rec.resume) {
      await TrackPlayer.play();
      usePlaybackStore.setState({ isPlaying: true });
    }
    _errorRecovery = null;
    return true;
  } catch (err) {
    // Still down (e.g. network not back yet) — keep backing off.
    scheduleErrorRetry();
    return false;
  }
}

interface PlaybackState {
  currentSession: any | null;
  isPlaying: boolean;
  isInitialized: boolean;
  playbackSpeed: number;
  duration: number;
  position: number;
  chapters: any[];
  currentChapterIndex: number;
  // True when the RNTP queue is built from chapters (one clipped item per
  // chapter) so Android Auto shows a real chapter queue. `position`/`duration`
  // remain absolute book seconds regardless.
  chapterQueue: boolean;

  // Chromecast — when a session is active, transport routes to the cast client.
  isCasting: boolean;
  castClient: any | null;
  setCastState: (client: any | null) => void;
  // Absolute-position seek handler registered by CastController. The raw cast
  // client can only seek within the CURRENT queue item; this handler maps an
  // absolute book position to the right track (reloading the queue when the
  // target lies in a different file).
  castSeekAbs: ((absSeconds: number) => Promise<void>) | null;
  setCastSeekHandler: (fn: ((absSeconds: number) => Promise<void>) | null) => void;

  // Sleep timer
  sleepTimer: {
    endOfChapter: boolean;
    remaining: number; // seconds left, or seconds until end of chapter
    // Chapter the end-of-chapter timer was armed in — lets the tick detect
    // the boundary crossing even if a tick lands just past it.
    chapterIdx?: number;
  } | null;

  // Actions
  initializePlayer: () => Promise<void>;
  startPlayback: (itemId: string, episodeId?: string) => Promise<boolean>;
  preparePlaybackSession: (session: any, playWhenReady?: boolean) => Promise<boolean>;
  playPause: () => Promise<void>;
  play: () => Promise<void>;
  pause: () => Promise<void>;
  seek: (value: number) => Promise<void>;
  seekForward: (value: number) => Promise<void>;
  seekBackward: (value: number) => Promise<void>;
  seekToChapter: (index: number) => Promise<void>;
  nextChapter: () => Promise<void>;
  previousChapter: () => Promise<void>;
  setPlaybackSpeed: (speed: number) => Promise<void>;
  setSleepTimer: (seconds: number, endOfChapter?: boolean) => void;
  cancelSleepTimer: () => void;
  closePlayback: () => Promise<void>;
  isPlayerExpanded: boolean;
  setPlayerExpanded: (expanded: boolean) => void;
  loadLastSession: () => Promise<void>;
  onTabScreen: boolean;
  setOnTabScreen: (isTab: boolean) => void;
}

// Wall-clock stamp of the previous sleep tick. Android throttles JS timers in
// the background, so ticks can arrive many seconds apart — fixed timers must
// subtract REAL elapsed time (while playing), not 1s per tick, or a 30-minute
// timer stretches far past 30 minutes with the screen off.
let _sleepLastTickAt: number | null = null;

// Ticks the sleep-timer countdown once per second, independent of the player
// progress poll. Pauses playback when it hits zero.
let sleepTimerInterval: ReturnType<typeof setInterval> | null = null;

export const usePlaybackStore = create<PlaybackState>((set, get) => ({
  currentSession: null,
  isPlaying: false,
  isInitialized: false,
  playbackSpeed: 1.0,
  duration: 0,
  position: 0,
  chapters: [],
  currentChapterIndex: -1,
  chapterQueue: false,
  isCasting: false,
  castClient: null,
  sleepTimer: null,
  isPlayerExpanded: false,
  setPlayerExpanded: (expanded: boolean) => set({ isPlayerExpanded: expanded }),
  onTabScreen: true,
  setOnTabScreen: (isTab: boolean) => set({ onTabScreen: isTab }),

  setCastState: (client) => {
    // Dropping the client also drops the seek handler (it closes over it).
    set({
      castClient: client || null,
      isCasting: !!client,
      ...(client ? {} : { castSeekAbs: null }),
    });
  },

  castSeekAbs: null,
  setCastSeekHandler: (fn) => set({ castSeekAbs: fn }),

  loadLastSession: async () => {
    const serverConfig = storageHelper.getServerConfig();
    if (!serverConfig || !serverConfig.token || !serverConfig.address) {
      console.log("[PlaybackStore] No active authenticated session, skipping session load.");
      return;
    }
    const session = storageHelper.getLastPlaybackSession();
    if (session) {
      console.log("[PlaybackStore] Found saved session, restoring...");
      // Cross-device freshness: if another device listened further since this
      // local save, prefer the server's position. Best-effort and capped at
      // 3s so a slow/unreachable server never delays app startup.
      try {
        const itemId = session.libraryItemId || session.libraryItem?.id;
        if (itemId) {
          // Podcast progress is keyed per EPISODE server-side — the item-level
          // GET returns nothing useful for an episode session.
          const progressPath = session.episodeId
            ? `/api/me/progress/${itemId}/${session.episodeId}`
            : `/api/me/progress/${itemId}`;
          const res: any = await Promise.race([
            api.get(progressPath),
            new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 3000)),
          ]);
          const p = res?.data;
          const serverUpdatedAt = Number(p?.lastUpdate) || 0;
          const localUpdatedAt = Number(session.updatedAt) || 0;
          if (
            p &&
            typeof p.currentTime === "number" &&
            serverUpdatedAt > localUpdatedAt + 10000 &&
            Math.abs(p.currentTime - (session.currentTime || 0)) > 2
          ) {
            console.log(
              `[PlaybackStore] Server progress is fresher (${p.currentTime}s vs ${session.currentTime}s) — resuming from server.`
            );
            session.currentTime = p.currentTime;
            session.updatedAt = serverUpdatedAt;
            // Persist the adopted position — preparePlaybackSession re-reads
            // the MMKV save for its own freshest-wins pass, and without this
            // write it would see the STALE local save (mediaProgress may not
            // be loaded yet at cold start → server side falls back to 0) and
            // reverse the decision just made here.
            try {
              storageHelper.setLastPlaybackSession({ ...session });
            } catch {}
          }
        }
      } catch {
        // Offline / timeout — the local save stands.
      }
      try {
        await get().preparePlaybackSession(session, false);
      } catch (err) {
        console.error("[PlaybackStore] loadLastSession failed:", err);
      }
    }
  },

  initializePlayer: async () => {
    if (get().isInitialized) return;
    // Concurrent callers (e.g. Android Auto double-dispatch racing an in-app
    // play) must share ONE init — otherwise two 1s progress intervals leak.
    if (_initPromise) return _initPromise;
    _initPromise = (async () => {

    try {
      await TrackPlayer.setupPlayer({
        // ExoPlayer wake mode 2 = WAKE_MODE_NETWORK: hold a partial wake lock
        // AND a WiFi lock while playback is active. Without it the default is
        // WAKE_MODE_NONE, so once the screen turns off and the device dozes,
        // the CPU/WiFi are allowed to suspend mid-stream — playback stalls,
        // eventually stops, and unlocking the phone finds a dead player that
        // has to rebuffer. Locks are only held while playing, so there's no
        // idle battery cost. (Not in RNTP's TS PlayerOptions type, but the
        // module passes the whole object through to the native service, which
        // reads `androidWakeMode` — made Double-safe in our RNTP patch.)
        androidWakeMode: 2,
        // Buffer headroom for streaming: ExoPlayer's 50s default means any
        // network wobble longer than ~a minute of buffered audio stalls
        // playback. Five minutes of buffer rides out doze-window network
        // flaps; 30s of back-buffer keeps the auto-rewind nudge (up to 30s)
        // instantly seekable without refetching.
        minBuffer: 60,
        maxBuffer: 300,
        backBuffer: 30,
        // 256MB LRU disk cache (app cacheDir) over streamed audio. Chapter
        // queues clip MANY items out of ONE file URL, and every chapter
        // boundary re-opens that URL — a fresh network fetch at exactly the
        // moment the doze-throttled network is least reliable (the classic
        // "book stopped at the end of a chapter overnight"). With the cache,
        // boundary loads (and auto-rewind/chapter jumps into recent audio)
        // hit disk instead.
        maxCacheSize: 256 * 1024,
      } as any);
      await TrackPlayer.updateOptions(buildPlayerOptions());
      
      set({ isInitialized: true });
      console.log("[PlaybackStore] TrackPlayer initialized successfully.");

      // Sync player state to Zustand reactively. Guard against a second interval
      // (e.g. a double init across a Fast Refresh) and skip the native
      // round-trips entirely when no session is loaded so we don't poll the
      // player while idle.
      if (progressInterval) clearInterval(progressInterval);
      progressInterval = setInterval(async () => {
        if (!get().isInitialized || !get().currentSession) return;
        try {
          const chapters = get().chapters;
          const chapterQueue = get().chapterQueue;
          const casting = get().isCasting;

          let absolutePosition: number;
          let bookDuration: number;
          let isPlayerPlaying: boolean;
          let chapterIndex = -1;

          if (casting) {
            // While casting the RECEIVER is the source of truth —
            // CastController mirrors its progress/play-state into the store.
            // Reading the (paused) local player here would overwrite the cast
            // position every tick and rubber-band the scrubber. We still run
            // the persistence tail below so listening time accrues and the
            // position keeps saving/syncing during a cast session.
            absolutePosition = get().position;
            bookDuration = get().duration;
            isPlayerPlaying = get().isPlaying;
            for (let i = 0; i < chapters.length; i++) {
              if (absolutePosition >= chapters[i].start && absolutePosition < chapters[i].end) {
                chapterIndex = i;
                break;
              }
            }
            if (chapterIndex !== get().currentChapterIndex) {
              set({ currentChapterIndex: chapterIndex });
            }
            // The cast framework's own notification is suppressed (see
            // plugins/withCastSingleNotification), so the app's normal media
            // notification is the single control surface — keep its title
            // tracking the RECEIVER's chapter ("Chapter" / "Book • Author").
            // Works in both queue modes: the local player sits paused on the
            // handoff item, whose metadata this rewrites in place
            // (restoreLocalNowPlayingMeta undoes it on disconnect).
            applyNowPlayingChapter(get().currentSession, chapters, chapterIndex);
          } else {
            const state = await TrackPlayer.getActiveTrack();
            if (!state) return;
            const progress = await TrackPlayer.getProgress();
            const playerState = await TrackPlayer.getPlaybackState();
            isPlayerPlaying = playerState.state === State.Playing;

            // Translate the player position to an ABSOLUTE book position. With a
            // chapter queue each item is clipped, so the raw position is
            // chapter-relative and the active index IS the chapter. With a
            // multi-file queue the raw position is TRACK-relative — add the
            // track's absolute start offset (treating it as book-absolute
            // collapsed duration to the current file and auto-finished books
            // at the end of file 1).
            absolutePosition = progress.position;
            bookDuration = progress.duration;
            if (chapterQueue && chapters.length) {
              const activeIndex = await TrackPlayer.getActiveTrackIndex();
              if (activeIndex != null && chapters[activeIndex]) {
                chapterIndex = activeIndex;
                absolutePosition = (chapters[activeIndex].start || 0) + progress.position;
              }
              bookDuration = get().duration || bookDuration; // keep whole-book duration
            } else {
              if (_trackOffsets.length > 1) {
                const activeIndex = await TrackPlayer.getActiveTrackIndex();
                if (activeIndex != null && _trackOffsets[activeIndex] != null) {
                  absolutePosition = _trackOffsets[activeIndex] + progress.position;
                }
                bookDuration = get().duration || bookDuration; // whole-book duration
              }
              for (let i = 0; i < chapters.length; i++) {
                if (absolutePosition >= chapters[i].start && absolutePosition < chapters[i].end) {
                  chapterIndex = i;
                  break;
                }
              }
            }

            set({
              position: absolutePosition,
              duration: bookDuration,
              isPlaying: isPlayerPlaying,
              currentChapterIndex: chapterIndex,
            });

            // For the single-track fallback we push the chapter title to the
            // now-playing metadata; the chapter queue already titles each item.
            if (!chapterQueue) {
              applyNowPlayingChapter(get().currentSession, chapters, chapterIndex);
            }
          }

          persistProgressSample(
            get().currentSession,
            absolutePosition,
            bookDuration,
            isPlayerPlaying
          );
        } catch (e) {
          // Player might not be active/loaded
        }
      }, 1000);

    } catch (error: any) {
      // RNTP throws an "already initialized" error if the native player survived
      // a JS reload — that's benign, so mark initialized. Any OTHER failure is
      // real: leave isInitialized false so the next play()/startPlayback retries
      // setup instead of every transport call silently no-oping.
      const alreadyInit = String(error?.code ?? error?.message ?? "")
        .toLowerCase()
        .includes("already");
      if (alreadyInit) {
        set({ isInitialized: true });
      } else {
        console.error("[PlaybackStore] TrackPlayer setup failed:", error);
      }
    }
    })();
    try {
      await _initPromise;
    } finally {
      _initPromise = null;
    }
  },

  startPlayback: async (itemId, episodeId) => {
    if (itemId) {
      storage.set(`last_interaction_${itemId}`, "listen");
    }
    // Android Auto double-dispatches its play command (onAddMediaItems fires
    // twice), so remote-play-id arrives twice ~10ms apart. Without this guard,
    // two /play sessions race two reset+add() calls and the queue ends up with
    // double the chapters (mismatched ids → Android Auto keeps resetting scroll).
    // The AA duplicates land ~10ms apart; 2s is ample and doesn't block a user
    // who deliberately re-taps the same book shortly after.
    const dupeKey = `${itemId}:${episodeId || ""}`;
    const now = Date.now();
    if (_lastStartKey === dupeKey && now - _lastStartAt < 2000) {
      console.log("[PlaybackStore] Ignoring duplicate startPlayback for", dupeKey);
      return false;
    }
    _lastStartKey = dupeKey;
    _lastStartAt = now;
    try {
      const path = episodeId
        ? `/api/items/${encodeURIComponent(itemId)}/play/${encodeURIComponent(episodeId)}`
        : `/api/items/${encodeURIComponent(itemId)}/play`;
      const res = await api.post(path, {
        deviceInfo: { clientName: "audiobookshelf-app-native", clientVersion: "1.0.0" },
        // Tell the server what the client can direct-play so it returns tracks
        // instead of an empty set.
        supportedMimeTypes: [
          "audio/flac",
          "audio/mpeg",
          "audio/mp3",
          "audio/mp4",
          "audio/m4a",
          "audio/m4b",
          "audio/aac",
          "audio/ogg",
          "audio/opus",
          "audio/webm",
          "audio/x-m4a",
        ],
        mediaPlayer: "react-native-track-player",
        forceDirectPlay: false,
        forceTranscode: false,
      });
      const session = res.data;
      const trackCount = (session?.audioTracks || session?.tracks || []).length;
      if (!session || trackCount === 0) {
        console.error("[PlaybackStore] startPlayback: session has no audio tracks");
        alertPlayFailure("This item has no playable audio.");
        return false;
      }
      return await get().preparePlaybackSession(session, true);
    } catch (err) {
      console.error("[PlaybackStore] startPlayback failed:", err);
      // Offline fallback: if this book is downloaded (with playback meta), build
      // a local session from the on-device files so it plays without the server.
      try {
        const { useDownloadStore } = require("./useDownloadStore");
        const dl = useDownloadStore.getState().completedDownloads[itemId];
        // Requires actual AUDIO tracks — an ebook-only download has meta but an
        // empty tracks list, and "playing" it would reset the player into an
        // empty queue (the reader is its playback surface, not us).
        if (dl?.meta?.tracks?.length && dl.localFolderPath && !episodeId) {
          const lastLocal = useUserStore.getState().getMediaProgress(itemId);
          const localSession = {
            id: `local_${itemId}`,
            libraryItemId: itemId,
            displayTitle: dl.title,
            displayAuthor: dl.author,
            duration: dl.meta.duration || 0,
            currentTime: lastLocal?.currentTime || 0,
            chapters: dl.meta.chapters || [],
            // The downloaded cover FILE — dl.coverUrl is the remote server URL
            // (dead offline, stale token baked in from download time).
            coverUrl:
              (dl.parts || []).find((p: any) => p.id === "cover")?.localFilePath ||
              dl.coverUrl,
            audioTracks: dl.meta.tracks.map((t: any) => ({
              index: t.index,
              contentUrl: `${dl.localFolderPath}${t.filename}`,
              duration: t.duration,
              startOffset: t.startOffset,
            })),
          };
          console.log("[PlaybackStore] Falling back to offline local session for", itemId);
          if (await get().preparePlaybackSession(localSession, true)) return true;
        }
      } catch (e) {
        console.error("[PlaybackStore] offline fallback failed:", e);
      }
      alertPlayFailure(
        "Couldn't reach the server, and this book isn't downloaded. Check your connection and try again."
      );
      return false;
    }
  },

  preparePlaybackSession: async (session, playWhenReady = false) => {
    await get().initializePlayer();

    // Claim the session generation. Any later prepare or closePlayback bumps
    // it; this run bails at the next checkpoint instead of interleaving
    // player mutations (queue merges / resurrecting a closed session).
    const gen = ++_sessionGen;
    const stale = () => gen !== _sessionGen;
    // Whether we've already wiped the previous queue — failures BEFORE the
    // reset must leave the old session fully intact.
    let didReset = false;

    try {
      console.log("[PlaybackStore] Preparing playback session:", session.id);

      // ---- Build everything FIRST (no player mutations yet) ----

      // Build absolute, authenticated URLs. ABS session contentUrls are
      // server-relative (e.g. /api/items/.../file/...) and need the server host
      // plus the auth token appended so TrackPlayer (which bypasses the axios
      // interceptor) can fetch them.
      const serverConfig = storageHelper.getServerConfig();
      const serverAddress = (serverConfig?.address || "").replace(/\/$/, "");
      const token = serverConfig?.token || "";

      const withToken = (url: string) => {
        if (!token || url.includes("token=")) return url;
        return url + (url.includes("?") ? "&" : "?") + `token=${token}`;
      };
      const absoluteUrl = (url: string) => {
        if (!url) return url;
        // Offline-fallback sessions carry on-device paths — pass them through
        // instead of mangling them into https://server/data/user/0/... URLs.
        if (url.startsWith("file://") || url.startsWith("content://")) return url;
        if (url.startsWith("/data/") || url.startsWith("/storage/")) return `file://${url}`;
        const full = url.startsWith("http") ? url : `${serverAddress}${url}`;
        return withToken(full);
      };

      const libraryItemId = session.libraryItemId || session.libraryItem?.id;

      // Prefer the locally-downloaded file when available so downloaded books
      // play the local copy (faster / offline) instead of streaming.
      const { useDownloadStore } = require("./useDownloadStore");
      const download = libraryItemId
        ? useDownloadStore.getState().completedDownloads[libraryItemId]
        : null;

      // Notification artwork. Media3 fetches this URL NATIVELY (no axios
      // interceptor, no token refresh), so a cover URL with a stale baked-in
      // token silently 401s → no album art. Priority:
      //  1. the downloaded cover FILE (token-proof, offline-proof),
      //  2. a URL built fresh with the CURRENT token,
      //  3. the session's own coverUrl with its (possibly rotated-out) token
      //     replaced by the current one — restored MMKV sessions carry the
      //     token that was current when they were saved.
      const localCover = (download?.parts || []).find((p: any) => p.id === "cover")
        ?.localFilePath as string | undefined;
      const freshenToken = (url?: string | null) =>
        url && url.startsWith("http") && token
          ? url.replace(/([?&])token=[^&]*/, `$1token=${token}`)
          : url || undefined;
      const artworkUrl =
        localCover ||
        (libraryItemId && serverAddress
          ? `${serverAddress}/api/items/${libraryItemId}/cover?width=800&format=webp&token=${token}`
          : undefined) ||
        freshenToken(session.coverUrl);
      const localFolder = download?.localFolderPath;
      const localForTrack = (track: any, idx: number): string | null => {
        if (!download) return null;
        const key = `track_${track.index ?? idx}`;
        // Legacy completed rows can lack `parts` entirely — an unguarded
        // .find made such books unplayable even STREAMING (throw mid-prepare).
        const part = (download.parts || []).find((p: any) => p.id === key);
        const path = part?.localFilePath || (localFolder && part ? `${localFolder}${part.filename}` : null);
        if (!path) return null;
        return path.startsWith("file://") ? path : `file://${path}`;
      };

      // Now-playing title should be the book (and, once playing, the current
      // chapter) — NOT the raw audio file name. Subtitle = "Book • Author".
      const bookTitle = session.displayTitle || "Audiobook";
      const bookAuthor = session.displayAuthor || "Unknown Author";
      const subtitle = [bookTitle, bookAuthor].filter(Boolean).join(" • ");

      const audioTracks = session.audioTracks || session.tracks || [];
      // Sanitize chapters: badly tagged files ship inverted (start > end) or
      // non-numeric windows; a negative clip window makes native behavior
      // undefined and corrupts absolute-position math.
      const chapters = (Array.isArray(session.chapters) ? session.chapters : []).filter(
        (c: any) =>
          Number.isFinite(Number(c?.start)) &&
          Number.isFinite(Number(c?.end)) &&
          Number(c.end) > Number(c.start)
      );

      // Chapter queue: when a single-file book has real chapters, build one
      // clipped RNTP item per chapter so Android Auto shows the chapters as the
      // queue and each chapter is its own now-playing title. Multi-file books
      // fall back to a file-per-item queue (a chapter can straddle files).
      const chapterQueue = chapters.length > 1 && audioTracks.length === 1;

      let tracksToLoad: any[];
      const trackOffsets: number[] = [];
      if (chapterQueue) {
        const track = audioTracks[0];
        const fileUrl = localForTrack(track, track.index ?? 0) || absoluteUrl(track.contentUrl);
        if (!fileUrl) throw new Error("Track has no playable URL");
        const startOffset = track.startOffset || 0;
        tracksToLoad = chapters.map((ch: any, i: number) => {
          const t: any = {
            id: `${session.id}_ch${i}`,
            // Unique mediaId per chapter — all chapters share the same file URL,
            // so without this Android Auto can't distinguish the queue items and
            // re-diffs/reloads the queue (scroll jumps to top) on every tick.
            mediaId: `${session.id}_ch${i}`,
            url: fileUrl,
            title: ch.title || `Chapter ${i + 1}`,
            artist: subtitle,
            album: bookTitle,
            duration: Math.max(0, (ch.end || 0) - (ch.start || 0)),
            // Clip the shared file to this chapter's window (ms, file-relative).
            clipStartMs: Math.max(0, Math.round(((ch.start || 0) - startOffset) * 1000)),
            clipEndMs: Math.round(((ch.end || 0) - startOffset) * 1000),
          };
          if (artworkUrl) t.artwork = artworkUrl;
          return t;
        });
      } else {
        // MULTI-FILE (or chapterless) queue: one item per file. Record each
        // item's absolute start offset — RNTP progress/seeks are per-track,
        // and treating them as book-absolute collapsed duration to the
        // current file and auto-finished books at the end of file 1.
        let acc = 0;
        tracksToLoad = audioTracks.map((track: any, idx: number) => {
          const off = Number.isFinite(Number(track.startOffset)) ? Number(track.startOffset) : acc;
          trackOffsets.push(off);
          acc = off + (Number(track.duration) || 0);
          const url = localForTrack(track, idx) || absoluteUrl(track.contentUrl);
          if (!url) throw new Error("Track has no playable URL");
          const t: any = {
            id: `${session.id}_${track.index ?? idx}`,
            url,
            title: bookTitle,
            artist: bookAuthor,
            album: bookTitle,
            duration: track.duration,
          };
          if (artworkUrl) t.artwork = artworkUrl;
          return t;
        });
      }

      if (tracksToLoad.length === 0) {
        throw new Error("No playback tracks found in session");
      }

      // Resolve the resume position BEFORE touching the player.
      // FRESHEST-WINS: the server's session.currentTime is its last-known
      // progress, which is STALE if we listened offline (those syncs are still
      // queued locally). Losing an offline listening session's position is the
      // worst progress bug an audiobook app can have — so if our local save for
      // this same book is meaningfully newer than the server's own progress
      // timestamp, resume from the local position instead. (Cross-device safety:
      // if another device listened further, the server timestamp is newer and
      // the server position wins.)
      let startAbs = session.currentTime || 0;
      try {
        const saved = storageHelper.getLastPlaybackSession();
        const savedItemId = saved?.libraryItemId || saved?.libraryItem?.id;
        if (
          saved &&
          savedItemId === libraryItemId &&
          // Podcast: the save must be for the SAME EPISODE — matching on the
          // item id alone resumed episode B at episode A's position (and could
          // instantly auto-finish a shorter episode).
          (saved.episodeId || null) === (session.episodeId || null) &&
          typeof saved.currentTime === "number" &&
          Math.abs(saved.currentTime - startAbs) > 2
        ) {
          const serverProg = useUserStore
            .getState()
            .getMediaProgress(libraryItemId, session.episodeId);
          // ABS progress rows carry server-side lastUpdate (ms). Fall back to 0
          // (unknown) so a local save always beats a server we know nothing about.
          const serverUpdatedAt = Number(serverProg?.lastUpdate) || 0;
          const localUpdatedAt = Number(saved.updatedAt) || 0;
          // 10s margin absorbs clock skew and in-flight sync races.
          if (localUpdatedAt > serverUpdatedAt + 10000) {
            console.log(
              `[PlaybackStore] Local position is fresher than server (${saved.currentTime}s vs ${startAbs}s) — resuming from local.`
            );
            startAbs = saved.currentTime;
          }
        }
      } catch {}

      // The chapter index for the resume position — set in the same state
      // write below so an end-of-chapter sleep timer armed before the first
      // 1s tick can't see a stale/-1 index (it fired instantly).
      let startChapterIdx = -1;
      for (let i = 0; i < chapters.length; i++) {
        if (startAbs >= (chapters[i].start || 0) && startAbs < (chapters[i].end || 0)) {
          startChapterIdx = i;
          break;
        }
      }

      // ---- Player mutations (checkpointed against newer prepares/closes) ----
      if (stale()) return false;

      await TrackPlayer.reset();
      if (stale()) return false;
      didReset = true;
      // A pending error-retry belongs to the PREVIOUS queue — recovering it
      // now would fight the session being prepared.
      clearErrorRecovery();
      _lastMetaChapter = -2; // force a now-playing metadata refresh for the new book
      // A sleep timer from the previous book must not run against the new one
      // (end-of-chapter timers would pause the new book almost immediately).
      get().cancelSleepTimer();

      // Reset progress-sync bookkeeping for the new session.
      _timeListenedAccum = 0;
      _lastTickAt = null;
      _lastSyncAt = 0;
      _lastLocalSaveAt = 0;
      _finishedSessionId = null;
      _trackOffsets = trackOffsets;

      await TrackPlayer.add(tracksToLoad);
      if (stale()) return false;

      // Restore the last speed the user set (persisted globally), matching the
      // original app's saved-playback-rate behaviour.
      const playbackSpeed = session.playbackRate || storageHelper.getPlaybackRate();
      await TrackPlayer.setRate(playbackSpeed);
      if (stale()) return false;

      if (chapterQueue) {
        let idx = startChapterIdx >= 0 ? startChapterIdx : 0;
        if (idx > 0) await TrackPlayer.skip(idx);
        if (stale()) return false;
        const within = startAbs - (chapters[idx]?.start || 0);
        if (within > 0) await TrackPlayer.seekTo(within);
      } else if (startAbs > 0) {
        // Map the absolute resume position into the owning FILE.
        let tIdx = 0;
        for (let i = trackOffsets.length - 1; i >= 0; i--) {
          if (startAbs >= trackOffsets[i]) {
            tIdx = i;
            break;
          }
        }
        if (tIdx > 0) await TrackPlayer.skip(tIdx);
        if (stale()) return false;
        const within = Math.max(0, startAbs - (trackOffsets[tIdx] || 0));
        if (within > 0) await TrackPlayer.seekTo(within);
      }
      if (stale()) return false;

      set({
        // Persist the resolved cover URL on the session so the Player and
        // MiniPlayer can render artwork (the raw session has no coverUrl).
        // currentTime reflects the RECONCILED position (see freshest-wins above).
        currentSession: { ...session, currentTime: startAbs, coverUrl: artworkUrl || session.coverUrl || "" },
        playbackSpeed,
        chapters,
        chapterQueue,
        duration: session.duration || 0,
        position: startAbs,
        currentChapterIndex: startChapterIdx,
      });

      // Mirror the current book to the home-screen resume widget and to the
      // native Media3 service (itemId powers Android Auto's resume card).
      writeWidgetState({ title: bookTitle, author: bookAuthor, itemId: libraryItemId || undefined });

      if (playWhenReady) {
        if (get().isCasting) {
          // Already casting: don't blast audio from the phone — leave the
          // local player paused and let CastController (keyed on the new
          // currentSession) load the book onto the receiver with autoplay.
          set({ isPlaying: true, isPlayerExpanded: true });
        } else {
          await TrackPlayer.play();
          if (stale()) return false;
          set({ isPlaying: true, isPlayerExpanded: true });
        }
      }
      return true;
    } catch (err) {
      console.error("[PlaybackStore] Failed to prepare playback session:", err);
      if (!stale() && didReset) {
        // The old queue is already gone — leave a COHERENT empty state, not a
        // ghost session whose transport controls silently no-op.
        set({
          currentSession: null,
          isPlaying: false,
          duration: 0,
          position: 0,
          chapters: [],
          chapterQueue: false,
          currentChapterIndex: -1,
        });
      }
      if (!stale() && playWhenReady) {
        alertPlayFailure("Playback couldn't start. Check your connection and try again.");
      }
      return false;
    }
  },

  playPause: async () => {
    const isPlaying = get().isPlaying;
    if (isPlaying) {
      await get().pause();
    } else {
      await get().play();
    }
  },

  play: async () => {
    // A remote-play racing closePlayback must not flip isPlaying on a dead
    // store (it stuck true forever with no session to ever clear it).
    if (!get().currentSession) return;
    const { isCasting, castClient } = get();
    // Auto rewind: on resume, nudge back a little (scaled by how long paused),
    // unless disabled in Settings.
    if (_lastPausedAt != null) {
      const disabled = useUserStore.getState().settings?.disableAutoRewind;
      if (!disabled) {
        const rewind = autoRewindSeconds(Date.now() - _lastPausedAt);
        if (rewind > 0) {
          // LIVE position: the snapshot can be stale after backgrounding
          // (throttled 1s interval) — see getLiveAbsolutePosition.
          const pos = await getLiveAbsolutePosition(get);
          const target = Math.max(0, pos - rewind);
          await get().seek(target);
        }
      }
      _lastPausedAt = null;
    }
    if (isCasting && castClient) {
      try { await castClient.play(); } catch (e) { console.warn("[Cast] play", e); }
      set({ isPlaying: true });
      return;
    }
    if (!get().isInitialized) {
      await get().initializePlayer();
    }
    // An errored player (mid-stream network drop) sits IDLE and ignores
    // play() — re-prepare it first so the user's tap actually resumes.
    // Manual resume supersedes any pending automatic retry.
    try {
      const ps: any = await TrackPlayer.getPlaybackState().catch(() => null);
      if (ps && (ps.state === State.Error || ps.state === State.None)) {
        clearErrorRecovery();
        await TrackPlayer.retry();
      }
    } catch {}
    await TrackPlayer.play();
    set({ isPlaying: true });
  },

  pause: async () => {
    if (!get().currentSession) return;
    _lastPausedAt = Date.now();
    const { isCasting, castClient } = get();
    if (isCasting && castClient) {
      try { await castClient.pause(); } catch (e) { console.warn("[Cast] pause", e); }
      set({ isPlaying: false });
    } else {
      if (!get().isInitialized) return;
      await TrackPlayer.pause();
      set({ isPlaying: false });
    }

    // LIVE position: pausing from the NOTIFICATION after backgrounded
    // playback is exactly when the store snapshot is minutes stale (throttled
    // 1s interval) — persisting/syncing the snapshot rolled real progress
    // back. Read the player itself and correct the snapshot too.
    const pausedAt = await getLiveAbsolutePosition(get);
    set({ position: pausedAt });

    // Persist the paused position locally right now (bypasses the 5s throttle
    // so an app kill immediately after pausing can't lose the position)...
    saveSessionPositionNow(pausedAt);

    // ...and flush accumulated listening time to the server. Runs for BOTH the
    // cast and local paths — this used to be skipped while casting, so a cast
    // session's listening time only landed on the next 15s tick.
    const session = get().currentSession;
    if (session?.id && _timeListenedAccum > 0) {
      const toSync = _timeListenedAccum;
      _timeListenedAccum = 0;
      _lastSyncAt = Date.now();
      syncProgress({
        sessionId: session.id,
        currentTime: pausedAt,
        timeListened: toSync,
        duration: get().duration,
        libraryItemId: session.libraryItemId,
        episodeId: session.episodeId || undefined,
      }).catch(() => {});
    }
  },

  // `value` is always an ABSOLUTE book position (seconds).
  seek: async (value) => {
    // No session (e.g. a remote event racing closePlayback) or a non-finite
    // target: nothing sane to do.
    if (!Number.isFinite(value) || !get().currentSession) return;
    const { isCasting, castClient, chapterQueue, chapters } = get();
    // Defensive clamp: scrubber overshoot / stale bookmarks can hand us a
    // position past the end (or negative) — clamp to the book bounds.
    const dur = get().duration;
    value = Math.max(0, dur > 0 ? Math.min(value, dur) : value);
    if (isCasting && castClient) {
      const castSeekAbs = get().castSeekAbs;
      // Optimistic: move the scrubber immediately — a cross-track cast seek
      // reloads the receiver queue, which can take seconds. CastController's
      // settle guard keeps stale receiver mirrors from fighting this.
      set({ position: value });
      // Persist immediately — a kill inside the 5s save throttle right after a
      // seek would otherwise resume at the pre-seek position.
      saveSessionPositionNow(value);
      try {
        if (castSeekAbs) {
          // Track-aware absolute seek: maps into the right queue item and
          // reloads the queue when crossing a file boundary (multi-file
          // books) — the raw client.seek below is within-current-item only.
          await castSeekAbs(value);
        } else {
          await castClient.seek({ position: value });
        }
      } catch (e) {
        console.warn("[Cast] seek", e);
      }
      return;
    }
    if (!get().isInitialized) return;
    if (chapterQueue && chapters.length) {
      // Map the absolute position into the owning chapter clip.
      let idx = chapters.findIndex((c: any) => value >= (c.start || 0) && value < (c.end || 0));
      if (idx < 0) idx = value <= 0 ? 0 : chapters.length - 1;
      const active = await TrackPlayer.getActiveTrackIndex();
      if (idx !== active) await TrackPlayer.skip(idx);
      await TrackPlayer.seekTo(Math.max(0, value - (chapters[idx].start || 0)));
      set({ position: value, currentChapterIndex: idx });
      saveSessionPositionNow(value);
      return;
    }
    if (_trackOffsets.length > 1) {
      // Multi-file queue: map the absolute position into the owning FILE —
      // a raw seekTo is track-relative and cannot cross file boundaries.
      let idx = 0;
      for (let i = _trackOffsets.length - 1; i >= 0; i--) {
        if (value >= _trackOffsets[i]) {
          idx = i;
          break;
        }
      }
      const active = await TrackPlayer.getActiveTrackIndex();
      if (idx !== active) await TrackPlayer.skip(idx);
      await TrackPlayer.seekTo(Math.max(0, value - (_trackOffsets[idx] || 0)));
      set({ position: value });
      saveSessionPositionNow(value);
      return;
    }
    await TrackPlayer.seekTo(value);
    set({ position: value });
    saveSessionPositionNow(value);
  },

  // seekForward/Backward funnel through seek() so they inherit cast routing.
  seekForward: async (value) => {
    // LIVE position, not the store snapshot — see getLiveAbsolutePosition.
    const pos = await getLiveAbsolutePosition(get);
    const target = Math.min(pos + value, get().duration || Infinity);
    await get().seek(target);
  },

  seekBackward: async (value) => {
    const pos = await getLiveAbsolutePosition(get);
    await get().seek(Math.max(0, pos - value));
  },

  // Chapter-aware navigation. ABS chapters carry absolute { start, end } times
  // (whole-book seconds).
  seekToChapter: async (index) => {
    const { chapters, chapterQueue, isCasting, castClient } = get();
    const ch = chapters?.[index];
    if (!ch) return;
    if (chapterQueue && !isCasting) {
      // Jump directly to the chapter's clip — no re-buffer of intermediate ones.
      await TrackPlayer.skip(index);
      await TrackPlayer.seekTo(0);
      set({ currentChapterIndex: index, position: ch.start || 0 });
      // Same immediate persist as seek() — a kill right after a chapter jump
      // must not resume at the pre-jump position.
      saveSessionPositionNow(ch.start || 0);
      return;
    }
    if (isCasting && castClient) {
      await get().seek(ch.start || 0);
      set({ currentChapterIndex: index });
      return;
    }
    await get().seek(ch.start || 0);
    set({ currentChapterIndex: index });
  },

  nextChapter: async () => {
    const { chapters, currentChapterIndex, chapterQueue, isCasting } = get();
    if (chapterQueue && !isCasting) {
      // Use the real active index — currentChapterIndex can be up to ~1s stale.
      const active = (await TrackPlayer.getActiveTrackIndex()) ?? currentChapterIndex;
      const nextIndex = active + 1;
      if (!chapters?.[nextIndex]) return;
      await get().seekToChapter(nextIndex);
      return;
    }
    // Derive the chapter from the LIVE position — the snapshot index can be
    // minutes stale in the background (throttled interval).
    let idx = currentChapterIndex;
    if (!isCasting && chapters?.length) {
      const position = await getLiveAbsolutePosition(get);
      const liveIdx = chapters.findIndex(
        (c: any) => position >= (c.start || 0) && position < (c.end || 0)
      );
      if (liveIdx >= 0) idx = liveIdx;
    }
    const nextIndex = idx + 1;
    if (chapters?.[nextIndex]) await get().seekToChapter(nextIndex);
  },

  previousChapter: async () => {
    const { chapters, currentChapterIndex, chapterQueue, isCasting } = get();
    // LIVE position: the store snapshot can be minutes stale in the background
    // (see getLiveAbsolutePosition), which flipped the restart-vs-previous
    // decision for notification presses.
    const position = await getLiveAbsolutePosition(get);
    if (chapterQueue && !isCasting) {
      const active = (await TrackPlayer.getActiveTrackIndex()) ?? currentChapterIndex;
      const current = chapters?.[active];
      // >3s into the chapter → restart it; otherwise go to the previous chapter.
      const within = current ? position - (current.start || 0) : 0;
      if (within > 3) {
        await get().seekToChapter(active);
      } else if (chapters?.[active - 1]) {
        await get().seekToChapter(active - 1);
      } else {
        await get().seekToChapter(active);
      }
      return;
    }
    // Derive the chapter from the LIVE position too — currentChapterIndex is
    // written by the same throttled interval as the position snapshot.
    let idx = currentChapterIndex;
    if (!isCasting && chapters?.length) {
      const liveIdx = chapters.findIndex(
        (c: any) => position >= (c.start || 0) && position < (c.end || 0)
      );
      if (liveIdx >= 0) idx = liveIdx;
    }
    const current = chapters?.[idx];
    const restart = current && position - (current.start || 0) > 3;
    if (restart) {
      await get().seekToChapter(idx);
      return;
    }
    const prevIndex = idx - 1;
    if (chapters?.[prevIndex]) await get().seekToChapter(prevIndex);
  },

  setPlaybackSpeed: async (speed) => {
    // Guard the input at the boundary — a non-finite rate would persist
    // globally and reach TrackPlayer.setRate/cast setPlaybackRate.
    if (!Number.isFinite(speed) || speed <= 0 || speed > 5) return;
    const { isCasting, castClient } = get();
    if (isCasting && castClient) {
      try { await castClient.setPlaybackRate(speed); } catch (e) { console.warn("[Cast] rate", e); }
    } else {
      if (!get().isInitialized) return;
      await TrackPlayer.setRate(speed);
    }

    // Persist globally so the next book (and Android Auto resume) restores it.
    storageHelper.setPlaybackRate(speed);

    const currentSession = get().currentSession;
    if (currentSession) {
      const updatedSession = { ...currentSession, playbackRate: speed };
      set({ currentSession: updatedSession, playbackSpeed: speed });
    } else {
      set({ playbackSpeed: speed });
    }
  },

  // Starts (or replaces) a sleep timer. When `endOfChapter` is true the
  // countdown tracks the time until the current chapter ends; otherwise it
  // counts down a fixed number of seconds. Playback pauses at zero.
  setSleepTimer: (seconds, endOfChapter = false) => {
    // No session → nothing to pause later; an orphan interval dragged the
    // player volume down forever via the fade path.
    if (!get().currentSession) return;
    if (sleepTimerInterval) {
      clearInterval(sleepTimerInterval);
      sleepTimerInterval = null;
    }
    // Make sure we start at full volume (a previous fade may have lowered it).
    // Unconditional: restoring the (paused) local player's volume while
    // casting is harmless, but skipping it left local playback stuck quiet
    // after a cast session that overlapped a fade.
    TrackPlayer.setVolume(1).catch(() => {});
    // End-of-chapter timers compute their own remaining from live position —
    // callers pass 0, which used to display as "0:00" until the first 1s tick.
    let initialRemaining = Math.max(0, Math.round(seconds));
    let armedChapterIdx: number | undefined;
    if (endOfChapter) {
      const { chapters, currentChapterIndex, position } = get();
      const ch = chapters?.[currentChapterIndex];
      initialRemaining = ch ? Math.max(0, Math.round((ch.end || 0) - position)) : 0;
      armedChapterIdx = currentChapterIndex;
    }
    set({ sleepTimer: { endOfChapter, remaining: initialRemaining, chapterIdx: armedChapterIdx } });

    _sleepLastTickAt = Date.now();
    sleepTimerInterval = setInterval(async () => {
      const timer = get().sleepTimer;
      if (!timer) {
        if (sleepTimerInterval) {
          clearInterval(sleepTimerInterval);
          sleepTimerInterval = null;
        }
        return;
      }

      // Real elapsed time since the previous tick — background throttling can
      // stretch the nominal 1s far longer, and the countdown must not stretch
      // with it.
      const now = Date.now();
      const elapsedS = _sleepLastTickAt != null ? Math.max(0, (now - _sleepLastTickAt) / 1000) : 1;
      _sleepLastTickAt = now;

      let remaining: number;
      let armedIdx = timer.chapterIdx;
      if (timer.endOfChapter) {
        // LIVE position (not the 1s-interval snapshot, which freezes in the
        // background): derive the current chapter from it so seeks AND
        // background playback both re-anchor correctly.
        const { chapters } = get();
        const position = await getLiveAbsolutePosition(get);
        const liveIdx = chapters?.length
          ? chapters.findIndex((c: any) => position >= (c.start || 0) && position < (c.end || 0))
          : -1;
        const armed = armedIdx ?? liveIdx;
        if (liveIdx !== -1 && armed >= 0 && liveIdx > armed) {
          // Crossed the boundary between ticks — fire now instead of
          // silently re-arming against the NEXT chapter's end.
          remaining = 0;
        } else if (liveIdx !== -1 && liveIdx < armed) {
          // User seeked BACK into an earlier chapter — re-arm there.
          const ch = chapters?.[liveIdx];
          remaining = ch ? Math.max(0, Math.round((ch.end || 0) - position)) : timer.remaining;
          armedIdx = liveIdx;
        } else {
          const ch = chapters?.[liveIdx];
          // Chapter unknown this tick (gap / boundary transient / chapterless
          // book) — hold without firing; `remaining` may legitimately be 0
          // here and must not trip the pause below.
          if (!ch) return;
          remaining = Math.max(0, Math.round((ch.end || 0) - position));
        }
      } else {
        // Count down real listening time only — pausing for 20 minutes must
        // not eat a 30-minute timer, and a throttled background gap while
        // PLAYING must consume its full duration on the next tick.
        remaining = get().isPlaying ? timer.remaining - elapsedS : timer.remaining;
      }

      // Gently fade the volume down over the final SLEEP_FADE_SECONDS so playback
      // eases out instead of cutting off mid-sentence.
      if (!get().isCasting) {
        const vol = remaining >= SLEEP_FADE_SECONDS ? 1 : Math.max(0, remaining / SLEEP_FADE_SECONDS);
        TrackPlayer.setVolume(vol).catch(() => {});
      }

      if (remaining <= 0) {
        if (sleepTimerInterval) {
          clearInterval(sleepTimerInterval);
          sleepTimerInterval = null;
        }
        set({ sleepTimer: null });
        get().pause();
        // Restore full volume so the next resume isn't silent — even while
        // casting (the local player is paused; without this a fade that
        // overlapped a cast session left local playback quiet forever).
        TrackPlayer.setVolume(1).catch(() => {});
        return;
      }
      set({
        sleepTimer: {
          endOfChapter: timer.endOfChapter,
          remaining: Math.round(remaining * 10) / 10,
          chapterIdx: armedIdx,
        },
      });
    }, 1000);
  },

  cancelSleepTimer: () => {
    if (sleepTimerInterval) {
      clearInterval(sleepTimerInterval);
      sleepTimerInterval = null;
    }
    _sleepLastTickAt = null;
    // Undo any in-progress fade (unconditional — see setSleepTimer).
    TrackPlayer.setVolume(1).catch(() => {});
    set({ sleepTimer: null });
  },

  closePlayback: async () => {
    if (!get().isInitialized) return;
    // Invalidate any in-flight preparePlaybackSession — without this a slow
    // prepare landing after close resurrected the session.
    ++_sessionGen;
    _trackOffsets = [];

    // Final flush + close the ABS session before tearing down the player.
    // LIVE position (read BEFORE reset clears the player): dismissing playback
    // from the notification after backgrounded listening is exactly when the
    // snapshot is minutes stale — closing the session with it regressed the
    // server-side position.
    const closeAt = await getLiveAbsolutePosition(get);
    const session = get().currentSession;
    if (session?.id) {
      const toSync = _timeListenedAccum;
      _timeListenedAccum = 0;
      try {
        await closeSession({
          sessionId: session.id,
          currentTime: closeAt,
          timeListened: toSync,
          duration: get().duration,
          libraryItemId: session.libraryItemId,
          episodeId: session.episodeId || undefined,
        });
      } catch {
        // closeSession already queues on failure; never block teardown.
      }
    }

    // If casting, stop the receiver's playback too — otherwise dismissing
    // playback on the phone leaves the TV playing with no session syncing.
    const { isCasting, castClient } = get();
    if (isCasting && castClient) {
      try { await castClient.stop(); } catch {}
    }

    await TrackPlayer.reset();
    storageHelper.removeLastPlaybackSession();

    // Nothing left to recover — a retry firing after close would resurrect
    // the dismissed session's player state.
    clearErrorRecovery();

    if (sleepTimerInterval) {
      clearInterval(sleepTimerInterval);
      sleepTimerInterval = null;
    }

    _lastTickAt = null;
    _lastSyncAt = 0;
    _lastLocalSaveAt = 0;
    _finishedSessionId = null;

    set({
      currentSession: null,
      isPlaying: false,
      duration: 0,
      position: 0,
      chapters: [],
      chapterQueue: false,
      currentChapterIndex: -1,
      sleepTimer: null,
      // The cast seek handler closes over the CLOSED book's track offsets —
      // drop it; CastController re-registers when the next session loads.
      castSeekAbs: null,
    });
  },
}));

// Re-apply the jump intervals to the native player whenever the setting changes.
{
  let _lastJump = "";
  useUserStore.subscribe((state) => {
    const key = `${state.settings?.jumpForwardTime}:${state.settings?.jumpBackwardTime}`;
    if (key !== _lastJump) {
      _lastJump = key;
      if (usePlaybackStore.getState().isInitialized) applyJumpOptions();
    }
  });
}
