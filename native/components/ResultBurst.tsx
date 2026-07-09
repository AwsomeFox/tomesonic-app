import React, { useEffect, useRef } from "react";
import { Animated, Easing, Text, View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { useThemeColors } from "../theme/useThemeColors";
import Icon from "./Icon";

/**
 * M3-expressive result moment: a container circle that springs in with a
 * playful overshoot while the icon swings upright, ringed by a scaling halo.
 * Success uses primaryContainer + check; failure errorContainer + warning
 * with a little head-shake. Purely presentational — the caller owns timing
 * (e.g. auto-dismissing a sheet after success).
 */
export default function ResultBurst({
  ok,
  title,
  subtitle,
}: {
  ok: boolean;
  title: string;
  subtitle?: string;
}) {
  const colors = useThemeColors();
  const reduceMotion = useReducedMotion();
  const scale = useRef(new Animated.Value(0)).current;
  const halo = useRef(new Animated.Value(0)).current;
  const swing = useRef(new Animated.Value(0)).current; // icon rotation progress
  const shake = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (reduceMotion) {
      // Reduced motion: jump straight to the settled badge — upright icon,
      // full-size container, halo already faded out, no shake.
      scale.setValue(1);
      halo.setValue(1);
      swing.setValue(1);
      shake.setValue(0);
      return;
    }
    // Expressive spring: fast attack, visible overshoot, quick settle.
    Animated.parallel([
      Animated.spring(scale, {
        toValue: 1,
        tension: 120,
        friction: 5,
        useNativeDriver: true,
      }),
      Animated.timing(halo, {
        toValue: 1,
        duration: 450,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.spring(swing, {
        toValue: 1,
        tension: 60,
        friction: 6,
        useNativeDriver: true,
      }),
    ]).start(() => {
      if (!ok) {
        // Gentle "nope" head-shake after landing.
        Animated.sequence(
          [10, -8, 6, -4, 0].map((x) =>
            Animated.timing(shake, {
              toValue: x,
              duration: 55,
              easing: Easing.inOut(Easing.quad),
              useNativeDriver: true,
            })
          )
        ).start();
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const bg = ok ? colors.primaryContainer : colors.errorContainer;
  const fg = ok ? colors.onPrimaryContainer : colors.error;

  return (
    <View style={{ alignItems: "center", paddingVertical: 28, paddingHorizontal: 24 }}>
      <View style={{ width: 96, height: 96, alignItems: "center", justifyContent: "center" }}>
        {/* Halo: expands past the badge and fades — the "burst". */}
        <Animated.View
          style={{
            position: "absolute",
            width: 96,
            height: 96,
            borderRadius: 48,
            backgroundColor: bg,
            opacity: halo.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0] }),
            transform: [{ scale: halo.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1.6] }) }],
          }}
        />
        <Animated.View
          style={{
            width: 76,
            height: 76,
            borderRadius: 38,
            backgroundColor: bg,
            alignItems: "center",
            justifyContent: "center",
            transform: [{ scale }, { translateX: shake }],
          }}
        >
          <Animated.View
            style={{
              transform: [
                {
                  rotate: swing.interpolate({
                    inputRange: [0, 1],
                    outputRange: ok ? ["-60deg", "0deg"] : ["25deg", "0deg"],
                  }),
                },
              ],
            }}
          >
            <Icon name={ok ? "check" : "warning"} size={40} color={fg} />
          </Animated.View>
        </Animated.View>
      </View>
      <Text
        style={{
          color: colors.onSurface,
          fontSize: 18,
          fontWeight: "600",
          marginTop: 16,
          textAlign: "center",
        }}
      >
        {title}
      </Text>
      {subtitle ? (
        <Text
          style={{
            color: colors.onSurfaceVariant,
            fontSize: 13,
            marginTop: 6,
            textAlign: "center",
          }}
        >
          {subtitle}
        </Text>
      ) : null}
    </View>
  );
}
