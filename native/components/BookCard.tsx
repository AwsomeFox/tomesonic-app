import React from "react";
import { View, Text, Pressable } from "react-native";
import { Image } from "expo-image";
import { coverSource } from "../utils/coverSource";
import { LinearGradient } from "expo-linear-gradient";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { useThemeColors } from "../theme/useThemeColors";
import { useUserStore } from "../store/useUserStore";
import { useDownloadStore } from "../store/useDownloadStore";
import { withAlpha } from "../theme/palette";
import Icon from "./Icon";
import BookProgressBadge, { bookStatusA11yLabel } from "./BookProgressBadge";
import { hasAudio, hasEbook } from "../utils/bookMatch";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/**
 * Shared book/podcast cover card, replicating the legacy LazyBookCard:
 * square cover, top-left progress chip (schedule / check_circle + label),
 * top-right cloud_done download badge, optional series/book-count badge, and a
 * bottom gradient meta panel with title + author. Tapping opens ItemDetail.
 */
export interface BookCardProps {
  item: any;
  size?: number;
  navigation: any;
  badgeCount?: number; // e.g. books in series
  onPress?: () => void;
}

export default function BookCard({ item, size = 165, navigation, badgeCount, onPress }: BookCardProps) {
  const colors = useThemeColors();
  const { serverConnectionConfig } = useUserStore();
  const mediaProgress = useUserStore((s) => s.mediaProgress);
  const completedDownloads = useDownloadStore((s) => s.completedDownloads);
  const activeDownloads = useDownloadStore((s) => s.activeDownloads);

  // Press feedback: a subtle spring scale-down makes taps feel responsive.
  const scale = useSharedValue(1);
  const pressStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  const serverAddress = serverConnectionConfig?.address?.replace(/\/$/, "") || "";
  const token = serverConnectionConfig?.token || "";

  const media = item?.media || {};
  const metadata = media?.metadata || {};
  const title = metadata.title || item?.title || "";
  const author = metadata.authorName || metadata.author || item?.author || "";
  const hasCover = !!media.coverPath || !!item?.coverUrl;
  const coverUrl =
    item?.coverUrl ||
    (item?.id && serverAddress && token
      ? `${serverAddress}/api/items/${item.id}/cover?width=400&format=webp&token=${token}`
      : null);

  // The global map is authoritative — it's refreshed from the server on every
  // Home focus and live-updated by the playback/reader loops, whereas a
  // progress object embedded in a shelf payload is a snapshot from fetch time.
  const progress = (item?.id ? mediaProgress[item.id] : null) || item?.userMediaProgress || item?.progress || null;
  const itemHasAudio = hasAudio(item);
  const itemHasEbook = hasEbook(item);
  const isPodcast = item?.mediaType === "podcast";

  const duration = itemHasAudio ? Number(media?.duration || progress?.duration || 0) : 0;
  const currentTime = itemHasAudio ? Number(progress?.currentTime || 0) : 0;
  const progressPercent = itemHasAudio
    ? Math.max(Math.min(1, progress?.progress ?? (duration > 0 ? currentTime / duration : 0)), 0)
    : 0;

  let ebookProgressPercent = 0;
  if (itemHasEbook) {
    if (itemHasAudio) {
      ebookProgressPercent = Number(progress?.ebookProgress || 0);
    } else {
      ebookProgressPercent = Number(progress?.ebookProgress || progress?.progress || 0);
    }
  }
  // Finished semantics (mirrors BookProgressBadge + ItemDetailScreen): an
  // EXPLICIT item-level isFinished finishes BOTH formats — both bars hide.
  // The ONE exception is the reader auto-finish (ebook read to >=99% while the
  // audio sits mid-way, 1–98%), where the audio bar keeps showing real
  // progress.
  const readerSetFinished = ebookProgressPercent >= 0.99 && progressPercent > 0 && progressPercent < 0.99;
  const isFinished = itemHasAudio ? !!progress?.isFinished && !readerSetFinished : false;
  const isEbookFinished =
    ebookProgressPercent >= 0.99 || (!!progress?.isFinished && !readerSetFinished);

  // Podcast progress lives per-EPISODE under composite `${itemId}-${episodeId}`
  // map keys, so the plain-id lookup above finds nothing. Drive the bottom bar
  // from the most recently played unfinished episode instead.
  let podcastEpisodeFraction = 0;
  if (isPodcast && item?.id) {
    let latestAt = -1;
    Object.values(mediaProgress).forEach((p: any) => {
      if (!p || p.libraryItemId !== item.id || p.isFinished) return;
      const frac = Number(p.progress || 0);
      if (frac <= 0) return;
      const at = Number(p.lastUpdate || p.updatedAt || 0);
      if (at >= latestAt) {
        latestAt = at;
        podcastEpisodeFraction = Math.min(1, frac);
      }
    });
  }

  // What the bottom (primary-colored) bar shows: the book's audio progress, or
  // the latest episode's progress for podcasts.
  const audioBarFraction = isPodcast ? podcastEpisodeFraction : progressPercent;
  const showAudioBar = audioBarFraction > 0 && !isFinished;
  const showEbookBar = ebookProgressPercent > 0 && !isEbookFinished;

  const isDownloaded = !!(item?.id && completedDownloads[item.id]);
  const activeDownload = item?.id ? activeDownloads[item.id] : null;
  const isDownloading =
    !!activeDownload && (activeDownload.status === "downloading" || activeDownload.status === "pending");
  const downloadPct = Math.round((activeDownload?.progress ?? 0) * 100);

  // A top-right badge (book-count pill) is shown when present;
  // reserve room so the top-left chip can't run under it.
  const hasTopRightBadge = !!badgeCount;
  const chipMaxWidth = hasTopRightBadge ? Math.max(size - 44, 40) : size - 16;

  const handlePress = () => {
    if (onPress) return onPress();
    if (item?.id) navigation.navigate("ItemDetail", { itemId: item.id });
  };

  return (
    <AnimatedPressable
      onPress={handlePress}
      onPressIn={() => { scale.value = withSpring(0.96, { damping: 18, stiffness: 320 }); }}
      onPressOut={() => { scale.value = withSpring(1, { damping: 18, stiffness: 320 }); }}
      android_ripple={{ color: withAlpha(colors.onSurface, 0.12) }}
      accessibilityRole="button"
      // Fold the progress/finished/downloaded status into the card's label —
      // the outer Pressable's label overrides the badge, so a screen-reader
      // user otherwise gets none of the badge's information.
      accessibilityLabel={[
        author ? `${title} by ${author}` : title || "Book",
        bookStatusA11yLabel(item, mediaProgress, isDownloaded),
      ]
        .filter(Boolean)
        .join(". ")}
      style={[
        {
          width: size,
          height: size,
          borderRadius: 20,
          overflow: "hidden",
          marginHorizontal: 4,
          backgroundColor: colors.surfaceContainer,
          elevation: 1,
        },
        pressStyle,
      ]}
    >
      {/* Cover or placeholder */}
      {hasCover && coverUrl ? (
        <>
          <Image
            source={coverSource(coverUrl)}
            style={{ width: "100%", height: "100%", position: "absolute" }}
            contentFit="cover"
            cachePolicy="disk"
            transition={150}
          />
          {/* Book-spine sheen on the left edge — makes covers read as books. */}
          <LinearGradient
            colors={["rgba(0,0,0,0.30)", "rgba(0,0,0,0.10)", "rgba(255,255,255,0.08)", "rgba(0,0,0,0)"]}
            locations={[0, 0.35, 0.6, 1]}
            start={{ x: 0, y: 0.5 }}
            end={{ x: 1, y: 0.5 }}
            pointerEvents="none"
            style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 12 }}
          />
        </>
      ) : (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.primary, padding: 16 }}>
          <Text numberOfLines={4} style={{ color: colors.onPrimary, fontWeight: "500", textAlign: "center", fontSize: 13, marginBottom: 8 }}>
            {title}
          </Text>
          {author ? (
            <Text numberOfLines={2} style={{ color: colors.onPrimary, textAlign: "center", fontSize: 11, opacity: 0.75 }}>
              {author}
            </Text>
          ) : null}
        </View>
      )}

      {/* Unified Progress & Download badge (top-left) */}
      <BookProgressBadge
        itemId={item?.id}
        item={item}
        downloaded={isDownloaded}
        style={{
          position: "absolute",
          top: 8,
          left: 8,
          maxWidth: chipMaxWidth,
          zIndex: 40,
        }}
      />

      {/* Book-count badge (top-right) — mint secondary-container pill w/ book icon */}
      {badgeCount ? (
        <View
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            paddingHorizontal: 8,
            paddingVertical: 3,
            zIndex: 30,
            flexDirection: "row",
            alignItems: "center",
            backgroundColor: colors.secondaryContainer,
            borderRadius: 999,
          }}
        >
          <Icon name="book" size={12} color={colors.onSecondaryContainer} />
          <Text style={{ color: colors.onSecondaryContainer, fontSize: 11, fontWeight: "bold", marginLeft: 4 }}>
            {badgeCount}
          </Text>
        </View>
      ) : null}

      {/* Bottom meta panel */}
      {title ? (
        <LinearGradient
          colors={["transparent", "rgba(0,0,0,0.55)", "rgba(0,0,0,0.85)"]}
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            paddingTop: 24,
            paddingBottom: 12,
            paddingHorizontal: 12,
          }}
        >
          <Text numberOfLines={1} style={{ color: colors.onMedia, fontSize: 15, fontWeight: "700", letterSpacing: -0.1 }}>
            {title}
          </Text>
          {author ? (
            <Text numberOfLines={1} style={{ color: withAlpha(colors.onMedia, 0.7), fontSize: 12, fontWeight: "500", marginTop: 2 }}>
              {author}
            </Text>
          ) : null}
        </LinearGradient>
      ) : null}

      {/* Audio progress bar at the very bottom (primary). When the ebook bar is
          also visible it stacks directly above this one (tertiary), so a
          both-format book in progress in both media shows both, consistently:
          audio on the bottom, reading above it. */}
      {showAudioBar ? (
        <View style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 3, backgroundColor: "rgba(255,255,255,0.2)", zIndex: 45 }}>
          <View style={{ height: 3, width: `${audioBarFraction * 100}%`, backgroundColor: colors.primary }} />
        </View>
      ) : null}

      {/* Reading progress bar (tertiary). The track goes transparent when
          stacked so the unfilled part doesn't double-darken the audio bar. */}
      {showEbookBar ? (
        <View style={{ position: "absolute", bottom: showAudioBar ? 3 : 0, left: 0, right: 0, height: 3, backgroundColor: showAudioBar ? "transparent" : "rgba(255,255,255,0.2)", zIndex: 45 }}>
          <View style={{ height: 3, width: `${ebookProgressPercent * 100}%`, backgroundColor: colors.tertiary }} />
        </View>
      ) : null}

      {/* Active-download overlay: dim the cover and show a live percentage where
          the user is already looking, rather than only on the Downloads screen. */}
      {isDownloading ? (
        <View
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 50,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "rgba(0,0,0,0.45)",
          }}
        >
          <Icon name="download" size={26} color="#FFFFFF" />
          <Text style={{ color: "#FFFFFF", fontSize: 15, fontWeight: "700", marginTop: 4 }}>
            {downloadPct}%
          </Text>
          <View style={{ width: size * 0.6, height: 4, borderRadius: 2, marginTop: 8, backgroundColor: "rgba(255,255,255,0.3)", overflow: "hidden" }}>
            <View style={{ height: 4, width: `${downloadPct}%`, backgroundColor: colors.primary }} />
          </View>
        </View>
      ) : null}
    </AnimatedPressable>
  );
}
