import React, { useEffect } from "react";
import { Text, Pressable, AccessibilityInfo } from "react-native";
import Animated, { FadeInDown, FadeOutDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColors } from "../theme/useThemeColors";
import { withAlpha } from "../theme/palette";
import { useSnackbarStore } from "../store/useSnackbarStore";
import { usePlaybackStore } from "../store/usePlaybackStore";
import { MINIPLAYER_HEIGHT, TAB_BAR_HEIGHT } from "../utils/layoutConstants";

/**
 * Material 3 snackbar host — mount once in AppShell (just below AppDialog).
 * Renders nothing until showSnackbar() sets a message, then shows an
 * inverseSurface pill that floats above the mini-player (when a playback
 * session exists) and the tab bar, auto-dismissing after durationMs.
 *
 * Single-instance: the store replaces `current` on every show, and the store
 * entry's `key` remounts the animated view so a replacement re-runs the enter
 * animation and restarts the auto-dismiss timer. The FadeIn/FadeOut layout
 * animations auto-respect the OS reduce-motion setting in reanimated (same
 * contract OfflineBanner relies on).
 */
export default function AppSnackbar() {
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const snackbar = useSnackbarStore((s) => s.current);
  const dismiss = useSnackbarStore((s) => s.dismiss);
  const hasSession = usePlaybackStore((s) => s.currentSession !== null);
  const onTabScreen = usePlaybackStore((s) => s.onTabScreen);

  // Announce + arm the auto-dismiss timer per shown entry. Keyed on
  // snackbar.key so a replacement (even with an identical message) re-announces
  // and restarts the countdown; the cleanup guarantees no timer outlives the
  // entry it belongs to.
  useEffect(() => {
    if (!snackbar) return;
    AccessibilityInfo.announceForAccessibility(snackbar.message);
    const t = setTimeout(() => dismiss(), snackbar.durationMs);
    return () => clearTimeout(t);
  }, [snackbar, dismiss]);

  if (!snackbar) return null;

  // Float above the mini-player when a session exists — mirror how
  // PlayerBottomSheet computes its collapsed offset (tab bar 64 + bottom inset
  // on tab screens, bare inset elsewhere), then add the mini-player's height.
  const bottom =
    insets.bottom +
    (onTabScreen ? TAB_BAR_HEIGHT : 0) +
    (hasSession ? MINIPLAYER_HEIGHT : 0) +
    12;

  const onAction = () => {
    dismiss();
    snackbar.action?.onPress();
  };

  return (
    // NO accessibilityLiveRegion here: the effect above already announces the
    // message explicitly, and pairing that with a live region makes Android
    // TalkBack speak every snackbar twice.
    <Animated.View
      key={snackbar.key}
      entering={FadeInDown.duration(250)}
      exiting={FadeOutDown.duration(200)}
      testID="app-snackbar"
      style={{
        position: "absolute",
        left: 16,
        right: 16,
        bottom,
        flexDirection: "row",
        alignItems: "center",
        backgroundColor: colors.inverseSurface,
        borderRadius: 8,
        paddingLeft: 16,
        paddingRight: snackbar.action ? 8 : 16,
        minHeight: 48,
        elevation: 6,
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.25,
        shadowRadius: 4,
      }}
    >
      <Text
        style={{ flex: 1, color: colors.inverseOnSurface, fontSize: 14, paddingVertical: 14 }}
        numberOfLines={2}
      >
        {snackbar.message}
      </Text>
      {snackbar.action ? (
        <Pressable
          onPress={onAction}
          accessibilityRole="button"
          accessibilityLabel={snackbar.action.label}
          hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
          android_ripple={{ color: withAlpha(colors.inversePrimary, 0.2), borderless: false }}
          style={{
            marginLeft: 8,
            paddingVertical: 8,
            paddingHorizontal: 12,
            borderRadius: 8,
            overflow: "hidden",
          }}
        >
          <Text style={{ color: colors.inversePrimary, fontSize: 14, fontWeight: "600" }}>
            {snackbar.action.label}
          </Text>
        </Pressable>
      ) : null}
    </Animated.View>
  );
}
