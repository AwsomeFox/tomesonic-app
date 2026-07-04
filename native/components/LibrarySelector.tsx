import React from "react";
import { View, Text, Pressable, Modal } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useThemeColors } from "../theme/useThemeColors";
import { useUiStore } from "../store/useUiStore";
import { useLibraryStore } from "../store/useLibraryStore";
import Icon from "./Icon";

/**
 * Bottom-sheet library switcher, opened from the TopAppBar "Books" pill.
 * Selecting a library updates the current library id, which the tab screens
 * observe to refetch their data.
 */
export default function LibrarySelector() {
  const colors = useThemeColors();
  const open = useUiStore((s) => s.librarySelectorOpen);
  const close = useUiStore((s) => s.closeLibrarySelector);
  const { libraries, currentLibraryId, setCurrentLibraryId } = useLibraryStore();

  const select = (id: string) => {
    if (id !== currentLibraryId) setCurrentLibraryId(id);
    close();
  };

  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={close}>
      {/* Scrim */}
      <Pressable
        onPress={close}
        style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "flex-end" }}
      >
        {/* Sheet (stop propagation by capturing press) */}
        <Pressable
          onPress={() => {}}
          style={{
            backgroundColor: colors.surfaceContainerHigh,
            borderTopLeftRadius: 28,
            borderTopRightRadius: 28,
            paddingTop: 12,
          }}
        >
          <SafeAreaView edges={["bottom"]}>
            {/* Drag handle */}
            <View
              style={{
                alignSelf: "center",
                width: 36,
                height: 4,
                borderRadius: 2,
                backgroundColor: colors.outlineVariant,
                marginBottom: 12,
              }}
            />
            <Text
              style={{
                color: colors.onSurface,
                fontSize: 18,
                fontWeight: "700",
                paddingHorizontal: 24,
                paddingBottom: 8,
              }}
            >
              Libraries
            </Text>

            {libraries.length === 0 ? (
              <Text
                style={{
                  color: colors.onSurfaceVariant,
                  paddingHorizontal: 24,
                  paddingVertical: 16,
                }}
              >
                No libraries available.
              </Text>
            ) : (
              libraries.map((lib) => {
                const active = lib.id === currentLibraryId;
                return (
                  <Pressable
                    key={lib.id}
                    onPress={() => select(lib.id)}
                    android_ripple={{ color: colors.surfaceContainerHighest }}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    accessibilityLabel={`${lib.name}${active ? ", current library" : ""}`}
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      paddingHorizontal: 24,
                      paddingVertical: 16,
                    }}
                  >
                    <Icon
                      name={lib.mediaType === "podcast" ? "podcast" : "library"}
                      size={22}
                      color={active ? colors.primary : colors.onSurfaceVariant}
                    />
                    <Text
                      style={{
                        flex: 1,
                        color: active ? colors.primary : colors.onSurface,
                        fontSize: 16,
                        fontWeight: active ? "700" : "500",
                        marginLeft: 18,
                      }}
                    >
                      {lib.name}
                    </Text>
                    {active ? <Icon name="check" size={20} color={colors.primary} /> : null}
                  </Pressable>
                );
              })
            )}
          </SafeAreaView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
