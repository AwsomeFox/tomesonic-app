import React from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Linking,
  TextInput,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useThemeStore, ThemeMode } from '../store/useThemeStore';
import { useUserStore } from '../store/useUserStore';
import { usePlaybackStore, applyJumpOptions, applyVoiceBoost } from '../store/usePlaybackStore';
import { showAppDialog } from '../store/useDialogStore';
import { useThemeColors } from '../theme/useThemeColors';
import { withAlpha } from '../theme/palette';
import Icon from '../components/Icon';
import {
  SectionHeader,
  Divider,
  RowBase,
  ToggleRow,
  SelectRow,
  NavRow,
} from '../components/SettingsRows';
import SettingSelectModal, { SelectOption } from '../components/SettingSelectModal';
import BottomSheet from '../components/BottomSheet';
import RmabSsoLoginModal from '../components/RmabSsoLoginModal';
import RmabSessionExpiredBanner from '../components/RmabSessionExpiredBanner';
import { useRmabStore } from '../store/useRmabStore';
import { getRmabAuthProviders, rmabOrigin, RmabConfig } from '../utils/rmab';
import { haptic } from '../utils/haptics';

import * as Application from 'expo-application';
import Pressable from "../components/HintPressable";

// The INSTALLED package's version — app.json drifts from the built APK (the
// release flow bumps versions on master, not on feature branches).
const APP_VERSION: string =
  Application.nativeApplicationVersion || require('../app.json').expo?.version || '';
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

export default function SettingsScreen({ navigation, route }: any) {
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
  const rmabAuthMode = useRmabStore((s) => s.authMode);
  const rmabIsAdmin = useRmabStore((s) => s.isAdmin);
  const rmabConnecting = useRmabStore((s) => s.connecting);
  const rmabError = useRmabStore((s) => s.connectError);
  const rmabConnect = useRmabStore((s) => s.connect);
  const rmabConnectWithOidc = useRmabStore((s) => s.connectWithOidc);
  const rmabDisconnect = useRmabStore((s) => s.disconnect);
  const [rmabSheetOpen, setRmabSheetOpen] = React.useState(false);
  // Which token flow the connect sheet shows: an admin-issued one-time login
  // URL (full access) or a self-service rmab_ API key (search + requests).
  const [rmabAuthTab, setRmabAuthTab] = React.useState<'url' | 'apiKey'>('url');
  const [rmabUrl, setRmabUrl] = React.useState('');
  const [rmabToken, setRmabToken] = React.useState('');
  // SSO (OIDC) sign-in: a WebView flow that needs no admin-issued login token.
  const [rmabSsoOpen, setRmabSsoOpen] = React.useState(false);
  const [rmabSsoError, setRmabSsoError] = React.useState<string | null>(null);
  const [rmabProviders, setRmabProviders] = React.useState<{ oidcEnabled: boolean; name?: string | null } | null>(null);

  // connect() accepts a one-time login URL (contains token=) pasted into
  // EITHER field, or a plain server URL plus a separate token — allow any
  // combination that gives it both a server address and a token.
  const rmabTokenIsLoginUrl = rmabToken.includes('token=');
  const rmabCanSubmit = rmabUrl.trim()
    ? rmabUrl.includes('token=') || !!rmabToken.trim()
    : rmabTokenIsLoginUrl;

  // Clear a prior SSO error when the connect sheet CLOSES, so it never lingers
  // into a later open — but without wiping an error the deep-link below sets
  // while opening (a clear-on-open effect would race and erase it).
  React.useEffect(() => {
    if (!rmabSheetOpen) setRmabSsoError(null);
  }, [rmabSheetOpen]);

  // Deep-link from the session-expired banner on Requests/Discover: open the
  // connect sheet directly (a bare navigate would dump the user on Settings
  // with no re-login UI) and surface any failure reason it forwarded.
  React.useEffect(() => {
    if (route?.params?.openRmabConnect) {
      setRmabSheetOpen(true);
      if (route.params.rmabConnectError) setRmabSsoError(route.params.rmabConnectError);
      navigation.setParams({ openRmabConnect: undefined, rmabConnectError: undefined });
    }
  }, [route?.params?.openRmabConnect, route?.params?.rmabConnectError]);

  const onRmabConnect = async () => {
    if (!rmabCanSubmit) return;
    // A token attempt supersedes any earlier SSO error (which otherwise masks
    // the token result, since it takes display precedence).
    setRmabSsoError(null);
    const ok = await rmabConnect(rmabUrl, rmabToken);
    if (ok) {
      setRmabSheetOpen(false);
      setRmabUrl('');
      setRmabToken('');
    }
  };

  // SSO only needs the server address — derive it from whichever field has a
  // usable URL. Show the button unless we've affirmatively learned OIDC is off.
  // The token field only contributes an origin when it's a login URL (has
  // `token=`); a raw `rmab_…` API token would otherwise mis-parse as a bare
  // host (`https://rmab_x`), wrongly showing SSO and probing a bogus origin.
  const rmabSsoOrigin = rmabOrigin(rmabUrl) || (rmabTokenIsLoginUrl ? rmabOrigin(rmabToken) : null);
  const rmabShowSso = !!rmabSsoOrigin && (rmabProviders === null || rmabProviders.oidcEnabled);
  const rmabSsoLabel = rmabProviders?.name ? `Sign in with ${rmabProviders.name}` : 'Sign in with SSO';

  // Probe the server's enabled providers when the sheet is open and we have an
  // address, so the SSO button reflects the real provider (and hides if off).
  React.useEffect(() => {
    // Clear stale provider state from a previous origin up front, then probe.
    setRmabProviders(null);
    if (!rmabSheetOpen || !rmabSsoOrigin) return;
    let cancelled = false;
    const controller = new AbortController();
    // Debounce: the origin recomputes on every keystroke while the user types
    // the server address — wait for a pause so we fire ONE probe, not one per
    // character. Cleanup both cancels the pending probe AND aborts an in-flight
    // request (12s timeout) so a fast edit can't leave a request storm behind.
    const timer = setTimeout(() => {
      getRmabAuthProviders(rmabSsoOrigin, controller.signal).then((p) => {
        // ONLY apply a real response — a null (network/404/aborted) leaves
        // providers unknown so the SSO button stays shown by default rather
        // than hiding on a transient blip.
        if (!cancelled && p) setRmabProviders({ oidcEnabled: p.oidcEnabled, name: p.oidcProviderName });
      });
    }, 450);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [rmabSheetOpen, rmabSsoOrigin]);

  const onRmabSsoSuccess = async (cfg: RmabConfig) => {
    setRmabSsoOpen(false);
    setRmabSsoError(null);
    const ok = await rmabConnectWithOidc(cfg);
    if (ok) {
      setRmabSheetOpen(false);
      setRmabUrl('');
      setRmabToken('');
    }
  };

  const onRmabDisconnect = () => {
    showAppDialog({
      title: 'Disconnect ReadMeABook?',
      message: 'Request features will be hidden until you reconnect.',
      buttons: [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Disconnect', style: 'destructive', onPress: () => rmabDisconnect() },
      ],
    });
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
        <Divider colors={colors} />

        <ToggleRow
          icon="explore"
          title="Show Discover tab before connecting"
          subtitle="Keep the Discover tab visible to explore and connect ReadMeABook"
          value={settings.showDiscoverWhenDisconnected !== false}
          onValueChange={(v) => set({ showDiscoverWhenDisconnected: v })}
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
        <Divider colors={colors} />

        <ToggleRow
          icon="mic"
          title="Enhance voice"
          subtitle="Boost quiet narration so speech is easier to hear"
          value={!!settings.voiceBoost}
          onValueChange={(v) => {
            // Persist first, then push the change to the native effect live so
            // it applies to the currently-playing book without a re-prepare.
            set({ voiceBoost: v });
            applyVoiceBoost();
          }}
          colors={colors}
        />
        <Divider colors={colors} />

        <ToggleRow
          icon="speed"
          title="Skip silence"
          subtitle="Trim silent gaps in narration for faster listening"
          value={!!settings.skipSilence}
          onValueChange={(v) => {
            // Persist first, then re-push the FULL player options so the live
            // exoPlayer.skipSilenceEnabled flips immediately (buildPlayerOptions
            // reads the setting; applyJumpOptions sends the whole options object).
            set({ skipSilence: v });
            applyJumpOptions();
          }}
          colors={colors}
        />
        <Divider colors={colors} />

        <ToggleRow
          icon="auto-stories"
          title="Show book progress bar"
          subtitle="Display full book progress bar in the player"
          value={settings.showPlayerBookProgress !== false}
          onValueChange={(v) => set({ showPlayerBookProgress: v })}
          colors={colors}
        />
        <Divider colors={colors} />

        <ToggleRow
          icon="list"
          title="Show chapter progress bar"
          subtitle="Display chapter progress bar in the player"
          value={settings.showPlayerChapterProgress !== false}
          onValueChange={(v) => set({ showPlayerChapterProgress: v })}
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
            <RmabSessionExpiredBanner
              onManualReconnect={(msg) => {
                if (msg) setRmabSsoError(msg);
                setRmabSheetOpen(true);
              }}
            />
            <RowBase icon="globe" title="Server" subtitle={rmabServerUrl || ''} colors={colors} />
            <Divider colors={colors} />
            <RowBase
              icon="person"
              title="Account"
              subtitle={(rmabUsername || 'Connected') + (rmabAuthMode === 'apiToken' ? ' • API token (search & requests only)' : '')}
              colors={colors}
            />
            <Divider colors={colors} />
            <NavRow
              icon="send"
              title={rmabIsAdmin && rmabAuthMode === 'jwt' ? 'Requests' : 'My Requests'}
              subtitle={
                rmabIsAdmin && rmabAuthMode === 'jwt'
                  ? 'Approve, deny, and manage all requests'
                  : 'Track your book requests'
              }
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
          <Text style={{ color: colors.onSurface, fontSize: 22, fontWeight: '500', marginBottom: 16 }}>
            Connect ReadMeABook
          </Text>

          <Text style={{ color: colors.onSurfaceVariant, fontSize: 13, fontWeight: '600', marginBottom: 6 }}>
            Server address
          </Text>
          <TextInput
            value={rmabUrl}
            onChangeText={setRmabUrl}
            placeholder="https://rmab.example.com"
            placeholderTextColor={colors.onSurfaceVariant}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            // A pasted login URL embeds the one-time token — mask it like the
            // token field does. (Pasting the whole login URL here still works.)
            secureTextEntry={rmabUrl.includes('token=')}
            accessibilityLabel="ReadMeABook server address"
            style={{
              backgroundColor: colors.surfaceContainer,
              color: colors.onSurface,
              borderRadius: 12,
              paddingHorizontal: 14,
              paddingVertical: 10,
            }}
          />

          {/* SSO — the easiest path, called out first. */}
          {rmabShowSso ? (
            <>
              <Pressable
                onPress={() => {
                  setRmabSsoError(null);
                  setRmabSsoOpen(true);
                }}
                accessibilityRole="button"
                // Stable label for assistive tech / automation; the provider
                // name (which varies per server) rides in the hint + visible text.
                accessibilityLabel="Sign in with SSO"
                accessibilityHint={rmabProviders?.name ? `Uses ${rmabProviders.name}` : undefined}
                android_ripple={{ color: withAlpha(colors.onPrimaryContainer, 0.13) }}
                style={{
                  backgroundColor: colors.primaryContainer,
                  height: 48,
                  borderRadius: 24,
                  overflow: 'hidden',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexDirection: 'row',
                  marginTop: 12,
                }}
              >
                <Icon name="account" size={18} color={colors.onPrimaryContainer} />
                <Text style={{ color: colors.onPrimaryContainer, fontSize: 15, fontWeight: '600', marginLeft: 8 }}>
                  {rmabSsoLabel}
                </Text>
              </Pressable>
              <Text style={{ color: colors.onSurfaceVariant, fontSize: 12, marginTop: 8, marginBottom: 14 }}>
                Single sign-on is the easiest way to connect — sign in with your normal
                account, nothing to paste.
              </Text>
            </>
          ) : (
            <Text style={{ color: colors.onSurfaceVariant, fontSize: 12, marginTop: 6, marginBottom: 14 }}>
              Enter your server address. If the server offers single sign-on — the easiest
              way to connect — a sign-in button will appear here.
            </Text>
          )}

          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 14 }}>
            <View style={{ flex: 1, height: 1, backgroundColor: colors.outlineVariant }} />
            <Text style={{ color: colors.onSurfaceVariant, fontSize: 12, marginHorizontal: 10 }}>
              or connect with a token
            </Text>
            <View style={{ flex: 1, height: 1, backgroundColor: colors.outlineVariant }} />
          </View>

          {/* Token-kind toggle: admin login URL vs self-service API key. */}
          <View
            accessibilityRole="tablist"
            style={{
              flexDirection: 'row',
              borderWidth: 1,
              borderColor: colors.outline,
              borderRadius: 20,
              overflow: 'hidden',
              marginBottom: 12,
            }}
          >
            {([
              { key: 'url', label: 'Login URL' },
              { key: 'apiKey', label: 'API key' },
            ] as const).map(({ key, label }) => {
              const selected = rmabAuthTab === key;
              return (
                <Pressable
                  key={key}
                  onPress={() => {
                    if (rmabAuthTab !== key) {
                      setRmabAuthTab(key);
                      // The field means a different secret per tab — a stale
                      // value from the other mode must not ride along.
                      setRmabToken('');
                    }
                  }}
                  accessibilityRole="tab"
                  accessibilityLabel={`${label} tab`}
                  accessibilityState={{ selected }}
                  style={{
                    flex: 1,
                    alignItems: 'center',
                    justifyContent: 'center',
                    paddingVertical: 10,
                    backgroundColor: selected ? colors.secondaryContainer : 'transparent',
                  }}
                >
                  <Text
                    style={{
                      fontSize: 13,
                      fontWeight: '700',
                      color: selected ? colors.onSecondaryContainer : colors.onSurfaceVariant,
                    }}
                  >
                    {label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {rmabAuthTab === 'url' ? (
            <>
              <TextInput
                value={rmabToken}
                onChangeText={setRmabToken}
                placeholder="https://rmab.example.com/auth/token/login?token=…"
                placeholderTextColor={colors.onSurfaceVariant}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                secureTextEntry
                accessibilityLabel="ReadMeABook login URL"
                style={{
                  backgroundColor: colors.surfaceContainer,
                  color: colors.onSurface,
                  borderRadius: 12,
                  paddingHorizontal: 14,
                  paddingVertical: 10,
                }}
              />
              <Text style={{ color: colors.onSurfaceVariant, fontSize: 12, marginTop: 6, marginBottom: 8 }}>
                Full access. Paste the one-time login URL an admin generates under
                Admin → Users → Edit permissions → Login Token. The server address is
                read from the URL, so the field above can stay empty.
              </Text>
            </>
          ) : (
            <>
              <TextInput
                value={rmabToken}
                onChangeText={setRmabToken}
                placeholder="rmab_…"
                placeholderTextColor={colors.onSurfaceVariant}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
                accessibilityLabel="ReadMeABook API key"
                style={{
                  backgroundColor: colors.surfaceContainer,
                  color: colors.onSurface,
                  borderRadius: 12,
                  paddingHorizontal: 14,
                  paddingVertical: 10,
                }}
              />
              <Text style={{ color: colors.onSurfaceVariant, fontSize: 12, marginTop: 6, marginBottom: 8 }}>
                Create one yourself under Profile → API Tokens, and fill in the server
                address above. Limited to search and requests — series and author
                browsing need SSO or a login URL.
              </Text>
            </>
          )}

          {rmabSsoError || rmabError ? (
            // Live region: a failed connect otherwise just leaves the sheet
            // open with no announcement.
            <Text
              accessibilityRole="alert"
              accessibilityLiveRegion="polite"
              style={{ color: colors.error, fontSize: 13, marginBottom: 4 }}
            >
              {rmabSsoError || rmabError}
            </Text>
          ) : null}
          <View style={{ alignItems: 'flex-end', marginTop: 8 }}>
            <Pressable
              onPress={onRmabConnect}
              disabled={rmabConnecting || !rmabCanSubmit}
              accessibilityRole="button"
              accessibilityLabel="Connect"
              android_ripple={{ color: withAlpha(colors.onPrimary, 0.13) }}
              style={{
                backgroundColor: colors.primary,
                height: 48,
                minWidth: 140,
                paddingHorizontal: 32,
                borderRadius: 24,
                overflow: 'hidden',
                alignItems: 'center',
                justifyContent: 'center',
                elevation: 2,
                opacity: rmabConnecting || !rmabCanSubmit ? 0.5 : 1,
              }}
            >
              {rmabConnecting ? (
                <ActivityIndicator size="small" color={colors.onPrimary} />
              ) : (
                <Text style={{ color: colors.onPrimary, fontSize: 16, fontWeight: '600' }}>Connect</Text>
              )}
            </Pressable>
          </View>
        </View>
      </BottomSheet>

      <RmabSsoLoginModal
        visible={rmabSsoOpen}
        serverUrl={rmabSsoOrigin || ''}
        onClose={() => setRmabSsoOpen(false)}
        onSuccess={onRmabSsoSuccess}
        onError={(m) => {
          setRmabSsoOpen(false);
          setRmabSsoError(m);
        }}
      />

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

