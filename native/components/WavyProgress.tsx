import React, { useEffect, useState } from "react";
import { View } from "react-native";
import Svg, { Path, Circle } from "react-native-svg";
import Animated, {
  useSharedValue,
  useAnimatedProps,
  withRepeat,
  withTiming,
  withSpring,
  cancelAnimation,
  Easing,
  useReducedMotion,
} from "react-native-reanimated";
import { SPATIAL_SLOW } from "../theme/motion";

const AnimatedPath = Animated.createAnimatedComponent(Path);

// M3 Expressive wavy linear progress: the played portion is a scrolling sine
// wave (amplitude springs to flat when paused), the remainder is a flat track
// separated by a small gap, with a stop dot at the far end. Read-only — for
// seeking use the slider-style scrubber, per Material guidance.
const WAVELENGTH = 40; // dp, M3 spec for linear wavy indicators
const GAP = 5; // dp between active indicator and track
const STOP_R = 2.5; // stop-indicator dot radius

export default function WavyProgress({
  progress, // 0..1
  playing,
  color,
  trackColor,
  height = 18,
  strokeWidth = 4,
  amplitude,
  wavelength = WAVELENGTH,
  showStopDot = true,
  flattenWhenPaused = false,
  showHandle = false,
  handleActive = false,
}: {
  progress: number;
  playing: boolean;
  color: string;
  trackColor: string;
  height?: number;
  strokeWidth?: number;
  amplitude?: number; // peak wave height in px; defaults to fill the height
  wavelength?: number;
  showStopDot?: boolean;
  flattenWhenPaused?: boolean; // settle to a clean flat line while paused
  showHandle?: boolean; // draw a slider handle at the played-position boundary
  handleActive?: boolean; // enlarge the handle (while dragging)
}) {
  const [width, setWidth] = useState(0);
  // Honor the OS "reduce motion" setting: hold the wave static (no scrolling
  // phase, no amplitude spring) instead of the endless animation.
  const reduceMotion = useReducedMotion();
  const phase = useSharedValue(0);
  const amp = useSharedValue(0);
  const progressShared = useSharedValue(0);
  const widthShared = useSharedValue(0);

  useEffect(() => {
    progressShared.value = progress || 0;
  }, [progress]);

  useEffect(() => {
    widthShared.value = width || 0;
  }, [width]);

  // Peak amplitude, clamped so the stroke never clips the SVG edges.
  const peakAmp = Math.max(
    0,
    Math.min(amplitude ?? (height - strokeWidth) / 2 - 1, (height - strokeWidth) / 2)
  );

  useEffect(() => {
    // The wave only scrolls while playing so the bar reads as "alive" during
    // playback and calm when paused. When reduced motion is on, never start the
    // endless phase scroll — hold the wave static.
    if (playing && !reduceMotion) {
      phase.value = withRepeat(withTiming(phase.value + 1, { duration: 1000, easing: Easing.linear }), -1, false);
    } else {
      cancelAnimation(phase);
    }
    // Cancel on unmount too, so the infinite repeat can't outlive the component
    // (e.g. the player closing mid-playback).
    return () => {
      cancelAnimation(phase);
      cancelAnimation(amp);
    };
  }, [playing, reduceMotion]);

  useEffect(() => {
    // Wave rises to full amplitude while playing; if flattenWhenPaused it settles
    // to a clean straight line when paused (avoids a lumpy frozen squiggle).
    // Under reduced motion, snap straight to the target instead of springing.
    const target = flattenWhenPaused && !playing ? 0 : peakAmp;
    amp.value = reduceMotion ? target : withSpring(target, SPATIAL_SLOW);
  }, [peakAmp, playing, flattenWhenPaused, reduceMotion]);

  const cy = height / 2;
  const clamped = Math.max(0, Math.min(1, progress || 0));
  const endX = Math.max(0, (width - STOP_R * 2) * clamped);
  // Track ends short of the stop dot when shown; otherwise (scrubber mode,
  // where the handle is the end marker) it runs to the full width so the bar
  // lines up with the timestamps above it.
  const trackEndX = showStopDot ? width - STOP_R * 3 : width - strokeWidth / 2;

  const waveProps = useAnimatedProps(() => {
    "worklet";
    const w = widthShared.value;
    const cl = Math.max(0, Math.min(1, progressShared.value));
    const currentEndX = Math.max(0, (w - STOP_R * 2) * cl);

    if (currentEndX <= 0) return { d: `M 0 ${cy}` };
    const a = amp.value;
    const ph = phase.value;
    let d = "";
    const step = 1.5;
    for (let x = 0; x <= currentEndX; x += step) {
      const y = cy + a * Math.sin((x / wavelength + ph) * Math.PI * 2);
      d += (x === 0 ? "M " : "L ") + x.toFixed(2) + " " + y.toFixed(2);
    }
    return { d };
  });

  return (
    <View style={{ height }} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      {width > 0 ? (
        <Svg width={width} height={height}>
          {/* Flat remainder track (starts after a gap from the wave). */}
          {endX + GAP < trackEndX ? (
            <Path
              d={`M ${endX + GAP} ${cy} L ${trackEndX} ${cy}`}
              stroke={trackColor}
              strokeWidth={strokeWidth}
              strokeLinecap="round"
              fill="none"
            />
          ) : null}
          {/* Stop indicator dot at the very end. */}
          {showStopDot ? <Circle cx={width - STOP_R} cy={cy} r={STOP_R} fill={color} /> : null}
          {/* Wavy active indicator. */}
          <AnimatedPath
            animatedProps={waveProps}
            stroke={color}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            fill="none"
          />
        </Svg>
      ) : null}
      {/* Slider handle, pinned to the exact played-position boundary so it can
          never drift from the wave (same `endX` the wave is drawn to). */}
      {showHandle && width > 0 ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: cy - (handleActive ? 15 : 13),
            left: endX - (handleActive ? 3.5 : 2.5),
            width: handleActive ? 7 : 5,
            height: handleActive ? 30 : 26,
            borderRadius: 4,
            backgroundColor: color,
          }}
        />
      ) : null}
    </View>
  );
}
