import React, { useEffect, useState } from "react";
import { View, Text, Pressable, ScrollView, ActivityIndicator } from "react-native";
import { Image } from "expo-image";
import { useThemeColors } from "../theme/useThemeColors";
import { SafeAreaView } from "react-native-safe-area-context";
import Icon from "../components/Icon";
import { api } from "../utils/api";
import { useLibraryStore } from "../store/useLibraryStore";
import { useUserStore } from "../store/useUserStore";

export default function LatestEpisodesScreen({ navigation }: any) {
  const colors = useThemeColors();
  const currentLibraryId = useLibraryStore((state) => state.currentLibraryId);
  const { serverConnectionConfig } = useUserStore();
  const [episodes, setEpisodes] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const serverAddress = serverConnectionConfig?.address?.replace(/\/$/, "") || "";
  const token = serverConnectionConfig?.token || "";

  useEffect(() => {
    if (!currentLibraryId) {
      setError("No library selected.");
      setLoading(false);
      return;
    }

    const fetchEpisodes = async () => {
      try {
        setLoading(true);
        setError(null);
        const response = await api.get(
          `/api/libraries/${currentLibraryId}/recent-episodes?limit=25`
        );
        setEpisodes(response.data?.episodes || []);
      } catch (err: any) {
        console.error("[LatestEpisodes] Failed to fetch episodes:", err);
        setError("Failed to load episodes.");
      } finally {
        setLoading(false);
      }
    };

    fetchEpisodes();
  }, [currentLibraryId]);

  const getCoverUrl = (libraryItemId: string) => {
    if (!libraryItemId || !serverAddress || !token) return null;
    return `${serverAddress}/api/items/${libraryItemId}/cover?width=400&format=webp&token=${token}`;
  };

  const formatDate = (dateStr: string | number | undefined) => {
    if (!dateStr) return "";
    try {
      const date = new Date(dateStr);
      return date.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    } catch {
      return "";
    }
  };

  const formatDuration = (seconds: number | undefined) => {
    if (!seconds || seconds <= 0) return "";
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  };

  const renderEpisodeRow = (episode: any, index: number) => {
    const coverUrl = getCoverUrl(episode.libraryItemId);
    const podcastName = episode.podcast?.metadata?.title || episode.podcastTitle || "";

    return (
      <Pressable
        key={episode.id || index}
        onPress={() => {
          if (episode.libraryItemId) {
            navigation.navigate("ItemDetail", { itemId: episode.libraryItemId });
          }
        }}
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingVertical: 12,
          paddingHorizontal: 16,
          borderBottomWidth: 1,
          borderBottomColor: colors.outlineVariant,
        }}
      >
        {/* Cover */}
        <View
          style={{
            width: 60,
            height: 60,
            borderRadius: 10,
            overflow: "hidden",
            backgroundColor: colors.surfaceContainerHigh,
          }}
        >
          {coverUrl ? (
            <Image
              source={{ uri: coverUrl }}
              style={{ width: 60, height: 60 }}
              contentFit="cover"
            />
          ) : (
            <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
              <Icon name="podcast" size={26} color={colors.onSurfaceVariant} />
            </View>
          )}
        </View>

        {/* Episode info */}
        <View style={{ flex: 1, marginLeft: 14 }}>
          {podcastName ? (
            <Text
              numberOfLines={1}
              style={{
                color: colors.primary,
                fontSize: 12,
                fontWeight: "600",
                textDecorationLine: "underline",
              }}
            >
              {podcastName}
            </Text>
          ) : null}
          <Text
            numberOfLines={2}
            style={{
              color: colors.onSurface,
              fontSize: 14,
              fontWeight: "600",
              lineHeight: 19,
              marginTop: podcastName ? 2 : 0,
            }}
          >
            {episode.title || "Untitled Episode"}
          </Text>
          <View style={{ flexDirection: "row", alignItems: "center", marginTop: 4 }}>
            {episode.pubDate ? (
              <Text style={{ color: colors.onSurfaceVariant, fontSize: 11 }}>
                {formatDate(episode.pubDate)}
              </Text>
            ) : null}
            {episode.pubDate && episode.duration ? (
              <Text style={{ color: colors.onSurfaceVariant, fontSize: 11, marginHorizontal: 6 }}>•</Text>
            ) : null}
            {episode.duration ? (
              <Text style={{ color: colors.onSurfaceVariant, fontSize: 11 }}>
                {formatDuration(episode.duration)}
              </Text>
            ) : null}
          </View>
        </View>

        {/* Actions: play + download */}
        <Pressable
          onPress={() => {
            if (episode.libraryItemId) {
              navigation.navigate("ItemDetail", { itemId: episode.libraryItemId });
            }
          }}
          style={{
            width: 40,
            height: 40,
            borderRadius: 20,
            backgroundColor: colors.secondaryContainer,
            alignItems: "center",
            justifyContent: "center",
            marginLeft: 8,
          }}
          hitSlop={6}
        >
          <Icon name="play" size={22} color={colors.onSecondaryContainer} />
        </Pressable>
        <Pressable
          onPress={() => {
            if (episode.libraryItemId) {
              navigation.navigate("ItemDetail", { itemId: episode.libraryItemId });
            }
          }}
          style={{
            width: 40,
            height: 40,
            borderRadius: 20,
            alignItems: "center",
            justifyContent: "center",
            marginLeft: 4,
          }}
          hitSlop={6}
        >
          <Icon name="download" size={22} color={colors.onSurfaceVariant} />
        </Pressable>
      </Pressable>
    );
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }} edges={["top", "left", "right"]}>
      {/* Header */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 16,
          paddingVertical: 14,
          borderBottomWidth: 1,
          borderBottomColor: colors.outlineVariant,
        }}
      >
        <Pressable
          onPress={() => navigation.goBack()}
          style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", marginRight: 4 }}
          hitSlop={8}
        >
          <Icon name="back" size={24} color={colors.onSurface} />
        </Pressable>
        <Text style={{ color: colors.onSurface, fontSize: 20, fontWeight: "700", flex: 1 }}>
          Latest Episodes
        </Text>
      </View>

      {loading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : error ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
          <Icon name="warning" size={40} color={colors.onSurfaceVariant} style={{ marginBottom: 12 }} />
          <Text style={{ color: colors.onSurfaceVariant, fontSize: 15, textAlign: "center" }}>{error}</Text>
        </View>
      ) : episodes.length === 0 ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
          <Icon name="podcast" size={48} color={colors.onSurfaceVariant} style={{ marginBottom: 12 }} />
          <Text style={{ color: colors.onSurfaceVariant, fontSize: 15, textAlign: "center" }}>
            No recent episodes found.
          </Text>
        </View>
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 32 }}>
          {/* Section header */}
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              paddingHorizontal: 16,
              paddingTop: 16,
              paddingBottom: 8,
            }}
          >
            <View
              style={{
                width: 6,
                height: 18,
                borderRadius: 3,
                backgroundColor: colors.primary,
                marginRight: 8,
              }}
            />
            <Text style={{ color: colors.onSurface, fontWeight: "bold", fontSize: 15 }}>
              {episodes.length} Recent {episodes.length === 1 ? "Episode" : "Episodes"}
            </Text>
          </View>

          {episodes.map((episode, index) => renderEpisodeRow(episode, index))}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}
