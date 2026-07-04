/**
 * theme/ — palette (withAlpha + palette shape), motion tokens, and
 * useThemeColors light/dark resolution (outside a DynamicThemeProvider the
 * hook falls back to the static teal palette keyed by the nativewind scheme).
 */
// NOTE: the setup-file reanimated mock is broken under reanimated v4 — its
// official `react-native-reanimated/mock` now requires react-native-worklets,
// which throws off-device ("Cannot read properties of undefined (reading
// 'loadUnpackers')"). jest.setup.ts must not be edited, so every screens-b
// test file overrides it with this self-contained inert mock.
jest.mock("react-native-reanimated", () => {
  const RN = require("react-native");
  const chainable = () => {
    const o: any = {};
    [
      "delay", "duration", "springify", "damping", "stiffness", "mass",
      "easing", "build", "withInitialValues", "randomDelay", "reduceMotion",
      "withCallback",
    ].forEach((k) => (o[k] = () => o));
    return o;
  };
  const id = (v: any) => v;
  const easing = (t: number) => t;
  return {
    __esModule: true,
    default: {
      createAnimatedComponent: (C: any) => C,
      View: RN.View,
      Text: RN.Text,
      Image: RN.Image,
      ScrollView: RN.ScrollView,
      FlatList: RN.FlatList,
    },
    useSharedValue: (v: any) => ({ value: v }),
    useAnimatedStyle: () => ({}),
    useAnimatedProps: () => ({}),
    useDerivedValue: (fn: any) => ({ value: typeof fn === "function" ? fn() : fn }),
    useAnimatedRef: () => ({ current: null }),
    useAnimatedScrollHandler: () => () => {},
    useAnimatedReaction: () => {},
    useReducedMotion: () => false,
    withTiming: id,
    withSpring: id,
    withDelay: (_d: any, v: any) => v,
    withRepeat: id,
    withSequence: id,
    cancelAnimation: () => {},
    interpolate: () => 0,
    interpolateColor: () => "rgb(0, 0, 0)",
    Extrapolation: { CLAMP: "clamp", EXTEND: "extend", IDENTITY: "identity" },
    Extrapolate: { CLAMP: "clamp", EXTEND: "extend", IDENTITY: "identity" },
    runOnJS: (fn: any) => fn,
    runOnUI: (fn: any) => fn,
    Easing: {
      linear: easing, ease: easing, quad: easing, cubic: easing,
      bezier: () => ({ factory: () => easing }),
      in: (f: any) => f || easing, out: (f: any) => f || easing, inOut: (f: any) => f || easing,
    },
    FadeIn: chainable(), FadeOut: chainable(), FadeInDown: chainable(),
    FadeInUp: chainable(), FadeInRight: chainable(), FadeInLeft: chainable(),
    FadeOutDown: chainable(), FadeOutUp: chainable(),
    SlideInDown: chainable(), SlideOutDown: chainable(),
    LinearTransition: chainable(),
    ReduceMotion: { System: "system", Always: "always", Never: "never" },
  };
});

import React from "react";
import { Text } from "react-native";
import { render, screen } from "@testing-library/react-native";
import { colorScheme } from "nativewind";
import { lightColors, darkColors, withAlpha, ThemeColors } from "../../theme/palette";
import { useThemeColors } from "../../theme/useThemeColors";
import {
  SPATIAL_FAST,
  SPATIAL_DEFAULT,
  SPATIAL_SLOW,
  SPATIAL_EXPRESSIVE,
  SPATIAL_SHEET,
  EFFECT_FAST,
  EFFECT_DEFAULT,
  EMPHASIZED,
  EMPHASIZED_ACCELERATE,
  EMPHASIZED_DECELERATE,
  listRowEnter,
  shelfCardEnter,
} from "../../theme/motion";

afterEach(() => {
  // Never leak a dark scheme into later tests in this file.
  colorScheme.set("light");
});

describe("palette.withAlpha", () => {
  it("converts an rgb() color to rgba() at the given opacity", () => {
    expect(withAlpha("rgb(13, 107, 88)", 0.5)).toBe("rgba(13, 107, 88, 0.5)");
    expect(withAlpha("rgb(0,0,0)", 0.12)).toBe("rgba(0, 0, 0, 0.12)");
  });

  it("passes through values it cannot parse", () => {
    expect(withAlpha("#FFFFFF", 0.5)).toBe("#FFFFFF");
    expect(withAlpha("tomato", 0.2)).toBe("tomato");
    expect(withAlpha("", 0.2)).toBe("");
  });
});

describe("palette color schemes", () => {
  const roleKeys = Object.keys(lightColors) as (keyof ThemeColors)[];

  it("light and dark palettes define the same complete role set", () => {
    expect(Object.keys(darkColors).sort()).toEqual(roleKeys.map(String).sort());
    for (const key of roleKeys) {
      expect(typeof lightColors[key]).toBe("string");
      expect(typeof darkColors[key]).toBe("string");
      expect(lightColors[key]).toMatch(/^rgb\(/);
      expect(darkColors[key]).toMatch(/^rgb\(/);
    }
  });

  it("is the teal scheme, not the M3 baseline purple", () => {
    // Design-spec #1: teal Material You. Light primary is the pine green seed
    // family, dark primary the corresponding tone.
    expect(lightColors.primary).toBe("rgb(13, 107, 88)");
    expect(darkColors.primary).toBe("rgb(134, 214, 191)");
    expect(lightColors.primary).not.toBe(darkColors.primary);
  });
});

describe("motion tokens", () => {
  it("spatial springs expose numeric damping/stiffness", () => {
    for (const spring of [SPATIAL_FAST, SPATIAL_DEFAULT, SPATIAL_SLOW, SPATIAL_EXPRESSIVE]) {
      expect(typeof spring.damping).toBe("number");
      expect(typeof spring.stiffness).toBe("number");
      expect(spring.damping).toBeGreaterThan(0);
      expect(spring.stiffness).toBeGreaterThan(0);
    }
  });

  it("effect springs and the sheet spring clamp overshoot", () => {
    expect(EFFECT_FAST.overshootClamping).toBe(true);
    expect(EFFECT_DEFAULT.overshootClamping).toBe(true);
    expect(SPATIAL_SHEET.overshootClamping).toBe(true);
  });

  it("emphasized easings are defined", () => {
    expect(EMPHASIZED).toBeDefined();
    expect(EMPHASIZED_ACCELERATE).toBeDefined();
    expect(EMPHASIZED_DECELERATE).toBeDefined();
  });

  it("listRowEnter builds an entrance for any index (stagger capped)", () => {
    expect(listRowEnter(0)).toBeDefined();
    expect(listRowEnter(3)).toBeDefined();
    // Index far past the cap must still produce a valid entering config.
    expect(listRowEnter(500)).toBeDefined();
  });

  it("shelfCardEnter builds a springified entrance", () => {
    expect(shelfCardEnter(0)).toBeDefined();
    expect(shelfCardEnter(42)).toBeDefined();
  });
});

describe("useThemeColors", () => {
  function Probe() {
    const colors = useThemeColors();
    return <Text testID="probe">{`${colors.primary}|${String(colors.isDark)}`}</Text>;
  }

  it("resolves the light teal palette by default", async () => {
    colorScheme.set("light");
    await render(<Probe />);
    expect(screen.getByTestId("probe")).toHaveTextContent(
      `${lightColors.primary}|false`
    );
  });

  it("resolves the dark palette when the scheme is dark", async () => {
    colorScheme.set("dark");
    await render(<Probe />);
    expect(screen.getByTestId("probe")).toHaveTextContent(
      `${darkColors.primary}|true`
    );
  });
});
