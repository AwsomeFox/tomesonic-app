import React from "react";
import { View, Text, Pressable, Modal } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useThemeColors } from "../theme/useThemeColors";
import Icon from "./Icon";

interface Props {
  visible: boolean;
  onClose: () => void;
  onGoToAudiobook: () => void;
  onClosePlayback: () => void;
  title?: string;
  author?: string;
}

export default function PlayerMenuModal({
  visible,
  onClose,
  onGoToAudiobook,
  onClosePlayback,
  title,
  author,
}: Props) {
  const colors = useThemeColors();

  const rowStyle = {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    paddingVertical: 16,
    paddingHorizontal: 24,
    borderRadius: 16,
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0, 0, 0, 0.45)" }}
        onPress={onClose}
      >
        <Pressable
          onPress={() => {}}
          style={{
            backgroundColor: colors.surfaceContainerHigh,
            borderTopLeftRadius: 28,
            borderTopRightRadius: 28,
            paddingBottom: 8,
          }}
        >
          <SafeAreaView edges={["bottom"]}>
            {/* Header with Title + Author */}
            <View style={{ paddingHorizontal: 24, paddingTop: 20, paddingBottom: 12 }}>
              <Text
                numberOfLines={1}
                style={{ fontSize: 18, fontWeight: "bold", color: colors.onSurface }}
              >
                {title || "Now Playing"}
              </Text>
              {author ? (
                <Text
                  numberOfLines={1}
                  style={{ fontSize: 14, color: colors.onSurfaceVariant, marginTop: 2 }}
                >
                  {author}
                </Text>
              ) : null}
            </View>

            <View style={{ height: 1, backgroundColor: colors.outlineVariant, marginBottom: 8 }} />

            {/* Menu options */}
            <View style={{ paddingHorizontal: 8 }}>
              {/* Go to Audiobook */}
              <Pressable
                onPress={() => {
                  onGoToAudiobook();
                  onClose();
                }}
                style={({ pressed }) => [
                  rowStyle,
                  { backgroundColor: pressed ? colors.surfaceContainerHighest : "transparent" },
                ]}
              >
                <Icon name="book" size={24} color={colors.onSurface} style={{ marginRight: 16 }} />
                <Text style={{ fontSize: 16, color: colors.onSurface, fontWeight: "500" }}>
                  Go to Audiobook
                </Text>
              </Pressable>

              {/* Close Playback / Stop */}
              <Pressable
                onPress={() => {
                  onClosePlayback();
                  onClose();
                }}
                style={({ pressed }) => [
                  rowStyle,
                  { backgroundColor: pressed ? colors.surfaceContainerHighest : "transparent" },
                ]}
              >
                <Icon name="close" size={24} color={colors.error || "#B3261E"} style={{ marginRight: 16 }} />
                <Text
                  style={{
                    fontSize: 16,
                    color: colors.error || "#B3261E",
                    fontWeight: "500",
                  }}
                >
                  Close Player
                </Text>
              </Pressable>
            </View>
          </SafeAreaView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
