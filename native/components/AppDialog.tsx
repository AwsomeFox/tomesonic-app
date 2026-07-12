import React, { useEffect, useRef, useState } from "react";
import { View, Text, TextInput, Pressable, Modal, Platform, AccessibilityInfo, findNodeHandle } from "react-native";
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

  // On open, move screen-reader focus onto the dialog and announce it.
  // accessibilityViewIsModal is iOS-only, so on Android nothing would grab
  // TalkBack focus or announce the dialog otherwise — mirror the
  // setAccessibilityFocus pattern the PlayerBottomSheet uses on expand.
  const titleRef = useRef<Text>(null);
  const containerRef = useRef<View>(null);

  // Typed-confirm input value, keyed to the dialog it was typed into (the
  // derive-on-render reset pattern, no effect): a previous dialog's text can
  // never pre-satisfy the next confirmation.
  const [typed, setTyped] = useState<{ dialog: unknown; text: string }>({ dialog: null, text: "" });
  const confirmText = typed.dialog === dialog ? typed.text : "";
  const setConfirmText = (text: string) => setTyped({ dialog, text });

  useEffect(() => {
    if (!dialog) return;
    const t = setTimeout(() => {
      if (Platform.OS === "android") {
        const node = findNodeHandle(titleRef.current) ?? findNodeHandle(containerRef.current);
        if (node != null) AccessibilityInfo.setAccessibilityFocus(node);
      }
      const announcement = [dialog.title, dialog.message].filter(Boolean).join(". ");
      if (announcement) AccessibilityInfo.announceForAccessibility(announcement);
    }, 50);
    return () => clearTimeout(t);
  }, [dialog]);

  if (!dialog) return null;

  // Typed-confirm gate: the LAST button (destructive/confirm by convention)
  // stays disabled until the input matches requiredText. Case-insensitive
  // unless caseSensitive is set.
  const confirmInput = dialog.confirmInput;
  const confirmMatched =
    !confirmInput ||
    (confirmInput.caseSensitive
      ? confirmText === confirmInput.requiredText
      : confirmText.toLowerCase() === confirmInput.requiredText.toLowerCase());
  const isButtonDisabled = (i: number) =>
    !!confirmInput && !confirmMatched && i === dialog.buttons.length - 1;

  const onButton = (b: AppDialogButton, i: number) => {
    if (isButtonDisabled(i)) return;
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
      testID="app-dialog-modal"
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
          testID="app-dialog-scrim"
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
          ref={containerRef}
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
            ref={titleRef}
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
        {confirmInput ? (
          <TextInput
            testID="app-dialog-confirm-input"
            value={confirmText}
            onChangeText={setConfirmText}
            placeholder={confirmInput.placeholder}
            placeholderTextColor={colors.onSurfaceVariant}
            accessibilityLabel={`Type ${confirmInput.requiredText} to confirm`}
            autoCapitalize="none"
            autoCorrect={false}
            style={{
              color: colors.onSurface,
              fontSize: 15,
              borderWidth: 1,
              borderColor: colors.outline,
              borderRadius: 8,
              paddingHorizontal: 12,
              paddingVertical: 10,
              marginBottom: 20,
              backgroundColor: colors.surfaceContainerHighest,
            }}
          />
        ) : null}
        <View style={{ flexDirection: "row", justifyContent: "flex-end", flexWrap: "wrap" }}>
          {dialog.buttons.map((b, i) => {
            const disabled = isButtonDisabled(i);
            return (
              <Pressable
                key={`${b.text}-${i}`}
                onPress={() => onButton(b, i)}
                accessibilityRole="button"
                accessibilityLabel={b.text}
                accessibilityState={{ disabled }}
                hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
                android_ripple={{ color: withAlpha(buttonColor(b), 0.14), borderless: false }}
                style={{
                  marginLeft: 8,
                  paddingVertical: 10,
                  paddingHorizontal: 12,
                  borderRadius: 20,
                  overflow: "hidden",
                  opacity: disabled ? 0.5 : 1,
                }}
              >
                <Text style={{ color: buttonColor(b), fontSize: 14, fontWeight: "600" }}>{b.text}</Text>
              </Pressable>
            );
          })}
          </View>
        </View>
      </View>
    </Modal>
  );
}
