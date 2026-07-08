import React, { useEffect, useState } from "react";
import { View, Text, Pressable, ScrollView, ActivityIndicator, Alert } from "react-native";
import { Image } from "expo-image";
import { coverSource } from "../utils/coverSource";
import { useThemeColors } from "../theme/useThemeColors";
import { withAlpha } from "../theme/palette";
import { SafeAreaView } from "react-native-safe-area-context";
import Icon from "../components/Icon";
import { api } from "../utils/api";
import { queueProgressPatch } from "../utils/progressSync";
import { useLibraryStore } from "../store/useLibraryStore";
import { useUserStore } from "../store/useUserStore";
import { usePlaybackStore } from "../store/usePlaybackStore";

export default function LatestEpisodesScreen({ navigation }: any) {
  const colors = useThemeColors();
  const currentLibraryId = useLibraryStore((state) => state.currentLibraryId);
  const { serverConnectionConfig } = useUserStore();
  const startPlayback = usePlaybackStore((state) => state.startPlayback);
  const hasSession = usePlaybackStore((state) => state.currentSession !== null);
  // Episode progress lives in the global map keyed `${libraryItemId}-${episode.id}`
  // (the /api/me convention) — same source ItemDetail's episode rows read.
  const progressMap = useUserStore((state) => state.mediaProgress);
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

  // Per-episode finished toggle — PATCHes the episode-scoped endpoint and
  // updates the `${libraryItemId}-${episode.id}` map key so the row's played
  // state flips immediately (and other screens reading the same map follow).
  const episodeBusyRef = React.useRef<Record<string, boolean>>({});
  const toggleEpisodeFinished = async (episode: any) => {
    const itemId = episode?.libraryItemId;
    const epId = episode?.id;
    if (!itemId || !epId || episodeBusyRef.current[epId]) return;
    episodeBusyRef.current[epId] = true;
    const key = `${itemId}-${epId}`;
    const next = !useUserStore.getState().mediaProgress[key]?.isFinished;
    const applyLocally = () =>
      useUserStore.setState((s) => ({
        mediaProgress: {
          ...s.mediaProgress,
          [key]: {
            ...s.mediaProgress[key],
            libraryItemId: itemId,
            episodeId: epId,
            isFinished: next,
            updatedAt: Date.now(),
          },
        },
      }));
    try {
      await api.patch(`/api/me/progress/${itemId}/${epId}`, { isFinished: next });
      applyLocally();
    } catch (err) {
      // Offline — queue an episode-scoped PATCH (non-finite position drops the
      // audio fields but still carries the isFinished toggle) and reflect it
      // locally; flushPendingSyncs delivers it when the server is reachable.
      console.warn("[LatestEpisodes] episode finished-toggle failed — queueing:", err);
      queueProgressPatch(itemId, NaN, NaN, epId, { isFinished: next });
      applyLocally();
    } finally {
      episodeBusyRef.current[epId] = false;
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
    // Played/in-progress state from the shared progress map (same key ItemDetail
    // uses). Finished dims the whole row and appends "· Finished"; an unfinished
    // partial shows a thin progress bar.
    const epProgress = progressMap[`${episode.libraryItemId}-${episode.id}`];
    const epFinished = !!epProgress?.isFinished;
    const epFraction = Math.max(0, Math.min(1, Number(epProgress?.progress || 0)));

    // Plain View row: were the whole row a Pressable (accessible=true),
    // TalkBack/VoiceOver would collapse it into one node and the nested Play +
    // mark-finished buttons would be unreachable. The open-podcast target is the
    // cover/text block; Play and mark-finished are siblings (RmabMissingSection
    // is the reference for this pattern).
    return (
      <View
        key={episode.id || index}
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingVertical: 12,
          paddingHorizontal: 16,
          borderBottomWidth: 1,
          borderBottomColor: colors.outlineVariant,
          opacity: epFinished ? 0.55 : 1,
        }}
      >
        <Pressable
          onPress={() => {
            if (episode.libraryItemId) {
              navigation.navigate("ItemDetail", { itemId: episode.libraryItemId });
            }
          }}
          accessibilityRole="button"
          accessibilityLabel={[episode.title || "Untitled Episode", podcastName].filter(Boolean).join(", ")}
          style={{ flex: 1, flexDirection: "row", alignItems: "center" }}
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
              {epFinished ? (
                <Text style={{ color: colors.onSurfaceVariant, fontSize: 11, marginLeft: 6 }}>· Finished</Text>
              ) : null}
            </View>
            {!epFinished && epFraction > 0 ? (
              <View
                style={{
                  height: 3,
                  borderRadius: 1.5,
                  backgroundColor: colors.surfaceContainerHighest,
                  marginTop: 6,
                  overflow: "hidden",
                }}
              >
                <View
                  style={{
                    height: "100%",
                    width: `${Math.min(99, Math.max(1, Math.round(epFraction * 100)))}%`,
                    backgroundColor: colors.primary,
                  }}
                />
              </View>
            ) : null}
          </View>
        </Pressable>

        {/* Mark this episode finished/unfinished (episode-scoped progress). */}
        <Pressable
          onPress={() => toggleEpisodeFinished(episode)}
          style={{
            width: 40,
            height: 40,
            borderRadius: 20,
            backgroundColor: epFinished ? colors.primaryContainer : colors.secondaryContainer,
            alignItems: "center",
            justifyContent: "center",
            marginLeft: 8,
          }}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityState={{ selected: epFinished }}
          accessibilityLabel={epFinished ? "Mark episode not finished" : "Mark episode finished"}
        >
          <Icon
            name="check"
            size={20}
            color={epFinished ? colors.onPrimaryContainer : colors.onSecondaryContainer}
            style={{ opacity: epFinished ? 1 : 0.45 }}
          />
        </Pressable>

        {/* Play the episode right here; the cover/text block opens the podcast. */}
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
      </View>
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
        <Text
          accessibilityRole="header"
          style={{ color: colors.onSurface, fontSize: 20, fontWeight: "700", flex: 1 }}
        >
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
            <Text
              accessibilityRole="header"
              style={{ color: colors.onSurface, fontWeight: "bold", fontSize: 15 }}
            >
              {episodes.length} Recent {episodes.length === 1 ? "Episode" : "Episodes"}
            </Text>
          </View>

          {episodes.map((episode, index) => renderEpisodeRow(episode, index))}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}
