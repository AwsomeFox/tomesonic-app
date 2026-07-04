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
  // Playback metadata captured at download time so the book can be played
  // fully offline (no /play session): whole-book duration, chapters, and
  // per-track timing/filenames.
  meta?: {
    duration: number;
    chapters: any[];
    tracks: { index: number; filename: string; duration: number; startOffset: number }[];
  };
}

interface DownloadState {
  activeDownloads: Record<string, DownloadItem>;
  completedDownloads: Record<string, DownloadItem>;
  
  // Actions
  loadDownloadsFromDb: () => void;
  startDownload: (item: Omit<DownloadItem, "progress" | "status" | "parts">, parts: Omit<DownloadPart, "bytesDownloaded" | "completed">[]) => void;
  updateDownloadProgress: (id: string, partId: string, bytesDownloaded: number, fileSize: number) => void;
  completeDownloadPart: (id: string, partId: string, localFilePath: string) => void;
  completeDownload: (id: string, localFolderPath: string) => void;
  failDownload: (id: string, errorMsg: string) => void;
  cancelDownload: (id: string) => void;
  // Delete a completed download's files + remove it from local media.
  removeDownload: (id: string) => Promise<void>;
  // Re-drive a failed/cancelled download from its saved parts (resumes, doesn't restart from scratch).
  retryDownload: (id: string) => Promise<void>;
}

export const useDownloadStore = create<DownloadState>((set, get) => ({
  activeDownloads: {},
  completedDownloads: {},

  loadDownloadsFromDb: () => {
    const list = db.getAllDownloads();
    const active: Record<string, DownloadItem> = {};
    const completed: Record<string, DownloadItem> = {};
    
    list.forEach(item => {
      if (item.status === "completed") {
        completed[item.id] = item;
      } else if (item.status === "downloading" || item.status === "pending") {
        // App was killed mid-download. Mark as failed so the UI surfaces it,
        // but keep parts/progress intact so retryDownload can resume instead
        // of re-downloading completed parts from scratch.
        active[item.id] = { ...item, status: "failed" };
      } else {
        active[item.id] = item;
      }
    });

    set({ activeDownloads: active, completedDownloads: completed });
  },

  startDownload: (item, parts) => {
    const newItem: DownloadItem = {
      ...item,
      progress: 0,
      status: "pending",
      parts: parts.map(p => ({ ...p, bytesDownloaded: 0, completed: false })),
    };

    db.saveDownloadItem(newItem);
    set(state => ({
      activeDownloads: {
        ...state.activeDownloads,
        [item.id]: newItem,
      },
    }));
  },

  updateDownloadProgress: (id, partId, bytesDownloaded, fileSize) => {
    const active = get().activeDownloads;
    const item = active[id];
    if (!item) return;

    const updatedParts = item.parts.map(p => 
      p.id === partId ? { ...p, bytesDownloaded, fileSize } : p
    );

    // Calculate overall progress across all parts
    const totalBytesExpected = updatedParts.reduce((acc, p) => acc + (p.fileSize || 0), 0);
    const totalBytesDownloaded = updatedParts.reduce((acc, p) => acc + p.bytesDownloaded, 0);
    const progress = totalBytesExpected > 0 ? totalBytesDownloaded / totalBytesExpected : 0;

    const updatedItem = {
      ...item,
      status: "downloading" as const,
      parts: updatedParts,
      progress: Math.min(0.99, progress), // Keep completed at 0.99 until fully wrapped up
    };

    db.saveDownloadItem(updatedItem);
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

    const updatedParts = item.parts.map(p =>
      p.id === partId ? { ...p, completed: true, bytesDownloaded: p.fileSize, localFilePath } : p
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
      localFolderPath,
    };

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
    try {
      const { downloader } = require("../utils/downloader");
      downloader.abortBookParts(id);
    } catch (e) {
      console.warn("[Downloads] abortBookParts failed", e);
    }

    const cancelledItem = {
      ...item,
      status: "cancelled" as const,
    };

    db.saveDownloadItem(cancelledItem);
    set(state => {
      const nextActive = { ...state.activeDownloads };
      delete nextActive[id];
      return { activeDownloads: nextActive };
    });
  },

  removeDownload: async (id) => {
    const item = get().completedDownloads[id] || get().activeDownloads[id];
    // Delete the on-device folder (and its files).
    const folder = item?.localFolderPath;
    if (folder) {
      try { await FileSystem.deleteAsync(folder, { idempotent: true }); } catch (e) {
        console.warn("[Downloads] Failed to delete folder", folder, e);
      }
    }
    db.removeDownloadItem(id);
    set(state => {
      const nextCompleted = { ...state.completedDownloads };
      const nextActive = { ...state.activeDownloads };
      delete nextCompleted[id];
      delete nextActive[id];
      return { completedDownloads: nextCompleted, activeDownloads: nextActive };
    });
  },

  retryDownload: async (id) => {
    const item = get().activeDownloads[id];
    if (!item) return;

    // Flip back to pending so the UI shows it as queued while the downloader
    // picks up where it left off (completed parts are skipped, see downloader.resumeDownload).
    const pendingItem: DownloadItem = { ...item, status: "pending" };
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

// Mirror the set of downloaded item ids to a file the native Android Auto browse
// service reads, so downloaded books get a "⤋" badge in the car.
{
  const { writeAutoDownloads } = require("../utils/autoCreds");
  let _lastKeys = "";
  const sync = (completed: Record<string, unknown>) => {
    const ids = Object.keys(completed || {});
    const key = ids.slice().sort().join(",");
    if (key === _lastKeys) return;
    _lastKeys = key;
    writeAutoDownloads(ids);
  };
  sync(useDownloadStore.getState().completedDownloads);
  useDownloadStore.subscribe((state) => sync(state.completedDownloads));
}
