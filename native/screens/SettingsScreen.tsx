import React from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Pressable,
  Linking,
  TextInput,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useThemeStore, ThemeMode } from '../store/useThemeStore';
import { useUserStore } from '../store/useUserStore';
import { usePlaybackStore } from '../store/usePlaybackStore';
import { useThemeColors } from '../theme/useThemeColors';
import Icon, { IconName } from '../components/Icon';
import SettingSelectModal, { SelectOption } from '../components/SettingSelectModal';
import BottomSheet from '../components/BottomSheet';
import { useRmabStore } from '../store/useRmabStore';
import { haptic } from '../utils/haptics';

// Single source of truth for the displayed version — the Expo app config.
const APP_VERSION: string = require('../app.json').expo?.version || '';
const GITHUB_URL = 'https://github.com/AwsomeFox/tomesonic-app';

const THEME_LABEL: Record<ThemeMode, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
};
const THEME_OPTIONS: SelectOption[] = [
  { label: 'Light', value: 'light' },
  { label: 'Dark', value: 'dark' },
  { label: 'System', value: 'system' },
];
const HAPTIC_OPTIONS: SelectOption[] = [
  { label: 'Off', value: 'off' },
  { label: 'Light', value: 'light' },
  { label: 'Medium', value: 'medium' },
  { label: 'Heavy', value: 'heavy' },
];
const JUMP_OPTIONS: SelectOption[] = [5, 10, 15, 30, 45, 60].map((s) => ({
  label: `${s}s`,
  value: s,
}));
const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

export default function SettingsScreen({ navigation }: any) {
  const colors = useThemeColors();

  const themeMode = useThemeStore((state) => state.mode);
  const setMode = useThemeStore((state) => state.setMode);
  const useDynamicColors = useThemeStore((state) => state.useDynamicColors);
  const setUseDynamicColors = useThemeStore((state) => state.setUseDynamicColors);

  const serverConnectionConfig = useUserStore((state) => state.serverConnectionConfig);
  const user = useUserStore((state) => state.user);
  const settings = useUserStore((state) => state.settings);
  const updateUserSettings = useUserStore((state) => state.updateUserSettings);
  const hasSession = usePlaybackStore((s) => s.currentSession !== null);

  // Which dropdown modal is open (null = none).
  const [openPicker, setOpenPicker] = React.useState<
    null | 'theme' | 'haptic' | 'jumpFwd' | 'jumpBack'
  >(null);

  // ReadMeABook connection state + connect sheet fields.
  const rmabConfigured = useRmabStore((s) => s.configured);
  const rmabServerUrl = useRmabStore((s) => s.serverUrl);
  const rmabUsername = useRmabStore((s) => s.username);
  const rmabConnecting = useRmabStore((s) => s.connecting);
  const rmabError = useRmabStore((s) => s.connectError);
  const rmabConnect = useRmabStore((s) => s.connect);
  const rmabDisconnect = useRmabStore((s) => s.disconnect);
  const [rmabSheetOpen, setRmabSheetOpen] = React.useState(false);
  const [rmabUrl, setRmabUrl] = React.useState('');
  const [rmabToken, setRmabToken] = React.useState('');

  const onRmabConnect = async () => {
    if (!rmabUrl.trim() || !rmabToken.trim()) return;
    const ok = await rmabConnect(rmabUrl, rmabToken);
    if (ok) {
      setRmabSheetOpen(false);
      setRmabUrl('');
      setRmabToken('');
    }
  };

  const onRmabDisconnect = () => {
    Alert.alert('Disconnect ReadMeABook?', 'Request features will be hidden until you reconnect.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Disconnect', style: 'destructive', onPress: () => rmabDisconnect() },
    ]);
  };

  const set = (updates: any) => {
    haptic();
    updateUserSettings(updates);
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }} edges={['top', 'left', 'right']}>
      {/* Header */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingVertical: 12,
          paddingHorizontal: 8,
        }}
      >
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={{ padding: 8, marginRight: 4 }}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Icon name="back" size={24} color={colors.onSurface} />
        </TouchableOpacity>
        <Text style={{ color: colors.onSurface, fontSize: 22, fontWeight: '600' }}>
          Settings
        </Text>
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: hasSession ? 100 : 48 }}>
        {/* ── ACCOUNT ── */}
        <SectionHeader label="Account" colors={colors} />
        <NavRow
          icon="info"
          title="Server"
          subtitle={serverConnectionConfig?.address || 'Not connected'}
          onPress={() => navigation.navigate('Account')}
          colors={colors}
        />
        <Divider colors={colors} />
        <NavRow
          icon="person"
          title="Username"
          subtitle={user?.username || 'Guest'}
          onPress={() => navigation.navigate('Account')}
          colors={colors}
        />

        {/* ── USER INTERFACE SETTINGS ── */}
        <SectionHeader label="User Interface Settings" colors={colors} />

        <ToggleRow
          icon="screen-rotation"
          title="Lock orientation"
          value={!!settings.lockOrientation}
          onValueChange={(v) => set({ lockOrientation: v })}
          colors={colors}
        />
        <Divider colors={colors} />

        <SelectRow
          icon="vibration"
          title="Haptic feedback"
          subtitle={cap(settings.hapticFeedback || 'medium')}
          onPress={() => setOpenPicker('haptic')}
          colors={colors}
        />
        <Divider colors={colors} />

        <SelectRow
          icon="palette"
          title="Theme"
          subtitle={THEME_LABEL[themeMode]}
          onPress={() => setOpenPicker('theme')}
          colors={colors}
        />
        <Divider colors={colors} />

        <ToggleRow
          icon="color-fill"
          title="Use Dynamic Colors (Material You)"
          subtitle="Tint the app with colors from your wallpaper"
          info
          value={useDynamicColors}
          onValueChange={(v) => {
            haptic();
            setUseDynamicColors(v);
          }}
          colors={colors}
        />
        <Divider colors={colors} />

        <ToggleRow
          icon="headphones"
          title="Hide non-audiobooks globally"
          value={!!settings.hideNonAudiobooksGlobal}
          onValueChange={(v) => set({ hideNonAudiobooksGlobal: v })}
          colors={colors}
        />

        {/* ── PLAYBACK SETTINGS ── */}
        <SectionHeader label="Playback Settings" colors={colors} />

        <ToggleRow
          icon="replay"
          title="Disable auto rewind"
          subtitle="Skip the small rewind when resuming"
          value={!!settings.disableAutoRewind}
          onValueChange={(v) => set({ disableAutoRewind: v })}
          colors={colors}
        />
        <Divider colors={colors} />

        <SelectRow
          icon="replay-30"
          title="Jump backwards time"
          subtitle={`${settings.jumpBackwardTime ?? 10}s`}
          onPress={() => setOpenPicker('jumpBack')}
          colors={colors}
        />
        <Divider colors={colors} />

        <SelectRow
          icon="forward-30"
          title="Jump forwards time"
          subtitle={`${settings.jumpForwardTime ?? 10}s`}
          onPress={() => setOpenPicker('jumpFwd')}
          colors={colors}
        />
        <Divider colors={colors} />

        <ToggleRow
          icon="download"
          title="Auto-download next in series"
          subtitle="When you finish a downloaded book, download the next one"
          value={!!settings.autoDownloadNextInSeries}
          onValueChange={(v) => set({ autoDownloadNextInSeries: v })}
          colors={colors}
        />

        {/* ── APP ── */}
        <SectionHeader label="App" colors={colors} />
        <NavRow
          icon="download"
          title="Downloads"
          onPress={() => navigation.navigate('Downloads')}
          colors={colors}
        />
        <Divider colors={colors} />
        <NavRow
          icon="clock"
          title="Listening History"
          onPress={() => navigation.navigate('ListeningHistory')}
          colors={colors}
        />
        <Divider colors={colors} />
        <NavRow
          icon="logs"
          title="Logs"
          onPress={() => navigation.navigate('Logs')}
          colors={colors}
        />

        {/* ── READMEABOOK (book requests) ── */}
        <SectionHeader label="ReadMeABook" colors={colors} />
        {rmabConfigured ? (
          <>
            <RowBase icon="globe" title="Server" subtitle={rmabServerUrl || ''} colors={colors} />
            <Divider colors={colors} />
            <RowBase icon="person" title="Account" subtitle={rmabUsername || 'Connected'} colors={colors} />
            <Divider colors={colors} />
            <NavRow
              icon="send"
              title="My Requests"
              subtitle="Track your book requests"
              onPress={() => navigation.navigate('RmabRequests')}
              colors={colors}
            />
            <Divider colors={colors} />
            <NavRow
              icon="close"
              title="Disconnect"
              onPress={onRmabDisconnect}
              colors={colors}
            />
          </>
        ) : (
          <NavRow
            icon="send"
            title="Connect ReadMeABook"
            subtitle="Request books missing from your library"
            onPress={() => setRmabSheetOpen(true)}
            colors={colors}
          />
        )}

        {/* ── ABOUT ── */}
        <SectionHeader label="About" colors={colors} />
        <RowBase icon="info" title="Version" subtitle={APP_VERSION} colors={colors} />
        <Divider colors={colors} />
        <NavRow
          icon="globe"
          title="GitHub"
          subtitle="Report bugs and request features"
          onPress={() => Linking.openURL(GITHUB_URL)}
          colors={colors}
        />
      </ScrollView>

      {/* Dropdown pickers */}
      {/* ReadMeABook connect sheet */}
      <BottomSheet visible={rmabSheetOpen} onClose={() => setRmabSheetOpen(false)}>
        <View style={{ paddingHorizontal: 24, paddingBottom: 8 }}>
          <Text style={{ color: colors.onSurface, fontSize: 22, fontWeight: '500', marginBottom: 4 }}>
            Connect ReadMeABook
          </Text>
          <Text style={{ color: colors.onSurfaceVariant, fontSize: 13, marginBottom: 16 }}>
            Paste your login token from your ReadMeABook profile page.
          </Text>
          <Text style={{ color: colors.onSurfaceVariant, fontSize: 13, fontWeight: '600', marginBottom: 6 }}>
            Server URL
          </Text>
          <TextInput
            value={rmabUrl}
            onChangeText={setRmabUrl}
            placeholder="https://rmab.example.com"
            placeholderTextColor={colors.onSurfaceVariant}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            accessibilityLabel="ReadMeABook server URL"
            style={{
              backgroundColor: colors.surfaceContainer,
              color: colors.onSurface,
              borderRadius: 12,
              paddingHorizontal: 14,
              paddingVertical: 10,
              marginBottom: 12,
            }}
          />
          <Text style={{ color: colors.onSurfaceVariant, fontSize: 13, fontWeight: '600', marginBottom: 6 }}>
            Login Token
          </Text>
          <TextInput
            value={rmabToken}
            onChangeText={setRmabToken}
            placeholder="Login token"
            placeholderTextColor={colors.onSurfaceVariant}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            accessibilityLabel="ReadMeABook login token"
            style={{
              backgroundColor: colors.surfaceContainer,
              color: colors.onSurface,
              borderRadius: 12,
              paddingHorizontal: 14,
              paddingVertical: 10,
              marginBottom: 8,
            }}
          />
          {rmabError ? (
            <Text style={{ color: colors.error, fontSize: 13, marginBottom: 4 }}>{rmabError}</Text>
          ) : null}
          <Pressable
            onPress={onRmabConnect}
            disabled={rmabConnecting || !rmabUrl.trim() || !rmabToken.trim()}
            accessibilityRole="button"
            accessibilityLabel="Connect"
            style={{
              backgroundColor: colors.primary,
              height: 48,
              borderRadius: 24,
              alignItems: 'center',
              justifyContent: 'center',
              marginTop: 8,
              opacity: rmabConnecting || !rmabUrl.trim() || !rmabToken.trim() ? 0.5 : 1,
            }}
          >
            {rmabConnecting ? (
              <ActivityIndicator size="small" color={colors.onPrimary} />
            ) : (
              <Text style={{ color: colors.onPrimary, fontSize: 16, fontWeight: '600' }}>Connect</Text>
            )}
          </Pressable>
        </View>
      </BottomSheet>

      <SettingSelectModal
        visible={openPicker === 'theme'}
        title="Theme"
        options={THEME_OPTIONS}
        selected={themeMode}
        onSelect={(v) => setMode(v as ThemeMode)}
        onClose={() => setOpenPicker(null)}
      />
      <SettingSelectModal
        visible={openPicker === 'haptic'}
        title="Haptic feedback"
        options={HAPTIC_OPTIONS}
        selected={settings.hapticFeedback || 'medium'}
        onSelect={(v) => set({ hapticFeedback: v })}
        onClose={() => setOpenPicker(null)}
      />
      <SettingSelectModal
        visible={openPicker === 'jumpBack'}
        title="Jump backwards time"
        options={JUMP_OPTIONS}
        selected={settings.jumpBackwardTime ?? 10}
        onSelect={(v) => set({ jumpBackwardTime: v })}
        onClose={() => setOpenPicker(null)}
      />
      <SettingSelectModal
        visible={openPicker === 'jumpFwd'}
        title="Jump forwards time"
        options={JUMP_OPTIONS}
        selected={settings.jumpForwardTime ?? 10}
        onSelect={(v) => set({ jumpForwardTime: v })}
        onClose={() => setOpenPicker(null)}
      />
    </SafeAreaView>
  );
}

function SectionHeader({ label, colors }: { label: string; colors: any }) {
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

function Divider({ colors }: { colors: any }) {
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
function RowBase({
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
  accessibilityState?: { checked?: boolean };
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

function ToggleRow({
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
function SelectRow({
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
function NavRow({
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
function M3Switch({
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
