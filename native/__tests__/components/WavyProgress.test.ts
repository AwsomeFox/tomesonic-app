/**
 * WavyProgress — clampedPeakAmp, the pure amplitude clamp behind the wavy
 * progress indicator. The wave's stroke is drawn centered on height/2, so the
 * peak amplitude may never exceed (height - strokeWidth) / 2 or the stroke
 * clips the SVG's top/bottom edges; and it may never go negative even for
 * degenerate heights.
 */
import { clampedPeakAmp } from "../../components/WavyProgress";

describe("clampedPeakAmp", () => {
  const STROKE = 4;
  const ceiling = (height: number, strokeWidth: number) => (height - strokeWidth) / 2;

  it("never exceeds (height - strokeWidth) / 2 across heights 8..40 (default amplitude)", () => {
    for (let height = 8; height <= 40; height++) {
      const amp = clampedPeakAmp(height, STROKE);
      expect(amp).toBeLessThanOrEqual(ceiling(height, STROKE));
      expect(amp).toBeGreaterThanOrEqual(0);
    }
  });

  it("clamps an oversized explicit amplitude to the ceiling across heights 8..40", () => {
    for (let height = 8; height <= 40; height++) {
      const amp = clampedPeakAmp(height, STROKE, 1000);
      expect(amp).toBe(ceiling(height, STROKE));
    }
  });

  it("defaults to 1px inside the ceiling", () => {
    // height 18, stroke 4 → ceiling 7, default 6 (the component's defaults).
    expect(clampedPeakAmp(18, 4)).toBe(6);
    expect(clampedPeakAmp(40, 4)).toBe(17);
  });

  it("respects a small explicit amplitude unchanged", () => {
    expect(clampedPeakAmp(18, 4, 2)).toBe(2);
    expect(clampedPeakAmp(40, 4, 0)).toBe(0);
  });

  it("respects the floor: a negative explicit amplitude clamps to 0", () => {
    expect(clampedPeakAmp(18, 4, -5)).toBe(0);
  });

  it("degenerate height <= strokeWidth stays non-negative (flat wave, no clipping)", () => {
    expect(clampedPeakAmp(4, 4)).toBe(0); // default would be -1 → floored
    expect(clampedPeakAmp(2, 4)).toBe(0); // negative ceiling → floored
    expect(clampedPeakAmp(0, 4)).toBe(0);
    expect(clampedPeakAmp(3, 4, 10)).toBe(0); // explicit amp can't beat a negative ceiling
  });
});
