import React from "react";
import { View, Text } from "react-native";
import { useThemeColors } from "../theme/useThemeColors";
import Icon from "./Icon";
import BottomSheet from "./BottomSheet";
import Pressable from "./HintPressable";

const MIN_SPEED = 0.5;
const MAX_SPEED = 3.0;
const STEP = 0.05;
const QUICK = [0.75, 1.0, 1.25, 1.5, 1.75, 2.0];

interface Props {
  visible: boolean;
  onClose: () => void;
  speed: number;
  onChange: (speed: number) => void;
  /** "Remember speed per book" toggle state (omit to hide the row). */
  rememberPerBook?: boolean;
  onToggleRememberPerBook?: (value: boolean) => void;
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

// Minimal M3-style inline switch row, self-contained so the modal stays
// standalone. The row itself is the accessible switch.
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
        paddingHorizontal: 24,
        paddingVertical: 14,
      }}
    >
      <Text style={{ flex: 1, fontSize: 16, color: colors.onSurface, marginRight: 16 }}>
        {label}
      </Text>
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

/**
 * Playback speed bottom sheet: large current-speed display with a +/- stepper
 * (0.5x-3.0x, 0.05 steps) plus quick-pick chips. Mirrors the original
 * PlaybackSpeedModal.vue, adapted to the RN player's Material You styling.
 */
export default function PlaybackSpeedModal({
  visible,
  onClose,
  speed,
  onChange,
  rememberPerBook,
  onToggleRememberPerBook,
}: Props) {
  const colors = useThemeColors();

  const canDecrement = round2(speed - STEP) >= MIN_SPEED;
  const canIncrement = round2(speed + STEP) <= MAX_SPEED;

  const decrement = () => {
    if (canDecrement) onChange(round2(speed - STEP));
  };
  const increment = () => {
    if (canIncrement) onChange(round2(speed + STEP));
  };

  return (
    <BottomSheet visible={visible} onClose={onClose}>
            {/* Header */}
            <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 24, paddingTop: 8, paddingBottom: 12 }}>
              <Icon name="speed" size={24} color={colors.onSurface} style={{ marginRight: 12 }} />
              <Text accessibilityRole="header" style={{ flex: 1, fontSize: 22, fontWeight: "500", color: colors.onSurface }}>Playback Speed</Text>
            </View>

            {/* Large current-speed display + stepper */}
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", columnGap: 24, paddingVertical: 16 }}>
              <Pressable
                onPress={decrement}
                disabled={!canDecrement}
                accessibilityRole="button"
                accessibilityLabel="Decrease speed"
                accessibilityState={{ disabled: !canDecrement }}
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: 28,
                  backgroundColor: colors.secondaryContainer,
                  alignItems: "center",
                  justifyContent: "center",
                  opacity: canDecrement ? 1 : 0.4,
                }}
              >
                <Text style={{ fontSize: 28, color: colors.onSecondaryContainer, marginTop: -2 }}>−</Text>
              </Pressable>

              <Text
                accessibilityLabel={`Current speed ${speed.toFixed(2)} times`}
                // Announce each +/- step — the buttons alone give no feedback.
                accessibilityLiveRegion="polite"
                style={{ fontSize: 44, fontWeight: "600", color: colors.onSurface, minWidth: 130, textAlign: "center" }}
              >
                {speed.toFixed(2)}
                <Text style={{ fontSize: 28 }}>×</Text>
              </Text>

              <Pressable
                onPress={increment}
                disabled={!canIncrement}
                accessibilityRole="button"
                accessibilityLabel="Increase speed"
                accessibilityState={{ disabled: !canIncrement }}
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: 28,
                  backgroundColor: colors.secondaryContainer,
                  alignItems: "center",
                  justifyContent: "center",
                  opacity: canIncrement ? 1 : 0.4,
                }}
              >
                <Text style={{ fontSize: 28, color: colors.onSecondaryContainer, marginTop: -2 }}>+</Text>
              </Pressable>
            </View>

            {/* Quick-pick chips */}
            <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "center", columnGap: 10, rowGap: 10, paddingHorizontal: 24, paddingTop: 8, paddingBottom: 20 }}>
              {QUICK.map((rate) => {
                const active = round2(speed) === rate;
                return (
                  <Pressable
                    key={rate}
                    onPress={() => onChange(rate)}
                    accessibilityRole="button"
                    accessibilityLabel={`${rate} times speed`}
                    accessibilityState={{ selected: active }}
                    style={{
                      paddingHorizontal: 18,
                      height: 44,
                      borderRadius: 22,
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: active ? colors.primaryContainer : "transparent",
                      borderWidth: active ? 0 : 1,
                      borderColor: colors.outlineVariant,
                    }}
                  >
                    <Text
                      style={{
                        fontSize: 16,
                        fontWeight: active ? "600" : "400",
                        color: active ? colors.onPrimaryContainer : colors.onSurface,
                      }}
                    >
                      {rate}×
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            {/* Per-book speed memory toggle */}
            {onToggleRememberPerBook ? (
              <View style={{ borderTopWidth: 1, borderTopColor: colors.outlineVariant, paddingBottom: 8 }}>
                <ToggleRow
                  label="Remember speed per book"
                  value={!!rememberPerBook}
                  onValueChange={onToggleRememberPerBook}
                  colors={colors}
                />
              </View>
            ) : null}
    </BottomSheet>
  );
}
