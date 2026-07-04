import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  ActivityIndicator,
} from "react-native";
import { Image } from "expo-image";
import { useThemeColors } from "../theme/useThemeColors";
import { withAlpha } from "../theme/palette";
import { api } from "../utils/api";
import { useLibraryStore } from "../store/useLibraryStore";
import { useUserStore } from "../store/useUserStore";
import { useUiStore } from "../store/useUiStore";
import { usePlaybackStore } from "../store/usePlaybackStore";
import Icon from "./Icon";
import BookProgressBadge from "./BookProgressBadge";

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

export default function SearchContent({ navigation }: { navigation: any }) {
  const colors = useThemeColors();
  const currentLibraryId = useLibraryStore((state) => state.currentLibraryId);
  const hasSession = usePlaybackStore((state) => state.currentSession !== null);
  const { serverConnectionConfig } = useUserStore();
  const query = useUiStore((s) => s.searchQuery);
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

  const performSearch = useCallback(
    async (searchQuery: string) => {
      if (!searchQuery.trim() || !currentLibraryId) {
        setResults(null);
        setHasSearched(false);
        setLoading(false);
        return;
      }

      try {
        setLoading(true);
        const response = await api.get(
          `/api/libraries/${currentLibraryId}/search?q=${encodeURIComponent(
            searchQuery.trim()
          )}&limit=5`
        );
        setResults(response.data || null);
        setHasSearched(true);
      } catch (err: any) {
        console.error("[Search] Search failed:", err);
        setResults(null);
        setHasSearched(true);
      } finally {
        setLoading(false);
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

  const bookResults = results?.book || [];
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
    const cUri = getCoverUrl(libraryItem.id);

    return (
      <Pressable
        key={libraryItem.id || index}
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
          }}
        >
          {cUri ? (
            <Image
              source={{ uri: cUri }}
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
      </Pressable>
    );
  };

  const renderSeriesResult = (result: any, index: number) => {
    const series = result.series || {};
    const books = result.books || [];
    const collage = books.slice(0, 4);
    const count = books.length;

    return (
      <Pressable
        key={series.id || index}
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
      </Pressable>
    );
  };

  const renderPersonResult = (
    key: string,
    name: string,
    subtitle: string | null,
    onPress: () => void,
    imageUri: string | null
  ) => (
    <Pressable
      key={key}
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
    </Pressable>
  );

  const renderTagResult = (tag: any, index: number) => {
    const name = typeof tag === "string" ? tag : tag.name || "";
    return (
      <Pressable
        key={name || index}
        onPress={() =>
          navigation.navigate("Library", {
            filter: `tags.${encodeURIComponent(name)}`,
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
      </Pressable>
    );
  };

  if (loading) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface }}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (hasSearched && !hasResults) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          backgroundColor: colors.surface,
        }}
      >
        <Text style={{ color: colors.onSurfaceVariant, fontSize: 16 }}>
          No items found
        </Text>
      </View>
    );
  }

  if (!hasSearched) {
    return (
      <View style={{ flex: 1, alignItems: "center", paddingTop: 96, backgroundColor: colors.surface }}>
        <Icon name="search" size={48} color={colors.onSurfaceVariant} />
        <Text
          style={{ color: colors.onSurfaceVariant, fontSize: 16, marginTop: 12 }}
        >
          Search
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
            const author = result.author || {};
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
              getAuthorImageUrl(author)
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
                  filter: `narrators.${encodeURIComponent(narrator.name)}`,
                  title: narrator.name,
                  showBack: true,
                }),
              null
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
  );
}
