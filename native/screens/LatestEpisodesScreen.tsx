import React, { useEffect, useState } from "react";
import { View, Text, Pressable, ScrollView, ActivityIndicator, Alert } from "react-native";
import { Image } from "expo-image";
import { coverSource } from "../utils/coverSource";
import { useThemeColors } from "../theme/useThemeColors";
import { withAlpha } from "../theme/palette";
import { SafeAreaView } from "react-native-safe-area-context";
import Icon from "../components/Icon";
import { api } from "../utils/api";
import { useLibraryStore } from "../store/useLibraryStore";
import { useUserStore } from "../store/useUserStore";
import { usePlaybackStore } from "../store/usePlaybackStore";

export default function LatestEpisodesScreen({ navigation }: any) {
  const colors = useThemeColors();
  const currentLibraryId = useLibraryStore((state) => state.currentLibraryId);
  const { serverConnectionConfig } = useUserStore();
  const startPlayback = usePlaybackStore((state) => state.startPlayback);
  const hasSession = usePlaybackStore((state) => state.currentSession !== null);
  const [episodes, setEpisodes] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Episode id currently being started, so the tapped row shows a spinner and
  // double-taps can't start two sessions.
  const [startingId, setStartingId] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);

  const playEpisode = async (episode: any) => {
    if (!episode?.libraryItemId || !episode?.id || startingId) return;
    setStartingId(episode.id);
    try {
      await startPlayback(episode.libraryItemId, episode.id);
    } catch (e) {
      // Was an unhandled rejection — spinner cleared and nothing happened.
      console.warn("[LatestEpisodes] play failed", e);
      Alert.alert("Couldn't play episode", "Check your connection to the server and try again.");
    } finally {
      setStartingId(null);
    }
  };

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
  }, [currentLibraryId, retryTick]);

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
              source={coverSource(coverUrl)}
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

        {/* Play the episode right here; the row itself opens the podcast. */}
        <Pressable
          onPress={() => playEpisode(episode)}
          disabled={!!startingId}
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
          accessibilityRole="button"
          accessibilityLabel={`Play ${episode.title || "episode"}`}
        >
          {startingId === episode.id ? (
            <ActivityIndicator size="small" color={colors.onSecondaryContainer} />
          ) : (
            <Icon name="play" size={22} color={colors.onSecondaryContainer} />
          )}
        </Pressable>
        <Icon name="chevron-right" size={20} color={colors.onSurfaceVariant} style={{ marginLeft: 6 }} />
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
          accessibilityRole="button"
          accessibilityLabel="Go back"
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
          <Icon name="warning" size={44} color={colors.onSurfaceVariant} style={{ marginBottom: 4 }} />
          <Text style={{ color: colors.onSurface, fontSize: 18, fontWeight: "600", marginTop: 12 }}>
            Couldn't load episodes
          </Text>
          <Text style={{ color: colors.onSurfaceVariant, fontSize: 15, textAlign: "center", marginTop: 8 }}>{error}</Text>
          {currentLibraryId ? (
            <Pressable
              onPress={() => setRetryTick((t) => t + 1)}
              android_ripple={{ color: withAlpha(colors.onPrimary, 0.2) }}
              accessibilityRole="button"
              accessibilityLabel="Retry loading episodes"
              style={{ marginTop: 20, paddingHorizontal: 24, paddingVertical: 10, borderRadius: 24, overflow: "hidden", backgroundColor: colors.primary }}
            >
              <Text style={{ color: colors.onPrimary, fontSize: 15, fontWeight: "600" }}>Retry</Text>
            </Pressable>
          ) : null}
        </View>
      ) : episodes.length === 0 ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
          <Icon name="podcast" size={44} color={colors.onSurfaceVariant} style={{ marginBottom: 4 }} />
          <Text style={{ color: colors.onSurface, fontSize: 18, fontWeight: "600", marginTop: 12 }}>
            No recent episodes
          </Text>
          <Text style={{ color: colors.onSurfaceVariant, fontSize: 15, textAlign: "center", marginTop: 8 }}>
            New episodes from this library's podcasts will show up here.
          </Text>
        </View>
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: hasSession ? 100 : 32 }}>
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
