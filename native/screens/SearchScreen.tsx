import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
} from "react-native";
import { Image } from "expo-image";
import Animated from "react-native-reanimated";
import { listRowEnter } from "../theme/motion";
import { useThemeColors } from "../theme/useThemeColors";
import { withAlpha } from "../theme/palette";
import { SafeAreaView } from "react-native-safe-area-context";
import { api } from "../utils/api";
import { useLibraryStore } from "../store/useLibraryStore";
import { useUserStore } from "../store/useUserStore";
import Icon from "../components/Icon";
import { isEbookOnly } from "../utils/bookMatch";
import { encodeFilterValue } from "../components/FilterModal";
import BookProgressBadge from "../components/BookProgressBadge";
import { ListSkeleton } from "../components/Skeleton";
import { usePlaybackStore } from "../store/usePlaybackStore";

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

export default function SearchScreen({ navigation }: any) {
  const colors = useThemeColors();
  const currentLibraryId = useLibraryStore((state) => state.currentLibraryId);
  const hasSession = usePlaybackStore((state) => state.currentSession !== null);
  const { serverConnectionConfig } = useUserStore();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResults | null>(null);
  const [loading, setLoading] = useState(false);
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
  const searchIdRef = useRef(0);

  const performSearch = useCallback(
    async (searchQuery: string) => {
      if (!searchQuery.trim() || !currentLibraryId) {
        setResults(null);
        setHasSearched(false);
        setLoading(false);
        return;
      }

      const searchId = ++searchIdRef.current;
      try {
        setLoading(true);
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
        setResults(null);
        setHasSearched(true);
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
      setResults(null);
      setHasSearched(false);
      setLoading(false);
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
  const bookResults = (results?.book || []).filter(
    (r: any) => !hideNonAudiobooks || !isEbookOnly(r?.libraryItem || r)
  );
  const seriesResults = results?.series || [];
  const authorResults = results?.authors || [];
  const narratorResults = results?.narrators || [];
  const tagResults = results?.tags || [];
  const hasResults =
    bookResults.length > 0 ||
    seriesResults.length > 0 ||
    authorResults.length > 0 ||
    narratorResults.length > 0 ||
    tagResults.length > 0;

  const renderSectionHeader = (title: string) => (
    <Text
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
    const coverUrl = getCoverUrl(libraryItem.id);

    return (
      <AnimatedPressable
        key={libraryItem.id || index}
        entering={listRowEnter(index)}
        android_ripple={{ color: colors.surfaceContainerHighest }}
        onPress={() =>
          navigation.navigate("ItemDetail", { itemId: libraryItem.id })
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
            position: "relative",
          }}
        >
          {coverUrl ? (
            <Image
              source={{ uri: coverUrl }}
              style={{ width: COVER_W, height: COVER_H }}
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
        onPress={() =>
          navigation.navigate("SeriesDetail", { seriesId: series.id })
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
                      source={{ uri: cUri }}
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
            source={{ uri: imageUri }}
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
        onPress={() =>
          // Filter values are base64-$encode'd (ABS convention) — a plain
          // URI-encoded name fails the server's base64 decode and matches nothing.
          navigation.navigate("Library", {
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

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: colors.surface }}
      edges={["top", "left", "right"]}
    >
      {/* Top bar: back arrow + full-width rounded search field */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 8,
          paddingVertical: 8,
          backgroundColor: colors.surface,
          borderBottomWidth: 1,
          borderBottomColor: withAlpha(colors.outlineVariant, 0.5),
        }}
      >
        <Pressable
          onPress={() => navigation.goBack()}
          hitSlop={8}
          android_ripple={{ color: colors.surfaceContainerHighest, borderless: true, radius: 22 }}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={{ padding: 10, borderRadius: 24 }}
        >
          <Icon name="back" size={24} color={colors.onSurface} />
        </Pressable>

        <View
          style={{
            flex: 1,
            flexDirection: "row",
            alignItems: "center",
            backgroundColor: colors.surface,
            borderWidth: 1,
            borderColor: colors.outline,
            borderRadius: 28,
            paddingHorizontal: 16,
            paddingVertical: 8,
            marginLeft: 4,
          }}
        >
          <Icon name="search" size={20} color={colors.onSurfaceVariant} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search"
            placeholderTextColor={colors.onSurfaceVariant}
            autoFocus
            returnKeyType="search"
            style={{
              flex: 1,
              color: colors.onSurface,
              fontSize: 16,
              padding: 0,
              marginLeft: 12,
            }}
          />
          {query.length > 0 ? (
            <Pressable
              onPress={() => {
                setQuery("");
                setResults(null);
                setHasSearched(false);
              }}
              hitSlop={8}
              android_ripple={{ color: colors.surfaceContainerHighest, borderless: true, radius: 18 }}
              accessibilityRole="button"
              accessibilityLabel="Clear search"
              style={{ padding: 2 }}
            >
              <Icon name="close" size={18} color={colors.onSurfaceVariant} />
            </Pressable>
          ) : null}
        </View>
      </View>

      {/* Content — skeleton rows only while there's nothing on screen yet;
          refining an existing query keeps the previous results visible
          (no flash to a bare loading state). */}
      {loading && !hasResults ? (
        <ListSkeleton rows={8} thumb={52} />
      ) : hasSearched && !hasResults ? (
        <View
          style={{
            flex: 1,
            alignItems: "center",
            justifyContent: "center",
            padding: 32,
          }}
        >
          <Icon name="search" size={48} color={colors.onSurfaceVariant} />
          <Text style={{ color: colors.onSurface, fontSize: 17, fontWeight: "600", marginTop: 16, textAlign: "center" }}>
            No results{query.trim() ? ` for “${query.trim()}”` : ""}
          </Text>
          <Text style={{ color: colors.onSurfaceVariant, fontSize: 14, marginTop: 6, textAlign: "center" }}>
            Try a different title, author, series, or narrator.
          </Text>
        </View>
      ) : !hasSearched ? (
        <View style={{ flex: 1, alignItems: "center", paddingTop: 96, paddingHorizontal: 32 }}>
          <Icon name="search" size={48} color={colors.onSurfaceVariant} />
          <Text style={{ color: colors.onSurface, fontSize: 17, fontWeight: "600", marginTop: 12, textAlign: "center" }}>
            Search your library
          </Text>
          <Text style={{ color: colors.onSurfaceVariant, fontSize: 14, marginTop: 6, textAlign: "center" }}>
            Find books, series, authors, narrators, and tags.
          </Text>
        </View>
      ) : (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: hasSession ? 100 : 32 }}
          keyboardShouldPersistTaps="handled"
        >
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
                // ABS search returns authors as PLAIN author objects — no
                // {author: ...} wrapper. Tolerate both shapes.
                const author = result.author || result || {};
                return renderPersonResult(
                  author.id || String(index),
                  author.name || "Unknown Author",
                  author.numBooks != null
                    ? `${author.numBooks} ${author.numBooks === 1 ? "Book" : "Books"}`
                    : null,
                  () =>
                    navigation.navigate("AuthorDetail", {
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
                    navigation.navigate("Library", {
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
        </ScrollView>
      )}
    </SafeAreaView>
  );
}
