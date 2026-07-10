import React, { useEffect, useRef } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  useWindowDimensions,
  StyleSheet,
  PanResponder,
} from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  interpolate,
  Extrapolate,
  SharedValue,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColors } from "../theme/useThemeColors";
import Icon from "./Icon";
import { haptic } from "../utils/haptics";

const ROW_H = 52;
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface Props {
  mainPlayerProgress: SharedValue<number>;
  chapters: any[];
  currentChapterIndex: number;
  onSeekToChapter: (index: number) => void;
  queue: any[];
  removeFromQueue: (id: string, episodeId?: string | null) => void;
  clearQueue: () => void;
  playNextInQueue: () => Promise<boolean>;
  expanded: boolean;
  onToggleExpand: (expanded: boolean) => void;
  activeTab: "chapters" | "queue";
  onTabChange: (tab: "chapters" | "queue") => void;
  isLandscape?: boolean;
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

export default function PlayerChaptersQueueSheet({
  mainPlayerProgress,
  chapters,
  currentChapterIndex,
  onSeekToChapter,
  queue,
  removeFromQueue,
  clearQueue,
  playNextInQueue,
  expanded,
  onToggleExpand,
  activeTab,
  onTabChange,
  isLandscape = false,
}: Props) {
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const { height: screenHeight } = useWindowDimensions();
  const sheetHeight = screenHeight * 0.72; // covers 72% of the screen
  const peekHeight = 54;

  const subProgress = useSharedValue(0);
  const scrollRef = useRef<ScrollView>(null);

  const hasChapters = chapters && chapters.length > 0;

  useEffect(() => {
    subProgress.value = withTiming(expanded ? 1 : 0, { duration: 250 });
  }, [expanded]);

  // Scroll to active chapter when chapters tab is selected or opened
  useEffect(() => {
    if (expanded && activeTab === "chapters" && currentChapterIndex > 2) {
      const timer = setTimeout(() => {
        scrollRef.current?.scrollTo({
          y: (currentChapterIndex - 2) * ROW_H,
          animated: false,
        });
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [activeTab, expanded, currentChapterIndex]);

  // PanResponder to drive drawer progress via dragging the handle
  const dragRange = sheetHeight - peekHeight - insets.bottom;
  const dragRangeRef = useRef(dragRange);
  dragRangeRef.current = dragRange;
  const expandedRef = useRef(expanded);
  useEffect(() => {
    expandedRef.current = expanded;
  }, [expanded]);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (evt, gestureState) => {
        const { dx, dy } = gestureState;
        return Math.abs(dy) > 4 && Math.abs(dy) > Math.abs(dx);
      },
      onPanResponderMove: (evt, gestureState) => {
        const dy = gestureState.dy;
        const range = dragRangeRef.current || 1;
        if (expandedRef.current) {
          const newProgress = 1 - dy / range;
          subProgress.value = Math.max(0, Math.min(1, newProgress));
        } else {
          const newProgress = -dy / range;
          subProgress.value = Math.max(0, Math.min(1, newProgress));
        }
      },
      onPanResponderRelease: (evt, gestureState) => {
        const p = subProgress.value;
        if (gestureState.vy < -0.2) {
          onToggleExpand(true);
        } else if (gestureState.vy > 0.2) {
          onToggleExpand(false);
        } else {
          if (p > 0.4) {
            onToggleExpand(true);
          } else {
            onToggleExpand(false);
          }
        }
      },
      onPanResponderTerminate: () => {
        onToggleExpand(expandedRef.current);
      },
    })
  ).current;

  // Coordinated slide-up position
  const animatedSheetStyle = useAnimatedStyle(() => {
    const mainP = mainPlayerProgress.value;
    const subP = subProgress.value;

    const offScreenY = sheetHeight + insets.bottom;
    const peekY = isLandscape
      ? offScreenY
      : (sheetHeight - peekHeight - insets.bottom);
    const expandedY = 0;

    // Slide peek up as parent expands
    const currentCollapsedY = interpolate(
      mainP,
      [0.9, 1],
      [offScreenY, peekY],
      Extrapolate.CLAMP
    );

    // Expand upward on tap
    const translateY = interpolate(
      subP,
      [0, 1],
      [currentCollapsedY, expandedY]
    );

    return {
      transform: [{ translateY }],
    };
  });

  const animatedBackdropStyle = useAnimatedStyle(() => {
    const subP = subProgress.value;
    return {
      opacity: subP,
    };
  });

  const toggleExpand = () => {
    haptic();
    onToggleExpand(!expanded);
  };

  return (
    <>
      {/* Backdrop */}
      {expanded && (
        <AnimatedPressable
          onPress={() => onToggleExpand(false)}
          accessibilityRole="button"
          accessibilityLabel="Dismiss chapters and queue list"
          style={[
            StyleSheet.absoluteFill,
            {
              backgroundColor: "rgba(0, 0, 0, 0.45)",
              zIndex: 92,
            },
            animatedBackdropStyle,
          ]}
        />
      )}

      {/* Main Drawer Sheet */}
      <Animated.View
        style={[
          {
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            height: sheetHeight,
            backgroundColor: colors.surfaceContainer,
            borderTopLeftRadius: 28,
            borderTopRightRadius: 28,
            zIndex: 95,
            shadowColor: "#000",
            shadowOffset: { width: 0, height: -3 },
            shadowOpacity: 0.1,
            shadowRadius: 6,
            elevation: 8,
          },
          animatedSheetStyle,
        ]}
      >
        <View {...panResponder.panHandlers}>
          <Pressable
            onPress={toggleExpand}
            accessibilityRole="button"
            accessibilityLabel={activeTab === "chapters" ? "Chapters" : "Up Next"}
            style={{
              height: peekHeight,
              flexDirection: "row",
              alignItems: "center",
              paddingHorizontal: 24,
              borderBottomWidth: expanded ? 1 : 0,
              borderBottomColor: colors.outlineVariant,
            }}
          >
            {/* Decorative Drag Handle */}
            <View
              style={{
                position: "absolute",
                top: 8,
                left: "50%",
                marginLeft: -18,
                width: 36,
                height: 4,
                borderRadius: 3,
                backgroundColor: colors.outlineVariant,
              }}
            />

            <Icon
              name={activeTab === "chapters" ? "list" : "playlist-add"}
              size={20}
              color={colors.onSurface}
              style={{ marginRight: 10, marginTop: 4 }}
            />
            <Text
              style={{
                flex: 1,
                fontSize: 15,
                fontWeight: "600",
                color: colors.onSurface,
                marginTop: 4,
              }}
            >
              {expanded
                ? "Chapters & Up Next"
                : activeTab === "chapters"
                ? `Chapters (${chapters.length})`
                : `Up Next (${queue.length})`}
            </Text>

            <Icon
              name={expanded ? "chevron-down" : "chevron-up"}
              size={24}
              color={colors.onSurfaceVariant}
              style={{ marginTop: 4 }}
            />
          </Pressable>
        </View>

        {expanded && (
          <View style={{ flex: 1 }}>
            {/* Tab Selector Row (Material 3 Segmented Control Style) */}
            <View
              style={{
                flexDirection: "row",
                paddingHorizontal: 24,
                paddingVertical: 12,
              }}
            >
              <View
                accessibilityRole="tablist"
                style={{
                  flex: 1,
                  flexDirection: "row",
                  borderWidth: 1,
                  borderColor: colors.outline,
                  borderRadius: 20,
                  overflow: "hidden",
                }}
              >
                {(["chapters", "queue"] as const).map((tab) => {
                  const selected = activeTab === tab;
                  const label =
                    tab === "chapters"
                      ? `Chapters (${chapters.length})`
                      : `Up Next (${queue.length})`;
                  return (
                    <Pressable
                      key={tab}
                      onPress={() => {
                        haptic();
                        onTabChange(tab);
                      }}
                      accessibilityRole="tab"
                      accessibilityState={{ selected }}
                      style={{
                        flex: 1,
                        alignItems: "center",
                        justifyContent: "center",
                        paddingVertical: 10,
                        backgroundColor: selected
                          ? colors.secondaryContainer
                          : "transparent",
                      }}
                    >
                      <Text
                        style={{
                          fontSize: 13,
                          fontWeight: "700",
                          color: selected
                            ? colors.onSecondaryContainer
                            : colors.onSurfaceVariant,
                        }}
                      >
                        {label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            {/* Tab Contents */}
            {activeTab === "chapters" ? (
              /* Chapters List Content */
              <ScrollView
                ref={scrollRef}
                style={{ flex: 1 }}
                contentContainerStyle={{
                  paddingHorizontal: 16,
                  paddingBottom: insets.bottom + 16,
                }}
              >
                {hasChapters ? (
                  chapters.map((ch: any, i: number) => {
                    const active = i === currentChapterIndex;
                    return (
                      <Pressable
                        key={ch.id ?? i}
                        onPress={() => {
                          haptic();
                          onSeekToChapter(i);
                          onToggleExpand(false);
                        }}
                        accessibilityRole="button"
                        accessibilityLabel={`${ch.title || `Chapter ${i + 1}`}, starts at ${secondsToTimestamp(ch.start || 0)}`}
                        style={{
                          flexDirection: "row",
                          alignItems: "center",
                          paddingHorizontal: 16,
                          borderRadius: 24,
                          height: ROW_H,
                          backgroundColor: active
                            ? colors.secondaryContainer
                            : "transparent",
                          marginVertical: 2,
                        }}
                      >
                        {active ? (
                          <Icon
                            name="play-triangle"
                            size={16}
                            color={colors.onSecondaryContainer}
                            style={{ marginRight: 8 }}
                          />
                        ) : null}
                        <Text
                          numberOfLines={1}
                          style={{
                            flex: 1,
                            fontSize: 15,
                            color: active
                              ? colors.onSecondaryContainer
                              : colors.onSurface,
                            fontWeight: active ? "600" : "400",
                          }}
                        >
                          {ch.title || `Chapter ${i + 1}`}
                        </Text>
                        <Text
                          style={{
                            fontFamily: "monospace",
                            fontSize: 13,
                            color: active
                              ? colors.onSecondaryContainer
                              : colors.onSurfaceVariant,
                            marginLeft: 8,
                          }}
                        >
                          {secondsToTimestamp(ch.start || 0)}
                        </Text>
                      </Pressable>
                    );
                  })
                ) : (
                  <View style={{ paddingVertical: 40, alignItems: "center" }}>
                    <Text style={{ color: colors.onSurfaceVariant, fontSize: 14 }}>
                      No chapters available
                    </Text>
                  </View>
                )}
              </ScrollView>
            ) : (
              /* Up Next Queue Content */
              <ScrollView
                style={{ flex: 1 }}
                contentContainerStyle={{
                  paddingHorizontal: 16,
                  paddingBottom: insets.bottom + 16,
                }}
              >
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "space-between",
                    paddingHorizontal: 8,
                    paddingBottom: 8,
                  }}
                >
                  <Text
                    style={{
                      fontSize: 13,
                      fontWeight: "700",
                      color: colors.onSurfaceVariant,
                      textTransform: "uppercase",
                    }}
                  >
                    Up Next
                  </Text>
                  {queue.length > 0 ? (
                    <Pressable
                      onPress={() => {
                        haptic();
                        clearQueue();
                      }}
                      accessibilityRole="button"
                      accessibilityLabel="Clear all queue items"
                      style={{ paddingHorizontal: 8, paddingVertical: 4 }}
                    >
                      <Text
                        style={{
                          color: colors.error,
                          fontSize: 14,
                          fontWeight: "600",
                        }}
                      >
                        Clear All
                      </Text>
                    </Pressable>
                  ) : null}
                </View>

                {queue.length === 0 ? (
                  <View style={{ paddingVertical: 48, paddingHorizontal: 24 }}>
                    <Text
                      style={{
                        color: colors.onSurfaceVariant,
                        fontSize: 14,
                        textAlign: "center",
                        lineHeight: 20,
                      }}
                    >
                      No books queued. When this book finishes, playback stops
                      unless a queued book is available.
                    </Text>
                  </View>
                ) : (
                  queue.map((item, idx) => (
                    <View
                      key={`${item.libraryItemId}:${item.episodeId || ""}`}
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        paddingHorizontal: 12,
                        paddingVertical: 12,
                        borderBottomWidth: idx < queue.length - 1 ? 1 : 0,
                        borderBottomColor: colors.outlineVariant,
                      }}
                    >
                      <View style={{ flex: 1, marginRight: 12 }}>
                        <Text
                          numberOfLines={1}
                          style={{
                            color: colors.onSurface,
                            fontSize: 15,
                            fontWeight: "500",
                          }}
                        >
                          {item.title || item.libraryItemId}
                        </Text>
                        {item.author ? (
                          <Text
                            numberOfLines={1}
                            style={{
                              color: colors.onSurfaceVariant,
                              fontSize: 12,
                              marginTop: 2,
                            }}
                          >
                            {item.author}
                          </Text>
                        ) : null}
                      </View>
                      {idx === 0 ? (
                        <Pressable
                          onPress={() => {
                            haptic();
                            onToggleExpand(false);
                            playNextInQueue().catch(() => {});
                          }}
                          accessibilityRole="button"
                          accessibilityLabel={`Play ${item.title || "track"} now`}
                          style={{
                            width: 38,
                            height: 38,
                            borderRadius: 19,
                            backgroundColor: colors.secondaryContainer,
                            alignItems: "center",
                            justifyContent: "center",
                            marginRight: 8,
                          }}
                        >
                          <Icon
                            name="play"
                            size={16}
                            color={colors.onSecondaryContainer}
                          />
                        </Pressable>
                      ) : null}
                      <Pressable
                        onPress={() => {
                          haptic();
                          removeFromQueue(item.libraryItemId, item.episodeId);
                        }}
                        accessibilityRole="button"
                        accessibilityLabel={`Remove ${item.title || "track"} from queue`}
                        style={{
                          width: 38,
                          height: 38,
                          borderRadius: 19,
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <Icon
                          name="close"
                          size={18}
                          color={colors.onSurfaceVariant}
                        />
                      </Pressable>
                    </View>
                  ))
                )}
              </ScrollView>
            )}
          </View>
        )}
      </Animated.View>
    </>
  );
}
