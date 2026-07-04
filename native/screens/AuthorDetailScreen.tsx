import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  FlatList,
  Image,
  Pressable,
  ActivityIndicator,
} from "react-native";
import { useThemeColors } from "../theme/useThemeColors";
import { SafeAreaView } from "react-native-safe-area-context";
import Animated, { FadeInDown } from "react-native-reanimated";
import { api } from "../utils/api";
import { useUserStore } from "../store/useUserStore";
import { withAlpha } from "../theme/palette";
import Icon from "../components/Icon";
import BookProgressBadge from "../components/BookProgressBadge";
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
  const [descExpanded, setDescExpanded] = useState(false);

  const serverAddress = serverConnectionConfig?.address?.replace(/\/$/, "") || "";
  const token = serverConnectionConfig?.token || "";

  const getCoverUrl = (itemId: string) => {
    if (!itemId || !serverAddress || !token) return null;
    return `${serverAddress}/api/items/${itemId}/cover?token=${token}`;
  };

  const getAuthorImageUrl = () => {
    if (!author?.imagePath || !serverAddress || !token) return null;
    return `${serverAddress}/api/authors/${author.id}/image?token=${token}`;
  };

  useEffect(() => {
    const fetchAuthorDetail = async () => {
      if (!authorId) {
        setLoading(false);
        return;
      }
      setLoading(true);
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
      } finally {
        setLoading(false);
      }
    };

    fetchAuthorDetail();
  }, [authorId]);

  const renderBookCard = ({ item, index }: { item: AuthorBook; index: number }) => {
    const coverUri = getCoverUrl(item.id);
    const title = item.media?.metadata?.title || "Untitled";
    const subtitle = item.media?.metadata?.subtitle || "";

    return (
      <AnimatedPressable
        entering={FadeInDown.delay(Math.min(index * 50, 500))
          .duration(350)
          .springify()
          .damping(32)
          .stiffness(150)}
        onPress={() => navigation.navigate("ItemDetail", { itemId: item.id })}
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
              source={{ uri: coverUri }}
              style={{ width: COVER_WIDTH, height: COVER_HEIGHT }}
              resizeMode="cover"
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
            downloaded={(item as any).isLocal || !!(item as any).localLibraryItem}
            style={{ marginTop: 4 }}
          />
        </View>
      </AnimatedPressable>
    );
  };

  const imageUri = getAuthorImageUrl();
  const books = author?.libraryItems || [];

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
              source={{ uri: imageUri }}
              style={{ width: 120, height: 120 }}
              resizeMode="cover"
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

  if (loading) {
    return (
      <SafeAreaView
        style={{ flex: 1, backgroundColor: colors.surface }}
        edges={["top", "left", "right"]}
      >
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text
            style={{ color: colors.onSurface, marginTop: 12, fontSize: 14, opacity: 0.7 }}
          >
            Loading author…
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: colors.surface }}
      edges={["top", "left", "right"]}
    >
      {/* Header bar */}
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

      {books.length === 0 ? (
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
