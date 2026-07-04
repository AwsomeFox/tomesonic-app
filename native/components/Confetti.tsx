import React, { useEffect } from "react";
import { View, useWindowDimensions } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  runOnJS,
  interpolate,
  cancelAnimation,
  type SharedValue,
} from "react-native-reanimated";
import { useThemeColors } from "../theme/useThemeColors";

const COUNT = 28;
const DURATION = 1800;

/**
 * A one-shot confetti burst that celebrates finishing a book. Purely decorative,
 * pointer-events-none, and self-dismissing — flip `visible` to true to fire it.
 * No external dependency; particles are plain reanimated views.
 */
export default function Confetti({
  visible,
  onDone,
}: {
  visible: boolean;
  onDone?: () => void;
}) {
  const colors = useThemeColors();
  const { width } = useWindowDimensions();
  const t = useSharedValue(0);

  // Fixed per-particle parameters (angle spread, distance, spin, color, size).
  const particles = React.useMemo(() => {
    const palette = [
      colors.primary,
      colors.tertiary,
      colors.secondary,
      colors.primaryContainer,
      "#F5A623",
      "#E85D75",
    ];
    return Array.from({ length: COUNT }).map((_, i) => {
      const angle = (Math.PI * (i / (COUNT - 1))) - Math.PI / 2; // fan upward/out
      const spreadX = Math.sin(angle) * (120 + (i % 5) * 34);
      const rise = 90 + (i % 7) * 26;
      return {
        dx: spreadX,
        rise,
        spin: (i % 2 === 0 ? 1 : -1) * (360 + (i % 3) * 180),
        color: palette[i % palette.length],
        size: 7 + (i % 3) * 3,
        delay: (i % 6) * 20,
      };
    });
  }, [colors]);

  useEffect(() => {
    if (visible) {
      t.value = 0;
      // Easing.out(quad) is deliberate (decelerating "physics" for the burst),
      // not a UI transition — the M3 motion tokens don't apply here.
      t.value = withTiming(1, { duration: DURATION, easing: Easing.out(Easing.quad) }, (finished) => {
        if (finished && onDone) runOnJS(onDone)();
      });
    }
    // Cancel on unmount so the burst can't outlive the player closing mid-flight.
    return () => cancelAnimation(t);
  }, [visible]);

  if (!visible) return null;

  return (
    <View pointerEvents="none" style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}>
      <View style={{ position: "absolute", top: "34%", left: width / 2 }}>
        {particles.map((p, i) => (
          <Particle key={i} t={t} p={p} />
        ))}
      </View>
    </View>
  );
}

function Particle({ t, p }: { t: SharedValue<number>; p: any }) {
  const style = useAnimatedStyle(() => {
    // Rise then fall under "gravity" as t goes 0→1.
    const up = interpolate(t.value, [0, 0.4, 1], [0, -p.rise, p.rise * 0.6]);
    const across = interpolate(t.value, [0, 1], [0, p.dx]);
    const opacity = interpolate(t.value, [0, 0.75, 1], [1, 1, 0]);
    const rotate = `${p.spin * t.value}deg`;
    return {
      opacity,
      transform: [{ translateX: across }, { translateY: up }, { rotate }],
    };
  });

  return (
    <Animated.View
      style={[
        {
          position: "absolute",
          width: p.size,
          height: p.size * 1.6,
          borderRadius: 2,
          backgroundColor: p.color,
        },
        style,
      ]}
    />
  );
}
