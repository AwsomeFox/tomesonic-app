/**
 * StatusChip — small status pill. The label ALWAYS renders (never color-only
 * status), each tone maps to its theme container pair, and the optional dot
 * renders only when asked for.
 *
 * One render per test: RNTL v14's async act gets confused by repeated
 * render/unmount cycles inside a single test body.
 */
import React from "react";
import { StyleSheet } from "react-native";
import { render, screen } from "@testing-library/react-native";
import StatusChip, { StatusChipTone } from "../../components/StatusChip";
import { useThemeColors } from "../../theme/useThemeColors";

// Capture the live theme so color assertions don't hardcode a palette.
let colors: any;
function ThemeProbe() {
  colors = useThemeColors();
  return null;
}

const renderChip = async (tone: StatusChipTone, dot?: boolean) =>
  render(
    <>
      <ThemeProbe />
      <StatusChip label={`${tone} label`} tone={tone} dot={dot} />
    </>
  );

// tone → [container color key, on-container color key]
const TONE_COLORS: Array<[StatusChipTone, string, string]> = [
  ["success", "primaryContainer", "onPrimaryContainer"],
  ["info", "secondaryContainer", "onSecondaryContainer"],
  ["warning", "tertiaryContainer", "onTertiaryContainer"],
  ["error", "errorContainer", "onErrorContainer"],
  ["neutral", "surfaceContainerHighest", "onSurfaceVariant"],
];

describe("StatusChip", () => {
  it.each(TONE_COLORS)(
    "tone %s renders the label (never color-only) in its container colors",
    async (tone, bgKey, fgKey) => {
      await renderChip(tone);

      // The label text always renders — tone color is reinforcement only.
      const label = screen.getByText(`${tone} label`);
      expect(StyleSheet.flatten(label.props.style).color).toBe(colors[fgKey]);

      const pill = StyleSheet.flatten(screen.getByTestId("status-chip").props.style);
      expect(pill.backgroundColor).toBe(colors[bgKey]);
    }
  );

  it("tones are visually distinct from each other", async () => {
    await renderChip("success");
    const keys = TONE_COLORS.map(([, bgKey]) => colors[bgKey]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("renders the leading dot when dot is set", async () => {
    await renderChip("success", true);
    expect(screen.getByTestId("status-chip-dot")).toBeTruthy();
    expect(screen.getByText("success label")).toBeTruthy();
  });

  it("omits the dot by default", async () => {
    await renderChip("success");
    expect(screen.queryByTestId("status-chip-dot")).toBeNull();
  });

  it("exposes the label as the chip's accessible name", async () => {
    await renderChip("error");
    expect(screen.getByLabelText("error label")).toBeTruthy();
  });
});
