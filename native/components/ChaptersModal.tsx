import React, { useRef } from "react";
import { View, Text, ScrollView, useWindowDimensions } from "react-native";
import { useThemeColors } from "../theme/useThemeColors";
import Icon from "./Icon";
import BottomSheet from "./BottomSheet";
import Pressable from "./HintPressable";

// Fixed row metrics (52 height + 2+2 vertical margin) so we can jump the list
// to the active chapter without measuring.
const ROW_H = 56;

interface Props {
  visible: boolean;
  onClose: () => void;
  chapters: any[];
  currentChapterIndex: number;
  onSeekToChapter: (index: number) => void;
  hideBackdrop?: boolean;
}

function secondsToTimestamp(seconds: number) {
  let s = seconds;
  if (!s || s < 0) s = 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
  }
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

export default function ChaptersModal({
  visible,
  onClose,
  chapters,
  currentChapterIndex,
  onSeekToChapter,
  hideBackdrop,
}: Props) {
  const colors = useThemeColors();
  const { height: screenHeight } = useWindowDimensions();
  const scrollRef = useRef<ScrollView>(null);

  const hasChapters = chapters && chapters.length > 0;

  // Jump to the active chapter when the list content is measured (Modal
  // remounts children on every open, so this fires per open) — on a
  // 60-chapter book the current chapter would otherwise be far below the
  // fold. Two rows of context are kept above it; not animated so it reads as
  // the initial state rather than a scroll.
  const scrollToActive = () => {
    if (currentChapterIndex > 2) {
      scrollRef.current?.scrollTo({ y: (currentChapterIndex - 2) * ROW_H, animated: false });
    }
  };

  return (
    <BottomSheet visible={visible} onClose={onClose} maxHeight="70%" hideBackdrop={hideBackdrop}>
            {/* Modal Header */}
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                paddingHorizontal: 24,
                paddingTop: 8,
                paddingBottom: 12,
                borderBottomWidth: 1,
                borderBottomColor: colors.outlineVariant,
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <Icon name="list" size={24} color={colors.onSurface} style={{ marginRight: 12 }} />
                <Text style={{ fontSize: 22, fontWeight: "500", color: colors.onSurface }}>
                  Chapters
                </Text>
              </View>
              <Pressable
                onPress={onClose}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Close"
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 20,
                  backgroundColor: colors.secondaryContainer,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Icon name="close" size={22} color={colors.onSecondaryContainer} />
              </Pressable>
            </View>

            {/* Chapters List */}
            <ScrollView
              ref={scrollRef}
              onContentSizeChange={scrollToActive}
              style={{ marginVertical: 8 }}
              contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 16 }}
            >
              {hasChapters ? (
                chapters.map((ch: any, i: number) => {
                  const active = i === currentChapterIndex;
                  return (
                    <Pressable
                      key={ch.id ?? i}
                      onPress={() => {
                        onSeekToChapter(i);
                        onClose();
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={`${ch.title || `Chapter ${i + 1}`}, starts at ${secondsToTimestamp(ch.start || 0)}`}
                      accessibilityState={{ selected: active }}
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        paddingHorizontal: 16,
                        borderRadius: 28,
                        height: 52,
                        backgroundColor: active ? colors.secondaryContainer : "transparent",
                        marginVertical: 2,
                      }}
                    >
                      {active ? (
                        <Icon
                          name="play-triangle"
                          size={20}
                          color={colors.onSecondaryContainer}
                          style={{ marginRight: 8 }}
                        />
                      ) : null}
                      <Text
                        numberOfLines={1}
                        style={{
                          flex: 1,
                          fontSize: 16,
                          color: active ? colors.onSecondaryContainer : colors.onSurface,
                          fontWeight: active ? "600" : "400",
                        }}
                      >
                        {ch.title || `Chapter ${i + 1}`}
                      </Text>
                      <Text
                        style={{
                          fontFamily: "monospace",
                          fontSize: 14,
                          marginLeft: 8,
                          color: active ? colors.onSecondaryContainer : colors.onSurfaceVariant,
                        }}
                      >
                        {secondsToTimestamp(ch.start || 0)}
                      </Text>
                    </Pressable>
                  );
                })
              ) : (
                <View style={{ paddingVertical: 32, alignItems: "center" }}>
                  <Text style={{ color: colors.onSurfaceVariant, fontSize: 16 }}>
                    No chapters available
                  </Text>
                </View>
              )}
            </ScrollView>
    </BottomSheet>
  );
}
