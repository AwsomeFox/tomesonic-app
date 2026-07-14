import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, ScrollView, ActivityIndicator, Share } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { api } from '../utils/api';
import { useThemeColors } from '../theme/useThemeColors';
import { withAlpha } from '../theme/palette';
import Icon from '../components/Icon';
import HintPressable from '../components/HintPressable';
import EmptyState from '../components/EmptyState';
import ErrorState from '../components/ErrorState';
import { useUserStore } from '../store/useUserStore';
import { usePlaybackStore } from '../store/usePlaybackStore';
import { useNetworkStatus } from '../hooks/useNetworkStatus';
import { coverUrl } from '../utils/urls';
import { coverSource } from '../utils/coverSource';

// Shape returned by ABS `GET /api/me/stats/year/{year}`. Every field is
// optional-at-runtime because an account with no listening in the requested
// year returns zeros / empty arrays, and older servers may omit newer keys.
interface YearStats {
  numBooksFinished?: number;
  totalListeningTime?: number; // seconds
  totalListeningSessions?: number;
  numBooksListened?: number;
  mostListenedNarrator?: any;
  topGenres?: any[];
  topAuthors?: any[];
  mostListenedMonth?: any;
  finishedBooksWithCovers?: string[];
  booksWithCovers?: string[];
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// The year param (and any default derived from the clock) can be faked or
// garbage in tests. Clamp to a sane calendar range; if the clock itself is
// unusable, fall back to a fixed recent completed year rather than NaN.
export function safeYear(param?: any): number {
  const n = typeof param === 'string' ? Number(param) : param;
  if (typeof n === 'number' && Number.isFinite(n) && n >= 1970 && n <= 3000) {
    return Math.floor(n);
  }
  try {
    const y = new Date().getFullYear();
    if (Number.isFinite(y) && y >= 1970 && y <= 3000) return y;
  } catch {}
  return 2024;
}

// Map a heterogeneous list (strings, or objects keyed by name/genre/author)
// to display labels, dropping empties.
function listLabels(arr: any, keys: string[]): string[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((it) => {
      if (it == null) return '';
      if (typeof it === 'string' || typeof it === 'number') return String(it);
      for (const k of keys) if (it[k] != null && it[k] !== '') return String(it[k]);
      return '';
    })
    .filter(Boolean);
}

// A single string/object value -> its display name.
function nameOf(v: any, keys: string[]): string {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (typeof v === 'object') {
    for (const k of keys) if (v[k] != null && v[k] !== '') return String(v[k]);
  }
  return '';
}

// mostListenedMonth may arrive as a 0-based index, a numeric string, a plain
// month name, or an object wrapping any of those.
function monthLabel(v: any): string {
  if (v == null || v === '') return '';
  if (typeof v === 'number') return MONTHS[v] ?? String(v);
  if (typeof v === 'string') {
    const n = Number(v);
    if (v.trim() !== '' && Number.isFinite(n) && n >= 0 && n < 12) return MONTHS[n];
    return v;
  }
  if (typeof v === 'object') {
    const m = v.month ?? v.name ?? v.label ?? v.value;
    return monthLabel(m);
  }
  return '';
}

// seconds -> "X hr Y min", mirroring StatsScreen's elapsedPretty spirit.
function hoursMinutes(seconds: number): string {
  const total = Math.max(0, Math.floor((seconds || 0) / 60));
  const h = Math.floor(total / 60);
  const m = total - h * 60;
  if (h && m) return `${h} hr ${m} min`;
  if (h) return `${h} hr`;
  return `${m} min`;
}

function formatNumber(n: number): string {
  return (n || 0).toLocaleString('en-US');
}

export default function YearInReviewScreen({ navigation, route }: any) {
  const colors = useThemeColors();
  const serverConfig = useUserStore((s) => s.serverConnectionConfig);
  const hasSession = usePlaybackStore((s) => s.currentSession !== null);
  const { isConnected } = useNetworkStatus();

  const year = safeYear(route?.params?.year);

  const [stats, setStats] = useState<YearStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadYear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year]);

  async function loadYear() {
    try {
      setLoading(true);
      setError(null);
      const response = await api.get<YearStats>(`/api/me/stats/year/${year}`);
      setStats(response.data || {});
    } catch (err: any) {
      setError(err?.message || 'Failed to load your year');
    } finally {
      setLoading(false);
    }
  }

  const serverAddress = (serverConfig?.address || '').replace(/\/$/, '');
  const token = serverConfig?.token || '';

  const booksFinished = stats?.numBooksFinished || 0;
  const totalTime = stats?.totalListeningTime || 0;
  const sessions = stats?.totalListeningSessions || 0;
  const booksListened = stats?.numBooksListened || 0;
  const totalHours = Math.floor(totalTime / 3600);
  const totalMinutes = Math.floor(totalTime / 60);
  // Under an hour, "0 hours" reads as "nothing listened" and buries a real
  // (if light) year. Surface the minutes as the headline instead.
  const heroUnderHour = totalHours < 1;
  // Under a minute, "0 minutes" headlines a real (if tiny) year as nothing —
  // drop to seconds so a non-empty year never reads as empty.
  const heroUnderMinute = heroUnderHour && totalMinutes < 1 && totalTime > 0;
  const heroValue = heroUnderMinute
    ? totalTime
    : heroUnderHour
    ? totalMinutes
    : totalHours;
  const heroUnit = heroUnderMinute
    ? totalTime === 1
      ? 'second'
      : 'seconds'
    : heroUnderHour
    ? totalMinutes === 1
      ? 'minute'
      : 'minutes'
    : totalHours === 1
    ? 'hour'
    : 'hours';

  const topAuthors = useMemo(() => listLabels(stats?.topAuthors, ['name', 'author']), [stats]);
  const topGenres = useMemo(() => listLabels(stats?.topGenres, ['genre', 'name']), [stats]);
  const narrator = nameOf(stats?.mostListenedNarrator, ['name', 'narrator']);
  const month = monthLabel(stats?.mostListenedMonth);

  const coverIds = useMemo(() => {
    const ids = stats?.finishedBooksWithCovers?.length
      ? stats.finishedBooksWithCovers
      : stats?.booksWithCovers || [];
    return (ids || []).filter((id): id is string => typeof id === 'string' && !!id).slice(0, 12);
  }, [stats]);

  const isEmpty =
    !!stats && booksFinished === 0 && totalTime === 0 && sessions === 0 && booksListened === 0;

  function buildShareText(): string {
    const lines = [
      `My ${year} in Audio`,
      `${formatNumber(heroValue)} ${heroUnit} listened`,
      `${formatNumber(booksFinished)} books finished`,
      `${formatNumber(sessions)} listening sessions`,
    ];
    if (topAuthors.length) lines.push(`Top author: ${topAuthors[0]}`);
    if (topGenres.length) lines.push(`Top genre: ${topGenres[0]}`);
    if (narrator) lines.push(`Most-listened narrator: ${narrator}`);
    if (month) lines.push(`Biggest month: ${month}`);
    return lines.join('\n');
  }

  async function handleShare() {
    try {
      await Share.share({ message: buildShareText() });
    } catch {
      // user cancelled / share unavailable — ignore
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }} edges={['top', 'left', 'right']}>
      {/* Header */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingTop: 8,
          paddingBottom: 16,
          paddingHorizontal: 16,
        }}
      >
        <HintPressable
          onPress={() => navigation.goBack()}
          style={{ paddingRight: 16, paddingVertical: 4 }}
          android_ripple={{ color: withAlpha(colors.onSurface, 0.12), borderless: true, radius: 22 }}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Icon name="back" size={24} color={colors.onSurface} />
        </HintPressable>
        <Text
          accessibilityRole="header"
          style={{ color: colors.onSurface, fontSize: 22, fontWeight: '600', flex: 1 }}
        >
          {`${year} in Audio`}
        </Text>
        {!loading && !error && !isEmpty && (
          <HintPressable
            onPress={handleShare}
            style={{ paddingLeft: 16, paddingVertical: 4 }}
            android_ripple={{ color: withAlpha(colors.onSurface, 0.12), borderless: true, radius: 22 }}
            accessibilityRole="button"
            accessibilityLabel="Share your year in audio"
          >
            <Icon name="share" size={22} color={colors.onSurface} />
          </HintPressable>
        )}
      </View>

      {loading ? (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : error ? (
        <ErrorState
          style={{ flex: 1 }}
          icon={!isConnected ? 'cloud-off' : 'warning'}
          title={!isConnected ? "You're offline" : "Couldn't load your year"}
          message={
            !isConnected
              ? 'Reconnect to see your Year in Audio.'
              : error
          }
          onRetry={loadYear}
        />
      ) : isEmpty ? (
        <EmptyState
          style={{ flex: 1 }}
          icon="headphones"
          title={`No listening in ${year} yet`}
          message="Once you start listening, your Year in Audio will appear here."
        />
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: hasSession ? 100 : 40 }}>
          {/* Hero */}
          <View style={{ paddingHorizontal: 24, marginBottom: 24 }}>
            <Text style={{ color: colors.onSurfaceVariant, fontSize: 15, marginBottom: 4 }}>
              Your Year in Audio
            </Text>
            <View accessible accessibilityLabel={`${formatNumber(heroValue)} ${heroUnit} listened, ${hoursMinutes(totalTime)}`}>
              <Text style={{ color: colors.primary, fontSize: 56, fontWeight: '800', lineHeight: 62 }}>
                {formatNumber(heroValue)}
              </Text>
              <Text style={{ color: colors.onSurface, fontSize: 18, fontWeight: '600' }}>
                {`${heroUnit} listened`}
              </Text>
              {/* Under an hour the headline already IS the minutes, so the
                  "X hr Y min" detail would just repeat it — only show it when
                  the headline is in hours. */}
              {!heroUnderHour && (
                <Text style={{ color: colors.onSurfaceVariant, fontSize: 13, marginTop: 2 }}>
                  {hoursMinutes(totalTime)}
                </Text>
              )}
            </View>
          </View>

          {/* Totals row */}
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'center',
              marginBottom: 28,
              paddingHorizontal: 16,
            }}
          >
            <Total value={formatNumber(booksFinished)} label="Books Finished" colors={colors} />
            <Total value={formatNumber(sessions)} label="Sessions" colors={colors} />
            <Total value={formatNumber(booksListened)} label="Books Started" colors={colors} />
          </View>

          {/* Cover collage */}
          {coverIds.length > 0 && (
            <View style={{ paddingHorizontal: 20, marginBottom: 28 }}>
              <Text
                accessibilityRole="header"
                style={{ color: colors.onSurface, fontSize: 20, marginBottom: 12, paddingHorizontal: 4 }}
              >
                Books You Finished
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
                {coverIds.map((id) => {
                  const url = coverUrl(id, serverAddress, token);
                  return (
                    <View
                      key={id}
                      style={{ width: '25%', padding: 4 }}
                      // Decorative collage — the "Books You Finished" header
                      // already conveys the group, so these 12 identical tiles
                      // are hidden from TalkBack rather than read as 12 stops.
                      accessibilityElementsHidden
                      importantForAccessibility="no-hide-descendants"
                    >
                      <View
                        style={{
                          aspectRatio: 1,
                          borderRadius: 6,
                          overflow: 'hidden',
                          backgroundColor: colors.surfaceContainerHigh,
                        }}
                      >
                        {url ? (
                          <Image
                            source={coverSource(url)}
                            style={{ width: '100%', height: '100%' }}
                            contentFit="cover"
                          />
                        ) : null}
                      </View>
                    </View>
                  );
                })}
              </View>
            </View>
          )}

          {/* Highlights */}
          {(topAuthors.length > 0 ||
            topGenres.length > 0 ||
            !!narrator ||
            !!month) && (
            <View style={{ paddingHorizontal: 24 }}>
              <Text
                accessibilityRole="header"
                style={{ color: colors.onSurface, fontSize: 20, marginBottom: 12 }}
              >
                Highlights
              </Text>

              {!!month && (
                <Highlight label="Biggest month" value={month} colors={colors} />
              )}
              {!!narrator && (
                <Highlight label="Most-listened narrator" value={narrator} colors={colors} />
              )}
              {topAuthors.length > 0 && (
                <Highlight label="Top authors" value={topAuthors.join(', ')} colors={colors} />
              )}
              {topGenres.length > 0 && (
                <Highlight label="Top genres" value={topGenres.join(', ')} colors={colors} />
              )}
            </View>
          )}

          {/* Share CTA */}
          <View style={{ paddingHorizontal: 24, marginTop: 28 }}>
            <HintPressable
              onPress={handleShare}
              accessibilityRole="button"
              accessibilityLabel="Share your year"
              android_ripple={{ color: withAlpha(colors.onPrimary, 0.12) }}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: colors.primary,
                borderRadius: 24,
                overflow: 'hidden',
                paddingVertical: 14,
              }}
            >
              <Icon name="share" size={20} color={colors.onPrimary} />
              <Text style={{ color: colors.onPrimary, fontSize: 16, fontWeight: '600', marginLeft: 8 }}>
                Share your year
              </Text>
            </HintPressable>
          </View>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function Total({ value, label, colors }: { value: string; label: string; colors: any }) {
  return (
    <View
      style={{ flex: 1, alignItems: 'center', paddingHorizontal: 4 }}
      accessible
      accessibilityLabel={`${value} ${label}`}
    >
      <Text style={{ color: colors.onSurface, fontSize: 28, fontWeight: '800' }}>{value}</Text>
      <Text
        style={{ color: colors.onSurfaceVariant, fontSize: 12, marginTop: 4, textAlign: 'center' }}
      >
        {label}
      </Text>
    </View>
  );
}

function Highlight({ label, value, colors }: { label: string; value: string; colors: any }) {
  return (
    <View
      style={{
        backgroundColor: colors.surfaceContainerHigh,
        borderRadius: 12,
        paddingVertical: 12,
        paddingHorizontal: 16,
        marginBottom: 10,
      }}
      accessible
      accessibilityLabel={`${label}: ${value}`}
    >
      <Text style={{ color: colors.onSurfaceVariant, fontSize: 12, marginBottom: 2 }}>{label}</Text>
      <Text style={{ color: colors.onSurface, fontSize: 16, fontWeight: '600' }}>{value}</Text>
    </View>
  );
}
