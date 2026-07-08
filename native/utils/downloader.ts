// SDK 54+ moved the classic download API (documentDirectory /
// createDownloadResumable / DownloadResumable) to the /legacy entry point.
import * as FileSystem from "expo-file-system/legacy";
import { useDownloadStore, DownloadItem, DownloadPart } from "../store/useDownloadStore";
import { downloadNotifications } from "./downloadNotifications";
import { absoluteUrl, coverUrl as buildCoverUrl } from "./urls";
import { api } from "./api";
import { useUserStore } from "../store/useUserStore";
import { storageHelper } from "./storage";
import { hasEbook, getEbookFormat } from "./bookMatch";

// In-memory reference to active download processes so they can be cancelled
const activeDownloadsMap: Record<string, FileSystem.DownloadResumable> = {};

// Per-book run generation. Each downloadBook/resumeDownload invocation bumps
// the counter and captures its own runId; any state mutation (fail/complete)
// is skipped if a newer run has since taken over. This prevents a stale loop
// (e.g. cancel → immediate re-download while a part is still aborting) from
// failing/completing the NEW download's store entry.
const bookRunSeq: Record<string, number> = {};
// Books that currently have a live download loop — used to reject duplicate
// concurrent starts (double-tap, retry-while-running, auto-next races).
const runningBooks = new Set<string>();

// Guards auto-download-next-in-series against triggering more than once per
// completion chain (e.g. if a user has several books mid-series queued up).
const autoNextInFlight = new Set<string>();

// Leave some headroom beyond the estimated download size when checking free
// disk space so we don't fill the device to the last byte.
const FREE_SPACE_MARGIN_BYTES = 50 * 1024 * 1024;

function cleanStringForFileSystem(str: string): string {
  return str.replace(/[/\\?%*:|"<>\s]/g, "_");
}

function bookFolderPath(id: string, title: string): string {
  return `${FileSystem.documentDirectory}downloads/${id}_${cleanStringForFileSystem(title)}/`;
}

/** Human-readable message for a non-2xx download response. */
function describeHttpFailure(status: number, filename: string): string {
  if (status === 401 || status === 403) return `Not authorized to download "${filename}" (session expired?)`;
  if (status === 404) return `"${filename}" was not found on the server`;
  return `Server returned ${status} for "${filename}"`;
}

/** Map raw filesystem/network errors to something meaningful for the UI. */
function friendlyError(err: any): string {
  const msg = String(err?.message || err || "Unknown error");
  if (/ENOSPC|no space left|disk.*full|not enough (free )?(disk )?space/i.test(msg)) {
    return "Not enough storage space on this device";
  }
  return msg;
}

/**
 * Best-effort preflight: if the server metadata gives us an expected size and
 * the device clearly doesn't have room for it, fail fast with a clear message
 * instead of writing until the disk fills mid-download.
 */
async function assertEnoughFreeSpace(parts: { fileSize: number }[]) {
  const needed = parts.reduce((acc, p) => acc + (p.fileSize || 0), 0);
  if (needed <= 0) return; // sizes unknown — can't preflight
  let free = 0;
  try {
    free = await FileSystem.getFreeDiskStorageAsync();
  } catch {
    return; // API unavailable — skip the check rather than block downloads
  }
  if (free > 0 && needed + FREE_SPACE_MARGIN_BYTES > free) {
    const mb = (n: number) => `${Math.ceil(n / (1024 * 1024))} MB`;
    throw new Error(`Not enough free space: needs ${mb(needed)}, only ${mb(free)} available`);
  }
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
    // Cancelled mid-flight: a late native callback must not touch the store or
    // resurrect the (already cleared) progress notification.
    if (!useDownloadStore.getState().activeDownloads[id]) return;
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

  const mapKey = `${id}_${part.id}`;
  activeDownloadsMap[mapKey] = downloadResumable;

  console.log(`[Downloader] Starting download part ${part.id} to ${destPath}`);
  let result: FileSystem.FileSystemDownloadResult | undefined;
  try {
    result = await downloadResumable.downloadAsync();
  } finally {
    // Always drop the handle, even when downloadAsync throws (network drop),
    // so abortBookParts never tries to cancel a dead resumable.
    delete activeDownloadsMap[mapKey];
  }

  // downloadAsync resolves undefined when cancelAsync was called on it.
  if (!result) {
    if (useDownloadStore.getState().activeDownloads[id]) {
      // Not a user cancel — the native task ended without a result.
      throw new Error(`Download of "${part.filename}" stopped unexpectedly`);
    }
    return; // cancelled — the caller's loop check will bail out
  }

  if (result.status === 200 || result.status === 206) {
    useDownloadStore.getState().completeDownloadPart(id, part.id, destPath);
    return;
  }

  // Non-2xx: the server's error body (HTML/JSON) was written to destPath —
  // delete it so a garbage file can't be mistaken for real media later.
  try {
    await FileSystem.deleteAsync(destPath, { idempotent: true });
  } catch {}
  const err: any = new Error(describeHttpFailure(result.status, part.filename));
  err.status = result.status;
  throw err;
}

/**
 * downloadPart with a single retry on 401: the access token can expire during
 * a long multi-part download. On 401 we poke an authenticated API endpoint
 * (which drives the axios refresh interceptor), re-read the stored token, and
 * retry the part once with a freshly-tokenized URL + Authorization header.
 */
async function downloadPartWithAuthRetry(
  id: string,
  title: string,
  part: { id: string; filename: string; url: string; fileSize: number },
  destPath: string,
  token: string
) {
  try {
    await downloadPart(id, title, part, destPath, token);
  } catch (err: any) {
    if (err?.status !== 401) throw err;
    console.log(`[Downloader] 401 on part ${part.id} — refreshing token and retrying once`);
    try {
      await api.get("/api/me"); // triggers the interceptor's refresh flow on 401
    } catch {}
    const config = storageHelper.getServerConfig();
    const freshToken = config?.token;
    // No refresh happened (same/absent token) — surface the original error.
    if (!freshToken || freshToken === token) throw err;
    const freshUrl = absoluteUrl(part.url.split("?")[0], config.address || "", freshToken);
    await downloadPart(id, title, { ...part, url: freshUrl }, destPath, freshToken);
  }
}

/**
 * Called when the user FINISHES LISTENING to a book. If "auto-download next in
 * series" is on AND the just-finished book was itself downloaded, download the
 * SINGLE next book in its series.
 *
 * This used to fire on download COMPLETION and chain — each finished download
 * kicked off the next, so enabling the setting and downloading book 1 silently
 * pulled the ENTIRE series (many GB, possibly over mobile data) with no consent.
 * Tying it to finishing LISTENING, gating on the finished book being downloaded,
 * and only ever grabbing one book, matches what the setting actually promises.
 * Best-effort — never throws to the caller.
 */
export async function autoDownloadNextAfterFinish(libraryItemId: string) {
  try {
    if (!useUserStore.getState().settings?.autoDownloadNextInSeries) return;
    if (!libraryItemId || autoNextInFlight.has(libraryItemId)) return;
    // Only when the finished book was downloaded — a streaming-only listener
    // finishing a book must not trigger a surprise download.
    if (!useDownloadStore.getState().completedDownloads[libraryItemId]) return;

    const config = storageHelper.getServerConfig();
    const serverAddress = config?.address;
    const token = config?.token;
    if (!serverAddress || !token) return;

    autoNextInFlight.add(libraryItemId);

    // The playback session doesn't carry full series metadata — fetch the
    // finished item to learn its series + sequence.
    const curRes = await api.get(`/api/items/${libraryItemId}?expanded=1`);
    const libraryItem = curRes.data;
    const libraryId = libraryItem?.libraryId;
    const series = (libraryItem?.media?.metadata?.series || [])[0];
    if (!libraryId || !series?.id) return;

    const currentSequence = parseFloat(series.sequence);
    const res = await api.get(`/api/libraries/${libraryId}/series/${series.id}`);
    const books: any[] = res.data?.books || [];
    if (!books.length) return;

    const { completedDownloads, activeDownloads } = useDownloadStore.getState();

    // A book can belong to MULTIPLE series, so series[0] may be a DIFFERENT
    // series than the one we're following — resolve each candidate's sequence
    // by matching the REQUESTED series id, not by blindly reading series[0].
    const sequenceInSeries = (b: any) =>
      parseFloat((b?.media?.metadata?.series || []).find((s: any) => s?.id === series.id)?.sequence);

    // Prefer the book whose sequence is strictly next after the current one;
    // fall back to the first book not yet downloaded/downloading.
    const sorted = books
      .filter(b => b.id !== libraryItemId)
      .sort((a, b) => (sequenceInSeries(a) || 0) - (sequenceInSeries(b) || 0));

    let next = sorted.find(b => {
      const seq = sequenceInSeries(b);
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

    console.log("[Downloader] Auto-downloading next in series after finish:", expandedItem?.media?.metadata?.title);
    await downloader.downloadBook(expandedItem, serverAddress, token);
  } catch (e) {
    console.warn("[Downloader] Auto-download-next-in-series failed:", e);
  } finally {
    autoNextInFlight.delete(libraryItemId);
  }
}

export const downloader = {
  downloadBook: async (libraryItem: any, serverAddress: string, token: string) => {
    const id = libraryItem.id;

    // Duplicate-start guard: if a loop is already driving this book (double
    // tap, auto-next racing a manual download, retry-while-running), ignore.
    if (runningBooks.has(id)) {
      console.log("[Downloader] Download already running for", id, "— ignoring duplicate start");
      return;
    }

    const media = libraryItem.media || {};
    const metadata = media.metadata || {};
    const title = metadata.title || "Unknown Title";
    const author = metadata.authorName || "Unknown Author";

    // Setup tracks and cover downloads
    const tracks = media.tracks || [];
    const partsToDownload: any[] = [];

    // Add cover download if available (skip when the URL can't be built, e.g.
    // missing server address — an empty URL would fail the whole download).
    const coverPath = media.coverPath;
    const coverDownloadUrl = coverPath ? buildCoverUrl(id, serverAddress, token) : null;
    if (coverDownloadUrl) {
      partsToDownload.push({
        id: "cover",
        filename: `cover.${coverPath.split(".").pop() || "jpg"}`,
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
    // Malformed metadata can repeat track.index — colliding part ids would
    // silently overwrite one file with another and resolve BOTH logical
    // tracks to the same audio at playback. Uniquify on collision.
    const usedTrackIds = new Set<string>();
    tracks.forEach((track: any, idx: number) => {
      const rel: string = track.contentUrl || `/api/items/${id}/file/${track.ino || ""}`;
      const trackUrl = absoluteUrl(rel, serverAddress, token);
      const ext = String(track.metadata?.ext || track.ext || "mp3").replace(/^\./, "");
      let base = `track_${track.index ?? idx}`;
      if (usedTrackIds.has(base)) base = `track_${track.index ?? idx}_${idx}`;
      usedTrackIds.add(base);
      partsToDownload.push({
        id: base,
        filename: `${base}.${ext}`,
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
      tracks: tracks.map((track: any, idx: number) => {
        // Mirror the collision-uniquified part filenames above.
        const trackPart = partsToDownload.filter((p) => p.id.startsWith("track_"))[idx];
        return {
          index: track.index ?? idx,
          filename:
            trackPart?.filename ||
            `track_${track.index ?? idx}.${String(track.metadata?.ext || track.ext || "mp3").replace(/^\./, "")}`,
          duration: track.duration || 0,
          startOffset: track.startOffset || 0,
        };
      }),
    };

    // Target directory — recorded on the store item from the start so cancel/
    // remove can always find (and delete) partial files, not just completed ones.
    const localFolderPath = bookFolderPath(id, title);

    // Initialize state
    useDownloadStore.getState().startDownload(
      {
        id,
        libraryItemId: id,
        title,
        author,
        coverUrl: coverDownloadUrl || "",
        localFolderPath,
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

    const runId = (bookRunSeq[id] = (bookRunSeq[id] || 0) + 1);
    const isCurrent = () => bookRunSeq[id] === runId;
    runningBooks.add(id);

    try {
      // Fail fast (with a clear message) when the device clearly lacks space.
      await assertEnoughFreeSpace(partsToDownload);

      const dirInfo = await FileSystem.getInfoAsync(localFolderPath);
      if (!dirInfo.exists) {
        await FileSystem.makeDirectoryAsync(localFolderPath, { intermediates: true });
      }

      // Download each part sequentially. Bail if the user cancelled mid-flight —
      // otherwise the finished loop would "complete" a cancelled download.
      for (const part of partsToDownload) {
        if (!isCurrent()) return; // a newer run owns this book's state now
        if (!useDownloadStore.getState().activeDownloads[id]) {
          downloadNotifications.clear(id);
          return;
        }
        const destPath = `${localFolderPath}${part.filename}`;
        await downloadPartWithAuthRetry(id, title, part, destPath, token);
      }
      if (!isCurrent()) return;
      if (!useDownloadStore.getState().activeDownloads[id]) {
        downloadNotifications.clear(id);
        return;
      }

      // If we finished all parts successfully
      useDownloadStore.getState().completeDownload(id, localFolderPath);
      downloadNotifications.complete(id, title);
      console.log(`[Downloader] Download completed successfully for book: ${title}`);

      // This book is done — release the running guard.
      runningBooks.delete(id);
      // NOTE: auto-download-next-in-series is NOT triggered here anymore.
      // Firing it on download completion chained the whole series; it now fires
      // when the user FINISHES LISTENING (see autoDownloadNextAfterFinish, called
      // from the playback finished-transition).
    } catch (err: any) {
      if (!isCurrent()) return; // superseded — don't fail the new run's state
      console.error(`[Downloader] Download failed for book ${title}:`, err);
      useDownloadStore.getState().failDownload(id, friendlyError(err));
      downloadNotifications.clear(id);
    } finally {
      if (isCurrent()) runningBooks.delete(id);
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

    // Duplicate-start guard, same as downloadBook (double-tapped retry etc.).
    if (runningBooks.has(id)) {
      console.log("[Downloader] Download already running for", id, "— ignoring duplicate resume");
      return;
    }

    let localFolderPath = downloadItem.localFolderPath;
    if (!localFolderPath) {
      localFolderPath = bookFolderPath(id, title);
      // Persist it so cancel/remove can locate the partial files (older DB
      // rows from before localFolderPath was set at start won't have it).
      useDownloadStore.getState().setDownloadFolder(id, localFolderPath);
    }

    const runId = (bookRunSeq[id] = (bookRunSeq[id] || 0) + 1);
    const isCurrent = () => bookRunSeq[id] === runId;
    runningBooks.add(id);

    try {
      const dirInfo = await FileSystem.getInfoAsync(localFolderPath);
      if (!dirInfo.exists) {
        await FileSystem.makeDirectoryAsync(localFolderPath, { intermediates: true });
      }

      downloadNotifications.start(id, title);

      const remainingParts = (downloadItem.parts || []).filter((p: DownloadPart) => !p.completed);

      // Only the not-yet-downloaded remainder needs to fit on disk.
      await assertEnoughFreeSpace(remainingParts);

      for (const part of remainingParts) {
        if (!isCurrent()) return;
        if (!useDownloadStore.getState().activeDownloads[id]) {
          downloadNotifications.clear(id);
          return;
        }
        const destPath = `${localFolderPath}${part.filename}`;
        // Token may have rotated since the original attempt; rebuild the url with the current one.
        const refreshedUrl = part.url.split("?")[0];
        const url = absoluteUrl(refreshedUrl, serverAddress, token);
        await downloadPartWithAuthRetry(id, title, { ...part, url }, destPath, token);
      }
      if (!isCurrent()) return;
      if (!useDownloadStore.getState().activeDownloads[id]) {
        downloadNotifications.clear(id);
        return;
      }

      useDownloadStore.getState().completeDownload(id, localFolderPath);
      downloadNotifications.complete(id, title);
      console.log(`[Downloader] Resume completed successfully for book: ${title}`);
    } catch (err: any) {
      if (!isCurrent()) return;
      console.error(`[Downloader] Resume failed for book ${title}:`, err);
      useDownloadStore.getState().failDownload(id, friendlyError(err));
      downloadNotifications.clear(id);
    } finally {
      if (isCurrent()) runningBooks.delete(id);
    }
  },

  /**
   * Cancels the in-flight native DownloadResumables and clears the notification
   * for a book WITHOUT touching store state. Called by the store's
   * cancelDownload so that every cancel path (screens call the store directly)
   * actually stops the bytes, not just the UI entry.
   */
  /**
   * Deletes subfolders of downloads/ that no download record owns — partial
   * files orphaned by old cancel/fail paths that never cleaned up. Ownership
   * is re-checked against the LIVE store right before each delete so a
   * download started while the sweep is in flight can't lose its folder
   * (startDownload registers the item before any file is written).
   */
  sweepOrphanFolders: async () => {
    try {
      const root = `${FileSystem.documentDirectory}downloads/`;
      const rootInfo = await FileSystem.getInfoAsync(root);
      if (!rootInfo.exists) return;
      const entries = await FileSystem.readDirectoryAsync(root);
      for (const name of entries) {
        const { activeDownloads, completedDownloads } = useDownloadStore.getState();
        const ownedBy = (ids: string[]) => ids.some(id => name === id || name.startsWith(`${id}_`));
        if (ownedBy(Object.keys(activeDownloads)) || ownedBy(Object.keys(completedDownloads))) continue;
        console.log("[Downloader] Removing orphaned download folder:", name);
        try {
          await FileSystem.deleteAsync(`${root}${name}`, { idempotent: true });
        } catch (e) {
          console.warn("[Downloader] Failed to remove orphaned folder:", name, e);
        }
      }
    } catch (e) {
      console.warn("[Downloader] Orphan sweep failed:", e);
    }
  },

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
