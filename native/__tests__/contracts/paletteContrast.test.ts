/**
 * WCAG AA contrast invariant over the static Material 3 palettes.
 *
 * theme/palette.ts is hand-mirrored from global.css (regenerated via
 * material-color-utilities when the seed changes) — nothing type-checks that a
 * retint keeps text readable. This pins the WCAG 2.x AA normal-text threshold
 * (contrast >= 4.5:1) for every on-X/X role pair the app renders text with,
 * in BOTH palettes.
 *
 * Current headroom (do not pin exact ratios — they may drift with a reseed;
 * only the 4.5 floor is the contract):
 *   - tightest pair: dark onSurfaceVariant/surfaceVariant ~= 5.5
 *   - everything else sits ~6.4 or higher
 * If a reseed lands a pair below 4.5, fix the palette, not this test.
 */
import { lightColors, darkColors, ThemeColors } from "../../theme/palette";

// --- WCAG 2.x relative luminance + contrast ratio (self-contained) ----------
// https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
function parseRgb(color: string): [number, number, number] {
  const m = color.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
  if (!m) throw new Error(`palette color is not an rgb(r, g, b) literal: ${color}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function relativeLuminance(color: string): number {
  const [r, g, b] = parseRgb(color).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// The on-X/X role pairs the app draws text/icons with.
const PAIRS: Array<[keyof ThemeColors, keyof ThemeColors]> = [
  ["onPrimary", "primary"],
  ["onPrimaryContainer", "primaryContainer"],
  ["onSecondaryContainer", "secondaryContainer"],
  ["onTertiaryContainer", "tertiaryContainer"],
  ["onError", "error"],
  ["onErrorContainer", "errorContainer"],
  ["onSurface", "surface"],
  ["onSurfaceVariant", "surfaceVariant"],
];

describe.each([
  ["lightColors", lightColors],
  ["darkColors", darkColors],
] as Array<[string, ThemeColors]>)("%s meets WCAG AA (>= 4.5:1) on every on-X/X pair", (_name, palette) => {
  it.each(PAIRS)("%s on %s", (fg, bg) => {
    const ratio = contrastRatio(palette[fg], palette[bg]);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it("every asserted role is a parseable rgb() literal (guards a format change breaking the math silently)", () => {
    for (const [fg, bg] of PAIRS) {
      expect(() => parseRgb(palette[fg])).not.toThrow();
      expect(() => parseRgb(palette[bg])).not.toThrow();
    }
  });
});
