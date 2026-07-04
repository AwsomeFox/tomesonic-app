import React from "react";
import { View, Text } from "react-native";
import { useUserStore } from "../store/useUserStore";
import { useDownloadStore } from "../store/useDownloadStore";
import { useThemeColors } from "../theme/useThemeColors";
import Icon from "./Icon";
import { hasAudio, hasEbook } from "../utils/bookMatch";

function remainingPretty(seconds: number): string {
  if (!seconds || seconds <= 0) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${Math.floor(seconds)}s`;
}

interface Props {
  itemId: string;
  item?: any;
  downloaded?: boolean;
  progress?: any;
  style?: any;
}

export default function BookProgressBadge({ itemId, item, downloaded, progress, style }: Props) {
  const colors = useThemeColors();
  const mediaProgress = useUserStore((s) => s.mediaProgress);
  const completedDownloads = useDownloadStore((s) => s.completedDownloads);

  const isDownloaded = !!downloaded || !!(itemId && completedDownloads[itemId]);

  const progressObj = progress || (itemId ? mediaProgress[itemId] : null);
  const itemHasAudio = item ? hasAudio(item) : (progressObj?.duration > 0 || progressObj?.currentTime > 0);
  const itemHasEbook = item ? hasEbook(item) : (progressObj?.ebookProgress > 0 || progressObj?.ebookLocation);

  const isFinished = itemHasAudio ? !!progressObj?.isFinished : false;
  const duration = itemHasAudio ? Number(progressObj?.duration || 0) : 0;
  const currentTime = itemHasAudio ? Number(progressObj?.currentTime || 0) : 0;
  const progressPercent = itemHasAudio
    ? Math.max(Math.min(1, progressObj?.progress ?? (duration > 0 ? currentTime / duration : 0)), 0)
    : 0;
  const isInProgress = progressPercent > 0 && !isFinished;

  let ebookProgressPercent = 0;
  if (itemHasEbook) {
    if (itemHasAudio) {
      ebookProgressPercent = Number(progressObj?.ebookProgress || 0);
    } else {
      ebookProgressPercent = Number(progressObj?.ebookProgress || progressObj?.progress || 0);
    }
  }
  const isEbookFinished = ebookProgressPercent >= 0.99;
  const isEbookInProgress = ebookProgressPercent > 0 && !isEbookFinished;

  if (!isDownloaded && !isFinished && !isInProgress && !isEbookInProgress && !isEbookFinished) {
    return null;
  }

  let label = "";
  const showListenProgress = isInProgress;
  const showEbookProgress = isEbookInProgress;

  if (isFinished && (isEbookFinished || ebookProgressPercent === 0)) {
    label = "Finished";
  } else if (showListenProgress && showEbookProgress) {
    const listenLabel = duration > 0 ? remainingPretty(duration * (1 - progressPercent)) : `${Math.round(progressPercent * 100)}%`;
    label = `${listenLabel} • ${Math.round(ebookProgressPercent * 100)}%`;
  } else if (showListenProgress) {
    label = duration > 0 ? remainingPretty(duration * (1 - progressPercent)) : `${Math.round(progressPercent * 100)}%`;
  } else if (showEbookProgress) {
    label = `${Math.round(ebookProgressPercent * 100)}%`;
  } else if (isEbookFinished) {
    label = "Read Finished";
  } else if (isDownloaded) {
    label = "Downloaded";
  }

  return (
    <View
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          backgroundColor: colors.tertiaryContainer,
          borderRadius: 999,
          paddingHorizontal: 8,
          paddingVertical: 3,
          alignSelf: "flex-start",
        },
        style,
      ]}
    >
      {/* Icon cluster */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          marginRight: label ? 5 : 0,
          columnGap: 4,
        }}
      >
        {isDownloaded && !isInProgress && !isEbookInProgress && !isFinished && !isEbookFinished && (
          <Icon name="cloud" size={12} color={colors.onTertiaryContainer} />
        )}
        {(isFinished || isEbookFinished) && !isInProgress && !isEbookInProgress && (
          <Icon name="check" size={12} color={colors.onTertiaryContainer} />
        )}
        {showListenProgress && <Icon name="headphones" size={12} color={colors.onTertiaryContainer} />}
        {showEbookProgress && <Icon name="book" size={12} color={colors.onTertiaryContainer} />}
      </View>

      {/* Label */}
      {label ? (
        <Text
          numberOfLines={1}
          style={{
            color: colors.onTertiaryContainer,
            fontSize: 10,
            fontWeight: "600",
            letterSpacing: 0.1,
            flexShrink: 1,
          }}
        >
          {label}
        </Text>
      ) : null}
    </View>
  );
}
