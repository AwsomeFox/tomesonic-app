import React from "react";
import { View, Text, StyleProp, ViewStyle } from "react-native";
import { useThemeColors } from "../theme/useThemeColors";
import Icon, { IconName } from "./Icon";

interface EmptyStateProps {
  /** Icon shown inside the filled secondaryContainer circle. */
  icon: IconName;
  /** Bold headline (18/600). */
  title: string;
  /** Optional supporting line beneath the title. */
  message?: string;
  /** Optional action (e.g. a Retry button) rendered below the message. */
  action?: React.ReactNode;
  /** Extra container style — e.g. `{ flex: 1 }` to fill and center a screen. */
  style?: StyleProp<ViewStyle>;
}

/**
 * Shared empty-state treatment used across list/detail screens so every "no
 * content yet" view looks identical: a 72dp filled secondaryContainer circle
 * icon over an 18/600 title and a 15 supporting label. Extracted from the
 * DownloadsScreen original, which had the nicest treatment.
 */
export default function EmptyState({ icon, title, message, action, style }: EmptyStateProps) {
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
          backgroundColor: colors.secondaryContainer,
          alignItems: "center",
          justifyContent: "center",
          marginBottom: 16,
        }}
      >
        <Icon name={icon} size={36} color={colors.onSecondaryContainer} />
      </View>
      <Text style={{ color: colors.onSurface, fontSize: 18, fontWeight: "600", textAlign: "center" }}>
        {title}
      </Text>
      {message ? (
        <Text style={{ color: colors.onSurfaceVariant, fontSize: 15, textAlign: "center", marginTop: 8 }}>
          {message}
        </Text>
      ) : null}
      {action ? <View style={{ marginTop: 20 }}>{action}</View> : null}
    </View>
  );
}
