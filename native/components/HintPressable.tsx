import React, { forwardRef } from "react";
import { Platform, Pressable, PressableProps, ToastAndroid, View } from "react-native";
import { haptic } from "../utils/haptics";

/**
 * Drop-in Pressable that gives every BUTTON (accessibilityRole="button"):
 *   - a haptic tap on the COMPLETED press, not press-in — press-in fires on
 *     every touch-down, so scroll gestures over buttons buzzed constantly
 *     (respects the Settings intensity, incl. off)
 *   - a long-press hint toast with the button's accessibility label —
 *     the standard Android affordance for icon-only buttons
 *
 * Non-button pressables (scrims, rows without a role, propagation stoppers)
 * pass through untouched, so files can swap their Pressable import wholesale.
 * A button that defines its own onLongPress keeps that behavior (no toast).
 */
const HintPressable = forwardRef<View, PressableProps & { hint?: string }>(
  ({ hint, onPress, onLongPress, ...props }, ref) => {
    const isButton = props.accessibilityRole === "button";
    const label =
      hint || (typeof props.accessibilityLabel === "string" ? props.accessibilityLabel : undefined);

    return (
      <Pressable
        ref={ref}
        // Touch-down during a scroll gesture must not flash the ripple — delay
        // press-in feedback long enough for the scroll responder to claim the
        // gesture first.
        unstable_pressDelay={isButton ? 90 : undefined}
        {...props}
        onPress={(e) => {
          // Haptic on the COMPLETED press, not press-in: pressIn fires on
          // every touch-down, so scrolling across buttons buzzed constantly.
          if (isButton && !props.disabled) haptic();
          onPress?.(e);
        }}
        onLongPress={
          onLongPress ||
          (isButton && label
            ? () => {
                haptic();
                if (Platform.OS === "android") ToastAndroid.show(label, ToastAndroid.SHORT);
              }
            : undefined)
        }
      />
    );
  }
);

HintPressable.displayName = "HintPressable";
export default HintPressable;
