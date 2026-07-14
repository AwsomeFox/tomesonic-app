import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import Icon, { IconName } from './Icon';
import Pressable from './HintPressable';

// Shared settings-list row primitives, extracted VERBATIM from SettingsScreen
// so other screens (server admin, podcast settings, ...) can build identical
// M3 settings lists without duplicating the row anatomy. Same props, same
// visuals — SettingsScreen's test suite is the regression gate.

export function SectionHeader({ label, colors }: { label: string; colors: any }) {
  return (
    <Text
      style={{
        color: colors.primary,
        fontSize: 13,
        fontWeight: '700',
        textTransform: 'uppercase',
        letterSpacing: 1,
        paddingTop: 28,
        paddingBottom: 12,
        paddingHorizontal: 20,
      }}
    >
      {label}
    </Text>
  );
}

export function Divider({ colors }: { colors: any }) {
  return (
    <View
      style={{
        height: 1,
        backgroundColor: colors.outlineVariant,
        marginHorizontal: 20,
        opacity: 0.6,
      }}
    />
  );
}

// Leading icon + title/subtitle stack. Trailing content passed by callers.
export function RowBase({
  icon,
  title,
  subtitle,
  trailing,
  onPress,
  colors,
  accessibilityRole,
  accessibilityState,
}: {
  icon: IconName;
  title: string;
  subtitle?: string;
  trailing?: React.ReactNode;
  onPress?: () => void;
  colors: any;
  accessibilityRole?: 'button' | 'switch';
  accessibilityState?: { checked?: boolean; disabled?: boolean };
}) {
  const inner = (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 16,
        paddingHorizontal: 20,
      }}
    >
      <Icon name={icon} size={26} color={colors.onSurface} style={{ marginRight: 20 }} />
      <View style={{ flex: 1, marginRight: 12 }}>
        <Text style={{ color: colors.onSurface, fontSize: 18 }}>{title}</Text>
        {subtitle ? (
          <Text style={{ color: colors.onSurfaceVariant, fontSize: 14, marginTop: 2 }}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {trailing}
    </View>
  );
  if (onPress) {
    return (
      <TouchableOpacity
        onPress={onPress}
        accessibilityRole={accessibilityRole || 'button'}
        accessibilityState={accessibilityState}
        accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
      >
        {inner}
      </TouchableOpacity>
    );
  }
  return inner;
}

export function ToggleRow({
  icon,
  title,
  subtitle,
  info,
  value,
  onValueChange,
  colors,
}: {
  icon: IconName;
  title: string;
  subtitle?: string;
  info?: boolean;
  value: boolean;
  onValueChange: (v: boolean) => void;
  colors: any;
}) {
  return (
    <RowBase
      icon={icon}
      title={title}
      subtitle={subtitle}
      onPress={() => onValueChange(!value)}
      colors={colors}
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      trailing={
        // The row itself is the accessible switch — hide the visual knob so
        // screen readers don't announce a second, redundant control.
        <View
          style={{ flexDirection: 'row', alignItems: 'center' }}
          importantForAccessibility="no-hide-descendants"
          accessibilityElementsHidden
        >
          {info ? (
            <Icon
              name="info"
              size={22}
              color={colors.onSurfaceVariant}
              style={{ marginRight: 16 }}
            />
          ) : null}
          <M3Switch value={value} onValueChange={onValueChange} colors={colors} />
        </View>
      }
    />
  );
}

// Row that opens a picker sheet (trailing chevron-down = "expands a menu").
export function SelectRow({
  icon,
  title,
  subtitle,
  onPress,
  colors,
}: {
  icon: IconName;
  title: string;
  subtitle?: string;
  onPress?: () => void;
  colors: any;
}) {
  return (
    <RowBase
      icon={icon}
      title={title}
      subtitle={subtitle}
      onPress={onPress}
      colors={colors}
      trailing={<Icon name="chevron-down" size={26} color={colors.onSurface} />}
    />
  );
}

// Row that navigates to another screen (trailing chevron-right = "goes somewhere").
export function NavRow({
  icon,
  title,
  subtitle,
  onPress,
  colors,
}: {
  icon: IconName;
  title: string;
  subtitle?: string;
  onPress?: () => void;
  colors: any;
}) {
  return (
    <RowBase
      icon={icon}
      title={title}
      subtitle={subtitle}
      onPress={onPress}
      colors={colors}
      trailing={<Icon name="chevron-right" size={26} color={colors.onSurfaceVariant} />}
    />
  );
}

// M3 switch: pill track, white knob that grows and gains a ✓ when ON.
export function M3Switch({
  value,
  onValueChange,
  colors,
}: {
  value: boolean;
  onValueChange: (v: boolean) => void;
  colors: any;
}) {
  const TRACK_W = 52;
  const TRACK_H = 32;
  const KNOB_ON = 24;
  const KNOB_OFF = 16;
  const knob = value ? KNOB_ON : KNOB_OFF;
  const pad = (TRACK_H - knob) / 2;
  return (
    <Pressable
      onPress={() => onValueChange(!value)}
      hitSlop={8}
      style={{
        width: TRACK_W,
        height: TRACK_H,
        borderRadius: TRACK_H / 2,
        backgroundColor: value ? colors.primary : colors.surfaceContainerHighest,
        borderWidth: value ? 0 : 2,
        borderColor: colors.outline,
        justifyContent: 'center',
      }}
    >
      <View
        style={{
          position: 'absolute',
          left: value ? TRACK_W - knob - pad : pad,
          width: knob,
          height: knob,
          borderRadius: knob / 2,
          backgroundColor: value ? colors.onPrimary : colors.outline,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {value ? <Icon name="check" size={16} color={colors.primary} /> : null}
      </View>
    </Pressable>
  );
}
