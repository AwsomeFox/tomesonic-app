import React from "react";
import { View, Text, Pressable, ScrollView } from "react-native";
import { useThemeColors } from "../theme/useThemeColors";
import { withAlpha } from "../theme/palette";
import Icon from "./Icon";
import BottomSheet from "./BottomSheet";
import LibraryIcon, { ABS_LIBRARY_ICONS } from "./LibraryIcon";

const TILE = 56;

/**
 * Glyph-grid icon picker for the library editor — mirrors SettingSelectModal's
 * BottomSheet + title + body structure, but the body is a wrapped grid of
 * square pressable tiles instead of a single-column list. Each tile shows the
 * server glyph the ABS key maps to (via LibraryIcon); the selected tile gets a
 * secondaryContainer fill and a check overlay. onSelect receives the raw ABS
 * key (what the library stores / the server expects), then the sheet closes.
 */
export default function LibraryIconPickerSheet({
  visible,
  selected,
  mediaType,
  onSelect,
  onClose,
}: {
  visible: boolean;
  selected?: string;
  mediaType: "book" | "podcast";
  onSelect: (iconName: string) => void;
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
        Library icon
      </Text>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 12 }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
          {ABS_LIBRARY_ICONS.map((key) => {
            const isSel = key === selected;
            return (
              <Pressable
                key={key}
                onPress={() => {
                  onSelect(key);
                  onClose();
                }}
                android_ripple={{ color: withAlpha(colors.onSurfaceVariant, 0.12) }}
                accessibilityRole="radio"
                accessibilityLabel={key}
                accessibilityState={{ checked: isSel }}
                style={{
                  width: TILE,
                  height: TILE,
                  margin: 4,
                  borderRadius: 12,
                  overflow: "hidden",
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: isSel ? colors.secondaryContainer : colors.surfaceContainerHighest,
                  borderWidth: 1,
                  borderColor: isSel ? colors.secondaryContainer : colors.outlineVariant,
                }}
              >
                <LibraryIcon
                  icon={key}
                  mediaType={mediaType}
                  size={26}
                  color={isSel ? colors.onSecondaryContainer : colors.onSurface}
                />
                {isSel ? (
                  <View
                    style={{
                      position: "absolute",
                      top: 2,
                      right: 2,
                      width: 18,
                      height: 18,
                      borderRadius: 9,
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: colors.secondaryContainer,
                    }}
                  >
                    <Icon name="check" size={14} color={colors.onSecondaryContainer} />
                  </View>
                ) : null}
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
    </BottomSheet>
  );
}
