import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  FlatList,
  Pressable,
  ActivityIndicator,
} from "react-native";
import { Image } from "expo-image";
import { useThemeColors } from "../theme/useThemeColors";
import { SafeAreaView } from "react-native-safe-area-context";
import Animated from "react-native-reanimated";
import { listRowEnter } from "../theme/motion";
import { api } from "../utils/api";
import { useUserStore } from "../store/useUserStore";
import { useLibraryStore } from "../store/useLibraryStore";
import { usePlaybackStore } from "../store/usePlaybackStore";
import TopAppBar from "../components/TopAppBar";
import Icon from "../components/Icon";
import BookProgressBadge from "../components/BookProgressBadge";

const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
const base64Encode = (input: string = '') => {
  let str = input;
  let output = '';
  for (let block = 0, charCode, i = 0, map = chars;
    str.charAt(i | 0) || (map = '=', i % 1);
    output += map.charAt(63 & block >> 8 - i % 1 * 8)) {
    charCode = str.charCodeAt(i += 3 / 4);
    if (charCode > 0xFF) {
      throw new Error("'btoa' failed");
    }
    block = block << 8 | charCode;
  }
  return output;
};

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

const COVER_WIDTH = 72;
const COVER_HEIGHT = 72;

// Mirrors $elapsedPretty (see LibraryScreen / ItemDetailScreen).
function elapsedPretty(seconds: number): string {
  if (!seconds || seconds <= 0) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h} hr ${m} min`;
  return `${m} min`;
}

interface MediaProgress {
  progress?: number;
  currentTime?: number;
  isFinished?: boolean;
}

interface SeriesBook {
  id: string;
  media: {
    metadata: {
      title: string;
      authorName?: string;
    };
    coverPath?: string;
    duration?: number;
  };
  sequence?: string | number;
  userMediaProgress?: MediaProgress | null;
}

interface SeriesData {
  id: string;
  name: string;
  books: SeriesBook[];
}

export default function SeriesDetailScreen({ route, navigation }: any) {
  const colors = useThemeColors();
  const { seriesId, seriesName } = route.params || {};
  const { currentLibraryId } = useLibraryStore();
  const hasSession = usePlaybackStore((state) => state.currentSession !== null);
  const { serverConnectionConfig } = useUserStore();
  const startPlayback = usePlaybackStore((s) => s.startPlayback);

  const [series, setSeries] = useState<SeriesData | null>(null);
  const [loading, setLoading] = useState(true);
  const [startingId, setStartingId] = useState<string | null>(null);

  const serverAddress = serverConnectionConfig?.address?.replace(/\/$/, "") || "";
  const token = serverConnectionConfig?.token || "";

  const getCoverUrl = (itemId: string) => {
    if (!itemId || !serverAddress || !token) return null;
    return `${serverAddress}/api/items/${itemId}/cover?width=400&format=webp&token=${token}`;
  };

  useEffect(() => {
    const fetchSeriesDetail = async () => {
      if (!seriesId || !currentLibraryId) return;
      setLoading(true);

      try {
        const seriesMetaResponse = await api.get(`/api/series/${seriesId}`).catch(() => null);
        const seriesMeta = seriesMetaResponse?.data || {};

        const itemsResponse = await api.get(
          `/api/libraries/${currentLibraryId}/items?filter=series.${encodeURIComponent(base64Encode(seriesId))}&include=progress`
        );
        const results = itemsResponse.data?.results || [];

        const books: SeriesBook[] = results.map((item: any) => {
          const rawSeries = item.media?.metadata?.series;
          const matchedSeriesObj = Array.isArray(rawSeries)
            ? rawSeries.find((s: any) => s.id === seriesId)
            : rawSeries;
          return {
            id: item.id,
            media: {
              metadata: {
                title: item.media?.metadata?.title || "Untitled",
                authorName: item.media?.metadata?.authorName || "",
              },
              coverPath: item.media?.coverPath,
              duration: item.media?.duration || 0,
            },
            sequence: matchedSeriesObj?.sequence ?? "",
            userMediaProgress: item.userMediaProgress || null,
          };
        });

        books.sort((a, b) => {
          const seqA = parseFloat(String(a.sequence)) || 0;
          const seqB = parseFloat(String(b.sequence)) || 0;
          if (seqA !== seqB) return seqA - seqB;
          return String(a.sequence).localeCompare(String(b.sequence));
        });

        setSeries({
          id: seriesId,
          name: seriesMeta.name || seriesName || "Unknown Series",
          books,
        });
      } catch (err) {
        console.error("[SeriesDetailScreen] Failed to fetch series books:", err);
      } finally {
        setLoading(false);
      }
    };

    fetchSeriesDetail();
  }, [seriesId, currentLibraryId]);

  const handlePlay = async (item: SeriesBook) => {
    if (startingId) return;
    setStartingId(item.id);
    try {
      const ok = await startPlayback(item.id);
    } finally {
      setStartingId(null);
    }
  };

  const renderBookCard = ({ item, index }: { item: SeriesBook; index: number }) => {
    const coverUri = getCoverUrl(item.id);
    const rawTitle = item.media?.metadata?.title || "Untitled";
    const author = item.media?.metadata?.authorName || "";
    const sequence = item.sequence;
    const duration = item.media?.duration || 0;

    // "#N Title" — sequence prefix mirrors the original series detail list.
    const title =
      sequence != null && sequence !== "" ? `#${sequence} ${rawTitle}` : rawTitle;

    const startingThis = startingId === item.id;

    return (
      <AnimatedPressable
        entering={listRowEnter(index)}
        onPress={() => navigation.navigate("ItemDetail", { itemId: item.id })}
        android_ripple={{ color: colors.surfaceContainerHighest }}
        style={{ paddingVertical: 10, paddingHorizontal: 16 }}
      >
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          {/* Cover — rounded ~12 */}
          <View
            style={{
              width: COVER_WIDTH,
              height: COVER_HEIGHT,
              borderRadius: 12,
              overflow: "hidden",
              backgroundColor: colors.surfaceContainer,
            }}
          >
            {coverUri ? (
              <Image
                source={{ uri: coverUri }}
                style={{ width: COVER_WIDTH, height: COVER_HEIGHT }}
                contentFit="cover"
              />
            ) : (
              <View
                style={{ flex: 1, alignItems: "center", justifyContent: "center" }}
              >
                <Icon name="book" size={28} color={colors.onSurfaceVariant} />
              </View>
            )}
          </View>

          {/* Info — title / author / duration / remaining chip */}
          <View style={{ flex: 1, minWidth: 0, paddingLeft: 14, paddingRight: 12 }}>
            <Text
              numberOfLines={1}
              style={{ color: colors.onSurface, fontSize: 15, fontWeight: "bold" }}
            >
              {title}
            </Text>
            {author ? (
              <Text
                numberOfLines={1}
                style={{ color: colors.onSurfaceVariant, fontSize: 13, marginTop: 2 }}
              >
                {author}
              </Text>
            ) : null}
            {duration > 0 ? (
              <Text
                numberOfLines={1}
                style={{ color: colors.onSurfaceVariant, fontSize: 13, marginTop: 2 }}
              >
                {elapsedPretty(duration)}
              </Text>
            ) : null}

            <BookProgressBadge
              itemId={item.id}
              item={item}
              downloaded={(item as any).isLocal || !!(item as any).localLibraryItem}
              style={{ marginTop: 6 }}
            />
          </View>

          {/* Filled pine-green circular Play button (~56dp) */}
          <Pressable
            onPress={() => handlePlay(item)}
            hitSlop={6}
            style={{
              width: 56,
              height: 56,
              borderRadius: 28,
              alignItems: "center",
              justifyContent: "center",
              elevation: 2,
              backgroundColor: startingThis ? colors.surfaceVariant : colors.primary,
            }}
          >
            {startingThis ? (
              <ActivityIndicator size="small" color={colors.onSurfaceVariant} />
            ) : (
              <Icon name="play" size={30} color={colors.onPrimary} />
            )}
          </Pressable>
        </View>
      </AnimatedPressable>
    );
  };

  if (loading) {
    return (
      <SafeAreaView
        style={{ flex: 1, backgroundColor: colors.surface }}
        edges={["top", "left", "right"]}
      >
        <TopAppBar navigation={navigation} showDownload showBack title={seriesName || "Loading Series"} />
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text
            style={{
              color: colors.onSurface,
              marginTop: 12,
              fontSize: 14,
              opacity: 0.7,
            }}
          >
            Loading series…
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  const bookCount = series?.books?.length || 0;

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: colors.surface }}
      edges={["top", "left", "right"]}
    >
      {/* Top app bar — download + search (matches screenshot 19) */}
      <TopAppBar navigation={navigation} showDownload showBack title={series?.name} />

      {bookCount === 0 ? (
        <View
          style={{
            flex: 1,
            alignItems: "center",
            justifyContent: "center",
            padding: 32,
          }}
        >
          <Icon name="series" size={48} color={colors.onSurfaceVariant} />
          <View style={{ height: 16 }} />
          <Text
            style={{
              color: colors.onSurface,
              fontSize: 16,
              fontWeight: "bold",
              marginBottom: 8,
            }}
          >
            No books in this series
          </Text>
        </View>
      ) : (
        <FlatList
          data={series?.books || []}
          renderItem={renderBookCard}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ paddingTop: 8, paddingBottom: hasSession ? 100 : 32 }}
          showsVerticalScrollIndicator={false}
        />
      )}
    </SafeAreaView>
  );
}
