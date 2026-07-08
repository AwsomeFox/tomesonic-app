import React, { useEffect, useRef, useState } from "react";
import { View, Text, Pressable, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useThemeColors } from "../theme/useThemeColors";
import TopAppBar from "../components/TopAppBar";
import Icon, { IconName } from "../components/Icon";
import SearchContent from "../components/SearchContent";
import { useUiStore } from "../store/useUiStore";
import { storageHelper } from "../utils/storage";
import LibraryScreen, { LibraryScreenHandle } from "./LibraryScreen";
import SeriesListScreen, { SeriesListScreenHandle } from "./SeriesListScreen";
import CollectionsPlaylistsScreen from "./CollectionsPlaylistsScreen";
import AuthorsScreen, { AuthorsScreenHandle } from "./AuthorsScreen";

/**
 * LibraryHubScreen — Material 3 "Library" destination that consolidates the
 * four library-browse facets (Books · Series · Collections · Authors) behind a
 * single bottom-tab entry with a segmented control. This keeps the bottom bar
 * at Home · Library · [Discover] (≤5 M3 destinations) instead of repeating the
 * "browse the library" job across four tabs.
 *
 * The hub owns the shared chrome — one SafeAreaView + one TopAppBar — and the
 * embedded facet screens render only their list/content body (they accept an
 * `embedded` prop that drops their own SafeAreaView/TopAppBar). Contextual
 * TopAppBar actions (filter+sort for Books, sort for Series/Authors) are driven
 * through each embedded screen's imperative handle. Search is global, so it is
 * surfaced on every segment and, when active, the hub shows the shared
 * SearchContent overlay in place of the segment body.
 */

export type LibrarySegment = "books" | "series" | "collections" | "authors";

const SEGMENTS: { key: LibrarySegment; label: string; icon: IconName }[] = [
  { key: "books", label: "Books", icon: "book" },
  { key: "series", label: "Series", icon: "series" },
  { key: "collections", label: "Collections", icon: "collections" },
  { key: "authors", label: "Authors", icon: "authors" },
];

const VALID_SEGMENTS = SEGMENTS.map((s) => s.key);

function normalizeSegment(value: any): LibrarySegment | null {
  return VALID_SEGMENTS.includes(value) ? (value as LibrarySegment) : null;
}

export default function LibraryHubScreen({ route, navigation }: any) {
  const colors = useThemeColors();
  const isSearchActive = useUiStore((s) => s.isSearchActive);

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

  // Books deep-link seed (filter/sort). Consumed on the first Books mount and
  // discarded the moment the user manually switches segments, so bouncing back
  // to Books later shows the user's own saved sort/filter rather than re-applying
  // a stale deep-link.
  const [booksSeed, setBooksSeed] = useState<any>(() =>
    hasBooksSeed
      ? { filter: params.filter, orderBy: params.orderBy, descending: params.descending }
      : undefined
  );

  // A fresh navigation into this tab with new params re-selects Books + reseeds.
  useEffect(() => {
    if (
      params.filter !== undefined ||
      params.orderBy !== undefined ||
      params.descending !== undefined
    ) {
      setSegment("books");
      setBooksSeed({
        filter: params.filter,
        orderBy: params.orderBy,
        descending: params.descending,
      });
    } else if (normalizeSegment(params.segment)) {
      setSegment(params.segment as LibrarySegment);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.segment, params.filter, params.orderBy, params.descending]);

  // Imperative handles for the active facet — the shared TopAppBar's filter/sort
  // buttons call into whichever facet is mounted.
  const booksRef = useRef<LibraryScreenHandle>(null);
  const seriesRef = useRef<SeriesListScreenHandle>(null);
  const authorsRef = useRef<AuthorsScreenHandle>(null);

  // The Books facet reports when its filter/sort differs from the default so the
  // shared TopAppBar can badge the filter icon (a persisted filter is otherwise
  // invisible on the hub's Books segment).
  const [booksFilterActive, setBooksFilterActive] = useState(false);

  const selectSegment = (next: LibrarySegment) => {
    if (next === segment) return;
    setSegment(next);
    setBooksSeed(undefined);
    storageHelper.setLibraryHubSegment(next);
  };

  // Contextual TopAppBar affordances per active segment (mirrors each facet's
  // standalone bar): Books = filter + sort, Series/Authors = sort, Collections
  // = none. Search is global and always available.
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

  const renderSegmentContent = () => {
    switch (segment) {
      case "books":
        return (
          <LibraryScreen
            ref={booksRef}
            embedded
            navigation={navigation}
            route={{ params: booksSeed || {} }}
            onFilterActiveChange={setBooksFilterActive}
          />
        );
      case "series":
        return <SeriesListScreen ref={seriesRef} embedded navigation={navigation} />;
      case "collections":
        return <CollectionsPlaylistsScreen embedded navigation={navigation} />;
      case "authors":
        return <AuthorsScreen ref={authorsRef} embedded navigation={navigation} />;
      default:
        return null;
    }
  };

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

      {isSearchActive ? (
        <SearchContent navigation={navigation} />
      ) : (
        <>
          {/* Material 3 segmented control — one row of connected segments. */}
          <View style={{ paddingHorizontal: 16, paddingTop: 10, paddingBottom: 6 }}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ flexGrow: 1 }}
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
                      style={{
                        flex: 1,
                        minWidth: 90,
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

          {/* Active facet body — provides its own list/error/empty states. */}
          <View style={{ flex: 1 }}>{renderSegmentContent()}</View>
        </>
      )}
    </SafeAreaView>
  );
}
