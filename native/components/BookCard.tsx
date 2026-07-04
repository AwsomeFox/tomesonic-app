import React from "react";
import { View, Text, Pressable } from "react-native";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { useThemeColors } from "../theme/useThemeColors";
import { useUserStore } from "../store/useUserStore";
import { useDownloadStore } from "../store/useDownloadStore";
import { withAlpha } from "../theme/palette";
import Icon from "./Icon";
import BookProgressBadge from "./BookProgressBadge";
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

  // Shelf/list payloads often omit progress; fall back to the global map.
  const progress = item?.userMediaProgress || item?.progress || (item?.id ? mediaProgress[item.id] : null) || null;
  const itemHasAudio = hasAudio(item);
  const itemHasEbook = hasEbook(item);

  const duration = itemHasAudio ? Number(media?.duration || progress?.duration || 0) : 0;
  const currentTime = itemHasAudio ? Number(progress?.currentTime || 0) : 0;
  const progressPercent = itemHasAudio
    ? Math.max(Math.min(1, progress?.progress ?? (duration > 0 ? currentTime / duration : 0)), 0)
    : 0;
  const isFinished = itemHasAudio ? !!progress?.isFinished : false;

  let ebookProgressPercent = 0;
  if (itemHasEbook) {
    if (itemHasAudio) {
      ebookProgressPercent = Number(progress?.ebookProgress || 0);
    } else {
      ebookProgressPercent = Number(progress?.ebookProgress || progress?.progress || 0);
    }
  }
  const isEbookFinished = ebookProgressPercent >= 0.99;

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
            source={{ uri: coverUrl }}
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
          <Text numberOfLines={1} style={{ color: "#FFFFFF", fontSize: 15, fontWeight: "700", letterSpacing: -0.1 }}>
            {title}
          </Text>
          {author ? (
            <Text numberOfLines={1} style={{ color: "rgba(255,255,255,0.7)", fontSize: 12, fontWeight: "500", marginTop: 2 }}>
              {author}
            </Text>
          ) : null}
        </LinearGradient>
      ) : null}

      {/* Progress bar at very bottom */}
      {progressPercent > 0 && !isFinished ? (
        <View style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 3, backgroundColor: "rgba(255,255,255,0.2)", zIndex: 45 }}>
          <View style={{ height: 3, width: `${progressPercent * 100}%`, backgroundColor: colors.primary }} />
        </View>
      ) : null}

      {/* Reading progress bar */}
      {ebookProgressPercent > 0 && !isEbookFinished ? (
        <View style={{ position: "absolute", bottom: progressPercent > 0 && !isFinished ? 3 : 0, left: 0, right: 0, height: 3, backgroundColor: progressPercent > 0 && !isFinished ? "transparent" : "rgba(255,255,255,0.2)", zIndex: 45 }}>
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
