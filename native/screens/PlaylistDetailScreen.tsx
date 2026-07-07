import React, { useEffect, useState } from "react";
import { View, Text, Pressable, ScrollView, ActivityIndicator, Alert } from "react-native";
import { Image } from "expo-image";
import { coverSource } from "../utils/coverSource";
import { useThemeColors } from "../theme/useThemeColors";
import { SafeAreaView } from "react-native-safe-area-context";
import Animated from "react-native-reanimated";
import { listRowEnter } from "../theme/motion";
import { withAlpha } from "../theme/palette";
import { api } from "../utils/api";
import { useUserStore } from "../store/useUserStore";
import { usePlaybackStore } from "../store/usePlaybackStore";
import Icon from "../components/Icon";
import BookProgressBadge from "../components/BookProgressBadge";
import { ListSkeleton } from "../components/Skeleton";
import { isEbookOnly, getEbookFormat } from "../utils/bookMatch";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

function elapsedPretty(seconds: number): string {
  if (!seconds || seconds <= 0) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h} hr ${m} min`;
  if (m > 0) return `${m} min`;
  return `${Math.floor(seconds)} sec`;
}

export default function PlaylistDetailScreen({ route, navigation }: any) {
  const colors = useThemeColors();
  const { playlistId } = route.params || {};
  const { serverConnectionConfig } = useUserStore();
  // Reactive subscription (not getState) so episode badges live-update while
  // this screen is open (e.g. an episode playing in the background).
  const mediaProgress = useUserStore((s) => s.mediaProgress);
  const startPlayback = usePlaybackStore((state) => state.startPlayback);
  const hasSession = usePlaybackStore((state) => state.currentSession !== null);
  const [playlist, setPlaylist] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  const [starting, setStarting] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = () => {
    Alert.alert(
      "Delete playlist?",
      `"${playlist?.name || "This playlist"}" will be removed from your server. Your books aren't affected.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            if (!playlistId || deleting) return;
            setDeleting(true);
            try {
              await api.delete(`/api/playlists/${playlistId}`);
              navigation.goBack();
            } catch {
              setDeleting(false);
              Alert.alert("Couldn't delete", "The playlist couldn't be deleted. Check your connection and try again.");
            }
          },
        },
      ]
    );
  };

  const serverAddress = serverConnectionConfig?.address?.replace(/\/$/, "") || "";
  const token = serverConnectionConfig?.token || "";

  useEffect(() => {
    if (!playlistId) {
      setError("No playlist ID provided.");
      setLoading(false);
      return;
    }

    const fetchPlaylist = async () => {
      try {
        setLoading(true);
        setError(null);
        const response = await api.get(`/api/playlists/${playlistId}`);
        setPlaylist(response.data);
      } catch (err: any) {
        console.error("[PlaylistDetail] Failed to fetch playlist:", err);
        setError("Failed to load playlist.");
      } finally {
        setLoading(false);
      }
    };

    fetchPlaylist();
  }, [playlistId, retryTick]);

  // Silent revalidate on return (membership can change from a book's
  // "Add to…" sheet) — no loading flip, so no skeleton flash.
  const firstFocusRef = React.useRef(true);
  useEffect(() => {
    const unsub = navigation.addListener("focus", () => {
      if (firstFocusRef.current) {
        firstFocusRef.current = false;
        return;
      }
      if (!playlistId) return;
      api
        .get(`/api/playlists/${playlistId}`)
        .then((r) => setPlaylist(r.data))
        .catch(() => {});
    });
    return unsub;
  }, [navigation, playlistId]);

  const getCoverUrl = (itemId: string) => {
    if (!itemId || !serverAddress || !token) return null;
    return `${serverAddress}/api/items/${itemId}/cover?width=400&format=webp&token=${token}`;
  };

  // filter(Boolean): a single null entry crashed the duration reduce and
  // blanked the app to the root error boundary.
  const items: any[] = (Array.isArray(playlist?.items) ? playlist.items : []).filter(Boolean);
  const totalDuration = items.reduce((t, i) => {
    const d = i.episode?.duration || i.libraryItem?.media?.duration || 0;
    return t + d;
  }, 0);

  // The playlist payload carries no user progress — look it up in the global
  // map (episodes use composite `${itemId}-${episodeId}` keys), or "Play all"
  // always restarts the first item. Ebook-only entries can't play — skip them
  // for Play-all instead of erroring on the first one.
  const nextUnfinishedItem = (): any | undefined =>
    items.find((i) => {
      if (!i.episode && isEbookOnly(i.libraryItem)) return false;
      const libId = i.libraryItemId || i.libraryItem?.id;
      const key = i.episodeId ? `${libId}-${i.episodeId}` : libId;
      return !(mediaProgress[key] || i.userMediaProgress)?.isFinished;
    }) || items.find((i) => i.episode || !isEbookOnly(i.libraryItem));

  const startItem = async (item: any) => {
    const libraryItemId = item?.libraryItemId || item?.libraryItem?.id;
    if (!libraryItemId || starting) return;
    // Ebook-only entries have nothing to play — open the Reader instead of
    // letting startPlayback error on an audio-less item (SeriesDetail routes
    // the same book to the Reader; CollectionDetail hides the button).
    if (!item.episode && isEbookOnly(item.libraryItem)) {
      navigation.navigate("Reader", {
        itemId: libraryItemId,
        ebookFormat: getEbookFormat(item.libraryItem),
        title: item.libraryItem?.media?.metadata?.title,
      });
      return;
    }
    setStarting(true);
    try {
      await startPlayback(libraryItemId, item.episodeId);
    } finally {
      setStarting(false);
    }
  };

  const handlePlayAll = () => {
    const item = nextUnfinishedItem();
    if (item) startItem(item);
  };

  const collageCovers = items
    .slice(0, 4)
    .map((i) => getCoverUrl(i.libraryItemId || i.libraryItem?.id))
    .filter(Boolean) as string[];

  const renderPlaylistItem = (item: any, index: number) => {
    const libraryItemId = item.libraryItemId || item.libraryItem?.id;
    const metadata = item.libraryItem?.media?.metadata || item.episode || {};
    const isEpisode = !!item.episode;
    const title = item.episode?.title || metadata.title || "Untitled";
    const subtitle =
      metadata.authorName || item.episode?.podcast?.metadata?.title || metadata.author || "";
    const duration = item.episode?.duration || item.libraryItem?.media?.duration || 0;
    const coverUrl = getCoverUrl(libraryItemId);
    // Ebook-only rows open the Reader (startItem routes them) — reflect that
    // in the icon + spoken label instead of promising audio.
    const ebookOnly = !isEpisode && isEbookOnly(item.libraryItem);

    return (
      <AnimatedPressable
        key={item.id || `${libraryItemId}-${index}`}
        entering={listRowEnter(index)}
        android_ripple={{ color: colors.surfaceContainerHighest }}
        onPress={() => {
          if (libraryItemId) navigation.navigate("ItemDetail", { itemId: libraryItemId });
        }}
        style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 8 }}
        accessibilityRole="button"
        accessibilityLabel={subtitle ? `${title} by ${subtitle}` : title}
        // The nested Play/Read button collapses into this accessible row and is
        // unreachable by TalkBack — expose it as a custom action instead.
        accessibilityActions={[{ name: "play", label: ebookOnly ? "Read" : "Play" }]}
        onAccessibilityAction={(e) => {
          if (e.nativeEvent.actionName === "play") startItem(item);
        }}
      >
        {/* Cover */}
        <View
          style={{
            width: 56,
            height: 80,
            borderRadius: 8,
            overflow: "hidden",
            backgroundColor: colors.surfaceContainerHigh,
            position: "relative",
          }}
        >
          {coverUrl ? (
            <Image source={coverSource(coverUrl)} style={{ width: 56, height: 80 }} contentFit="cover" />
          ) : (
            <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
              <Icon name={isEpisode ? "podcast" : "book"} size={22} color={colors.onSurfaceVariant} />
            </View>
          )}
        </View>

        {/* Title / author / duration */}
        <View style={{ flex: 1, marginLeft: 14 }}>
          <Text numberOfLines={2} style={{ color: colors.onSurface, fontSize: 15, fontWeight: "600", lineHeight: 20 }}>
            {title}
          </Text>
          {subtitle ? (
            <Text numberOfLines={1} style={{ color: colors.onSurfaceVariant, fontSize: 13, marginTop: 2 }}>
              {subtitle}
            </Text>
          ) : null}
          {duration ? (
            <Text style={{ color: colors.onSurfaceVariant, fontSize: 12, marginTop: 2 }}>
              {elapsedPretty(duration)}
            </Text>
          ) : null}
          {libraryItemId ? (
            <BookProgressBadge
              itemId={libraryItemId}
              item={(item as any).libraryItem || item}
              // Episode rows pass their composite-key progress so the badge
              // shows THIS episode's state, not a whole-podcast summary.
              progress={
                item.episodeId
                  ? mediaProgress[`${libraryItemId}-${item.episodeId}`] || null
                  : undefined
              }
              downloaded={(item as any).isLocal || !!(item as any).localLibraryItem}
              style={{ marginTop: 4 }}
            />
          ) : null}
        </View>

        {/* pine-green circular play */}
        {libraryItemId ? (
          <Pressable
            onPress={() => startItem(item)}
            hitSlop={6}
            android_ripple={{ color: withAlpha(colors.onPrimary, 0.2), radius: 24 }}
            accessibilityRole="button"
            accessibilityLabel={ebookOnly ? `Read ${title}` : `Play ${title}`}
            style={{
              width: 48,
              height: 48,
              borderRadius: 24,
              overflow: "hidden",
              backgroundColor: colors.primary,
              alignItems: "center",
              justifyContent: "center",
              marginLeft: 8,
              elevation: 2,
              shadowColor: "#000",
              shadowOffset: { width: 0, height: 1 },
              shadowOpacity: 0.2,
              shadowRadius: 2,
            }}
          >
            <Icon name={ebookOnly ? "book" : "play"} size={26} color={colors.onPrimary} />
          </Pressable>
        ) : null}
      </AnimatedPressable>
    );
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }} edges={["top", "left", "right"]}>
      {/* Header bar */}
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
          hitSlop={8}
          android_ripple={{ color: colors.surfaceContainerHighest, borderless: true, radius: 22 }}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={{ marginRight: 12, padding: 8, borderRadius: 20 }}
        >
          <Icon name="back" size={20} color={colors.onSurface} />
        </Pressable>
        <Text numberOfLines={1} style={{ flex: 1, color: colors.onSurface, fontSize: 20, fontWeight: "700" }}>
          {playlist?.name || "Playlist"}
        </Text>
        {playlist ? (
          <Pressable
            onPress={handleDelete}
            disabled={deleting}
            hitSlop={8}
            android_ripple={{ color: colors.surfaceContainerHighest, borderless: true, radius: 22 }}
            accessibilityRole="button"
            accessibilityLabel="Delete playlist"
            accessibilityState={{ disabled: deleting, busy: deleting }}
            style={{ marginLeft: 8, padding: 8, borderRadius: 20, opacity: deleting ? 0.5 : 1 }}
          >
            <Icon name="trash" size={20} color={colors.onSurfaceVariant} />
          </Pressable>
        ) : null}
      </View>

      {loading ? (
        <ListSkeleton rows={7} thumb={64} />
      ) : error ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
          <Icon name="warning" size={40} color={colors.error} style={{ marginBottom: 12 }} />
          <Text style={{ color: colors.onSurfaceVariant, fontSize: 15, textAlign: "center" }}>{error}</Text>
          {playlistId ? (
            <Pressable
              onPress={() => setRetryTick((t) => t + 1)}
              android_ripple={{ color: withAlpha(colors.onPrimary, 0.2) }}
              accessibilityRole="button"
              accessibilityLabel="Retry loading playlist"
              style={{ marginTop: 20, paddingHorizontal: 24, paddingVertical: 10, borderRadius: 24, overflow: "hidden", backgroundColor: colors.primary }}
            >
              <Text style={{ color: colors.onPrimary, fontSize: 15, fontWeight: "600" }}>Retry</Text>
            </Pressable>
          ) : null}
        </View>
      ) : playlist ? (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: hasSession ? 100 : 32 }}>
          {/* Detail header: collage + title + count + Play all */}
          <View style={{ flexDirection: "row", paddingHorizontal: 16, paddingTop: 20, paddingBottom: 16 }}>
            <PlaylistCollage covers={collageCovers} size={120} colors={colors} />
            <View style={{ flex: 1, marginLeft: 16, justifyContent: "center" }}>
              <Text numberOfLines={3} style={{ color: colors.onSurface, fontSize: 22, fontWeight: "800" }}>
                {playlist.name || "Untitled Playlist"}
              </Text>
              <Text style={{ color: colors.onSurfaceVariant, fontSize: 14, marginTop: 4 }}>
                {items.length} {items.length === 1 ? "item" : "items"}
                {totalDuration ? `  ·  ${elapsedPretty(totalDuration)}` : ""}
              </Text>
              {items.length > 0 ? (
                <Pressable
                  onPress={handlePlayAll}
                  disabled={starting}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "center",
                    alignSelf: "flex-start",
                    marginTop: 14,
                    paddingHorizontal: 20,
                    paddingVertical: 10,
                    borderRadius: 24,
                    backgroundColor: colors.primary,
                    opacity: starting ? 0.6 : 1,
                  }}
                >
                  {starting ? (
                    <ActivityIndicator size="small" color={colors.onPrimary} />
                  ) : (
                    <>
                      <Icon name="play" size={20} color={colors.onPrimary} />
                      <Text style={{ color: colors.onPrimary, fontSize: 15, fontWeight: "600", marginLeft: 6 }}>
                        Play all
                      </Text>
                    </>
                  )}
                </Pressable>
              ) : null}
            </View>
          </View>

          {playlist.description ? (
            <Text style={{ color: colors.onSurface, fontSize: 14, lineHeight: 20, paddingHorizontal: 16, paddingBottom: 12 }}>
              {playlist.description}
            </Text>
          ) : null}

          <View style={{ height: 1, backgroundColor: colors.outlineVariant, marginHorizontal: 16, marginBottom: 6 }} />

          {items.length > 0 ? (
            items.map((item, index) => renderPlaylistItem(item, index))
          ) : (
            <View style={{ alignItems: "center", justifyContent: "center", paddingVertical: 60, paddingHorizontal: 32 }}>
              <Icon name="list" size={48} color={colors.onSurfaceVariant} style={{ marginBottom: 12 }} />
              <Text style={{ color: colors.onSurface, fontSize: 17, fontWeight: "700", marginBottom: 4 }}>
                No items yet
              </Text>
              <Text style={{ color: colors.onSurfaceVariant, fontSize: 15, textAlign: "center" }}>
                Add books to this playlist from a book's details screen.
              </Text>
            </View>
          )}
        </ScrollView>
      ) : null}
    </SafeAreaView>
  );
}

// Rounded collage over primary bg: single fills, else up-to-4 grid.
function PlaylistCollage({ covers, size, colors }: { covers: string[]; size: number; colors: any }) {
  return (
    <View style={{ width: size, height: size, borderRadius: 14, overflow: "hidden", backgroundColor: colors.primary }}>
      {covers.length === 0 ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <Icon name="list" size={28} color={colors.onPrimary} />
        </View>
      ) : covers.length === 1 ? (
        <Image source={coverSource(covers[0])} style={{ width: size, height: size }} contentFit="cover" />
      ) : (
        <View style={{ flexDirection: "row", flexWrap: "wrap", width: size, height: size }}>
          {covers.slice(0, 4).map((uri, idx) => (
            <Image
              key={idx}
              source={{ uri }}
              style={{ width: size / 2, height: covers.length <= 2 ? size : size / 2 }}
              contentFit="cover"
            />
          ))}
        </View>
      )}
    </View>
  );
}
