import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  ActivityIndicator,
  useWindowDimensions,
  TextInput,
  Linking,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import { Image } from "expo-image";
import { coverSource } from "../utils/coverSource";
import { SafeAreaView } from "react-native-safe-area-context";
import { api } from "../utils/api";
import {
  queueFinishedPatch,
  queueProgressPatch,
  syncBothProgressFraction,
  reconcileLinkedProgress,
  clearPendingWritesFor,
} from "../utils/progressSync";
import { useUserStore } from "../store/useUserStore";
import { useFavoritesStore } from "../store/useFavoritesStore";
import { usePlaybackStore } from "../store/usePlaybackStore";
import { showAppDialog } from "../store/useDialogStore";
import { useThemeColors } from "../theme/useThemeColors";
import { withAlpha } from "../theme/palette";
import Icon from "../components/Icon";
import ErrorState from "../components/ErrorState";
import EmptyState from "../components/EmptyState";
import { useDownloadStore, episodeDownloadKey } from "../store/useDownloadStore";
import { downloader, downloadFileByUrl, type FileDownloadHandle } from "../utils/downloader";
import { downloadNotifications } from "../utils/downloadNotifications";
import { storage } from "../utils/storage";
import { encodeFilterValue } from "../components/FilterModal";
import TopAppBar from "../components/TopAppBar";
import ChaptersModal from "../components/ChaptersModal";
import AddToListModal from "../components/AddToListModal";
import BottomSheet from "../components/BottomSheet";
import OpenFeedSheet, { type OpenFeedEntity } from "../components/OpenFeedSheet";
import ResultBurst from "../components/ResultBurst";
import { useRmabStore } from "../store/useRmabStore";
import { hasAudio, hasEbook as itemHasEbook, getEbookFormat, bestCounterpart } from "../utils/bookMatch";
import { formatBytes } from "../utils/format";
import Pressable from "../components/HintPressable";
import { RowBase } from "../components/SettingsRows";
import { showSnackbar } from "../store/useSnackbarStore";
import { useServerCapabilities } from "../utils/abs/capabilities";
import {
  encodeM4b,
  embedMetadata,
  createShareLink,
  deleteShareLink,
  getItemZipDownloadTarget,
} from "../utils/abs/items";
import { startTaskWatch, subscribeTasks, getTasksSnapshot } from "../utils/abs/tasks";
import { batchUpdateProgress } from "../utils/abs/me";
import type { AbsTask } from "../utils/abs/types";
// The classic filesystem API lives on the /legacy entry point (SDK 54+) —
// used here only to dispose of the shared zip staging file from the cache.
import * as FileSystem from "expo-file-system/legacy";

// expo-sharing is optional at runtime (same lazy require as ReaderScreen's
// openExternally) — a build without it falls back to the browser dialog.
let Sharing: any = null;
try {
  Sharing = require("expo-sharing");
} catch {
  Sharing = null;
}

// Share-link expiry presets (ms). 0 = never (the server expects numeric
// expiresAt with 0 for "no expiry" — never null).
const SHARE_EXPIRY_OPTIONS: { label: string; ms: number }[] = [
  { label: "1 day", ms: 24 * 60 * 60 * 1000 },
  { label: "1 week", ms: 7 * 24 * 60 * 60 * 1000 },
  { label: "30 days", ms: 30 * 24 * 60 * 60 * 1000 },
  { label: "Never", ms: 0 },
];

/** "The Long Way!" → "the-long-way" — default slug for a new share link. */
export function slugifyTitle(title: string): string {
  return String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** Strip HTML tags/entities from ABS descriptions (which contain markup). */
function stripHtml(html: string): string {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// base64Encode helper removed in favor of imported encodeFilterValue

/** Mirrors $elapsedPretty — "19 hr 25 min" / "45 min". */
function elapsedPretty(seconds: number | undefined) {
  if (!seconds || seconds <= 0) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h} hr ${m} min`;
  return `${m} min`;
}

export default function ItemDetailScreen({ route, navigation }: any) {
  const colors = useThemeColors();
  const { width: screenWidth } = useWindowDimensions();
  const { itemId } = route.params || {};
  const { serverConnectionConfig } = useUserStore();
  const [descExpanded, setDescExpanded] = useState(false);
  // Whether the collapsed description actually overflows 5 lines — drives the
  // "Read more" affordance reliably (a char-count guess misfires on short
  // paragraphs with many line breaks and on long single-line text).
  const [descOverflows, setDescOverflows] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startingEpisodeId, setStartingEpisodeId] = useState<string | null>(null);
  const [chaptersVisible, setChaptersVisible] = useState(false);
  const [addToVisible, setAddToVisible] = useState(false);
  // Overflow ("More actions") sheet + the admin flows it fans out to.
  const [overflowVisible, setOverflowVisible] = useState(false);
  const [toolsVisible, setToolsVisible] = useState(false);
  const [shareVisible, setShareVisible] = useState(false);
  const [shareSlug, setShareSlug] = useState("");
  const [shareExpiryMs, setShareExpiryMs] = useState(SHARE_EXPIRY_OPTIONS[1].ms); // 1 week
  const [shareBusy, setShareBusy] = useState(false);
  // The created link for THIS sheet session (ABS has no per-item share GET, so
  // we only know about links we just minted).
  const [shareLink, setShareLink] = useState<any>(null);
  // Open-RSS-feed flow (admin-only) — null when the sheet is closed.
  const [feedEntity, setFeedEntity] = useState<OpenFeedEntity | null>(null);
  // In-app zip download (issue #68): whole-percent progress + a cancel hook
  // for the banner. Null when idle. `totalBytes` is the ONE total both the
  // percent and the byte label derive from — preferring the response's
  // Content-Length (captured in onProgress) over the item's metadata size;
  // 0 means no total is known and the banner renders indeterminate. The live
  // handle rides a ref so the unmount cleanup can cancel without re-running
  // the effect per percent.
  const [zipDownload, setZipDownload] = useState<null | {
    pct: number;
    totalBytes: number;
    cancel: () => Promise<void>;
  }>(null);
  const zipHandleRef = React.useRef<FileDownloadHandle | null>(null);
  React.useEffect(() => {
    return () => {
      // Cancel an in-flight zip on unmount — the handle's own cancel path
      // clears the notification and deletes the partial file from cache.
      zipHandleRef.current?.cancel();
    };
  }, []);
  const capabilities = useServerCapabilities();
  const [sendToVisible, setSendToVisible] = useState(false);
  const [sendingTo, setSendingTo] = useState<string | null>(null);
  const [sendResult, setSendResult] = useState<null | { ok: boolean; device: string }>(null);
  // Request-the-other-format via ReadMeABook (null = sheet closed).
  const [formatReq, setFormatReq] = useState<null | {
    kind: "ebook" | "audiobook";
    state: "working" | "ok" | "fail";
    msg?: string;
  }>(null);
  const rmabConfigured = useRmabStore((s) => s.configured);
  const rmabAuthMode = useRmabStore((s) => s.authMode);
  // Async send/request flows resolve after navigation away — guard their
  // deferred setState (same pattern as DiscoverScreen).
  const aliveRef = React.useRef(true);
  React.useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);
  const ereaderDevices = useUserStore((s) => s.ereaderDevices);
  // Per-item "Link reading & listening" lock — subscribe to the map so the
  // toggle reflects/persists per book (see useUserStore settings.linkedProgress).
  const linkedProgressMap = useUserStore((s) => s.settings.linkedProgress);
  const setProgressLinked = useUserStore((s) => s.setProgressLinked);
  const isLinked = !!(itemId && linkedProgressMap?.[itemId]);

  // Local "Want to Read" / favorites overlay (no server flag exists). Subscribe
  // to the list so the heart reflects/persists the toggle across screens.
  const isFavorite = useFavoritesStore((s) => (itemId ? s.favorites.includes(itemId) : false));
  const toggleFavorite = useFavoritesStore((s) => s.toggleFavorite);

  const startPlayback = usePlaybackStore((state) => state.startPlayback);
  const currentSession = usePlaybackStore((state) => state.currentSession);
  const currentChapterIndex = usePlaybackStore((state) => state.currentChapterIndex);
  const seekToChapter = usePlaybackStore((state) => state.seekToChapter);

  const [item, setItem] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const hasSession = currentSession !== null;

  const completedDownloads = useDownloadStore((s) => s.completedDownloads);
  const activeDownloads = useDownloadStore((s) => s.activeDownloads);
  const cancelDownload = useDownloadStore((s) => s.cancelDownload);
  const removeDownload = useDownloadStore((s) => s.removeDownload);

  // NOT downloaded while an active row exists for the same id — a poisoned
  // dual-state made the a11y label say "Delete download" over a progress
  // spinner (and press ran the delete flow mid-download).
  const isDownloaded = !!(item?.id && completedDownloads[item.id] && !activeDownloads[item.id]);
  // A failed download stays in activeDownloads with status "failed" — it must
  // NOT read as "downloading" (that rendered an infinite spinner here) but as
  // a retryable error, matching BookCard's handling.
  const downloadStatus = item?.id ? activeDownloads[item.id]?.status : undefined;
  const isDownloading = downloadStatus === "downloading" || downloadStatus === "pending";
  const isDownloadFailed = downloadStatus === "failed";

  // Progress source: the global map entry is live-updated every second while
  // playing/reading, whereas item.userMediaProgress is a snapshot from the
  // item fetch — prefer whichever is fresher so the Your Progress card tracks
  // an active session AND reflects a just-toggled finished state (the refetch
  // bumps the snapshot's lastUpdate past the map's).
  const liveProgress = useUserStore((s) => (itemId ? s.mediaProgress[itemId] : null));
  // Full map for podcast episode rows (their entries are keyed `${itemId}-${episodeId}`).
  const progressMap = useUserStore((s) => s.mediaProgress);
  const itemProgress = item?.userMediaProgress || null;
  const progress = React.useMemo(() => {
    if (!liveProgress) return itemProgress;
    if (!itemProgress) return liveProgress;
    const liveAt = Number(liveProgress.lastUpdate || liveProgress.updatedAt || 0);
    const itemAt = Number(itemProgress.lastUpdate || itemProgress.updatedAt || 0);
    // Merge so ebook-only live writes (reader) keep the snapshot's audio fields.
    return liveAt >= itemAt ? { ...itemProgress, ...liveProgress } : itemProgress;
  }, [liveProgress, itemProgress]);
  const isFinished = !!progress?.isFinished;
  const activeDownload = item?.id ? activeDownloads[item.id] : null;
  const downloadPct =
    activeDownload && Number.isFinite(activeDownload.progress)
      ? Math.round(activeDownload.progress * 100)
      : 0;

  const finishBusyRef = React.useRef(false);
  const handleToggleFinished = async () => {
    if (!item?.id || finishBusyRef.current) return;
    finishBusyRef.current = true;
    const next = !isFinished;
    // Merge into the global progress map immediately so badges/cards on
    // already-rendered screens update without waiting for the next /api/me —
    // applied for BOTH the online and queued-offline outcomes below.
    const applyLocally = () =>
      useUserStore.setState((s) => {
        const now = Date.now();
        const nextMap: Record<string, any> = {
          ...s.mediaProgress,
          [item.id]: {
            ...s.mediaProgress[item.id],
            libraryItemId: item.id,
            isFinished: next,
            updatedAt: now,
          },
        };
        if (counterpart?.id) {
          nextMap[counterpart.id] = {
            ...s.mediaProgress[counterpart.id],
            libraryItemId: counterpart.id,
            isFinished: next,
            updatedAt: now,
          };
        }
        return { mediaProgress: nextMap };
      });
    try {
      await api.patch(`/api/me/progress/${item.id}`, { isFinished: next });
      // Mark-as-finished means the BOOK is finished — when the ebook and the
      // audiobook live as two separate library items (the fuzzy-matched
      // counterpart), mirror the flag to the sibling so both formats agree.
      // Best-effort: a failure here never blocks the primary toggle (but it
      // does queue, so it still lands once connectivity returns).
      if (counterpart?.id) {
        api.patch(`/api/me/progress/${counterpart.id}`, { isFinished: next }).catch((e) => {
          console.warn("[ItemDetail] Counterpart finished-toggle failed — queueing:", e);
          queueFinishedPatch(counterpart.id, next);
        });
      }
      applyLocally();
      refetchItem();
    } catch (err: any) {
      // Distinguish a genuine offline/network failure (the request never got a
      // response) from a server rejection (403/500 etc.). Only the offline case
      // may optimistically queue + apply the toggle locally — poison-patching on
      // a server error would desync the map from the server's real state.
      if (err?.response) {
        console.warn("[ItemDetail] Toggle finished rejected by server:", err);
        showAppDialog({
          title: "Couldn't update",
          message: "The server rejected this change. Please try again.",
        });
      } else {
        // Offline — queue the toggle(s) and reflect the state locally anyway;
        // flushPendingSyncs delivers them when the server is reachable again.
        console.warn("[ItemDetail] Toggle finished failed — queueing for later:", err);
        queueFinishedPatch(item.id, next);
        if (counterpart?.id) queueFinishedPatch(counterpart.id, next);
        applyLocally();
      }
    } finally {
      finishBusyRef.current = false;
    }
  };

  // Per-item "Reset progress" (issue #71): un-finish AND zero both mediums via
  // the batch progress endpoint (the plain finished-toggle above only flips the
  // flag, leaving currentTime/progress behind). DELIBERATE DIVERGENCE from the
  // finished-toggle's offline queue: a failed reset just reports (mirroring the
  // series-level reset in SeriesDetailScreen) — a destructive batch write
  // either lands or is surfaced, never silently deferred.
  //
  // KNOWN LIMITATION: the batch endpoint has never carried ebookLocation, so an
  // old CFI can survive the reset — the reader may resume its saved position
  // even though progress reads 0%. Fully clearing it would need
  // DELETE /api/me/progress/:id, which is unverified against the server
  // source; tracked as a follow-up.
  const resetBusyRef = React.useRef(false);
  const handleResetProgress = () => {
    if (!item?.id) return;
    // Never reset the item (or its counterpart) while it is the CURRENT
    // playback session: the player's per-tick sync writes progress
    // continuously, so the zeroing PATCH would be overwritten within seconds.
    const liveItemId = usePlaybackStore.getState().currentSession?.libraryItemId;
    if (liveItemId && (liveItemId === item.id || liveItemId === counterpart?.id)) {
      showAppDialog({
        title: "Can't reset while playing",
        message:
          "Stop playback first — resetting while playing would be immediately overwritten.",
      });
      return;
    }
    showAppDialog({
      title: "Reset progress?",
      message: `Progress on "${
        item?.media?.metadata?.title || "this book"
      }" will be returned to not started. This can't be undone.`,
      buttons: [
        { text: "Cancel", style: "cancel" },
        {
          text: "Reset",
          style: "destructive",
          onPress: async () => {
            if (resetBusyRef.current) return;
            resetBusyRef.current = true;
            try {
              const zeroed = (libraryItemId: string) => ({
                libraryItemId,
                isFinished: false,
                currentTime: 0,
                progress: 0,
                ebookProgress: 0,
              });
              const payloads = [zeroed(item.id)];
              // The fuzzy-matched sibling (see the counterpart mirroring in
              // handleToggleFinished) is the same book in the other format —
              // reset both together so they keep agreeing.
              if (counterpart?.id) payloads.push(zeroed(counterpart.id));
              // Drop queued offline writes for both ids FIRST: a stale queued
              // position/finished flag would flush AFTER the zeroing PATCH and
              // silently undo the reset.
              clearPendingWritesFor(item.id);
              if (counterpart?.id) clearPendingWritesFor(counterpart.id);
              await batchUpdateProgress(payloads);
              // Merge the zeroed entries into the global progress map so
              // badges/cards on already-rendered screens update without
              // waiting for the next /api/me (same shape as the
              // finished-toggle's applyLocally above).
              useUserStore.setState((s) => {
                const now = Date.now();
                const nextMap: Record<string, any> = { ...s.mediaProgress };
                for (const p of payloads) {
                  nextMap[p.libraryItemId] = {
                    ...s.mediaProgress[p.libraryItemId],
                    ...p,
                    updatedAt: now,
                  };
                }
                return { mediaProgress: nextMap };
              });
              useUserStore
                .getState()
                .loadMediaProgress()
                .catch(() => {});
              refetchItem();
              showSnackbar({ message: "Progress reset" });
            } catch (e: any) {
              showAppDialog({
                title: "Couldn't reset progress",
                message: e?.message || "Something went wrong. Please try again.",
              });
            } finally {
              resetBusyRef.current = false;
            }
          },
        },
      ],
    });
  };

  // Per-episode finished toggle. Episode progress is ITS OWN entry, keyed
  // `${itemId}-${episodeId}` (the /api/me convention) and PATCHed to the
  // episode-scoped endpoint — an item-level write would pollute the map with a
  // bogus podcast-item progress entry (see usePlaybackStore's per-tick note).
  const episodeBusyRef = React.useRef<Record<string, boolean>>({});
  const handleToggleEpisodeFinished = async (episode: any) => {
    const epId = episode?.id;
    if (!item?.id || !epId) return;
    // Key the busy flag by the item+episode composite (same as the endpoint and
    // progress map) — episode ids aren't unique across items, so keying by
    // episode id alone could block a different item's episode toggle.
    const key = `${item.id}-${epId}`;
    if (episodeBusyRef.current[key]) return;
    episodeBusyRef.current[key] = true;
    const next = !useUserStore.getState().mediaProgress[key]?.isFinished;
    const applyLocally = () =>
      useUserStore.setState((s) => ({
        mediaProgress: {
          ...s.mediaProgress,
          [key]: {
            ...s.mediaProgress[key],
            libraryItemId: item.id,
            episodeId: epId,
            isFinished: next,
            updatedAt: Date.now(),
          },
        },
      }));
    try {
      await api.patch(`/api/me/progress/${item.id}/${epId}`, { isFinished: next });
      applyLocally();
    } catch (err: any) {
      // As with the item-level toggle: a server rejection (has a response) must
      // NOT queue + poison the local map — only a genuine offline/network error
      // (no response) does.
      if (err?.response) {
        console.warn("[ItemDetail] Episode finished-toggle rejected by server:", err);
        showAppDialog({
          title: "Couldn't update",
          message: "The server rejected this change. Please try again.",
        });
      } else {
        // Offline — queue an episode-scoped PATCH (non-finite position drops the
        // audio fields but still delivers the isFinished toggle) and reflect it
        // locally; flushPendingSyncs delivers it when the server is reachable.
        console.warn("[ItemDetail] Episode finished-toggle failed — queueing:", err);
        queueProgressPatch(item.id, NaN, NaN, epId, { isFinished: next });
        applyLocally();
      }
    } finally {
      episodeBusyRef.current[key] = false;
    }
  };

  const handleDownloadPress = async () => {
    if (!item?.id) return;
    if (isDownloaded) {
      // A completed download must go through removeDownload (cancelDownload
      // only touches in-flight downloads and would silently no-op here).
      // Destructive — deletes the files — so confirm first.
      showAppDialog({
        title: "Delete download",
        message: `Remove "${metadata.title || "this book"}" from this device? You can download it again later.`,
        buttons: [
          { text: "Cancel", style: "cancel" },
          { text: "Delete", style: "destructive", onPress: () => removeDownload(item.id) },
        ],
      });
    } else if (isDownloading) {
      cancelDownload(item.id);
    } else if (isDownloadFailed) {
      // Resume from the failed state — completed parts are skipped.
      useDownloadStore.getState().retryDownload(item.id);
    } else {
      try {
        await downloader.downloadBook(item, serverAddress, token);
        refetchItem();
      } catch (err: any) {
        console.warn("[ItemDetail] Download failed:", err);
        // Surface the ACTUAL failure reason (e.g. "No space left on device",
        // an HTTP status) instead of a one-size-fits-all connectivity blurb.
        const reason = err?.message || err?.response?.data?.error;
        showAppDialog({
          title: "Download failed",
          message: reason
            ? `Couldn't start the download: ${reason}`
            : "Couldn't start the download. Check your connection and free space, then try again.",
        });
      }
    }
  };

  // Per-episode download control. Episodes are stored under the composite
  // `${itemId}::${episodeId}` key (episodeDownloadKey); the four states mirror
  // the book download button (download / cancel / retry / delete).
  const handleEpisodeDownloadPress = async (episode: any) => {
    if (!item?.id || !episode?.id) return;
    const key = episodeDownloadKey(item.id, episode.id);
    const active = useDownloadStore.getState().activeDownloads[key];
    const completed = useDownloadStore.getState().completedDownloads[key];
    if (completed && !active) {
      // A completed download must go through removeDownload (deletes files);
      // destructive, so confirm first.
      showAppDialog({
        title: "Delete download",
        message: `Remove "${episode.title || "this episode"}" from this device? You can download it again later.`,
        buttons: [
          { text: "Cancel", style: "cancel" },
          { text: "Delete", style: "destructive", onPress: () => removeDownload(key) },
        ],
      });
    } else if (active?.status === "downloading" || active?.status === "pending") {
      cancelDownload(key);
    } else if (active?.status === "failed") {
      useDownloadStore.getState().retryDownload(key);
    } else {
      try {
        await downloader.downloadEpisode(item, episode, serverAddress, token);
      } catch (err: any) {
        console.warn("[ItemDetail] Episode download failed:", err);
        // Surface the ACTUAL failure reason instead of a generic connectivity blurb.
        const reason = err?.message || err?.response?.data?.error;
        showAppDialog({
          title: "Download failed",
          message: reason
            ? `Couldn't start the download: ${reason}`
            : "Couldn't start the download. Check your connection and free space, then try again.",
        });
      }
    }
  };

  const refetchItem = async () => {
    if (!itemId) return;
    try {
      const response = await api.get(`/api/items/${itemId}?expanded=1&include=progress`);
      setItem(response.data);
    } catch (err) {
      console.warn("[ItemDetail] refetch failed", err);
    }
  };

  const serverAddress = serverConnectionConfig?.address?.replace(/\/$/, "") || "";
  const token = serverConnectionConfig?.token || "";

  const loadItem = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await api.get(`/api/items/${itemId}?expanded=1&include=progress`);
      setItem(response.data);
    } catch (err: any) {
      console.error("[ItemDetail] Failed to fetch item:", err);
      // No HTTP response means the request never reached the server (offline
      // or unreachable) — say so instead of a generic failure.
      if (err?.response) {
        setError("Failed to load item details.");
      } else {
        const downloaded = !!useDownloadStore.getState().completedDownloads[itemId];
        setError(
          downloaded
            ? "You're offline. This book is downloaded — you can keep listening from the Downloads tab."
            : "You're offline. Reconnect to load this item, or download books ahead of time to use them offline."
        );
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!itemId) {
      setError("No item ID provided.");
      setLoading(false);
      return;
    }
    loadItem();
  }, [itemId]);

  // SILENT refetch on navigation focus so edits made on pushed screens
  // (metadata editor, chapter editor, match apply) show on return — no
  // spinner over already-rendered content (refetchItem never sets loading).
  useEffect(() => {
    if (!itemId) return;
    const unsub = navigation?.addListener?.("focus", () => {
      refetchItem();
    });
    return () => unsub?.();
  }, [navigation, itemId]);

  // --- Server task activity for THIS item (encode/embed) --------------------
  // Poller subscription held only while focused (ServerAdminHub's focus/blur
  // handoff) and only for admins — the Tools rows are admin-gated anyway.
  const [tasks, setTasks] = useState<AbsTask[]>(() => getTasksSnapshot());
  useEffect(() => {
    if (!capabilities.isAdmin || !itemId) return;
    let unsub: (() => void) | null = subscribeTasks(setTasks);
    const focusUnsub = navigation?.addListener?.("focus", () => {
      if (!unsub) {
        setTasks(getTasksSnapshot());
        unsub = subscribeTasks(setTasks);
      }
    });
    const blurUnsub = navigation?.addListener?.("blur", () => {
      unsub?.();
      unsub = null;
    });
    return () => {
      unsub?.();
      focusUnsub?.();
      blurUnsub?.();
    };
  }, [navigation, capabilities.isAdmin, itemId]);

  // An UNFINISHED encode/embed task targeting this item — drives the
  // in-progress banner and disables the Tools rows (no double kickoff).
  const hasRunningItemTask = (fragment: string) =>
    tasks.some(
      (t) =>
        !t.isFinished &&
        typeof t.action === "string" &&
        t.action.includes(fragment) &&
        t.data?.libraryItemId === itemId
    );
  const encodeTaskRunning = hasRunningItemTask("encode");
  const embedTaskRunning = hasRunningItemTask("embed");
  const itemTaskRunning = encodeTaskRunning || embedTaskRunning;

  const metadata = item?.media?.metadata || {};
  // `ts` cache-busts on the item's updatedAt so a cover changed in the editor
  // actually re-renders here (expo-image would otherwise serve the old cached
  // bitmap for the same URI). coverSource() strips only the token from its
  // cacheKey, so a new ts is a new cache entry — exactly what a changed cover
  // needs.
  const coverBust = item?.updatedAt ? `&ts=${item.updatedAt}` : "";
  const coverUrl =
    itemId && serverAddress && token
      ? `${serverAddress}/api/items/${itemId}/cover?width=800&format=webp&token=${token}${coverBust}`
      : null;

  const description = stripHtml(metadata.description || "");
  const duration = item?.media?.duration || 0;
  // Audio and reading progress tracked separately — the player only writes
  // `progress`, the reader only writes `ebookProgress`, and on both-format
  // items neither may masquerade as the other.
  const audioProgressFraction = Math.max(0, Math.min(1, Number(progress?.progress || 0)));
  const ebookProgressFraction = Math.max(0, Math.min(1, Number(progress?.ebookProgress || 0)));
  // Headline % prefers audio, falling back to reading progress (ebook-only
  // items). Displayed value is clamped to 1–99 while in progress so a book
  // never reads "0%" just after starting or "100%" before it's finished;
  // finished always reads 100% (even when marked finished mid-way).
  const headlineFraction = audioProgressFraction > 0 ? audioProgressFraction : ebookProgressFraction;
  const progressPercent = isFinished
    ? 100
    : headlineFraction > 0
    ? Math.min(99, Math.max(1, Math.round(headlineFraction * 100)))
    : 0;
  const timeRemaining =
    progress && duration > 0 ? elapsedPretty(duration - (progress.currentTime || 0)) : "";

  // Per-format rows for the Your Progress card: Listening (headphones) and
  // Reading (book) each get their own icon, percent, and bar so the two kinds
  // of progress can never be confused. `isFinished` is ITEM-level in ABS; when
  // it was evidently set by the reader (ebook ≥99%) while the audio sits
  // mid-way, the audio row keeps showing its real remaining time.
  const readerSetFinished =
    ebookProgressFraction >= 0.99 && audioProgressFraction > 0 && audioProgressFraction < 0.99;
  const audioFinished = isFinished && !readerSetFinished && hasAudio(item);
  // An EXPLICIT mark-as-finished finishes the whole book — both rows. The one
  // exception stays the reader auto-finish (ebook hit 99% while audio is
  // mid-way), where the audio row keeps its real remaining time.
  const ebookFinished = ebookProgressFraction >= 0.99 || (isFinished && !readerSetFinished);
  const showAudioRow = hasAudio(item) && (audioProgressFraction > 0 || audioFinished);
  const showEbookRow = itemHasEbook(item) && (ebookProgressFraction > 0 || ebookFinished);
  const audioPct = audioFinished
    ? 100
    : Math.min(99, Math.max(1, Math.round(audioProgressFraction * 100)));
  const ebookPct = ebookFinished
    ? 100
    : Math.min(99, Math.max(1, Math.round(ebookProgressFraction * 100)));

  // Both progress rows are showing AND they disagree by a meaningful margin —
  // the trigger for the manual "Sync progress" action and the lock toggle's
  // "these have drifted" case. |Δ| >= 2 percentage points.
  const bothProgressRows = showAudioRow && showEbookRow;
  const progressDrifted = bothProgressRows && Math.abs(audioPct - ebookPct) >= 2;
  // Target for a sync/reconcile = the FURTHEST-along position (max fraction), so
  // neither medium is ever moved backward.
  const syncTargetFraction = Math.max(audioProgressFraction, ebookProgressFraction);
  const syncTargetPct = Math.max(audioPct, ebookPct);

  // Manual "Sync progress": reconcile both media to the furthest spot. Writes
  // BOTH — audio via a currentTime = fraction*duration patch, ebook via its
  // fraction (the exact page can't be repositioned from a fraction, so only the
  // ebook PERCENTAGE moves; the CFI is preserved). Offline-safe (patches queue).
  const handleSyncProgress = () => {
    if (!item?.id) return;
    showAppDialog({
      title: "Sync progress",
      message:
        `Listening ${audioPct}% · Reading ${ebookPct}%.\n\n` +
        `Bring both to the furthest spot (${syncTargetPct}%)? The ebook's exact ` +
        `page stays put — only its percentage moves.`,
      buttons: [
        { text: "Cancel", style: "cancel" },
        {
          text: `Sync to ${syncTargetPct}%`,
          onPress: () => {
            syncBothProgressFraction(item.id, syncTargetFraction, {
              duration,
              ebookLocation: progress?.ebookLocation || "",
            });
            showAppDialog({
              title: "Progress synced",
              message: `Listening and reading are now both at ${syncTargetPct}%.`,
            });
          },
        },
      ],
    });
  };

  // Lock toggle: persist the per-item link and, when turning it ON, reconcile
  // immediately (the focus effect below only runs on load/focus, not on this
  // in-place toggle press).
  const handleToggleLink = () => {
    if (!item?.id) return;
    const next = !isLinked;
    setProgressLinked(item.id, next);
    if (next && !isCurrentlyPlaying) {
      // Enabling the lock must NEVER silently mark an unstarted medium finished.
      // For a read-but-unlistened both-format book (ebook ~100%, audio ~0%) an
      // immediate furthest-wins reconcile would jump the untouched audiobook to
      // "finished". When one side hasn't been started (≈0) there is nothing to
      // link yet — skip the immediate reconcile; once BOTH sides have real
      // progress the boundary reconcile keeps them aligned. (reconcileLinkedProgress
      // itself also guards the destructive finish jump, so the focus-effect
      // re-run triggered by this toggle is safe too.)
      const LINK_MIN = 0.005;
      if (audioProgressFraction < LINK_MIN || ebookProgressFraction < LINK_MIN) return;
      reconcileLinkedProgress(item.id, {
        audioFraction: audioProgressFraction,
        ebookFraction: ebookProgressFraction,
        duration,
        ebookLocation: progress?.ebookLocation || "",
      });
    }
  };

  // --- Overflow (More actions): metadata / chapters / tools / zip / share /
  // history. Entries are capability-gated (utils/abs/capabilities) — the
  // server would 403 anyway, but a dead row is worse than a hidden one.

  // Kicks off the in-app streaming zip download (issue #68): the token rides
  // the Authorization header (never the url), progress paints the banner in
  // whole percents, and the finished file is offered via the share sheet.
  const startZipDownload = (target: { url: string; token: string }) => {
    const title = metadata.title || "Download";
    // Always unique per item: two items with the same (or empty) title must
    // never collide on one cache staging path mid-download.
    const filename = `${slugifyTitle(metadata.title || "") || "item"}_${itemId}.zip`;
    // Whole-percent throttle: a multi-GB zip fires the native progress
    // callback constantly — re-rendering the screen per callback would jank.
    let lastPct = -1;
    const handle = downloadFileByUrl({
      url: target.url,
      token: target.token,
      filename,
      expectedBytes: sizeBytes > 0 ? sizeBytes : undefined,
      notification: { id: `zip_${itemId}`, title },
      // The zip is transient share-sheet staging, deleted right after use —
      // a tappable "complete" notification would point at a gone file.
      clearNotificationOnComplete: true,
      onProgress: (bytesWritten, bytesExpected) => {
        // Servers may stream the zip without Content-Length — fall back to
        // the item's metadata size for the fraction. No total at all keeps
        // the banner indeterminate (never a stuck 0%).
        const total = bytesExpected > 0 ? bytesExpected : sizeBytes;
        if (!(total > 0)) return;
        const pct = Math.max(0, Math.min(100, Math.round((bytesWritten / total) * 100)));
        if (pct === lastPct) return;
        lastPct = pct;
        setZipDownload((cur) => (cur ? { ...cur, pct, totalBytes: total } : cur));
      },
    });
    zipHandleRef.current = handle;
    setZipDownload({ pct: 0, totalBytes: sizeBytes > 0 ? sizeBytes : 0, cancel: handle.cancel });

    handle.promise
      .then(async (res) => {
        zipHandleRef.current = null;
        if (!aliveRef.current) {
          // Screen unmounted while the download was settling — nobody is left
          // to share the staged file. Dispose of it (and any notification)
          // best-effort so multi-GB temp files don't linger in cache.
          if (res) {
            try {
              await FileSystem.deleteAsync(res.uri, { idempotent: true });
            } catch {}
            try {
              await downloadNotifications.clear(`zip_${itemId}`);
            } catch {}
          }
          return;
        }
        setZipDownload(null);
        if (!res) {
          // Cancelled (banner X / unmount race) — the handle already cleaned
          // up the partial file and notification.
          showSnackbar({ message: "Download cancelled" });
          return;
        }
        let shared = false;
        try {
          if (Sharing && (await Sharing.isAvailableAsync())) {
            await Sharing.shareAsync(res.uri, {
              dialogTitle: title,
              mimeType: "application/zip",
              UTI: "public.zip-archive",
            });
            shared = true;
          }
        } catch (e) {
          console.warn("[ItemDetail] Zip share failed:", e);
          shared = true; // downloaded + share attempted — don't fall through to the browser dialog
        } finally {
          // The zip lives in cache purely as share-sheet staging — dispose of
          // it in EVERY outcome, before any fallback dialog (the browser
          // handoff re-downloads; the local file is unused there). Best-effort.
          try {
            await FileSystem.deleteAsync(res.uri, { idempotent: true });
          } catch {}
        }
        if (shared) return;
        // No share sheet on this device: offer the legacy browser handoff.
        showAppDialog({
          title: "Downloaded",
          message:
            "The zip finished downloading, but this device can't open a save/share dialog for it. " +
            "You can hand the download to your browser instead. " +
            "The browser link includes your session token and downloads the file again.",
          buttons: [
            { text: "Close", style: "cancel" },
            {
              text: "Open in browser",
              onPress: () => {
                // FALLBACK ONLY: a browser can't send our Authorization
                // header, so this reconstructs the legacy tokened-URL form —
                // the one deliberate, user-chosen exception to the
                // header-only token rule (#68).
                Linking.openURL(`${target.url}?token=${target.token}`).catch(() => {});
              },
            },
          ],
        });
      })
      .catch((err: any) => {
        zipHandleRef.current = null;
        if (!aliveRef.current) return;
        setZipDownload(null);
        showAppDialog({
          title: "Couldn't download",
          message: err?.message || "Something went wrong. Please try again.",
        });
      });
  };

  const handleZipDownload = () => {
    if (zipDownload) return; // one zip at a time (the row is disabled too)
    const target = getItemZipDownloadTarget(itemId);
    setOverflowVisible(false);
    if (!target) {
      showAppDialog({
        title: "Can't download",
        message: "No server session available. Reconnect and try again.",
      });
      return;
    }
    showAppDialog({
      title: "Download all files",
      message:
        `Download this item's folder as a single zip${
          sizeBytes > 0 ? ` (~${formatBytes(sizeBytes)})` : ""
        }? ` +
        "It downloads right here in the app with progress, and you can save or share the file when it's done.",
      buttons: [
        { text: "Cancel", style: "cancel" },
        {
          text: "Download",
          onPress: () => startZipDownload(target),
        },
      ],
    });
  };

  const startEncodeM4b = () => {
    showAppDialog({
      title: "Encode as M4B",
      message:
        "The server merges the audio files into a single M4B with embedded metadata and chapters. " +
        "This modifies files on the server and can take a long time.",
      buttons: [
        { text: "Cancel", style: "cancel" },
        {
          text: "Start encode",
          // Server-side file mutation with no undo — destructive tier.
          style: "destructive",
          onPress: async () => {
            try {
              await encodeM4b(itemId);
              setToolsVisible(false);
              showSnackbar({ message: "M4B encode started" });
              // The watch may resolve via INFERRED completion (the task
              // vanished from a snapshot — ABS removes finished tasks): treat
              // that as generic success; failure copy comes ONLY from
              // isFailed/error.
              const task = await startTaskWatch(
                (t) =>
                  typeof t.action === "string" &&
                  t.action.includes("encode") &&
                  t.data?.libraryItemId === itemId
              );
              if (task) {
                showSnackbar({
                  message: task.isFailed
                    ? `Encode failed: ${task.error || "unknown error"}`
                    : "M4B encode finished",
                });
                if (!task.isFailed) refetchItem();
              }
            } catch (e: any) {
              showAppDialog({
                title: "Couldn't start encode",
                message: e?.message || "Something went wrong. Please try again.",
              });
            }
          },
        },
      ],
    });
  };

  const startEmbedMetadata = () => {
    showAppDialog({
      title: "Embed metadata",
      message:
        "The server writes the current metadata and cover into the audio files on disk. " +
        "A backup of the original tags is kept only if enabled on the server.",
      buttons: [
        { text: "Cancel", style: "cancel" },
        {
          text: "Embed",
          // Writes into the audio files on disk — destructive tier.
          style: "destructive",
          onPress: async () => {
            try {
              await embedMetadata(itemId);
              setToolsVisible(false);
              showSnackbar({ message: "Metadata embed started" });
              // Same inferred-completion contract as the encode watch above.
              const task = await startTaskWatch(
                (t) =>
                  typeof t.action === "string" &&
                  t.action.includes("embed") &&
                  t.data?.libraryItemId === itemId
              );
              if (task) {
                showSnackbar({
                  message: task.isFailed
                    ? `Embed failed: ${task.error || "unknown error"}`
                    : "Metadata embed finished",
                });
              }
            } catch (e: any) {
              showAppDialog({
                title: "Couldn't start embed",
                message: e?.message || "Something went wrong. Please try again.",
              });
            }
          },
        },
      ],
    });
  };

  const openShareSheet = () => {
    setOverflowVisible(false);
    setShareSlug((s) => s || slugifyTitle(item?.media?.metadata?.title || ""));
    setShareVisible(true);
  };

  const handleCreateShareLink = async () => {
    if (shareBusy) return;
    // Share links key on the MEDIA id (book.id), NOT the libraryItemId.
    const mediaItemId = item?.media?.id;
    const slug = shareSlug.trim();
    if (!mediaItemId || !slug) {
      showAppDialog({
        title: "Couldn't create link",
        message: !slug ? "Enter a slug for the link." : "This item can't be shared.",
      });
      return;
    }
    setShareBusy(true);
    try {
      const link = await createShareLink({
        slug,
        mediaItemId,
        mediaItemType: "book",
        // Numeric, 0 = never (the server rejects null).
        expiresAt: shareExpiryMs === 0 ? 0 : Date.now() + shareExpiryMs,
      });
      setShareLink(link);
      showSnackbar({ message: "Share link created" });
    } catch (e: any) {
      showAppDialog({
        title: "Couldn't create link",
        message: e?.message || "Something went wrong. Please try again.",
      });
    } finally {
      setShareBusy(false);
    }
  };

  const shareUrl = shareLink?.slug ? `${serverAddress}/share/${shareLink.slug}` : "";

  const handleCopyShareLink = () => {
    if (!shareUrl) return;
    Clipboard.setStringAsync(shareUrl).catch(() => {});
    showSnackbar({ message: "Link copied" });
  };

  const handleDeleteShareLink = () => {
    if (!shareLink?.id) return;
    showAppDialog({
      title: "Delete share link",
      message: "Anyone with the link will immediately lose access.",
      buttons: [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              await deleteShareLink(shareLink.id);
              setShareLink(null);
              showSnackbar({ message: "Share link deleted" });
            } catch (e: any) {
              showAppDialog({
                title: "Couldn't delete link",
                message: e?.message || "Something went wrong. Please try again.",
              });
            }
          },
        },
      ],
    });
  };

  const chapters = item?.media?.chapters || [];
  const hasChapters = chapters.length > 0;
  const isCurrentlyPlaying = currentSession?.libraryItemId === itemId;
  // While this item is the loaded session, the chapter list must be the
  // STORE's normalized array (sorted/filtered/coverage-extended) — the raw
  // item list can differ on badly-tagged books, and indexing the store's
  // seekToChapter with a raw-list index seeked/highlighted the wrong chapter.
  const playerChapters = usePlaybackStore((s) => s.chapters);
  const displayChapters =
    isCurrentlyPlaying && playerChapters.length ? playerChapters : chapters;

  // LOCK reconciliation at the ItemDetail transition boundary: on load AND on
  // every focus (returning from the reader/player), pull the lagging medium up
  // to the furthest position when this item is linked. FRACTION-ONLY — see
  // reconcileLinkedProgress. Skipped while THIS item is the live audio session
  // (the 1s tick owns the audio position; that session reconciles when it
  // CLOSES instead — see usePlaybackStore). No-op unless locked, so it's inert
  // for every audio-only / ebook-only / unlinked book.
  useEffect(() => {
    if (!itemId) return;
    const run = () => {
      if (usePlaybackStore.getState().currentSession?.libraryItemId === itemId) return;
      // Read the freshest progress from the store (the reader/player wrote it),
      // falling back to the loaded item's snapshot on a cold direct-open.
      const p =
        useUserStore.getState().mediaProgress[itemId] || item?.userMediaProgress || {};
      reconcileLinkedProgress(itemId, {
        audioFraction: Number(p.progress) || 0,
        ebookFraction: Number(p.ebookProgress) || 0,
        duration,
        ebookLocation: p.ebookLocation || "",
      });
    };
    run();
    const unsub = navigation?.addListener?.("focus", run);
    return () => unsub?.();
  }, [itemId, isLinked, duration, item?.id]);

  // What media this exact item has, and what a matched sibling item supplies.
  // Podcasts carry episodes (not tracks), so hasAudio() would be false — treat
  // them as playable and never fuzzy-match them against books.
  const isPodcastItem = item?.mediaType === "podcast";
  const selfHasAudio = isPodcastItem || hasAudio(item);
  const selfHasEbook = itemHasEbook(item);
  const selfEbookFormat = getEbookFormat(item);

  // A separate library item that is the same book in the other format (ABS often
  // stores the ebook and audiobook as two items). Matched fuzzily by title+author.
  const [counterpart, setCounterpart] = useState<any>(null);
  useEffect(() => {
    if (!item || item.mediaType === "podcast") { setCounterpart(null); return; }
    // If this item already has both audio and ebook, no sibling is needed.
    if (selfHasAudio && selfHasEbook) { setCounterpart(null); return; }
    const libraryId = item.libraryId;
    const title = item?.media?.metadata?.title;
    if (!libraryId || !title) { setCounterpart(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const r = await api.get(
          `/api/libraries/${libraryId}/search?q=${encodeURIComponent(String(title).slice(0, 60))}&limit=10`
        );
        const books = (r.data?.book || []).map((b: any) => b.libraryItem).filter(Boolean);
        const match = bestCounterpart(item, books);
        // Only keep the match if it supplies the format this item lacks.
        const useful = match && (selfHasAudio ? itemHasEbook(match) : hasAudio(match) || itemHasEbook(match));
        if (!cancelled) setCounterpart(useful ? match : null);
      } catch (e) {
        if (!cancelled) setCounterpart(null);
      }
    })();
    return () => { cancelled = true; };
  }, [item?.id]);

  // Resolve where to read/play from — this item, or its matched sibling.
  const ebookSource = selfHasEbook
    ? { id: item.id, format: selfEbookFormat }
    : counterpart && itemHasEbook(counterpart)
    ? { id: counterpart.id, format: getEbookFormat(counterpart) }
    : null;
  const audioCounterpartId =
    !selfHasAudio && counterpart && hasAudio(counterpart) ? counterpart.id : null;
  const canRead = !!ebookSource;
  const [, setLastInteractionState] = useState(() => {
    return storage.getString(`last_interaction_${itemId}`) || (canRead && !selfHasAudio ? "read" : "listen");
  });

  const handleSeekToChapter = async (index: number) => {
    // The seek path must match the SAME gate that chose `displayChapters`. Index
    // seeking is only valid when the modal is showing the STORE's chapter array
    // (isCurrentlyPlaying AND the store actually has chapters). If this item is
    // the loaded session but the store list is empty/out of sync, the modal fell
    // back to the raw item list — indexing seekToChapter() into the empty store
    // array silently no-ops, so seek by the tapped chapter's TIME instead.
    const usingStoreChapters = isCurrentlyPlaying && playerChapters.length > 0;
    if (usingStoreChapters) {
      // displayChapters IS the store array here — the index aligns.
      await seekToChapter(index);
      return;
    }
    // Seek by the tapped chapter's TIME (its raw-list index may not survive
    // normalization into the store array).
    const target = Number(displayChapters[index]?.start) || 0;
    if (isCurrentlyPlaying) {
      // Already the loaded session — just seek; don't churn a fresh /play.
      usePlaybackStore
        .getState()
        .seek(target)
        .catch(() => {});
      return;
    }
    // Not loaded yet: start playback, then seek once the player is set up.
    setStarting(true);
    const ok = await startPlayback(itemId);
    setStarting(false);
    if (ok) {
      // Wait a brief moment for track player setup before seeking. The
      // timer callback's promise is unobserved — a rejecting seek (player
      // torn down in the gap) must not become an unhandled rejection.
      setTimeout(() => {
        usePlaybackStore
          .getState()
          .seek(target)
          .catch(() => {});
      }, 300);
    }
  };

  // Metadata sources (arrays from expanded API response).
  const authors: { id: string; name: string }[] = metadata.authors || [];
  const narrators: string[] = metadata.narrators || [];
  const seriesList: { id: string; name: string; sequence?: string; text: string }[] = (
    metadata.series || []
  ).map((se: any) => ({ ...se, text: se.sequence ? `${se.name} #${se.sequence}` : se.name }));
  const genres: string[] = metadata.genres || [];
  const tags: string[] = item?.media?.tags || [];
  const publishedYear: string | undefined = metadata.publishedYear;
  const publisher: string | undefined = metadata.publisher;
  const language: string | undefined = metadata.language;
  // Total media size in bytes (expanded responses carry it on the item).
  const sizeBytes: number = Number(item?.size || item?.media?.size || 0);

  // Podcast episodes, most recent first. Shown capped so a 500-episode feed
  // doesn't render an unbounded list inside this ScrollView.
  const EPISODE_CAP = 100;
  // Render cap only (the array is already in memory) — "Show more" pages in
  // the next batch; a hard cap left episodes 101+ of large feeds unreachable.
  const [episodeLimit, setEpisodeLimit] = useState(EPISODE_CAP);
  // Episode list filter/sort — All / Unplayed / In-Progress against the shared
  // per-episode progress map, plus a newest↔oldest toggle.
  const [episodeFilter, setEpisodeFilter] = useState<"all" | "unplayed" | "in-progress">("all");
  const [episodeSort, setEpisodeSort] = useState<"newest" | "oldest">("newest");
  const episodes: any[] = React.useMemo(() => {
    if (!isPodcastItem) return [];
    // filter(Boolean): a null entry in the feed-derived episodes array threw
    // in this sort and took the whole screen down.
    const eps = (Array.isArray(item?.media?.episodes) ? item.media.episodes : []).filter(Boolean);
    eps.sort((a: any, b: any) => Number(b.publishedAt || 0) - Number(a.publishedAt || 0));
    return eps;
  }, [isPodcastItem, item]);

  // Filtered/sorted view of `episodes` (which is already newest-first). The
  // header count still reflects the full total; only the rendered list changes.
  const displayEpisodes: any[] = React.useMemo(() => {
    const decorated = episodes.map((ep: any) => {
      const p = progressMap[`${itemId}-${ep.id}`];
      const finished = !!p?.isFinished;
      const fraction = Math.max(0, Math.min(1, Number(p?.progress || 0)));
      return { ep, finished, fraction };
    });
    const filtered = decorated.filter(({ finished, fraction }) => {
      if (episodeFilter === "unplayed") return !finished && fraction === 0;
      if (episodeFilter === "in-progress") return !finished && fraction > 0;
      return true;
    });
    const ordered = episodeSort === "newest" ? filtered : [...filtered].reverse();
    return ordered.map((d) => d.ep);
  }, [episodes, progressMap, itemId, episodeFilter, episodeSort]);

  const EpisodeFilterChip = ({
    label,
    value,
  }: {
    label: string;
    value: "all" | "unplayed" | "in-progress";
  }) => {
    const active = episodeFilter === value;
    return (
      <Pressable
        onPress={() => setEpisodeFilter(value)}
        accessibilityRole="button"
        accessibilityState={{ selected: active }}
        accessibilityLabel={`Filter: ${label}`}
        style={{
          paddingHorizontal: 14,
          height: 34,
          borderRadius: 17,
          alignItems: "center",
          justifyContent: "center",
          marginRight: 8,
          backgroundColor: active ? colors.secondaryContainer : "transparent",
          borderWidth: 1,
          borderColor: active ? colors.secondaryContainer : colors.outlineVariant,
        }}
      >
        <Text
          style={{
            color: active ? colors.onSecondaryContainer : colors.onSurfaceVariant,
            fontSize: 13,
            fontWeight: "600",
          }}
        >
          {label}
        </Text>
      </Pressable>
    );
  };

  const playEpisode = async (episode: any) => {
    if (!episode?.id || startingEpisodeId || starting) return;
    // Already the loaded session: resume/expand instead of churning a fresh
    // /play (mirrors startAudio). The row used to be DISABLED in this state,
    // so a paused episode had no resume affordance on its own page.
    const st = usePlaybackStore.getState();
    if (st.currentSession?.libraryItemId === itemId && st.currentSession?.episodeId === episode.id) {
      if (!st.isPlaying) st.play().catch(() => {});
      st.setPlayerExpanded(true);
      return;
    }
    setStartingEpisodeId(episode.id);
    try {
      await startPlayback(itemId, episode.id);
    } finally {
      setStartingEpisodeId(null);
    }
  };

  // Series subtitle e.g. "Expeditionary Force, Book 10".
  const seriesSubtitle =
    seriesList.length > 0
      ? seriesList[0].sequence
        ? `${seriesList[0].name}, Book ${seriesList[0].sequence}`
        : seriesList[0].name
      : metadata.subtitle || "";

  // Cover sizing — centered, ~68% of screen width, capped.
  const coverWidth = Math.min(Math.round(screenWidth * 0.68), 280);

  const startAudio = async (id: string) => {
    if (!item || starting) return;
    // Already the loaded session: don't churn a fresh /play + full queue
    // reset (audible hiccup, server session churn, and a possible ~15s
    // backward jump to the last-synced position) — just resume and expand.
    const st = usePlaybackStore.getState();
    if (st.currentSession?.libraryItemId === id) {
      if (!st.isPlaying) st.play().catch(() => {});
      st.setPlayerExpanded(true);
      return;
    }
    setStarting(true);
    storage.set(`last_interaction_${itemId}`, "listen");
    setLastInteractionState("listen");
    await startPlayback(id);
    setStarting(false);
  };
  const handlePlay = () => startAudio(itemId);

  const hasAudioMedia = selfHasAudio || !!audioCounterpartId;
  // A podcast with no episodes has a Play button (selfHasAudio is forced true
  // for podcasts) that computes no episode and no-ops — disable it and show an
  // empty state instead of a prominent button that does nothing.
  const isPodcastEmpty = isPodcastItem && episodes.length === 0;
  const onPlayPress = () => {
    if (isPodcastItem) {
      // A podcast ITEM has no playable tracks — /play without an episodeId
      // returns an empty session and the tap silently did nothing. Play the
      // most recently published unfinished episode (or the latest).
      const nextEpisode =
        episodes.find((ep: any) => {
          const p = progressMap[`${itemId}-${ep.id}`];
          return !p?.isFinished;
        }) || episodes[0];
      // playEpisode drives startingEpisodeId (its own guard reads `starting`,
      // so don't set that here).
      if (nextEpisode) playEpisode(nextEpisode);
      return;
    }
    if (selfHasAudio) {
      handlePlay();
    } else if (audioCounterpartId) {
      startAudio(audioCounterpartId);
    }
  };

  const openReader = () => {
    if (!ebookSource) return;
    storage.set(`last_interaction_${itemId}`, "read");
    setLastInteractionState("read");
    // Linked catch-up (listening ahead of reading → seek the reader forward) is
    // now handled BY THE READER on its 'ready' message, keyed off its TRUE
    // rendered page position. We deliberately do NOT pass an initialFraction
    // here: the ItemDetail focus-effect / audio-close reconcile bumps this
    // item's ebookProgress PERCENTAGE up to the audio fraction WITHOUT moving
    // the CFI, so a percentage-based gate here was self-defeating (by tap time
    // ebook% == audio%, the gate was false, and the reader opened at the stale
    // CFI). Letting the reader be the single source of truth also fixes every
    // OTHER entry point (Bookshelf/Library/Series/Playlist) at once. The
    // explicit "Read from here" jump still flows through PlayerBottomSheet's
    // own initialFraction, which the reader applies unconditionally.
    navigation.navigate("Reader", {
      itemId: ebookSource.id,
      ebookFormat: ebookSource.format,
      title: metadata.title,
    });
  };

  // Cross-book "Up Next" queue: the playable audio item's id (this item, or its
  // audio-only counterpart). Podcasts are excluded — the queue auto-advances
  // whole books, and each podcast episode already tracks its own progress. The
  // queue toggle itself now lives in the "Add to…" sheet (AddToListModal); this
  // just resolves which id that sheet should queue.
  const queueItemId = selfHasAudio ? item?.id : audioCounterpartId;
  // Cover url used both for the sheet's queue entry and (elsewhere) the header.
  const queueCoverUrl =
    queueItemId && serverAddress && token
      ? `${serverAddress}/api/items/${queueItemId}/cover?width=400&format=webp&token=${token}`
      : undefined;

  /** Two-column metadata row: CAPS grey label (left) + value (right, links green+underline). */
  const MetaRow = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <View style={{ flexDirection: "row", paddingVertical: 6 }}>
      <Text
        style={{
          color: colors.onSurfaceVariant,
          fontSize: 12,
          fontWeight: "600",
          letterSpacing: 0.6,
          width: 118,
          textTransform: "uppercase",
        }}
      >
        {label}
      </Text>
      <View style={{ flex: 1, flexDirection: "row", flexWrap: "wrap", alignItems: "center" }}>{children}</View>
    </View>
  );

  // Auto-dismiss timers for the send-result sheet and the format-request
  // burst. Kept in refs so unmount, a manual sheet close, or a retry can
  // cancel them — an orphaned timer would setState on an unmounted screen or
  // yank a fresh attempt's sheet shut with stale state.
  const sendTimersRef = React.useRef<ReturnType<typeof setTimeout>[]>([]);
  const formatTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearSendTimers = () => {
    sendTimersRef.current.forEach(clearTimeout);
    sendTimersRef.current = [];
  };
  useEffect(() => {
    return () => {
      clearSendTimers();
      if (formatTimerRef.current) clearTimeout(formatTimerRef.current);
    };
  }, []);

  const sendEbookToDevice = async (deviceName: string) => {
    setSendingTo(deviceName);
    try {
      // Same endpoint the original app used; the server emails the ebook file
      // to the configured device (Kindle etc.).
      await api.post("/api/emails/send-ebook-to-device", {
        libraryItemId: itemId,
        deviceName,
      });
      if (!aliveRef.current) return;
      // In-sheet M3 result moment instead of a system alert; the sheet
      // dismisses itself after the success burst plays.
      setSendResult({ ok: true, device: deviceName });
      // A previous attempt's pending dismissal must not close this fresh
      // result early — drop it before re-arming.
      clearSendTimers();
      sendTimersRef.current.push(
        setTimeout(() => {
          setSendToVisible(false);
          sendTimersRef.current.push(setTimeout(() => setSendResult(null), 400)); // after exit animation
        }, 1600)
      );
    } catch (e) {
      console.error("[ItemDetail] send ebook failed", e);
      if (aliveRef.current) setSendResult({ ok: false, device: deviceName });
    } finally {
      if (aliveRef.current) setSendingTo(null);
    }
  };

  const closeSendSheet = () => {
    // Manual close cancels the pending auto-dismiss, which would otherwise
    // fire into the sheet's next open.
    clearSendTimers();
    setSendToVisible(false);
    setSendResult(null);
  };

  // The book exists in one format; ask ReadMeABook for the other. Ebook
  // requests ride RMAB's fetch-ebook pipeline (JWT-only, needs an ebook
  // source configured); audiobook requests are ordinary RMAB requests.
  const requestOtherFormat = async (kind: "ebook" | "audiobook") => {
    // In-flight guard: a rapid double-tap must not fire two RMAB requests. The
    // button is also disabled while working, but guard here too so a queued
    // second press (or a programmatic call) can't slip a duplicate through.
    if (formatReq?.state === "working") return;
    // A pending burst-dismiss from a previous request would null this fresh
    // "working" state mid-flight — cancel it before re-arming.
    if (formatTimerRef.current) clearTimeout(formatTimerRef.current);
    setFormatReq({ kind, state: "working" });
    try {
      const md = item?.media?.metadata || {};
      const title = md.title;
      const author = md.authorName;
      if (!title) throw new Error("Missing book metadata");
      let asin: string | null = md.asin || null;
      if (!asin) {
        const { audibleFindBookAsin } = require("../utils/audible");
        asin = await audibleFindBookAsin(title, author);
      }
      if (!asin) throw new Error("Couldn't match this book on Audible");
      const rmab = require("../utils/rmab");
      if (kind === "ebook") {
        await rmab.requestEbookForAsin(asin);
      } else {
        // RMAB's schema requires author — degrade to a placeholder rather
        // than a guaranteed 400 for items missing authorName.
        await rmab.createRequest({
          asin,
          title,
          author: author || "Unknown",
          narrator: (md.narrators || [])[0],
        });
      }
      // Keep the shared requested-state in sync so discovery surfaces flip
      // their chips for this ASIN too.
      useRmabStore.getState().noteRequestStatus(asin, "pending");
      if (!aliveRef.current) return;
      setFormatReq({ kind, state: "ok" });
      formatTimerRef.current = setTimeout(() => setFormatReq(null), 1800);
    } catch (e: any) {
      if (!aliveRef.current) return;
      const serverMsg = e?.response?.data?.error;
      const already = ["AlreadyAvailable", "DuplicateRequest", "BeingProcessed"].includes(serverMsg);
      setFormatReq({
        kind,
        state: already ? "ok" : "fail",
        msg: already
          ? "Already requested"
          : serverMsg || e?.message || "Request failed",
      });
      if (already) formatTimerRef.current = setTimeout(() => setFormatReq(null), 1800);
    }
  };

  /** Green underlined link chip inside a metadata value. */
  const Link = ({ text, onPress }: { text: string; onPress?: () => void }) => (
    // hitSlop lifts the effective target toward 48dp — these chips are the
    // page's main navigation but render as ~18dp-tall text.
    <Pressable
      onPress={onPress}
      hitSlop={{ top: 12, bottom: 12, left: 4, right: 4 }}
      accessibilityRole="link"
      accessibilityLabel={text}
    >
      <Text
        style={{
          color: colors.primary,
          fontSize: 14,
          textDecorationLine: "underline",
        }}
      >
        {text}
      </Text>
    </Pressable>
  );

  /** Plain (non-link) metadata value. */
  const Value = ({ text }: { text: string }) => (
    <Text style={{ color: colors.onSurface, fontSize: 14 }}>{text}</Text>
  );

  /** Comma-joined list of links. */
  const LinkList = ({ items }: { items: { key: string; text: string; onPress?: () => void }[] }) => (
    <>
      {items.map((it, i) => (
        <React.Fragment key={it.key}>
          <Link text={it.text} onPress={it.onPress} />
          {i < items.length - 1 ? (
            <Text style={{ color: colors.onSurface, fontSize: 14 }}>, </Text>
          ) : null}
        </React.Fragment>
      ))}
    </>
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }} edges={["top", "left", "right"]}>
      <TopAppBar navigation={navigation} showBack title={metadata.title || "Book Details"} />

      {loading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : error ? (
        <ErrorState
          message={error}
          onRetry={itemId ? loadItem : undefined}
          style={{ flex: 1 }}
        />
      ) : item ? (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: hasSession ? 120 : 48 }}>
          {/* Centered cover with progress bar on its bottom edge */}
          <View style={{ alignItems: "center", paddingTop: 20 }}>
            <View
              style={{
                width: coverWidth,
                height: coverWidth,
                borderRadius: 16,
                overflow: "hidden",
                backgroundColor: colors.surfaceContainerHigh,
                shadowColor: "#000",
                shadowOffset: { width: 0, height: 6 },
                shadowOpacity: 0.22,
                shadowRadius: 12,
                elevation: 8,
              }}
            >
              {coverUrl ? (
                <Image source={coverSource(coverUrl)} style={{ width: coverWidth, height: coverWidth }} contentFit="cover" />
              ) : (
                <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
                  <Icon name="book" size={64} color={colors.onSurfaceVariant} />
                </View>
              )}
              {/* Thin pine-green progress bar along the cover's bottom edge.
                  Finished renders as a full-width tertiary bar (progressPercent
                  is forced to 100 above, even when marked finished mid-way). */}
              {progressPercent > 0 ? (
                <View
                  style={{
                    position: "absolute",
                    bottom: 0,
                    left: 0,
                    height: 6,
                    width: `${progressPercent}%`,
                    backgroundColor: isFinished ? colors.tertiary : colors.primary,
                    borderTopRightRadius: 3,
                  }}
                />
              ) : null}

              {/* "Want to Read" / favorite toggle, overlaid on the cover's
                  top-right corner (a device-local overlay — ABS has no server
                  favorites flag). A translucent scrim keeps the heart legible
                  over any cover art. Moved here off the action row to declutter. */}
              <Pressable
                onPress={() => item?.id && toggleFavorite(item.id)}
                accessibilityRole="button"
                accessibilityLabel={isFavorite ? "Remove from Want to Read" : "Add to Want to Read"}
                accessibilityState={{ selected: isFavorite }}
                hitSlop={8}
                android_ripple={{
                  color: withAlpha(colors.onPrimaryContainer, 0.2),
                  radius: 22,
                }}
                style={{
                  position: "absolute",
                  top: 8,
                  right: 8,
                  width: 40,
                  height: 40,
                  borderRadius: 20,
                  overflow: "hidden",
                  alignItems: "center",
                  justifyContent: "center",
                  // Translucent scrim keeps the heart legible over any art
                  // (withAlpha only rewrites rgb() strings, so use a literal).
                  backgroundColor: isFavorite ? colors.primaryContainer : "rgba(0,0,0,0.42)",
                }}
              >
                <Icon
                  name="heart"
                  size={22}
                  color={isFavorite ? colors.onPrimaryContainer : "#FFFFFF"}
                  style={{ opacity: isFavorite ? 1 : 0.95 }}
                />
              </Pressable>
            </View>
          </View>

          {/* Title + series subtitle (centered) */}
          <View style={{ paddingHorizontal: 20, marginTop: 20, alignItems: "center" }}>
            <Text style={{ color: colors.onSurface, fontSize: 25, fontFamily: "serif", fontWeight: "700", lineHeight: 32, textAlign: "center" }}>
              {metadata.title || "Untitled"}
            </Text>
            {seriesSubtitle ? (
              <Text style={{ color: colors.onSurfaceVariant, fontSize: 16, marginTop: 6, textAlign: "center" }}>
                {seriesSubtitle}
              </Text>
            ) : null}
          </View>

          {/* Persistent in-progress banner while the server runs an encode/
              embed task against THIS item (plan §G6) — otherwise a long file
              mutation is invisible outside a transient snackbar. Also drives
              the disabled Tools rows below (no double kickoff). */}
          {itemTaskRunning ? (
            <View style={{ paddingHorizontal: 20, marginTop: 16 }} accessibilityLiveRegion="polite">
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  backgroundColor: colors.tertiaryContainer,
                  borderRadius: 12,
                  paddingHorizontal: 14,
                  paddingVertical: 10,
                }}
              >
                <ActivityIndicator size="small" color={colors.onTertiaryContainer} />
                <Text
                  style={{
                    flex: 1,
                    color: colors.onTertiaryContainer,
                    fontSize: 14,
                    fontWeight: "600",
                    marginLeft: 10,
                  }}
                >
                  {encodeTaskRunning ? "Encoding in progress…" : "Embedding metadata…"}
                </Text>
              </View>
            </View>
          ) : null}

          {/* Persistent in-app zip download banner (issue #68) — mirrors the
              encode/embed banner above, plus a thin determinate bar and a
              cancel affordance (the download survives leaving this scroll
              position, so a transient snackbar wouldn't do). */}
          {zipDownload ? (
            <View style={{ paddingHorizontal: 20, marginTop: 16 }}>
              <View
                style={{
                  backgroundColor: colors.tertiaryContainer,
                  borderRadius: 12,
                  paddingHorizontal: 14,
                  paddingVertical: 10,
                }}
              >
                {/* STATIC live-region status, announced once when the banner
                    appears. The live region must never sit on the per-percent
                    text — screen readers would announce every whole percent.
                    The moving value is exposed via the progressbar's
                    accessibilityValue instead. */}
                <Text
                  accessibilityLiveRegion="polite"
                  style={{ position: "absolute", width: 1, height: 1, opacity: 0 }}
                >
                  Downloading zip
                </Text>
                <View style={{ flexDirection: "row", alignItems: "center" }}>
                  <Text
                    style={{
                      flex: 1,
                      color: colors.onTertiaryContainer,
                      fontSize: 14,
                      fontWeight: "600",
                    }}
                  >
                    {/* ONE total drives both the percent and the byte label
                        (zipDownload.totalBytes — Content-Length when known).
                        No total at all → indeterminate copy, never a stuck 0%. */}
                    {zipDownload.totalBytes > 0
                      ? `Downloading zip… ${zipDownload.pct}% of ${formatBytes(
                          zipDownload.totalBytes
                        )}`
                      : "Downloading zip…"}
                  </Text>
                  <Pressable
                    onPress={() => {
                      zipDownload.cancel();
                    }}
                    accessibilityRole="button"
                    accessibilityLabel="Cancel zip download"
                    // 18dp glyph + 14dp slop per side = 46dp target (≥44dp).
                    hitSlop={14}
                    style={{ marginLeft: 10 }}
                  >
                    <Icon name="close" size={18} color={colors.onTertiaryContainer} />
                  </Pressable>
                </View>
                {/* Determinate bar only when a total is known — an indeterminate
                    download hides the bar rather than pinning it at 0%. */}
                {zipDownload.totalBytes > 0 ? (
                  <View
                    accessible
                    accessibilityRole="progressbar"
                    accessibilityValue={{ min: 0, max: 100, now: zipDownload.pct }}
                    style={{
                      height: 4,
                      borderRadius: 2,
                      marginTop: 8,
                      overflow: "hidden",
                      backgroundColor: withAlpha(colors.onTertiaryContainer, 0.2),
                    }}
                  >
                    <View
                      testID="zip-progress-fill"
                      style={{
                        width: `${zipDownload.pct}%`,
                        height: 4,
                        borderRadius: 2,
                        backgroundColor: colors.onTertiaryContainer,
                      }}
                    />
                  </View>
                ) : null}
              </View>
            </View>
          ) : null}

          {/* Action row. Primary is Play for audiobooks; for an ebook-only item
              it becomes Read (in the play button's place). A matched sibling in
              the other format adds the secondary Play/Read button. */}
          <View style={{ flexDirection: "row", paddingHorizontal: 20, marginTop: 18, alignItems: "stretch" }}>
            {hasAudioMedia ? (
              <Pressable
                onPress={onPlayPress}
                disabled={starting || isPodcastEmpty}
                accessibilityRole="button"
                accessibilityState={{ disabled: starting || isPodcastEmpty, busy: starting }}
                accessibilityLabel={!isFinished && audioProgressFraction > 0 ? "Continue listening" : "Play"}
                android_ripple={{ color: withAlpha(colors.onPrimary, 0.2) }}
                style={{
                  flex: 1,
                  overflow: "hidden",
                  backgroundColor: colors.primary,
                  height: 52,
                  borderRadius: 26,
                  alignItems: "center",
                  justifyContent: "center",
                  flexDirection: "row",
                  // Keep the label off the pill's rounded edge ("Continue" is
                  // wide when sharing the row with a Read button).
                  paddingHorizontal: 16,
                  marginRight: canRead ? 8 : 0,
                  opacity: starting || isPodcastEmpty ? 0.6 : 1,
                }}
              >
                {starting ? (
                  <ActivityIndicator size="small" color={colors.onPrimary} />
                ) : (
                  <>
                    <Icon name="play" size={22} color={colors.onPrimary} />
                    <Text numberOfLines={1} style={{ color: colors.onPrimary, fontSize: 16, fontWeight: "600", marginLeft: 8 }}>
                      {/* "Continue" only when there's AUDIO progress — reading
                          progress alone must not relabel the play button on a
                          both-format item. */}
                      {!isFinished && audioProgressFraction > 0 ? "Continue" : "Play"}
                    </Text>
                  </>
                )}
              </Pressable>
            ) : null}

            {canRead ? (
              <Pressable
                onPress={openReader}
                accessibilityRole="button"
                accessibilityLabel="Read ebook"
                android_ripple={{
                  color: withAlpha(hasAudioMedia ? colors.onSecondaryContainer : colors.onPrimary, 0.2),
                }}
                style={{
                  flex: 1,
                  overflow: "hidden",
                  backgroundColor: hasAudioMedia ? colors.secondaryContainer : colors.primary,
                  height: 52,
                  borderRadius: 26,
                  alignItems: "center",
                  justifyContent: "center",
                  flexDirection: "row",
                  paddingHorizontal: 16,
                  marginLeft: hasAudioMedia ? 8 : 0,
                }}
              >
                <Icon name="book" size={22} color={hasAudioMedia ? colors.onSecondaryContainer : colors.onPrimary} />
                <Text style={{ color: hasAudioMedia ? colors.onSecondaryContainer : colors.onPrimary, fontSize: 16, fontWeight: "600", marginLeft: 8 }}>
                  Read
                </Text>
              </Pressable>
            ) : null}

            {!hasAudioMedia && !canRead ? (
              <View
                style={{
                  flex: 1, height: 52, borderRadius: 26, backgroundColor: colors.surfaceContainer,
                  alignItems: "center", justifyContent: "center",
                }}
              >
                <Text style={{ color: colors.onSurfaceVariant, fontSize: 14 }}>No playable media</Text>
              </View>
            ) : null}
          </View>

          {/* Secondary actions on their own row — sharing the primary line
              squeezed Play/Read into slivers once all four icons showed. Wraps
              to additional lines so all 7-8 circular actions stay reachable on
              narrow screens (they used to overflow off the right edge). */}
          <View
            testID="detail-action-row"
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              justifyContent: "center",
              paddingHorizontal: 20,
              marginTop: 12,
              columnGap: 12,
              rowGap: 12,
            }}
          >
            {/* Download Button — for items with their own audio or ebook.
                Hidden for podcasts: the downloader handles book tracks, not
                episodes, so the button would silently no-op there. */}
            {(selfHasAudio || selfHasEbook) && !isPodcastItem ? (
              <Pressable
                onPress={handleDownloadPress}
                accessibilityRole="button"
                accessibilityLabel={
                  isDownloaded
                    ? "Delete download"
                    : isDownloading
                    ? `Cancel download, ${downloadPct} percent complete`
                    : isDownloadFailed
                    ? "Download failed, tap to retry"
                    : "Download"
                }
                android_ripple={{
                  color: withAlpha(
                    isDownloaded || isDownloadFailed ? colors.error : colors.onSecondaryContainer,
                    0.15
                  ),
                }}
                style={{
                  width: 52,
                  height: 52,
                  borderRadius: 26,
                  overflow: "hidden",
                  backgroundColor:
                    isDownloaded || isDownloadFailed
                      ? withAlpha(colors.error, 0.1)
                      : colors.secondaryContainer,
                  alignItems: "center",
                  justifyContent: "center",
                  borderWidth: isDownloaded || isDownloadFailed ? 1 : 0,
                  borderColor: isDownloaded || isDownloadFailed ? colors.error : "transparent",
                }}
              >
                {isDownloading ? (
                  <View style={{ alignItems: "center", justifyContent: "center" }}>
                    <ActivityIndicator size="small" color={colors.primary} />
                    <Text style={{ fontSize: 10, color: colors.onSurface, marginTop: 2, fontWeight: "800" }}>
                      {downloadPct}%
                    </Text>
                  </View>
                ) : isDownloadFailed ? (
                  <Icon name="refresh" size={22} color={colors.error} />
                ) : (
                  <Icon
                    name={isDownloaded ? "trash" : "download"}
                    size={22}
                    color={isDownloaded ? colors.error : colors.onSecondaryContainer}
                  />
                )}
              </Pressable>
            ) : null}

            {/* Chapters Button */}
            {hasChapters ? (
              <Pressable
                onPress={() => setChaptersVisible(true)}
                accessibilityRole="button"
                accessibilityLabel="View chapters"
                android_ripple={{ color: withAlpha(colors.onSecondaryContainer, 0.15) }}
                style={{
                  width: 52,
                  height: 52,
                  borderRadius: 26,
                  overflow: "hidden",
                  backgroundColor: colors.secondaryContainer,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Icon name="list" size={22} color={colors.onSecondaryContainer} />
              </Pressable>
            ) : null}

            {/* Send ebook to a configured e-reader device (Kindle etc.).
                Only when the server has devices AND this item has an ebook. */}
            {selfHasEbook && !isPodcastItem && ereaderDevices.length > 0 ? (
              <Pressable
                onPress={() => {
                  // A pending auto-dismiss from the LAST send could fire
                  // mid-open and flip the fresh sheet closed — cancel it and
                  // start from the device list.
                  clearSendTimers();
                  setSendResult(null);
                  setSendToVisible(true);
                }}
                accessibilityRole="button"
                accessibilityLabel="Send ebook to device"
                android_ripple={{ color: withAlpha(colors.onSecondaryContainer, 0.15) }}
                style={{
                  width: 52,
                  height: 52,
                  borderRadius: 26,
                  overflow: "hidden",
                  backgroundColor: colors.secondaryContainer,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Icon name="send" size={22} color={colors.onSecondaryContainer} />
              </Pressable>
            ) : null}

            {/* Request the OTHER format via ReadMeABook: ebook for an
                audio-only book (JWT sessions — the endpoint rejects API
                tokens), audiobook for an ebook-only book (works on both). */}
            {rmabConfigured &&
            !isPodcastItem &&
            ((selfHasAudio && !canRead && rmabAuthMode === "jwt") ||
              (selfHasEbook && !hasAudioMedia)) ? (
              <Pressable
                onPress={() => requestOtherFormat(selfHasAudio && !canRead ? "ebook" : "audiobook")}
                disabled={formatReq?.state === "working"}
                accessibilityRole="button"
                accessibilityState={{ disabled: formatReq?.state === "working", busy: formatReq?.state === "working" }}
                accessibilityLabel={
                  selfHasAudio && !canRead ? "Request ebook edition" : "Request audiobook edition"
                }
                android_ripple={{ color: withAlpha(colors.onSecondaryContainer, 0.15) }}
                style={{
                  width: 52,
                  height: 52,
                  borderRadius: 26,
                  overflow: "hidden",
                  backgroundColor: colors.secondaryContainer,
                  alignItems: "center",
                  justifyContent: "center",
                  opacity: formatReq?.state === "working" ? 0.6 : 1,
                }}
              >
                <Icon
                  name={selfHasAudio && !canRead ? "book" : "headphones"}
                  size={22}
                  color={colors.onSecondaryContainer}
                />
              </Pressable>
            ) : null}

            {/* Mark as Finished/Unfinished Button. Books only: a podcast ITEM
                has no item-level progress (each EPISODE tracks its own), so an
                item-level isFinished PATCH here writes a bogus podcast-item
                entry (see usePlaybackStore's per-tick note). Episodes get their
                own per-row finished toggle below. */}
            {!isPodcastItem ? (
              <Pressable
                onPress={handleToggleFinished}
                accessibilityRole="button"
                accessibilityLabel={isFinished ? "Mark as not finished" : "Mark as finished"}
                accessibilityState={{ selected: isFinished }}
                android_ripple={{
                  color: withAlpha(
                    isFinished ? colors.onPrimaryContainer : colors.onSecondaryContainer,
                    0.15
                  ),
                }}
                style={{
                  width: 52,
                  height: 52,
                  borderRadius: 26,
                  overflow: "hidden",
                  backgroundColor: isFinished ? colors.primaryContainer : colors.secondaryContainer,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Icon
                  name="check"
                  size={22}
                  color={isFinished ? colors.onPrimaryContainer : colors.onSecondaryContainer}
                  style={{ opacity: isFinished ? 1 : 0.45 }}
                />
              </Pressable>
            ) : null}

            {/* Combined "Add to…" — opens the sheet that toggles Up Next (audio
                books), collections, and playlists in one place. Books only: ABS
                collections are book-only and playlists hold EPISODES for
                podcasts — adding a whole podcast item would just 400 on the
                server. (Podcasts reach the queue per-episode elsewhere.) */}
            {!isPodcastItem ? (
              <Pressable
                onPress={() => setAddToVisible(true)}
                accessibilityRole="button"
                accessibilityLabel="Add to…"
                android_ripple={{ color: withAlpha(colors.onSecondaryContainer, 0.15) }}
                style={{
                  width: 52,
                  height: 52,
                  borderRadius: 26,
                  overflow: "hidden",
                  backgroundColor: colors.secondaryContainer,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Icon name="playlist-add" size={22} color={colors.onSecondaryContainer} />
              </Pressable>
            ) : null}

            {/* Per-podcast auto-download settings. Podcasts only — this is the
                single entry point on the podcast itself (the Latest Episodes
                list only exposes it per-episode). */}
            {isPodcastItem && item?.id ? (
              <Pressable
                onPress={() =>
                  navigation.navigate("PodcastSettings", {
                    libraryItemId: item.id,
                    podcastTitle: metadata.title || undefined,
                  })
                }
                accessibilityRole="button"
                accessibilityLabel="Podcast settings"
                android_ripple={{ color: withAlpha(colors.onSecondaryContainer, 0.15) }}
                style={{
                  width: 52,
                  height: 52,
                  borderRadius: 26,
                  overflow: "hidden",
                  backgroundColor: colors.secondaryContainer,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Icon name="settings" size={22} color={colors.onSecondaryContainer} />
              </Pressable>
            ) : null}

            {/* Overflow — item admin/tools/history entries live in a sheet so
                the everyday action row stays uncluttered. Always shown:
                Listening history applies to every account. */}
            <Pressable
              onPress={() => setOverflowVisible(true)}
              accessibilityRole="button"
              accessibilityLabel="More actions"
              android_ripple={{ color: withAlpha(colors.onSecondaryContainer, 0.15) }}
              style={{
                width: 52,
                height: 52,
                borderRadius: 26,
                overflow: "hidden",
                backgroundColor: colors.secondaryContainer,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Icon name="more-vert" size={22} color={colors.onSecondaryContainer} />
            </Pressable>
          </View>

          {/* Podcasts have no item-level Download button (there's no
              item-level audio to grab). Each episode carries its own download
              control in the episode list below. */}

          {/* Your Progress card — one icon-labeled row per format so listening
              and reading progress can never be mistaken for each other. */}
          {showAudioRow || showEbookRow ? (
            <View style={{ paddingHorizontal: 20, marginTop: 18 }}>
              <View
                style={{
                  backgroundColor: colors.surfaceContainer,
                  borderRadius: 16,
                  borderWidth: 1,
                  borderColor: colors.outlineVariant,
                  paddingVertical: 14,
                  paddingHorizontal: 16,
                  rowGap: 14,
                }}
              >
                {showAudioRow ? (
                  <View>
                    <View style={{ flexDirection: "row", alignItems: "center" }}>
                      <View
                        style={{
                          width: 30,
                          height: 30,
                          borderRadius: 15,
                          backgroundColor: colors.secondaryContainer,
                          alignItems: "center",
                          justifyContent: "center",
                          marginRight: 10,
                        }}
                      >
                        <Icon
                          name={audioFinished ? "check" : "headphones"}
                          size={16}
                          color={colors.onSecondaryContainer}
                        />
                      </View>
                      <Text style={{ flex: 1, color: colors.onSurface, fontSize: 14, fontWeight: "600" }}>
                        Listening
                      </Text>
                      <Text style={{ color: colors.onSurface, fontSize: 14, fontWeight: "700" }}>
                        {audioFinished ? "Finished" : `${audioPct}%`}
                      </Text>
                    </View>
                    <View
                      style={{
                        height: 6,
                        borderRadius: 3,
                        backgroundColor: colors.surfaceContainerHighest,
                        marginTop: 8,
                        overflow: "hidden",
                      }}
                    >
                      <View
                        style={{
                          height: "100%",
                          width: `${audioFinished ? 100 : audioPct}%`,
                          backgroundColor: colors.primary,
                          borderRadius: 3,
                        }}
                      />
                    </View>
                    {!audioFinished && timeRemaining ? (
                      <Text style={{ color: colors.onSurfaceVariant, fontSize: 12, marginTop: 4 }}>
                        {timeRemaining} remaining
                      </Text>
                    ) : null}
                  </View>
                ) : null}

                {showEbookRow ? (
                  <View>
                    <View style={{ flexDirection: "row", alignItems: "center" }}>
                      <View
                        style={{
                          width: 30,
                          height: 30,
                          borderRadius: 15,
                          backgroundColor: colors.secondaryContainer,
                          alignItems: "center",
                          justifyContent: "center",
                          marginRight: 10,
                        }}
                      >
                        <Icon
                          name={ebookFinished ? "check" : "book"}
                          size={16}
                          color={colors.onSecondaryContainer}
                        />
                      </View>
                      <Text style={{ flex: 1, color: colors.onSurface, fontSize: 14, fontWeight: "600" }}>
                        Reading
                      </Text>
                      <Text style={{ color: colors.onSurface, fontSize: 14, fontWeight: "700" }}>
                        {ebookFinished ? "Finished" : `${ebookPct}%`}
                      </Text>
                    </View>
                    <View
                      style={{
                        height: 6,
                        borderRadius: 3,
                        backgroundColor: colors.surfaceContainerHighest,
                        marginTop: 8,
                        overflow: "hidden",
                      }}
                    >
                      <View
                        style={{
                          height: "100%",
                          width: `${ebookFinished ? 100 : ebookPct}%`,
                          backgroundColor: colors.tertiary,
                          borderRadius: 3,
                        }}
                      />
                    </View>
                  </View>
                ) : null}

                {/* Cross-medium controls — only when BOTH progress rows show
                    (inert for audio-only / ebook-only items). */}
                {bothProgressRows ? (
                  <View style={{ rowGap: 12 }}>
                    {/* "Sync progress" — appears only when the two have DRIFTED
                        (|Δ| >= 2 pts). Reconciles both to the furthest spot;
                        fraction-only (the ebook page isn't repositioned). */}
                    {progressDrifted ? (
                      // Wrapped in a polite live region so TalkBack announces the
                      // Sync button when drift appears (it otherwise pops in
                      // silently); only rendered when drifted so the parent's
                      // rowGap doesn't reserve empty space.
                      <View accessibilityLiveRegion="polite">
                        <Pressable
                          onPress={handleSyncProgress}
                          accessibilityRole="button"
                          accessibilityLabel={`Sync progress to ${syncTargetPct} percent`}
                          android_ripple={{ color: withAlpha(colors.onSecondaryContainer, 0.15) }}
                          hitSlop={{ top: 6, bottom: 6 }}
                          style={{
                            alignSelf: "flex-start",
                            flexDirection: "row",
                            alignItems: "center",
                            height: 40,
                            paddingHorizontal: 16,
                            borderRadius: 20,
                            overflow: "hidden",
                            backgroundColor: colors.secondaryContainer,
                          }}
                        >
                          <Icon name="refresh" size={18} color={colors.onSecondaryContainer} />
                          <Text
                            style={{
                              color: colors.onSecondaryContainer,
                              fontSize: 14,
                              fontWeight: "600",
                              marginLeft: 8,
                            }}
                          >
                            Sync progress
                          </Text>
                        </Pressable>
                      </View>
                    ) : null}

                    {/* "Link reading & listening" lock — persisted per item. */}
                    <Pressable
                      onPress={handleToggleLink}
                      accessibilityRole="switch"
                      accessibilityLabel="Link reading and listening"
                      accessibilityState={{ checked: isLinked }}
                      android_ripple={{ color: withAlpha(colors.onSurface, 0.08) }}
                      style={{ flexDirection: "row", alignItems: "center" }}
                    >
                      <View
                        style={{
                          width: 30,
                          height: 30,
                          borderRadius: 15,
                          backgroundColor: isLinked
                            ? colors.primaryContainer
                            : colors.secondaryContainer,
                          alignItems: "center",
                          justifyContent: "center",
                          marginRight: 10,
                        }}
                      >
                        <Icon
                          name="lock"
                          size={16}
                          color={isLinked ? colors.onPrimaryContainer : colors.onSecondaryContainer}
                          style={{ opacity: isLinked ? 1 : 0.5 }}
                        />
                      </View>
                      <View style={{ flex: 1, paddingRight: 10 }}>
                        <Text style={{ color: colors.onSurface, fontSize: 14, fontWeight: "600" }}>
                          Link reading &amp; listening
                        </Text>
                        <Text style={{ color: colors.onSurfaceVariant, fontSize: 12, marginTop: 2 }}>
                          Keep both at the furthest spot (by percentage)
                        </Text>
                      </View>
                      {/* M3-ish track/thumb toggle. */}
                      <View
                        style={{
                          width: 44,
                          height: 26,
                          borderRadius: 13,
                          padding: 3,
                          justifyContent: "center",
                          backgroundColor: isLinked ? colors.primary : colors.surfaceContainerHighest,
                          alignItems: isLinked ? "flex-end" : "flex-start",
                        }}
                      >
                        <View
                          style={{
                            width: 20,
                            height: 20,
                            borderRadius: 10,
                            backgroundColor: isLinked ? colors.onPrimary : colors.outline,
                          }}
                        />
                      </View>
                    </Pressable>
                  </View>
                ) : null}
              </View>
            </View>
          ) : null}

          {/* Metadata table */}
          <View style={{ paddingHorizontal: 20, marginTop: 20 }}>
             {authors.length > 0 ? (
              <MetaRow label={authors.length > 1 ? "Authors" : "Author"}>
                <LinkList
                  items={authors.map((a) => ({
                    key: a.id,
                    text: a.name,
                    // Dedicated author page (photo, bio, books) — not the
                    // generic filtered library list.
                    onPress: () =>
                      navigation.navigate("AuthorDetail", {
                        authorId: a.id,
                        authorName: a.name,
                      }),
                  }))}
                />
              </MetaRow>
            ) : null}

            {seriesList.length > 0 ? (
              <MetaRow label="Series">
                <LinkList
                  items={seriesList.map((s) => ({
                    key: s.id,
                    text: s.text,
                    // Dedicated series page (collage, description, continue).
                    onPress: () =>
                      navigation.navigate("SeriesDetail", {
                        seriesId: s.id,
                        seriesName: s.name,
                      }),
                  }))}
                />
              </MetaRow>
            ) : null}

            {duration > 0 ? (
              <MetaRow label="Duration">
                <Value text={elapsedPretty(duration)} />
              </MetaRow>
            ) : null}

             {narrators.length > 0 ? (
              <MetaRow label={narrators.length > 1 ? "Narrators" : "Narrator"}>
                <LinkList
                  items={narrators.map((n) => ({
                    key: n,
                    text: n,
                    onPress: () =>
                      navigation.navigate("Library", {
                        filter: `narrators.${encodeFilterValue(n)}`,
                        showBack: true,
                        title: n,
                      }),
                  }))}
                />
              </MetaRow>
            ) : null}

            {genres.length > 0 ? (
              <MetaRow label={genres.length > 1 ? "Genres" : "Genre"}>
                <LinkList
                  items={genres.map((g) => ({
                    key: g,
                    text: g,
                    onPress: () =>
                      navigation.navigate("Library", {
                        filter: `genres.${encodeFilterValue(g)}`,
                        showBack: true,
                        title: g,
                      }),
                  }))}
                />
              </MetaRow>
            ) : null}

            {tags.length > 0 ? (
              <MetaRow label={tags.length > 1 ? "Tags" : "Tag"}>
                <LinkList
                  items={tags.map((t) => ({
                    key: t,
                    text: t,
                    onPress: () =>
                      navigation.navigate("Library", {
                        filter: `tags.${encodeFilterValue(t)}`,
                        showBack: true,
                        title: t,
                      }),
                  }))}
                />
              </MetaRow>
            ) : null}

            {publishedYear ? (
              <MetaRow label="Publish Year">
                <Value text={String(publishedYear)} />
              </MetaRow>
            ) : null}

            {publisher ? (
              <MetaRow label="Publisher">
                <Value text={publisher} />
              </MetaRow>
            ) : null}

            {language ? (
              <MetaRow label="Language">
                <Value text={language} />
              </MetaRow>
            ) : null}

            {sizeBytes > 0 ? (
              <MetaRow label="Size">
                <Value text={formatBytes(sizeBytes)} />
              </MetaRow>
            ) : null}
          </View>

          {/* Description with Read more */}
          {description ? (
            <View style={{ paddingHorizontal: 20, marginTop: 20 }}>
              {/* Invisible unclamped copy measures the real line count — the
                  clamped Text can't report overflow itself, and a char-count
                  guess misfires on multi-paragraph or long-single-line text. */}
              <Text
                style={{
                  position: "absolute",
                  left: 20,
                  right: 20,
                  opacity: 0,
                  fontSize: 14,
                  lineHeight: 21,
                }}
                pointerEvents="none"
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                onTextLayout={(e) => {
                  const overflows = e.nativeEvent.lines.length > 5;
                  if (overflows !== descOverflows) setDescOverflows(overflows);
                }}
              >
                {description}
              </Text>
              <Text numberOfLines={descExpanded ? undefined : 5} style={{ color: colors.onSurface, fontSize: 14, lineHeight: 21 }}>
                {description}
              </Text>
              {descOverflows ? (
                <Pressable
                  onPress={() => setDescExpanded((v) => !v)}
                  accessibilityRole="button"
                  accessibilityLabel={descExpanded ? "Collapse description" : "Expand description"}
                  hitSlop={8}
                >
                  <Text style={{ color: colors.primary, fontSize: 14, fontWeight: "600", marginTop: 8 }}>
                    {descExpanded ? "Read less" : "Read more"}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}

          {/* Podcast with no episodes: the Play button above is disabled, so
              disclose why here instead of leaving a silent dead control. */}
          {isPodcastEmpty ? (
            <EmptyState
              icon="podcast"
              title="No episodes available yet"
              message="Episodes will appear here once this podcast has published them."
              style={{ marginTop: 8 }}
            />
          ) : null}

          {/* Podcast episodes */}
          {isPodcastItem && episodes.length > 0 ? (
            <View style={{ paddingHorizontal: 20, marginTop: 24 }}>
              <Text
                accessibilityRole="header"
                style={{ color: colors.onSurface, fontSize: 18, fontWeight: "700", marginBottom: 4 }}
              >
                {episodes.length} {episodes.length === 1 ? "Episode" : "Episodes"}
              </Text>

              {/* Filter (All / Unplayed / In-Progress) + newest↔oldest sort. */}
              <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", marginTop: 4, marginBottom: 8 }}>
                <EpisodeFilterChip label="All" value="all" />
                <EpisodeFilterChip label="Unplayed" value="unplayed" />
                <EpisodeFilterChip label="In-Progress" value="in-progress" />
                <Pressable
                  onPress={() => setEpisodeSort((s) => (s === "newest" ? "oldest" : "newest"))}
                  accessibilityRole="button"
                  accessibilityLabel={episodeSort === "newest" ? "Sort oldest first" : "Sort newest first"}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    paddingHorizontal: 14,
                    height: 34,
                    borderRadius: 17,
                    borderWidth: 1,
                    borderColor: colors.outlineVariant,
                  }}
                >
                  <Icon name="sort" size={16} color={colors.onSurfaceVariant} style={{ marginRight: 6 }} />
                  <Text style={{ color: colors.onSurfaceVariant, fontSize: 13, fontWeight: "600" }}>
                    {episodeSort === "newest" ? "Newest" : "Oldest"}
                  </Text>
                </Pressable>
              </View>

              {displayEpisodes.length === 0 ? (
                <Text style={{ color: colors.onSurfaceVariant, fontSize: 14, textAlign: "center", paddingVertical: 24 }}>
                  No episodes match this filter.
                </Text>
              ) : null}
              {displayEpisodes.slice(0, episodeLimit).map((episode) => {
                const epProgress = progressMap[`${itemId}-${episode.id}`];
                const epFinished = !!epProgress?.isFinished;
                const epFraction = Math.max(0, Math.min(1, Number(epProgress?.progress || 0)));
                // RSS-derived dates aren't normalized — a garbage value
                // rendered a literal "Invalid Date" subtitle.
                const pubMs = episode.publishedAt ? new Date(episode.publishedAt).getTime() : NaN;
                const pubDate = Number.isFinite(pubMs)
                  ? new Date(pubMs).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })
                  : "";
                const durationStr = elapsedPretty(episode.duration || episode.audioFile?.duration);
                const subtitleStr = [pubDate, durationStr].filter(Boolean).join(" · ");
                const isThisPlaying =
                  currentSession?.libraryItemId === itemId && currentSession?.episodeId === episode.id;
                // Per-episode offline download state (composite-keyed).
                const epDlKey = episodeDownloadKey(itemId, episode.id);
                const epActiveDl = activeDownloads[epDlKey];
                const epDownloaded = !!(completedDownloads[epDlKey] && !epActiveDl);
                const epDownloading = epActiveDl?.status === "downloading" || epActiveDl?.status === "pending";
                const epDownloadFailed = epActiveDl?.status === "failed";
                const epDownloadPct =
                  epActiveDl && Number.isFinite(epActiveDl.progress)
                    ? Math.round(epActiveDl.progress * 100)
                    : 0;
                return (
                  <View
                    key={episode.id}
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      paddingVertical: 10,
                      borderBottomWidth: 1,
                      borderBottomColor: colors.outlineVariant,
                      opacity: epFinished ? 0.55 : 1,
                    }}
                  >
                    <View style={{ flex: 1, marginRight: 12 }}>
                      <Text numberOfLines={2} style={{ color: colors.onSurface, fontSize: 14, fontWeight: "600", lineHeight: 19 }}>
                        {episode.title || "Untitled episode"}
                      </Text>
                      {subtitleStr ? (
                        <Text style={{ color: colors.onSurfaceVariant, fontSize: 12, marginTop: 2 }}>
                          {subtitleStr}
                          {epFinished ? " · Finished" : ""}
                        </Text>
                      ) : null}
                      {!epFinished && epFraction > 0 ? (
                        <View
                          style={{
                            height: 3,
                            borderRadius: 1.5,
                            backgroundColor: colors.surfaceContainerHighest,
                            marginTop: 6,
                            overflow: "hidden",
                          }}
                        >
                          <View
                            style={{
                              height: "100%",
                              width: `${Math.min(99, Math.max(1, Math.round(epFraction * 100)))}%`,
                              backgroundColor: colors.primary,
                            }}
                          />
                        </View>
                      ) : null}
                    </View>
                    {/* Per-episode download control — mirrors the book download
                        button's four states (download / downloading% / retry /
                        delete) but scoped to this episode's composite key. */}
                    <Pressable
                      onPress={() => handleEpisodeDownloadPress(episode)}
                      accessibilityRole="button"
                      accessibilityLabel={
                        epDownloaded
                          ? `Delete download of ${episode.title || "episode"}`
                          : epDownloading
                          ? `Cancel download of ${episode.title || "episode"}, ${epDownloadPct} percent complete`
                          : epDownloadFailed
                          ? `Download of ${episode.title || "episode"} failed, tap to retry`
                          : `Download ${episode.title || "episode"}`
                      }
                      hitSlop={6}
                      android_ripple={{
                        color: withAlpha(
                          epDownloaded || epDownloadFailed ? colors.error : colors.onSecondaryContainer,
                          0.15
                        ),
                      }}
                      style={{
                        width: 40,
                        height: 40,
                        borderRadius: 20,
                        overflow: "hidden",
                        marginRight: 8,
                        backgroundColor:
                          epDownloaded || epDownloadFailed
                            ? withAlpha(colors.error, 0.1)
                            : colors.secondaryContainer,
                        alignItems: "center",
                        justifyContent: "center",
                        borderWidth: epDownloaded || epDownloadFailed ? 1 : 0,
                        borderColor: epDownloaded || epDownloadFailed ? colors.error : "transparent",
                      }}
                    >
                      {epDownloading ? (
                        <View style={{ alignItems: "center", justifyContent: "center" }}>
                          <ActivityIndicator size="small" color={colors.primary} />
                          <Text style={{ fontSize: 9, color: colors.onSurface, marginTop: 1, fontWeight: "800" }}>
                            {epDownloadPct}%
                          </Text>
                        </View>
                      ) : epDownloadFailed ? (
                        <Icon name="refresh" size={18} color={colors.error} />
                      ) : (
                        <Icon
                          name={epDownloaded ? "trash" : "download"}
                          size={18}
                          color={epDownloaded ? colors.error : colors.onSecondaryContainer}
                        />
                      )}
                    </Pressable>
                    {/* Per-episode finished toggle — PATCHes the episode-scoped
                        endpoint and updates the `${itemId}-${episodeId}` map key. */}
                    <Pressable
                      onPress={() => handleToggleEpisodeFinished(episode)}
                      accessibilityRole="button"
                      accessibilityLabel={
                        epFinished ? "Mark episode not finished" : "Mark episode finished"
                      }
                      accessibilityState={{ selected: epFinished }}
                      hitSlop={6}
                      style={{
                        width: 40,
                        height: 40,
                        borderRadius: 20,
                        marginRight: 8,
                        backgroundColor: epFinished ? colors.primaryContainer : colors.secondaryContainer,
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <Icon
                        name="check"
                        size={20}
                        color={epFinished ? colors.onPrimaryContainer : colors.onSecondaryContainer}
                        style={{ opacity: epFinished ? 1 : 0.45 }}
                      />
                    </Pressable>
                    <Pressable
                      onPress={() => playEpisode(episode)}
                      disabled={!!startingEpisodeId}
                      accessibilityRole="button"
                      accessibilityLabel={
                        isThisPlaying
                          ? `Resume ${episode.title || "episode"}`
                          : `Play ${episode.title || "episode"}`
                      }
                      hitSlop={6}
                      style={{
                        width: 40,
                        height: 40,
                        borderRadius: 20,
                        backgroundColor: isThisPlaying ? colors.primaryContainer : colors.secondaryContainer,
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      {startingEpisodeId === episode.id ? (
                        <ActivityIndicator size="small" color={colors.onSecondaryContainer} />
                      ) : (
                        <Icon
                          name={isThisPlaying ? "headphones" : "play"}
                          size={22}
                          color={isThisPlaying ? colors.onPrimaryContainer : colors.onSecondaryContainer}
                        />
                      )}
                    </Pressable>
                  </View>
                );
              })}
              {displayEpisodes.length > episodeLimit ? (
                <Pressable
                  onPress={() => setEpisodeLimit((n) => n + EPISODE_CAP)}
                  android_ripple={{ color: colors.surfaceContainerHighest }}
                  accessibilityRole="button"
                  accessibilityLabel={`Show more episodes, ${displayEpisodes.length - episodeLimit} remaining`}
                  style={{
                    marginTop: 10,
                    paddingVertical: 12,
                    borderRadius: 16,
                    overflow: "hidden",
                    backgroundColor: colors.surfaceContainer,
                    alignItems: "center",
                  }}
                >
                  <Text style={{ color: colors.primary, fontSize: 14, fontWeight: "600" }}>
                    Show more ({displayEpisodes.length - episodeLimit} remaining)
                  </Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
        </ScrollView>
      ) : null}

      <ChaptersModal
        visible={chaptersVisible}
        onClose={() => setChaptersVisible(false)}
        chapters={displayChapters}
        currentChapterIndex={isCurrentlyPlaying ? currentChapterIndex : -1}
        onSeekToChapter={handleSeekToChapter}
        hideBackdrop
      />
      {item?.id && item?.libraryId ? (
        <AddToListModal
          visible={addToVisible}
          onClose={() => setAddToVisible(false)}
          libraryItemId={item.id}
          libraryId={item.libraryId}
          isPodcast={isPodcastItem}
          queueItemId={queueItemId}
          title={metadata.title || undefined}
          author={metadata.authorName || authors[0]?.name || undefined}
          coverUrl={queueCoverUrl}
        />
      ) : null}

      {/* Request-other-format progress/result. */}
      <BottomSheet visible={!!formatReq} onClose={() => setFormatReq(null)}>
        {formatReq?.state === "working" ? (
          <View style={{ alignItems: "center", paddingVertical: 36 }}>
            <ActivityIndicator size="large" color={colors.primary} />
            <Text style={{ color: colors.onSurfaceVariant, marginTop: 14 }}>
              Requesting the {formatReq.kind} edition…
            </Text>
          </View>
        ) : formatReq ? (
          <ResultBurst
            ok={formatReq.state === "ok"}
            title={
              formatReq.state === "ok"
                ? formatReq.msg || `${formatReq.kind === "ebook" ? "Ebook" : "Audiobook"} requested`
                : "Couldn't request"
            }
            subtitle={
              formatReq.state === "ok"
                ? "ReadMeABook is on it — track it under Requests."
                : formatReq.msg
            }
          />
        ) : null}
      </BottomSheet>

      {/* Device picker for "Send ebook to device". */}
      <BottomSheet visible={sendToVisible} onClose={closeSendSheet}>
        {sendResult ? (
          <>
            <ResultBurst
              ok={sendResult.ok}
              title={sendResult.ok ? `Sent to ${sendResult.device}` : "Couldn't send"}
              subtitle={
                sendResult.ok
                  ? "The server is emailing your ebook."
                  : "Check the server's email settings and try again."
              }
            />
            {!sendResult.ok ? (
              <Pressable
                onPress={() => setSendResult(null)}
                accessibilityRole="button"
                accessibilityLabel="Try again"
                android_ripple={{ color: withAlpha(colors.onSecondaryContainer, 0.13) }}
                style={{
                  alignSelf: "center",
                  backgroundColor: colors.secondaryContainer,
                  borderRadius: 20,
                  paddingHorizontal: 24,
                  height: 40,
                  justifyContent: "center",
                  marginBottom: 20,
                }}
              >
                <Text style={{ color: colors.onSecondaryContainer, fontSize: 14, fontWeight: "600" }}>
                  Try again
                </Text>
              </Pressable>
            ) : null}
          </>
        ) : (
          <>
            <View style={{ paddingHorizontal: 24, paddingTop: 4, paddingBottom: 6 }}>
              <Text style={{ fontSize: 18, fontWeight: "600", color: colors.onSurface }}>
                Send ebook to device
              </Text>
              <Text style={{ fontSize: 13, color: colors.onSurfaceVariant, marginTop: 2 }}>
                The server emails the file to the device you pick.
              </Text>
            </View>
            {ereaderDevices.map((d: any) => (
              <Pressable
                key={d.name}
                disabled={!!sendingTo}
                onPress={() => sendEbookToDevice(d.name)}
                accessibilityRole="button"
                accessibilityLabel={`Send to ${d.name}`}
                android_ripple={{ color: withAlpha(colors.primary, 0.13) }}
                // Plain object style: Fabric drops function-styles on this
                // pressable path on-device (row rendered unstyled — no
                // padding/row direction). Ripple covers pressed feedback.
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  minHeight: 64,
                  paddingHorizontal: 24,
                  paddingVertical: 10,
                  opacity: sendingTo && sendingTo !== d.name ? 0.5 : 1,
                }}
              >
                <View
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 20,
                    backgroundColor: colors.secondaryContainer,
                    alignItems: "center",
                    justifyContent: "center",
                    marginRight: 16,
                  }}
                >
                  <Icon name="book" size={20} color={colors.onSecondaryContainer} />
                </View>
                <Text
                  numberOfLines={1}
                  style={{ flex: 1, fontSize: 16, fontWeight: "500", color: colors.onSurface }}
                >
                  {d.name}
                </Text>
                {sendingTo === d.name ? <ActivityIndicator size="small" color={colors.primary} /> : null}
              </Pressable>
            ))}
          </>
        )}
      </BottomSheet>

      {/* Overflow: capability-gated item actions. */}
      <BottomSheet visible={overflowVisible} onClose={() => setOverflowVisible(false)}>
        <View style={{ paddingHorizontal: 24, paddingTop: 4, paddingBottom: 6 }}>
          <Text
            accessibilityRole="header"
            style={{ fontSize: 18, fontWeight: "600", color: colors.onSurface }}
          >
            More actions
          </Text>
        </View>
        {/* Books AND podcasts: the editor handles both shapes since issue #56
            (podcast metadata/cover editing landed with the podcast admin work). */}
        {capabilities.canEditMetadata ? (
          <RowBase
            icon="edit"
            title="Edit metadata"
            subtitle="Details, cover, and provider match"
            colors={colors}
            onPress={() => {
              setOverflowVisible(false);
              navigation.navigate("EditMetadata", { libraryItemId: itemId });
            }}
          />
        ) : null}
        {capabilities.canEditMetadata && !isPodcastItem && selfHasAudio ? (
          <RowBase
            icon="list"
            title="Edit chapters"
            colors={colors}
            onPress={() => {
              setOverflowVisible(false);
              navigation.navigate("ChapterEditor", { libraryItemId: itemId });
            }}
          />
        ) : null}
        {capabilities.isAdmin && !isPodcastItem && selfHasAudio ? (
          <RowBase
            icon="settings"
            title="Tools"
            subtitle="M4B encode, embed metadata"
            colors={colors}
            onPress={() => {
              setOverflowVisible(false);
              setToolsVisible(true);
            }}
          />
        ) : null}
        {capabilities.canDownload ? (
          // Disabled (dimmed + guarded in handleZipDownload) while a zip is
          // already streaming — one zip download per item at a time.
          <View style={{ opacity: zipDownload ? 0.5 : 1 }}>
            <RowBase
              icon="download"
              title="Download all (zip)"
              subtitle={
                zipDownload
                  ? zipDownload.totalBytes > 0
                    ? `Downloading… ${zipDownload.pct}%`
                    : "Downloading…"
                  : sizeBytes > 0
                  ? `~${formatBytes(sizeBytes)}`
                  : undefined
              }
              colors={colors}
              accessibilityState={{ disabled: !!zipDownload }}
              onPress={handleZipDownload}
            />
          </View>
        ) : null}
        {capabilities.isAdmin && capabilities.supportsShareLinks && !isPodcastItem ? (
          <RowBase
            icon="share"
            title="Share link"
            subtitle="Public streaming link"
            colors={colors}
            onPress={openShareSheet}
          />
        ) : null}
        {/* Open a public RSS feed for this item (podcast or audiobook) —
            admin-only, every feed route is admin-gated server-side. */}
        {capabilities.isAdmin ? (
          <RowBase
            icon="rss"
            title="Open RSS feed"
            subtitle="Public podcast-style feed"
            colors={colors}
            onPress={() => {
              setOverflowVisible(false);
              setFeedEntity({ kind: "item", id: itemId, title: metadata.title || "this item" });
            }}
          />
        ) : null}
        {/* Per-item progress reset (issue #71) — books only, and only when
            there is something to reset. Podcasts track per-EPISODE progress;
            a bulk episode reset is out of scope here. */}
        {!isPodcastItem &&
        (isFinished || audioProgressFraction > 0 || ebookProgressFraction > 0) ? (
          <RowBase
            icon="undo"
            title="Reset progress"
            subtitle="Back to not started"
            colors={colors}
            onPress={() => {
              setOverflowVisible(false);
              handleResetProgress();
            }}
          />
        ) : null}
        <RowBase
          icon="clock"
          title="Listening history"
          colors={colors}
          onPress={() => {
            setOverflowVisible(false);
            navigation.navigate("ItemHistory", { libraryItemId: itemId });
          }}
        />
      </BottomSheet>

      {/* Tools: server-side file operations (admin). Both rows disable while
          an encode/embed task already targets this item — kicking off a second
          file mutation mid-run is never valid. */}
      <BottomSheet visible={toolsVisible} onClose={() => setToolsVisible(false)}>
        <View style={{ paddingHorizontal: 24, paddingTop: 4, paddingBottom: 6 }}>
          <Text
            accessibilityRole="header"
            style={{ fontSize: 18, fontWeight: "600", color: colors.onSurface }}
          >
            Tools
          </Text>
          <Text style={{ fontSize: 13, color: colors.onSurfaceVariant, marginTop: 2 }}>
            These run on the server and modify the item's files.
          </Text>
        </View>
        <View style={{ opacity: itemTaskRunning ? 0.5 : 1 }}>
          <RowBase
            icon="music"
            title="Encode as M4B"
            subtitle={encodeTaskRunning ? "Encoding in progress…" : "Merge audio files into one M4B"}
            colors={colors}
            accessibilityState={{ disabled: itemTaskRunning }}
            onPress={() => {
              if (itemTaskRunning) return;
              startEncodeM4b();
            }}
          />
          <RowBase
            icon="edit"
            title="Embed metadata"
            subtitle={
              embedTaskRunning
                ? "Embedding metadata…"
                : "Write metadata and cover into the audio files"
            }
            colors={colors}
            accessibilityState={{ disabled: itemTaskRunning }}
            onPress={() => {
              if (itemTaskRunning) return;
              startEmbedMetadata();
            }}
          />
        </View>
      </BottomSheet>

      {/* Share link: create/copy/delete a public streaming link. */}
      <BottomSheet visible={shareVisible} onClose={() => setShareVisible(false)}>
        <View style={{ paddingHorizontal: 24, paddingTop: 4, paddingBottom: 12 }}>
          <Text
            accessibilityRole="header"
            style={{ fontSize: 18, fontWeight: "600", color: colors.onSurface }}
          >
            Share link
          </Text>
          <Text style={{ fontSize: 13, color: colors.onSurfaceVariant, marginTop: 2 }}>
            This link is public — anyone with it can stream this book without logging in.
          </Text>
        </View>
        {shareLink ? (
          <>
            <View style={{ paddingHorizontal: 24, paddingBottom: 8 }}>
              <Text
                selectable
                accessibilityLabel={`Share link URL: ${shareUrl}`}
                style={{ color: colors.onSurface, fontSize: 14 }}
              >
                {shareUrl}
              </Text>
            </View>
            <RowBase icon="copy" title="Copy link" colors={colors} onPress={handleCopyShareLink} />
            <RowBase
              icon="trash"
              title="Delete link"
              colors={colors}
              onPress={handleDeleteShareLink}
            />
          </>
        ) : (
          <>
            <View style={{ paddingHorizontal: 24, paddingBottom: 4 }}>
              <Text style={{ color: colors.onSurface, fontSize: 14, fontWeight: "600" }}>Slug</Text>
              <TextInput
                value={shareSlug}
                onChangeText={setShareSlug}
                autoCapitalize="none"
                autoCorrect={false}
                accessibilityLabel="Share link slug"
                placeholderTextColor={colors.onSurfaceVariant}
                style={{
                  backgroundColor: colors.surfaceContainer,
                  color: colors.onSurface,
                  borderRadius: 12,
                  paddingHorizontal: 14,
                  paddingVertical: 10,
                  fontSize: 15,
                  marginTop: 6,
                }}
              />
              <Text style={{ color: colors.onSurface, fontSize: 14, fontWeight: "600", marginTop: 12 }}>
                Expires
              </Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", marginTop: 6 }}>
                {SHARE_EXPIRY_OPTIONS.map((opt) => {
                  const active = shareExpiryMs === opt.ms;
                  return (
                    <Pressable
                      key={opt.label}
                      onPress={() => setShareExpiryMs(opt.ms)}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                      accessibilityLabel={`Expires: ${opt.label}`}
                      hitSlop={{ top: 6, bottom: 6 }}
                      style={{
                        paddingHorizontal: 14,
                        height: 34,
                        borderRadius: 17,
                        alignItems: "center",
                        justifyContent: "center",
                        marginRight: 8,
                        marginBottom: 8,
                        backgroundColor: active ? colors.secondaryContainer : "transparent",
                        borderWidth: 1,
                        borderColor: active ? colors.secondaryContainer : colors.outlineVariant,
                      }}
                    >
                      <Text
                        style={{
                          color: active ? colors.onSecondaryContainer : colors.onSurfaceVariant,
                          fontSize: 13,
                          fontWeight: "600",
                        }}
                      >
                        {opt.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
            <Pressable
              onPress={handleCreateShareLink}
              disabled={shareBusy}
              accessibilityRole="button"
              accessibilityLabel="Create share link"
              accessibilityState={{ disabled: shareBusy, busy: shareBusy }}
              android_ripple={{ color: withAlpha(colors.onPrimary, 0.16) }}
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                marginHorizontal: 24,
                marginTop: 8,
                marginBottom: 16,
                height: 48,
                borderRadius: 24,
                overflow: "hidden",
                backgroundColor: colors.primary,
                opacity: shareBusy ? 0.6 : 1,
              }}
            >
              {shareBusy ? (
                <ActivityIndicator size="small" color={colors.onPrimary} />
              ) : (
                <Text style={{ color: colors.onPrimary, fontSize: 15, fontWeight: "700" }}>
                  Create link
                </Text>
              )}
            </Pressable>
          </>
        )}
      </BottomSheet>

      {/* Open RSS feed (admin-only shared flow). */}
      <OpenFeedSheet entity={feedEntity} onClose={() => setFeedEntity(null)} />
    </SafeAreaView>
  );
}
