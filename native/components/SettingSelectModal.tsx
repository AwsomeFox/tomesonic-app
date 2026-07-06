import React from "react";
import { View, Text, Pressable, ScrollView } from "react-native";
import { useThemeColors } from "../theme/useThemeColors";
import Icon from "./Icon";
import BottomSheet from "./BottomSheet";

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
    <BottomSheet visible={visible} onClose={onClose} maxHeight="70%">
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
    </BottomSheet>
  );
}
