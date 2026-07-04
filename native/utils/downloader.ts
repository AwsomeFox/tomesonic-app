// SDK 54+ moved the classic download API (documentDirectory /
// createDownloadResumable / DownloadResumable) to the /legacy entry point.
import * as FileSystem from "expo-file-system/legacy";
import { useDownloadStore, DownloadItem, DownloadPart } from "../store/useDownloadStore";
import { downloadNotifications } from "./downloadNotifications";
import { absoluteUrl, coverUrl as buildCoverUrl } from "./urls";
import { api } from "./api";
import { useUserStore } from "../store/useUserStore";
import { hasEbook, getEbookFormat } from "./bookMatch";

// In-memory reference to active download processes so they can be cancelled
const activeDownloadsMap: Record<string, FileSystem.DownloadResumable> = {};

// Guards auto-download-next-in-series against triggering more than once per
// completion chain (e.g. if a user has several books mid-series queued up).
const autoNextInFlight = new Set<string>();

function cleanStringForFileSystem(str: string): string {
  return str.replace(/[/\\?%*:|"<>\s]/g, "_");
}

/** Downloads a single part to destPath, wiring progress/completion into the store + notifications. */
async function downloadPart(
  id: string,
  title: string,
  part: { id: string; filename: string; url: string; fileSize: number },
  destPath: string,
  token: string
) {
  const callback = (downloadProgress: FileSystem.DownloadProgressData) => {
    const bytesWritten = downloadProgress.totalBytesWritten;
    const bytesExpected = downloadProgress.totalBytesExpectedToWrite;
    useDownloadStore.getState().updateDownloadProgress(id, part.id, bytesWritten, bytesExpected);
    // Mirror the overall progress into the system notification.
    const overall = useDownloadStore.getState().activeDownloads[id]?.progress ?? 0;
    downloadNotifications.progress(id, title, overall);
  };

  const downloadResumable = FileSystem.createDownloadResumable(
    part.url,
    destPath,
    { headers: { Authorization: `Bearer ${token}` } },
    callback
  );

  activeDownloadsMap[`${id}_${part.id}`] = downloadResumable;

  console.log(`[Downloader] Starting download part ${part.id} to ${destPath}`);
  const result = await downloadResumable.downloadAsync();

  delete activeDownloadsMap[`${id}_${part.id}`];

  if (result && result.status === 200) {
    useDownloadStore.getState().completeDownloadPart(id, part.id, destPath);
  } else {
    throw new Error(`Failed to download part ${part.id}, status code: ${result?.status || "unknown"}`);
  }
}

/**
 * After a book finishes downloading, optionally kick off the next book in
 * its series (if the user has that setting on). Best-effort only — any
 * failure here must never surface as a failure of the primary download.
 */
async function maybeAutoDownloadNext(libraryItem: any, serverAddress: string, token: string) {
  try {
    if (!useUserStore.getState().settings?.autoDownloadNextInSeries) return;

    const id = libraryItem.id;
    if (autoNextInFlight.has(id)) return;

    const libraryId = libraryItem.libraryId;
    const metadata = libraryItem.media?.metadata || {};
    const seriesList = metadata.series || [];
    const series = seriesList[0];
    if (!libraryId || !series?.id) return;

    autoNextInFlight.add(id);

    const currentSequence = parseFloat(series.sequence);
    const res = await api.get(`/api/libraries/${libraryId}/series/${series.id}`);
    const books: any[] = res.data?.books || [];
    if (!books.length) return;

    const { completedDownloads, activeDownloads } = useDownloadStore.getState();

    // Prefer the book whose sequence is strictly next after the current one;
    // fall back to the first book not yet downloaded/downloading.
    const sorted = books
      .filter(b => b.id !== id)
      .sort((a, b) => (parseFloat(a?.media?.metadata?.series?.[0]?.sequence) || 0) - (parseFloat(b?.media?.metadata?.series?.[0]?.sequence) || 0));

    let next = sorted.find(b => {
      const seq = parseFloat(b?.media?.metadata?.series?.[0]?.sequence);
      return !isNaN(currentSequence) && !isNaN(seq) && seq > currentSequence;
    });
    if (!next) {
      next = sorted.find(b => !completedDownloads[b.id] && !activeDownloads[b.id]);
    }
    if (!next || completedDownloads[next.id] || activeDownloads[next.id]) return;

    // The series listing doesn't include full track info; fetch the expanded item.
    const expandedRes = await api.get(`/api/items/${next.id}?expanded=1`);
    const expandedItem = expandedRes.data;
    if (!expandedItem) return;

    console.log("[Downloader] Auto-downloading next in series:", expandedItem?.media?.metadata?.title);
    await downloader.downloadBook(expandedItem, serverAddress, token);
  } catch (e) {
    console.warn("[Downloader] Auto-download-next-in-series failed:", e);
  } finally {
    autoNextInFlight.delete(libraryItem.id);
  }
}

export const downloader = {
  downloadBook: async (libraryItem: any, serverAddress: string, token: string) => {
    const id = libraryItem.id;
    const media = libraryItem.media || {};
    const metadata = media.metadata || {};
    const title = metadata.title || "Unknown Title";
    const author = metadata.authorName || "Unknown Author";

    // Setup tracks and cover downloads
    const tracks = media.tracks || [];
    const partsToDownload: any[] = [];

    // Add cover download if available
    const coverPath = media.coverPath;
    let coverLocalPath = "";
    if (coverPath) {
      const coverDownloadUrl = buildCoverUrl(id, serverAddress, token) || "";
      coverLocalPath = `cover.${coverPath.split(".").pop() || "jpg"}`;
      partsToDownload.push({
        id: "cover",
        filename: coverLocalPath,
        url: coverDownloadUrl,
        fileSize: 0, // dynamic
      });
    }

    // Add Ebook download if available
    if (hasEbook(libraryItem)) {
      const ebookDownloadUrl = `${serverAddress}/api/items/${id}/ebook`;
      const ebookFormat = getEbookFormat(libraryItem) || "epub";
      partsToDownload.push({
        id: "ebook",
        filename: `book.${ebookFormat}`,
        url: ebookDownloadUrl,
        fileSize: media.ebookFile?.metadata?.size || media.ebookFile?.fileSize || 0,
      });
    }

    // Add tracks. ABS expanded library items expose media.tracks each with a
    // server-relative contentUrl (the same direct-play URL used for streaming);
    // download that with the auth token appended.
    tracks.forEach((track: any, idx: number) => {
      const rel: string = track.contentUrl || `/api/items/${id}/file/${track.ino || ""}`;
      const trackUrl = absoluteUrl(rel, serverAddress, token);
      const ext = String(track.metadata?.ext || track.ext || "mp3").replace(/^\./, "");
      partsToDownload.push({
        id: `track_${track.index ?? idx}`,
        filename: `track_${track.index ?? idx}.${ext}`,
        url: trackUrl,
        fileSize: track.metadata?.size || track.fileSize || 0,
      });
    });

    if (partsToDownload.length === 0) {
      console.warn("[Downloader] Nothing to download for library item:", id);
      return;
    }

    // Playback metadata so this book can play fully offline later (chapters,
    // whole-book duration, and per-track timing keyed to our part filenames).
    const meta = {
      duration: Number(media.duration) || tracks.reduce((a: number, t: any) => a + (t.duration || 0), 0),
      chapters: media.chapters || [],
      tracks: tracks.map((track: any, idx: number) => ({
        index: track.index ?? idx,
        filename: `track_${track.index ?? idx}.${String(track.metadata?.ext || track.ext || "mp3").replace(/^\./, "")}`,
        duration: track.duration || 0,
        startOffset: track.startOffset || 0,
      })),
    };

    // Initialize state
    useDownloadStore.getState().startDownload(
      {
        id,
        libraryItemId: id,
        title,
        author,
        coverUrl: coverPath ? buildCoverUrl(id, serverAddress, token) || "" : "",
        meta,
      },
      partsToDownload.map(p => ({
        id: p.id,
        filename: p.filename,
        url: p.url,
        fileSize: p.fileSize,
      }))
    );
    downloadNotifications.start(id, title);

    // Create target directory
    const cleanTitle = cleanStringForFileSystem(title);
    const localFolderPath = `${FileSystem.documentDirectory}downloads/${id}_${cleanTitle}/`;

    try {
      const dirInfo = await FileSystem.getInfoAsync(localFolderPath);
      if (!dirInfo.exists) {
        await FileSystem.makeDirectoryAsync(localFolderPath, { intermediates: true });
      }

      // Download each part sequentially. Bail if the user cancelled mid-flight —
      // otherwise the finished loop would "complete" a cancelled download.
      for (const part of partsToDownload) {
        if (!useDownloadStore.getState().activeDownloads[id]) {
          downloadNotifications.clear(id);
          return;
        }
        const destPath = `${localFolderPath}${part.filename}`;
        await downloadPart(id, title, part, destPath, token);
      }
      if (!useDownloadStore.getState().activeDownloads[id]) {
        downloadNotifications.clear(id);
        return;
      }

      // If we finished all parts successfully
      useDownloadStore.getState().completeDownload(id, localFolderPath);
      downloadNotifications.complete(id, title);
      console.log(`[Downloader] Download completed successfully for book: ${title}`);

      // Best-effort: queue up the next book in the series if the user wants that.
      await maybeAutoDownloadNext(libraryItem, serverAddress, token);
    } catch (err: any) {
      console.error(`[Downloader] Download failed for book ${title}:`, err);
      useDownloadStore.getState().failDownload(id, err.message || "Unknown error");
      downloadNotifications.clear(id);
    }
  },

  /**
   * Re-drives a previously-started DownloadItem (from a failed/cancelled/interrupted
   * state), skipping parts already marked completed and reusing the existing folder.
   * Used by useDownloadStore.retryDownload — we don't have the original libraryItem
   * here, so auto-download-next-in-series is intentionally NOT attempted from this path.
   */
  resumeDownload: async (downloadItem: DownloadItem, serverAddress: string, token: string) => {
    const { id, title } = downloadItem;

    let localFolderPath = downloadItem.localFolderPath;
    if (!localFolderPath) {
      const cleanTitle = cleanStringForFileSystem(title);
      localFolderPath = `${FileSystem.documentDirectory}downloads/${id}_${cleanTitle}/`;
    }

    try {
      const dirInfo = await FileSystem.getInfoAsync(localFolderPath);
      if (!dirInfo.exists) {
        await FileSystem.makeDirectoryAsync(localFolderPath, { intermediates: true });
      }

      downloadNotifications.start(id, title);

      const remainingParts = (downloadItem.parts || []).filter((p: DownloadPart) => !p.completed);
      for (const part of remainingParts) {
        if (!useDownloadStore.getState().activeDownloads[id]) {
          downloadNotifications.clear(id);
          return;
        }
        const destPath = `${localFolderPath}${part.filename}`;
        // Token may have rotated since the original attempt; rebuild the url with the current one.
        const refreshedUrl = part.url.split("?")[0];
        const url = absoluteUrl(refreshedUrl, serverAddress, token);
        await downloadPart(id, title, { ...part, url }, destPath, token);
      }
      if (!useDownloadStore.getState().activeDownloads[id]) {
        downloadNotifications.clear(id);
        return;
      }

      useDownloadStore.getState().completeDownload(id, localFolderPath);
      downloadNotifications.complete(id, title);
      console.log(`[Downloader] Resume completed successfully for book: ${title}`);
    } catch (err: any) {
      console.error(`[Downloader] Resume failed for book ${title}:`, err);
      useDownloadStore.getState().failDownload(id, err.message || "Unknown error");
      downloadNotifications.clear(id);
    }
  },

  /**
   * Cancels the in-flight native DownloadResumables and clears the notification
   * for a book WITHOUT touching store state. Called by the store's
   * cancelDownload so that every cancel path (screens call the store directly)
   * actually stops the bytes, not just the UI entry.
   */
  abortBookParts: async (id: string) => {
    const activeKeys = Object.keys(activeDownloadsMap).filter(k => k.startsWith(`${id}_`));
    for (const key of activeKeys) {
      const download = activeDownloadsMap[key];
      if (download) {
        try {
          await download.cancelAsync();
        } catch (e) {
          console.warn("[Downloader] Failed to cancel download part:", key, e);
        }
        delete activeDownloadsMap[key];
      }
    }
    downloadNotifications.clear(id);
  },

  cancelBookDownload: async (id: string) => {
    console.log("[Downloader] Cancelling download for item:", id);
    // State change first (marks it cancelled), which also aborts the parts.
    useDownloadStore.getState().cancelDownload(id);
  }
};
