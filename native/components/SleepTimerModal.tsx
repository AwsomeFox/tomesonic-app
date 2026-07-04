import React, { useEffect, useState } from "react";
import { View, Text, Pressable, Modal } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useThemeColors } from "../theme/useThemeColors";
import Icon from "./Icon";

const TIMEOUTS = [5, 10, 15, 30, 45, 60];

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Active timer state from the store, or null when no timer is running. */
  timer: { endOfChapter: boolean; remaining: number } | null;
  /** Whether a current chapter exists (enables the End of chapter option). */
  hasChapter: boolean;
  onSet: (seconds: number, endOfChapter?: boolean) => void;
  onCancel: () => void;
}

function fmt(seconds: number) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

/**
 * Sleep timer bottom sheet. Mirrors the original SleepTimerModal.vue: preset
 * durations, End of chapter, and a Custom stepper. When a timer is active it
 * shows the remaining time with a cancel button.
 */
export default function SleepTimerModal({ visible, onClose, timer, hasChapter, onSet, onCancel }: Props) {
  const colors = useThemeColors();
  const [customMode, setCustomMode] = useState(false);
  const [customMin, setCustomMin] = useState(15);

  // Reset the custom sub-view whenever the sheet is reopened.
  useEffect(() => {
    if (visible) setCustomMode(false);
  }, [visible]);

  const rowStyle = {
    paddingVertical: 14,
    borderRadius: 16,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  };

  const renderBody = () => {
    // Active timer view
    if (timer) {
      return (
        <View style={{ paddingHorizontal: 24, paddingTop: 8, paddingBottom: 24 }}>
          <Text style={{ fontSize: 44, fontWeight: "600", color: colors.onSurface, textAlign: "center", marginVertical: 12 }}>
            {fmt(timer.remaining)}
          </Text>
          {timer.endOfChapter ? (
            <Text style={{ fontSize: 14, color: colors.onSurfaceVariant, textAlign: "center", marginBottom: 16 }}>
              End of chapter
            </Text>
          ) : null}
          <Pressable
            onPress={() => {
              onCancel();
              onClose();
            }}
            style={{ backgroundColor: colors.primary, borderRadius: 24, paddingVertical: 14, alignItems: "center" }}
          >
            <Text style={{ color: colors.onPrimary, fontSize: 16, fontWeight: "600" }}>Cancel Timer</Text>
          </Pressable>
        </View>
      );
    }

    // Custom stepper view
    if (customMode) {
      return (
        <View style={{ paddingHorizontal: 24, paddingTop: 8, paddingBottom: 24 }}>
          <Pressable onPress={() => setCustomMode(false)} style={{ marginBottom: 8, alignSelf: "flex-start", padding: 4 }}>
            <Icon name="back" size={26} color={colors.onSurface} />
          </Pressable>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginVertical: 12 }}>
            <Pressable
              onPress={() => setCustomMin((m) => Math.max(1, m - 1))}
              style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: colors.secondaryContainer, alignItems: "center", justifyContent: "center" }}
            >
              <Text style={{ fontSize: 24, color: colors.onSecondaryContainer, marginTop: -2 }}>−</Text>
            </Pressable>
            <Text style={{ fontSize: 28, fontWeight: "600", color: colors.onSurface }}>{customMin} min</Text>
            <Pressable
              onPress={() => setCustomMin((m) => m + 1)}
              style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: colors.secondaryContainer, alignItems: "center", justifyContent: "center" }}
            >
              <Text style={{ fontSize: 24, color: colors.onSecondaryContainer, marginTop: -2 }}>+</Text>
            </Pressable>
          </View>
          <Pressable
            onPress={() => {
              onSet(customMin * 60, false);
              onClose();
            }}
            style={{ backgroundColor: colors.primary, borderRadius: 24, paddingVertical: 14, alignItems: "center" }}
          >
            <Text style={{ color: colors.onPrimary, fontSize: 16, fontWeight: "600" }}>Set Timer</Text>
          </Pressable>
        </View>
      );
    }

    // Option list
    return (
      <View style={{ paddingHorizontal: 8, paddingBottom: 16 }}>
        {TIMEOUTS.map((min) => (
          <Pressable
            key={min}
            onPress={() => {
              onSet(min * 60, false);
              onClose();
            }}
            style={rowStyle}
          >
            <Text style={{ fontSize: 18, color: colors.onSurface }}>{min} min</Text>
          </Pressable>
        ))}
        {hasChapter ? (
          <Pressable
            onPress={() => {
              onSet(0, true);
              onClose();
            }}
            style={rowStyle}
          >
            <Text style={{ fontSize: 18, color: colors.onSurface }}>End of chapter</Text>
          </Pressable>
        ) : null}
        <Pressable onPress={() => setCustomMode(true)} style={rowStyle}>
          <Text style={{ fontSize: 18, color: colors.onSurface }}>Custom</Text>
        </Pressable>
      </View>
    );
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0, 0, 0, 0.4)" }} onPress={onClose}>
        <Pressable
          onPress={() => {}}
          style={{ backgroundColor: colors.surfaceContainerHigh, borderTopLeftRadius: 28, borderTopRightRadius: 28 }}
        >
          <SafeAreaView edges={["bottom"]}>
            <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 24, paddingTop: 20, paddingBottom: 12 }}>
              <Icon name="moon" size={24} color={colors.onSurface} style={{ marginRight: 12 }} />
              <Text style={{ flex: 1, fontSize: 22, fontWeight: "500", color: colors.onSurface }}>Sleep Timer</Text>
            </View>
            {renderBody()}
          </SafeAreaView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
