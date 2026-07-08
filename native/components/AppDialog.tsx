import React from "react";
import { View, Text, Pressable, Modal } from "react-native";
import { useThemeColors } from "../theme/useThemeColors";
import { withAlpha } from "../theme/palette";
import { useDialogStore, AppDialogButton } from "../store/useDialogStore";

/**
 * Material 3 dialog host — the themed replacement for native Alert.alert. Mount
 * once at the top of AppShell (last child = topmost). It renders nothing until
 * showAppDialog() sets a dialog, then shows an M3 basic dialog: a scrim, a 28dp
 * rounded surfaceContainerHigh container, a headline + supporting text, and a
 * trailing row of text buttons (destructive actions use the error color).
 *
 * The whole thing lives inside a transparent RN <Modal> so it renders in its
 * own window above the app root — otherwise a dialog raised from within a
 * bottom sheet (BottomSheet / BookmarksModal both use RN Modal) would be hidden
 * behind that sheet's separate window. onRequestClose handles hardware back.
 */
export default function AppDialog() {
  const colors = useThemeColors();
  const dialog = useDialogStore((s) => s.current);
  const dismiss = useDialogStore((s) => s.dismiss);

  if (!dialog) return null;

  const onButton = (b: AppDialogButton) => {
    dismiss();
    b.onPress?.();
  };

  const buttonColor = (b: AppDialogButton) =>
    b.style === "destructive" ? colors.error : colors.primary;

  // Hardware back / gesture: dismiss when cancelable, otherwise swallow so back
  // can't fall through to the navigator underneath.
  const onRequestClose = () => {
    if (dialog.cancelable !== false) dismiss();
  };

  return (
    <Modal
      transparent
      visible
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onRequestClose}
    >
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          paddingHorizontal: 24,
        }}
      >
        {/* Scrim — tap to dismiss when cancelable. */}
        <Pressable
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          onPress={() => {
            if (dialog.cancelable !== false) dismiss();
          }}
          style={{
            ...({ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 } as const),
            backgroundColor: "rgba(0, 0, 0, 0.5)",
          }}
        />
        <View
          accessibilityViewIsModal
          style={{
            width: "100%",
            maxWidth: 360,
            backgroundColor: colors.surfaceContainerHigh,
            borderRadius: 28,
            paddingTop: 24,
            paddingHorizontal: 24,
            paddingBottom: 18,
            elevation: 6,
          }}
        >
        {dialog.title ? (
          <Text
            accessibilityRole="header"
            style={{ color: colors.onSurface, fontSize: 22, fontWeight: "500", marginBottom: dialog.message ? 12 : 20 }}
          >
            {dialog.title}
          </Text>
        ) : null}
        {dialog.message ? (
          <Text style={{ color: colors.onSurfaceVariant, fontSize: 15, lineHeight: 21, marginBottom: 20 }}>
            {dialog.message}
          </Text>
        ) : null}
        <View style={{ flexDirection: "row", justifyContent: "flex-end", flexWrap: "wrap" }}>
          {dialog.buttons.map((b, i) => (
            <Pressable
              key={`${b.text}-${i}`}
              onPress={() => onButton(b)}
              accessibilityRole="button"
              accessibilityLabel={b.text}
              android_ripple={{ color: withAlpha(buttonColor(b), 0.14), borderless: false }}
              style={{ marginLeft: 8, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 20, overflow: "hidden" }}
            >
              <Text style={{ color: buttonColor(b), fontSize: 14, fontWeight: "600" }}>{b.text}</Text>
            </Pressable>
          ))}
          </View>
        </View>
      </View>
    </Modal>
  );
}
