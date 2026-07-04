import React, { useEffect, useState } from "react";
import { View, Text, TextStyle, StyleProp } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";

/**
 * Single-line text that gently scrolls back and forth only when it overflows its
 * container; otherwise it renders as ordinary (non-animated) text. Used for long
 * book titles where an ellipsis would hide the part the reader wants.
 */
export default function Marquee({
  text,
  style,
}: {
  text: string;
  style?: StyleProp<TextStyle>;
}) {
  const [containerW, setContainerW] = useState(0);
  const [textW, setTextW] = useState(0);
  const tx = useSharedValue(0);

  const overflow = Math.max(0, textW - containerW);

  useEffect(() => {
    if (overflow > 1 && containerW > 0) {
      // px/sec pacing so long titles don't scroll faster than short ones.
      const dur = Math.max(2000, Math.round(overflow * 22));
      tx.value = 0;
      tx.value = withRepeat(
        withSequence(
          withDelay(1200, withTiming(-overflow, { duration: dur, easing: Easing.inOut(Easing.quad) })),
          withDelay(1200, withTiming(0, { duration: dur, easing: Easing.inOut(Easing.quad) }))
        ),
        -1,
        false
      );
    } else {
      tx.value = 0;
    }
  }, [overflow, containerW, text]);

  const animStyle = useAnimatedStyle(() => ({ transform: [{ translateX: tx.value }] }));

  return (
    <View
      style={{ overflow: "hidden" }}
      onLayout={(e) => setContainerW(e.nativeEvent.layout.width)}
    >
      {/* Hidden measuring copy — reports the true single-line width. */}
      <Text
        numberOfLines={1}
        onLayout={(e) => setTextW(e.nativeEvent.layout.width)}
        style={[style, { position: "absolute", opacity: 0, left: 0, top: 0 }]}
      >
        {text}
      </Text>

      {overflow > 1 ? (
        <Animated.Text numberOfLines={1} style={[style, { width: textW }, animStyle]}>
          {text}
        </Animated.Text>
      ) : (
        <Text numberOfLines={1} style={style}>
          {text}
        </Text>
      )}
    </View>
  );
}
