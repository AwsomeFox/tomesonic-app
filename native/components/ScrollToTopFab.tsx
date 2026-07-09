import React, { useEffect, useRef, useState } from "react";
import { Animated, Easing, Pressable } from "react-native";
import { useThemeColors } from "../theme/useThemeColors";
import Icon, { IconName } from "./Icon";

/**
 * Material 3 Expressive scroll-to-top FAB.
 *
 * Two things the old inline FAB got wrong:
 *  1. It hard-mounted/unmounted on `visible`, so it popped in and out with no
 *     motion. M3 Expressive FABs enter with a springy scale + fade and leave by
 *     scaling back down — so we keep the view mounted through the exit and only
 *     unmount once the collapse animation finishes.
 *  2. `android_ripple` on a rounded Pressable bled a SQUARE ripple past the
 *     corners because the container didn't clip. `overflow: "hidden"` masks the
 *     ripple to the FAB's rounded shape.
 */
export default function ScrollToTopFab({
  visible,
  onPress,
  bottom,
  right = 16,
  icon = "chevron-up",
  accessibilityLabel = "Scroll to top",
  testID,
}: {
  visible: boolean;
  onPress: () => void;
  bottom: number;
  right?: number;
  icon?: IconName;
  accessibilityLabel?: string;
  testID?: string;
}) {
  const colors = useThemeColors();
  // Kept mounted while animating out so the collapse is visible.
  const [mounted, setMounted] = useState(visible);
  // Drives both scale and opacity: 0 = hidden/collapsed, 1 = shown.
  const anim = useRef(new Animated.Value(visible ? 1 : 0)).current;

  useEffect(() => {
    if (visible) {
      setMounted(true);
      // Expressive entrance: a spring with a touch of overshoot so the FAB
      // "pops" in rather than easing linearly.
      Animated.spring(anim, {
        toValue: 1,
        bounciness: 10,
        speed: 14,
        useNativeDriver: true,
      }).start();
    } else if (mounted) {
      // Collapse back down, then unmount.
      Animated.timing(anim, {
        toValue: 0,
        duration: 150,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) setMounted(false);
      });
    }
  }, [visible, mounted, anim]);

  if (!mounted) return null;

  return (
    <Animated.View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        right,
        bottom,
        // Shadow lives on the outer container: putting it on the clipping
        // Pressable below would clip the iOS shadow along with the ripple.
        borderRadius: 16,
        elevation: 3,
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.2,
        shadowRadius: 3,
        opacity: anim,
        transform: [
          { scale: anim.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }) },
        ],
      }}
    >
      <Pressable
        onPress={onPress}
        android_ripple={{ color: colors.surfaceContainerHighest, borderless: false }}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        testID={testID}
        style={{
          width: 48,
          height: 48,
          borderRadius: 16,
          alignItems: "center",
          justifyContent: "center",
          // Clip the ripple to the rounded shape (fixes the square ripple).
          overflow: "hidden",
          backgroundColor: colors.secondaryContainer,
        }}
      >
        <Icon name={icon} size={26} color={colors.onSecondaryContainer} />
      </Pressable>
    </Animated.View>
  );
}
