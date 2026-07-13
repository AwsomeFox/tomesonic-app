import React from "react";
import { View, Text } from "react-native";
import { useThemeColors } from "../theme/useThemeColors";
import { withAlpha } from "../theme/palette";

export type StatusChipTone = "success" | "info" | "warning" | "error" | "neutral";

/**
 * Small status pill (server online, task failed, user disabled, ...). Never
 * color-only: the label text always renders, so tone is reinforcement — not
 * the sole carrier of meaning. Tones map to the theme's container colors:
 *
 *   success → primaryContainer   (the palette's teal-green reads "healthy")
 *   info    → secondaryContainer
 *   warning → tertiaryContainer  (same tone LogsScreen uses for WARN)
 *   error   → errorContainer
 *   neutral → surfaceContainerHighest
 */
export default function StatusChip({
  label,
  tone,
  dot,
  testID,
}: {
  label: string;
  tone: StatusChipTone;
  dot?: boolean;
  testID?: string;
}) {
  const colors = useThemeColors();

  const toneColors: Record<StatusChipTone, { bg: string; fg: string }> = {
    success: { bg: colors.primaryContainer, fg: colors.onPrimaryContainer },
    info: { bg: colors.secondaryContainer, fg: colors.onSecondaryContainer },
    warning: { bg: colors.tertiaryContainer, fg: colors.onTertiaryContainer },
    error: { bg: colors.errorContainer, fg: colors.onErrorContainer },
    neutral: { bg: colors.surfaceContainerHighest, fg: colors.onSurfaceVariant },
  };
  const { bg, fg } = toneColors[tone];

  return (
    <View
      testID={testID ?? "status-chip"}
      accessible
      accessibilityLabel={label}
      style={{
        flexDirection: "row",
        alignItems: "center",
        alignSelf: "flex-start",
        backgroundColor: bg,
        borderRadius: 999,
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderWidth: 1,
        borderColor: withAlpha(fg, 0.12),
      }}
    >
      {dot ? (
        <View
          testID="status-chip-dot"
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: fg,
            marginRight: 6,
          }}
        />
      ) : null}
      <Text style={{ color: fg, fontSize: 12, fontWeight: "600", letterSpacing: 0.2 }}>
        {label}
      </Text>
    </View>
  );
}
