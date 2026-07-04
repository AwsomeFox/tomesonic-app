import React from "react";
import { View, Text, Pressable, Modal, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useThemeColors } from "../theme/useThemeColors";
import { useLibraryStore } from "../store/useLibraryStore";
import Icon from "./Icon";

/**
 * Sort bottom-sheet, mirroring the original tomesonic OrderModal.vue. Lists the
 * available sort fields; tapping the already-selected field toggles asc/desc
 * (shown with a north/south arrow, matching the Vue). The caller applies the
 * chosen `orderBy` + `descending` to `sort` + `desc` query params.
 */

type SortItem = { text: string; value: string };

const BOOK_ITEMS: SortItem[] = [
  { text: "Title", value: "media.metadata.title" },
  { text: "Author (First Last)", value: "media.metadata.authorName" },
  { text: "Author (Last, First)", value: "media.metadata.authorNameLF" },
  { text: "Publish Year", value: "media.metadata.publishedYear" },
  { text: "Added At", value: "addedAt" },
  { text: "Size", value: "size" },
  { text: "Duration", value: "media.duration" },
  { text: "File Created", value: "birthtimeMs" },
  { text: "File Modified", value: "mtimeMs" },
  { text: "Random", value: "random" },
];

const PODCAST_ITEMS: SortItem[] = [
  { text: "Title", value: "media.metadata.title" },
  { text: "Author", value: "media.metadata.author" },
  { text: "Added At", value: "addedAt" },
  { text: "Size", value: "size" },
  { text: "Number of Episodes", value: "media.numTracks" },
  { text: "File Created", value: "birthtimeMs" },
  { text: "File Modified", value: "mtimeMs" },
  { text: "Random", value: "random" },
];

// Sort options offered on the Series list (series support name / added / total duration).
const SERIES_ITEMS: SortItem[] = [
  { text: "Name", value: "name" },
  { text: "Number of Books", value: "numBooks" },
  { text: "Added At", value: "addedAt" },
  { text: "Total Duration", value: "totalDuration" },
];

interface OrderModalProps {
  visible: boolean;
  onClose: () => void;
  orderBy: string;
  descending: boolean;
  /** Use the series-specific sort options instead of book/podcast ones. */
  series?: boolean;
  /** Fired with the chosen field and direction. */
  onChange: (orderBy: string, descending: boolean) => void;
}

export default function OrderModal({
  visible,
  onClose,
  orderBy,
  descending,
  series,
  onChange,
}: OrderModalProps) {
  const colors = useThemeColors();
  const { libraries, currentLibraryId } = useLibraryStore();
  const currentLibrary = libraries.find((l) => l.id === currentLibraryId);
  const isPodcast = currentLibrary?.mediaType === "podcast";

  const items = series ? SERIES_ITEMS : isPodcast ? PODCAST_ITEMS : BOOK_ITEMS;

  const clickedOption = (value: string) => {
    if (value === orderBy) {
      onChange(value, !descending);
    } else {
      // addedAt defaults to descending (most recent first), mirroring the Vue.
      const desc = value === "addedAt" || value === "recent";
      onChange(value, desc);
    }
    onClose();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable
        onPress={onClose}
        style={{
          flex: 1,
          backgroundColor: "rgba(0,0,0,0.45)",
          justifyContent: "flex-end",
        }}
      >
        <Pressable
          onPress={() => {}}
          style={{
            backgroundColor: colors.surfaceContainerHigh,
            borderTopLeftRadius: 28,
            borderTopRightRadius: 28,
            paddingTop: 12,
            maxHeight: "80%",
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
                marginBottom: 8,
              }}
            />

            {/* Header: sort icon + title */}
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                paddingHorizontal: 20,
                paddingVertical: 8,
              }}
            >
              <Icon
                name="sort"
                size={24}
                color={colors.onSurface}
                style={{ marginRight: 12 }}
              />
              <Text
                style={{
                  fontSize: 20,
                  fontWeight: "600",
                  color: colors.onSurface,
                }}
              >
                Sort by
              </Text>
            </View>

            <ScrollView
              contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 8 }}
              showsVerticalScrollIndicator={false}
            >
              {items.map((item) => {
                const selected = item.value === orderBy;
                return (
                  <Pressable
                    key={item.value}
                    onPress={() => clickedOption(item.value)}
                    android_ripple={{ color: colors.surfaceContainerHighest }}
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      paddingVertical: 12,
                      paddingHorizontal: 12,
                      borderRadius: 16,
                      backgroundColor: selected
                        ? colors.secondaryContainer
                        : "transparent",
                    }}
                  >
                    <Text
                      numberOfLines={1}
                      style={{
                        flex: 1,
                        fontSize: 16,
                        color: selected
                          ? colors.onSecondaryContainer
                          : colors.onSurface,
                      }}
                    >
                      {item.text}
                    </Text>
                    {selected ? (
                      <Icon
                        name={descending ? "chevron-down" : "chevron-up"}
                        size={22}
                        color={colors.onSecondaryContainer}
                      />
                    ) : null}
                  </Pressable>
                );
              })}
            </ScrollView>
          </SafeAreaView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
