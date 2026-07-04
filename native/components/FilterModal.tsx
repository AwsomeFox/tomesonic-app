import React, { useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  Pressable,
  Modal,
  ScrollView,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useThemeColors } from "../theme/useThemeColors";
import { useLibraryStore } from "../store/useLibraryStore";
import Icon, { IconName } from "./Icon";

/**
 * Filter bottom-sheet, mirroring the original tomesonic FilterModal.vue and
 * reference screenshot 06. Top-level rows (All / Genre / Tag / Series / Author /
 * Narrator / Language / Progress / Ebooks / Issues / RSS Feed Open / Explicit);
 * sublist rows drill in to concrete values from the library filterData. The
 * chosen value is emitted as the raw `filter` query value (already base64
 * `$encode`d for sublists, matching the original), which the caller applies to
 * `/api/libraries/{id}/items?filter=...`.
 */

// Mirrors the original app's $encode: base64 then URI-encode the value.
export function encodeFilterValue(value: string): string {
  try {
    const b64 =
      typeof btoa === "function"
        ? btoa(unescape(encodeURIComponent(value)))
        : (globalThis as any).Buffer?.from(value, "utf8").toString("base64") ||
          value;
    return encodeURIComponent(b64);
  } catch {
    return encodeURIComponent(value);
  }
}

type TopItem = {
  text: string;
  value: string;
  sublist?: boolean;
};

const BOOK_ITEMS: TopItem[] = [
  { text: "All", value: "all" },
  { text: "Genre", value: "genres", sublist: true },
  { text: "Tag", value: "tags", sublist: true },
  { text: "Series", value: "series", sublist: true },
  { text: "Author", value: "authors", sublist: true },
  { text: "Narrator", value: "narrators", sublist: true },
  { text: "Language", value: "languages", sublist: true },
  { text: "Progress", value: "progress", sublist: true },
  { text: "Ebooks", value: "ebooks", sublist: true },
  { text: "Issues", value: "issues" },
  { text: "RSS Feed Open", value: "feed-open" },
  { text: "Explicit", value: "explicit" },
];

const PODCAST_ITEMS: TopItem[] = [
  { text: "All", value: "all" },
  { text: "Genre", value: "genres", sublist: true },
  { text: "Tag", value: "tags", sublist: true },
  { text: "RSS Feed Open", value: "feed-open" },
  { text: "Explicit", value: "explicit" },
];

// Static sublists (mirrors FilterModal.vue progress/ebooks computeds).
const PROGRESS_ITEMS = [
  { id: "finished", name: "Finished" },
  { id: "in-progress", name: "In Progress" },
  { id: "not-started", name: "Not Started" },
  { id: "not-finished", name: "Not Finished" },
];
const EBOOKS_ITEMS = [
  { id: "ebook", name: "Has Ebook" },
  { id: "supplementary", name: "Has Supplementary Ebook" },
];

interface FilterModalProps {
  visible: boolean;
  onClose: () => void;
  /** Current filter value (raw query value, e.g. "all" or "authors.<enc>"). */
  filterBy: string;
  /** Fired with the newly chosen raw filter value. */
  onChange: (value: string) => void;
}

export default function FilterModal({
  visible,
  onClose,
  filterBy,
  onChange,
}: FilterModalProps) {
  const colors = useThemeColors();
  const { libraries, currentLibraryId, filterData, fetchLibraryDetails } =
    useLibraryStore();

  const [sublist, setSublist] = useState<string | null>(null);
  const [loadingData, setLoadingData] = useState(false);

  const currentLibrary = libraries.find((l) => l.id === currentLibraryId);
  const isPodcast = currentLibrary?.mediaType === "podcast";
  const items = isPodcast ? PODCAST_ITEMS : BOOK_ITEMS;

  // Load filterData lazily the first time the modal is opened (the store's
  // fetchLibraryDetails populates it; it isn't fetched at startup).
  useEffect(() => {
    if (!visible) return;
    if (!filterData && currentLibraryId && !loadingData) {
      setLoadingData(true);
      Promise.resolve(fetchLibraryDetails(currentLibraryId)).finally(() =>
        setLoadingData(false)
      );
    }
  }, [visible, filterData, currentLibraryId]);

  // Reset drilled-in sublist when reopening, restoring it if the current
  // selection is itself a sublist value (matches the Vue watch on `show`).
  useEffect(() => {
    if (visible) {
      const selectedSublist =
        filterBy && filterBy.includes(".") ? filterBy.split(".")[0] : null;
      setSublist(selectedSublist);
    }
  }, [visible]);

  const sublistItems = useMemo<{ text: string; value: string }[]>(() => {
    if (!sublist) return [];
    if (sublist === "progress")
      return PROGRESS_ITEMS.map((i) => ({
        text: i.name,
        value: encodeFilterValue(i.id),
      }));
    if (sublist === "ebooks")
      return EBOOKS_ITEMS.map((i) => ({
        text: i.name,
        value: encodeFilterValue(i.id),
      }));

    const raw = (filterData && filterData[sublist]) || [];
    const mapped = raw.map((item: any) => {
      if (typeof item === "string") {
        return { text: item, value: encodeFilterValue(item) };
      }
      return { text: item.name, value: encodeFilterValue(item.id) };
    });
    if (sublist === "series") {
      mapped.unshift({
        text: "No Series",
        value: encodeFilterValue("no-series"),
      });
    }
    return mapped;
  }, [sublist, filterData]);

  const commit = (value: string) => {
    if (value === filterBy) {
      onClose();
      return;
    }
    onChange(value);
    onClose();
  };

  const clickTop = (item: TopItem) => {
    if (item.sublist) {
      setSublist(item.value);
      return;
    }
    commit(item.value);
  };

  const clearSelected = () => {
    onChange("all");
    onClose();
  };

  const renderRow = (
    key: string,
    text: string,
    selected: boolean,
    onPress: () => void,
    chevron: IconName | null,
    leadingBack = false
  ) => (
    <Pressable
      key={key}
      onPress={onPress}
      android_ripple={{ color: colors.surfaceContainerHighest }}
      style={{
        flexDirection: "row",
        alignItems: "center",
        paddingVertical: 12,
        paddingHorizontal: 12,
        borderRadius: 16,
        backgroundColor: selected ? colors.secondaryContainer : "transparent",
      }}
    >
      {leadingBack ? (
        <Icon
          name="back"
          size={20}
          color={colors.onSurfaceVariant}
          style={{ marginRight: 8 }}
        />
      ) : null}
      <Text
        numberOfLines={1}
        style={{
          flex: 1,
          fontSize: 16,
          color: selected ? colors.onSecondaryContainer : colors.onSurface,
        }}
      >
        {text}
      </Text>
      {chevron ? (
        <Icon name={chevron} size={22} color={colors.onSurfaceVariant} />
      ) : null}
    </Pressable>
  );

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
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

            {/* Header: filter icon + title + clear */}
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                paddingHorizontal: 20,
                paddingVertical: 8,
              }}
            >
              <Icon
                name="filter"
                size={24}
                color={colors.onSurface}
                style={{ marginRight: 12 }}
              />
              <Text
                style={{
                  flex: 1,
                  fontSize: 20,
                  fontWeight: "600",
                  color: colors.onSurface,
                }}
              >
                Filter
              </Text>
              {filterBy !== "all" && !sublist ? (
                <Pressable onPress={clearSelected} hitSlop={8}>
                  <Text
                    style={{ color: colors.primary, fontSize: 14, fontWeight: "600" }}
                  >
                    Clear Filter
                  </Text>
                </Pressable>
              ) : null}
            </View>

            <ScrollView
              contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 8 }}
              showsVerticalScrollIndicator={false}
            >
              {sublist == null
                ? items.map((item) =>
                    renderRow(
                      item.value,
                      item.text,
                      item.value === filterBy,
                      () => clickTop(item),
                      item.sublist ? "chevron-right" : null
                    )
                  )
                : [
                    renderRow(
                      "__back",
                      "Back",
                      false,
                      () => setSublist(null),
                      null,
                      true
                    ),
                    loadingData && !sublistItems.length ? (
                      <View
                        key="__loading"
                        style={{ paddingVertical: 24, alignItems: "center" }}
                      >
                        <ActivityIndicator size="small" color={colors.primary} />
                      </View>
                    ) : !sublistItems.length ? (
                      <Text
                        key="__empty"
                        style={{
                          color: colors.onSurfaceVariant,
                          textAlign: "center",
                          paddingVertical: 20,
                          fontSize: 16,
                        }}
                      >
                        No {sublist} items
                      </Text>
                    ) : (
                      sublistItems.map((si) => {
                        const value = `${sublist}.${si.value}`;
                        return renderRow(
                          value,
                          si.text,
                          value === filterBy,
                          () => commit(value),
                          null
                        );
                      })
                    ),
                  ]}
            </ScrollView>
          </SafeAreaView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
