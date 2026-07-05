import React, { useEffect, useState, useCallback, useMemo } from "react";
import {
  View,
  Text,
  FlatList,
  Pressable,
  RefreshControl,
  useWindowDimensions,
} from "react-native";
import { Image } from "expo-image";
import { coverSource } from "../utils/coverSource";
import { SafeAreaView } from "react-native-safe-area-context";
import Animated from "react-native-reanimated";
import { listRowEnter } from "../theme/motion";
import { api } from "../utils/api";
import { useLibraryStore } from "../store/useLibraryStore";
import { useUserStore } from "../store/useUserStore";
import { useThemeColors } from "../theme/useThemeColors";
import { withAlpha } from "../theme/palette";
import TopAppBar from "../components/TopAppBar";
import OrderModal, { SortItem } from "../components/OrderModal";
import { GridSkeleton } from "../components/Skeleton";
import Icon from "../components/Icon";
import { useUiStore } from "../store/useUiStore";
import { usePlaybackStore } from "../store/usePlaybackStore";
import SearchContent from "../components/SearchContent";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

const GRID_PADDING = 16;
const CARD_GAP = 16;

interface AuthorBook {
  id: string;
  updatedAt?: number;
}

interface Author {
  id: string;
  name: string;
  numBooks?: number;
  imagePath?: string | null;
  addedAt?: number;
  updatedAt?: number;
  books?: AuthorBook[];
  coverBooks?: AuthorBook[];
}

type SortKey = "name" | "lastFirst" | "numBooks" | "addedAt";

// Same OrderModal bottom sheet as the library page, with author fields.
const SORT_ITEMS: SortItem[] = [
  { text: "Name (First Last)", value: "name" },
  { text: "Name (Last, First)", value: "lastFirst" },
  { text: "Number of Books", value: "numBooks" },
  { text: "Added At", value: "addedAt" },
];

function lastName(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? parts[parts.length - 1] : name;
}

export default function AuthorsScreen({ navigation }: any) {
  const colors = useThemeColors();
  const isSearchActive = useUiStore((s) => s.isSearchActive);
  const { width } = useWindowDimensions();
  const { currentLibraryId } = useLibraryStore();
  const { serverConnectionConfig } = useUserStore();
  const hasSession = usePlaybackStore((s) => s.currentSession !== null);

  const [authors, setAuthors] = useState<Author[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState(false);
  // Sort field + direction, persisted like the library page's sort settings.
  const savedSettings = useUserStore.getState().settings;
  const updateUserSettings = useUserStore((s) => s.updateUserSettings);
  const [sortKey, setSortKey] = useState<SortKey>(
    (savedSettings?.mobileAuthorsOrderBy as SortKey) || "name"
  );
  const [descending, setDescending] = useState<boolean>(
    savedSettings?.mobileAuthorsOrderDesc ?? false
  );
  const [sortOpen, setSortOpen] = useState(false);

  const serverAddress = serverConnectionConfig?.address?.replace(/\/$/, "") || "";
  const token = serverConnectionConfig?.token || "";

  // 2 columns on phones (unchanged); more on tablet widths so the square cards
  // don't blow up to fill half the screen each.
  const numColumns = Math.max(2, Math.floor((width - GRID_PADDING * 2) / 220));
  // Card is a square: available width minus outer padding & inter-card gaps.
  const cardSize = Math.floor(
    (width - GRID_PADDING * 2 - CARD_GAP * (numColumns - 1)) / numColumns
  );

  const getAuthorImageUrl = (author: Author) => {
    if (!author.imagePath || !serverAddress || !token) return null;
    return `${serverAddress}/api/authors/${author.id}/image?width=400&format=webp&token=${token}`;
  };

  const getCoverUrl = (itemId: string) => {
    if (!itemId || !serverAddress || !token) return null;
    return `${serverAddress}/api/items/${itemId}/cover?width=400&format=webp&token=${token}`;
  };

  const fetchAuthors = useCallback(async () => {
    if (!currentLibraryId) return;
    setLoading(true);
    setLoadError(false);
    try {
      const response = await api.get(
        `/api/libraries/${currentLibraryId}/authors`
      );
      const data = response.data || {};
      const results: Author[] = data.authors || data.results || data || [];
      setAuthors(results);
    } catch (err) {
      console.error("[AuthorsScreen] Failed to fetch authors:", err);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [currentLibraryId]);

  useEffect(() => {
    fetchAuthors();
  }, [fetchAuthors]);

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await fetchAuthors();
    } finally {
      setRefreshing(false);
    }
  };

  const sortedAuthors = useMemo(() => {
    const list = [...authors];
    const dir = descending ? -1 : 1;
    switch (sortKey) {
      case "numBooks":
        list.sort((a, b) => dir * ((a.numBooks || 0) - (b.numBooks || 0)));
        break;
      case "addedAt":
        list.sort((a, b) => dir * ((a.addedAt || 0) - (b.addedAt || 0)));
        break;
      case "lastFirst":
        list.sort(
          (a, b) => dir * lastName(a.name || "").localeCompare(lastName(b.name || ""))
        );
        break;
      case "name":
      default:
        list.sort((a, b) => dir * (a.name || "").localeCompare(b.name || ""));
        break;
    }
    return list;
  }, [authors, sortKey, descending]);

  const renderItem = ({ item, index }: { item: Author; index: number }) => {
    const imageUri = getAuthorImageUrl(item);
    const coverBooks = (item.coverBooks?.length ? item.coverBooks : item.books) || [];
    const collage = coverBooks.slice(0, 4);
    const numBooks =
      typeof item.numBooks === "number" && item.numBooks >= 0
        ? item.numBooks
        : collage.length;

    return (
      <AnimatedPressable
        entering={listRowEnter(index)}
        onPress={() =>
          navigation.navigate("AuthorDetail", {
            authorId: item.id,
            authorName: item.name,
          })
        }
        android_ripple={{ color: withAlpha(colors.onSurface, 0.12) }}
        accessibilityRole="button"
        accessibilityLabel={`Author: ${item.name}, ${numBooks} ${numBooks === 1 ? "book" : "books"}`}
        style={{
          width: cardSize,
          height: cardSize,
          borderRadius: 16,
          overflow: "hidden",
          backgroundColor: colors.surfaceContainer,
          borderWidth: 1,
          borderColor: withAlpha(colors.outlineVariant, 0.35),
          marginBottom: CARD_GAP,
        }}
      >
        {/* Image / collage / placeholder fills the whole card */}
        {imageUri ? (
          <Image
            source={coverSource(imageUri)}
            style={{ width: "100%", height: "100%" }}
            contentFit="cover"
          />
        ) : collage.length > 0 ? (
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              width: "100%",
              height: "100%",
            }}
          >
            {collage.map((book, idx) => {
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
                  ) : (
                    <View
                      style={{
                        width: "100%",
                        height: "100%",
                        backgroundColor: colors.surfaceContainerHigh,
                      }}
                    />
                  )}
                </View>
              );
            })}
          </View>
        ) : (
          <View
            style={{
              flex: 1,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: colors.surfaceContainer,
            }}
          >
            <Icon name="person" size={44} color={colors.onSurfaceVariant} />
          </View>
        )}

        {/* Translucent grey bottom panel with name + book count */}
        <View
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            paddingHorizontal: 12,
            paddingTop: 10,
            paddingBottom: 12,
            backgroundColor: withAlpha(colors.onSurface, 0.55),
          }}
        >
          <Text
            numberOfLines={1}
            style={{
              color: colors.isDark ? colors.onSurface : "#FFFFFF",
              fontSize: 15,
              fontWeight: "700",
            }}
          >
            {item.name}
          </Text>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              marginTop: 3,
            }}
          >
            <Icon
              name="book"
              size={13}
              color={withAlpha(colors.isDark ? colors.onSurface : "#FFFFFF", 0.85)}
            />
            <Text
              numberOfLines={1}
              style={{
                color: withAlpha(colors.isDark ? colors.onSurface : "#FFFFFF", 0.85),
                fontSize: 12,
                fontWeight: "500",
                marginLeft: 5,
              }}
            >
              {numBooks} {numBooks === 1 ? "Book" : "Books"}
            </Text>
          </View>
        </View>
      </AnimatedPressable>
    );
  };

  if (isSearchActive) {
    return (
      <SafeAreaView
        style={{ flex: 1, backgroundColor: colors.surface }}
        edges={["top", "left", "right"]}
      >
        <TopAppBar navigation={navigation} />
        <SearchContent navigation={navigation} />
      </SafeAreaView>
    );
  }

  if (loading && authors.length === 0) {
    return (
      <SafeAreaView
        style={{ flex: 1, backgroundColor: colors.surface }}
        edges={["top", "left", "right"]}
      >
        <TopAppBar navigation={navigation} />
        {/* Square tiles to match the real author cards (no snap on arrival). */}
        <GridSkeleton columns={numColumns} count={numColumns * 4} aspectRatio={1} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: colors.surface }}
      edges={["top", "left", "right"]}
    >
      {/* Same top-bar sort affordance as the library page. */}
      <TopAppBar navigation={navigation} showSort onSort={() => setSortOpen(true)} />

      <OrderModal
        visible={sortOpen}
        onClose={() => setSortOpen(false)}
        orderBy={sortKey}
        descending={descending}
        items={SORT_ITEMS}
        onChange={(o, d) => {
          setSortKey(o as SortKey);
          setDescending(d);
          // Persist so the choice survives restarts (mirrors the library page).
          updateUserSettings({ mobileAuthorsOrderBy: o, mobileAuthorsOrderDesc: d }).catch(() => {});
        }}
      />

      {loadError && authors.length === 0 ? (
        <View
          style={{
            flex: 1,
            alignItems: "center",
            justifyContent: "center",
            padding: 32,
          }}
        >
          <Icon name="warning" size={48} color={colors.error} />
          <Text
            style={{
              color: colors.onSurface,
              fontSize: 17,
              fontWeight: "600",
              marginTop: 16,
              marginBottom: 6,
              textAlign: "center",
            }}
          >
            Couldn't load authors
          </Text>
          <Text
            style={{
              color: colors.onSurfaceVariant,
              fontSize: 14,
              textAlign: "center",
            }}
          >
            Check your connection to the server and try again.
          </Text>
          <Pressable
            onPress={fetchAuthors}
            android_ripple={{ color: withAlpha(colors.onPrimary, 0.2) }}
            accessibilityRole="button"
            accessibilityLabel="Retry loading authors"
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
      ) : authors.length === 0 ? (
        <View
          style={{
            flex: 1,
            alignItems: "center",
            justifyContent: "center",
            padding: 32,
          }}
        >
          <Icon name="authors" size={56} color={colors.onSurfaceVariant} />
          <Text
            style={{
              color: colors.onSurface,
              fontSize: 18,
              fontWeight: "bold",
              marginTop: 16,
              marginBottom: 8,
            }}
          >
            No authors found
          </Text>
          <Text
            style={{
              color: colors.onSurfaceVariant,
              fontSize: 14,
              textAlign: "center",
            }}
          >
            No authors have been added to this library yet.
          </Text>
        </View>
      ) : (
        <FlatList
          key={`authors-grid-${numColumns}`}
          data={sortedAuthors}
          renderItem={renderItem}
          keyExtractor={(item) => item.id}
          numColumns={numColumns}
          // gap (not space-between) so an incomplete last row packs left
          // instead of stretching across the width.
          columnWrapperStyle={{ gap: CARD_GAP }}
          contentContainerStyle={{
            paddingHorizontal: GRID_PADDING,
            paddingTop: 4,
            paddingBottom: hasSession ? 100 : 32,
          }}
          showsVerticalScrollIndicator={false}
          initialNumToRender={8}
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
    </SafeAreaView>
  );
}
