import { useColorScheme } from "nativewind";
import { lightColors, darkColors, ThemeColors } from "./palette";
import { useDynamicThemeContext } from "./DynamicThemeContext";

/**
 * Returns the active Material 3 color palette. When wrapped in
 * <DynamicThemeProvider> (the default), this is the wallpaper-derived Material
 * You palette (Android 12+) with a teal fallback. Outside a provider it falls
 * back to the static teal palette by color scheme. Use for inline-style/JS
 * color needs so screens theme correctly instead of hardcoding a scheme.
 */
export function useThemeColors(): ThemeColors & { isDark: boolean } {
  const ctx = useDynamicThemeContext();
  const { colorScheme } = useColorScheme();
  if (ctx) return ctx;
  const isDark = colorScheme === "dark";
  const colors = isDark ? darkColors : lightColors;
  return { ...colors, isDark };
}
