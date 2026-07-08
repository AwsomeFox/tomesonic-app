import React, { useEffect, useState } from "react";
import { View, Text, Pressable, ScrollView, ActivityIndicator } from "react-native";
import { Image } from "expo-image";
import { coverSource } from "../utils/coverSource";
import { useThemeColors } from "../theme/useThemeColors";
import { SafeAreaView } from "react-native-safe-area-context";
import Icon from "../components/Icon";
import ErrorState from "../components/ErrorState";
import EmptyState from "../components/EmptyState";
import { api } from "../utils/api";
import { queueProgressPatch } from "../utils/progressSync";
import { useLibraryStore } from "../store/useLibraryStore";
import { useUserStore } from "../store/useUserStore";
import { usePlaybackStore } from "../store/usePlaybackStore";
import { showAppDialog } from "../store/useDialogStore";
import { useDownloadStore, episodeDownloadKey } from "../store/useDownloadStore";
import { downloader } from "../utils/downloader";
import { withAlpha } from "../theme/palette";

export default function LatestEpisodesScreen({ navigation }: any) {
  const colors = useThemeColors();
  const currentLibraryId = useLibraryStore((state) => state.currentLibraryId);
  const { serverConnectionConfig } = useUserStore();
  const startPlayback = usePlaybackStore((state) => state.startPlayback);
  const hasSession = usePlaybackStore((state) => state.currentSession !== null);
  // Now-playing session so a row can flip its Play button to the active
  // (headphones-on-primaryContainer) treatment — same as ItemDetail's rows.
  const currentSession = usePlaybackStore((state) => state.currentSession);
  // Per-episode offline download state (composite-keyed), so the triage screen
  // can start/cancel/delete a download without opening the podcast.
  const completedDownloads = useDownloadStore((s) => s.completedDownloads);
  const activeDownloads = useDownloadStore((s) => s.activeDownloads);
  const cancelDownload = useDownloadStore((s) => s.cancelDownload);
  const removeDownload = useDownloadStore((s) => s.removeDownload);
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
  // Episode list filter/sort — All / Unplayed / In-Progress against the shared
  // per-episode progress map, plus a newest↔oldest toggle.
  const [episodeFilter, setEpisodeFilter] = useState<"all" | "unplayed" | "in-progress">("all");
  const [episodeSort, setEpisodeSort] = useState<"newest" | "oldest">("newest");

  const playEpisode = async (episode: any) => {
    if (!episode?.libraryItemId || !episode?.id || startingId) return;
    // Already the loaded session's episode: resume/expand instead of churning a
    // fresh /play (server session churn + a possible backward jump to the
    // last-synced position). Mirrors ItemDetail's playEpisode short-circuit.
    const st = usePlaybackStore.getState();
    if (
      st.currentSession?.libraryItemId === episode.libraryItemId &&
      st.currentSession?.episodeId === episode.id
    ) {
      if (!st.isPlaying) st.play?.().catch(() => {});
      st.setPlayerExpanded?.(true);
      return;
    }
    setStartingId(episode.id);
    try {
      await startPlayback(episode.libraryItemId, episode.id);
    } catch (e) {
      // Was an unhandled rejection — spinner cleared and nothing happened.
      console.warn("[LatestEpisodes] play failed", e);
      showAppDialog({ title: "Couldn't play episode", message: "Check your connection to the server and try again." });
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
    if (!itemId || !epId) return;
    // Key the busy flag by the SAME item+episode composite the endpoint and
    // progress map use — episode ids aren't unique across podcasts, so keying
    // by episode id alone could block toggling a different podcast's episode.
    const key = `${itemId}-${epId}`;
    if (episodeBusyRef.current[key]) return;
    episodeBusyRef.current[key] = true;
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
      episodeBusyRef.current[key] = false;
    }
  };

  const serverAddress = serverConnectionConfig?.address?.replace(/\/$/, "") || "";
  const token = serverConnectionConfig?.token || "";

  // Per-episode download control — mirrors ItemDetail's episode download button
  // (download / cancel / retry / delete) keyed by the composite
  // `${libraryItemId}::${episodeId}` (episodeDownloadKey). recent-episodes hands
  // back loose episodes rather than a full libraryItem, so we build the minimal
  // shell the downloader reads (id + media.metadata/coverPath).
  const handleEpisodeDownloadPress = async (episode: any) => {
    const libraryItemId = episode?.libraryItemId;
    if (!libraryItemId || !episode?.id) return;
    const key = episodeDownloadKey(libraryItemId, episode.id);
    const active = useDownloadStore.getState().activeDownloads[key];
    const completed = useDownloadStore.getState().completedDownloads[key];
    if (completed && !active) {
      // A completed download must go through removeDownload (deletes files);
      // destructive, so confirm first.
      showAppDialog({
        title: "Delete download",
        message: `Remove "${episode.title || "this episode"}" from this device? You can download it again later.`,
        buttons: [
          { text: "Cancel", style: "cancel" },
          { text: "Delete", style: "destructive", onPress: () => removeDownload(key) },
        ],
      });
    } else if (active?.status === "downloading" || active?.status === "pending") {
      cancelDownload(key);
    } else if (active?.status === "failed") {
      useDownloadStore.getState().retryDownload(key);
    } else {
      const libraryItem = episode.libraryItem || {
        id: libraryItemId,
        media: episode.podcast || { metadata: { title: episode.podcastTitle || "" } },
      };
      try {
        await downloader.downloadEpisode(libraryItem, episode, serverAddress, token);
      } catch (err) {
        console.warn("[LatestEpisodes] Episode download failed:", err);
        showAppDialog({
          title: "Download failed",
          message: "Couldn't start the download. Check your connection and free space, then try again.",
        });
      }
    }
  };

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

  // Apply the filter/sort to the fetched episodes. Progress lives in the shared
  // map keyed `${libraryItemId}-${episode.id}` (same source the rows read).
  const visibleEpisodes = React.useMemo(() => {
    const decorated = episodes.map((ep: any) => {
      const p = progressMap[`${ep.libraryItemId}-${ep.id}`];
      const finished = !!p?.isFinished;
      const fraction = Math.max(0, Math.min(1, Number(p?.progress || 0)));
      return { ep, finished, fraction };
    });
    const filtered = decorated.filter(({ finished, fraction }) => {
      if (episodeFilter === "unplayed") return !finished && fraction === 0;
      if (episodeFilter === "in-progress") return !finished && fraction > 0;
      return true;
    });
    const ms = (ep: any) => {
      const t = ep?.pubDate ? new Date(ep.pubDate).getTime() : NaN;
      return Number.isFinite(t) ? t : 0;
    };
    filtered.sort((a, b) =>
      episodeSort === "newest" ? ms(b.ep) - ms(a.ep) : ms(a.ep) - ms(b.ep)
    );
    return filtered.map((d) => d.ep);
  }, [episodes, progressMap, episodeFilter, episodeSort]);

  const FilterChip = ({
    label,
    value,
  }: {
    label: string;
    value: "all" | "unplayed" | "in-progress";
  }) => {
    const active = episodeFilter === value;
    return (
      <Pressable
        onPress={() => setEpisodeFilter(value)}
        accessibilityRole="button"
        accessibilityState={{ selected: active }}
        accessibilityLabel={`Filter: ${label}`}
        android_ripple={{ color: withAlpha(colors.onSurfaceVariant, 0.12) }}
        hitSlop={{ top: 8, bottom: 8 }}
        style={{
          paddingHorizontal: 14,
          height: 34,
          borderRadius: 17,
          overflow: "hidden",
          alignItems: "center",
          justifyContent: "center",
          marginRight: 8,
          backgroundColor: active ? colors.secondaryContainer : "transparent",
          borderWidth: 1,
          borderColor: active ? colors.secondaryContainer : colors.outlineVariant,
        }}
      >
        <Text
          style={{
            color: active ? colors.onSecondaryContainer : colors.onSurfaceVariant,
            fontSize: 13,
            fontWeight: "600",
          }}
        >
          {label}
        </Text>
      </Pressable>
    );
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

    // Now-playing: flip Play → headphones-on-primaryContainer for the loaded
    // session's episode (same treatment as ItemDetail's rows).
    const isThisPlaying =
      currentSession?.libraryItemId === episode.libraryItemId &&
      currentSession?.episodeId === episode.id;

    // Per-episode offline download state (composite-keyed).
    const epDlKey = episodeDownloadKey(episode.libraryItemId, episode.id);
    const epActiveDl = activeDownloads[epDlKey];
    const epDownloaded = !!(completedDownloads[epDlKey] && !epActiveDl);
    const epDownloading = epActiveDl?.status === "downloading" || epActiveDl?.status === "pending";
    const epDownloadFailed = epActiveDl?.status === "failed";
    const epDownloadPct =
      epActiveDl && Number.isFinite(epActiveDl.progress)
        ? Math.round(epActiveDl.progress * 100)
        : 0;

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

        {/* Per-episode download control — mirrors ItemDetail's episode download
            button's four states (download / downloading% / retry / delete)
            scoped to this episode's composite key. */}
        <Pressable
          onPress={() => handleEpisodeDownloadPress(episode)}
          accessibilityRole="button"
          accessibilityLabel={
            epDownloaded
              ? `Delete download of ${episode.title || "episode"}`
              : epDownloading
              ? `Cancel download of ${episode.title || "episode"}, ${epDownloadPct} percent complete`
              : epDownloadFailed
              ? `Download of ${episode.title || "episode"} failed, tap to retry`
              : `Download ${episode.title || "episode"}`
          }
          hitSlop={6}
          android_ripple={{
            color: withAlpha(
              epDownloaded || epDownloadFailed ? colors.error : colors.onSecondaryContainer,
              0.15
            ),
          }}
          style={{
            width: 40,
            height: 40,
            borderRadius: 20,
            overflow: "hidden",
            backgroundColor:
              epDownloaded || epDownloadFailed
                ? withAlpha(colors.error, 0.1)
                : colors.secondaryContainer,
            alignItems: "center",
            justifyContent: "center",
            marginLeft: 8,
            borderWidth: epDownloaded || epDownloadFailed ? 1 : 0,
            borderColor: epDownloaded || epDownloadFailed ? colors.error : "transparent",
          }}
        >
          {epDownloading ? (
            <View style={{ alignItems: "center", justifyContent: "center" }}>
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={{ fontSize: 9, color: colors.onSurface, marginTop: 1, fontWeight: "800" }}>
                {epDownloadPct}%
              </Text>
            </View>
          ) : epDownloadFailed ? (
            <Icon name="refresh" size={18} color={colors.error} />
          ) : (
            <Icon
              name={epDownloaded ? "trash" : "download"}
              size={18}
              color={epDownloaded ? colors.error : colors.onSecondaryContainer}
            />
          )}
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
            // Flip to the primaryContainer/headphones treatment when this is the
            // loaded session's episode (mirrors ItemDetail's rows).
            backgroundColor: isThisPlaying ? colors.primaryContainer : colors.secondaryContainer,
            alignItems: "center",
            justifyContent: "center",
            marginLeft: 8,
            // Another row is starting: this Play button is disabled, so dim it
            // instead of sitting full-opacity yet dead (the tapped row keeps its
            // spinner at full opacity).
            opacity: startingId && startingId !== episode.id ? 0.5 : 1,
          }}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={
            isThisPlaying
              ? `Resume ${episode.title || "episode"}`
              : `Play ${episode.title || "episode"}`
          }
        >
          {startingId === episode.id ? (
            <ActivityIndicator size="small" color={colors.onSecondaryContainer} />
          ) : (
            <Icon
              name={isThisPlaying ? "headphones" : "play"}
              size={22}
              color={isThisPlaying ? colors.onPrimaryContainer : colors.onSecondaryContainer}
            />
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
        <ErrorState
          style={{ flex: 1 }}
          title="Couldn't load episodes"
          message={error}
          onRetry={currentLibraryId ? () => setRetryTick((t) => t + 1) : undefined}
        />
      ) : episodes.length === 0 ? (
        <EmptyState
          style={{ flex: 1 }}
          icon="podcast"
          title="No recent episodes"
          message="New episodes from this library's podcasts will show up here."
        />
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
              // Drive the count from the FILTERED list so it never claims "25
              // Recent Episodes" over 3 visible rows. Announce politely so a
              // filter/sort change reports the new result count to TalkBack.
              accessibilityLiveRegion="polite"
              style={{ color: colors.onSurface, fontWeight: "bold", fontSize: 15 }}
            >
              {visibleEpisodes.length} Recent {visibleEpisodes.length === 1 ? "Episode" : "Episodes"}
            </Text>
          </View>

          {/* Filter (All / Unplayed / In-Progress) + newest↔oldest sort. */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 8, alignItems: "center" }}
          >
            <FilterChip label="All" value="all" />
            <FilterChip label="Unplayed" value="unplayed" />
            <FilterChip label="In-Progress" value="in-progress" />
            <Pressable
              onPress={() => setEpisodeSort((s) => (s === "newest" ? "oldest" : "newest"))}
              accessibilityRole="button"
              accessibilityLabel={episodeSort === "newest" ? "Sort oldest first" : "Sort newest first"}
              android_ripple={{ color: withAlpha(colors.onSurfaceVariant, 0.12) }}
              hitSlop={{ top: 8, bottom: 8 }}
              style={{
                flexDirection: "row",
                alignItems: "center",
                paddingHorizontal: 14,
                height: 34,
                borderRadius: 17,
                overflow: "hidden",
                marginLeft: 4,
                backgroundColor: "transparent",
                borderWidth: 1,
                borderColor: colors.outlineVariant,
              }}
            >
              <Icon name="sort" size={16} color={colors.onSurfaceVariant} style={{ marginRight: 6 }} />
              <Text style={{ color: colors.onSurfaceVariant, fontSize: 13, fontWeight: "600" }}>
                {episodeSort === "newest" ? "Newest" : "Oldest"}
              </Text>
            </Pressable>
          </ScrollView>

          {visibleEpisodes.length === 0 ? (
            <Text
              accessibilityLiveRegion="polite"
              style={{ color: colors.onSurfaceVariant, fontSize: 14, textAlign: "center", paddingVertical: 40, paddingHorizontal: 32 }}
            >
              No episodes match this filter.
            </Text>
          ) : (
            visibleEpisodes.map((episode, index) => renderEpisodeRow(episode, index))
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}
