import React from "react";
import { View, Text, Pressable, StyleProp, ViewStyle } from "react-native";
import { useThemeColors } from "../theme/useThemeColors";
import { withAlpha } from "../theme/palette";
import Icon, { IconName } from "./Icon";

interface ErrorStateProps {
  /** Icon shown inside the filled errorContainer circle. Defaults to "warning". */
  icon?: IconName;
  /** Bold headline (18/600). Defaults to "Something went wrong". */
  title?: string;
  /** Optional supporting line beneath the title (e.g. the error detail). */
  message?: string;
  /** When provided, renders the canonical pill retry button. */
  onRetry?: () => void;
  /** Retry button label. Defaults to "Retry". */
  retryLabel?: string;
  /** Optional custom action rendered instead of the retry button. */
  action?: React.ReactNode;
  /** Extra container style — e.g. `{ flex: 1 }` to fill and center a screen. */
  style?: StyleProp<ViewStyle>;
}

/**
 * Shared full-screen error treatment — the sibling of EmptyState. Before this,
 * ~13 screens hand-rolled their own error view and drifted apart (icon size
 * 36–48, icon color red-vs-grey for the SAME failure, headline present or
 * absent, retry-button type varying). This gives every failure one voice: a
 * 72dp errorContainer circle over an 18/600 title, a 15 supporting line, and
 * one canonical pill retry button.
 */
export default function ErrorState({
  icon = "warning",
  title = "Something went wrong",
  message,
  onRetry,
  retryLabel = "Retry",
  action,
  style,
}: ErrorStateProps) {
  const colors = useThemeColors();
  return (
    <View
      style={[
        { alignItems: "center", justifyContent: "center", paddingVertical: 80, paddingHorizontal: 32 },
        style,
      ]}
    >
      <View
        style={{
          width: 72,
          height: 72,
          borderRadius: 36,
          backgroundColor: colors.errorContainer,
          alignItems: "center",
          justifyContent: "center",
          marginBottom: 16,
        }}
      >
        <Icon name={icon} size={36} color={colors.onErrorContainer} />
      </View>
      <Text style={{ color: colors.onSurface, fontSize: 18, fontWeight: "600", textAlign: "center" }}>
        {title}
      </Text>
      {message ? (
        <Text style={{ color: colors.onSurfaceVariant, fontSize: 15, textAlign: "center", marginTop: 8 }}>
          {message}
        </Text>
      ) : null}
      {action ? (
        <View style={{ marginTop: 20 }}>{action}</View>
      ) : onRetry ? (
        <Pressable
          onPress={onRetry}
          accessibilityRole="button"
          accessibilityLabel={retryLabel}
          android_ripple={{ color: withAlpha(colors.onSecondaryContainer, 0.14), borderless: false }}
          style={{
            marginTop: 20,
            paddingVertical: 10,
            paddingHorizontal: 24,
            borderRadius: 20,
            backgroundColor: colors.secondaryContainer,
            overflow: "hidden",
          }}
        >
          <Text style={{ color: colors.onSecondaryContainer, fontSize: 15, fontWeight: "600" }}>
            {retryLabel}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
