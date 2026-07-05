import React, { createContext, useContext, useMemo } from "react";
import { View } from "react-native";
import { vars, useColorScheme } from "nativewind";
import { useMaterial3Theme } from "@pchmn/expo-material3-theme";
import { lightColors, darkColors, ThemeColors } from "./palette";
import { useThemeStore } from "../store/useThemeStore";

// Full Material You: the app is tinted from the system wallpaper palette on
// Android 12+ (matching the original app's "Use Dynamic Colors" behaviour).
// When the platform can't supply a dynamic palette we fall back to the brand
// teal seed so we never regress to the M3 baseline purple.
const FALLBACK_SEED = "#1E5F50";

type Ctx = ThemeColors & { isDark: boolean };
const ThemeContext = createContext<Ctx | null>(null);

/** "#RRGGBB" or "#AARRGGBB" -> "R G B" (the space-separated triple NativeWind vars expect). */
function hexToTriple(hex: string): string | null {
  if (!hex) return null;
  const h = hex.replace("#", "");
  const s = h.length === 8 ? h.slice(2) : h;
  if (s.length < 6) return null;
  const r = parseInt(s.slice(0, 2), 16);
  const g = parseInt(s.slice(2, 4), 16);
  const b = parseInt(s.slice(4, 6), 16);
  if ([r, g, b].some((n) => Number.isNaN(n))) return null;
  return `${r} ${g} ${b}`;
}
const tripleToRgb = (t: string) => {
  const [r, g, b] = t.split(" ");
  return `rgb(${r}, ${g}, ${b})`;
};

// scheme role (camelCase, from @pchmn) -> css token suffix (kebab, matches global.css / tailwind).
const ROLE_TO_CSS: Record<string, string> = {
  primary: "primary",
  onPrimary: "on-primary",
  primaryContainer: "primary-container",
  onPrimaryContainer: "on-primary-container",
  secondary: "secondary",
  onSecondary: "on-secondary",
  secondaryContainer: "secondary-container",
  onSecondaryContainer: "on-secondary-container",
  tertiary: "tertiary",
  onTertiary: "on-tertiary",
  tertiaryContainer: "tertiary-container",
  onTertiaryContainer: "on-tertiary-container",
  error: "error",
  onError: "on-error",
  errorContainer: "error-container",
  onErrorContainer: "on-error-container",
  surface: "surface",
  onSurface: "on-surface",
  surfaceVariant: "surface-variant",
  onSurfaceVariant: "on-surface-variant",
  surfaceDim: "surface-dim",
  surfaceBright: "surface-bright",
  surfaceContainerLowest: "surface-container-lowest",
  surfaceContainerLow: "surface-container-low",
  surfaceContainer: "surface-container",
  surfaceContainerHigh: "surface-container-high",
  surfaceContainerHighest: "surface-container-highest",
  outline: "outline",
  outlineVariant: "outline-variant",
  inverseSurface: "inverse-surface",
  inverseOnSurface: "inverse-on-surface",
  inversePrimary: "inverse-primary",
};

export function DynamicThemeProvider({ children }: { children: React.ReactNode }) {
  const { theme } = useMaterial3Theme({ fallbackSourceColor: FALLBACK_SEED });
  const { colorScheme } = useColorScheme();
  const useDynamicColors = useThemeStore((s) => s.useDynamicColors);
  const isDark = colorScheme === "dark";
  const staticColors = isDark ? darkColors : lightColors;
  // When dynamic color is OFF, ignore the wallpaper palette and use static teal.
  const scheme: any = useDynamicColors ? (isDark ? theme.dark : theme.light) : null;

  const { colors, cssVars } = useMemo(() => {
    // Only override the CSS vars the dynamic scheme actually provides; any unset
    // var keeps its static teal value from global.css (never falls back to purple).
    const cssVars: Record<string, string> = {};
    for (const [role, css] of Object.entries(ROLE_TO_CSS)) {
      const triple = hexToTriple(scheme?.[role]);
      if (triple) cssVars[`--md-sys-color-${css}`] = triple;
    }

    // Inline-style palette: prefer the dynamic scheme, fall back to static teal.
    const g = (role: keyof ThemeColors, fallback: string) => {
      const triple = hexToTriple((scheme as any)?.[role]);
      return triple ? tripleToRgb(triple) : fallback;
    };
    const keys = Object.keys(staticColors) as (keyof ThemeColors)[];
    const colors = {} as ThemeColors;
    for (const k of keys) colors[k] = g(k, staticColors[k]);
    // onMedia / onMediaVariant / success aren't part of the M3 scheme — keep static.
    colors.onMedia = staticColors.onMedia;
    colors.onMediaVariant = staticColors.onMediaVariant;
    colors.success = staticColors.success;

    return { colors, cssVars };
  }, [scheme, staticColors, useDynamicColors]);

  return (
    <ThemeContext.Provider value={{ ...colors, isDark }}>
      <View style={[{ flex: 1 }, vars(cssVars)]}>{children}</View>
    </ThemeContext.Provider>
  );
}

export function useDynamicThemeContext() {
  return useContext(ThemeContext);
}
