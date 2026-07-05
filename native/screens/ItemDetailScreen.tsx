import React, { useEffect, useState } from "react";
import { View, Text, Pressable, ScrollView, ActivityIndicator, useWindowDimensions, Alert } from "react-native";
import { Image } from "expo-image";
import { coverSource } from "../utils/coverSource";
import { SafeAreaView } from "react-native-safe-area-context";
import { api } from "../utils/api";
import { queueFinishedPatch } from "../utils/progressSync";
import { useUserStore } from "../store/useUserStore";
import { usePlaybackStore } from "../store/usePlaybackStore";
import { useThemeColors } from "../theme/useThemeColors";
import Icon from "../components/Icon";
import { useDownloadStore } from "../store/useDownloadStore";
import { downloader } from "../utils/downloader";
import { storage } from "../utils/storage";
import { encodeFilterValue } from "../components/FilterModal";
import TopAppBar from "../components/TopAppBar";
import ChaptersModal from "../components/ChaptersModal";
import AddToListModal from "../components/AddToListModal";
import { hasAudio, hasEbook as itemHasEbook, getEbookFormat, bestCounterpart } from "../utils/bookMatch";
import { formatBytes } from "../utils/format";

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

  const isDownloaded = !!(item?.id && completedDownloads[item.id]);
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
  const downloadPct = activeDownload ? Math.round(activeDownload.progress * 100) : 0;

  const handleToggleFinished = async () => {
    if (!item?.id) return;
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
    } catch (err) {
      // Offline — queue the toggle(s) and reflect the state locally anyway;
      // flushPendingSyncs delivers them when the server is reachable again.
      console.warn("[ItemDetail] Toggle finished failed — queueing for later:", err);
      queueFinishedPatch(item.id, next);
      if (counterpart?.id) queueFinishedPatch(counterpart.id, next);
      applyLocally();
    }
  };

  const handleDownloadPress = async () => {
    if (!item?.id) return;
    if (isDownloaded) {
      // A completed download must go through removeDownload (cancelDownload
      // only touches in-flight downloads and would silently no-op here).
      // Destructive — deletes the files — so confirm first.
      Alert.alert(
        "Delete download",
        `Remove "${metadata.title || "this book"}" from this device? You can download it again later.`,
        [
          { text: "Cancel", style: "cancel" },
          { text: "Delete", style: "destructive", onPress: () => removeDownload(item.id) },
        ]
      );
    } else if (isDownloading) {
      cancelDownload(item.id);
    } else if (isDownloadFailed) {
      // Resume from the failed state — completed parts are skipped.
      useDownloadStore.getState().retryDownload(item.id);
    } else {
      try {
        await downloader.downloadBook(item, serverAddress, token);
        refetchItem();
      } catch (err) {
        console.warn("[ItemDetail] Download failed:", err);
        Alert.alert(
          "Download failed",
          "Couldn't start the download. Check your connection and free space, then try again."
        );
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
    } catch (err) {
      console.error("[ItemDetail] Failed to fetch item:", err);
      setError("Failed to load item details.");
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

  const chapters = item?.media?.chapters || [];
  const hasChapters = chapters.length > 0;
  const isCurrentlyPlaying = currentSession?.libraryItemId === itemId;

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
    if (isCurrentlyPlaying) {
      await seekToChapter(index);
    } else {
      setStarting(true);
      const ok = await startPlayback(itemId);
      setStarting(false);
      if (ok) {
        // Wait a brief moment for track player setup before seeking
        setTimeout(async () => {
          await seekToChapter(index);
        }, 300);
      }
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
  const episodes: any[] = React.useMemo(() => {
    if (!isPodcastItem) return [];
    const eps = [...(item?.media?.episodes || [])];
    eps.sort((a, b) => Number(b.publishedAt || 0) - Number(a.publishedAt || 0));
    return eps;
  }, [isPodcastItem, item]);

  const playEpisode = async (episode: any) => {
    if (!episode?.id || startingEpisodeId || starting) return;
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
    setStarting(true);
    storage.set(`last_interaction_${itemId}`, "listen");
    setLastInteractionState("listen");
    await startPlayback(id);
    setStarting(false);
  };
  const handlePlay = () => startAudio(itemId);

  const hasAudioMedia = selfHasAudio || !!audioCounterpartId;
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
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
          <Icon name="warning" size={40} color={colors.error} />
          <Text style={{ color: colors.onSurfaceVariant, fontSize: 15, textAlign: "center", marginTop: 12 }}>{error}</Text>
          {itemId ? (
            <Pressable
              onPress={loadItem}
              accessibilityRole="button"
              style={{
                marginTop: 20,
                backgroundColor: colors.primary,
                paddingHorizontal: 24,
                paddingVertical: 10,
                borderRadius: 20,
              }}
            >
              <Text style={{ color: colors.onPrimary, fontSize: 14, fontWeight: "600" }}>Retry</Text>
            </Pressable>
          ) : null}
        </View>
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
                disabled={starting}
                accessibilityRole="button"
                accessibilityLabel={!isFinished && audioProgressFraction > 0 ? "Continue listening" : "Play"}
                style={{
                  flex: 1,
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
                  opacity: starting ? 0.6 : 1,
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
                style={{
                  flex: 1,
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
              squeezed Play/Read into slivers once all four icons showed. */}
          <View
            style={{
              flexDirection: "row",
              justifyContent: "center",
              paddingHorizontal: 20,
              marginTop: 12,
              columnGap: 12,
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
                style={{
                  width: 52,
                  height: 52,
                  borderRadius: 26,
                  backgroundColor:
                    isDownloaded || isDownloadFailed
                      ? "rgba(179, 38, 30, 0.1)"
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
                style={{
                  width: 52,
                  height: 52,
                  borderRadius: 26,
                  backgroundColor: colors.secondaryContainer,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Icon name="list" size={22} color={colors.onSecondaryContainer} />
              </Pressable>
            ) : null}

            {/* Mark as Finished/Unfinished Button */}
            <Pressable
              onPress={handleToggleFinished}
              accessibilityRole="button"
              accessibilityLabel={isFinished ? "Mark as not finished" : "Mark as finished"}
              accessibilityState={{ selected: isFinished }}
              style={{
                width: 52,
                height: 52,
                borderRadius: 26,
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

            {/* Add to collection / playlist. Books only: ABS collections are
                book-only and playlists hold EPISODES for podcasts — adding a
                whole podcast item would just 400 on the server. */}
            {!isPodcastItem ? (
              <Pressable
                onPress={() => setAddToVisible(true)}
                accessibilityRole="button"
                accessibilityLabel="Add to collection or playlist"
                style={{
                  width: 52,
                  height: 52,
                  borderRadius: 26,
                  backgroundColor: colors.secondaryContainer,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Icon name="playlist-add" size={22} color={colors.onSecondaryContainer} />
              </Pressable>
            ) : null}
          </View>

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
                    onPress: () =>
                      navigation.navigate("Library", {
                        filter: `authors.${encodeFilterValue(a.id)}`,
                        showBack: true,
                        title: a.name,
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
                    onPress: () =>
                      navigation.navigate("Library", {
                        filter: `series.${encodeFilterValue(s.id)}`,
                        showBack: true,
                        title: s.text,
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

          {/* Podcast episodes */}
          {isPodcastItem && episodes.length > 0 ? (
            <View style={{ paddingHorizontal: 20, marginTop: 24 }}>
              <Text style={{ color: colors.onSurface, fontSize: 18, fontWeight: "700", marginBottom: 4 }}>
                {episodes.length} {episodes.length === 1 ? "Episode" : "Episodes"}
              </Text>
              {episodes.slice(0, episodeLimit).map((episode) => {
                const epProgress = progressMap[`${itemId}-${episode.id}`];
                const epFinished = !!epProgress?.isFinished;
                const epFraction = Math.max(0, Math.min(1, Number(epProgress?.progress || 0)));
                const pubDate = episode.publishedAt
                  ? new Date(episode.publishedAt).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })
                  : "";
                const durationStr = elapsedPretty(episode.duration || episode.audioFile?.duration);
                const subtitleStr = [pubDate, durationStr].filter(Boolean).join(" · ");
                const isThisPlaying =
                  currentSession?.libraryItemId === itemId && currentSession?.episodeId === episode.id;
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
                    <Pressable
                      onPress={() => playEpisode(episode)}
                      disabled={!!startingEpisodeId || isThisPlaying}
                      accessibilityRole="button"
                      accessibilityLabel={`Play ${episode.title || "episode"}`}
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
              {episodes.length > episodeLimit ? (
                <Pressable
                  onPress={() => setEpisodeLimit((n) => n + EPISODE_CAP)}
                  android_ripple={{ color: colors.surfaceContainerHighest }}
                  accessibilityRole="button"
                  accessibilityLabel={`Show more episodes, ${episodes.length - episodeLimit} remaining`}
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
                    Show more ({episodes.length - episodeLimit} remaining)
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
        chapters={chapters}
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
        />
      ) : null}
    </SafeAreaView>
  );
}
