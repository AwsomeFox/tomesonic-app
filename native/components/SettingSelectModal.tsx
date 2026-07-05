import React from "react";
import { View, Text, Modal, Pressable, ScrollView } from "react-native";
import { useThemeColors } from "../theme/useThemeColors";
import Icon from "./Icon";

export interface SelectOption {
  label: string;
  value: any;
}

// Material-style single-choice bottom sheet used by the Settings dropdowns.
export default function SettingSelectModal({
  visible,
  title,
  options,
  selected,
  onSelect,
  onClose,
}: {
  visible: boolean;
  title: string;
  options: SelectOption[];
  selected: any;
  onSelect: (value: any) => void;
  onClose: () => void;
}) {
  const colors = useThemeColors();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" }}
      >
        <Pressable
          onPress={(e) => e.stopPropagation()}
          style={{
            backgroundColor: colors.surfaceContainerHigh,
            borderTopLeftRadius: 28,
            borderTopRightRadius: 28,
            paddingTop: 12,
            paddingBottom: 32,
            maxHeight: "70%",
          }}
        >
          <View style={{ alignItems: "center", paddingBottom: 8 }}>
            <View style={{ width: 32, height: 4, borderRadius: 2, backgroundColor: colors.outlineVariant }} />
          </View>
          <Text
            style={{
              color: colors.onSurface,
              fontSize: 20,
              fontWeight: "600",
              paddingHorizontal: 24,
              paddingVertical: 12,
            }}
          >
            {title}
          </Text>
          <ScrollView>
            {options.map((opt) => {
              const isSel = opt.value === selected;
              return (
                <Pressable
                  key={String(opt.value)}
                  onPress={() => {
                    onSelect(opt.value);
                    onClose();
                  }}
                  android_ripple={{ color: colors.surfaceContainerHighest }}
                  accessibilityRole="radio"
                  accessibilityLabel={opt.label}
                  accessibilityState={{ checked: isSel }}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    paddingVertical: 16,
                    paddingHorizontal: 24,
                  }}
                >
                  <Text style={{ flex: 1, color: colors.onSurface, fontSize: 17 }}>{opt.label}</Text>
                  {isSel ? <Icon name="check" size={22} color={colors.primary} /> : null}
                </Pressable>
              );
            })}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
