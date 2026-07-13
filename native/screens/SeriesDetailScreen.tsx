import React, { useEffect, useRef, useState } from "react";
import { View, Text, FlatList, Pressable, ActivityIndicator, RefreshControl, ScrollView } from "react-native";
import { Image } from "expo-image";
import { coverSource } from "../utils/coverSource";
import { useThemeColors } from "../theme/useThemeColors";
import { SafeAreaView } from "react-native-safe-area-context";
import Animated from "react-native-reanimated";
import { listRowEnter } from "../theme/motion";
import { api } from "../utils/api";
import { useUserStore } from "../store/useUserStore";
import { useLibraryStore } from "../store/useLibraryStore";
import { usePlaybackStore } from "../store/usePlaybackStore";
import { withAlpha } from "../theme/palette";
import { showAppDialog } from "../store/useDialogStore";
import { showSnackbar } from "../store/useSnackbarStore";
import { batchUpdateProgress } from "../utils/abs/me";
import Icon from "../components/Icon";
import { isEbookOnly, getEbookFormat } from "../utils/bookMatch";
import BookProgressBadge, { bookStatusA11yLabel } from "../components/BookProgressBadge";
import { ListSkeleton } from "../components/Skeleton";
import ErrorState from "../components/ErrorState";
import EmptyState from "../components/EmptyState";
import RmabMissingSection from "../components/RmabMissingSection";

const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
const base64Encode = (input: string = '') => {
  let str = input;
  let output = '';
  for (let block = 0, charCode, i = 0, map = chars;
    str.charAt(i | 0) || (map = '=', i % 1);
    output += map.charAt(63 & block >> 8 - i % 1 * 8)) {
    charCode = str.charCodeAt(i += 3 / 4);
    if (charCode > 0xFF) {
      throw new Error("'btoa' failed");
    }
    block = block << 8 | charCode;
  }
  return output;
};

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

// Square cover (72×72) + radius 8 — audiobook art is square (album-art style)
// and the rest of the app (LibraryScreen list rows, BookCard) renders it
// square. contentFit:"cover" means a square source fills exactly; a rare
// portrait/ebook cover is center-cropped rather than the whole app disagreeing
// on shape.
const COVER_WIDTH = 72;
const COVER_HEIGHT = 72;

// Mirrors $elapsedPretty (see LibraryScreen / ItemDetailScreen).
function elapsedPretty(seconds: number): string {
  if (!seconds || seconds <= 0) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h} hr ${m} min`;
  return `${m} min`;
}

interface MediaProgress {
  progress?: number;
  currentTime?: number;
  isFinished?: boolean;
}

interface SeriesBook {
  id: string;
  mediaType?: string;
  media: {
    metadata: {
      title: string;
      authorName?: string;
    };
    coverPath?: string;
    duration?: number;
    // Format-detection fields consumed by hasAudio()/isEbookOnly()/
    // getEbookFormat() — present on minified (num*) and expanded (arrays)
    // payloads. Without these every row looked ebook-only.
    numTracks?: number;
    numAudioFiles?: number;
    tracks?: any[];
    audioFiles?: any[];
    ebookFormat?: string | null;
    ebookFile?: any;
  };
  sequence?: string | number;
  userMediaProgress?: MediaProgress | null;
  // Recency signals for the re-release dedup tie-break (newest wins when
  // neither candidate has progress or a download).
  addedAt?: number;
  // Download signals — a downloaded copy is preferred as the dedup
  // representative over a non-downloaded re-release.
  isLocal?: boolean;
  localLibraryItem?: any;
}

interface SeriesData {
  id: string;
  name: string;
  description?: string;
  books: SeriesBook[];
}

export default function SeriesDetailScreen({ route, navigation }: any) {
  const colors = useThemeColors();
  const { seriesId, seriesName } = route.params || {};
  const { currentLibraryId } = useLibraryStore();
  const hasSession = usePlaybackStore((state) => state.currentSession !== null);
  const { serverConnectionConfig } = useUserStore();
  const startPlayback = usePlaybackStore((s) => s.startPlayback);
  const loadMediaProgress = useUserStore((s) => s.loadMediaProgress);

  const [series, setSeries] = useState<SeriesData | null>(null);

  const [loading, setLoading] = useState(true);
  const [markingFinished, setMarkingFinished] = useState(false);
  const [resettingProgress, setResettingProgress] = useState(false);
  // Synchronous in-flight guards: the confirm-dialog button can be tapped
  // again before the `saving` STATE re-renders, so guard the batch PATCH with
  // a ref to prevent duplicate submits.
  const markingFinishedRef = useRef(false);
  const resettingProgressRef = useRef(false);

  // Missing-books discovery straight off Audible's catalog API (fast, free) —
  // diffed locally against the library books this screen already loaded.
  // RMAB is only involved when the user taps Request.
  const displayName = series?.name || seriesName;
  const seriesLoading = loading;
  const fetchMissingInSeries = React.useCallback(async () => {
    const {
      audibleSeriesAsinFromBook,
      audibleFindSeriesAsin,
      audibleSeriesBooks,
      buildOwnedTitleMatcher,
    } = require("../utils/audible");
    if (!displayName || seriesLoading) return [];
    // Derive the book list from `series` (a dep — new identity per load)
    // inside the callback: closing over a derived array keyed on .length
    // would go stale on a same-length content change.
    const libraryBooks = series?.books || [];
    const haveAsins = new Set(
      libraryBooks.map((b: any) => b.media?.metadata?.asin).filter(Boolean)
    );
    // Resolve the series ASIN — exact via a library book's ASIN, else by name.
    let seriesAsin: string | null = null;
    // Bounded attempts: each miss costs a round trip, but stopping after 2
    // stranded series whose first books were omnibus/regional editions with
    // no parent relationship — those fell to the fuzzy name search. The whole
    // phase shares one wall-clock budget: 8 sequential attempts against a
    // hanging endpoint (15s each) would otherwise spin for two minutes.
    const resolveDeadline = Date.now() + 20000;
    for (const asin of Array.from(haveAsins).slice(0, 8)) {
      const remaining = resolveDeadline - Date.now();
      if (remaining <= 0) break;
      // Clear the deadline timer once the lookup settles — the race loser
      // would otherwise leave up to 8 stray timers firing later.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        seriesAsin = await Promise.race([
          audibleSeriesAsinFromBook(asin).catch(() => null),
          new Promise<null>((res) => {
            timer = setTimeout(() => res(null), remaining);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (seriesAsin) break;
    }
    if (!seriesAsin) seriesAsin = await audibleFindSeriesAsin(displayName);
    if (!seriesAsin) return [];
    const all = await audibleSeriesBooks(seriesAsin);
    // ASIN-first; the title fallback (for library items without an ASIN or
    // with a regional/edition ASIN skew) must keep distinct volumes distinct —
    // the old pre-colon titleKey diff hid every other "Series: Volume" book
    // the moment you owned one of them. Precomputed key sets keep the diff
    // linear, and the matcher guards the bare-owned-title-is-the-series-name
    // case (owning a bare "Mistborn" must not hide every Mistborn volume).
    const ownedMatches = buildOwnedTitleMatcher(
      libraryBooks.map((b: any) => b.media?.metadata?.title),
      displayName
    );
    const missing = all.filter((b: any) => !haveAsins.has(b.asin) && !ownedMatches(b));
    // Propagate "the catalog fetch was cut short" so the section can disclose
    // a possibly-incomplete list instead of presenting it as the whole series.
    if ((all as any).partial) (missing as any).partial = true;
    return missing;
  }, [displayName, seriesLoading, series]);

  const [error, setError] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [startingId, setStartingId] = useState<string | null>(null);
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);

  const serverAddress = serverConnectionConfig?.address?.replace(/\/$/, "") || "";
  const token = serverConnectionConfig?.token || "";

  const getCoverUrl = (itemId: string) => {
    if (!itemId || !serverAddress || !token) return null;
    return `${serverAddress}/api/items/${itemId}/cover?width=400&format=webp&token=${token}`;
  };

  const loadSeries = React.useCallback(
    async (isRefresh = false) => {
      if (!seriesId || !currentLibraryId) return;
      // Pull-to-refresh keeps the list on screen (no skeleton flip).
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      setError(null);

      try {
        const seriesMetaResponse = await api.get(`/api/series/${seriesId}`).catch(() => null);
        const seriesMeta = seriesMetaResponse?.data || {};

        const itemsResponse = await api.get(
          `/api/libraries/${currentLibraryId}/items?filter=series.${encodeURIComponent(base64Encode(seriesId))}&include=progress`
        );
        const rawResults = itemsResponse.data?.results;
        // One corrupt/null row used to throw here and hide the ENTIRE series
        // behind a misleading "Failed to load series." error.
        const results = (Array.isArray(rawResults) ? rawResults : []).filter(
          (it: any) => it && it.id
        );

        const books: SeriesBook[] = results.map((item: any) => {
          const rawSeries = item.media?.metadata?.series;
          const matchedSeriesObj = Array.isArray(rawSeries)
            ? rawSeries.find((s: any) => s.id === seriesId)
            : rawSeries;
          return {
            id: item.id,
            mediaType: item.mediaType,
            isLocal: item.isLocal,
            localLibraryItem: item.localLibraryItem,
            media: {
              metadata: {
                title: item.media?.metadata?.title || "Untitled",
                authorName: item.media?.metadata?.authorName || "",
                // Audible ASIN (when matched) — powers the missing-books diff.
                asin: item.media?.metadata?.asin || null,
                // Publication year — secondary recency tie-break for the dedup.
                publishedYear: item.media?.metadata?.publishedYear || null,
              },
              coverPath: item.media?.coverPath,
              duration: item.media?.duration || 0,
              // Keep the audio/ebook detection fields — stripping them made
              // isEbookOnly() true for EVERY row (audiobooks got "Read"
              // buttons routed to the Reader, and hideNonAudiobooksGlobal
              // emptied the whole series).
              numTracks: item.media?.numTracks,
              numAudioFiles: item.media?.numAudioFiles,
              tracks: item.media?.tracks,
              audioFiles: item.media?.audioFiles,
              ebookFormat: item.media?.ebookFormat,
              ebookFile: item.media?.ebookFile,
            },
            sequence: matchedSeriesObj?.sequence ?? "",
            userMediaProgress: item.userMediaProgress || null,
            addedAt: Number(item.addedAt) || 0,
          };
        });

        // Collapse re-releases: two catalog editions of the same entry share a
        // sequence but have different item ids, so both used to render. Group
        // by the normalized non-empty sequence and keep ONE representative,
        // preferring (1) the copy with listening progress, (2) a downloaded
        // copy, then (3) the newest (addedAt, then publishedYear). Blank/
        // whitespace sequences are never collapsed — each stays its own entry.
        const progressStore = useUserStore.getState().mediaProgress || {};
        const hasProgress = (b: SeriesBook) => {
          const p = progressStore[b.id] || b.userMediaProgress;
          return !!(p && (p.isFinished || (p.progress || 0) > 0));
        };
        const isDownloaded = (b: SeriesBook) =>
          !!((b as any).isLocal || (b as any).localLibraryItem);
        const recency = (b: SeriesBook) =>
          b.addedAt || Number((b.media?.metadata as any)?.publishedYear) || 0;
        const repScore = (b: SeriesBook) => (hasProgress(b) ? 2 : 0) + (isDownloaded(b) ? 1 : 0);
        const seqKey = (b: SeriesBook): string | null => {
          const raw = String(b.sequence ?? "").trim();
          if (!raw) return null; // blank → keep un-collapsed
          const n = parseFloat(raw);
          return Number.isNaN(n) ? raw.toLowerCase() : String(n);
        };

        // Track each collapsed sequence's chosen representative together with
        // its slot in `deduped`, so replacing a worse pick is O(1) instead of
        // an indexOf scan.
        const groups = new Map<string, { book: SeriesBook; index: number }>();
        const deduped: SeriesBook[] = [];
        for (const b of books) {
          const key = seqKey(b);
          if (key === null) {
            deduped.push(b);
            continue;
          }
          const current = groups.get(key);
          if (!current) {
            groups.set(key, { book: b, index: deduped.length });
            deduped.push(b);
            continue;
          }
          // A better representative replaces the one already placed.
          const sc = repScore(b);
          const scCur = repScore(current.book);
          const better = sc !== scCur ? sc > scCur : recency(b) > recency(current.book);
          if (better) {
            deduped[current.index] = b;
            current.book = b;
          }
        }
        books.length = 0;
        books.push(...deduped);

        books.sort((a, b) => {
          const seqA = parseFloat(String(a.sequence)) || 0;
          const seqB = parseFloat(String(b.sequence)) || 0;
          if (seqA !== seqB) return seqA - seqB;
          return String(a.sequence).localeCompare(String(b.sequence));
        });

        setSeries({
          id: seriesId,
          name: seriesMeta.name || seriesName || "Unknown Series",
          description: seriesMeta.description || "",
          books,
        });
      } catch (err) {
        console.error("[SeriesDetailScreen] Failed to fetch series books:", err);
        setError("Failed to load series.");
      } finally {
        if (isRefresh) setRefreshing(false);
        else setLoading(false);
      }
    },
    [seriesId, currentLibraryId, seriesName]
  );

  useEffect(() => {
    loadSeries();
  }, [loadSeries, retryTick]);

  // "Hide non-audiobooks": ebook-only rows are dropped when the setting is on.
  const hideNonAudiobooks = useUserStore((s) => !!s.settings?.hideNonAudiobooksGlobal);
  const books = (series?.books || []).filter((b: any) => !hideNonAudiobooks || !isEbookOnly(b));
  const bookCount = books.length;
  const totalDuration = books.reduce((t, b) => t + (b.media?.duration || 0), 0);
  // Progress from the global map — the items payload carries no
  // userMediaProgress (the server ignores include=progress on this endpoint),
  // so relying on it alone made "Play all" always restart book 1 and the
  // finished count always read 0. Keep the payload field as a fallback.
  const progressMap = useUserStore((s) => s.mediaProgress);
  const progressOf = (b: any) => progressMap[b.id] || b.userMediaProgress;
  const finishedCount = books.filter((b) => progressOf(b)?.isFinished).length;
  const anyProgress = books.some(
    (b) => progressOf(b)?.isFinished || (progressOf(b)?.progress || 0) > 0
  );

  // First unfinished book in sequence order — what the header button starts.
  const nextUnfinished = books.find((b) => !progressOf(b)?.isFinished) || books[0];

  // Batch progress over the whole series, via the batch progress endpoint whose
  // body is a BARE ARRAY of progress payloads (one PATCH for N books). Managing
  // your own progress needs no admin gate — any logged-in user can do it.
  const unfinishedBooks = books.filter((b) => !progressOf(b)?.isFinished);
  const booksWithProgress = books.filter(
    (b) => progressOf(b)?.isFinished || (progressOf(b)?.progress || 0) > 0
  );

  // Recompute the batch targets from the LATEST progress map at confirm time —
  // the dialog can sit open while a background sync changes progress, so the
  // render-time lists above are only the preview; the payload must not be stale.
  const freshTargets = () => {
    const map = useUserStore.getState().mediaProgress || {};
    const pOf = (b: any) => map[b.id] || b.userMediaProgress;
    return {
      unfinished: books.filter((b) => !pOf(b)?.isFinished),
      withProgress: books.filter(
        (b) => pOf(b)?.isFinished || (pOf(b)?.progress || 0) > 0
      ),
    };
  };

  // Refresh the authoritative progress map (drives header stats + row badges)
  // and silently revalidate the series payload after a batch mutation.
  const refreshAfterBatch = () => {
    loadMediaProgress().catch(() => {});
    loadSeries(true).catch(() => {});
  };

  const handleMarkSeriesFinished = () => {
    const count = unfinishedBooks.length;
    if (count === 0) {
      showSnackbar({ message: "Every book in this series is already finished." });
      return;
    }
    showAppDialog({
      title: "Mark series as finished?",
      message: `${count} ${count === 1 ? "book" : "books"} in "${
        series?.name || "this series"
      }" will be marked as finished.`,
      buttons: [
        { text: "Cancel", style: "cancel" },
        {
          text: "Mark finished",
          onPress: async () => {
            if (markingFinishedRef.current) return;
            markingFinishedRef.current = true;
            setMarkingFinished(true);
            try {
              const targets = freshTargets().unfinished;
              if (targets.length === 0) {
                showSnackbar({ message: "Every book in this series is already finished." });
                return;
              }
              await batchUpdateProgress(
                targets.map((b) => ({ libraryItemId: b.id, isFinished: true }))
              );
              const n = targets.length;
              showSnackbar({
                message: `${n} ${n === 1 ? "book" : "books"} marked finished`,
              });
              refreshAfterBatch();
            } catch (e: any) {
              showAppDialog({
                title: "Couldn't mark as finished",
                message: e?.message || "Something went wrong. Please try again.",
              });
            } finally {
              setMarkingFinished(false);
              markingFinishedRef.current = false;
            }
          },
        },
      ],
    });
  };

  const handleResetSeriesProgress = () => {
    const count = booksWithProgress.length;
    if (count === 0) {
      showSnackbar({ message: "No progress to reset in this series." });
      return;
    }
    showAppDialog({
      title: "Reset series progress?",
      message: `Progress on ${count} ${count === 1 ? "book" : "books"} in "${
        series?.name || "this series"
      }" will be reset to not started. This can't be undone.`,
      buttons: [
        { text: "Cancel", style: "cancel" },
        {
          text: "Reset",
          style: "destructive",
          onPress: async () => {
            if (resettingProgressRef.current) return;
            resettingProgressRef.current = true;
            setResettingProgress(true);
            try {
              const targets = freshTargets().withProgress;
              if (targets.length === 0) {
                showSnackbar({ message: "No progress to reset in this series." });
                return;
              }
              await batchUpdateProgress(
                targets.map((b) => ({
                  libraryItemId: b.id,
                  isFinished: false,
                  currentTime: 0,
                  progress: 0,
                }))
              );
              const n = targets.length;
              showSnackbar({
                message: `Progress reset on ${n} ${n === 1 ? "book" : "books"}`,
              });
              refreshAfterBatch();
            } catch (e: any) {
              showAppDialog({
                title: "Couldn't reset progress",
                message: e?.message || "Something went wrong. Please try again.",
              });
            } finally {
              setResettingProgress(false);
              resettingProgressRef.current = false;
            }
          },
        },
      ],
    });
  };

  const handlePlay = async (item?: SeriesBook) => {
    if (!item || startingId) return;
    // Ebook-only entries have nothing to play — open the Reader instead of
    // letting startPlayback silently no-op on an audio-less session.
    if (isEbookOnly(item)) {
      navigation.navigate("Reader", {
        itemId: item.id,
        ebookFormat: getEbookFormat(item),
        title: (item as any).media?.metadata?.title,
      });
      return;
    }
    setStartingId(item.id);
    try {
      await startPlayback(item.id);
    } finally {
      setStartingId(null);
    }
  };

  const collageCovers = books
    .slice(0, 4)
    .map((b) => getCoverUrl(b.id))
    .filter(Boolean) as string[];

  const renderBookRow = ({ item, index }: { item: SeriesBook; index: number }) => {
    const coverUri = getCoverUrl(item.id);
    const rawTitle = item.media?.metadata?.title || "Untitled";
    const author = item.media?.metadata?.authorName || "";
    const sequence = item.sequence;
    const duration = item.media?.duration || 0;

    // "#N Title" — sequence prefix mirrors the original series detail list.
    const title =
      sequence != null && sequence !== "" ? `#${sequence} ${rawTitle}` : rawTitle;

    const startingThis = startingId === item.id;
    const downloaded = (item as any).isLocal || !!(item as any).localLibraryItem;

    // The accessible parent row collapses the nested play button, so TalkBack
    // can't reach the primary Play action through it. Give the row an explicit
    // composed label (title + author + progress status) AND expose play as an
    // accessibility action so the primary action stays reachable; the visible
    // nested button remains the pointer path for sighted users.
    const rowA11yLabel = [title, author, bookStatusA11yLabel(item, progressMap, downloaded)]
      .filter(Boolean)
      .join(". ");

    return (
      <AnimatedPressable
        entering={listRowEnter(index)}
        onPress={() => navigation.navigate("ItemDetail", { itemId: item.id })}
        accessibilityRole="button"
        accessibilityLabel={rowA11yLabel}
        accessibilityActions={[{ name: "play", label: isEbookOnly(item) ? "Read" : "Play" }]}
        onAccessibilityAction={(e) => {
          if (e.nativeEvent.actionName === "play") handlePlay(item);
        }}
        android_ripple={{ color: colors.surfaceContainerHighest }}
        style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 8 }}
      >
        {/* Cover */}
        <View
          style={{
            width: COVER_WIDTH,
            height: COVER_HEIGHT,
            borderRadius: 8,
            overflow: "hidden",
            backgroundColor: colors.surfaceContainerHigh,
          }}
        >
          {coverUri ? (
            <Image
              source={coverSource(coverUri)}
              style={{ width: COVER_WIDTH, height: COVER_HEIGHT }}
              contentFit="cover"
            />
          ) : (
            <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
              <Icon name="book" size={28} color={colors.onSurfaceVariant} />
            </View>
          )}
        </View>

        {/* Title / author / duration / progress badge */}
        <View style={{ flex: 1, minWidth: 0, marginLeft: 14, paddingRight: 8 }}>
          <Text
            numberOfLines={2}
            style={{ color: colors.onSurface, fontSize: 15, fontWeight: "600", lineHeight: 20 }}
          >
            {title}
          </Text>
          {author ? (
            <Text numberOfLines={1} style={{ color: colors.onSurfaceVariant, fontSize: 13, marginTop: 2 }}>
              {author}
            </Text>
          ) : null}
          {duration > 0 ? (
            <Text style={{ color: colors.onSurfaceVariant, fontSize: 12, marginTop: 2 }}>
              {elapsedPretty(duration)}
            </Text>
          ) : null}
          <BookProgressBadge
            itemId={item.id}
            item={item}
            downloaded={(item as any).isLocal || !!(item as any).localLibraryItem}
            style={{ marginTop: 4 }}
          />
        </View>

        {/* pine-green circular play (matches playlist rows); ebook-only rows
            open the Reader instead */}
        <Pressable
          onPress={() => handlePlay(item)}
          hitSlop={6}
          android_ripple={{ color: withAlpha(colors.onPrimary, 0.2), radius: 24 }}
          accessibilityRole="button"
          accessibilityLabel={`${isEbookOnly(item) ? "Read" : "Play"} ${rawTitle}`}
          style={{
            width: 48,
            height: 48,
            borderRadius: 24,
            overflow: "hidden",
            backgroundColor: startingThis ? colors.surfaceVariant : colors.primary,
            alignItems: "center",
            justifyContent: "center",
            marginLeft: 8,
            elevation: 2,
            shadowColor: "#000",
            shadowOffset: { width: 0, height: 1 },
            shadowOpacity: 0.2,
            shadowRadius: 2,
          }}
        >
          {startingThis ? (
            <ActivityIndicator size="small" color={colors.onSurfaceVariant} />
          ) : (
            <Icon name={isEbookOnly(item) ? "book" : "play"} size={isEbookOnly(item) ? 22 : 26} color={colors.onPrimary} />
          )}
        </Pressable>
      </AnimatedPressable>
    );
  };

  // Hero header: collage + name + counts + continue/play — mirrors the
  // playlist detail layout, plus the series description when the server has
  // one (long ones collapse to 4 lines, tap to expand).
  const ListHeader = (
    <View>
      <View style={{ flexDirection: "row", paddingHorizontal: 16, paddingTop: 20, paddingBottom: 16 }}>
        <SeriesCollage covers={collageCovers} size={120} colors={colors} />
        <View style={{ flex: 1, marginLeft: 16, justifyContent: "center" }}>
          <Text style={{ color: colors.onSurface, fontSize: 22, fontWeight: "800" }} numberOfLines={3}>
            {series?.name || "Series"}
          </Text>
          <Text style={{ color: colors.onSurfaceVariant, fontSize: 14, marginTop: 4 }}>
            {bookCount} {bookCount === 1 ? "book" : "books"}
            {totalDuration ? `  ·  ${elapsedPretty(totalDuration)}` : ""}
          </Text>
          {finishedCount > 0 ? (
            <Text style={{ color: colors.onSurfaceVariant, fontSize: 13, marginTop: 2 }}>
              {finishedCount} of {bookCount} finished
            </Text>
          ) : null}
          {bookCount > 0 ? (
            <Pressable
              onPress={() => handlePlay(nextUnfinished)}
              disabled={!!startingId}
              accessibilityRole="button"
              accessibilityState={{ disabled: !!startingId, busy: !!startingId }}
              accessibilityLabel={
                startingId ? "Starting playback" : anyProgress ? "Continue" : "Play all"
              }
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                alignSelf: "flex-start",
                marginTop: 14,
                paddingHorizontal: 20,
                paddingVertical: 10,
                borderRadius: 24,
                backgroundColor: colors.primary,
                opacity: startingId ? 0.6 : 1,
              }}
            >
              {startingId === nextUnfinished?.id ? (
                <ActivityIndicator size="small" color={colors.onPrimary} />
              ) : (
                <>
                  <Icon name="play" size={20} color={colors.onPrimary} />
                  <Text style={{ color: colors.onPrimary, fontSize: 15, fontWeight: "600", marginLeft: 6 }}>
                    {anyProgress ? "Continue" : "Play all"}
                  </Text>
                </>
              )}
            </Pressable>
          ) : null}
        </View>
      </View>

      {series?.description ? (
        <Pressable
          onPress={() => setDescriptionExpanded((v) => !v)}
          accessibilityRole="button"
          accessibilityState={{ expanded: descriptionExpanded }}
          accessibilityLabel={descriptionExpanded ? "Collapse description" : "Expand description"}
          style={{ paddingHorizontal: 16, paddingBottom: 12 }}
        >
          <Text
            numberOfLines={descriptionExpanded ? undefined : 4}
            style={{ color: colors.onSurface, fontSize: 14, lineHeight: 20 }}
          >
            {series.description}
          </Text>
          {series.description.length > 220 ? (
            <Text style={{ color: colors.primary, fontSize: 13, fontWeight: "600", marginTop: 4 }}>
              {descriptionExpanded ? "Show less" : "Show more"}
            </Text>
          ) : null}
        </Pressable>
      ) : null}

      <View style={{ height: 1, backgroundColor: colors.outlineVariant, marginHorizontal: 16, marginBottom: 6 }} />
    </View>
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }} edges={["top", "left", "right"]}>
      {/* Header bar (matches playlist detail) */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 16,
          paddingVertical: 14,
          borderBottomWidth: 1,
          borderBottomColor: colors.outlineVariant,
        }}
      >
        <Pressable
          onPress={() => navigation.goBack()}
          hitSlop={8}
          android_ripple={{ color: colors.surfaceContainerHighest, borderless: true, radius: 22 }}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={{ marginRight: 12, padding: 8, borderRadius: 20 }}
        >
          <Icon name="back" size={20} color={colors.onSurface} />
        </Pressable>
        <Text numberOfLines={1} style={{ flex: 1, color: colors.onSurface, fontSize: 20, fontWeight: "700" }}>
          {series?.name || seriesName || "Series"}
        </Text>
        {series && bookCount > 0 ? (
          <>
            <Pressable
              onPress={handleMarkSeriesFinished}
              disabled={markingFinished}
              hitSlop={8}
              android_ripple={{ color: colors.surfaceContainerHighest, borderless: true, radius: 22 }}
              accessibilityRole="button"
              accessibilityLabel="Mark series as finished"
              accessibilityHint="Marks every book in this series as finished"
              accessibilityState={{ disabled: markingFinished, busy: markingFinished }}
              style={{ marginLeft: 8, padding: 8, borderRadius: 20, opacity: markingFinished ? 0.5 : 1 }}
            >
              <Icon name="check" size={20} color={colors.onSurfaceVariant} />
            </Pressable>
            <Pressable
              onPress={handleResetSeriesProgress}
              disabled={resettingProgress}
              hitSlop={8}
              android_ripple={{ color: colors.surfaceContainerHighest, borderless: true, radius: 22 }}
              accessibilityRole="button"
              accessibilityLabel="Reset series progress"
              accessibilityHint="Resets progress on every book in this series to not started"
              accessibilityState={{ disabled: resettingProgress, busy: resettingProgress }}
              style={{ marginLeft: 8, padding: 8, borderRadius: 20, opacity: resettingProgress ? 0.5 : 1 }}
            >
              <Icon name="undo" size={20} color={colors.error} />
            </Pressable>
          </>
        ) : null}
      </View>

      {loading ? (
        <ListSkeleton rows={7} thumb={COVER_WIDTH} />
      ) : error ? (
        <ErrorState
          message={error}
          onRetry={() => setRetryTick((t) => t + 1)}
          style={{ flex: 1 }}
        />
      ) : bookCount === 0 ? (
        // Even with nothing owned in this series, still offer the missing-books
        // discovery/Request affordance below the empty state.
        <ScrollView contentContainerStyle={{ flexGrow: 1 }} showsVerticalScrollIndicator={false}>
          <EmptyState
            icon="series"
            title="No books in this series"
            message="Books in this series will appear here once they're in your library."
          />
          <RmabMissingSection title="Missing from this series" fetchMissing={fetchMissingInSeries} />
        </ScrollView>
      ) : (
        <FlatList
          data={books}
          renderItem={renderBookRow}
          keyExtractor={(item) => item.id}
          ListHeaderComponent={ListHeader}
          ListFooterComponent={
            <RmabMissingSection title="Missing from this series" fetchMissing={fetchMissingInSeries} />
          }
          contentContainerStyle={{ paddingBottom: hasSession ? 100 : 32 }}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => loadSeries(true)}
              colors={[colors.primary]}
              progressBackgroundColor={colors.surfaceContainerHigh}
            />
          }
        />
      )}
    </SafeAreaView>
  );
}

// Rounded collage over primary bg: single fills, else up-to-4 grid.
// (Same treatment as the playlist detail collage.)
function SeriesCollage({ covers, size, colors }: { covers: string[]; size: number; colors: any }) {
  return (
    <View style={{ width: size, height: size, borderRadius: 14, overflow: "hidden", backgroundColor: colors.primary }}>
      {covers.length === 0 ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <Icon name="series" size={28} color={colors.onPrimary} />
        </View>
      ) : covers.length === 1 ? (
        <Image source={coverSource(covers[0])} style={{ width: size, height: size }} contentFit="cover" />
      ) : (
        <View style={{ flexDirection: "row", flexWrap: "wrap", width: size, height: size }}>
          {covers.slice(0, 4).map((uri, idx) => (
            <Image
              key={idx}
              source={coverSource(uri)}
              style={{ width: size / 2, height: covers.length <= 2 ? size : size / 2 }}
              contentFit="cover"
            />
          ))}
        </View>
      )}
    </View>
  );
}
