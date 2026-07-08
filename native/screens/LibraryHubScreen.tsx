import React, { useEffect, useRef, useState } from "react";
import { View, Text, Pressable, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useThemeColors } from "../theme/useThemeColors";
import TopAppBar from "../components/TopAppBar";
import Icon, { IconName } from "../components/Icon";
import SearchContent from "../components/SearchContent";
import { useUiStore } from "../store/useUiStore";
import { usePlaybackStore } from "../store/usePlaybackStore";
import { storageHelper } from "../utils/storage";
import LibraryScreen, { LibraryScreenHandle } from "./LibraryScreen";
import SeriesListScreen, { SeriesListScreenHandle } from "./SeriesListScreen";
import CollectionsPlaylistsScreen, {
  CollectionsPlaylistsScreenHandle,
} from "./CollectionsPlaylistsScreen";
import AuthorsScreen, { AuthorsScreenHandle } from "./AuthorsScreen";

/**
 * LibraryHubScreen — Material 3 "Library" destination that consolidates the
 * library-browse facets (Books · Series · Collections · Playlists · Authors)
 * behind a single bottom-tab entry with a segmented pill control. This keeps the
 * bottom bar at Home · Library · [Discover] (≤5 M3 destinations) instead of
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

export type LibrarySegment = "books" | "series" | "collections" | "playlists" | "authors";

const SEGMENTS: { key: LibrarySegment; label: string; icon: IconName }[] = [
  { key: "books", label: "Books", icon: "book" },
  { key: "series", label: "Series", icon: "series" },
  { key: "collections", label: "Collections", icon: "collections" },
  { key: "playlists", label: "Playlists", icon: "list" },
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

function normalizeSegment(value: any): LibrarySegment | null {
  return VALID_SEGMENTS.includes(value) ? (value as LibrarySegment) : null;
}

export default function LibraryHubScreen({ route, navigation }: any) {
  const colors = useThemeColors();
  const isSearchActive = useUiStore((s) => s.isSearchActive);
  const hasSession = usePlaybackStore((s) => s.currentSession !== null);

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
  const collectionsRef = useRef<CollectionsPlaylistsScreenHandle>(null);
  const playlistsRef = useRef<CollectionsPlaylistsScreenHandle>(null);
  const authorsRef = useRef<AuthorsScreenHandle>(null);

  const refFor = (key: LibrarySegment) =>
    key === "books"
      ? booksRef
      : key === "series"
      ? seriesRef
      : key === "collections"
      ? collectionsRef
      : key === "playlists"
      ? playlistsRef
      : authorsRef;

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
  const handleFacetScroll = (key: LibrarySegment) => (y: number) => {
    scrollOffsets.current[key] = y;
    if (key === segmentRef.current) setShowScrollTop(y > SCROLL_TOP_THRESHOLD);
  };

  const selectSegment = (next: LibrarySegment) => {
    if (next === segment) return;
    setSegment(next);
    // A manual segment switch drops any pending Books deep-link seed.
    setBooksSeed(undefined);
    setShowScrollTop((scrollOffsets.current[next] || 0) > SCROLL_TOP_THRESHOLD);
    storageHelper.setLibraryHubSegment(next);
  };

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
  // standalone bar): Books = filter + sort, Series/Authors = sort, Collections/
  // Playlists = none. Search is global and always available.
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
  const pillRow = (
    <View style={{ paddingHorizontal: 16, paddingTop: 10, paddingBottom: 6 }}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        // A little trailing peek so the last pill ("Authors") is partly visible,
        // hinting the row scrolls.
        contentContainerStyle={{ flexGrow: 1, paddingRight: 16 }}
      >
        <View
          accessibilityRole="tablist"
          style={{
            flexDirection: "row",
            flexGrow: 1,
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
                  minWidth: 84,
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
      </ScrollView>
    </View>
  );

  const renderFacet = (key: LibrarySegment) => {
    const active = key === segment;
    // Only the active facet receives the pill row (a single visible copy) and
    // reports scroll — inactive layers are hidden anyway.
    const listHeader = active ? pillRow : undefined;
    const onScroll = handleFacetScroll(key);
    switch (key) {
      case "books":
        return (
          <LibraryScreen
            ref={booksRef}
            embedded
            navigation={navigation}
            route={{ params: booksSeed || {} }}
            onFilterActiveChange={setBooksFilterActive}
            onSeedConsumed={() => setBooksSeed(undefined)}
            listHeader={listHeader}
            onScroll={onScroll}
          />
        );
      case "series":
        return (
          <SeriesListScreen
            ref={seriesRef}
            embedded
            navigation={navigation}
            listHeader={listHeader}
            onScroll={onScroll}
          />
        );
      case "collections":
        return (
          <CollectionsPlaylistsScreen
            ref={collectionsRef}
            embedded
            mode="collections"
            navigation={navigation}
            listHeader={listHeader}
            onScroll={onScroll}
          />
        );
      case "playlists":
        return (
          <CollectionsPlaylistsScreen
            ref={playlistsRef}
            embedded
            mode="playlists"
            navigation={navigation}
            listHeader={listHeader}
            onScroll={onScroll}
          />
        );
      case "authors":
        return (
          <AuthorsScreen
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

  const showCreateFab = segment === "collections" || segment === "playlists";
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
            the active one is shown. */}
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
            Staggered above the create FAB when both are visible. */}
        {!isSearchActive && showScrollTop ? (
          <Pressable
            onPress={scrollActiveToTop}
            android_ripple={{ color: colors.surfaceContainerHighest }}
            accessibilityRole="button"
            accessibilityLabel="Scroll to top"
            style={{
              position: "absolute",
              right: 16,
              bottom: showCreateFab ? fabBottom + 68 : fabBottom,
              width: 48,
              height: 48,
              borderRadius: 16,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: colors.secondaryContainer,
              elevation: 3,
            }}
          >
            <Icon name="chevron-up" size={26} color={colors.onSecondaryContainer} />
          </Pressable>
        ) : null}

        {/* Create FAB — Material 3 primaryContainer FAB, only on the
            collections/playlists segments, above the mini-player. */}
        {!isSearchActive && showCreateFab ? (
          <Pressable
            onPress={() =>
              (segment === "collections" ? collectionsRef : playlistsRef).current?.openCreate?.()
            }
            android_ripple={{ color: colors.surfaceContainerHighest }}
            accessibilityRole="button"
            accessibilityLabel={`Create new ${segment === "collections" ? "collection" : "playlist"}`}
            style={{
              position: "absolute",
              right: 16,
              bottom: fabBottom,
              width: 56,
              height: 56,
              borderRadius: 16,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: colors.primaryContainer,
              elevation: 3,
            }}
          >
            <Icon name="add" size={26} color={colors.onPrimaryContainer} />
          </Pressable>
        ) : null}
      </View>
    </SafeAreaView>
  );
}
