import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  FlatList,
  Pressable,
} from "react-native";
import { Image } from "expo-image";
import { coverSource } from "../utils/coverSource";
import { useThemeColors } from "../theme/useThemeColors";
import { SafeAreaView } from "react-native-safe-area-context";
import Animated from "react-native-reanimated";
import { listRowEnter } from "../theme/motion";
import { api } from "../utils/api";
import { useUserStore } from "../store/useUserStore";
import { withAlpha } from "../theme/palette";
import Icon from "../components/Icon";
import { isEbookOnly } from "../utils/bookMatch";
import BookProgressBadge from "../components/BookProgressBadge";
import Skeleton, { ListSkeleton } from "../components/Skeleton";
import { usePlaybackStore } from "../store/usePlaybackStore";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

const COVER_WIDTH = 80;
const COVER_HEIGHT = 120;

interface AuthorBook {
  id: string;
  media?: {
    metadata?: {
      title?: string;
      subtitle?: string;
    };
  };
}

interface AuthorData {
  id: string;
  name: string;
  description?: string | null;
  imagePath?: string | null;
  libraryItems: AuthorBook[];
}

export default function AuthorDetailScreen({ route, navigation }: any) {
  const colors = useThemeColors();
  const hasSession = usePlaybackStore((s) => s.currentSession !== null);
  const { authorId, authorName } = route.params || {};
  const { serverConnectionConfig } = useUserStore();

  const [author, setAuthor] = useState<AuthorData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [retryTick, setRetryTick] = useState(0);
  const [descExpanded, setDescExpanded] = useState(false);

  const serverAddress = serverConnectionConfig?.address?.replace(/\/$/, "") || "";
  const token = serverConnectionConfig?.token || "";

  const getCoverUrl = (itemId: string) => {
    if (!itemId || !serverAddress || !token) return null;
    return `${serverAddress}/api/items/${itemId}/cover?width=400&format=webp&token=${token}`;
  };

  const getAuthorImageUrl = () => {
    if (!author?.imagePath || !serverAddress || !token) return null;
    return `${serverAddress}/api/authors/${author.id}/image?width=400&format=webp&token=${token}`;
  };

  useEffect(() => {
    const fetchAuthorDetail = async () => {
      if (!authorId) {
        setLoading(false);
        setLoadError(true);
        return;
      }
      setLoading(true);
      setLoadError(false);
      try {
        const response = await api.get(
          `/api/authors/${authorId}?include=items,series`
        );
        const data = response.data || {};
        setAuthor({
          id: data.id,
          name: data.name || authorName || "Unknown Author",
          description: data.description,
          imagePath: data.imagePath,
          libraryItems: data.libraryItems || data.items || [],
        });
      } catch (err) {
        console.error("[AuthorDetailScreen] Failed to fetch author:", err);
        setLoadError(true);
      } finally {
        setLoading(false);
      }
    };

    fetchAuthorDetail();
  }, [authorId, retryTick]);

  const renderBookCard = ({ item, index }: { item: AuthorBook; index: number }) => {
    const coverUri = getCoverUrl(item.id);
    const title = item.media?.metadata?.title || "Untitled";
    const subtitle = item.media?.metadata?.subtitle || "";

    return (
      <AnimatedPressable
        entering={listRowEnter(index)}
        onPress={() => navigation.navigate("ItemDetail", { itemId: item.id })}
        android_ripple={{ color: colors.surfaceContainerHighest }}
        style={{
          flexDirection: "row",
          backgroundColor: colors.surfaceContainer,
          borderRadius: 16,
          marginBottom: 10,
          marginHorizontal: 16,
          overflow: "hidden",
          elevation: 3,
          shadowColor: "#000",
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: 0.25,
          shadowRadius: 4,
        }}
      >
        <View
          style={{
            width: COVER_WIDTH,
            height: COVER_HEIGHT,
            backgroundColor: colors.surfaceContainerHigh,
            position: "relative",
          }}
        >
          {coverUri ? (
            <Image
              source={coverSource(coverUri)}
              style={{ width: COVER_WIDTH, height: COVER_HEIGHT }}
              contentFit="cover"
            />
          ) : (
            <View
              style={{
                flex: 1,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: colors.surfaceContainerHigh,
              }}
            >
              <Icon name="book" size={28} color={colors.onSurfaceVariant} />
            </View>
          )}
        </View>

        <View
          style={{
            flex: 1,
            paddingVertical: 12,
            paddingHorizontal: 14,
            justifyContent: "center",
          }}
        >
          <Text
            numberOfLines={2}
            style={{
              color: colors.onSurface,
              fontSize: 15,
              fontWeight: "bold",
              marginBottom: 4,
            }}
          >
            {title}
          </Text>
          {subtitle ? (
            <Text
              numberOfLines={1}
              style={{ color: colors.onSurfaceVariant, fontSize: 12 }}
            >
              {subtitle}
            </Text>
          ) : null}
          <BookProgressBadge
            itemId={item.id}
            item={item}
            downloaded={(item as any).isLocal || !!(item as any).localLibraryItem}
            style={{ marginTop: 4 }}
          />
        </View>
      </AnimatedPressable>
    );
  };

  const imageUri = getAuthorImageUrl();
  // "Hide non-audiobooks": ebook-only rows are dropped when the setting is on.
  const hideNonAudiobooks = useUserStore((s) => !!s.settings?.hideNonAudiobooksGlobal);
  const books = (author?.libraryItems || []).filter((b: any) => !hideNonAudiobooks || !isEbookOnly(b));

  const renderHeader = () => (
    <View style={{ paddingBottom: 8 }}>
      {/* Author profile */}
      <View style={{ alignItems: "center", paddingTop: 12, paddingBottom: 16 }}>
        <View
          style={{
            width: 120,
            height: 120,
            borderRadius: 60,
            overflow: "hidden",
            backgroundColor: colors.primary,
            alignItems: "center",
            justifyContent: "center",
            marginBottom: 14,
          }}
        >
          {imageUri ? (
            <Image
              source={coverSource(imageUri)}
              style={{ width: 120, height: 120 }}
              contentFit="cover"
            />
          ) : (
            <Icon name="person" size={56} color={colors.onPrimary} />
          )}
        </View>
        <Text
          style={{
            color: colors.onSurface,
            fontSize: 22,
            fontWeight: "bold",
            textAlign: "center",
            paddingHorizontal: 24,
          }}
        >
          {author?.name || authorName}
        </Text>
        <Text
          style={{
            color: colors.onSurfaceVariant,
            fontSize: 13,
            marginTop: 4,
          }}
        >
          {books.length} {books.length === 1 ? "book" : "books"}
        </Text>

        {author?.description ? (
          <Pressable
            onPress={() => setDescExpanded((v) => !v)}
            style={{ paddingHorizontal: 24, marginTop: 12 }}
          >
            <Text
              numberOfLines={descExpanded ? undefined : 4}
              style={{
                color: colors.onSurfaceVariant,
                fontSize: 13,
                lineHeight: 19,
                textAlign: "center",
              }}
            >
              {author.description}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: colors.surface }}
      edges={["top", "left", "right"]}
    >
      {/* Header bar — rendered in every state so back stays reachable even
          while loading or after an error. */}
      <View
        style={{
          paddingHorizontal: 16,
          paddingVertical: 12,
          flexDirection: "row",
          alignItems: "center",
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
          style={{ marginRight: 8, padding: 6, borderRadius: 20 }}
        >
          <Icon name="back" size={24} color={colors.onSurface} />
        </Pressable>
        <Text
          numberOfLines={1}
          style={{ color: colors.onSurface, fontSize: 18, fontWeight: "bold", flex: 1 }}
        >
          {author?.name || authorName || "Author"}
        </Text>
      </View>

      {loading ? (
        <View>
          {/* Profile-circle + name placeholders matching the real header. */}
          <View style={{ alignItems: "center", paddingTop: 12, paddingBottom: 16 }}>
            <Skeleton width={120} height={120} radius={60} style={{ marginBottom: 14 }} />
            <Skeleton width={180} height={20} radius={6} />
            <Skeleton width={80} height={13} radius={5} style={{ marginTop: 8 }} />
          </View>
          <ListSkeleton rows={4} thumb={80} />
        </View>
      ) : loadError && !author ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 32 }}>
          <Icon name="warning" size={48} color={colors.error} />
          <Text style={{ color: colors.onSurface, fontSize: 17, fontWeight: "600", marginTop: 16, marginBottom: 6, textAlign: "center" }}>
            Couldn't load author
          </Text>
          <Text style={{ color: colors.onSurfaceVariant, fontSize: 14, textAlign: "center" }}>
            Check your connection to the server and try again.
          </Text>
          <Pressable
            onPress={() => setRetryTick((t) => t + 1)}
            android_ripple={{ color: withAlpha(colors.onPrimary, 0.2) }}
            accessibilityRole="button"
            accessibilityLabel="Retry loading author"
            style={{ marginTop: 20, paddingHorizontal: 24, paddingVertical: 10, borderRadius: 24, overflow: "hidden", backgroundColor: colors.primary }}
          >
            <Text style={{ color: colors.onPrimary, fontSize: 15, fontWeight: "600" }}>Retry</Text>
          </Pressable>
        </View>
      ) : books.length === 0 ? (
        <FlatList
          data={[]}
          renderItem={null as any}
          ListHeaderComponent={renderHeader}
          ListEmptyComponent={
            <View style={{ alignItems: "center", paddingVertical: 40 }}>
              <Icon name="book" size={40} color={colors.onSurfaceVariant} />
              <Text
                style={{ color: colors.onSurfaceVariant, fontSize: 15, marginTop: 8 }}
              >
                No books by this author.
              </Text>
            </View>
          }
        />
      ) : (
        <FlatList
          data={books}
          renderItem={renderBookCard}
          keyExtractor={(item) => item.id}
          ListHeaderComponent={renderHeader}
          contentContainerStyle={{ paddingBottom: hasSession ? 100 : 32 }}
          showsVerticalScrollIndicator={false}
        />
      )}
    </SafeAreaView>
  );
}
