import React, { useEffect, useState, useCallback, useMemo } from "react";
import {
  View,
  Text,
  FlatList,
  Pressable,
  useWindowDimensions,
} from "react-native";
import { Image } from "expo-image";
import { SafeAreaView } from "react-native-safe-area-context";
import Animated from "react-native-reanimated";
import { listRowEnter } from "../theme/motion";
import { api } from "../utils/api";
import { useLibraryStore } from "../store/useLibraryStore";
import { useUserStore } from "../store/useUserStore";
import { useThemeColors } from "../theme/useThemeColors";
import { withAlpha } from "../theme/palette";
import TopAppBar from "../components/TopAppBar";
import { GridSkeleton } from "../components/Skeleton";
import Icon from "../components/Icon";
import { useUiStore } from "../store/useUiStore";
import SearchContent from "../components/SearchContent";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

const NUM_COLUMNS = 2;
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

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "lastFirst", label: "Last, First" },
  { key: "numBooks", label: "# Books" },
  { key: "addedAt", label: "Added" },
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

  const [authors, setAuthors] = useState<Author[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>("name");

  const serverAddress = serverConnectionConfig?.address?.replace(/\/$/, "") || "";
  const token = serverConnectionConfig?.token || "";

  // Card is a square: available width minus outer padding & inter-card gap, split 2-up.
  const cardSize = Math.floor(
    (width - GRID_PADDING * 2 - CARD_GAP) / NUM_COLUMNS
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
    try {
      const response = await api.get(
        `/api/libraries/${currentLibraryId}/authors`
      );
      const data = response.data || {};
      const results: Author[] = data.authors || data.results || data || [];
      setAuthors(results);
    } catch (err) {
      console.error("[AuthorsScreen] Failed to fetch authors:", err);
    } finally {
      setLoading(false);
    }
  }, [currentLibraryId]);

  useEffect(() => {
    fetchAuthors();
  }, [fetchAuthors]);

  const sortedAuthors = useMemo(() => {
    const list = [...authors];
    switch (sortKey) {
      case "numBooks":
        list.sort((a, b) => (b.numBooks || 0) - (a.numBooks || 0));
        break;
      case "addedAt":
        list.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
        break;
      case "lastFirst":
        list.sort((a, b) =>
          lastName(a.name || "").localeCompare(lastName(b.name || ""))
        );
        break;
      case "name":
      default:
        list.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
        break;
    }
    return list;
  }, [authors, sortKey]);

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
            source={{ uri: imageUri }}
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
                      source={{ uri: cUri }}
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
        <TopAppBar navigation={navigation} showSort />
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
        <TopAppBar navigation={navigation} showSort />
        <GridSkeleton columns={NUM_COLUMNS} count={NUM_COLUMNS * 4} aspectRatio={0.78} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: colors.surface }}
      edges={["top", "left", "right"]}
    >
      <TopAppBar navigation={navigation} showSort />

      {/* Sort selector */}
      <View
        style={{
          flexDirection: "row",
          paddingHorizontal: GRID_PADDING,
          paddingTop: 4,
          paddingBottom: 10,
        }}
      >
        {SORT_OPTIONS.map((opt) => (
          <Pressable
            key={opt.key}
            onPress={() => setSortKey(opt.key)}
            style={{
              paddingVertical: 6,
              paddingHorizontal: 12,
              borderRadius: 16,
              marginRight: 8,
              backgroundColor:
                sortKey === opt.key
                  ? colors.secondaryContainer
                  : colors.surfaceContainer,
            }}
          >
            <Text
              style={{
                color:
                  sortKey === opt.key
                    ? colors.onSecondaryContainer
                    : colors.onSurfaceVariant,
                fontSize: 12,
                fontWeight: "600",
              }}
            >
              {opt.label}
            </Text>
          </Pressable>
        ))}
      </View>

      {authors.length === 0 ? (
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
          data={sortedAuthors}
          renderItem={renderItem}
          keyExtractor={(item) => item.id}
          numColumns={NUM_COLUMNS}
          columnWrapperStyle={{ justifyContent: "space-between" }}
          contentContainerStyle={{
            paddingHorizontal: GRID_PADDING,
            paddingTop: 4,
            paddingBottom: 32,
          }}
          showsVerticalScrollIndicator={false}
        />
      )}
    </SafeAreaView>
  );
}
