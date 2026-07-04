import React, { useEffect, useState, useCallback, useRef } from "react";
import { View, Text, FlatList, Image, Pressable, ActivityIndicator } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Animated, { FadeIn } from "react-native-reanimated";
import { api } from "../utils/api";
import { useLibraryStore } from "../store/useLibraryStore";
import { useUserStore } from "../store/useUserStore";
import { usePlaybackStore } from "../store/usePlaybackStore";
import { useDownloadStore } from "../store/useDownloadStore";
import { useThemeColors } from "../theme/useThemeColors";
import TopAppBar from "../components/TopAppBar";
import Icon from "../components/Icon";
import BookProgressBadge from "../components/BookProgressBadge";
import { useUiStore } from "../store/useUiStore";
import SearchContent from "../components/SearchContent";
import { ListSkeleton } from "../components/Skeleton";
import { hasAudio, hasEbook as itemHasEbook, getEbookFormat } from "../utils/bookMatch";
import FilterModal from "../components/FilterModal";
import OrderModal from "../components/OrderModal";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

// list-card-cover: 80px tall, cover width derived from aspect ratio (80 / 1 for square,
// but book aspect is ~1.6 -> width 80/1.6 = 50). Original --list-card-cover-width default 80.
const COVER_HEIGHT = 80;
const COVER_WIDTH = 80;
const PAGE_LIMIT = 25;

interface LibraryItem {
  id: string;
  addedAt?: number;
  numTracks?: number;
  mediaType?: string;
  media: {
    metadata: {
      title: string;
      authorName?: string;
    };
    coverPath?: string;
    duration?: number;
  };
}

// Mirrors $elapsedPretty
function elapsedPretty(seconds: number): string {
  if (!seconds || seconds <= 0) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h} hr ${m} min`;
  return `${m} min`;
}

// Mirrors displaySortLine for orderBy === 'addedAt' -> $getString('LabelAddedDate', [$formatDate(addedAt)])
function formatAdded(ms?: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `Added ${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

export default function LibraryScreen({ route, navigation }: any) {
  const colors = useThemeColors();
  const isSearchActive = useUiStore((s) => s.isSearchActive);
  const { currentLibraryId } = useLibraryStore();
  const { serverConnectionConfig } = useUserStore();
  const startPlayback = usePlaybackStore((s) => s.startPlayback);
  const hasSession = usePlaybackStore((s) => s.currentSession !== null);
  const mediaProgress = useUserStore((s) => s.mediaProgress);
  const hideNonAudiobooks = useUserStore((s) => s.settings?.hideNonAudiobooksGlobal);
  const completedDownloads = useDownloadStore((s) => s.completedDownloads);

  const [items, setItems] = useState<LibraryItem[]>([]);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [startingId, setStartingId] = useState<string | null>(null);
  const isFetchingRef = useRef(false);
  const fetchIdRef = useRef(0);
  const routeFilter = route.params?.filter;

  // Filter / sort state (raw query values matching the original app).
  const [filterBy, setFilterBy] = useState(routeFilter || "all");
  const [orderBy, setOrderBy] = useState("addedAt");
  const [descending, setDescending] = useState(true);
  const [filterOpen, setFilterOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);

  useEffect(() => {
    if (routeFilter) {
      setFilterBy(routeFilter);
    }
  }, [routeFilter]);

  const serverAddress = serverConnectionConfig?.address?.replace(/\/$/, "") || "";
  const token = serverConnectionConfig?.token || "";

  const getCoverUrl = (itemId: string) => {
    if (!itemId || !serverAddress || !token) return null;
    return `${serverAddress}/api/items/${itemId}/cover?token=${token}`;
  };

  const fetchItems = useCallback(
    async (pageNum: number, reset = false) => {
      if (!currentLibraryId) return;
      if (!reset && isFetchingRef.current) return;

      const currentFetchId = ++fetchIdRef.current;
      isFetchingRef.current = true;
      if (reset) setInitialLoading(true);
      setLoading(true);

      try {
        // filterBy holds the raw query value ("all" = no filter; sublist values
        // are already $encode'd). sort/desc mirror the original items endpoint.
        const params = [
          "minified=1",
          `limit=${PAGE_LIMIT}`,
          `page=${pageNum}`,
          `sort=${encodeURIComponent(orderBy)}`,
          `desc=${descending ? 1 : 0}`,
        ];
        if (filterBy && filterBy !== "all") params.push(`filter=${filterBy}`);
        const response = await api.get(
          `/api/libraries/${currentLibraryId}/items?${params.join("&")}`
        );

        if (currentFetchId !== fetchIdRef.current) return;

        const data = response.data || {};
        let results: LibraryItem[] = data.results || [];
        // "Hide non-audiobooks globally": drop items that have no audio (e.g.
        // ebook-only entries) when the setting is on.
        if (useUserStore.getState().settings?.hideNonAudiobooksGlobal) {
          results = results.filter((it: any) => {
            const m = it?.media;
            return (m?.numAudioFiles ?? 0) > 0 || (m?.duration ?? 0) > 0 || (m?.numTracks ?? 0) > 0;
          });
        }
        setTotal(data.total || 0);
        setItems((prev) => (reset ? results : [...prev, ...results]));
        setPage(pageNum);
      } catch (err) {
        if (currentFetchId === fetchIdRef.current) {
          console.error("[LibraryScreen] Failed to fetch items:", err);
        }
      } finally {
        if (currentFetchId === fetchIdRef.current) {
          setLoading(false);
          setInitialLoading(false);
          isFetchingRef.current = false;
        }
      }
    },
    [currentLibraryId, filterBy, orderBy, descending, hideNonAudiobooks]
  );

  useEffect(() => {
    setItems([]);
    setPage(0);
    setTotal(0);
    fetchItems(0, true);
  }, [currentLibraryId, fetchItems]);

  const handleLoadMore = () => {
    if (loading || items.length >= total) return;
    fetchItems(page + 1);
  };

  const handlePlay = async (item: LibraryItem) => {
    if (startingId) return;
    setStartingId(item.id);
    try {
      const ok = await startPlayback(item.id);
      if (ok) navigation.navigate("Player");
    } finally {
      setStartingId(null);
    }
  };

  const handleReadRow = (item: LibraryItem) => {
    navigation.navigate("Reader", {
      itemId: item.id,
      ebookFormat: getEbookFormat(item),
      title: item.media?.metadata?.title,
    });
  };

  const renderItem = ({ item, index }: { item: LibraryItem; index: number }) => {
    const coverUri = getCoverUrl(item.id);
    const title = item.media?.metadata?.title || "Untitled";
    const author = item.media?.metadata?.authorName || "Unknown";
    const sortLine = formatAdded(item.addedAt);
    const firstSeries = (item.media?.metadata as any)?.series?.[0];
    const seriesText = firstSeries
      ? (firstSeries.sequence ? `${firstSeries.name} #${firstSeries.sequence}` : firstSeries.name)
      : null;
    // Action button: Play for audiobooks, Read for ebook-only items (no audio),
    // nothing for podcasts.
    const isPodcast = item.mediaType === "podcast";
    const rowHasAudio = hasAudio(item);
    const rowHasEbook = itemHasEbook(item);
    const isEbookOnly = !rowHasAudio && rowHasEbook;
    const showPlayButton = !isPodcast && (rowHasAudio || isEbookOnly);
    const startingThis = startingId === item.id;

    // Check if progress/download status is active
    const progress = (item as any).userMediaProgress || (item as any).progress || mediaProgress[item.id] || null;
    const isFinished = !!progress?.isFinished;
    const durationSecs = Number(item.media?.duration || progress?.duration || 0);
    const progressPercent = Math.max(
      Math.min(1, progress?.progress ?? (durationSecs > 0 ? (progress?.currentTime || 0) / durationSecs : 0)),
      0
    );
    const isInProgress = progressPercent > 0 && !isFinished;
    const isLocal = (item as any).isLocal || !!(item as any).localLibraryItem || !!completedDownloads[item.id];
    const hasBadge = isLocal || isFinished || isInProgress;

    return (
      // material-3-list-card embedded-list-row z-10 cursor-pointer py-1 px-2 mx-0
      <AnimatedPressable
        entering={FadeIn.delay(Math.min(index * 20, 200)).duration(250)}
        onPress={() => navigation.navigate("ItemDetail", { itemId: item.id })}
        android_ripple={{ color: colors.surfaceContainerHighest }}
        style={{ zIndex: 10, paddingVertical: 12, paddingHorizontal: 12 }}
      >
        {/* h-full flex items-center relative */}
        <View style={{ flexDirection: "row", alignItems: "center", position: "relative" }}>
          {/* list-card-cover relative — 80px tall, rounded-xl, overflow-hidden */}
          <View
            style={{
              position: "relative",
              borderRadius: 12,
              overflow: "hidden",
              backgroundColor: colors.surfaceContainer,
              width: COVER_WIDTH,
              height: COVER_HEIGHT,
            }}
          >
            {coverUri ? (
              <Image
                source={{ uri: coverUri }}
                style={{ width: COVER_WIDTH, height: COVER_HEIGHT }}
                resizeMode="cover"
              />
            ) : (
              // Material Symbol placeholder — bg-surface-container, book icon
              <View style={{ width: "100%", height: "100%", alignItems: "center", justifyContent: "center" }}>
                <Icon name="book" size={34} color={colors.onSurfaceVariant} />
              </View>
            )}
          </View>

          {/* flex-grow min-w-0 pl-4 pr-20 (room for play button) */}
          <View style={{ flex: 1, minWidth: 0, paddingLeft: 16, paddingRight: showPlayButton ? 80 : 16 }}>
            {/* Title: truncate text-on-surface text-body-medium font-medium */}
            <Text numberOfLines={1} ellipsizeMode="tail" style={{ color: colors.onSurface, fontSize: 16, fontWeight: "500" }}>
              {title}
            </Text>
            {/* Author: truncate text-on-surface-variant text-body-small */}
            <Text numberOfLines={1} style={{ color: colors.onSurfaceVariant, fontSize: 12 }}>
              {author}
            </Text>
            {/* displaySortLine / progress indicator */}
            {hasBadge ? (
              <BookProgressBadge
                itemId={item.id}
                downloaded={isLocal}
                style={{ marginTop: 4 }}
              />
            ) : sortLine ? (
              <Text numberOfLines={1} style={{ color: colors.onSurfaceVariant, fontSize: 12, marginTop: 2 }}>
                {sortLine}
              </Text>
            ) : null}
            {/* series information and number */}
            {seriesText ? (
              <Text numberOfLines={1} ellipsizeMode="tail" style={{ color: colors.onSurfaceVariant, fontSize: 12, marginTop: 2 }}>
                {seriesText}
              </Text>
            ) : null}
          </View>

          {/* Play button — vertically centered, right-4, 56dp rounded-full pine-green w/ elevation */}
          {showPlayButton ? (
            <View style={{ position: "absolute", right: 16, alignItems: "center", justifyContent: "center", zIndex: 20, top: 0, bottom: 0 }}>
              <Pressable
                onPress={() => (isEbookOnly ? handleReadRow(item) : handlePlay(item))}
                hitSlop={6}
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: 28,
                  alignItems: "center",
                  justifyContent: "center",
                  elevation: 2,
                  backgroundColor: startingThis ? colors.surfaceVariant : colors.primary,
                }}
              >
                {startingThis ? (
                  <ActivityIndicator size="small" color={colors.onSurfaceVariant} />
                ) : (
                  <Icon name={isEbookOnly ? "book" : "play"} size={isEbookOnly ? 26 : 30} color={colors.onPrimary} />
                )}
              </Pressable>
            </View>
          ) : null}
        </View>
      </AnimatedPressable>
    );
  };

  const renderFooter = () => {
    if (!loading || initialLoading) return null;
    return (
      <View style={{ paddingVertical: 20, alignItems: "center" }}>
        <ActivityIndicator size="small" color={colors.primary} />
      </View>
    );
  };

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: colors.surface }}
      edges={["top", "left", "right"]}
    >
      <TopAppBar
        navigation={navigation}
        showBack={route.params?.showBack}
        title={route.params?.title}
        showFilter
        showSort
        onFilter={() => setFilterOpen(true)}
        onSort={() => setSortOpen(true)}
      />

      <FilterModal
        visible={filterOpen}
        onClose={() => setFilterOpen(false)}
        filterBy={filterBy}
        onChange={setFilterBy}
      />
      <OrderModal
        visible={sortOpen}
        onClose={() => setSortOpen(false)}
        orderBy={orderBy}
        descending={descending}
        onChange={(o, d) => {
          setOrderBy(o);
          setDescending(d);
        }}
      />

      {isSearchActive ? (
        <SearchContent navigation={navigation} />
      ) : initialLoading ? (
        <ListSkeleton rows={9} />
      ) : items.length === 0 ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 32 }}>
          <Icon name="library" size={48} color={colors.onSurfaceVariant} />
          <Text style={{ color: colors.onSurface, fontSize: 22, fontWeight: "bold", marginTop: 16, marginBottom: 8 }}>
            No items found
          </Text>
          <Text style={{ color: colors.onSurfaceVariant, fontSize: 14, textAlign: "center" }}>
            Your library is empty. Add some audiobooks to get started.
          </Text>
        </View>
      ) : (
        <FlatList
          data={items}
          renderItem={renderItem}
          keyExtractor={(item) => item.id}
          // Generous spacing, no hard dividers (matches screenshot 05)
          contentContainerStyle={{ paddingBottom: hasSession ? 100 : 32, paddingTop: 4 }}
          onEndReached={handleLoadMore}
          onEndReachedThreshold={3.0}
          ListFooterComponent={renderFooter}
          showsVerticalScrollIndicator={false}
        />
      )}
    </SafeAreaView>
  );
}
