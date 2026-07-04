import React from "react";
import { View, Text } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColors } from "../theme/useThemeColors";
import { useNetworkStatus } from "../hooks/useNetworkStatus";

/**
 * Thin banner shown at the very top of the app while offline, so users know
 * why fetches are failing / only downloaded content is available. Renders
 * nothing when connected.
 */
export default function OfflineBanner() {
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const { isConnected } = useNetworkStatus();

  if (isConnected) return null;

  return (
    <View
      style={{
        paddingTop: insets.top,
        backgroundColor: colors.errorContainer,
      }}
    >
      <View style={{ paddingVertical: 6, paddingHorizontal: 16 }}>
        <Text style={{ color: colors.onErrorContainer, fontSize: 12, fontWeight: "600", textAlign: "center" }}>
          No internet connection — showing downloaded content
        </Text>
      </View>
    </View>
  );
}
