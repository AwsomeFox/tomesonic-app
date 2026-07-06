import React, { useEffect, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Modal,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
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
  // Keep the Modal mounted through the exit animation.
  const [mounted, setMounted] = useState(visible);
  const backdrop = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(windowHeight)).current;

  useEffect(() => {
    if (visible) {
      setMounted(true);
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
          toValue: windowHeight,
          duration: 200,
          // M3 emphasized-accelerate.
          easing: Easing.bezier(0.3, 0, 0.8, 0.15),
          useNativeDriver: true,
        }),
      ]).start(({ finished }) => {
        if (finished) setMounted(false);
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
        <Pressable
          accessibilityLabel="Dismiss"
          onPress={onClose}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>

      {/* Sheet: the only thing that slides. */}
      <View style={{ flex: 1, justifyContent: "flex-end" }} pointerEvents="box-none">
        <Animated.View
          style={{
            transform: [{ translateY }],
            backgroundColor: colors.surfaceContainerHigh,
            borderTopLeftRadius: 28,
            borderTopRightRadius: 28,
            paddingTop: 12,
            maxHeight,
          }}
        >
          <SafeAreaView edges={["bottom"]}>
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
          </SafeAreaView>
        </Animated.View>
      </View>
    </Modal>
  );
}
