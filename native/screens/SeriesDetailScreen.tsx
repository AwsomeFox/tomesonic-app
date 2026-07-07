import React, { useEffect, useState } from "react";
import { View, Text, FlatList, Pressable, ActivityIndicator } from "react-native";
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
import Icon from "../components/Icon";
import { isEbookOnly, getEbookFormat } from "../utils/bookMatch";
import BookProgressBadge from "../components/BookProgressBadge";
import { ListSkeleton } from "../components/Skeleton";
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

  const [series, setSeries] = useState<SeriesData | null>(null);

  const [loading, setLoading] = useState(true);

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
  const [startingId, setStartingId] = useState<string | null>(null);
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);

  const serverAddress = serverConnectionConfig?.address?.replace(/\/$/, "") || "";
  const token = serverConnectionConfig?.token || "";

  const getCoverUrl = (itemId: string) => {
    if (!itemId || !serverAddress || !token) return null;
    return `${serverAddress}/api/items/${itemId}/cover?width=400&format=webp&token=${token}`;
  };

  useEffect(() => {
    const fetchSeriesDetail = async () => {
      if (!seriesId || !currentLibraryId) return;
      setLoading(true);
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
            media: {
              metadata: {
                title: item.media?.metadata?.title || "Untitled",
                authorName: item.media?.metadata?.authorName || "",
                // Audible ASIN (when matched) — powers the missing-books diff.
                asin: item.media?.metadata?.asin || null,
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
          };
        });

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
        setLoading(false);
      }
    };

    fetchSeriesDetail();
  }, [seriesId, currentLibraryId, retryTick]);

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

    return (
      <AnimatedPressable
        entering={listRowEnter(index)}
        onPress={() => navigation.navigate("ItemDetail", { itemId: item.id })}
        accessibilityRole="button"
        android_ripple={{ color: colors.surfaceContainerHighest }}
        style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 8 }}
      >
        {/* Cover */}
        <View
          style={{
            width: COVER_WIDTH,
            height: COVER_HEIGHT,
            borderRadius: 12,
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
      </View>

      {loading ? (
        <ListSkeleton rows={7} thumb={72} />
      ) : error ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
          <Icon name="warning" size={40} color={colors.onSurfaceVariant} style={{ marginBottom: 12 }} />
          <Text style={{ color: colors.onSurfaceVariant, fontSize: 15, textAlign: "center" }}>{error}</Text>
          <Pressable
            onPress={() => setRetryTick((t) => t + 1)}
            android_ripple={{ color: withAlpha(colors.onPrimary, 0.2) }}
            accessibilityRole="button"
            accessibilityLabel="Retry loading series"
            style={{ marginTop: 20, paddingHorizontal: 24, paddingVertical: 10, borderRadius: 24, overflow: "hidden", backgroundColor: colors.primary }}
          >
            <Text style={{ color: colors.onPrimary, fontSize: 15, fontWeight: "600" }}>Retry</Text>
          </Pressable>
        </View>
      ) : bookCount === 0 ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 32 }}>
          <Icon name="series" size={48} color={colors.onSurfaceVariant} />
          <Text style={{ color: colors.onSurface, fontSize: 16, fontWeight: "bold", marginTop: 16 }}>
            No books in this series
          </Text>
        </View>
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
              source={{ uri }}
              style={{ width: size / 2, height: covers.length <= 2 ? size : size / 2 }}
              contentFit="cover"
            />
          ))}
        </View>
      )}
    </View>
  );
}
