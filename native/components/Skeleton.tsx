import React, { useEffect } from "react";
import { View, ViewStyle, DimensionValue, useWindowDimensions } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  interpolate,
} from "react-native-reanimated";
import { useThemeColors } from "../theme/useThemeColors";
import { withAlpha } from "../theme/palette";

/**
 * A single shimmering placeholder block. A soft highlight sweeps left→right over
 * a muted surface tint, giving loading states a sense of motion (perceived
 * performance) instead of a static grey box or a lone spinner.
 */
export function Skeleton({
  width = "100%",
  height = 16,
  radius = 8,
  style,
}: {
  width?: DimensionValue;
  height?: number;
  radius?: number;
  style?: ViewStyle;
}) {
  const colors = useThemeColors();
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = withRepeat(
      withTiming(1, { duration: 1200, easing: Easing.inOut(Easing.ease) }),
      -1,
      false
    );
    // Stop the infinite shimmer when the skeleton unmounts (content loaded).
    return () => cancelAnimation(progress);
  }, []);

  const sweepStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: interpolate(progress.value, [0, 1], [-1, 1]) * 220 }],
  }));

  return (
    <View
      style={[
        {
          width,
          height,
          borderRadius: radius,
          backgroundColor: colors.surfaceContainerHigh,
          overflow: "hidden",
        },
        style,
      ]}
    >
      <Animated.View style={[{ ...StyleSheetAbsolute }, sweepStyle]}>
        <LinearGradient
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          colors={[
            withAlpha(colors.surfaceContainerHighest, 0),
            withAlpha(colors.onSurface, 0.06),
            withAlpha(colors.surfaceContainerHighest, 0),
          ]}
          style={{ flex: 1 }}
        />
      </Animated.View>
    </View>
  );
}

const StyleSheetAbsolute = {
  position: "absolute" as const,
  top: 0,
  bottom: 0,
  left: 0,
  right: 0,
};

/**
 * The Home/bookshelf loading placeholder: a couple of shelf headers each with a
 * horizontal row of cover-sized skeleton cards. Matches the real layout so the
 * transition to loaded content doesn't jump.
 */
export function ShelfSkeleton({ rows = 3, cards = 4 }: { rows?: number; cards?: number }) {
  const CARD = 165;
  return (
    <View style={{ paddingTop: 16 }}>
      {Array.from({ length: rows }).map((_, r) => (
        <View key={r} style={{ marginBottom: 20 }}>
          {/* Shelf header (accent bar + title) */}
          <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, marginBottom: 12 }}>
            <Skeleton width={5} height={22} radius={3} style={{ marginRight: 10 }} />
            <Skeleton width={160} height={20} radius={6} />
          </View>
          {/* Card row */}
          <View style={{ flexDirection: "row", paddingHorizontal: 12 }}>
            {Array.from({ length: cards }).map((_, c) => (
              <Skeleton
                key={c}
                width={CARD}
                height={CARD}
                radius={20}
                style={{ marginHorizontal: 4 }}
              />
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}

/**
 * A grid of square skeleton tiles for the Library / Series / Authors screens
 * while their first page loads. `columns` should match the real grid.
 */
export function GridSkeleton({
  columns = 2,
  count = 8,
  aspectRatio = 1,
}: {
  columns?: number;
  count?: number;
  aspectRatio?: number;
}) {
  const { width } = useWindowDimensions();
  const OUTER = 8;
  const CELL_PAD = 6;
  const tileWidth = (width - OUTER * 2) / columns - CELL_PAD * 2;
  const tileHeight = Math.round(tileWidth / aspectRatio);
  return (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        paddingHorizontal: OUTER,
        paddingTop: 8,
      }}
    >
      {Array.from({ length: count }).map((_, i) => (
        <View key={i} style={{ width: `${100 / columns}%`, padding: CELL_PAD }}>
          <Skeleton width="100%" height={tileHeight} radius={18} />
        </View>
      ))}
    </View>
  );
}

/**
 * A vertical list of row placeholders (thumbnail + two text lines) for
 * list-style screens like the Library list.
 */
export function ListSkeleton({ rows = 8, thumb = 56 }: { rows?: number; thumb?: number }) {
  return (
    <View style={{ paddingTop: 8 }}>
      {Array.from({ length: rows }).map((_, i) => (
        <View
          key={i}
          style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 10 }}
        >
          <Skeleton width={thumb} height={thumb} radius={10} />
          <View style={{ flex: 1, marginLeft: 14 }}>
            <Skeleton width="70%" height={15} radius={5} />
            <Skeleton width="45%" height={12} radius={5} style={{ marginTop: 8 }} />
          </View>
        </View>
      ))}
    </View>
  );
}

export default Skeleton;
