import React from "react";
import { View, Text } from "react-native";
import { useUserStore } from "../store/useUserStore";
import { useDownloadStore } from "../store/useDownloadStore";
import { useThemeColors } from "../theme/useThemeColors";
import Icon from "./Icon";

function remainingPretty(seconds: number): string {
  if (!seconds || seconds <= 0) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m remaining`;
  if (m > 0) return `${m}m remaining`;
  return `${Math.floor(seconds)}s remaining`;
}

interface Props {
  itemId: string;
  downloaded?: boolean;
  progress?: any;
  style?: any;
}

export default function BookProgressBadge({ itemId, downloaded, progress, style }: Props) {
  const colors = useThemeColors();
  const mediaProgress = useUserStore((s) => s.mediaProgress);
  const completedDownloads = useDownloadStore((s) => s.completedDownloads);

  const isDownloaded = !!downloaded || !!(itemId && completedDownloads[itemId]);

  const progressObj = progress || (itemId ? mediaProgress[itemId] : null);
  const isFinished = !!progressObj?.isFinished;
  const duration = Number(progressObj?.duration || 0);
  const currentTime = Number(progressObj?.currentTime || 0);
  const progressPercent = Math.max(
    Math.min(1, progressObj?.progress ?? (duration > 0 ? currentTime / duration : 0)),
    0
  );
  const isInProgress = progressPercent > 0 && !isFinished;

  if (!isDownloaded && !isFinished && !isInProgress) {
    return null;
  }

  let label = "";
  if (isFinished) {
    label = "Finished";
  } else if (isInProgress) {
    const remaining = duration > 0 ? duration * (1 - progressPercent) : 0;
    label = remainingPretty(remaining);
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
        {isDownloaded && <Icon name="cloud" size={12} color={colors.onTertiaryContainer} />}
        {isFinished && <Icon name="check" size={12} color={colors.onTertiaryContainer} />}
        {isInProgress && <Icon name="clock" size={12} color={colors.onTertiaryContainer} />}
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
