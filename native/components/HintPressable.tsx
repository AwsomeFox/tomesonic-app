import React, { forwardRef } from "react";
import { Platform, Pressable, PressableProps, ToastAndroid, View } from "react-native";
import { haptic } from "../utils/haptics";

/**
 * Drop-in Pressable that gives every BUTTON (accessibilityRole="button"):
 *   - a haptic tap on press-in (respects the Settings intensity, incl. off)
 *   - a long-press hint toast with the button's accessibility label —
 *     the standard Android affordance for icon-only buttons
 *
 * Non-button pressables (scrims, rows without a role, propagation stoppers)
 * pass through untouched, so files can swap their Pressable import wholesale.
 * A button that defines its own onLongPress keeps that behavior (no toast).
 */
const HintPressable = forwardRef<View, PressableProps & { hint?: string }>(
  ({ hint, onPressIn, onLongPress, ...props }, ref) => {
    const isButton = props.accessibilityRole === "button";
    const label =
      hint || (typeof props.accessibilityLabel === "string" ? props.accessibilityLabel : undefined);

    return (
      <Pressable
        ref={ref}
        {...props}
        onPressIn={(e) => {
          if (isButton && !props.disabled) haptic();
          onPressIn?.(e);
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
