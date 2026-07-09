import React from "react";
import { View, Text } from "react-native";
import Animated, { FadeInDown, FadeOutUp } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColors } from "../theme/useThemeColors";
import { useNetworkStatus } from "../hooks/useNetworkStatus";
import Icon from "./Icon";

/**
 * Thin banner shown at the very top of the app while offline, so users know
 * why fetches are failing / only downloaded content is available. Renders
 * nothing when connected.
 *
 * Inset handling: the banner paints the status-bar area itself (paddingTop),
 * then gives that inset back to the layout (negative marginBottom) because
 * every screen below already pads the top inset via SafeAreaView — without
 * the give-back the inset is counted twice and a blank strip appears. zIndex
 * keeps the banner above the screens' (blank) safe-area padding it overlaps,
 * but below PlayerBottomSheet's zIndex 100 so the full-screen player is never
 * covered.
 */
export default function OfflineBanner() {
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const { isOffline } = useNetworkStatus();

  // Gate on the derived "effectively offline" signal (debounced; also true for
  // a captive portal / server-down-but-Wi-Fi-up), not device isConnected alone.
  // Reanimated keeps the view mounted through the exit animation, so returning
  // null here still slides/fades the banner out rather than popping it away.
  if (!isOffline) return null;

  return (
    // Slide-down + fade in on connect loss, slide-up + fade out on recovery.
    // Duration matches the shared listRowEnter recipe (theme/motion.ts); the
    // FadeIn/FadeOut layout animations auto-respect reduce-motion in reanimated.
    <Animated.View
      // Optional-chained so an incomplete test mock of reanimated (missing a
      // layout-animation export) leaves the prop undefined instead of throwing.
      entering={FadeInDown.duration(250)}
      exiting={FadeOutUp.duration(200)}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={{
        paddingTop: insets.top,
        marginBottom: -insets.top,
        zIndex: 10,
        backgroundColor: colors.errorContainer,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          paddingVertical: 6,
          paddingHorizontal: 16,
        }}
      >
        <Icon name="cloud-off" size={14} color={colors.onErrorContainer} style={{ marginRight: 6 }} />
        <Text style={{ color: colors.onErrorContainer, fontSize: 12, fontWeight: "600", textAlign: "center" }}>
          No internet connection — showing downloaded content
        </Text>
      </View>
    </Animated.View>
  );
}
