import React, { useEffect, useState, useCallback, useRef, forwardRef, useImperativeHandle } from "react";
import { View, Text, FlatList, Pressable, ActivityIndicator, RefreshControl } from "react-native";
import { Image } from "expo-image";
import { coverSource } from "../utils/coverSource";
import { SafeAreaView } from "react-native-safe-area-context";
import Animated from "react-native-reanimated";
import { listRowEnter } from "../theme/motion";
import { withAlpha } from "../theme/palette";
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
import ErrorState from "../components/ErrorState";
import EmptyState from "../components/EmptyState";

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

// Mirrors displaySortLine for orderBy === 'addedAt' -> $getString('LabelAddedDate', [$formatDate(addedAt)])
function formatAdded(ms?: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  // Non-numeric addedAt from a non-conforming server rendered a literal
  // "Added NaN/NaN/NaN NaN:NaN" line.
  if (!Number.isFinite(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `Added ${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

/**
 * Imperative handle the Library-hub uses to drive the shared TopAppBar's
 * filter/sort actions when this screen is embedded (the hub owns the bar).
 */
export interface LibraryScreenHandle {
  openFilter: () => void;
  openSort: () => void;
  scrollToTop: () => void;
}

interface LibraryRowProps {
  item: LibraryItem;
  index: number;
  coverUri: string | null;
  colors: any;
  starting: boolean;
  onOpen: (item: LibraryItem) => void;
  onPlay: (item: LibraryItem) => void;
  onRead: (item: LibraryItem) => void;
}

/**
 * One library row, extracted from LibraryScreen's renderItem and memoized so it
 * re-renders only when ITS OWN data changes. The previous inline renderItem
 * closed over the whole mediaProgress map, so a playing book — which rewrites
 * that map about once a second — reconciled every row on every tick, stealing
 * frames from animations (the list stays mounted behind every screen via the
 * keep-alive hub). This row subscribes to just its own progress and download
 * entry via per-item selectors, so only the currently-playing book's row
 * updates on a tick.
 */
const LibraryRow = React.memo(function LibraryRow({
  item,
  index,
  coverUri,
  colors,
  starting,
  onOpen,
  onPlay,
  onRead,
}: LibraryRowProps) {
  const perItemProgress = useUserStore((s) => s.mediaProgress[item.id]);
  const isDownloaded = useDownloadStore((s) => !!s.completedDownloads[item.id]);

  const title = item.media?.metadata?.title || "Untitled";
  const author = item.media?.metadata?.authorName || "Unknown";
  const sortLine = formatAdded(item.addedAt);
  const firstSeries = (item.media?.metadata as any)?.series?.[0];
  const seriesText = firstSeries
    ? firstSeries.sequence
      ? `${firstSeries.name} #${firstSeries.sequence}`
      : firstSeries.name
    : null;
  // Action button: Play for audiobooks, Read for ebook-only items (no audio),
  // nothing for podcasts.
  const isPodcast = item.mediaType === "podcast";
  const rowHasAudio = hasAudio(item);
  const rowHasEbook = itemHasEbook(item);
  const isEbookOnly = !rowHasAudio && rowHasEbook;
  const showPlayButton = !isPodcast && (rowHasAudio || isEbookOnly);

  // Check if progress/download status is active
  const progress =
    (item as any).userMediaProgress || (item as any).progress || perItemProgress || null;
  const isFinished = !!progress?.isFinished;
  const durationSecs = Number(item.media?.duration || progress?.duration || 0);
  const progressPercent = Math.max(
    Math.min(1, progress?.progress ?? (durationSecs > 0 ? (progress?.currentTime || 0) / durationSecs : 0)),
    0
  );
  const isInProgress = progressPercent > 0 && !isFinished;
  const isLocal = (item as any).isLocal || !!(item as any).localLibraryItem || isDownloaded;
  // Reading progress and podcast-episode progress count too — the badge itself
  // renders null when there's truly nothing to show, so this gate only needs to
  // be generous, not exact.
  const hasEbookProgress = !!(progress?.ebookLocation || (progress?.ebookProgress || 0) > 0);
  const hasBadge = isLocal || isFinished || isInProgress || hasEbookProgress || isPodcast;

  return (
    // material-3-list-card embedded-list-row z-10 cursor-pointer py-1 px-2 mx-0
    <AnimatedPressable
      // Gate the per-row entrance to the first screenful. Past that, animating a
      // freshly-scrolled-in row allocated a new FadeInDown object per row per
      // render and re-armed on fast scroll — visible jank; those rows now just
      // appear.
      entering={index < 12 ? listRowEnter(index) : undefined}
      onPress={() => onOpen(item)}
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
              source={coverSource(coverUri)}
              style={{ width: COVER_WIDTH, height: COVER_HEIGHT }}
              contentFit="cover"
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
              item={item}
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
              onPress={() => (isEbookOnly ? onRead(item) : onPlay(item))}
              hitSlop={6}
              android_ripple={{ color: withAlpha(colors.onPrimary, 0.2), radius: 28 }}
              accessibilityRole="button"
              accessibilityLabel={`${isEbookOnly ? "Read" : "Play"} ${title}`}
              style={{
                width: 56,
                height: 56,
                borderRadius: 28,
                overflow: "hidden",
                alignItems: "center",
                justifyContent: "center",
                elevation: 2,
                backgroundColor: starting ? colors.surfaceVariant : colors.primary,
              }}
            >
              {starting ? (
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
});

function LibraryScreen(
  { route, navigation, embedded, onFilterActiveChange, listHeader, onScroll, onSeedConsumed }: any,
  ref: React.Ref<LibraryScreenHandle>
) {
  const colors = useThemeColors();
  const isSearchActive = useUiStore((s) => s.isSearchActive);
  const { currentLibraryId } = useLibraryStore();
  const { serverConnectionConfig } = useUserStore();
  const startPlayback = usePlaybackStore((s) => s.startPlayback);
  const hasSession = usePlaybackStore((s) => s.currentSession !== null);
  // The list itself no longer subscribes to the whole mediaProgress /
  // completedDownloads maps — that made a playing book (which rewrites its
  // progress mirror ~1×/sec) reconcile the ENTIRE list every tick, and the
  // keep-alive hub keeps this list mounted behind every screen. Each row
  // (LibraryRow) subscribes to just its own entry via per-item selectors.
  const hideNonAudiobooks = useUserStore((s) => s.settings?.hideNonAudiobooksGlobal);

  const [items, setItems] = useState<LibraryItem[]>([]);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // Only set when the FIRST page fails — a mid-pagination hiccup shouldn't
  // blow away the list the user is already scrolling.
  const [loadError, setLoadError] = useState(false);
  const [startingId, setStartingId] = useState<string | null>(null);
  const isFetchingRef = useRef(false);
  const fetchIdRef = useRef(0);
  const listRef = useRef<FlatList>(null);
  // Set when the server returns an empty page: with the hide-non-audiobooks
  // client filter active, items.length can stay below `total` forever, which
  // would otherwise make onEndReached refetch empty pages on every scroll-end.
  const noMorePagesRef = useRef(false);
  const routeFilter = route.params?.filter;
  // A shelf header on the Home tab can route here with a specific sort (e.g.
  // Recently Added → addedAt desc). Like routeFilter, these seed the view
  // without being persisted as the user's saved default.
  const routeOrderBy = route.params?.orderBy;
  const routeDescending = route.params?.descending;

  // Filter / sort state (raw query values matching the original app). Seeded
  // from the persisted mobile* settings so the user's sort/filter choices
  // survive app restarts (a route-supplied filter still takes precedence).
  const savedSettings = useUserStore.getState().settings;
  const updateUserSettings = useUserStore((s) => s.updateUserSettings);
  const [filterBy, setFilterBy] = useState(routeFilter || savedSettings?.mobileFilterBy || "all");
  const [orderBy, setOrderBy] = useState(routeOrderBy || savedSettings?.mobileOrderBy || "addedAt");
  const [descending, setDescending] = useState(
    routeDescending ?? savedSettings?.mobileOrderDesc ?? true
  );
  const [filterOpen, setFilterOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);

  // A deep-link seed (route filter/sort) applies AUTHORITATIVELY: when a new
  // seed arrives — including on the embedded hub's already-mounted Books facet —
  // every field the seed omits resets to the user's saved default, so a
  // narrower re-seed (e.g. a filter-only genre link) can't leave a stale sort
  // from a previous seed in place. Fields are still applied without persisting
  // (a one-off view). Once applied we notify the hub so it can drop the seed and
  // never re-apply it on a later remount/search-toggle (the sort-reversion bug).
  useEffect(() => {
    const hasSeed =
      routeFilter !== undefined ||
      routeOrderBy !== undefined ||
      routeDescending !== undefined;
    if (!hasSeed) return;
    const saved = useUserStore.getState().settings;
    setFilterBy(routeFilter ?? saved?.mobileFilterBy ?? "all");
    setOrderBy(routeOrderBy ?? saved?.mobileOrderBy ?? "addedAt");
    setDescending(routeDescending ?? saved?.mobileOrderDesc ?? true);
    onSeedConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeFilter, routeOrderBy, routeDescending]);

  // Badge the filter icon when the view differs from the app default sort
  // (addedAt, descending) or has an active filter — otherwise a persisted
  // filter/sort is invisible.
  const isDefaultSort = orderBy === "addedAt" && descending === true;
  const filterActive = (!!filterBy && filterBy !== "all") || !isDefaultSort;

  // Let the Library-hub trigger this screen's own filter/sort sheets from the
  // shared TopAppBar when embedded.
  useImperativeHandle(
    ref,
    () => ({
      openFilter: () => setFilterOpen(true),
      openSort: () => setSortOpen(true),
      scrollToTop: () => listRef.current?.scrollToOffset({ offset: 0, animated: true }),
    }),
    []
  );

  // When embedded, the hub owns the shared TopAppBar, so it needs to know when
  // this screen's filter/sort differs from the default to show the active-filter
  // badge on the Books segment. Push filterActive up whenever it changes.
  useEffect(() => {
    onFilterActiveChange?.(filterActive);
  }, [filterActive, onFilterActiveChange]);

  const serverAddress = serverConnectionConfig?.address?.replace(/\/$/, "") || "";
  const token = serverConnectionConfig?.token || "";

  const getCoverUrl = useCallback(
    (itemId: string) => {
      if (!itemId || !serverAddress || !token) return null;
      return `${serverAddress}/api/items/${itemId}/cover?width=400&format=webp&token=${token}`;
    },
    [serverAddress, token]
  );

  const fetchItems = useCallback(
    async (pageNum: number, reset = false, showSkeleton = true) => {
      if (!currentLibraryId) return;
      if (!reset && isFetchingRef.current) return;

      const currentFetchId = ++fetchIdRef.current;
      isFetchingRef.current = true;
      if (reset) {
        noMorePagesRef.current = false;
        setLoadError(false);
        // Pull-to-refresh passes showSkeleton=false so the visible list isn't
        // replaced by the skeleton mid-gesture.
        if (showSkeleton) setInitialLoading(true);
      }
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
        const rawResults: LibraryItem[] = (Array.isArray(data.results) ? data.results : []).filter(
          Boolean
        );
        if (rawResults.length === 0 && !reset) noMorePagesRef.current = true;
        let results: LibraryItem[] = rawResults;
        // "Hide non-audiobooks globally": drop items that have no audio (e.g.
        // ebook-only entries) when the setting is on.
        if (useUserStore.getState().settings?.hideNonAudiobooksGlobal) {
          results = results.filter((it: any) => {
            const m = it?.media;
            return (m?.numAudioFiles ?? 0) > 0 || (m?.duration ?? 0) > 0 || (m?.numTracks ?? 0) > 0;
          });
        }
        setTotal(data.total || 0);
        setItems((prev) => {
          if (reset) return results;
          // Dedupe by id: the default addedAt-desc sort means a server-side
          // add mid-scroll shifts page boundaries and re-serves rows.
          const seen = new Set(prev.map((it: any) => it?.id).filter(Boolean));
          return [...prev, ...results.filter((it: any) => !it?.id || !seen.has(it.id))];
        });
        setPage(pageNum);
        // "Hide non-audiobooks" can filter a FULL raw page down to nothing —
        // content doesn't grow, so onEndReached never re-fires and load-more
        // stalls (each scroll-wiggle advanced one page). Chain straight into
        // the next page instead. This applies to the FIRST page too: when
        // page 0 is all ebook-only, the list would otherwise be permanently
        // empty (a stuck spinner / false empty state) even though later pages
        // hold audiobooks — keep paginating until some survive or pages run out.
        if (
          rawResults.length > 0 &&
          results.length === 0 &&
          currentFetchId === fetchIdRef.current
        ) {
          isFetchingRef.current = false;
          fetchItems(pageNum + 1);
        }
      } catch (err) {
        if (currentFetchId === fetchIdRef.current) {
          console.error("[LibraryScreen] Failed to fetch items:", err);
          if (pageNum === 0) setLoadError(true);
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
    if (loading || noMorePagesRef.current || items.length >= total) return;
    fetchItems(page + 1);
  };

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await fetchItems(0, true, false);
    } finally {
      setRefreshing(false);
    }
  };

  // startingId is mirrored into a ref so handlePlay stays referentially stable
  // (its guard reads the ref, not the state) — a new handlePlay each render
  // would break LibraryRow's React.memo and re-render every visible row when
  // any single row starts playing.
  const startingIdRef = useRef<string | null>(null);
  const handlePlay = useCallback(
    async (item: LibraryItem) => {
      if (startingIdRef.current) return;
      startingIdRef.current = item.id;
      setStartingId(item.id);
      try {
        await startPlayback(item.id);
      } finally {
        startingIdRef.current = null;
        setStartingId(null);
      }
    },
    [startPlayback]
  );

  const handleReadRow = useCallback(
    (item: LibraryItem) => {
      navigation.navigate("Reader", {
        itemId: item.id,
        ebookFormat: getEbookFormat(item),
        title: item.media?.metadata?.title,
      });
    },
    [navigation]
  );

  const handleOpen = useCallback(
    (item: LibraryItem) => {
      navigation.navigate("ItemDetail", { itemId: item.id });
    },
    [navigation]
  );

  const renderItem = useCallback(
    ({ item, index }: { item: LibraryItem; index: number }) => (
      <LibraryRow
        item={item}
        index={index}
        coverUri={getCoverUrl(item.id)}
        colors={colors}
        starting={startingId === item.id}
        onOpen={handleOpen}
        onPlay={handlePlay}
        onRead={handleReadRow}
      />
    ),
    [getCoverUrl, colors, startingId, handleOpen, handlePlay, handleReadRow]
  );

  const renderFooter = () => {
    if (!loading || initialLoading) return null;
    return (
      <View style={{ paddingVertical: 20, alignItems: "center" }}>
        <ActivityIndicator size="small" color={colors.primary} />
      </View>
    );
  };

  const modals = (
    <>
      <FilterModal
        visible={filterOpen}
        onClose={() => setFilterOpen(false)}
        filterBy={filterBy}
        onChange={(f) => {
          setFilterBy(f);
          // Persist so the choice survives restarts (mirrors the original app)
          // — but NOT on a pushed genre/tag/narrator list (routeFilter): those
          // are one-off views, and persisting from them silently rewrote the
          // main Library tab's saved filter.
          if (!routeFilter) updateUserSettings({ mobileFilterBy: f }).catch(() => {});
        }}
      />
      <OrderModal
        visible={sortOpen}
        onClose={() => setSortOpen(false)}
        orderBy={orderBy}
        descending={descending}
        onChange={(o, d) => {
          setOrderBy(o);
          setDescending(d);
          updateUserSettings({ mobileOrderBy: o, mobileOrderDesc: d }).catch(() => {});
        }}
      />
    </>
  );

  const content = (
    <>
      {/* The search overlay belongs to TAB instances only. This screen is ALSO
          registered on the root stack ("Library" + showBack) as the target of
          narrator/tag/genre taps — rendering the overlay there showed the
          search results AGAIN instead of the filtered list you navigated to.
          When embedded in the Library-hub the hub owns the search overlay, so
          this branch is suppressed there too. */}
      {isSearchActive && !route.params?.showBack && !embedded ? (
        <SearchContent navigation={navigation} />
      ) : initialLoading ? (
        <>
          {listHeader}
          <ListSkeleton rows={9} />
        </>
      ) : loadError && items.length === 0 ? (
        <>
          {listHeader}
          <ErrorState
            style={{ flex: 1 }}
            title="Couldn't load your library"
            message="Check your connection to the server and try again."
            onRetry={() => fetchItems(0, true)}
          />
        </>
      ) : items.length === 0 ? (
        <>
          {listHeader}
          <EmptyState
            style={{ flex: 1 }}
            icon="library"
            title="No items found"
          message={
            filterBy && filterBy !== "all"
              ? "Nothing in this library matches the current filter."
              : "Your library is empty. Add some audiobooks to get started."
          }
          action={
            filterBy && filterBy !== "all" && !routeFilter ? (
              <Pressable
                onPress={() => {
                  setFilterBy("all");
                  updateUserSettings({ mobileFilterBy: "all" }).catch(() => {});
                }}
                android_ripple={{ color: colors.surfaceContainerHighest }}
                accessibilityRole="button"
                accessibilityLabel="Clear filter"
                style={{
                  paddingHorizontal: 24,
                  paddingVertical: 10,
                  borderRadius: 24,
                  overflow: "hidden",
                  borderWidth: 1,
                  borderColor: colors.outline,
                }}
              >
                <Text style={{ color: colors.primary, fontSize: 15, fontWeight: "600" }}>Clear filter</Text>
              </Pressable>
            ) : undefined
          }
          />
        </>
      ) : (
        <FlatList
          ref={listRef}
          data={items}
          renderItem={renderItem}
          keyExtractor={(item) => item.id}
          // The hub passes the segment pill row as a non-sticky list header so
          // it scrolls away with the content (only for the active facet).
          ListHeaderComponent={listHeader ?? null}
          onScroll={(e) => onScroll?.(e.nativeEvent.contentOffset.y)}
          scrollEventThrottle={16}
          // Generous spacing, no hard dividers (matches screenshot 05)
          contentContainerStyle={{ paddingBottom: hasSession ? 100 : 32, paddingTop: 4 }}
          onEndReached={handleLoadMore}
          onEndReachedThreshold={3.0}
          ListFooterComponent={renderFooter}
          showsVerticalScrollIndicator={false}
          initialNumToRender={12}
          windowSize={11}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              colors={[colors.primary]}
              progressBackgroundColor={colors.surfaceContainerHigh}
            />
          }
        />
      )}
    </>
  );

  // Embedded in the Library-hub: the hub provides the shared SafeAreaView +
  // single TopAppBar (and drives filter/sort via the imperative handle), so we
  // render just the modals + content body here.
  if (embedded) {
    return (
      <View style={{ flex: 1 }}>
        {modals}
        {content}
      </View>
    );
  }

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
        filterActive={filterActive}
        showSort
        onFilter={() => setFilterOpen(true)}
        onSort={() => setSortOpen(true)}
      />
      {modals}
      {content}
    </SafeAreaView>
  );
}

export default forwardRef(LibraryScreen);
