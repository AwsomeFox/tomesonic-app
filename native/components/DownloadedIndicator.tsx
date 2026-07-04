import React from "react";
import { View } from "react-native";
import { useDownloadStore } from "../store/useDownloadStore";
import { useThemeColors } from "../theme/useThemeColors";
import Icon from "./Icon";

/**
 * Small "downloaded to device" badge — a pine-green circle with a cloud-done
 * glyph. Renders ONLY when the item is actually downloaded (present in the
 * download store, or flagged local by the API). Drop it into any list row / card
 * so the downloaded state shows consistently everywhere.
 */
export default function DownloadedIndicator({
  itemId,
  downloaded,
  size = 22,
  style,
}: {
  itemId?: string;
  downloaded?: boolean;
  size?: number;
  style?: any;
}) {
  const colors = useThemeColors();
  const completed = useDownloadStore((s) => s.completedDownloads);
  const isDownloaded = !!downloaded || (!!itemId && !!completed[itemId]);
  if (!isDownloaded) return null;
  return (
    <View
      style={[
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: colors.primary,
          alignItems: "center",
          justifyContent: "center",
        },
        style,
      ]}
    >
      <Icon name="cloud" size={Math.round(size * 0.62)} color={colors.onPrimary} />
    </View>
  );
}
