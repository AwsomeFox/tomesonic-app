import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
} from "react-native";
import { Image } from "expo-image";
import { coverSource } from "../utils/coverSource";
import Animated from "react-native-reanimated";
import { listRowEnter } from "../theme/motion";
import { useThemeColors } from "../theme/useThemeColors";
import { withAlpha } from "../theme/palette";
import { api } from "../utils/api";
import { useLibraryStore } from "../store/useLibraryStore";
import { useUserStore } from "../store/useUserStore";
import { useUiStore } from "../store/useUiStore";
import { usePlaybackStore } from "../store/usePlaybackStore";
import Icon from "./Icon";
import { isEbookOnly } from "../utils/bookMatch";
import { encodeFilterValue } from "./FilterModal";
import BookProgressBadge from "./BookProgressBadge";
import { ListSkeleton } from "./Skeleton";
import RmabMissingSection from "./RmabMissingSection";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface SearchResults {
  book: any[];
  podcast: any[];
  series: any[];
  authors: any[];
  narrators: any[];
  tags: any[];
}

const COVER_W = 46;
const COVER_H = 58;
// Book results use a SQUARE cover; the series collage keeps COVER_W/COVER_H.
const BOOK_COVER = 56;

export default function SearchContent({ navigation }: { navigation: any }) {
  const colors = useThemeColors();
  // SearchContent renders INSIDE tab screens, so `navigation` belongs to the
  // TAB navigator — but every result destination lives on the ROOT stack.
  // Same-name routes resolve in the tab navigator first: "Library" collides
  // with the Library TAB, silently switching tabs UNDERNEATH the still-open
  // search overlay (the page only "appears" after closing search). Route all
  // result taps through the parent stack so they always PUSH on top.
  const rootNav = navigation?.getParent?.() ?? navigation;
  const currentLibraryId = useLibraryStore((state) => state.currentLibraryId);
  const hasSession = usePlaybackStore((state) => state.currentSession !== null);
  const { serverConnectionConfig } = useUserStore();
  const query = useUiStore((s) => s.searchQuery);
  const [results, setResults] = useState<SearchResults | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const serverAddress = serverConnectionConfig?.address?.replace(/\/$/, "") || "";
  const token = serverConnectionConfig?.token || "";

  const getCoverUrl = (itemId: string) => {
    if (!itemId || !serverAddress || !token) return null;
    return `${serverAddress}/api/items/${itemId}/cover?width=400&format=webp&token=${token}`;
  };

  const getAuthorImageUrl = (author: any) => {
    if (!author?.imagePath || !author?.id || !serverAddress || !token) return null;
    return `${serverAddress}/api/authors/${author.id}/image?width=400&format=webp&token=${token}`;
  };

  // Monotonic id so a slow earlier response can't overwrite a newer one
  // (type "cat" → slow; type "catalog" → fast; "cat" must be discarded).
  // Mirrors SearchScreen's guard.
  const searchIdRef = useRef(0);

  const performSearch = useCallback(
    async (searchQuery: string) => {
      if (!searchQuery.trim() || !currentLibraryId) {
        setResults(null);
        setHasSearched(false);
        setLoading(false);
        // Clear a prior failure — the "Search failed" screen renders on
        // `loadError && !hasResults` (independent of hasSearched), so leaving
        // it set would pin the error state over an emptied/invalid query.
        setLoadError(false);
        return;
      }

      const searchId = ++searchIdRef.current;
      try {
        setLoading(true);
        setLoadError(false);
        const response = await api.get(
          `/api/libraries/${currentLibraryId}/search?q=${encodeURIComponent(
            searchQuery.trim()
          )}&limit=5`
        );
        if (searchId !== searchIdRef.current) return; // stale response
        setResults(response.data || null);
        setHasSearched(true);
      } catch (err: any) {
        if (searchId !== searchIdRef.current) return;
        console.error("[Search] Search failed:", err);
        // A network failure is NOT "no results" — masking it as the empty
        // state told users on flaky connections the book wasn't in their
        // library.
        setResults(null);
        setHasSearched(true);
        setLoadError(true);
      } finally {
        if (searchId === searchIdRef.current) setLoading(false);
      }
    },
    [currentLibraryId]
  );

  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    if (!query.trim()) {
      // Invalidate any in-flight search — its stale-guard id must not stay
      // "current", or a slow response would reinstall results under the
      // now-empty search box.
      searchIdRef.current++;
      setResults(null);
      setHasSearched(false);
      setLoading(false);
      // Emptying the box must drop a prior "Search failed" screen too — its
      // render guard (loadError && !hasResults) ignores hasSearched.
      setLoadError(false);
      return;
    }

    setLoading(true);
    debounceRef.current = setTimeout(() => {
      performSearch(query);
    }, 500);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [query, performSearch]);

  const hideNonAudiobooks = useUserStore((s) => !!s.settings?.hideNonAudiobooksGlobal);
  // "Hide non-audiobooks": drop ebook-only books from search results too.
  // Podcast libraries return matches under `podcast` with the same row shape
  // ({libraryItem}) — ignoring them made search render "No results" for every
  // query in a podcast library.
  // Coerce every section: a corrupt response with e.g. series as a STRING
  // passed the `|| []` truthy check and `.map` crashed the whole app (the
  // only ErrorBoundary is at the App root).
  const asArray = (x: any) => (Array.isArray(x) ? x : []);
  // ReadMeABook catalog lookup for the query — DEBOUNCED: `query` updates on
  // every keystroke and the section refetches whenever this callback's
  // identity changes, which would have hit RMAB per keypress.
  const [rmabQuery, setRmabQuery] = React.useState("");
  React.useEffect(() => {
    const t = setTimeout(() => setRmabQuery(query.trim()), 600);
    return () => clearTimeout(t);
  }, [query]);
  const fetchRmabForQuery = React.useCallback(async () => {
    const { searchBooks } = require("../utils/rmab");
    if (!rmabQuery) return [];
    return searchBooks(rmabQuery);
  }, [rmabQuery]);
  const bookResults = [...asArray(results?.book), ...asArray(results?.podcast)].filter(
    (r: any) => r && (!hideNonAudiobooks || !isEbookOnly(r?.libraryItem || r))
  );
  const seriesResults = asArray(results?.series).filter(Boolean);
  const authorResults = asArray(results?.authors).filter(Boolean);
  const narratorResults = asArray(results?.narrators).filter(Boolean);
  const tagResults = asArray(results?.tags).filter(Boolean);
  const hasResults =
    bookResults.length > 0 ||
    seriesResults.length > 0 ||
    authorResults.length > 0 ||
    narratorResults.length > 0 ||
    tagResults.length > 0;

  const renderSectionHeader = (title: string) => (
    <Text
      accessibilityRole="header"
      style={{
        color: colors.onSurface,
        fontSize: 14,
        fontWeight: "600",
        paddingHorizontal: 16,
        paddingTop: 16,
        paddingBottom: 6,
      }}
    >
      {title}
    </Text>
  );

  const rowBorder = {
    borderBottomWidth: 1,
    borderBottomColor: withAlpha(colors.outlineVariant, 0.5),
  };

  const renderBookResult = (result: any, index: number) => {
    const libraryItem = result.libraryItem || {};
    const metadata = libraryItem.media?.metadata || {};
    const cUri = getCoverUrl(libraryItem.id);

    return (
      <AnimatedPressable
        key={libraryItem.id || index}
        entering={listRowEnter(index)}
        android_ripple={{ color: colors.surfaceContainerHighest }}
        accessibilityRole="button"
        accessibilityLabel={`Open ${metadata.title || "book"}`}
        onPress={() =>
          rootNav.navigate("ItemDetail", { itemId: libraryItem.id })
        }
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingVertical: 8,
          paddingHorizontal: 16,
          ...rowBorder,
        }}
      >
        <View
          testID="book-result-cover"
          style={{
            width: BOOK_COVER,
            height: BOOK_COVER,
            borderRadius: 6,
            overflow: "hidden",
            backgroundColor: colors.surfaceContainerHigh,
          }}
        >
          {cUri ? (
            <Image
              source={coverSource(cUri)}
              style={{ width: "100%", height: "100%" }}
              contentFit="cover"
            />
          ) : (
            <View
              style={{ flex: 1, alignItems: "center", justifyContent: "center" }}
            >
              <Icon name="book" size={20} color={colors.onSurfaceVariant} />
            </View>
          )}
        </View>

        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text
            numberOfLines={1}
            style={{ color: colors.onSurface, fontSize: 14 }}
          >
            {metadata.title || "No Title"}
          </Text>
          {metadata.authorName || metadata.author ? (
            <Text
              numberOfLines={1}
              style={{ color: colors.onSurfaceVariant, fontSize: 12, marginTop: 3 }}
            >
              by {metadata.authorName || metadata.author}
            </Text>
          ) : null}
          <BookProgressBadge
            itemId={libraryItem.id}
            item={libraryItem}
            downloaded={result.isLocal || libraryItem.isLocal || !!libraryItem.localLibraryItem}
            style={{ marginTop: 4 }}
          />
        </View>
      </AnimatedPressable>
    );
  };

  const renderSeriesResult = (result: any, index: number) => {
    const series = result.series || {};
    const books = result.books || [];
    const collage = books.slice(0, 4);
    const count = books.length;

    return (
      <AnimatedPressable
        key={series.id || index}
        entering={listRowEnter(index)}
        android_ripple={{ color: colors.surfaceContainerHighest }}
        accessibilityRole="button"
        accessibilityLabel={`${series.name || "Untitled Series"}, ${count} ${
          count === 1 ? "book" : "books"
        }`}
        onPress={() =>
          rootNav.navigate("SeriesDetail", { seriesId: series.id })
        }
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingVertical: 8,
          paddingHorizontal: 16,
          ...rowBorder,
        }}
      >
        <View
          style={{
            width: COVER_W,
            height: COVER_H,
            borderRadius: 6,
            overflow: "hidden",
            backgroundColor: colors.surfaceContainerHigh,
            flexDirection: "row",
            flexWrap: "wrap",
          }}
        >
          {collage.length > 0 ? (
            collage.map((book: any, idx: number) => {
              const cUri = getCoverUrl(book.id);
              const cw = collage.length === 1 ? "100%" : "50%";
              const ch = collage.length <= 2 ? "100%" : "50%";
              return (
                <View key={book.id || idx} style={{ width: cw, height: ch }}>
                  {cUri ? (
                    <Image
                      source={coverSource(cUri)}
                      style={{ width: "100%", height: "100%" }}
                      contentFit="cover"
                    />
                  ) : null}
                </View>
              );
            })
          ) : (
            <View
              style={{ flex: 1, alignItems: "center", justifyContent: "center" }}
            >
              <Icon name="series" size={20} color={colors.onSurfaceVariant} />
            </View>
          )}
        </View>

        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text
            numberOfLines={1}
            style={{ color: colors.onSurface, fontSize: 14 }}
          >
            {series.name || "Untitled Series"}
          </Text>
          <Text
            numberOfLines={1}
            style={{ color: colors.onSurfaceVariant, fontSize: 12, marginTop: 3 }}
          >
            {count} {count === 1 ? "Book" : "Books"}
          </Text>
        </View>
      </AnimatedPressable>
    );
  };

  const renderPersonResult = (
    key: string,
    name: string,
    subtitle: string | null,
    onPress: () => void,
    imageUri: string | null,
    index = 0
  ) => (
    <AnimatedPressable
      key={key}
      entering={listRowEnter(index)}
      android_ripple={{ color: colors.surfaceContainerHighest }}
      accessibilityRole="button"
      accessibilityLabel={`${name}${subtitle ? ", " + subtitle : ""}`}
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        paddingVertical: 10,
        paddingHorizontal: 16,
        ...rowBorder,
      }}
    >
      <View
        style={{
          width: 40,
          height: 40,
          borderRadius: 20,
          overflow: "hidden",
          backgroundColor: colors.primary,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {imageUri ? (
          <Image
            source={coverSource(imageUri)}
            style={{ width: 40, height: 40 }}
            contentFit="cover"
          />
        ) : (
          <Icon name="person" size={22} color={colors.onPrimary} />
        )}
      </View>

      <View style={{ flex: 1, marginLeft: 12 }}>
        <Text numberOfLines={1} style={{ color: colors.onSurface, fontSize: 14 }}>
          {name}
        </Text>
        {subtitle ? (
          <Text
            numberOfLines={1}
            style={{ color: colors.onSurfaceVariant, fontSize: 12, marginTop: 3 }}
          >
            {subtitle}
          </Text>
        ) : null}
      </View>
    </AnimatedPressable>
  );

  const renderTagResult = (tag: any, index: number) => {
    const name = typeof tag === "string" ? tag : tag.name || "";
    return (
      <AnimatedPressable
        key={name || index}
        entering={listRowEnter(index)}
        android_ripple={{ color: colors.surfaceContainerHighest }}
        accessibilityRole="button"
        accessibilityLabel={`Tag: ${name}`}
        onPress={() =>
          // Filter values are base64-$encode'd (ABS convention) — a plain
          // URI-encoded name fails the server's base64 decode and matches nothing.
          rootNav.navigate("Library", {
            filter: `tags.${encodeFilterValue(name)}`,
            title: name,
            showBack: true,
          })
        }
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingVertical: 12,
          paddingHorizontal: 16,
          ...rowBorder,
        }}
      >
        <View
          style={{
            width: 40,
            height: 40,
            borderRadius: 10,
            backgroundColor: colors.surfaceContainerHigh,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name="list" size={20} color={colors.onSurfaceVariant} />
        </View>
        <Text
          numberOfLines={1}
          style={{ color: colors.onSurface, fontSize: 14, flex: 1, marginLeft: 12 }}
        >
          {name}
        </Text>
      </AnimatedPressable>
    );
  };

  // Skeleton rows only when there's nothing on screen yet; while refining an
  // existing query the previous results stay visible (no flash to a spinner).
  if (loading && !hasResults) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.surface }}>
        <ListSkeleton rows={8} thumb={52} />
      </View>
    );
  }

  if (loadError && !hasResults) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          padding: 32,
          backgroundColor: colors.surface,
        }}
      >
        <Icon name="warning" size={48} color={colors.error} />
        {/* Live region: state changes while the user types are otherwise
            silent to screen readers. Same for the no-results/results states. */}
        <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          style={{ color: colors.onSurface, fontSize: 17, fontWeight: "600", marginTop: 16, textAlign: "center" }}
        >
          Search failed
        </Text>
        <Text style={{ color: colors.onSurfaceVariant, fontSize: 14, marginTop: 6, textAlign: "center" }}>
          Check your connection to the server and try again.
        </Text>
        <Pressable
          onPress={() => performSearch(query)}
          android_ripple={{ color: withAlpha(colors.onPrimary, 0.2) }}
          accessibilityRole="button"
          accessibilityLabel="Retry search"
          style={{
            marginTop: 20,
            paddingHorizontal: 24,
            paddingVertical: 10,
            borderRadius: 24,
            overflow: "hidden",
            backgroundColor: colors.primary,
          }}
        >
          <Text style={{ color: colors.onPrimary, fontSize: 15, fontWeight: "600" }}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  if (hasSearched && !hasResults) {
    // The RMAB "Not in your library" section MUST render here too: searching
    // for a book you don't own is the single most common reason to request
    // one, and the old early return made the request option unreachable in
    // exactly that case. The section self-hides when RMAB is unconfigured or
    // has no catalog hits.
    return (
      <ScrollView
        style={{ flex: 1, backgroundColor: colors.surface }}
        contentContainerStyle={{ paddingBottom: hasSession ? 100 : 32 }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ alignItems: "center", paddingTop: 96, paddingHorizontal: 32 }}>
          <Icon name="search" size={48} color={colors.onSurfaceVariant} />
          <Text
            accessibilityLiveRegion="polite"
            style={{ color: colors.onSurface, fontSize: 17, fontWeight: "600", marginTop: 16, textAlign: "center" }}
          >
            No results{query.trim() ? ` for “${query.trim()}”` : ""} in your library
          </Text>
          <Text style={{ color: colors.onSurfaceVariant, fontSize: 14, marginTop: 6, textAlign: "center" }}>
            Try a different title, author, series, or narrator.
          </Text>
        </View>
        <RmabMissingSection title="Not in your library" fetchMissing={fetchRmabForQuery} />
      </ScrollView>
    );
  }

  if (!hasSearched) {
    return (
      <View style={{ flex: 1, alignItems: "center", paddingTop: 96, paddingHorizontal: 32, backgroundColor: colors.surface }}>
        <Icon name="search" size={48} color={colors.onSurfaceVariant} />
        <Text style={{ color: colors.onSurface, fontSize: 17, fontWeight: "600", marginTop: 12, textAlign: "center" }}>
          Search your library
        </Text>
        <Text style={{ color: colors.onSurfaceVariant, fontSize: 14, marginTop: 6, textAlign: "center" }}>
          Find books, series, authors, narrators, and tags.
        </Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.surface }}
      contentContainerStyle={{ paddingBottom: hasSession ? 100 : 32 }}
      keyboardShouldPersistTaps="handled"
    >
      {/* Invisible live region: announces arriving results while the user is
          still focused in the search field. */}
      <Text
        accessibilityLiveRegion="polite"
        importantForAccessibility="yes"
        style={{ position: "absolute", width: 1, height: 1, opacity: 0 }}
      >
        {`${
          bookResults.length + seriesResults.length + authorResults.length +
          narratorResults.length + tagResults.length
        } search results`}
      </Text>
      {bookResults.length > 0 ? (
        <View>
          {renderSectionHeader("Books")}
          {bookResults.map((result, index) => renderBookResult(result, index))}
        </View>
      ) : null}

      {seriesResults.length > 0 ? (
        <View>
          {renderSectionHeader("Series")}
          {seriesResults.map((result, index) =>
            renderSeriesResult(result, index)
          )}
        </View>
      ) : null}

      {authorResults.length > 0 ? (
        <View>
          {renderSectionHeader("Authors")}
          {authorResults.map((result, index) => {
            // ABS search returns authors as PLAIN author objects (verified in
            // server source: authorFilters.search → toOldJSONExpanded) — there
            // is no {author: ...} wrapper. Tolerate both shapes.
            const author = result.author || result || {};
            return renderPersonResult(
              author.id || String(index),
              author.name || "Unknown Author",
              author.numBooks != null
                ? `${author.numBooks} ${author.numBooks === 1 ? "Book" : "Books"}`
                : null,
              () =>
                rootNav.navigate("AuthorDetail", {
                  authorId: author.id,
                  authorName: author.name,
                }),
              getAuthorImageUrl(author),
              index
            );
          })}
        </View>
      ) : null}

      {narratorResults.length > 0 ? (
        <View>
          {renderSectionHeader("Narrators")}
          {narratorResults.map((narrator, index) =>
            renderPersonResult(
              narrator.name || String(index),
              narrator.name || "Unknown Narrator",
              narrator.numBooks != null
                ? `${narrator.numBooks} ${narrator.numBooks === 1 ? "Book" : "Books"}`
                : null,
              () =>
                rootNav.navigate("Library", {
                  filter: `narrators.${encodeFilterValue(narrator.name)}`,
                  title: narrator.name,
                  showBack: true,
                }),
              null,
              index
            )
          )}
        </View>
      ) : null}

      {tagResults.length > 0 ? (
        <View>
          {renderSectionHeader("Tags")}
          {tagResults.map((tag, index) => renderTagResult(tag, index))}
        </View>
      ) : null}

      {/* ReadMeABook: catalog hits NOT in the library, requestable in place.
          Renders nothing unless RMAB is configured in Settings. */}
      <RmabMissingSection title="Not in your library" fetchMissing={fetchRmabForQuery} />
    </ScrollView>
  );
}
