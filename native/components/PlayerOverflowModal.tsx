import React from "react";
import { View, Text } from "react-native";
import { useThemeColors } from "../theme/useThemeColors";
import Icon from "./Icon";
import BottomSheet from "./BottomSheet";
import Pressable from "./HintPressable";

interface Props {
  visible: boolean;
  onClose: () => void;
  hasChapters: boolean;
  isBookSession: boolean;
  favItemId: string | null;
  isFav: boolean;
  onToggleFav: () => void;
  onShowChapters: () => void;
  onGoToDetails: () => void;
  onReadFromHere: () => void;
  onStopClose: () => void;
}

export default function PlayerOverflowModal({
  visible,
  onClose,
  hasChapters,
  isBookSession,
  favItemId,
  isFav,
  onToggleFav,
  onShowChapters,
  onGoToDetails,
  onReadFromHere,
  onStopClose,
}: Props) {
  const colors = useThemeColors();

  const handleItemPress = (action: () => void) => {
    onClose();
    setTimeout(action, 200);
  };

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      {/* Header */}
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 24, paddingTop: 12, paddingBottom: 16 }}>
        <Icon name="more-vert" size={24} color={colors.onSurface} style={{ marginRight: 12 }} />
        <Text style={{ flex: 1, fontSize: 20, fontWeight: "600", color: colors.onSurface }}>Playback Options</Text>
      </View>

      {/* List items */}
      <View style={{ paddingHorizontal: 16, paddingBottom: 24 }}>
        {/* Chapters */}
        <Pressable
          onPress={() => handleItemPress(onShowChapters)}
          disabled={!hasChapters}
          accessibilityRole="button"
          accessibilityLabel="Chapters List"
          style={{
            flexDirection: "row",
            alignItems: "center",
            paddingVertical: 16,
            paddingHorizontal: 16,
            borderRadius: 16,
            opacity: hasChapters ? 1 : 0.4,
          }}
        >
          <Icon name="list" size={24} color={colors.onSurface} style={{ marginRight: 16 }} />
          <Text style={{ fontSize: 16, fontWeight: "500", color: colors.onSurface }}>Chapters List</Text>
        </Pressable>

        {/* Ebook reader */}
        {isBookSession && (
          <Pressable
            onPress={() => handleItemPress(onReadFromHere)}
            accessibilityRole="button"
            accessibilityLabel="Read from here"
            style={{
              flexDirection: "row",
              alignItems: "center",
              paddingVertical: 16,
              paddingHorizontal: 16,
              borderRadius: 16,
            }}
          >
            <Icon name="auto-stories" size={24} color={colors.onSurface} style={{ marginRight: 16 }} />
            <Text style={{ fontSize: 16, fontWeight: "500", color: colors.onSurface }}>Read from here</Text>
          </Pressable>
        )}

        {/* Go to Details */}
        <Pressable
          onPress={() => handleItemPress(onGoToDetails)}
          accessibilityRole="button"
          accessibilityLabel="View book details"
          style={{
            flexDirection: "row",
            alignItems: "center",
            paddingVertical: 16,
            paddingHorizontal: 16,
            borderRadius: 16,
          }}
        >
          <Icon name="book" size={24} color={colors.onSurface} style={{ marginRight: 16 }} />
          <Text style={{ fontSize: 16, fontWeight: "500", color: colors.onSurface }}>View book details</Text>
        </Pressable>

        {/* Want to Read (Favorite) */}
        {favItemId && (
          <Pressable
            onPress={() => handleItemPress(onToggleFav)}
            accessibilityRole="button"
            accessibilityLabel={isFav ? "Remove from Want to Read" : "Add to Want to Read"}
            accessibilityState={{ selected: isFav }}
            style={{
              flexDirection: "row",
              alignItems: "center",
              paddingVertical: 16,
              paddingHorizontal: 16,
              borderRadius: 16,
            }}
          >
            <Icon name="heart" size={24} color={isFav ? colors.primary : colors.onSurface} style={{ marginRight: 16 }} />
            <Text style={{ fontSize: 16, fontWeight: "500", color: isFav ? colors.primary : colors.onSurface }}>
              {isFav ? "Remove from Want to Read" : "Add to Want to Read"}
            </Text>
          </Pressable>
        )}

        <View style={{ height: 1, backgroundColor: colors.outlineVariant, marginVertical: 8, marginHorizontal: 16 }} />

        {/* Stop / Close Session */}
        <Pressable
          onPress={() => handleItemPress(onStopClose)}
          accessibilityRole="button"
          accessibilityLabel="Stop and close player"
          style={{
            flexDirection: "row",
            alignItems: "center",
            paddingVertical: 16,
            paddingHorizontal: 16,
            borderRadius: 16,
          }}
        >
          <Icon name="close" size={24} color={colors.error} style={{ marginRight: 16 }} />
          <Text style={{ fontSize: 16, fontWeight: "600", color: colors.error }}>Stop & Close Player</Text>
        </Pressable>
      </View>
    </BottomSheet>
  );
}
