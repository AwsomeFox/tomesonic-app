import { create } from "zustand";
import * as FileSystem from "expo-file-system/legacy";
import { db } from "../utils/db";

export interface DownloadPart {
  id: string;
  filename: string;
  url: string;
  bytesDownloaded: number;
  fileSize: number;
  completed: boolean;
  error?: string;
  localFilePath?: string; // absolute on-device path once downloaded
}

export interface DownloadItem {
  id: string; // libraryItemId (or episodeId)
  libraryItemId: string;
  title: string;
  author: string;
  coverUrl: string;
  progress: number; // 0 to 1
  status: "pending" | "downloading" | "completed" | "failed" | "cancelled";
  parts: DownloadPart[];
  localFolderPath?: string;
  // Why the download failed — shown in the UI so "Failed" is actionable
  // (e.g. "Not enough storage space" vs a transient network error).
  error?: string;
  // Playback metadata captured at download time so the book can be played
  // fully offline (no /play session): whole-book duration, chapters, and
  // per-track timing/filenames.
  meta?: {
    duration: number;
    chapters: any[];
    tracks: { index: number; filename: string; duration: number; startOffset: number }[];
  };
}

// Progress callbacks can fire many times per second per part; persisting the
// whole item on each tick means a JSON serialize + MMKV write each time.
// Throttle DB writes per item — part/status transitions still save immediately.
const DB_SAVE_INTERVAL_MS = 1000;
const _lastDbSaveAt: Record<string, number> = {};

/**
 * Best folder guess for an item's on-device files. Prefers the recorded
 * localFolderPath (set at download start); falls back to deriving it from any
 * completed part's file path (older DB rows predating localFolderPath-at-start).
 */
function folderForItem(item?: DownloadItem | null): string | null {
  if (!item) return null;
  if (item.localFolderPath) return item.localFolderPath;
  const withPath = (item.parts || []).find(p => p.localFilePath);
  if (withPath?.localFilePath) {
    const idx = withPath.localFilePath.lastIndexOf("/");
    if (idx > 0) return withPath.localFilePath.slice(0, idx + 1);
  }
  return null;
}

interface DownloadState {
  activeDownloads: Record<string, DownloadItem>;
  completedDownloads: Record<string, DownloadItem>;
  
  // Actions
  loadDownloadsFromDb: () => void;
  startDownload: (item: Omit<DownloadItem, "progress" | "status" | "parts">, parts: Omit<DownloadPart, "bytesDownloaded" | "completed">[]) => void;
  // Backfills localFolderPath on an active item (used by resume for old DB rows).
  setDownloadFolder: (id: string, localFolderPath: string) => void;
  updateDownloadProgress: (id: string, partId: string, bytesDownloaded: number, fileSize: number) => void;
  completeDownloadPart: (id: string, partId: string, localFilePath: string) => void;
  completeDownload: (id: string, localFolderPath: string) => void;
  failDownload: (id: string, errorMsg: string) => void;
  cancelDownload: (id: string) => void;
  // Delete a download's files (completed or partial) + remove it from local media.
  removeDownload: (id: string) => Promise<void>;
  // Re-drive a failed download from its saved parts (resumes, doesn't restart from scratch).
  retryDownload: (id: string) => Promise<void>;
  removeAllDownloads: () => Promise<void>;
  // True once loadDownloadsFromDb has hydrated — offline UI gates its
  // "No downloaded books" empty state on this to avoid a scary flash before
  // the DB read lands on cold start.
  downloadsLoaded: boolean;
}

export const useDownloadStore = create<DownloadState>((set, get) => ({
  activeDownloads: {},
  completedDownloads: {},
  downloadsLoaded: false,

  loadDownloadsFromDb: () => {
    const list = db.getAllDownloads();
    const active: Record<string, DownloadItem> = {};
    const completed: Record<string, DownloadItem> = {};
    const liveActive = get().activeDownloads;

    list.forEach(item => {
      if (item.status === "completed") {
        completed[item.id] = item;
      } else if (item.status === "downloading" || item.status === "pending") {
        const live = liveActive[item.id];
        if (live && (live.status === "downloading" || live.status === "pending")) {
          // A download loop is driving this item RIGHT NOW (this reload came
          // from a screen mount, not app start) — keep the fresher in-memory
          // state; the DB copy is throttled and must not flag it as failed.
          active[item.id] = live;
          return;
        }
        // App was killed mid-download. Mark as failed so the UI surfaces it,
        // but keep parts/progress intact so retryDownload can resume instead
        // of re-downloading completed parts from scratch.
        active[item.id] = { ...item, status: "failed", error: "Interrupted — tap retry to resume" };
        db.saveDownloadItem(active[item.id]);
      } else if (
        item.status !== "pending" &&
        item.status !== "downloading" &&
        item.status !== "failed" &&
        item.status !== "cancelled"
      ) {
        // Unknown status (corrupt row / future app version): surface it as a
        // retryable failure instead of an inert ghost row with no affordance.
        active[item.id] = {
          ...item,
          parts: item.parts || [],
          status: "failed",
          error: "Interrupted — tap retry to resume",
        };
        db.saveDownloadItem(active[item.id]);
      } else if (item.status === "cancelled") {
        // Legacy rows: cancels used to persist a "cancelled" record with the
        // partial files left on disk and no retry path — clean both up now.
        const folder = folderForItem(item);
        if (folder) {
          FileSystem.deleteAsync(folder, { idempotent: true }).catch(() => {});
        }
        db.removeDownloadItem(item.id);
      } else {
        active[item.id] = item;
      }
    });

    set({ activeDownloads: active, completedDownloads: completed, downloadsLoaded: true });

    // Best-effort, after hydration: reclaim download folders on disk that no
    // record owns (partial files orphaned by old cancel/fail paths).
    try {
      const { downloader } = require("../utils/downloader");
      downloader.sweepOrphanFolders();
    } catch {}
  },

  startDownload: (item, parts) => {
    const newItem: DownloadItem = {
      ...item,
      progress: 0,
      status: "pending",
      error: undefined, // a fresh start clears any stale failure reason
      parts: parts.map(p => ({ ...p, bytesDownloaded: 0, completed: false })),
    };

    delete _lastDbSaveAt[item.id];
    db.saveDownloadItem(newItem);
    set(state => {
      // Invariant: an id is never in BOTH maps. Every current caller guards
      // against re-downloading a completed item, but the store must not rest
      // on caller discipline — a re-start supersedes the completed entry.
      const nextCompleted = { ...state.completedDownloads };
      delete nextCompleted[item.id];
      return {
        completedDownloads: nextCompleted,
        activeDownloads: {
          ...state.activeDownloads,
          [item.id]: newItem,
        },
      };
    });
  },

  setDownloadFolder: (id, localFolderPath) => {
    const item = get().activeDownloads[id];
    if (!item || item.localFolderPath === localFolderPath) return;
    const updatedItem = { ...item, localFolderPath };
    db.saveDownloadItem(updatedItem);
    set(state => ({
      activeDownloads: { ...state.activeDownloads, [id]: updatedItem },
    }));
  },

  updateDownloadProgress: (id, partId, bytesDownloaded, fileSize) => {
    const active = get().activeDownloads;
    const item = active[id];
    if (!item) return;

    // Native progress callbacks are numbers in practice, but a NaN here
    // poisons the progress math and gets persisted — guard the inputs.
    if (!Number.isFinite(bytesDownloaded)) return;
    const updatedParts = (item.parts || []).map(p =>
      p.id === partId
        ? {
            ...p,
            bytesDownloaded: Math.max(0, bytesDownloaded),
            // totalBytesExpectedToWrite from the callback is authoritative when
            // known, but is -1/0 when the server omits Content-Length — keep
            // the previous (server-metadata) estimate in that case.
            fileSize: fileSize > 0 ? fileSize : p.fileSize,
          }
        : p
    );

    // Calculate overall progress across all parts. Per part, the expected size
    // is never counted below what's already been written (covers unknown-size
    // parts like the cover image) so the ratio can't exceed 1 or run backwards.
    const totalBytesExpected = updatedParts.reduce(
      (acc, p) => acc + Math.max(p.fileSize || 0, p.bytesDownloaded || 0), 0
    );
    const totalBytesDownloaded = updatedParts.reduce((acc, p) => acc + (p.bytesDownloaded || 0), 0);
    const progress = totalBytesExpected > 0 ? totalBytesDownloaded / totalBytesExpected : 0;

    const updatedItem = {
      ...item,
      status: "downloading" as const,
      parts: updatedParts,
      progress: Math.max(0, Math.min(0.99, progress)), // Keep at 0.99 until fully wrapped up
    };

    // Throttle persistence — progress ticks arrive many times per second and
    // each save is a full-item MMKV write. In-memory state is always current;
    // part completion / status changes save unconditionally elsewhere.
    const now = Date.now();
    if (now - (_lastDbSaveAt[id] || 0) >= DB_SAVE_INTERVAL_MS) {
      _lastDbSaveAt[id] = now;
      db.saveDownloadItem(updatedItem);
    }
    set(state => ({
      activeDownloads: {
        ...state.activeDownloads,
        [id]: updatedItem,
      },
    }));
  },

  completeDownloadPart: (id, partId, localFilePath) => {
    const active = get().activeDownloads;
    const item = active[id];
    if (!item) return;

    const updatedParts = (item.parts || []).map(p =>
      p.id === partId
        ? {
            ...p,
            completed: true,
            // fileSize is 0 for parts with unknown size (cover) — snapping
            // bytesDownloaded to it would make the progress bar jump backwards.
            bytesDownloaded: p.fileSize > 0 ? p.fileSize : p.bytesDownloaded,
            localFilePath,
          }
        : p
    );

    const updatedItem = {
      ...item,
      parts: updatedParts,
    };

    db.saveDownloadItem(updatedItem);
    set(state => ({
      activeDownloads: {
        ...state.activeDownloads,
        [id]: updatedItem,
      },
    }));
  },

  completeDownload: (id, localFolderPath) => {
    const active = get().activeDownloads;
    const item = active[id];
    if (!item) return;

    const completedItem = {
      ...item,
      status: "completed" as const,
      progress: 1.0,
      error: undefined, // clear any failure message from an earlier attempt
      localFolderPath,
    };

    delete _lastDbSaveAt[id];
    db.saveDownloadItem(completedItem);

    // Save download mapping to offline database
    const offlineItem = {
      id: completedItem.id,
      libraryItemId: completedItem.libraryItemId,
      title: completedItem.title,
      author: completedItem.author,
      localFolderPath,
      isDownloaded: true,
      downloadedAt: Date.now(),
    };
    db.saveLocalLibraryItem(offlineItem);

    set(state => {
      const nextActive = { ...state.activeDownloads };
      delete nextActive[id];
      return {
        activeDownloads: nextActive,
        completedDownloads: {
          ...state.completedDownloads,
          [id]: completedItem,
        },
      };
    });
  },

  failDownload: (id, errorMsg) => {
    const active = get().activeDownloads;
    const item = active[id];
    if (!item) return;

    const failedItem = {
      ...item,
      status: "failed" as const,
      error: errorMsg || "Unknown error", // surface WHY in the UI, not just "Failed"
    };

    db.saveDownloadItem(failedItem);
    set(state => ({
      activeDownloads: {
        ...state.activeDownloads,
        [id]: failedItem,
      },
    }));
  },

  cancelDownload: (id) => {
    const active = get().activeDownloads;
    const item = active[id];
    if (!item) return;

    // Actually stop the in-flight native downloads + notification. All UI
    // cancel paths call this store action, so this is the single choke point
    // (lazy require avoids a circular import with the downloader).
    // Partial files are deleted AFTER the abort settles — deleting while a
    // part is still writing would race the native writer.
    const folder = folderForItem(item);
    try {
      const { downloader } = require("../utils/downloader");
      Promise.resolve(downloader.abortBookParts(id))
        .catch((e: any) => console.warn("[Downloads] abortBookParts failed", e))
        .then(async () => {
          if (!folder) return;
          // A re-download may have started while the abort settled — the
          // folder path is deterministic, so deleting now would destroy the
          // NEW run's files mid-write.
          if (useDownloadStore.getState().activeDownloads[id]) return;
          try { await FileSystem.deleteAsync(folder, { idempotent: true }); } catch (e) {
            console.warn("[Downloads] Failed to delete cancelled folder", folder, e);
          }
        });
    } catch (e) {
      console.warn("[Downloads] abortBookParts failed", e);
    }

    // A cancel is a discard: remove the DB record entirely. Persisting a
    // "cancelled" row used to leave a ghost entry (reappearing after restart
    // with no retry affordance) whose partial files were orphaned forever.
    db.removeDownloadItem(id);
    delete _lastDbSaveAt[id];
    set(state => {
      const nextActive = { ...state.activeDownloads };
      delete nextActive[id];
      return { activeDownloads: nextActive };
    });
  },

  removeDownload: async (id) => {
    const item = get().completedDownloads[id] || get().activeDownloads[id];

    // If any parts are somehow still in flight, stop them before deleting the
    // folder so nothing keeps writing into it.
    try {
      const { downloader } = require("../utils/downloader");
      await downloader.abortBookParts(id);
    } catch {}

    // Delete the on-device folder (and its files). folderForItem falls back to
    // deriving the path from part files for failed items / older DB rows that
    // never had localFolderPath recorded.
    const folder = folderForItem(item);
    if (folder) {
      try { await FileSystem.deleteAsync(folder, { idempotent: true }); } catch (e) {
        console.warn("[Downloads] Failed to delete folder", folder, e);
      }
    }
    db.removeDownloadItem(id);
    db.removeLocalLibraryItem(id); // drop the offline-library mapping written on completion
    delete _lastDbSaveAt[id];
    set(state => {
      const nextCompleted = { ...state.completedDownloads };
      const nextActive = { ...state.activeDownloads };
      delete nextCompleted[id];
      delete nextActive[id];
      return { completedDownloads: nextCompleted, activeDownloads: nextActive };
    });

    // If this item is the LOADED playback session, its queue points at the
    // file:// URLs just deleted — playback would die at the next uncached
    // open (chapter boundary, resume) with no self-recovery. Swap an actively
    // playing session to streaming at the current position; close a paused
    // one (its position is safe in MMKV + the progress map). Lazy require:
    // the playback store requires this store the same way.
    try {
      const { usePlaybackStore } = require("./usePlaybackStore");
      const st = usePlaybackStore.getState();
      if (st.currentSession?.libraryItemId === id) {
        if (st.isPlaying) {
          const ok = await st
            .startPlayback(id, st.currentSession.episodeId || undefined)
            .catch(() => false);
          if (!ok) await st.closePlayback().catch(() => {});
        } else {
          await st.closePlayback().catch(() => {});
        }
      }
    } catch {}
  },

  // Account-switch / logout hygiene: downloads are keyed by bare
  // libraryItemId with NO server/account scoping, so without this wipe the
  // next account inherited the previous user's downloaded books — visible on
  // the Downloads screen and the offline shelf, fully playable from disk, and
  // mirrored into the Android Auto file. Aborts anything in flight, deletes
  // every file, clears all db rows, and empties the store + AA mirror.
  removeAllDownloads: async () => {
    const ids = Array.from(
      new Set([
        ...Object.keys(get().completedDownloads),
        ...Object.keys(get().activeDownloads),
      ])
    );
    try {
      const { downloader } = require("../utils/downloader");
      for (const id of ids) {
        try {
          await downloader.abortBookParts(id);
        } catch {}
      }
    } catch {}
    for (const id of ids) {
      const item = get().completedDownloads[id] || get().activeDownloads[id];
      const folder = folderForItem(item);
      if (folder) {
        try {
          await FileSystem.deleteAsync(folder, { idempotent: true });
        } catch {}
      }
      try {
        db.removeDownloadItem(id);
        db.removeLocalLibraryItem(id);
      } catch {}
      delete _lastDbSaveAt[id];
    }
    // Clear state BEFORE the sweep — sweepOrphanFolders skips folders owned
    // by in-store ids, so sweeping first would protect exactly the leftovers
    // this is meant to remove (items whose folderForItem came back null).
    set({ completedDownloads: {}, activeDownloads: {} });
    // Sweep anything the id list missed (orphan folders from older installs).
    try {
      const { downloader } = require("../utils/downloader");
      await downloader.sweepOrphanFolders?.();
    } catch {}
  },

  retryDownload: async (id) => {
    const item = get().activeDownloads[id];
    if (!item) return;
    // Already being driven (double-tapped retry) — the downloader also guards
    // this, but skip the redundant state churn here too.
    if (item.status === "pending" || item.status === "downloading") return;

    // Flip back to pending so the UI shows it as queued while the downloader
    // picks up where it left off (completed parts are skipped, see downloader.resumeDownload).
    const pendingItem: DownloadItem = { ...item, status: "pending", error: undefined };
    db.saveDownloadItem(pendingItem);
    set(state => ({
      activeDownloads: {
        ...state.activeDownloads,
        [id]: pendingItem,
      },
    }));

    try {
      const { storageHelper } = require("../utils/storage");
      const { downloader } = require("../utils/downloader");
      const config = storageHelper.getServerConfig();
      if (!config?.address || !config?.token) {
        throw new Error("Missing server config, cannot retry download");
      }
      await downloader.resumeDownload(pendingItem, config.address, config.token);
    } catch (e: any) {
      console.warn("[Downloads] retryDownload failed for", id, e);
      get().failDownload(id, e?.message || "Retry failed");
    }
  },
}));

// Mirror the downloaded books (metadata + local files + resume position) to a
// file the native Android Auto browse service reads: downloaded books get the
// native download badge, and with no network the car can browse AND play them
// from local files.
{
  const { writeAutoDownloads } = require("../utils/autoCreds");
  let _lastKeys = "";
  const sync = (completed: Record<string, any>) => {
    const items = Object.values(completed || {});
    const key = items.map((d: any) => d.id).sort().join(",");
    if (key === _lastKeys) return;
    _lastKeys = key;
    let progressMap: Record<string, any> = {};
    try {
      const { useUserStore } = require("./useUserStore");
      progressMap = useUserStore.getState().mediaProgress || {};
    } catch {}
    const entries = items
      // Audio downloads only — ebook-only downloads can't play in the car.
      .filter((d: any) => d?.meta?.tracks?.length)
      .map((d: any) => ({
        id: d.libraryItemId || d.id,
        title: d.title || "Audiobook",
        author: d.author || undefined,
        folder: d.localFolderPath || undefined,
        coverPath: (d.parts || []).find((p: any) => p.id === "cover")?.localFilePath || undefined,
        currentTime: Number(progressMap[d.libraryItemId || d.id]?.currentTime) || 0,
        duration: Number(d.meta?.duration) || 0,
        tracks: (d.meta?.tracks || []).map((t: any) => ({
          filename: t.filename,
          startOffset: Number(t.startOffset) || 0,
          duration: Number(t.duration) || 0,
        })),
      }));
    writeAutoDownloads(entries);
  };
  sync(useDownloadStore.getState().completedDownloads);
  useDownloadStore.subscribe((state) => sync(state.completedDownloads));
}
