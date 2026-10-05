import React, { useEffect, useState } from "react";
import { View, Text, FlatList } from "react-native";
import { useThemeColors } from "../theme/useThemeColors";
import Icon from "./Icon";
import BottomSheet from "./BottomSheet";
import Pressable from "./HintPressable";
import type { SleepTimerState } from "../store/usePlaybackStore";

const TIMEOUTS = [5, 10, 15, 30, 45, 60];

/** The chapter fields the stop-after-chapter picker reads. */
export interface SleepChapter {
  title?: string;
  start: number;
  end: number;
}

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Active timer state from the store, or null when no timer is running. */
  timer: SleepTimerState | null;
  /** Whether a current chapter exists (enables the End of chapter option). */
  hasChapter: boolean;
  onSet: (seconds: number, endOfChapter?: boolean) => void;
  onCancel: () => void;
  /**
   * Stop-after-chapter: the book's chapters + where playback is, and the
   * handler that arms a timer for the end of a picked chapter. The picker row
   * only appears when the book has a later chapter to pick.
   */
  chapters?: SleepChapter[];
  currentChapterIndex?: number;
  /** One-shot read of the live book position (seconds) when the picker opens. */
  getPosition?: () => number;
  playbackSpeed?: number;
  onSetUntilChapter?: (chapterIndex: number) => void;
  /** "Rewind on wake" toggle (omit both to hide the row). */
  rewindOnWake?: boolean;
  onToggleRewindOnWake?: (value: boolean) => void;
  /** "Shake to add time" toggle (omit both to hide the row). */
  shakeToExtend?: boolean;
  onToggleShakeToExtend?: (value: boolean) => void;
}

// Minimal M3-style inline switch row (self-contained). The row is the switch.
function ToggleRow({
  label,
  value,
  onValueChange,
  colors,
}: {
  label: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
  colors: ReturnType<typeof useThemeColors>;
}) {
  return (
    <Pressable
      onPress={() => onValueChange(!value)}
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      accessibilityLabel={label}
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingHorizontal: 16,
        paddingVertical: 14,
      }}
    >
      <Text style={{ flex: 1, fontSize: 16, color: colors.onSurface, marginRight: 16 }}>{label}</Text>
      <View
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden
        style={{
          width: 48,
          height: 28,
          borderRadius: 14,
          padding: 3,
          backgroundColor: value ? colors.primary : colors.surfaceVariant,
          alignItems: value ? "flex-end" : "flex-start",
          justifyContent: "center",
        }}
      >
        <View
          style={{
            width: 22,
            height: 22,
            borderRadius: 11,
            backgroundColor: value ? colors.onPrimary : colors.outline,
          }}
        />
      </View>
    </Pressable>
  );
}

function chapterTitle(ch: SleepChapter | undefined, index: number) {
  return ch?.title?.trim() || `Chapter ${index + 1}`;
}

function fmt(seconds: number) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

/**
 * Sleep timer bottom sheet. Mirrors the original SleepTimerModal.vue: preset
 * durations, End of chapter, and a Custom stepper — plus "Stop after
 * chapter…", which picks a LATER chapter to stop at. When a timer is active
 * it shows the remaining time with a cancel button.
 */
export default function SleepTimerModal({
  visible,
  onClose,
  timer,
  hasChapter,
  onSet,
  onCancel,
  rewindOnWake,
  onToggleRewindOnWake,
  shakeToExtend,
  onToggleShakeToExtend,
  chapters,
  currentChapterIndex = -1,
  getPosition,
  playbackSpeed = 1,
  onSetUntilChapter,
}: Props) {
  const colors = useThemeColors();
  const [customMode, setCustomMode] = useState(false);
  const [customMin, setCustomMin] = useState(15);
  const [chapterMode, setChapterMode] = useState(false);

  // Reset the sub-views whenever the sheet is reopened.
  useEffect(() => {
    if (visible) {
      setCustomMode(false);
      setChapterMode(false);
    }
  }, [visible]);

  // A later chapter must exist for "stop after…" to mean more than the plain
  // End of chapter row.
  const firstPickable = Math.max(0, currentChapterIndex);
  const canPickChapter =
    !!onSetUntilChapter && hasChapter && !!chapters && chapters.length > firstPickable + 1;

  const rowStyle = {
    paddingVertical: 14,
    borderRadius: 16,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  };
  const rowA11y = { accessibilityRole: "button" as const };

  const renderBody = () => {
    // Active timer view
    if (timer) {
      // Extend in place: "I'm not asleep yet, give me more time" is the most
      // common sleep-timer interaction — cancelling and rebuilding the timer
      // (the old only option) fully wakes the user. Adds onto the current
      // remaining and converts an End-of-chapter timer to a fixed one, which
      // is the intent when you're actively asking for N more minutes.
      const extend = (mins: number) => {
        onSet(Math.max(0, Math.round(timer.remaining)) + mins * 60, false);
        onClose();
      };
      return (
        <View style={{ paddingHorizontal: 24, paddingTop: 8, paddingBottom: 24 }}>
          <Text style={{ fontSize: 44, fontWeight: "600", color: colors.onSurface, textAlign: "center", marginVertical: 12 }}>
            {fmt(timer.remaining)}
          </Text>
          {timer.endOfChapter ? (
            <Text
              numberOfLines={2}
              style={{ fontSize: 14, color: colors.onSurfaceVariant, textAlign: "center", marginBottom: 16 }}
            >
              {timer.untilChapter && timer.chapterIdx != null
                ? `End of ${chapterTitle(chapters?.[timer.chapterIdx], timer.chapterIdx)}`
                : "End of chapter"}
            </Text>
          ) : null}
          <View style={{ flexDirection: "row", justifyContent: "center", gap: 12, marginBottom: 16 }}>
            {[5, 15].map((mins) => (
              <Pressable
                key={mins}
                onPress={() => extend(mins)}
                accessibilityRole="button"
                accessibilityLabel={`Add ${mins} minutes`}
                style={{
                  flex: 1,
                  backgroundColor: colors.secondaryContainer,
                  borderRadius: 24,
                  paddingVertical: 14,
                  alignItems: "center",
                }}
              >
                <Text style={{ color: colors.onSecondaryContainer, fontSize: 16, fontWeight: "600" }}>
                  +{mins} min
                </Text>
              </Pressable>
            ))}
          </View>
          <Pressable
            onPress={() => {
              onCancel();
              onClose();
            }}
            {...rowA11y}
            style={{ backgroundColor: colors.primary, borderRadius: 24, paddingVertical: 14, alignItems: "center" }}
          >
            <Text style={{ color: colors.onPrimary, fontSize: 16, fontWeight: "600" }}>Cancel Timer</Text>
          </Pressable>
        </View>
      );
    }

    // Stop-after-chapter picker: the current chapter onward, each with how
    // long until it ends (listening time at the current speed).
    if (chapterMode && canPickChapter && chapters) {
      const position = getPosition ? getPosition() : chapters[firstPickable]?.start || 0;
      const rate = playbackSpeed > 0 ? playbackSpeed : 1;
      const rows = chapters.slice(firstPickable).map((ch, i) => {
        const index = firstPickable + i;
        return {
          index,
          title: chapterTitle(ch, index),
          endsIn: Math.max(0, ((ch.end || 0) - position) / rate),
          isCurrent: index === currentChapterIndex,
        };
      });
      return (
        <View style={{ paddingHorizontal: 8, paddingBottom: 16 }}>
          <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, marginBottom: 4 }}>
            <Pressable
              onPress={() => setChapterMode(false)}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Back to presets"
              style={{ padding: 4, marginRight: 8 }}
            >
              <Icon name="back" size={26} color={colors.onSurface} />
            </Pressable>
            <Text accessibilityRole="header" style={{ fontSize: 16, fontWeight: "500", color: colors.onSurface }}>
              Stop after chapter
            </Text>
          </View>
          <FlatList
            data={rows}
            keyExtractor={(r) => String(r.index)}
            style={{ maxHeight: 380 }}
            initialNumToRender={12}
            renderItem={({ item }) => (
              <Pressable
                onPress={() => {
                  onSetUntilChapter!(item.index);
                  onClose();
                }}
                accessibilityRole="button"
                accessibilityLabel={`Stop after ${item.title}, ends in ${fmt(item.endsIn)}`}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  paddingHorizontal: 16,
                  paddingVertical: 14,
                  borderRadius: 16,
                }}
              >
                <View style={{ flex: 1, marginRight: 12 }}>
                  <Text numberOfLines={1} style={{ fontSize: 16, color: colors.onSurface }}>
                    {item.title}
                  </Text>
                  {item.isCurrent ? (
                    <Text style={{ fontSize: 12, color: colors.primary, marginTop: 2 }}>Playing now</Text>
                  ) : null}
                </View>
                <Text style={{ fontSize: 14, color: colors.onSurfaceVariant, fontVariant: ["tabular-nums"] }}>
                  {fmt(item.endsIn)}
                </Text>
              </Pressable>
            )}
          />
        </View>
      );
    }

    // Custom stepper view
    if (customMode) {
      return (
        <View style={{ paddingHorizontal: 24, paddingTop: 8, paddingBottom: 24 }}>
          <Pressable
            onPress={() => setCustomMode(false)}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Back to presets"
            style={{ marginBottom: 8, alignSelf: "flex-start", padding: 4 }}
          >
            <Icon name="back" size={26} color={colors.onSurface} />
          </Pressable>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginVertical: 12 }}>
            <Pressable
              onPress={() => setCustomMin((m) => Math.max(1, m - 1))}
              accessibilityRole="button"
              accessibilityLabel="Decrease minutes"
              style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: colors.secondaryContainer, alignItems: "center", justifyContent: "center" }}
            >
              <Text style={{ fontSize: 24, color: colors.onSecondaryContainer, marginTop: -2 }}>−</Text>
            </Pressable>
            {/* Live region: each +/- step announces the new value. */}
            <Text
              accessibilityLiveRegion="polite"
              style={{ fontSize: 28, fontWeight: "600", color: colors.onSurface }}
            >
              {customMin} min
            </Text>
            <Pressable
              onPress={() => setCustomMin((m) => m + 1)}
              accessibilityRole="button"
              accessibilityLabel="Increase minutes"
              style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: colors.secondaryContainer, alignItems: "center", justifyContent: "center" }}
            >
              <Text style={{ fontSize: 24, color: colors.onSecondaryContainer, marginTop: -2 }}>+</Text>
            </Pressable>
          </View>
          <Pressable
            onPress={() => {
              onSet(customMin * 60, false);
              onClose();
            }}
            {...rowA11y}
            style={{ backgroundColor: colors.primary, borderRadius: 24, paddingVertical: 14, alignItems: "center" }}
          >
            <Text style={{ color: colors.onPrimary, fontSize: 16, fontWeight: "600" }}>Set Timer</Text>
          </Pressable>
        </View>
      );
    }

    // Option list
    return (
      <View style={{ paddingHorizontal: 8, paddingBottom: 16 }}>
        {TIMEOUTS.map((min) => (
          <Pressable
            key={min}
            onPress={() => {
              onSet(min * 60, false);
              onClose();
            }}
            {...rowA11y}
            style={rowStyle}
          >
            <Text style={{ fontSize: 18, color: colors.onSurface }}>{min} min</Text>
          </Pressable>
        ))}
        {hasChapter ? (
          <Pressable
            onPress={() => {
              onSet(0, true);
              onClose();
            }}
            {...rowA11y}
            style={rowStyle}
          >
            <Text style={{ fontSize: 18, color: colors.onSurface }}>End of chapter</Text>
          </Pressable>
        ) : null}
        {canPickChapter ? (
          <Pressable onPress={() => setChapterMode(true)} {...rowA11y} style={rowStyle}>
            <Text style={{ fontSize: 18, color: colors.onSurface }}>Stop after chapter…</Text>
          </Pressable>
        ) : null}
        <Pressable onPress={() => setCustomMode(true)} {...rowA11y} style={rowStyle}>
          <Text style={{ fontSize: 18, color: colors.onSurface }}>Custom</Text>
        </Pressable>

        {onToggleRewindOnWake || onToggleShakeToExtend ? (
          <View style={{ borderTopWidth: 1, borderTopColor: colors.outlineVariant, marginTop: 8, paddingTop: 4 }}>
            {onToggleRewindOnWake ? (
              <ToggleRow
                label="Rewind on wake"
                value={!!rewindOnWake}
                onValueChange={onToggleRewindOnWake}
                colors={colors}
              />
            ) : null}
            {onToggleShakeToExtend ? (
              <ToggleRow
                label="Shake to add time"
                value={!!shakeToExtend}
                onValueChange={onToggleShakeToExtend}
                colors={colors}
              />
            ) : null}
          </View>
        ) : null}
      </View>
    );
  };

  return (
    <BottomSheet visible={visible} onClose={onClose}>
            <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 24, paddingTop: 8, paddingBottom: 12 }}>
              <Icon name="moon" size={24} color={colors.onSurface} style={{ marginRight: 12 }} />
              <Text accessibilityRole="header" style={{ flex: 1, fontSize: 22, fontWeight: "500", color: colors.onSurface }}>Sleep Timer</Text>
            </View>
            {renderBody()}
    </BottomSheet>
  );
}
