import { create } from "zustand";
import TrackPlayer, { Capability, State, AppKilledPlaybackBehavior } from "react-native-track-player";
import { storageHelper, storage } from "../utils/storage";
import { api } from "../utils/api";
import { useUserStore } from "./useUserStore";
import { syncProgress, closeSession, queueProgressPatch, reconcileLinkedProgress } from "../utils/progressSync";
import { writeWidgetState } from "../utils/autoCreds";
import * as FileSystem from "expo-file-system/legacy";

// Records when playback was paused so play() can apply the "auto rewind" nudge
// (rewind a little on resume, scaled by how long you were away).
let _lastPausedAt: number | null = null;
// Token the current queue's stream URLs were built with (see prepare) — lets
// error recovery detect a rotation and rebuild URLs instead of retrying 401s.
let _preparedToken: string | null = null;

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
// Signature of the LAST mediaProgress display-mirror write. The mirror map is
// consumed only by library/shelf badges (percent / remaining-time), so we skip
// the per-tick setState unless the DISPLAYED value actually changes — the
// rounded percent, the whole remaining-minute, or the finished flag. Writing a
// fresh map reference every 1s tick re-rendered every subscriber (the whole
// Books list, kept mounted behind every screen) once a second and stole frames
// from animations; now the mirror writes ~once per percent or per minute. The
// finish / server-sync / MMKV paths are SEPARATE and unaffected by this gate.
let _lastMirrorSig: string | null = null;
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
// Native PlaybackProgressUpdated events are delivered slightly out of band, so
// one can still be in flight when the user pauses. Within this window after a
// local pause(), such a straggler is ignored so it can't re-stamp updatedAt /
// accrue listening time / flip isPlaying back to true on a book the user just
// paused (poisoning freshest-wins). See _lastPausedAt.
const PAUSE_STRAGGLER_WINDOW_MS = 2000;
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

// --- Per-book rate memory · cross-book queue · sleep-timer extras ------------
// All client-only. Persisted directly in the shared MMKV `storage` under their
// own keys (kept out of the user-settings blob) so they survive restarts.
const PER_BOOK_RATE_KEY = "perBookRate";
// Cap the per-book rate memory so it can't grow without bound — one entry is
// added per book whose speed was ever changed. Approximate LRU: the oldest
// (least-recently-written) entries are evicted once the map exceeds this.
const PER_BOOK_RATE_MAX = 200;
const REMEMBER_RATE_KEY = "rememberSpeedPerBook";
const QUEUE_KEY = "playbackQueue";
const AUTO_PLAY_NEXT_KEY = "autoPlayNext";
const SLEEP_REWIND_ON_WAKE_KEY = "sleepRewindOnWake";
const SLEEP_REWIND_SECONDS_KEY = "sleepRewindSeconds";
const SLEEP_SHAKE_KEY = "sleepShakeToExtend";
// Minutes a phone shake adds to an armed sleep timer.
const SLEEP_SHAKE_MINUTES = 5;

function getRememberSpeedPerBook(): boolean {
  if (!storage.contains(REMEMBER_RATE_KEY)) return true; // default ON
  return storage.getBoolean(REMEMBER_RATE_KEY) ?? true;
}
function getPerBookRateMap(): Record<string, number> {
  try {
    const parsed = JSON.parse(storage.getString(PER_BOOK_RATE_KEY) || "null");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function getPerBookRate(itemId?: string | null): number | undefined {
  if (!itemId) return undefined;
  const r = getPerBookRateMap()[itemId];
  return typeof r === "number" && r > 0 ? r : undefined;
}
function setPerBookRate(itemId?: string | null, rate?: number) {
  if (!itemId || !(typeof rate === "number" && rate > 0)) return;
  const map = getPerBookRateMap();
  // Delete-then-set moves the entry to the end (most-recently-used) so the LRU
  // eviction below drops the oldest entries first. Object key order is insertion
  // order for the string (UUID) keys used here.
  delete map[itemId];
  map[itemId] = rate;
  const keys = Object.keys(map);
  if (keys.length > PER_BOOK_RATE_MAX) {
    for (const k of keys.slice(0, keys.length - PER_BOOK_RATE_MAX)) delete map[k];
  }
  try {
    storage.set(PER_BOOK_RATE_KEY, JSON.stringify(map));
  } catch {}
}

function getStoredQueue(): QueueItem[] {
  try {
    const parsed = JSON.parse(storage.getString(QUEUE_KEY) || "null");
    return Array.isArray(parsed)
      ? parsed.filter((q: any) => q && typeof q.libraryItemId === "string")
      : [];
  } catch {
    return [];
  }
}
function persistQueue(q: QueueItem[]) {
  try {
    storage.set(QUEUE_KEY, JSON.stringify(q || []));
  } catch {}
}
function getAutoPlayNext(): boolean {
  if (!storage.contains(AUTO_PLAY_NEXT_KEY)) return true; // default ON
  return storage.getBoolean(AUTO_PLAY_NEXT_KEY) ?? true;
}

function getSleepRewindOnWake(): boolean {
  if (!storage.contains(SLEEP_REWIND_ON_WAKE_KEY)) return true; // default ON
  return storage.getBoolean(SLEEP_REWIND_ON_WAKE_KEY) ?? true;
}
function getSleepRewindSeconds(): number {
  const n = storage.getNumber(SLEEP_REWIND_SECONDS_KEY);
  return typeof n === "number" && n > 0 ? n : 30;
}
function getSleepShakeToExtend(): boolean {
  if (!storage.contains(SLEEP_SHAKE_KEY)) return true; // default ON
  return storage.getBoolean(SLEEP_SHAKE_KEY) ?? true;
}

// Set true when a sleep timer PAUSES playback so the next play() can apply the
// dedicated "rewind on wake" nudge, independent of the generic auto-rewind.
let _sleepRewindPending = false;

// Accelerometer shake-to-extend — works with the SCREEN OFF, battery-efficiently.
//
// Why it works screen-off: a non-wake-up SensorManager listener only stops
// delivering when the application processor enters deep sleep. But this player
// holds a PARTIAL wake lock during playback (androidWakeMode = WAKE_MODE_NETWORK,
// set in buildPlayerOptions), so the CPU never deep-sleeps while a book is
// playing — which is exactly the state during a sleep timer. So the accelerometer
// keeps firing with the screen off, and the native 1s progress events keep the JS
// runtime alive to receive them. This is the same approach Smart AudioBook
// Player / Prologue (and this app's pre-React-Native version) use.
//
// Why it's battery-efficient: we register the sensor ONLY while a sleep timer is
// actually running (a short, user-bounded window) and at a low 4 Hz rate. The CPU
// is already awake to decode audio, so a 4 Hz accelerometer is a negligible
// incremental cost — and we hold NO wake lock of our own (we ride the player's).
// When playback pauses (e.g. the timer fired), the wake lock releases and the CPU
// can sleep; by then the timer is over and shake-to-extend is no longer needed.
let _shakeSub: { remove: () => void } | null = null;
let _lastShakeAt = 0;
const SHAKE_G_THRESHOLD = 1.8; // total acceleration in g (~1g at rest)
function onShakeExtend() {
  const st = usePlaybackStore.getState();
  const t = st.sleepTimer;
  if (!t) return;
  // Extend in place (converting an end-of-chapter timer to fixed), matching the
  // modal's "+N min" extend semantics.
  st.setSleepTimer(Math.max(0, Math.round(t.remaining)) + SLEEP_SHAKE_MINUTES * 60, false);
}
function armShakeListener() {
  disarmShakeListener();
  if (!getSleepShakeToExtend()) return;
  try {
    const sensors = require("expo-sensors");
    const Accelerometer = sensors?.Accelerometer;
    if (!Accelerometer?.addListener) return;
    Accelerometer.setUpdateInterval?.(250); // 4 Hz — enough to catch a shake
    _shakeSub = Accelerometer.addListener((d: { x: number; y: number; z: number }) => {
      const mag = Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z);
      const now = Date.now();
      if (mag >= SHAKE_G_THRESHOLD && now - _lastShakeAt > 1500) {
        _lastShakeAt = now;
        onShakeExtend();
      }
    });
  } catch {
    // expo-sensors missing/misconfigured — stay a no-op.
    _shakeSub = null;
  }
}
function disarmShakeListener() {
  try {
    _shakeSub?.remove();
  } catch {}
  _shakeSub = null;
}

// Resolve the NEXT book in the finished book's series. Reuses the same
// series/sequence resolution as auto-download-next-in-series
// (utils/downloader.autoDownloadNextAfterFinish).
//
// REQUIRES CONNECTIVITY: the series membership + sequence needed to pick the
// next book lives only on the server — downloaded items (useDownloadStore)
// don't carry series/sequence metadata, so there's no local source to resolve
// from. Both api.get calls below therefore run first; offline they throw and
// this no-ops (returns null). Among the network-resolved candidates we still
// PREFER one that's already downloaded, so once connectivity picks the next
// book its playback can proceed from local files.
export async function resolveNextInSeries(libraryItemId: string): Promise<string | null> {
  try {
    const curRes = await api.get(`/api/items/${encodeURIComponent(libraryItemId)}?expanded=1`);
    const libraryItem = curRes.data;
    const libraryId = libraryItem?.libraryId;
    const series = (libraryItem?.media?.metadata?.series || [])[0];
    if (!libraryId || !series?.id) return null;
    const currentSequence = parseFloat(series.sequence);
    const res = await api.get(
      `/api/libraries/${libraryId}/series/${encodeURIComponent(series.id)}`
    );
    const books: any[] = res.data?.books || [];
    if (!books.length) return null;
    // A book can belong to MULTIPLE series — match the sequence to the series
    // we're following, not series[0].
    const sequenceInSeries = (b: any) =>
      parseFloat(
        (b?.media?.metadata?.series || []).find((s: any) => s?.id === series.id)?.sequence
      );
    const sorted = books
      .filter((b) => b.id !== libraryItemId)
      .sort((a, b) => (sequenceInSeries(a) || 0) - (sequenceInSeries(b) || 0));
    const after = sorted.filter((b) => {
      const seq = sequenceInSeries(b);
      return !isNaN(currentSequence) && !isNaN(seq) && seq > currentSequence;
    });
    const candidates = after.length ? after : sorted;
    if (!candidates.length) return null;
    // Prefer a downloaded next book (its playback can then run from local
    // files); else the immediate next.
    try {
      const { useDownloadStore } = require("./useDownloadStore");
      const completed = useDownloadStore.getState().completedDownloads || {};
      const downloaded = candidates.find((b) => completed[b.id]);
      if (downloaded) return downloaded.id;
    } catch {}
    return candidates[0].id;
  } catch {
    return null;
  }
}

// Fired once when a book finishes (from the auto-finish block). Advances to the
// next QUEUED book if any; otherwise, when enabled, auto-plays the next book in
// the series. Casting keeps working — advancing routes through startPlayback →
// preparePlaybackSession, which loads the receiver while casting.
let _autoAdvancing = false;
export async function autoAdvanceAfterFinish(finishedItemId: string, episodeId?: string | null) {
  if (episodeId) return; // podcast episodes don't queue / series-advance
  if (!finishedItemId || _autoAdvancing) return;
  _autoAdvancing = true;
  try {
    const store = usePlaybackStore.getState();
    // The user may have switched books between finish and now — only advance if
    // the finished book is still active (or nothing is active). Guards BOTH the
    // queue and series branches: this runs fire-and-forget, so a book the user
    // manually started after the finish must not be yanked off by the OLD book's
    // advance (the queue branch previously lacked this check).
    const cur = store.currentSession;
    const curId = cur?.libraryItemId || cur?.libraryItem?.id;
    if (cur && curId && curId !== finishedItemId) return;
    if (store.queue.length > 0) {
      await store.playNextInQueue();
      return;
    }
    if (!getAutoPlayNext()) return;
    const nextId = await resolveNextInSeries(finishedItemId);
    if (!nextId) return;
    // Re-check after the (awaited) series resolution: the user may have started a
    // different book while it was in flight.
    const cur2 = usePlaybackStore.getState().currentSession;
    const curId2 = cur2?.libraryItemId || cur2?.libraryItem?.id;
    if (cur2 && curId2 && curId2 !== finishedItemId) return;
    await usePlaybackStore.getState().startPlayback(nextId);
  } catch (e) {
    console.warn("[PlaybackStore] auto-advance failed", e);
  } finally {
    _autoAdvancing = false;
  }
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
  try {
    const isChapterQueue = usePlaybackStore.getState().chapterQueue;
    // Only a MULTI-FILE queue (one RNTP item per file) needs a native round-trip
    // to learn the active FILE index. The common cases are derivable without the
    // per-second bridge call: a chapter-queue's active item IS the current
    // chapter, and a single-item session is always index 0. Casting can remap
    // the local queue, so ask natively there too.
    const trackCount = (session?.audioTracks || session?.tracks || []).length;
    const needsNativeIndex = trackCount > 1 || usePlaybackStore.getState().isCasting;
    const activeIndex = needsNativeIndex
      ? await TrackPlayer.getActiveTrackIndex()
      : isChapterQueue && chapterIndex >= 0
      ? chapterIndex
      : 0;
    if (activeIndex == null) return;
    // Dedup native work when NOTHING moved. We must re-apply on a change to
    // EITHER the chapter OR the active queue item: a MULTI-FILE book moves the
    // inline cover bytes onto the active FILE item, whose index changes at file
    // boundaries WITHOUT the chapter index necessarily changing (a chapterless
    // multi-file book keeps chapterIndex=-1 across every file). Keying the
    // dedup on chapterIndex alone stranded the bytes on file 0.
    if (chapterIndex === _lastMetaChapter && activeIndex === _metaAppliedIndex) return;
    const book = session.displayTitle || "Audiobook";
    const author = session.displayAuthor || "";
    // Bytes live on the ACTIVE queue item ONLY — a chapter-queue item per
    // chapter, a file item per file. If they lingered on every item the ~40KB
    // cover on each of a long book's items would blow past Android Auto's ~1MB
    // Binder limit when Media3 bundles the whole Timeline
    // (TransactionTooLargeException → queue drops / controller crash). So on
    // each chapter/file change we MOVE them: stamp the newly-active item, then
    // strip the previously-active one. Empty-string localArtwork (not
    // undefined) also blocks toMediaItem's `localArtwork ?: artwork` byte
    // fallback so a LOCAL artwork URI can't re-inline bytes on the stripped
    // item.
    //
    // SET-NEW-THEN-STRIP-OLD: stamping the new active item BEFORE clearing the
    // old one leaves a momentary 2-item byte overlap (trivially under the
    // Binder limit) instead of a window with zero bytes, which briefly blanked
    // the compact card on every chapter/track change.
    const ch = chapters?.[chapterIndex];
    const title = ch?.title || book;
    const subtitle = ch ? [book, author].filter(Boolean).join(" • ") : author;
    const meta: any = { title, artist: subtitle };
    // artwork = the full card's artworkUri (unchanged). localArtwork = the
    // LOCAL cover file whose bytes the native layer inlines as artworkData for
    // the compact card — kept separate so the artworkUri is never disturbed.
    if (session.coverUrl) meta.artwork = session.coverUrl;
    const localArt =
      session.carArtworkLocal ||
      (session.coverUrl && !session.coverUrl.startsWith("http") ? session.coverUrl : undefined);
    if (localArt) meta.localArtwork = localArt;
    await TrackPlayer.updateMetadataForTrack(activeIndex, meta);
    // Strip the previously-active item's bytes (both queue modes). A
    // chapter-queue item's intrinsic title is its chapter; a file item's is the
    // book title (that is how the file items were built at prepare).
    if (_metaAppliedIndex >= 0 && _metaAppliedIndex !== activeIndex) {
      try {
        const prevTitle = isChapterQueue
          ? chapters?.[_metaAppliedIndex]?.title || book
          : book;
        const clearMeta: any = {
          title: prevTitle,
          artist: [book, author].filter(Boolean).join(" • "),
          localArtwork: "",
        };
        if (session.coverUrl) clearMeta.artwork = session.coverUrl;
        await TrackPlayer.updateMetadataForTrack(_metaAppliedIndex, clearMeta);
      } catch {}
    }
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
    const localArt =
      s.carArtworkLocal ||
      (s.coverUrl && !s.coverUrl.startsWith("http") ? s.coverUrl : undefined);
    if (localArt) meta.localArtwork = localArt;
    await TrackPlayer.updateMetadataForTrack(idx, meta);
  } catch {}
}

// Surfaces a play failure to the user — every play button in the app funnels
// through startPlayback, and a silent `return false` read as "tap did
// nothing". Alert is the app's established feedback pattern; in headless
// contexts (Android Auto) there's no activity, so it safely no-ops.
function alertPlayFailure(message: string) {
  // Themed Material 3 dialog. In headless contexts (Android Auto) there's no
  // mounted React tree, so the <AppDialog/> host never renders — the state is
  // set but nothing shows, the same safe no-op as before.
  try {
    const { showAppDialog } = require("./useDialogStore");
    showAppDialog({ title: "Couldn't play", message });
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

// Android Auto's COMPACT surfaces — the home-screen media card and the mini
// control bar shown while browsing — render cover art ONLY from inline
// artworkData bytes; unlike the full now-playing screen they never resolve a
// remote artworkUri (the same limitation the queue view has, see
// AudioItem.toMediaItem). So a streaming book — or a downloaded one whose cover
// image wasn't among the downloaded parts — whose cover is an http URL shows a
// BLANK tile in the car's small player even though the big player has art.
//
// Fix: fetch the cover to a local cache file once, then point the session's
// carArtworkLocal at that file. The next metadata push (forced via
// _lastMetaChapter) rebuilds the ACTIVE track through toMediaItem, which inlines
// the local file's bytes as artworkData (via the track's `localArtwork`) —
// lighting up the compact card. Crucially we do NOT re-point coverUrl: that is
// the artworkUri the FULL now-playing card depends on, and the OLD code
// overwrote it with this private cache path — which the car can't read, blanking
// the compact card's URI path (and needlessly disturbing the big player).
// Keeping coverUrl as the http URL leaves the full card untouched. Best-effort:
// any failure just leaves the remote URL in place, exactly as before.
//
// TRADEOFF (deliberate): the inlined bytes are downsampled to <=512px (see
// AudioItem.localArtworkBytes), so a single-file STREAMING book's FULL card,
// were it to prefer the bytes, would show 512px art. Media3 keeps BOTH the http
// artworkUri (high-res, resolved by the app's BitmapLoader on the full card) and
// the bytes (compact card, which cannot resolve a URI) on the one active item —
// the full card uses the URI, so it stays high-res. Bytes are placed on the
// ACTIVE item ONLY (a chaptered book moves them per chapter); inactive queue
// items carry no bytes, so a long book never exceeds the AA Binder limit.
async function cacheNowPlayingCoverLocally(itemId: string, url: string, gen: number) {
  try {
    if (!itemId || !url || !url.startsWith("http")) return;
    const safeId = itemId.replace(/[^a-zA-Z0-9._-]/g, "_");
    const dir = `${FileSystem.cacheDirectory}nowplaying/`;
    const path = `${dir}cover_${safeId}.jpg`;
    // The cover image is identical across token rotations, so a file already
    // cached for this item is reused — no repeat download on every prepare.
    const info = await FileSystem.getInfoAsync(path);
    if (!info?.exists) {
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
      const res = await FileSystem.downloadAsync(url, path);
      if (!res || (typeof res.status === "number" && res.status >= 400)) return;
    }
    // A different book may have been prepared while the download ran — only
    // touch the session that is still live and still this item.
    if (gen !== _sessionGen) return;
    const st = usePlaybackStore.getState();
    const s = st.currentSession;
    if (!s || (s.libraryItemId || s.libraryItem?.id) !== itemId) return;
    if (s.carArtworkLocal === path) return;
    usePlaybackStore.setState({ currentSession: { ...s, carArtworkLocal: path } });
    // Push the new (local) artwork onto the ACTIVE track now instead of waiting
    // for the next tick. applyNowPlayingChapter stamps the bytes onto the active
    // item (and the tick will keep moving them as chapters advance) for both
    // single-track AND chapter-queue books, recomputing the correct title/artist
    // for either mode (resetting _lastMetaChapter first so it isn't deduped away).
    _lastMetaChapter = -2;
    await applyNowPlayingChapter(
      usePlaybackStore.getState().currentSession,
      st.chapters,
      usePlaybackStore.getState().currentChapterIndex
    );
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
    // Podcast EPISODES key the map by `${itemId}-${episodeId}` (the
    // same convention as /api/me) — a plain-itemId write for an
    // episode would pollute the map with a bogus item-level entry.
    const sessionEpisodeId = currentSession.episodeId || null;
    const progressMapKey = sessionEpisodeId
      ? `${currentSession.libraryItemId}-${sessionEpisodeId}`
      : currentSession.libraryItemId;
    const existingEntry = useUserStore.getState().mediaProgress[progressMapKey];
    // A book finished EARLIER (previous session, the ebook side, or another
    // device) must stay finished — re-sampling a finished book used to flip
    // its local badge to unfinished on the first playing tick while the
    // server still said finished.
    const alreadyFinished =
      _finishedSessionId === currentSession.id || existingEntry?.isFinished === true;
    const progressObj = {
      libraryItemId: currentSession.libraryItemId,
      ...(sessionEpisodeId ? { episodeId: sessionEpisodeId } : {}),
      currentTime: absolutePosition,
      duration: bookDuration,
      progress: bookDuration > 0 ? Math.min(1, absolutePosition / bookDuration) : 0,
      isFinished: alreadyFinished,
      updatedAt: now,
    };
    // Skip the mirror write when nothing the badge DISPLAYS has changed. The
    // badge shows a rounded percent OR a whole remaining-minute (see
    // BookProgressBadge), so gate on exactly those + the finished flag. A book
    // playing for an hour used to rewrite this map ~3600 times; now it writes
    // only when the visible value ticks over (percent / minute / finished),
    // keeping the UI in sync without re-rendering the library list every tick.
    const roundedPct = Math.round((progressObj.progress || 0) * 100);
    const remainingSec = bookDuration - absolutePosition;
    const remainingMin = Math.floor(remainingSec / 60);
    // In the final minute BookProgressBadge switches from whole minutes to raw
    // seconds ("Xs"), but the whole-minute bucket is a constant 0 there, so the
    // throttle signature stopped changing and the badge froze at its last "Xs".
    // Add a coarse ~15s sub-bucket for the last minute so the sub-minute
    // countdown keeps updating (~every 15s) without reintroducing per-second
    // mirror churn. Outside the last minute the bucket is a constant (-1) so it
    // never affects the throttle.
    const subMinBucket = remainingSec < 60 ? Math.floor(remainingSec / 15) : -1;
    const mirrorSig = `${progressMapKey}|${roundedPct}|${remainingMin}|${subMinBucket}|${alreadyFinished ? 1 : 0}`;
    // Only throttle when the book duration is known: with an unknown (0)
    // duration the badge can't show a percent/remaining anyway, so the gate
    // would collapse every distinct position to one signature — keep the old
    // always-write behavior there. Otherwise skip the write when nothing the
    // badge displays changed.
    if (bookDuration <= 0 || mirrorSig !== _lastMirrorSig) {
      _lastMirrorSig = mirrorSig;
      useUserStore.setState({
        mediaProgress: {
          ...useUserStore.getState().mediaProgress,
          [progressMapKey]: {
            ...useUserStore.getState().mediaProgress[progressMapKey],
            ...progressObj,
          },
        },
      });
    }

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
      // Finish is a significant event: force the next display-mirror tick to
      // re-write so the throttle gate can't suppress a stale in-progress value.
      _lastMirrorSig = null;
      // Finishing a downloaded book is the trigger for auto-download-next-in-
      // series (only for books, not podcast episodes) — one book, opt-in, gated
      // on this one being downloaded. Fire-and-forget; never block persistence.
      if (!sessionEpisodeId) {
        try {
          const { autoDownloadNextAfterFinish } = require("../utils/downloader");
          autoDownloadNextAfterFinish(libraryItemId).catch(() => {});
        } catch {}
      }
      // Cross-book queue + series auto-next: advance to the next queued book
      // (or next in series) when this book finishes. Fire-and-forget; never
      // block persistence. Guarded once-per-session by the enclosing
      // _finishedSessionId check above.
      try {
        autoAdvanceAfterFinish(libraryItemId, sessionEpisodeId).catch(() => {});
      } catch {}
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
    // A native progress sample that arrives right after a local pause() is a
    // straggler for audio that has already stopped — accepting it would
    // hard-set isPlaying:true and accrue listening time + re-stamp updatedAt on
    // a paused book (matches the paused-tick-must-not-restamp gate in
    // persistProgressSample). Ignore samples inside the post-pause window.
    // play() clears _lastPausedAt, so real resumes are unaffected.
    if (_lastPausedAt != null && Date.now() - _lastPausedAt < PAUSE_STRAGGLER_WINDOW_MS) {
      return;
    }

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

// Event-driven persistence for CAST sessions. While casting, the local
// player is paused, so the native PlaybackProgressUpdated events that keep
// persistence alive in the background never fire — the only driver was the
// JS 1s interval, which Android throttles with the screen off (a long cast
// session with the phone asleep stopped saving/syncing entirely). The cast
// SDK's receiver-progress callbacks are native→JS EVENTS (delivered even
// while timers are throttled, same as RNTP's), so CastController feeds each
// mirrored sample through the same throttled persistence pipeline here.
export function persistCastProgressSample(absolutePosition: number) {
  const st = usePlaybackStore.getState();
  if (!st.currentSession || !st.isCasting) return;
  persistProgressSample(st.currentSession, absolutePosition, st.duration, st.isPlaying);
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
    // Token rotated since the queue was built? retry() re-prepares the SAME
    // URLs, so an auth-expired stream would 401 forever — rebuild the queue
    // with fresh-token URLs at the current position instead. (Local-file
    // sessions never carry tokens; their URLs can't go stale.)
    const cfgToken = storageHelper.getServerConfig()?.token || "";
    if (
      _preparedToken != null &&
      cfgToken &&
      cfgToken !== _preparedToken &&
      !String(st.currentSession.id || "").startsWith("local_")
    ) {
      const resume = rec.resume;
      _errorRecovery = null;
      console.log("[PlaybackStore] Token rotated mid-session — rebuilding stream URLs.");
      return usePlaybackStore
        .getState()
        .preparePlaybackSession({ ...st.currentSession, currentTime: st.position }, resume);
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

// Reconcile the JS store with a session the NATIVE player is already driving.
//
// Android Auto can cold-start playback while the JS engine is DEAD: the native
// Media3 session resolves and plays the book itself and never calls
// preparePlaybackSession, so the store keeps currentSession=null / position=0.
// When the user then opens the app the progress bars sit frozen at the pre-AA
// position (or empty), because the 1s poll is gated on `isPlaying` and there is
// no session to poll. This adopts the live session so the bars go live:
//   • No JS session but the native player is on a "play:<itemId>" queue item
//     (an Android-Auto-originated play) → rebuild the real session via
//     startPlayback so chapters/duration are correct, then let the poll drive.
//   • Session already known but `isPlaying` was left false while the native
//     player actually plays (e.g. the JS context reloaded, or an external
//     resume) → flip isPlaying so the existing poll resumes advancing the bars.
// Best-effort and side-effect-free on failure: if the native player exposes no
// live "play:" track (its queue was torn down when the real player initialised)
// this returns false and the caller falls back to the normal disk restore.
export async function reconcileWithNativePlayer(): Promise<boolean> {
  try {
    const st = usePlaybackStore.getState();
    if (st.isCasting) return false;
    const ps: any = await TrackPlayer.getPlaybackState().catch(() => null);
    const playing = ps?.state === State.Playing || ps?.state === State.Buffering;

    if (st.currentSession) {
      // The session is known; the only staleness the poll can't self-heal is a
      // stuck isPlaying=false (the poll early-returns on it). Flip it so the
      // next tick recomputes position/duration — the poll owns the correct
      // per-queue-mode position translation, so we don't touch position here.
      if (playing && !st.isPlaying) {
        usePlaybackStore.setState({ isPlaying: true });
      }
      return false;
    }

    // No JS session. Only adopt when the native player is ACTIVELY playing —
    // adoption goes through startPlayback, which always prepares with
    // playWhenReady=true, so adopting a paused/idle native session would start
    // playback merely because the user foregrounded the app (e.g. an AA session
    // they'd paused). When it isn't playing, fall through to the disk restore
    // (which restores paused), so foregrounding never auto-starts audio.
    if (!playing) return false;

    // Adopt only an Android-Auto-originated item — its mediaId is tagged
    // "play:<itemId>" / "play:<itemId>::<episodeId>" (see the RNTP patch
    // onAddMediaItems). A queue with any other mediaId isn't ours to rebuild.
    const active: any = await TrackPlayer.getActiveTrack().catch(() => null);
    const mediaId = String(active?.mediaId ?? active?.id ?? "");
    if (!mediaId.startsWith("play:")) return false;
    const raw = mediaId.slice("play:".length).split("@@")[0];
    const itemId = raw.split("::")[0];
    const episodeId = raw.includes("::") ? raw.split("::")[1] || undefined : undefined;
    if (!itemId) return false;
    console.log(`[PlaybackStore] Adopting Android Auto native session for ${itemId}.`);
    return await usePlaybackStore.getState().startPlayback(itemId, episodeId);
  } catch {
    return false;
  }
}

/** A queued book (or podcast episode) awaiting cross-book auto-advance. */
export interface QueueItem {
  libraryItemId: string;
  episodeId?: string;
  title?: string;
  author?: string;
  coverUrl?: string;
}

/** Shared shape of the active sleep-timer state (null when no timer runs). */
export interface SleepTimerState {
  endOfChapter: boolean;
  remaining: number; // seconds left, or seconds until end of chapter
  // Chapter the end-of-chapter timer was armed in — lets the tick detect
  // the boundary crossing even if a tick lands just past it.
  chapterIdx?: number;
}

interface PlaybackState {
  currentSession: any | null;
  isPlaying: boolean;
  // True while the native player is stalled (Buffering/Loading) — the progress
  // interval folds those states into "playing", so without this a mid-stream
  // stall showed the pause glyph over a frozen scrubber (looked hung). Set from
  // the TrackPlayer PlaybackState events observed in playbackService.
  isBuffering: boolean;
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
  sleepTimer: SleepTimerState | null;
  // "Rewind on wake": when a sleep timer pauses playback, the next resume
  // rewinds a dedicated amount (persisted; default ON).
  sleepRewindOnWake: boolean;
  setSleepRewindOnWake: (value: boolean) => void;
  // Shake-to-extend an armed sleep timer (persisted; default ON). No-op unless
  // expo-sensors is present — see armShakeListener.
  sleepShakeToExtend: boolean;
  setSleepShakeToExtend: (value: boolean) => void;

  // Per-book playback-speed memory (persisted; default ON). When ON, each book
  // resumes at the last speed set for THAT book; when OFF, the global rate is
  // used everywhere (today's behavior).
  rememberSpeedPerBook: boolean;
  setRememberSpeedPerBook: (value: boolean) => void;

  // Cross-book play queue — books to auto-advance to on finish.
  queue: QueueItem[];
  addToQueue: (item: QueueItem) => void;
  removeFromQueue: (libraryItemId: string) => void;
  clearQueue: () => void;
  playNextInQueue: () => Promise<boolean>;

  // Actions
  initializePlayer: () => Promise<void>;
  startPlayback: (itemId: string, episodeId?: string) => Promise<boolean>;
  preparePlaybackSession: (session: any, playWhenReady?: boolean) => Promise<boolean>;
  playPause: () => Promise<void>;
  play: () => Promise<void>;
  pause: () => Promise<void>;
  seek: (value: number) => Promise<void>;
  // Seek from a remote (notification / Android Auto) seekbar, whose position is
  // reported relative to the ACTIVE queue item. Maps that to an absolute book
  // position before seeking.
  remoteSeek: (trackPosition: number) => Promise<void>;
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
  isBuffering: false,
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
  sleepRewindOnWake: getSleepRewindOnWake(),
  sleepShakeToExtend: getSleepShakeToExtend(),
  rememberSpeedPerBook: getRememberSpeedPerBook(),
  queue: getStoredQueue(),
  isPlayerExpanded: false,
  setPlayerExpanded: (expanded: boolean) => set({ isPlayerExpanded: expanded }),
  onTabScreen: true,
  setOnTabScreen: (isTab: boolean) => set({ onTabScreen: isTab }),

  setSleepRewindOnWake: (value: boolean) => {
    try {
      storage.set(SLEEP_REWIND_ON_WAKE_KEY, !!value);
    } catch {}
    set({ sleepRewindOnWake: !!value });
  },
  setSleepShakeToExtend: (value: boolean) => {
    try {
      storage.set(SLEEP_SHAKE_KEY, !!value);
    } catch {}
    set({ sleepShakeToExtend: !!value });
    // Re-arm / disarm live if a timer is currently running.
    if (get().sleepTimer) {
      if (value) armShakeListener();
      else disarmShakeListener();
    }
  },

  setRememberSpeedPerBook: (value: boolean) => {
    try {
      storage.set(REMEMBER_RATE_KEY, !!value);
    } catch {}
    set({ rememberSpeedPerBook: !!value });
    // Turning it ON records the CURRENT book's active rate right away, so it's
    // remembered even if the user never touches the stepper again.
    if (value) {
      const s = get().currentSession;
      const itemId = s?.libraryItemId || s?.libraryItem?.id;
      if (itemId) setPerBookRate(itemId, get().playbackSpeed);
    }
  },

  addToQueue: (item: QueueItem) => {
    if (!item?.libraryItemId) return;
    const cur = get().queue;
    // De-dupe by libraryItemId (+episodeId) so re-queuing doesn't stack.
    if (
      cur.some(
        (q) =>
          q.libraryItemId === item.libraryItemId &&
          (q.episodeId || null) === (item.episodeId || null)
      )
    ) {
      return;
    }
    const next = [...cur, item];
    persistQueue(next);
    set({ queue: next });
  },
  removeFromQueue: (libraryItemId: string) => {
    const next = get().queue.filter((q) => q.libraryItemId !== libraryItemId);
    persistQueue(next);
    set({ queue: next });
  },
  clearQueue: () => {
    persistQueue([]);
    set({ queue: [] });
  },
  playNextInQueue: async () => {
    const q = get().queue;
    if (!q.length) return false;
    const [next, ...rest] = q;
    // Pop BEFORE starting: startPlayback awaits the network, and a finish that
    // fires again mid-start must not re-pick the same item.
    persistQueue(rest);
    set({ queue: rest });
    return await get().startPlayback(next.libraryItemId, next.episodeId);
  },

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
    // A session is already loaded — restoring over it would TrackPlayer.reset()
    // the LIVE queue and re-prepare it paused. This is not theoretical: Android
    // reclaims the Activity while the foreground service keeps playing, and
    // reopening the app remounts App.tsx on the living JS context, re-running
    // its init → loadLastSession — which paused active background playback the
    // moment the user opened the app. The in-memory session (playing OR
    // paused) is always fresher than the disk save; restore is only for cold
    // starts with an empty store.
    if (get().currentSession) {
      console.log("[PlaybackStore] Live session active — skipping saved-session restore.");
      return;
    }
    // Android Auto may have cold-started playback while JS was dead — adopt that
    // live native session instead of restoring the (stale) disk save paused over
    // it. No-ops when there's no live "play:" track, so cold starts still fall
    // through to the disk restore below.
    if (await reconcileWithNativePlayer()) {
      console.log("[PlaybackStore] Adopted live native session — skipping disk restore.");
      return;
    }
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
      // Snapshot the session generation BEFORE the up-to-3s await below: a user
      // tapping a book during cold start starts a real session (bumping
      // _sessionGen and setting currentSession) while we're blocked here.
      const genBeforeFetch = _sessionGen;
      try {
        const itemId = session.libraryItemId || session.libraryItem?.id;
        if (itemId) {
          // Podcast progress is keyed per EPISODE server-side — the item-level
          // GET returns nothing useful for an episode session.
          const progressPath = session.episodeId
            ? `/api/me/progress/${encodeURIComponent(itemId)}/${encodeURIComponent(session.episodeId)}`
            : `/api/me/progress/${encodeURIComponent(itemId)}`;
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
      // TOCTOU: the currentSession check at the top of loadLastSession ran
      // BEFORE the freshness GET above. A book tapped during that up-to-3s
      // window already prepared a LIVE session — restoring the saved session
      // over it would TrackPlayer.reset() the live queue and re-prepare it
      // paused (the exact clobber the top guard exists to prevent). Re-check
      // both the live session and the generation before preparing.
      if (get().currentSession || _sessionGen !== genBeforeFetch) {
        console.log(
          "[PlaybackStore] Live session started during restore — skipping saved-session restore."
        );
        return;
      }
      try {
        const ok = await get().preparePlaybackSession(session, false);
        // Seed the auto-rewind anchor from the save's timestamp AFTER the
        // prepare (which clears it): the paused-at stamp is module state, so
        // a process kill between pause and this restore silently disabled
        // the rewind nudge — resume dropped the user cold mid-sentence some
        // mornings and reoriented them on others.
        if (ok && Number(session.updatedAt) > 0) {
          _lastPausedAt = Number(session.updatedAt);
        }
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
    // Set true after setup succeeds — fresh OR the benign "already initialized"
    // case — so the shared progress-poll setup below runs for both paths (a
    // native player that survived a JS reload still needs the JS poll).
    let ready = false;

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
        // 256MB LRU disk cache (app cacheDir) over streamed audio — the RNTP
        // option is in KILOBYTES (native: cacheSizeKb * 1000 bytes), so
        // 256 * 1024 KB ≈ 262 MB. Chapter
        // queues clip MANY items out of ONE file URL, and every chapter
        // boundary re-opens that URL — a fresh network fetch at exactly the
        // moment the doze-throttled network is least reliable (the classic
        // "book stopped at the end of a chapter overnight"). With the cache,
        // boundary loads (and auto-rewind/chapter jumps into recent audio)
        // hit disk instead.
        maxCacheSize: 256 * 1024,
        // Hand audio focus to ExoPlayer (pause on call/assistant/other media,
        // duck for nav prompts, auto-resume after transient loss — all
        // native, so it works dozed and in Android Auto). The native read is
        // Bundle.getBoolean(key) with NO default, so a non-null options
        // bundle that omits the key silently DISABLED focus handling — the
        // book used to play straight over navigation prompts and calls
        // (kotlinaudio's fallback FocusManager only emits an event nothing
        // listens to; it never pauses).
        autoHandleInterruptions: true,
        // Speech content type: audiobooks aren't music, and the hint changes
        // system focus/ducking semantics (nav prompts and the assistant duck
        // vs. interrupt differently) and engages speech-aware output routing on
        // some head units. Native maps "speech" → C.AUDIO_CONTENT_TYPE_SPEECH;
        // without it the else-branch defaulted to MUSIC.
        androidAudioContentType: "speech",
      } as any);
      await TrackPlayer.updateOptions(buildPlayerOptions());

      // Request notification permission now (Android 13+) so the media
      // notification + lock-screen controls actually appear for listen-only
      // users — the download path is the only other request site and a
      // streaming user may never hit it.
      try {
        const { ensurePlaybackNotificationPermission } = require("../utils/downloadNotifications");
        // Fire-and-forget: the try/catch only guards the sync require, so a
        // rejected promise needs its own .catch() to avoid an unhandled rejection.
        ensurePlaybackNotificationPermission().catch(() => {});
      } catch {}

      set({ isInitialized: true });
      console.log("[PlaybackStore] TrackPlayer initialized successfully.");
      ready = true;
    } catch (error: any) {
      // RNTP throws an "already initialized" error if the native player survived
      // a JS reload — that's benign, so mark initialized AND start the poll
      // below. Any OTHER failure is real: leave isInitialized false so the next
      // play()/startPlayback retries setup instead of every transport call
      // silently no-oping.
      const alreadyInit = String(error?.code ?? error?.message ?? "")
        .toLowerCase()
        .includes("already");
      if (alreadyInit) {
        set({ isInitialized: true });
        ready = true;
      } else {
        console.error("[PlaybackStore] TrackPlayer setup failed:", error);
      }
    }

    // Progress poll — OUTSIDE the try/catch so the "already initialized"
    // recovery starts it too (it previously only ran on the fresh-setup path,
    // leaving a surviving-native-player session with no JS poll). Sync player
    // state to Zustand reactively; guard against a second interval (double init
    // across a Fast Refresh) and skip the native round-trips when no session is
    // loaded so we don't poll the player while idle.
    if (ready) {
      if (progressInterval) clearInterval(progressInterval);
      progressInterval = setInterval(async () => {
        if (!get().isInitialized || !get().currentSession) return;
        // PAUSED: nothing below changes (persistence is playing-gated), so
        // skip the 3 native round-trips this tick used to burn — a session
        // paused for hours cost ~11k bridge calls/hour. External resumes
        // flip isPlaying back via native progress samples / PlaybackState
        // events / play(), all event-driven.
        if (!get().isPlaying && !get().isCasting) return;
        // The session this tick is reporting on — a prepare/close completing
        // during the awaits below must not have its fresh state overwritten
        // with this tick's stale readings.
        const tickSession = get().currentSession;
        try {
          const chapters = get().chapters;
          const chapterQueue = get().chapterQueue;
          const casting = get().isCasting;

          let absolutePosition: number;
          let bookDuration: number;
          // `isPlayerPlaying` is the FOLDED UI flag (Playing OR Buffering OR
          // Loading) written to isPlaying — a transient stall must not flip the
          // mini-player/notification to the pause glyph, freeze the scrubber,
          // or disarm this tick. `isPlayingStrict` is true ONLY for real
          // Playing and gates listening-time accrual / persistence so a stall
          // never accrues time or re-stamps updatedAt.
          let isPlayerPlaying: boolean;
          let isPlayingStrict: boolean;
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
            isPlayingStrict = get().isPlaying;
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
            isPlayingStrict = playerState.state === State.Playing;
            // Fold Buffering/Loading into the playing UI flag (see comment at
            // the isBuffering field): a mid-stream stall keeps the play glyph
            // and a live scrubber instead of looking hung.
            isPlayerPlaying =
              isPlayingStrict ||
              playerState.state === State.Buffering ||
              playerState.state === State.Loading;

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

            // A prepare/close finished during the awaits above — these
            // readings describe the OLD queue; writing them would corrupt
            // the new session's state (or resurrect a closed one).
            if (get().currentSession !== tickSession) return;

            set({
              position: absolutePosition,
              duration: bookDuration,
              isPlaying: isPlayerPlaying,
              currentChapterIndex: chapterIndex,
            });

            // Single-track / multi-file books need the current chapter TITLE
            // pushed to the now-playing metadata. Chapter-queue books already
            // title each item, but they still call through here so the inline
            // artwork bytes get MOVED onto the newly-active chapter item (and
            // stripped off the previous one) — bytes live on the active item
            // only to stay under Android Auto's Binder limit. Both are deduped
            // by _lastMetaChapter so this only does native work on a real
            // chapter change.
            applyNowPlayingChapter(get().currentSession, chapters, chapterIndex);
          }

          if (get().currentSession !== tickSession) return;
          // Accrual/persistence gate on STRICT Playing — a Buffering/Loading
          // tick advances the UI flag above but must NOT accrue listening time
          // or re-stamp updatedAt (that would poison freshest-wins).
          persistProgressSample(
            get().currentSession,
            absolutePosition,
            bookDuration,
            isPlayingStrict
          );
        } catch (e) {
          // Player might not be active/loaded
        }
      }, 1000);
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
        const { useDownloadStore, episodeDownloadKey } = require("./useDownloadStore");
        // Podcast episodes are downloaded under the composite key; books under
        // the bare libraryItemId. Resolve whichever this play is for.
        const downloadKey = episodeId ? episodeDownloadKey(itemId, episodeId) : itemId;
        const dl = useDownloadStore.getState().completedDownloads[downloadKey];
        // Requires actual AUDIO tracks — an ebook-only download has meta but an
        // empty tracks list, and "playing" it would reset the player into an
        // empty queue (the reader is its playback surface, not us). A
        // non-downloaded episode simply has no entry here and keeps streaming.
        if (dl?.meta?.tracks?.length && dl.localFolderPath) {
          const lastLocal = useUserStore.getState().getMediaProgress(itemId, episodeId);
          const localSession = {
            id: episodeId ? `local_${downloadKey}` : `local_${itemId}`,
            libraryItemId: itemId,
            episodeId: episodeId || undefined,
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

    // Switching books/episodes is an implicit stop of the outgoing session:
    // close it on the server (final position + the listening time still
    // accumulating toward the next 15s sync). Without this, every book
    // switch leaked an open ABS session and silently dropped up to 15s of
    // listening stats. Fire-and-forget — closeSession self-queues offline.
    const prevSession = get().currentSession;
    if (prevSession?.id && prevSession.id !== session.id) {
      const prevPos = await getLiveAbsolutePosition(get);
      // A newer prepare claimed the session during the await — IT owns
      // closing the outgoing session; firing ours too double-closed it.
      if (stale()) return false;
      const prevAccum = _timeListenedAccum;
      _timeListenedAccum = 0;
      closeSession({
        sessionId: prevSession.id,
        currentTime: prevPos,
        timeListened: prevAccum,
        duration: get().duration,
        libraryItemId: prevSession.libraryItemId,
        episodeId: prevSession.episodeId || undefined,
      }).catch(() => {});
      // LOCK: an audio session for this item just closed — if the user linked
      // its progresses, pull the EBOOK up to this listening position
      // (furthest-wins, fraction-only; see reconcileLinkedProgress). No-op
      // unless locked, and never for podcast episodes. Guarded so a failure
      // here can't disturb the session switch.
      try {
        const prevDur = get().duration;
        if (!prevSession.episodeId && prevSession.libraryItemId) {
          reconcileLinkedProgress(prevSession.libraryItemId, {
            audioFraction: prevDur > 0 ? prevPos / prevDur : 0,
            duration: prevDur,
          });
        }
      } catch {}
      if (stale()) return false;
    }

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
      // Remember which token the queue URLs were built with — token rotation
      // recovery (recoverPlaybackIfNeeded) compares against it to decide
      // between retry() (same URLs) and a full URL rebuild.
      _preparedToken = token;

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
      // play the local copy (faster / offline) instead of streaming. Podcast
      // EPISODES are stored under the composite `episodeDownloadKey(itemId,
      // episodeId)` (books under the bare libraryItemId) — mirror how
      // startPlayback resolves them, else a downloaded episode would always
      // stream and its offline cover would be blank.
      const { useDownloadStore, episodeDownloadKey } = require("./useDownloadStore");
      const downloadKey = libraryItemId
        ? session.episodeId
          ? episodeDownloadKey(libraryItemId, session.episodeId)
          : libraryItemId
        : null;
      const download = downloadKey
        ? useDownloadStore.getState().completedDownloads[downloadKey]
        : null;

      // Now-playing artwork. The FULL now-playing card resolves the artworkUri
      // (via the app's BitmapLoader, which loads http AND local file:// — it
      // works today and MUST NOT change). Media3 fetches artworkUri NATIVELY
      // (no axios interceptor / token refresh), so http URLs are built with the
      // CURRENT token; a stale baked-in one would 401 → no art. Priority:
      //  1. the downloaded cover FILE (token-proof, offline-proof),
      //  2. a URL built fresh with the CURRENT token,
      //  3. the session's own coverUrl with its token refreshed.
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
      // SEPARATE bytes source for Android Auto's COMPACT surfaces (home-screen
      // media card + mini control bar). Those never render from a remote
      // artworkUri; they need inline artworkData bytes, which the native layer
      // (AudioItem.toMediaItem) decodes from a LOCAL cover file. Carried as the
      // track's `localArtwork` so it feeds artworkData WITHOUT touching the
      // artworkUri the full card depends on. A downloaded book already has the
      // file; a streaming book gets one cached lazily (cacheNowPlayingCoverLocally).
      const carArtworkLocal =
        localCover || (artworkUrl && !artworkUrl.startsWith("http") ? artworkUrl : undefined);
      const localFolder = download?.localFolderPath;
      const localForTrack = (track: any, idx: number): string | null => {
        if (!download) return null;
        const key = `track_${track.index ?? idx}`;
        // Legacy completed rows can lack `parts` entirely — an unguarded
        // .find made such books unplayable even STREAMING (throw mid-prepare).
        // POSITIONAL match first: the downloader collision-uniquifies part
        // ids when metadata repeats track.index (track_1, track_1_1) — an
        // id-only lookup resolved BOTH logical tracks to the FIRST file, so
        // track 2 played track 1's audio. Track parts preserve the server
        // track order, so the idx-th track part is the right one whenever
        // its id is the expected key or its uniquified variant.
        const trackParts = (download.parts || []).filter((p: any) =>
          String(p?.id || "").startsWith("track_")
        );
        const positional = trackParts[idx];
        const part =
          positional &&
          (positional.id === key || String(positional.id).startsWith(`${key}_`))
            ? positional
            : (download.parts || []).find((p: any) => p.id === key);
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
      // Whole-book duration. NEVER trust session.duration alone: when a
      // server payload omits it, the progress drivers' `get().duration ||
      // sampleDuration` fallback collapsed to the CURRENT clip/file duration
      // and self-perpetuated — auto-finish then fired at the end of file 1
      // (or early in chapter 2), PATCHing isFinished:true for a half-read
      // book. Derive from the chapter span or the summed track durations.
      // Sanitize + SORT chapters first: badly tagged files ship inverted
      // (start > end) or non-numeric windows; a negative clip window makes
      // native behavior undefined and corrupts absolute-position math. Every
      // consumer (queue build, skip-by-index, RemoteSeek mapping, titles)
      // assumes ordered chapters.
      const sanitizedChapters = (Array.isArray(session.chapters) ? session.chapters : [])
        .filter(
          (c: any) =>
            Number.isFinite(Number(c?.start)) &&
            Number.isFinite(Number(c?.end)) &&
            Number(c.end) > Number(c.start)
        )
        .sort((a: any, b: any) => Number(a.start) - Number(b.start));

      // Chapter-span fallback comes from the FILTERED list — a garbage
      // chapter (non-finite start, huge end) is excluded from playback, so
      // letting it inflate the book duration would make the auto-finish
      // window unreachable and pin progress near 0 forever.
      const chapterSpanEnd = sanitizedChapters.reduce(
        (m: number, c: any) => Math.max(m, Number(c.end)),
        0
      );
      const tracksTotal = audioTracks.reduce(
        (acc: number, t: any) => acc + (Number(t?.duration) || 0),
        0
      );
      // Positive-only guard: a negative duration is garbage, not "known".
      const sessionDuration = Number(session.duration) > 0 ? Number(session.duration) : 0;
      const bookDurationS = sessionDuration || tracksTotal || chapterSpanEnd || 0;

      // NORMALIZE coverage: numeric coordinates (string starts would turn the
      // `chapters[i].start + relative` absolute-position math into string
      // concatenation), overlaps clamped to the next chapter's start, gaps
      // attributed to the preceding chapter, and the last chapter extended to
      // the end of the book — otherwise gap/tail audio is unreachable in
      // chapter-queue mode (each queue item is a hard clip) and a book whose
      // last chapter ends early can never hit the auto-finish window. Empty
      // windows produced by overlap-clamping (duplicate starts) are dropped.
      const chapters = sanitizedChapters
        .map((c: any, i: number, arr: any[]) => {
          const start = Number(c.start);
          let end = Number(c.end);
          if (i < arr.length - 1) {
            // Sorted by start, so nextStart >= start always. Gap → extend to
            // the next chapter; overlap → clamp to it. A DUPLICATE start
            // clamps end to start, producing an empty window that the filter
            // below drops — leaving it would create fully-overlapping clips.
            const nextStart = Number(arr[i + 1].start);
            if (nextStart !== end) end = nextStart;
          } else if (bookDurationS > end) {
            end = bookDurationS; // tail → last chapter
          }
          return { ...c, start, end };
        })
        .filter((c: any) => c.end > c.start);

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
          // Byte inlining (artworkData) must NOT go on every chapter item. On a
          // 100+ chapter book toMediaItem would inline the ~40KB cover into EACH
          // item's MediaMetadata; when Media3 bundles the whole Timeline to
          // Android Auto the payload blows past the ~1MB Binder limit
          // (TransactionTooLargeException) → the queue drops / the controller
          // crashes. Bytes live on the ACTIVE chapter item ONLY, moved there by
          // applyNowPlayingChapter on each chapter change. An EMPTY-STRING
          // localArtwork (not undefined) blocks the toMediaItem
          // `localArtwork ?: artwork` fallback so a LOCAL artwork URI can't
          // inline bytes on the inactive items either.
          t.localArtwork = "";
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
          if (audioTracks.length > 1) {
            // MULTI-FILE: NO inline bytes at build time (mirrors the
            // chapter-queue branch). A downloaded book split into many per-file
            // items would otherwise inline the ~40KB cover into EACH item's
            // MediaMetadata; Media3 bundling the whole Timeline to Android Auto
            // then blows past the ~1MB Binder limit (TransactionTooLargeException)
            // → the queue drops / the controller crashes. Bytes live on the
            // ACTIVE file item only, moved there per file boundary by
            // applyNowPlayingChapter. Empty-string (not undefined) also blocks
            // toMediaItem's `localArtwork ?: artwork` fallback so a LOCAL
            // artwork URI can't inline bytes on the inactive file items.
            t.localArtwork = "";
          } else if (carArtworkLocal) {
            // SINGLE FILE: only one queue item, so carrying the bytes at build
            // is safe (no Timeline to overflow) — behavior unchanged.
            t.localArtwork = carArtworkLocal;
          }
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
      // Number() coercion: a non-numeric string currentTime ("abc") would
      // otherwise survive to the clamp and turn the position into NaN.
      let startAbs = Number(session.currentTime) || 0;
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

        // SERVER-side adoption — the mirror image of the local rescue above.
        // MMKV-restored sessions carry the position from THIS device's last
        // save; when another device listened further since (server lastUpdate
        // meaningfully newer than every local stamp), resume from the server
        // position. loadLastSession attempts this with a live GET, but its 3s
        // timeout silently dropped the cross-device position on a slow
        // launch — the (disk-cached) mediaProgress map makes it reliable.
        // RESTORED sessions only (updatedAt stamp present): a fresh /play
        // response IS current server truth, and adopting a possibly-stale
        // cached row over it would invert the feature. The saved-session
        // stamp counts only when it belongs to THIS item/episode — an
        // unrelated book's save must not suppress a legitimate adoption.
        const isRestoredSession = Number(session.updatedAt) > 0;
        if (isRestoredSession) {
          const serverProg2 = useUserStore
            .getState()
            .getMediaProgress(libraryItemId, session.episodeId);
          const serverAt2 = Number(serverProg2?.lastUpdate) || 0;
          const savedMatches =
            saved &&
            (saved.libraryItemId || saved.libraryItem?.id) === libraryItemId &&
            (saved.episodeId || null) === (session.episodeId || null);
          const localAt2 = Math.max(
            Number(session.updatedAt) || 0,
            savedMatches ? Number(saved.updatedAt) || 0 : 0
          );
          if (
            typeof serverProg2?.currentTime === "number" &&
            serverAt2 > localAt2 + 10000 &&
            Math.abs(serverProg2.currentTime - startAbs) > 2
          ) {
            console.log(
              `[PlaybackStore] Server position is fresher (${serverProg2.currentTime}s vs ${startAbs}s) — resuming from server.`
            );
            startAbs = serverProg2.currentTime;
          }
        }
      } catch {}

      // Defensive clamp: a garbage server currentTime (past the end, or
      // negative) went straight into skip/seekTo and the position state.
      startAbs = Math.max(0, bookDurationS > 0 ? Math.min(startAbs, bookDurationS) : startAbs);

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
      _metaAppliedIndex = -1; // no prior chapter item to strip bytes from
      // A sleep timer from the previous book must not run against the new one
      // (end-of-chapter timers would pause the new book almost immediately).
      get().cancelSleepTimer();

      // Reset progress-sync bookkeeping for the new session.
      _timeListenedAccum = 0;
      _lastTickAt = null;
      _lastSyncAt = 0;
      _lastLocalSaveAt = 0;
      _lastMirrorSig = null;
      _finishedSessionId = null;
      _trackOffsets = trackOffsets;
      // The previous book's pause stamp must not apply its auto-rewind to
      // this book's first play. (loadLastSession re-seeds it AFTER preparing
      // the restored session — same book, correct anchor.)
      _lastPausedAt = null;

      await TrackPlayer.add(tracksToLoad);
      if (stale()) return false;

      // Restore the speed. Per-book memory (when enabled) wins: a book resumes
      // at the last rate set for THAT book. Otherwise fall back to the restored
      // session rate, then the global rate (original behaviour).
      const rememberedRate = getRememberSpeedPerBook() ? getPerBookRate(libraryItemId) : undefined;
      const playbackSpeed = rememberedRate || session.playbackRate || storageHelper.getPlaybackRate();
      await TrackPlayer.setRate(playbackSpeed);
      if (stale()) return false;

      if (chapterQueue) {
        // No matching chapter window: a position at/past the end (finished
        // book) belongs in the LAST chapter — the old `-1 → 0` collapse
        // seeked ~the whole book into chapter 0's clip, snapping a finished
        // book back to the start of the book on the first tick.
        let idx = startChapterIdx;
        if (idx < 0) {
          idx = startAbs >= (chapters[chapters.length - 1]?.start || 0) ? chapters.length - 1 : 0;
          startChapterIdx = idx;
        }
        if (idx > 0) await TrackPlayer.skip(idx);
        if (stale()) return false;
        const chLen = Math.max(0, (chapters[idx]?.end || 0) - (chapters[idx]?.start || 0));
        const within = Math.min(chLen, Math.max(0, startAbs - (chapters[idx]?.start || 0)));
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
        currentSession: {
          ...session,
          currentTime: startAbs,
          coverUrl: artworkUrl || session.coverUrl || "",
          // Local cover file whose bytes light Android Auto's COMPACT surfaces
          // (see the artwork comment above). Kept separate from coverUrl so the
          // full card's artworkUri is never re-pointed at a private path.
          carArtworkLocal: carArtworkLocal || undefined,
        },
        playbackSpeed,
        chapters,
        chapterQueue,
        duration: bookDurationS,
        position: startAbs,
        currentChapterIndex: startChapterIdx,
      });

      // Mirror the current book to the home-screen resume widget and to the
      // native Media3 service (itemId powers Android Auto's resume card).
      // episodeId is persisted too so onPlaybackResumption resumes the right
      // PODCAST EPISODE (/play/{episode}) rather than the item as a whole.
      writeWidgetState({
        title: bookTitle,
        author: bookAuthor,
        itemId: libraryItemId || undefined,
        episodeId: session.episodeId || undefined,
      });

      // If the now-playing cover is a REMOTE url (streaming, or a downloaded
      // book whose cover image wasn't among the downloaded parts), cache it to a
      // local file so Android Auto's compact player (home card / mini bar) —
      // which only reads inline artwork bytes — gets a bitmap. This populates
      // carArtworkLocal WITHOUT re-pointing coverUrl, so the full card's
      // artworkUri stays the (working) http url. Fire-and-forget; leaves the
      // remote url in place on failure. Downloaded local covers already inline.
      const coverForCache = artworkUrl || session.coverUrl || "";
      if (libraryItemId && !carArtworkLocal && coverForCache.startsWith("http")) {
        cacheNowPlayingCoverLocally(libraryItemId, coverForCache, gen);
      }

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
    // An errored player (mid-stream network drop) sits IDLE and ignores
    // play() — re-prepare it BEFORE the auto-rewind below: seeks reject on a
    // dead player, and a throwing rewind used to abort the entire resume
    // (skipping retry AND play). Manual resume supersedes any pending
    // automatic retry.
    if (!isCasting) {
      if (!get().isInitialized) {
        await get().initializePlayer();
      }
      try {
        const ps: any = await TrackPlayer.getPlaybackState().catch(() => null);
        if (ps && (ps.state === State.Error || ps.state === State.None)) {
          clearErrorRecovery();
          await TrackPlayer.retry();
        }
      } catch {}
    }
    // Sleep-timer "rewind on wake": when the sleep timer paused playback, the
    // next resume rewinds a dedicated amount so you don't lose your place after
    // dozing off. When the toggle is OFF we fall through to today's generic
    // auto-rewind (below) unchanged.
    if (_sleepRewindPending) {
      _sleepRewindPending = false;
      if (getSleepRewindOnWake()) {
        _lastPausedAt = null; // dedicated rewind supersedes the generic one
        try {
          const secs = getSleepRewindSeconds();
          if (secs > 0) {
            const pos = await getLiveAbsolutePosition(get);
            await get().seek(Math.max(0, pos - secs));
          }
        } catch (e) {
          console.warn("[PlaybackStore] sleep rewind-on-wake skipped", e);
        }
      }
    }
    // Auto rewind: on resume, nudge back a little (scaled by how long paused),
    // unless disabled in Settings. Never let a failing seek strand
    // _lastPausedAt (a stale stamp turned into a bogus 30s rewind LATER) or
    // abort the play itself.
    if (_lastPausedAt != null) {
      try {
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
      } catch (e) {
        console.warn("[PlaybackStore] auto-rewind skipped", e);
      } finally {
        _lastPausedAt = null;
      }
    }
    // Re-anchor the sleep timer's wall-clock so a paused-in-background gap
    // (frozen throttled ticks) isn't charged against the countdown on resume.
    if (get().sleepTimer) _sleepLastTickAt = Date.now();
    if (isCasting && castClient) {
      try { await castClient.play(); } catch (e) { console.warn("[Cast] play", e); }
      // closePlayback may have landed during the awaits above — flipping
      // isPlaying:true on a torn-down (null) session would strand the flag true
      // with nothing to ever clear it.
      if (!get().currentSession) return;
      set({ isPlaying: true });
      return;
    }
    await TrackPlayer.play();
    if (!get().currentSession) return;
    set({ isPlaying: true });
  },

  pause: async () => {
    if (!get().currentSession) return;
    _lastPausedAt = Date.now();
    // Reset the listening-time anchor so the FIRST sample after resume doesn't
    // charge the whole paused gap as listened. Without this, _lastTickAt still
    // held the pre-pause timestamp, and the next playing tick accrued up to
    // MAX_TICK_DELTA_S (~2s) of not-actually-listened time per resume. It
    // re-seeds on the next playing tick (persistProgressSample stamps it).
    _lastTickAt = null;
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
    // A deliberate seek re-arms an end-of-chapter sleep timer to the
    // DESTINATION chapter — jumping forward past the armed chapter's end
    // used to read as a "boundary crossing" and pause instantly mid-chapter.
    const eocTimer = get().sleepTimer;
    if (eocTimer?.endOfChapter && chapters?.length) {
      const li = chapters.findIndex((c: any) => value >= (c.start || 0) && value < (c.end || 0));
      if (li >= 0 && li !== eocTimer.chapterIdx) {
        set({
          sleepTimer: {
            ...eocTimer,
            chapterIdx: li,
            remaining: Math.max(0, Math.round((chapters[li].end || 0) - value)),
          },
        });
      }
    }
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

  // The notification / Android Auto seekbar reports its position relative to the
  // ACTIVE queue item, not the whole book. Chapter queues clip each chapter into
  // its own item and multi-file books put each file in its own item, so the raw
  // value is track-relative in both. Map it to an absolute book position — the
  // chapter branch was already handled in the service; the multi-file case used
  // to pass the file-relative value straight to seek() as if absolute, so
  // dragging the seekbar while in file 2+ resolved back into file 1.
  remoteSeek: async (trackPosition) => {
    const pos = Number.isFinite(trackPosition) ? trackPosition : 0;
    const { isCasting, chapterQueue, chapters, currentChapterIndex } = get();
    if (chapterQueue && chapters?.length) {
      // While casting the local active index is the stale handoff item —
      // currentChapterIndex tracks the RECEIVER's chapter.
      const active = isCasting
        ? currentChapterIndex
        : (await TrackPlayer.getActiveTrackIndex().catch(() => null)) ?? currentChapterIndex;
      await get().seek((chapters[active]?.start || 0) + pos);
      return;
    }
    if (_trackOffsets.length > 1) {
      // Applies while casting too: the app's media notification (the single
      // control surface during a cast) reports its seekbar relative to the
      // PAUSED LOCAL item — the local active index is exactly the offset the
      // reported position is relative to. seek() then routes the mapped
      // absolute position to the receiver via the cast branch.
      const active = (await TrackPlayer.getActiveTrackIndex().catch(() => null)) ?? 0;
      await get().seek((_trackOffsets[active] || 0) + pos);
      return;
    }
    await get().seek(pos);
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
      // Chapter jumps re-arm an end-of-chapter timer too (see seek()).
      const t = get().sleepTimer;
      if (t?.endOfChapter && t.chapterIdx !== index) {
        set({
          sleepTimer: {
            ...t,
            chapterIdx: index,
            remaining: Math.max(0, Math.round((ch.end || 0) - (ch.start || 0))),
          },
        });
      }
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
      // Mirror the cast branch's guard: setRate can reject on a not-yet-ready
      // player, and an unobserved rejection here became an unhandled promise
      // rejection — the rest (persist + store update) should still run.
      try { await TrackPlayer.setRate(speed); } catch (e) { console.warn("[PlaybackStore] setRate", e); }
    }

    // Persist globally so the next book (and Android Auto resume) restores it.
    storageHelper.setPlaybackRate(speed);

    const currentSession = get().currentSession;
    if (currentSession) {
      // Per-book memory: remember the rate the user chose for THIS book so it
      // resumes at that speed next time (when the feature is enabled).
      if (getRememberSpeedPerBook()) {
        setPerBookRate(currentSession.libraryItemId || currentSession.libraryItem?.id, speed);
      }
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

    // Shake-to-extend: arm the accelerometer listener while the timer runs
    // (no-op unless expo-sensors is installed — see armShakeListener).
    armShakeListener();

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

      // PAUSED: the position is frozen (end-of-chapter remaining can't
      // change) and the fixed countdown deliberately holds — skip the native
      // position read and per-tick setVolume entirely, mirroring the progress
      // interval's paused-skip. Keep the wall-clock anchor fresh so the
      // paused gap is never charged on resume.
      if (!get().isPlaying && !get().isCasting) {
        _sleepLastTickAt = Date.now();
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
        // cancelSleepTimer may have landed DURING the await above — it clears
        // the interval and nulls sleepTimer. Without this re-check the parked
        // callback would fall through and `set({ sleepTimer: {...} })` below,
        // rewriting a non-null timer with the interval already gone → a stuck
        // timer that never counts down.
        if (!get().sleepTimer) return;
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
        disarmShakeListener();
        // Arm the "rewind on wake" nudge for the next resume, and record the
        // pause so play()'s generic auto-rewind anchor exists too.
        _sleepRewindPending = true;
        // pause() can reject on a dead player; this async interval callback's
        // promise is unobserved, so a bare call became an unhandled rejection.
        get().pause().catch(() => {});
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
    disarmShakeListener();
    // Explicit cancel means the user is awake — don't rewind on the next resume.
    _sleepRewindPending = false;
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

    // Capture the session, then DISARM every persistence driver immediately:
    // the 1s interval, native progress samples, and the cast mirror all gate
    // on currentSession/isPlaying, and a straggler firing during the awaits
    // below used to RE-SAVE the crash-restore blob after we removed it —
    // resurrecting the dismissed session if the process died soon after.
    // (chapters/_trackOffsets stay until the final set() so the live-position
    // read below still maps correctly.)
    const session = get().currentSession;
    set({ currentSession: null, isPlaying: false });

    // Final flush + close the ABS session before tearing down the player.
    // LIVE position (read BEFORE reset clears the player): dismissing playback
    // from the notification after backgrounded listening is exactly when the
    // snapshot is minutes stale — closing the session with it regressed the
    // server-side position.
    const closeAt = await getLiveAbsolutePosition(get);
    // Remove the crash-restore save BEFORE the network close: a process kill
    // during the (potentially slow) POST used to resurrect the dismissed
    // session on the next launch.
    storageHelper.removeLastPlaybackSession();
    if (session?.id) {
      const toSync = _timeListenedAccum;
      _timeListenedAccum = 0;
      // Fire-and-forget: closeSession self-queues on failure, and dismissing
      // playback must never block on a slow network.
      closeSession({
        sessionId: session.id,
        currentTime: closeAt,
        timeListened: toSync,
        duration: get().duration,
        libraryItemId: session.libraryItemId,
        episodeId: session.episodeId || undefined,
      }).catch(() => {});
      // LOCK: playback for this item was just dismissed — reconcile the ebook
      // up to this final listening position when linked (furthest-wins,
      // fraction-only). No-op unless locked; skipped for podcast episodes.
      try {
        const closeDur = get().duration;
        if (!session.episodeId && session.libraryItemId) {
          reconcileLinkedProgress(session.libraryItemId, {
            audioFraction: closeDur > 0 ? closeAt / closeDur : 0,
            duration: closeDur,
          });
        }
      } catch {}
    }

    // If casting, stop the receiver's playback too — otherwise dismissing
    // playback on the phone leaves the TV playing with no session syncing.
    const { isCasting, castClient } = get();
    if (isCasting && castClient) {
      try { await castClient.stop(); } catch {}
    }

    await TrackPlayer.reset();

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
    _lastMirrorSig = null;
    _finishedSessionId = null;
    _lastPausedAt = null;
    _preparedToken = null;
    _sleepRewindPending = false;
    disarmShakeListener();

    set({
      currentSession: null,
      isPlaying: false,
      isBuffering: false,
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
