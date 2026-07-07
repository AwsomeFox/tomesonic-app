import React, { useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  ActivityIndicator,
} from "react-native";
import { useThemeColors } from "../theme/useThemeColors";
import { withAlpha } from "../theme/palette";
import { useLibraryStore } from "../store/useLibraryStore";
import Icon, { IconName } from "./Icon";
import BottomSheet from "./BottomSheet";

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
  // Lone surrogates (legal in JSON strings) make encodeURIComponent throw
  // URIError — in the try body AND in a naive catch fallback. Scrub them to
  // U+FFFD first so the function is total. Array.from iterates code points:
  // paired surrogates arrive as length-2 strings, lone ones as length-1 with
  // a code point in the surrogate range.
  const safe = Array.from(String(value ?? ""))
    .map((ch) => {
      const cp = ch.codePointAt(0) ?? 0;
      return ch.length === 1 && cp >= 0xd800 && cp <= 0xdfff ? "\uFFFD" : ch;
    })
    .join("");
  try {
    const b64 =
      typeof btoa === "function"
        ? btoa(unescape(encodeURIComponent(safe)))
        : (globalThis as any).Buffer?.from(safe, "utf8").toString("base64") ||
          safe;
    return encodeURIComponent(b64);
  } catch {
    return encodeURIComponent(safe);
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
  // fetchLibraryDetails swallows errors (returns null) — without this flag a
  // failed fetch rendered as "No genres items" with no way to retry.
  const [loadFailed, setLoadFailed] = useState(false);

  const currentLibrary = libraries.find((l) => l.id === currentLibraryId);
  const isPodcast = currentLibrary?.mediaType === "podcast";
  const items = isPodcast ? PODCAST_ITEMS : BOOK_ITEMS;

  // Load filterData lazily the first time the modal is opened (the store's
  // fetchLibraryDetails populates it; it isn't fetched at startup).
  useEffect(() => {
    if (!visible) return;
    if (!filterData && currentLibraryId && !loadingData) {
      setLoadingData(true);
      Promise.resolve(fetchLibraryDetails(currentLibraryId))
        .then((data) => setLoadFailed(!data))
        .catch(() => setLoadFailed(true))
        .finally(() => setLoadingData(false));
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
      accessibilityRole="button"
      // The active filter was visual-only (tint), and sublist rows gave no
      // cue they open a second level.
      accessibilityState={{ selected }}
      accessibilityLabel={chevron === "chevron-right" ? `${text}, opens list` : text}
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
    <BottomSheet visible={visible} onClose={onClose}>

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
                <Pressable
                  onPress={clearSelected}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="Clear filter"
                  style={{ minHeight: 48, justifyContent: "center", paddingHorizontal: 4 }}
                >
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
                    ) : !sublistItems.length && loadFailed ? (
                      <View key="__error" style={{ alignItems: "center", paddingVertical: 16 }}>
                        <Text
                          style={{
                            color: colors.onSurfaceVariant,
                            textAlign: "center",
                            fontSize: 15,
                          }}
                        >
                          Couldn't load filters — check the server connection.
                        </Text>
                        <Pressable
                          onPress={() => {
                            if (!currentLibraryId || loadingData) return;
                            setLoadingData(true);
                            Promise.resolve(fetchLibraryDetails(currentLibraryId))
                              .then((data) => setLoadFailed(!data))
                              .catch(() => setLoadFailed(true))
                              .finally(() => setLoadingData(false));
                          }}
                          accessibilityRole="button"
                          accessibilityLabel="Retry loading filters"
                          android_ripple={{ color: withAlpha(colors.onPrimary, 0.2) }}
                          style={{
                            marginTop: 12,
                            paddingHorizontal: 24,
                            paddingVertical: 10,
                            borderRadius: 24,
                            overflow: "hidden",
                            backgroundColor: colors.primary,
                          }}
                        >
                          <Text style={{ color: colors.onPrimary, fontSize: 15, fontWeight: "600" }}>
                            Retry
                          </Text>
                        </Pressable>
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
                        {`No ${sublist === "ebooks" ? "ebook filters" : sublist} yet`}
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
    </BottomSheet>
  );
}
