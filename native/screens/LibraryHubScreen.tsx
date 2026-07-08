import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, Pressable } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useThemeColors } from "../theme/useThemeColors";
import TopAppBar from "../components/TopAppBar";
import Icon, { IconName } from "../components/Icon";
import EmptyState from "../components/EmptyState";
import SearchContent from "../components/SearchContent";
import { useNetworkStatus } from "../hooks/useNetworkStatus";
import { useUiStore } from "../store/useUiStore";
import { usePlaybackStore } from "../store/usePlaybackStore";
import { storageHelper } from "../utils/storage";
import LibraryScreen, { LibraryScreenHandle } from "./LibraryScreen";
import SeriesListScreen, { SeriesListScreenHandle } from "./SeriesListScreen";
import AuthorsScreen, { AuthorsScreenHandle } from "./AuthorsScreen";

// Memoized facet wrappers: crossing the scroll-to-top threshold flips
// setShowScrollTop and re-renders the hub, which would otherwise reconcile
// every kept-alive facet subtree with fresh props. With stable props (see the
// memoized pillRow, route and callbacks below) these bail out of re-rendering
// unless their own inputs actually change.
const MemoLibraryScreen = React.memo(LibraryScreen);
const MemoSeriesListScreen = React.memo(SeriesListScreen);
const MemoAuthorsScreen = React.memo(AuthorsScreen);

/**
 * LibraryHubScreen — Material 3 "Library" destination that consolidates the
 * core library-browse facets (Books · Series · Authors) behind a single
 * bottom-tab entry with a segmented pill control. Collections + Playlists live
 * in their own "Collections" bottom tab. This keeps the bottom bar at
 * Home · Library · Collections · [Discover] (≤5 M3 destinations) instead of
 * repeating the "browse the library" job across many tabs.
 *
 * The hub owns the shared chrome — one SafeAreaView + one TopAppBar — and the
 * embedded facet screens render only their list/content body (they accept an
 * `embedded` prop that drops their own SafeAreaView/TopAppBar). Contextual
 * TopAppBar actions (filter+sort for Books, sort for Series/Authors) are driven
 * through each embedded screen's imperative handle.
 *
 * Facets are KEPT MOUNTED once activated: every visited segment stays in the
 * tree as an absolute-fill layer, and only the active one is shown
 * (display:flex) while the others are hidden (display:none, pointerEvents off).
 * Switching segments — and toggling search — therefore preserves each facet's
 * pagination, scroll position, and in-flight fetches instead of unmounting and
 * refetching page 0. The pill row itself lives inside the active facet's list as
 * a non-sticky header so it scrolls away with the content (collapsing header).
 */

export type LibrarySegment = "books" | "series" | "authors";

const SEGMENTS: { key: LibrarySegment; label: string; icon: IconName }[] = [
  { key: "books", label: "Books", icon: "book" },
  { key: "series", label: "Series", icon: "series" },
  { key: "authors", label: "Authors", icon: "authors" },
];

const VALID_SEGMENTS = SEGMENTS.map((s) => s.key);

// Once the active list is scrolled past this many px, surface the scroll-to-top
// FAB (roughly a few rows down — far enough that a jump-to-top is useful).
const SCROLL_TOP_THRESHOLD = 600;

const ABSOLUTE_FILL = {
  position: "absolute" as const,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
};

// Only books/series/authors are valid now that Collections + Playlists moved to
// their own bottom tab. A persisted or deep-linked "collections"/"playlists"
// (from before the split) no longer matches VALID_SEGMENTS, so it normalizes to
// null and the caller falls back to Books — the hub never renders a removed
// segment.
function normalizeSegment(value: any): LibrarySegment | null {
  return VALID_SEGMENTS.includes(value) ? (value as LibrarySegment) : null;
}

export default function LibraryHubScreen({ route, navigation }: any) {
  const colors = useThemeColors();
  const isSearchActive = useUiStore((s) => s.isSearchActive);
  const hasSession = usePlaybackStore((s) => s.currentSession !== null);
  // Same DERIVED offline signal BookshelfScreen/OfflineBanner consume — true
  // for a captive portal / connected-but-unreachable network too, not just a
  // dropped radio. The hub's facets all fetch from the server, so offline
  // there's nothing to browse — point the user at their downloaded content
  // instead of firing failing fetches.
  const { isOffline } = useNetworkStatus();

  const params = route?.params || {};

  // A deep-link that carries a Books filter/sort (e.g. the Home shelf header's
  // "sort by X" affordance, or a narrator/tag list) always means the Books
  // segment. Otherwise honor an explicit `segment` param, then the persisted
  // last-selected segment, then default to Books.
  const paramSegment = normalizeSegment(params.segment);
  const hasBooksSeed =
    params.filter !== undefined ||
    params.orderBy !== undefined ||
    params.descending !== undefined;

  const [segment, setSegment] = useState<LibrarySegment>(() => {
    if (hasBooksSeed) return "books";
    if (paramSegment) return paramSegment;
    return normalizeSegment(storageHelper.getLibraryHubSegment()) || "books";
  });

  // Keep `segment` reachable from stable callbacks (tabPress listener) without
  // re-subscribing on every switch.
  const segmentRef = useRef(segment);
  segmentRef.current = segment;

  // Books deep-link seed (filter/sort). Consumed the moment the Books facet
  // applies it (via onSeedConsumed) OR when the user manually switches
  // segments, then discarded — so a later remount/search-toggle can't re-apply
  // a stale deep-link and revert the user's chosen sort.
  const [booksSeed, setBooksSeed] = useState<any>(() =>
    hasBooksSeed
      ? { filter: params.filter, orderBy: params.orderBy, descending: params.descending }
      : undefined
  );

  // A fresh navigation into this tab with new params re-selects Books + reseeds.
  useEffect(() => {
    const hadSeed =
      params.filter !== undefined ||
      params.orderBy !== undefined ||
      params.descending !== undefined;
    const hadSegment = normalizeSegment(params.segment) != null;
    if (hadSeed) {
      setSegment("books");
      setBooksSeed({
        filter: params.filter,
        orderBy: params.orderBy,
        descending: params.descending,
      });
    } else if (hadSegment) {
      setSegment(params.segment as LibrarySegment);
    }
    // Clear the consumed params. React Navigation MERGES tab params and keeps
    // them sticky, so without this a one-off deep-link seed would keep forcing
    // Books (and a lingering `filter` would override a later `segment` param) on
    // every remount/revisit. Guarded — some tests mock navigation without it.
    if ((hadSeed || hadSegment) && typeof navigation?.setParams === "function") {
      navigation.setParams({
        filter: undefined,
        orderBy: undefined,
        descending: undefined,
        segment: undefined,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.segment, params.filter, params.orderBy, params.descending]);

  // Imperative handles for every facet — the shared TopAppBar's filter/sort
  // buttons and the hub's scroll-to-top / create FABs call into whichever facet
  // is active.
  const booksRef = useRef<LibraryScreenHandle>(null);
  const seriesRef = useRef<SeriesListScreenHandle>(null);
  const authorsRef = useRef<AuthorsScreenHandle>(null);

  const refFor = (key: LibrarySegment) =>
    key === "books" ? booksRef : key === "series" ? seriesRef : authorsRef;

  // Lazy-mount then keep-alive: mount a facet the first time its segment is
  // activated, and never unmount it afterwards. Mutating the ref during render
  // is safe here — the render is already happening because `segment` changed.
  const mountedRef = useRef<Set<LibrarySegment>>(new Set([segment]));
  mountedRef.current.add(segment);

  // The Books facet reports when its filter/sort differs from the default so the
  // shared TopAppBar can badge the filter icon (a persisted filter is otherwise
  // invisible on the hub's Books segment).
  const [booksFilterActive, setBooksFilterActive] = useState(false);

  // Per-facet scroll offset (kept across switches so the scroll-to-top FAB
  // reflects the retained position of whichever facet is now active).
  const scrollOffsets = useRef<Record<string, number>>({});
  const [showScrollTop, setShowScrollTop] = useState(false);
  // Stable per-facet scroll handlers. The previous handleFacetScroll(key)
  // allocated a fresh closure per facet on every hub render (including each time
  // the scroll-to-top threshold toggled setShowScrollTop), changing the onScroll
  // prop and re-rendering every mounted facet. These read only refs + the stable
  // setter, so they never need to change.
  const onScrollHandlers = useMemo(() => {
    const make = (key: LibrarySegment) => (y: number) => {
      scrollOffsets.current[key] = y;
      if (key === segmentRef.current) setShowScrollTop(y > SCROLL_TOP_THRESHOLD);
    };
    return {
      books: make("books"),
      series: make("series"),
      authors: make("authors"),
    } as Record<LibrarySegment, (y: number) => void>;
  }, []);

  const selectSegment = useCallback((next: LibrarySegment) => {
    if (next === segmentRef.current) return;
    setSegment(next);
    // A manual segment switch drops any pending Books deep-link seed.
    setBooksSeed(undefined);
    setShowScrollTop((scrollOffsets.current[next] || 0) > SCROLL_TOP_THRESHOLD);
    storageHelper.setLibraryHubSegment(next);
  }, []);

  // Stable Books-facet props so the memoized facet doesn't re-render when only
  // the hub's scroll-to-top state changes.
  const onBooksSeedConsumed = useCallback(() => setBooksSeed(undefined), []);
  const booksRoute = useMemo(() => ({ params: booksSeed || {} }), [booksSeed]);

  // Resync the scroll-to-top FAB to the active facet's retained offset whenever
  // `segment` changes — by tap, deep-link seed, or an explicit `segment` param.
  // selectSegment sets this synchronously (to avoid a flash on tap), but the
  // params-driven effect switches segments without touching it, so without this
  // the FAB could stay stale from the previously active facet until the next
  // scroll.
  useEffect(() => {
    setShowScrollTop((scrollOffsets.current[segment] || 0) > SCROLL_TOP_THRESHOLD);
  }, [segment]);

  const scrollActiveToTop = () => {
    refFor(segmentRef.current).current?.scrollToTop?.();
  };

  // Re-tapping the already-focused Library tab scrolls the active facet to top
  // (composes with the global search-clear tabPress in AppNavigator).
  useEffect(() => {
    if (typeof navigation?.addListener !== "function") return;
    const unsub = navigation.addListener("tabPress", () => {
      const focused = typeof navigation.isFocused === "function" ? navigation.isFocused() : true;
      if (focused && !useUiStore.getState().isSearchActive) {
        scrollActiveToTop();
      }
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigation]);

  // Contextual TopAppBar affordances per active segment (mirrors each facet's
  // standalone bar): Books = filter + sort, Series/Authors = sort. Search is
  // global and always available.
  const showFilter = segment === "books";
  const showSort = segment === "books" || segment === "series" || segment === "authors";

  const onFilter = () => {
    if (segment === "books") booksRef.current?.openFilter();
  };
  const onSort = () => {
    if (segment === "books") booksRef.current?.openSort();
    else if (segment === "series") seriesRef.current?.openSort();
    else if (segment === "authors") authorsRef.current?.openSort();
  };

  // The segment pill row. Passed down to (only) the active facet as its list
  // header so it collapses away with the content (M3 collapsing header).
  // Memoized so an unrelated hub re-render (e.g. the scroll-to-top FAB toggling)
  // doesn't recreate it and, through it, re-render the active facet's header.
  const pillRow = useMemo(
    () => (
    <View style={{ paddingHorizontal: 16, paddingTop: 10, paddingBottom: 6 }}>
      {/* A plain full-width row of 3 equal-width pills — no horizontal
          ScrollView. Three segments fit any phone width (each flex:1 ≈ 120dp at
          ~360dp, well above the 84dp min touch target), so the pills are exactly
          equal width in every selection state and never resize/jump when the
          longest label ("Authors") + its checkmark is selected. (A horizontal
          ScrollView would size flex:1 children to content and cause that jump.) */}
      <View
        accessibilityRole="tablist"
        style={{
          flexDirection: "row",
          borderWidth: 1,
          borderColor: colors.outline,
          borderRadius: 20,
          overflow: "hidden",
        }}
      >
        {SEGMENTS.map((seg, i) => {
          const selected = segment === seg.key;
          return (
            <Pressable
              key={seg.key}
              onPress={() => selectSegment(seg.key)}
              android_ripple={{ color: colors.surfaceContainerHighest }}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              accessibilityLabel={seg.label}
              // Pills are ~38-40dp tall (under the 48dp min touch target);
              // extend the vertical hit area so they're comfortably tappable.
              hitSlop={{ top: 6, bottom: 6 }}
              style={{
                flex: 1,
                flexBasis: 0,
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                paddingVertical: 10,
                paddingHorizontal: 8,
                backgroundColor: selected ? colors.secondaryContainer : "transparent",
                borderLeftWidth: i === 0 ? 0 : 1,
                borderLeftColor: colors.outline,
              }}
            >
              <Icon
                name={selected ? "check" : seg.icon}
                size={18}
                color={selected ? colors.onSecondaryContainer : colors.onSurfaceVariant}
              />
              <Text
                numberOfLines={1}
                maxFontSizeMultiplier={1.3}
                style={{
                  color: selected ? colors.onSecondaryContainer : colors.onSurfaceVariant,
                  fontSize: 14,
                  fontWeight: "500",
                  marginLeft: 8,
                }}
              >
                {seg.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
    ),
    [colors, segment, selectSegment]
  );

  const renderFacet = (key: LibrarySegment) => {
    const active = key === segment;
    // Only the active facet receives the pill row (a single visible copy) and
    // reports scroll — inactive layers are hidden anyway.
    const listHeader = active ? pillRow : undefined;
    const onScroll = onScrollHandlers[key];
    switch (key) {
      case "books":
        return (
          <MemoLibraryScreen
            ref={booksRef}
            embedded
            navigation={navigation}
            route={booksRoute}
            onFilterActiveChange={setBooksFilterActive}
            onSeedConsumed={onBooksSeedConsumed}
            listHeader={listHeader}
            onScroll={onScroll}
          />
        );
      case "series":
        return (
          <MemoSeriesListScreen
            ref={seriesRef}
            embedded
            navigation={navigation}
            listHeader={listHeader}
            onScroll={onScroll}
          />
        );
      case "authors":
        return (
          <MemoAuthorsScreen
            ref={authorsRef}
            embedded
            navigation={navigation}
            listHeader={listHeader}
            onScroll={onScroll}
          />
        );
      default:
        return null;
    }
  };

  const fabBottom = hasSession ? 100 : 32;

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: colors.surface }}
      edges={["top", "left", "right"]}
    >
      <TopAppBar
        navigation={navigation}
        showFilter={showFilter}
        filterActive={showFilter && booksFilterActive}
        showSort={showSort}
        onFilter={onFilter}
        onSort={onSort}
      />

      <View style={{ flex: 1 }}>
        {/* Keep-alive facet layers: every visited segment stays mounted; only
            the active one is shown. These stay mounted even while offline (see
            the offline overlay below) so a transient connectivity blip doesn't
            unmount them and force a page-0 refetch on reconnect. */}
        {SEGMENTS.map((seg) => {
          if (!mountedRef.current.has(seg.key)) return null;
          const active = seg.key === segment;
          return (
            <View
              key={seg.key}
              testID={`facet-layer-${seg.key}`}
              // A flat object (not an [absoluteFill, {...}] array) so tests can
              // read `.style.display` directly.
              style={{ ...ABSOLUTE_FILL, display: active ? "flex" : "none" }}
              pointerEvents={active ? "auto" : "none"}
              // While offline the overlay below covers every facet. Its
              // accessibilityViewIsModal is iOS-only (a no-op for Android
              // TalkBack), so ALSO drop the facets from the a11y tree here —
              // otherwise a blind user swipes past the "You're offline" notice
              // into the hidden facet list and taps dead rows. Mirrors the
              // AppDialog/PlayerBottomSheet scrim pattern. Inactive layers are
              // already hidden, so they stay "no-hide-descendants" regardless;
              // the active layer returns to "auto" once back online.
              importantForAccessibility={
                isOffline || !active ? "no-hide-descendants" : "auto"
              }
            >
              {renderFacet(seg.key)}
            </View>
          );
        })}

        {/* Search overlay sits ABOVE the still-mounted facets (they survive the
            toggle) rather than replacing them. */}
        {isSearchActive ? (
          <View style={{ ...ABSOLUTE_FILL, backgroundColor: colors.surface }}>
            <SearchContent navigation={navigation} />
          </View>
        ) : null}

        {/* Scroll-to-top FAB — appears once the active list is scrolled down.
            Hidden while offline (the offline overlay covers the facets). */}
        {!isSearchActive && !isOffline && showScrollTop ? (
          <Pressable
            onPress={scrollActiveToTop}
            android_ripple={{ color: colors.surfaceContainerHighest }}
            accessibilityRole="button"
            accessibilityLabel="Scroll to top"
            style={{
              position: "absolute",
              right: 16,
              bottom: fabBottom,
              width: 48,
              height: 48,
              borderRadius: 16,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: colors.secondaryContainer,
              elevation: 3,
              shadowColor: "#000",
              shadowOffset: { width: 0, height: 2 },
              shadowOpacity: 0.2,
              shadowRadius: 3,
            }}
          >
            <Icon name="chevron-up" size={26} color={colors.onSecondaryContainer} />
          </Pressable>
        ) : null}

        {/* Offline overlay: the library facets browse the server, so offline
            there's nothing to load. Rather than REPLACING (and thereby
            unmounting) the facet tree — which would discard the retained
            pagination/scroll/in-flight state the hub promises and refetch page 0
            on every reconnect — we keep the facets mounted and cover them with
            an absolute-fill notice (mirroring the search overlay). When
            connectivity returns this layer is removed, revealing the facets with
            their state intact. pointerEvents="auto" + a solid surface background
            block interaction with the facets beneath. accessibilityViewIsModal
            keeps iOS VoiceOver on the notice; because that prop is a no-op for
            Android TalkBack we ALSO set importantForAccessibility="no-hide-
            descendants" on the facet layers above so the hidden facets are
            removed from the a11y tree there too. accessibilityLiveRegion="polite"
            announces the notice when it appears, and the title carries a header
            role. Mirrors the AppDialog/PlayerBottomSheet modal pattern. */}
        {isOffline ? (
          <View
            testID="library-offline-overlay"
            style={{ ...ABSOLUTE_FILL, backgroundColor: colors.surface }}
            pointerEvents="auto"
            accessibilityViewIsModal
            accessibilityLiveRegion="polite"
            accessibilityRole="header"
          >
            <EmptyState
              style={{ flex: 1 }}
              icon="cloud-off"
              title="You're offline"
              message="Browsing the library needs a connection. Your downloaded books are always available offline."
              action={
                <Pressable
                  onPress={() => navigation?.navigate?.("Downloads")}
                  android_ripple={{ color: colors.surfaceContainerHighest }}
                  accessibilityRole="button"
                  accessibilityLabel="Open Downloads"
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    paddingVertical: 12,
                    paddingHorizontal: 24,
                    borderRadius: 20,
                    backgroundColor: colors.primaryContainer,
                  }}
                >
                  <Icon name="download" size={18} color={colors.onPrimaryContainer} />
                  <Text
                    style={{
                      color: colors.onPrimaryContainer,
                      fontSize: 14,
                      fontWeight: "600",
                      marginLeft: 8,
                    }}
                  >
                    Open Downloads
                  </Text>
                </Pressable>
              }
            />
          </View>
        ) : null}
      </View>
    </SafeAreaView>
  );
}
