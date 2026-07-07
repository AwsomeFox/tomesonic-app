import React, { useEffect, useRef, useState } from "react";
import {
  Animated,
  Easing,
  KeyboardAvoidingView,
  Modal,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColors } from "../theme/useThemeColors";

/**
 * Shared bottom sheet. Every options modal used RN Modal with
 * animationType="slide", which slides the WHOLE content view — including the
 * full-screen dim backdrop — up with the sheet. Here the Modal itself doesn't
 * animate; the backdrop FADES in place while only the sheet translates, the
 * standard M3 bottom-sheet motion.
 */
export default function BottomSheet({
  visible,
  onClose,
  children,
  maxHeight = "80%",
  showHandle = true,
  hideBackdrop = false,
  testID,
}: {
  visible: boolean;
  onClose: () => void;
  children: React.ReactNode;
  maxHeight?: number | `${number}%`;
  showHandle?: boolean;
  /** Transparent scrim (e.g. chapters list over the reader). */
  hideBackdrop?: boolean;
  testID?: string;
}) {
  const colors = useThemeColors();
  const { height: windowHeight } = useWindowDimensions();
  // The open/close effect keys on `visible` only (re-running on height
  // changes would replay the enter animation mid-display), so it reads the
  // height through an always-current ref instead of a stale closure.
  const windowHeightRef = useRef(windowHeight);
  windowHeightRef.current = windowHeight;
  // Root-provider insets via the hook: the native SafeAreaView computes its
  // OWN window inside a Modal and comes back 0 on Android edge-to-edge,
  // clipping sheet content under the gesture bar.
  const insets = useSafeAreaInsets();
  // Keep the Modal mounted through the exit animation.
  const [mounted, setMounted] = useState(visible);
  // A reopen interrupts the close animation (finished=false), but a close
  // that COMPLETES in the same instant can deliver finished=true after the
  // reopen effect already ran — unmounting a sheet that should be open, with
  // no later effect to remount it. The completion handler re-checks the
  // current `visible` through this ref.
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const backdrop = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(windowHeight)).current;

  useEffect(() => {
    if (visible) {
      setMounted(true);
      // translateY is created once from the mount-time window height; after a
      // rotation/split-screen resize that offset is stale, so re-anchor to the
      // CURRENT height so every open starts fully off-screen.
      translateY.setValue(windowHeightRef.current);
      Animated.parallel([
        Animated.timing(backdrop, {
          toValue: 1,
          duration: 180,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(translateY, {
          toValue: 0,
          duration: 280,
          // M3 emphasized-decelerate.
          easing: Easing.bezier(0.05, 0.7, 0.1, 1),
          useNativeDriver: true,
        }),
      ]).start();
    } else if (mounted) {
      Animated.parallel([
        Animated.timing(backdrop, {
          toValue: 0,
          duration: 160,
          easing: Easing.in(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(translateY, {
          toValue: windowHeightRef.current,
          duration: 200,
          // M3 emphasized-accelerate.
          easing: Easing.bezier(0.3, 0, 0.8, 0.15),
          useNativeDriver: true,
        }),
      ]).start(({ finished }) => {
        if (finished && !visibleRef.current) setMounted(false);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  if (!mounted) return null;

  return (
    <Modal
      visible
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={onClose}
      testID={testID}
    >
      {/* Backdrop: fades in place, never moves. */}
      <Animated.View
        pointerEvents="auto"
        style={[
          StyleSheet.absoluteFill,
          {
            backgroundColor: hideBackdrop ? "transparent" : "rgba(0,0,0,0.45)",
            opacity: backdrop,
          },
        ]}
      >
        {/* Tap-to-dismiss stays, but out of the TalkBack swipe order — it used
            to be the FIRST focused element, forcing a swipe past "Dismiss"
            before reaching any real option. onRequestClose (hardware back) and
            the sheet's own close controls cover screen-reader dismissal. */}
        <Pressable
          testID="sheet-backdrop"
          // Drop the backdrop from the screen-reader focus order while keeping
          // tap-to-dismiss — it used to be the first element focused, before any
          // real option. importantForAccessibility is Android-only, so pair it
          // with accessible={false} + accessibilityElementsHidden for iOS/VoiceOver.
          importantForAccessibility="no"
          accessible={false}
          accessibilityElementsHidden
          onPress={onClose}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>

      {/* Sheet: the only thing that slides. KeyboardAvoidingView because a
          statusBarTranslucent Modal opts out of adjustResize — without it the
          keyboard covers any inputs in the sheet (e.g. the RMAB connect
          form). */}
      <KeyboardAvoidingView
        behavior="padding"
        style={{ flex: 1, justifyContent: "flex-end" }}
        pointerEvents="box-none"
      >
        <Animated.View
          // Modal isolation: TalkBack focus stays within the sheet content
          // instead of bleeding into the screen behind it.
          accessibilityViewIsModal
          style={{
            transform: [{ translateY }],
            backgroundColor: colors.surfaceContainerHigh,
            borderTopLeftRadius: 28,
            borderTopRightRadius: 28,
            paddingTop: 12,
            maxHeight,
          }}
        >
          <View style={{ paddingBottom: Math.max(insets.bottom, 12) }}>
            {showHandle ? (
              <View
                style={{
                  alignSelf: "center",
                  width: 36,
                  height: 4,
                  borderRadius: 2,
                  backgroundColor: colors.outlineVariant,
                  marginBottom: 8,
                }}
              />
            ) : null}
            {children}
          </View>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
