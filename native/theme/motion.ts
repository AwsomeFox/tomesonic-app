import { Easing, FadeInDown, FadeInRight } from "react-native-reanimated";

// Material 3 Expressive motion tokens (motion.springs.*), expressed as
// reanimated spring configs. Spatial springs move things (position/size/shape)
// and are allowed a little bounce; effect springs animate color/opacity and
// must not overshoot. Use these instead of ad-hoc damping/stiffness values so
// the whole app shares one motion personality.
// Reanimated's physics springs take damping (not dampingRatio); these values
// encode M3's ratios via damping = ratio * 2 * sqrt(stiffness), mass = 1.
export const SPATIAL_FAST = { damping: 67, stiffness: 1400 } as const; // ratio 0.9
export const SPATIAL_DEFAULT = { damping: 48, stiffness: 700 } as const; // ratio 0.9
export const SPATIAL_SLOW = { damping: 31, stiffness: 300 } as const; // ratio 0.9
// Extra-bouncy variant for playful, user-initiated moments (button presses).
export const SPATIAL_EXPRESSIVE = { damping: 34, stiffness: 800 } as const; // ratio 0.6

export const EFFECT_FAST = { damping: 123, stiffness: 3800, overshootClamping: true } as const;
export const EFFECT_DEFAULT = { damping: 80, stiffness: 1600, overshootClamping: true } as const;

// M3 emphasized easing — for timing-based (non-spring) transitions.
export const EMPHASIZED = Easing.bezier(0.2, 0, 0, 1);
export const EMPHASIZED_ACCELERATE = Easing.bezier(0.3, 0, 0.8, 0.15);
export const EMPHASIZED_DECELERATE = Easing.bezier(0.05, 0.7, 0.1, 1);

// --- Shared list-entrance recipes -------------------------------------------
// Every screen uses ONE of these two so entrances feel like one app:
// - Horizontal shelf cards slide in from the right (along the scroll axis)
//   with the M3 slow spatial spring.
// - Vertical list/grid rows fade-slide down with a short stagger.
// The stagger is capped: only the first screenful cascades, everything past
// it appears together (an uncapped `index * delay` makes late rows feel slow).
export const listRowEnter = (index: number) =>
  FadeInDown.delay(Math.min(index * 40, 300)).duration(250);
export const shelfCardEnter = (index: number) =>
  FadeInRight.delay(Math.min(index * 50, 300))
    .springify()
    .damping(SPATIAL_SLOW.damping)
    .stiffness(SPATIAL_SLOW.stiffness);
