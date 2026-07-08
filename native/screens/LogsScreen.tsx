import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  Clipboard,
  Share,
  Modal,
  Pressable,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { appLogger, type LogEntry, type LogLevel } from '../utils/logger';
import { useThemeColors } from '../theme/useThemeColors';
import { withAlpha } from '../theme/palette';
import Icon from '../components/Icon';
import HintPressable from '../components/HintPressable';

const LEVEL_FILTERS: (LogLevel | 'ALL')[] = ['ALL', 'INFO', 'WARN', 'ERROR'];

export default function LogsScreen({ navigation }: any) {
  const colors = useThemeColors();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [copied, setCopied] = useState(false);
  const [menuVisible, setMenuVisible] = useState(false);
  const [maskServerAddress, setMaskServerAddress] = useState(true);
  const [levelFilter, setLevelFilter] = useState<LogLevel | 'ALL'>('ALL');
  const scrollViewRef = useRef<ScrollView>(null);

  const visibleLogs = levelFilter === 'ALL' ? logs : logs.filter((l) => l.level === levelFilter);

  useEffect(() => {
    setLogs(appLogger.getLogs());

    const unsubscribe = appLogger.addListener((entry) => {
      setLogs((prev) => [...prev, entry]);
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    // Auto-scroll to bottom when logs change
    const t = setTimeout(() => {
      scrollViewRef.current?.scrollToEnd({ animated: true });
    }, 50);
    return () => clearTimeout(t);
  }, [logs]);

  function maskMessage(message: string): string {
    if (!maskServerAddress) return message;
    return message.replace(/(https?:\/\/)\S+/g, '$1[SERVER_ADDRESS]');
  }

  // Format epoch/ISO -> MM/DD/YYYY HH:mm:ss.SSS (24h) matching the original app.
  function formatTimestamp(iso: string): string {
    const d = new Date(iso);
    return d
      .toLocaleString('en-US', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        fractionalSecondDigits: 3,
        hour12: false,
      } as any)
      .replace(',', '');
  }

  // Exports what's on screen: copying while filtered to ERROR gives errors only.
  function getLogsString(): string {
    return visibleLogs
      .map(
        (log) =>
          `${formatTimestamp(log.timestamp)} [${log.level.toUpperCase()}]${
            log.tag ? ` [${log.tag}]` : ''
          } ${maskMessage(log.message)}`
      )
      .join('\n');
  }

  function handleCopyAll() {
    Clipboard.setString(getLogsString());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleShare() {
    try {
      await Share.share({ message: getLogsString() });
    } catch {
      // user cancelled / share unavailable — ignore
    }
  }

  function handleClear() {
    appLogger.clearLogs();
    setLogs([]);
    setMenuVisible(false);
  }

  const LEVEL_COLORS: Record<string, string> = {
    ERROR: colors.error,
    WARN: colors.tertiary,
    INFO: colors.primary,
  };

  const iconBtnStyle = {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  };

  const iconRipple = { color: withAlpha(colors.onSurface, 0.12), borderless: true, radius: 22 };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }} edges={['top', 'left', 'right']}>
      {/* Title row: Logs + copy + share + spacer + overflow */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 12,
          paddingTop: 8,
          paddingBottom: 8,
        }}
      >
        <HintPressable
          onPress={() => navigation.goBack()}
          style={iconBtnStyle}
          android_ripple={iconRipple}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Icon name="back" size={24} color={colors.onSurface} />
        </HintPressable>
        <Text
          accessibilityRole="header"
          style={{
            color: colors.onSurface,
            fontSize: 20,
            fontWeight: '700',
            marginLeft: 4,
            marginRight: 8,
          }}
        >
          Logs
        </Text>

        <HintPressable
          onPress={handleCopyAll}
          style={iconBtnStyle}
          android_ripple={iconRipple}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={copied ? 'Logs copied' : 'Copy logs to clipboard'}
        >
          <Icon name={copied ? 'check' : 'copy'} size={22} color={colors.onSurface} />
        </HintPressable>
        <HintPressable
          onPress={handleShare}
          style={iconBtnStyle}
          android_ripple={iconRipple}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Share logs"
        >
          <Icon name="share" size={22} color={colors.onSurface} />
        </HintPressable>

        <View style={{ flex: 1 }} />

        <HintPressable
          onPress={() => setMenuVisible(true)}
          style={iconBtnStyle}
          android_ripple={iconRipple}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="More options"
        >
          <Icon name="more-vert" size={24} color={colors.onSurface} />
        </HintPressable>
      </View>

      {/* Level filter chips */}
      <View style={{ flexDirection: 'row', paddingHorizontal: 16, paddingBottom: 8, columnGap: 8 }}>
        {LEVEL_FILTERS.map((lvl) => {
          const selected = levelFilter === lvl;
          return (
            <Pressable
              key={lvl}
              onPress={() => setLevelFilter(lvl)}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              accessibilityLabel={lvl === 'ALL' ? 'Show all logs' : `Show ${lvl.toLowerCase()} logs`}
              style={{
                paddingHorizontal: 14,
                paddingVertical: 6,
                borderRadius: 16,
                backgroundColor: selected ? colors.secondaryContainer : 'transparent',
                borderWidth: 1,
                borderColor: selected ? 'transparent' : colors.outlineVariant,
              }}
            >
              <Text
                style={{
                  color: selected ? colors.onSecondaryContainer : colors.onSurfaceVariant,
                  fontSize: 13,
                  fontWeight: '600',
                }}
              >
                {lvl === 'ALL' ? 'All' : lvl.charAt(0) + lvl.slice(1).toLowerCase()}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* Log List */}
      <ScrollView
        ref={scrollViewRef}
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 24 }}
      >
        {visibleLogs.length === 0 ? (
          <View style={{ paddingTop: 48, alignItems: 'center' }}>
            <Text style={{ color: colors.onSurfaceVariant, fontSize: 14 }}>
              {logs.length === 0 ? 'No logs to display' : `No ${levelFilter.toLowerCase()} logs`}
            </Text>
          </View>
        ) : (
          visibleLogs.map((log, index) => (
            <View
              key={index}
              style={{
                paddingVertical: 10,
                paddingHorizontal: 16,
                backgroundColor:
                  index % 2 === 0 ? colors.surfaceContainerLowest : 'transparent',
              }}
            >
              {/* Meta row: LEVEL + timestamp .... source tag (right) */}
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4 }}>
                <Text
                  style={{
                    color: LEVEL_COLORS[log.level] || colors.primary,
                    fontSize: 12,
                    fontWeight: '700',
                    letterSpacing: 0.5,
                  }}
                >
                  {log.level.toUpperCase()}
                </Text>
                <Text
                  style={{
                    color: colors.onSurfaceVariant,
                    fontSize: 12,
                    marginLeft: 12,
                  }}
                >
                  {formatTimestamp(log.timestamp)}
                </Text>
                <View style={{ flex: 1 }} />
                {log.tag ? (
                  <Text style={{ color: colors.onSurfaceVariant, fontSize: 12 }}>
                    {log.tag}
                  </Text>
                ) : null}
              </View>

              {/* Message */}
              <Text style={{ color: colors.onSurface, fontSize: 13, lineHeight: 19 }}>
                {maskMessage(log.message)}
              </Text>
            </View>
          ))
        )}
      </ScrollView>

      {/* Overflow menu */}
      <Modal
        visible={menuVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setMenuVisible(false)}
      >
        <Pressable style={{ flex: 1 }} onPress={() => setMenuVisible(false)}>
          <View
            style={{
              position: 'absolute',
              top: 56,
              right: 12,
              backgroundColor: colors.surfaceContainerHigh,
              borderRadius: 12,
              paddingVertical: 6,
              minWidth: 220,
              elevation: 6,
              shadowColor: '#000',
              shadowOpacity: 0.2,
              shadowRadius: 8,
              shadowOffset: { width: 0, height: 2 },
            }}
          >
            <HintPressable
              onPress={() => {
                setMaskServerAddress((m) => !m);
                setMenuVisible(false);
              }}
              accessibilityRole="button"
              accessibilityLabel={maskServerAddress ? 'Unmask server address' : 'Mask server address'}
              android_ripple={{ color: withAlpha(colors.onSurface, 0.12) }}
              style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12 }}
            >
              <Icon name="info" size={20} color={colors.onSurface} />
              <Text style={{ color: colors.onSurface, fontSize: 15, marginLeft: 16 }}>
                {maskServerAddress ? 'Unmask server address' : 'Mask server address'}
              </Text>
            </HintPressable>
            <HintPressable
              onPress={handleClear}
              accessibilityRole="button"
              accessibilityLabel="Clear logs"
              android_ripple={{ color: withAlpha(colors.onSurface, 0.12) }}
              style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12 }}
            >
              <Icon name="trash" size={20} color={colors.error} />
              <Text style={{ color: colors.error, fontSize: 15, marginLeft: 16 }}>Clear logs</Text>
            </HintPressable>
          </View>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}
