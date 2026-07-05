// Material 3 color palettes mirrored from global.css so that JS-side (inline
// style) code can be theme-aware without hardcoding a single scheme.
// Keep these in sync with the CSS variables in ../global.css.

export interface ThemeColors {
  primary: string;
  onPrimary: string;
  primaryContainer: string;
  onPrimaryContainer: string;
  secondary: string;
  onSecondary: string;
  secondaryContainer: string;
  onSecondaryContainer: string;
  tertiary: string;
  tertiaryContainer: string;
  onTertiaryContainer: string;
  error: string;
  onError: string;
  errorContainer: string;
  onErrorContainer: string;
  surface: string;
  onSurface: string;
  surfaceVariant: string;
  onSurfaceVariant: string;
  surfaceDim: string;
  surfaceBright: string;
  surfaceContainerLowest: string;
  surfaceContainerLow: string;
  surfaceContainer: string;
  surfaceContainerHigh: string;
  surfaceContainerHighest: string;
  outline: string;
  outlineVariant: string;
  inverseSurface: string;
  inverseOnSurface: string;
  inversePrimary: string;
  // Colors used for text/icons overlaid on media artwork
  onMedia: string;
  onMediaVariant: string;
  // App-specific accents
  success: string;
}

const rgb = (r: number, g: number, b: number) => `rgb(${r}, ${g}, ${b})`;

// TEAL / pine-green Material 3 scheme (SchemeTonalSpot, seed #1E5F50) — mirrors the
// original app's Material You palette (wallpaper-seeded teal, brand-teal fallback).
// NOT the M3 baseline purple. See DESIGN_SPEC/00-visual-reference.md. Regenerate via
// material-color-utilities if the seed changes.
export const lightColors: ThemeColors = {
  primary: rgb(13, 107, 88),
  onPrimary: rgb(255, 255, 255),
  primaryContainer: rgb(161, 242, 219),
  onPrimaryContainer: rgb(0, 81, 66),
  secondary: rgb(75, 99, 92),
  onSecondary: rgb(255, 255, 255),
  secondaryContainer: rgb(205, 233, 222),
  onSecondaryContainer: rgb(51, 76, 68),
  tertiary: rgb(66, 98, 119),
  tertiaryContainer: rgb(198, 231, 255),
  onTertiaryContainer: rgb(41, 74, 94),
  error: rgb(186, 26, 26),
  onError: rgb(255, 255, 255),
  errorContainer: rgb(255, 218, 214),
  onErrorContainer: rgb(147, 0, 10),
  surface: rgb(245, 251, 247),
  onSurface: rgb(23, 29, 27),
  surfaceVariant: rgb(219, 229, 224),
  onSurfaceVariant: rgb(63, 73, 69),
  surfaceDim: rgb(213, 219, 216),
  surfaceBright: rgb(245, 251, 247),
  surfaceContainerLowest: rgb(255, 255, 255),
  surfaceContainerLow: rgb(239, 245, 241),
  surfaceContainer: rgb(233, 239, 235),
  surfaceContainerHigh: rgb(227, 234, 230),
  surfaceContainerHighest: rgb(222, 228, 224),
  outline: rgb(111, 121, 117),
  outlineVariant: rgb(191, 201, 196),
  inverseSurface: rgb(43, 50, 47),
  inverseOnSurface: rgb(236, 242, 238),
  inversePrimary: rgb(134, 214, 191),
  onMedia: rgb(255, 255, 255),
  onMediaVariant: rgb(222, 228, 224),
  success: rgb(76, 175, 80),
};

export const darkColors: ThemeColors = {
  primary: rgb(134, 214, 191),
  onPrimary: rgb(0, 56, 45),
  primaryContainer: rgb(0, 81, 66),
  onPrimaryContainer: rgb(161, 242, 219),
  secondary: rgb(178, 204, 195),
  onSecondary: rgb(29, 53, 46),
  secondaryContainer: rgb(51, 76, 68),
  onSecondaryContainer: rgb(205, 233, 222),
  tertiary: rgb(169, 203, 227),
  tertiaryContainer: rgb(41, 74, 94),
  onTertiaryContainer: rgb(198, 231, 255),
  error: rgb(255, 180, 171),
  onError: rgb(105, 0, 5),
  errorContainer: rgb(147, 0, 10),
  onErrorContainer: rgb(255, 218, 214),
  surface: rgb(15, 21, 19),
  onSurface: rgb(222, 228, 224),
  surfaceVariant: rgb(63, 73, 69),
  onSurfaceVariant: rgb(191, 201, 196),
  surfaceDim: rgb(15, 21, 19),
  surfaceBright: rgb(52, 59, 56),
  surfaceContainerLowest: rgb(9, 15, 13),
  surfaceContainerLow: rgb(23, 29, 27),
  surfaceContainer: rgb(27, 33, 31),
  surfaceContainerHigh: rgb(37, 43, 41),
  surfaceContainerHighest: rgb(48, 54, 52),
  outline: rgb(137, 147, 143),
  outlineVariant: rgb(63, 73, 69),
  inverseSurface: rgb(222, 228, 224),
  inverseOnSurface: rgb(43, 50, 47),
  inversePrimary: rgb(13, 107, 88),
  onMedia: rgb(255, 255, 255),
  onMediaVariant: rgb(222, 228, 224),
  success: rgb(76, 175, 80),
};

/** Returns an rgba() string for a palette color at a given opacity. */
export function withAlpha(rgbColor: string, alpha: number): string {
  const m = rgbColor.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (!m) return rgbColor;
  return `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${alpha})`;
}
