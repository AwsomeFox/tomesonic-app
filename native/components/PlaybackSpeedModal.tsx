import React from "react";
import { View, Text, Pressable, Modal } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useThemeColors } from "../theme/useThemeColors";
import Icon from "./Icon";

const MIN_SPEED = 0.5;
const MAX_SPEED = 3.0;
const STEP = 0.05;
const QUICK = [0.75, 1.0, 1.25, 1.5, 1.75, 2.0];

interface Props {
  visible: boolean;
  onClose: () => void;
  speed: number;
  onChange: (speed: number) => void;
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

/**
 * Playback speed bottom sheet: large current-speed display with a +/- stepper
 * (0.5x-3.0x, 0.05 steps) plus quick-pick chips. Mirrors the original
 * PlaybackSpeedModal.vue, adapted to the RN player's Material You styling.
 */
export default function PlaybackSpeedModal({ visible, onClose, speed, onChange }: Props) {
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
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0, 0, 0, 0.4)" }} onPress={onClose}>
        <Pressable
          onPress={() => {}}
          style={{
            backgroundColor: colors.surfaceContainerHigh,
            borderTopLeftRadius: 28,
            borderTopRightRadius: 28,
          }}
        >
          <SafeAreaView edges={["bottom"]}>
            {/* Header */}
            <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 24, paddingTop: 20, paddingBottom: 12 }}>
              <Icon name="speed" size={24} color={colors.onSurface} style={{ marginRight: 12 }} />
              <Text style={{ flex: 1, fontSize: 22, fontWeight: "500", color: colors.onSurface }}>Playback Speed</Text>
            </View>

            {/* Large current-speed display + stepper */}
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", columnGap: 24, paddingVertical: 16 }}>
              <Pressable
                onPress={decrement}
                disabled={!canDecrement}
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

              <Text style={{ fontSize: 44, fontWeight: "600", color: colors.onSurface, minWidth: 130, textAlign: "center" }}>
                {speed.toFixed(2)}
                <Text style={{ fontSize: 28 }}>×</Text>
              </Text>

              <Pressable
                onPress={increment}
                disabled={!canIncrement}
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
          </SafeAreaView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
