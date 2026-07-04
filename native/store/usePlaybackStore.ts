import { create } from "zustand";
import TrackPlayer, { 
  Capability, 
  State, 
  useTrackPlayerEvents, 
  Event, 
  AppKilledPlaybackBehavior 
} from "react-native-track-player";
import { storageHelper } from "../utils/storage";
import { api } from "../utils/api";
import { useUserStore } from "./useUserStore";
import { syncProgress, closeSession } from "../utils/progressSync";
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
      notificationIcon: "notification_icon",
    },
    forwardJumpInterval: s.jumpForwardTime ?? 10,
    backwardJumpInterval: s.jumpBackwardTime ?? 10,
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
// Dedupe rapid duplicate startPlayback calls (Android Auto double-dispatch).
let _lastStartKey = "";
let _lastStartAt = 0;
async function applyNowPlayingChapter(session: any, chapters: any[], chapterIndex: number) {
  if (!session) return;
  if (chapterIndex === _lastMetaChapter) return;
  _lastMetaChapter = chapterIndex;
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
  } catch (e) {
    // Track not ready yet — the progress loop will retry on the next tick.
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

  // Sleep timer
  sleepTimer: {
    endOfChapter: boolean;
    remaining: number; // seconds left, or seconds until end of chapter
  } | null;

  // Actions
  initializePlayer: () => Promise<void>;
  startPlayback: (itemId: string, episodeId?: string) => Promise<boolean>;
  preparePlaybackSession: (session: any, playWhenReady?: boolean) => Promise<void>;
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
    set({ castClient: client || null, isCasting: !!client });
  },

  loadLastSession: async () => {
    const serverConfig = storageHelper.getServerConfig();
    if (!serverConfig || !serverConfig.token || !serverConfig.address) {
      console.log("[PlaybackStore] No active authenticated session, skipping session load.");
      return;
    }
    const session = storageHelper.getLastPlaybackSession();
    if (session) {
      console.log("[PlaybackStore] Found saved session, restoring...");
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
      await TrackPlayer.setupPlayer({});
      await TrackPlayer.updateOptions(buildPlayerOptions());
      
      set({ isInitialized: true });
      console.log("[PlaybackStore] TrackPlayer initialized successfully.");

      // Sync player state to Zustand reactively
      setInterval(async () => {
        if (!get().isInitialized) return;
        try {
          const state = await TrackPlayer.getActiveTrack();
          if (state) {
            const progress = await TrackPlayer.getProgress();
            const playerState = await TrackPlayer.getPlaybackState();
            const isPlayerPlaying = playerState.state === State.Playing;
            
            const chapters = get().chapters;
            const chapterQueue = get().chapterQueue;

            // Translate the player position to an ABSOLUTE book position. With a
            // chapter queue each item is clipped, so the raw position is
            // chapter-relative and the active index IS the chapter.
            let absolutePosition = progress.position;
            let bookDuration = progress.duration;
            let chapterIndex = -1;
            if (chapterQueue && chapters.length) {
              const activeIndex = await TrackPlayer.getActiveTrackIndex();
              if (activeIndex != null && chapters[activeIndex]) {
                chapterIndex = activeIndex;
                absolutePosition = (chapters[activeIndex].start || 0) + progress.position;
              }
              bookDuration = get().duration || bookDuration; // keep whole-book duration
            } else {
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

            // Accumulate real elapsed listening time (only while actually
            // playing), capped per tick so backgrounding/suspension doesn't
            // inflate it into a huge jump once ticks resume.
            const now = Date.now();
            if (isPlayerPlaying && _lastTickAt != null) {
              const deltaS = Math.min(MAX_TICK_DELTA_S, Math.max(0, (now - _lastTickAt) / 1000));
              _timeListenedAccum += deltaS;
            }
            _lastTickAt = now;

            // Auto-save progress to local storage, throttled to ~5s to reduce
            // flash wear (this loop ticks every 1s).
            const currentSession = get().currentSession;
            if (currentSession) {
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
              // to false on the next tick.
              const alreadyFinished = _finishedSessionId === currentSession.id;
              const progressObj = {
                libraryItemId: currentSession.libraryItemId,
                currentTime: absolutePosition,
                duration: bookDuration,
                progress: bookDuration > 0 ? Math.min(1, absolutePosition / bookDuration) : 0,
                isFinished: alreadyFinished,
                updatedAt: now,
              };
              useUserStore.setState({
                mediaProgress: {
                  ...useUserStore.getState().mediaProgress,
                  [currentSession.libraryItemId]: progressObj,
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
                }).catch(() => {});
              }

              // Auto mark-finished: within 5s of the end of the book, once per
              // session. Fires the isFinished PATCH and updates local state.
              const libraryItemId = currentSession.libraryItemId;
              if (
                bookDuration > 0 &&
                absolutePosition >= bookDuration - 5 &&
                libraryItemId &&
                _finishedSessionId !== currentSession.id
              ) {
                _finishedSessionId = currentSession.id;
                api
                  .patch(`/api/me/progress/${libraryItemId}`, {
                    currentTime: bookDuration,
                    duration: bookDuration,
                    progress: 1,
                    isFinished: true,
                  })
                  .catch(() => {});
                useUserStore.setState({
                  mediaProgress: {
                    ...useUserStore.getState().mediaProgress,
                    [libraryItemId]: {
                      ...useUserStore.getState().mediaProgress[libraryItemId],
                      libraryItemId,
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
        } catch (e) {
          // Player might not be active/loaded
        }
      }, 1000);

    } catch (error) {
      console.log("[PlaybackStore] Setup already done or failed:", error);
      set({ isInitialized: true }); // Assume initialized if it threw already-initialized error
    }
    })();
    try {
      await _initPromise;
    } finally {
      _initPromise = null;
    }
  },

  startPlayback: async (itemId, episodeId) => {
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
        ? `/api/items/${itemId}/play/${episodeId}`
        : `/api/items/${itemId}/play`;
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
        return false;
      }
      await get().preparePlaybackSession(session, true);
      return true;
    } catch (err) {
      console.error("[PlaybackStore] startPlayback failed:", err);
      // Offline fallback: if this book is downloaded (with playback meta), build
      // a local session from the on-device files so it plays without the server.
      try {
        const { useDownloadStore } = require("./useDownloadStore");
        const dl = useDownloadStore.getState().completedDownloads[itemId];
        if (dl?.meta && dl.localFolderPath && !episodeId) {
          const lastLocal = useUserStore.getState().getMediaProgress(itemId);
          const localSession = {
            id: `local_${itemId}`,
            libraryItemId: itemId,
            displayTitle: dl.title,
            displayAuthor: dl.author,
            duration: dl.meta.duration || 0,
            currentTime: lastLocal?.currentTime || 0,
            chapters: dl.meta.chapters || [],
            coverUrl: dl.coverUrl,
            audioTracks: dl.meta.tracks.map((t: any) => ({
              index: t.index,
              contentUrl: `${dl.localFolderPath}${t.filename}`,
              duration: t.duration,
              startOffset: t.startOffset,
            })),
          };
          console.log("[PlaybackStore] Falling back to offline local session for", itemId);
          await get().preparePlaybackSession(localSession, true);
          return true;
        }
      } catch (e) {
        console.error("[PlaybackStore] offline fallback failed:", e);
      }
      return false;
    }
  },

  preparePlaybackSession: async (session, playWhenReady = false) => {
    await get().initializePlayer();

    try {
      console.log("[PlaybackStore] Preparing playback session:", session.id);
      
      // Stop and reset current queue
      await TrackPlayer.reset();
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
        const full = url.startsWith("http") ? url : `${serverAddress}${url}`;
        return withToken(full);
      };

      const libraryItemId = session.libraryItemId || session.libraryItem?.id;
      const artworkUrl =
        session.coverUrl ||
        (libraryItemId && serverAddress
          ? `${serverAddress}/api/items/${libraryItemId}/cover?token=${token}`
          : undefined);

      // Prefer the locally-downloaded file when available so downloaded books
      // play the local copy (faster / offline) instead of streaming.
      const { useDownloadStore } = require("./useDownloadStore");
      const download = libraryItemId
        ? useDownloadStore.getState().completedDownloads[libraryItemId]
        : null;
      const localFolder = download?.localFolderPath;
      const localForTrack = (track: any, idx: number): string | null => {
        if (!download) return null;
        const key = `track_${track.index ?? idx}`;
        const part = download.parts.find((p: any) => p.id === key);
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
      const chapters = session.chapters || [];

      // Chapter queue: when a single-file book has real chapters, build one
      // clipped RNTP item per chapter so Android Auto shows the chapters as the
      // queue and each chapter is its own now-playing title. Multi-file books
      // fall back to a file-per-item queue (a chapter can straddle files).
      const chapterQueue = chapters.length > 1 && audioTracks.length === 1;

      let tracksToLoad: any[];
      if (chapterQueue) {
        const track = audioTracks[0];
        const fileUrl = localForTrack(track, track.index ?? 0) || absoluteUrl(track.contentUrl);
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
        tracksToLoad = audioTracks.map((track: any, idx: number) => {
          const t: any = {
            id: `${session.id}_${track.index}`,
            url: localForTrack(track, idx) || absoluteUrl(track.contentUrl),
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

      await TrackPlayer.add(tracksToLoad);

      // Restore the last speed the user set (persisted globally), matching the
      // original app's saved-playback-rate behaviour.
      const playbackSpeed = session.playbackRate || storageHelper.getPlaybackRate();
      await TrackPlayer.setRate(playbackSpeed);

      // Seek to the saved absolute position, mapping into the right chapter clip.
      const startAbs = session.currentTime || 0;
      if (chapterQueue) {
        let idx = chapters.findIndex((c: any) => startAbs >= (c.start || 0) && startAbs < (c.end || 0));
        if (idx < 0) idx = 0;
        if (idx > 0) await TrackPlayer.skip(idx);
        const within = startAbs - (chapters[idx]?.start || 0);
        if (within > 0) await TrackPlayer.seekTo(within);
      } else if (startAbs > 0) {
        await TrackPlayer.seekTo(startAbs);
      }

      set({
        // Persist the resolved cover URL on the session so the Player and
        // MiniPlayer can render artwork (the raw session has no coverUrl).
        currentSession: { ...session, coverUrl: artworkUrl || session.coverUrl || "" },
        playbackSpeed,
        chapters,
        chapterQueue,
        duration: session.duration || 0,
        position: session.currentTime || 0,
      });

      // Mirror the current book to the home-screen resume widget.
      writeWidgetState({ title: bookTitle, author: bookAuthor });

      if (playWhenReady) {
        await TrackPlayer.play();
        set({ isPlaying: true, isPlayerExpanded: true });
      }
    } catch (err) {
      console.error("[PlaybackStore] Failed to prepare playback session:", err);
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
    const { isCasting, castClient } = get();
    // Auto rewind: on resume, nudge back a little (scaled by how long paused),
    // unless disabled in Settings.
    if (_lastPausedAt != null) {
      const disabled = useUserStore.getState().settings?.disableAutoRewind;
      if (!disabled) {
        const rewind = autoRewindSeconds(Date.now() - _lastPausedAt);
        if (rewind > 0) {
          const target = Math.max(0, get().position - rewind);
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
    await TrackPlayer.play();
    set({ isPlaying: true });
  },

  pause: async () => {
    _lastPausedAt = Date.now();
    const { isCasting, castClient } = get();
    if (isCasting && castClient) {
      try { await castClient.pause(); } catch (e) { console.warn("[Cast] pause", e); }
      set({ isPlaying: false });
      return;
    }
    if (!get().isInitialized) return;
    await TrackPlayer.pause();
    set({ isPlaying: false });

    // Flush current progress + accumulated listening time immediately on pause.
    const session = get().currentSession;
    if (session?.id && _timeListenedAccum > 0) {
      const toSync = _timeListenedAccum;
      _timeListenedAccum = 0;
      _lastSyncAt = Date.now();
      syncProgress({
        sessionId: session.id,
        currentTime: get().position,
        timeListened: toSync,
        duration: get().duration,
      }).catch(() => {});
    }
  },

  // `value` is always an ABSOLUTE book position (seconds).
  seek: async (value) => {
    const { isCasting, castClient, chapterQueue, chapters } = get();
    if (isCasting && castClient) {
      try { await castClient.seek({ position: value }); } catch (e) { console.warn("[Cast] seek", e); }
      set({ position: value });
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
      return;
    }
    await TrackPlayer.seekTo(value);
    set({ position: value });
  },

  // seekForward/Backward funnel through seek() so they inherit cast routing.
  seekForward: async (value) => {
    const target = Math.min(get().position + value, get().duration || Infinity);
    await get().seek(target);
  },

  seekBackward: async (value) => {
    const target = Math.max(0, get().position - value);
    await get().seek(target);
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
    const nextIndex = currentChapterIndex + 1;
    if (chapters?.[nextIndex]) await get().seekToChapter(nextIndex);
  },

  previousChapter: async () => {
    const { chapters, currentChapterIndex, position, chapterQueue, isCasting } = get();
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
    const current = chapters?.[currentChapterIndex];
    const restart = current && position - (current.start || 0) > 3;
    if (restart) {
      await get().seekToChapter(currentChapterIndex);
      return;
    }
    const prevIndex = currentChapterIndex - 1;
    if (chapters?.[prevIndex]) await get().seekToChapter(prevIndex);
  },

  setPlaybackSpeed: async (speed) => {
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
    if (sleepTimerInterval) {
      clearInterval(sleepTimerInterval);
      sleepTimerInterval = null;
    }
    // Make sure we start at full volume (a previous fade may have lowered it).
    if (!get().isCasting) TrackPlayer.setVolume(1).catch(() => {});
    set({ sleepTimer: { endOfChapter, remaining: Math.max(0, Math.round(seconds)) } });

    sleepTimerInterval = setInterval(() => {
      const timer = get().sleepTimer;
      if (!timer) {
        if (sleepTimerInterval) {
          clearInterval(sleepTimerInterval);
          sleepTimerInterval = null;
        }
        return;
      }

      let remaining: number;
      if (timer.endOfChapter) {
        // Recompute against live position so it follows seeks.
        const { chapters, currentChapterIndex, position } = get();
        const ch = chapters?.[currentChapterIndex];
        remaining = ch ? Math.max(0, Math.round((ch.end || 0) - position)) : 0;
      } else {
        remaining = timer.remaining - 1;
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
        // Restore full volume so the next resume isn't silent.
        if (!get().isCasting) TrackPlayer.setVolume(1).catch(() => {});
        return;
      }
      set({ sleepTimer: { endOfChapter: timer.endOfChapter, remaining } });
    }, 1000);
  },

  cancelSleepTimer: () => {
    if (sleepTimerInterval) {
      clearInterval(sleepTimerInterval);
      sleepTimerInterval = null;
    }
    // Undo any in-progress fade.
    if (!get().isCasting) TrackPlayer.setVolume(1).catch(() => {});
    set({ sleepTimer: null });
  },

  closePlayback: async () => {
    if (!get().isInitialized) return;

    // Final flush + close the ABS session before tearing down the player.
    const session = get().currentSession;
    if (session?.id) {
      const toSync = _timeListenedAccum;
      _timeListenedAccum = 0;
      try {
        await closeSession({
          sessionId: session.id,
          currentTime: get().position,
          timeListened: toSync,
          duration: get().duration,
        });
      } catch {
        // closeSession already queues on failure; never block teardown.
      }
    }

    await TrackPlayer.reset();
    storageHelper.removeLastPlaybackSession();

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
