import React, { useEffect, useRef } from "react";
import { Dimensions, StyleSheet } from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withDelay,
  withTiming,
  Easing,
} from "react-native-reanimated";
import { useThemeColors } from "../theme/useThemeColors";

/**
 * Masks the multi-frame layout reflow on device rotation. The instant the
 * window orientation flips, a surface-colored overlay snaps fully opaque over
 * the WHOLE app (screens, player, everything), holds while React re-lays-out
 * underneath, then fades away — so the user sees a clean crossfade instead of
 * content popping around. Rendered last in AppShell so it sits on top.
 */
export default function RotationCurtain() {
  const colors = useThemeColors();
  const opacity = useSharedValue(0);
  const lastLandscape = useRef<boolean | null>(null);

  useEffect(() => {
    const check = ({ window }: { window: { width: number; height: number } }) => {
      const landscape = window.width > window.height;
      if (lastLandscape.current === null) {
        lastLandscape.current = landscape;
        return;
      }
      if (landscape !== lastLandscape.current) {
        lastLandscape.current = landscape;
        // Snap opaque immediately, hold ~350ms for reflow, then fade out.
        opacity.value = 1;
        opacity.value = withDelay(
          350,
          withTiming(0, { duration: 250, easing: Easing.out(Easing.quad) })
        );
      }
    };
    // Seed with the current orientation.
    const w = Dimensions.get("window");
    lastLandscape.current = w.width > w.height;
    const sub = Dimensions.addEventListener("change", check);
    return () => sub?.remove?.();
  }, []);

  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFill,
        { backgroundColor: colors.surface, zIndex: 99999, elevation: 99999 },
        style,
      ]}
    />
  );
}
