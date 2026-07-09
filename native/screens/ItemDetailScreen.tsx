import React, { useEffect, useState } from "react";
import { View, Text, ScrollView, ActivityIndicator, useWindowDimensions } from "react-native";
import { Image } from "expo-image";
import { coverSource } from "../utils/coverSource";
import { SafeAreaView } from "react-native-safe-area-context";
import { api } from "../utils/api";
import {
  queueFinishedPatch,
  queueProgressPatch,
  syncBothProgressFraction,
  reconcileLinkedProgress,
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
import { downloader } from "../utils/downloader";
import { storage } from "../utils/storage";
import { encodeFilterValue } from "../components/FilterModal";
import TopAppBar from "../components/TopAppBar";
import ChaptersModal from "../components/ChaptersModal";
import AddToListModal from "../components/AddToListModal";
import BottomSheet from "../components/BottomSheet";
import ResultBurst from "../components/ResultBurst";
import { useRmabStore } from "../store/useRmabStore";
import { hasAudio, hasEbook as itemHasEbook, getEbookFormat, bestCounterpart } from "../utils/bookMatch";
import { formatBytes } from "../utils/format";
import Pressable from "../components/HintPressable";

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

  const metadata = item?.media?.metadata || {};
  const coverUrl =
    itemId && serverAddress && token ? `${serverAddress}/api/items/${itemId}/cover?width=800&format=webp&token=${token}` : null;

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
    </SafeAreaView>
  );
}
