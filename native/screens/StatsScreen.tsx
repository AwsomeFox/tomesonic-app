import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { api } from '../utils/api';
import { useThemeColors } from '../theme/useThemeColors';
import Icon from '../components/Icon';
import { useUserStore } from '../store/useUserStore';
import { usePlaybackStore } from '../store/usePlaybackStore';

// Gold accent for the data-viz line, matching the original app's `yellow-400`.
// This is a chart accent, not a theme role, so it is intentionally fixed.
const CHART_GOLD = 'rgb(250, 204, 21)';

interface RecentSession {
  id?: string;
  mediaMetadata?: { title?: string };
  displayTitle?: string;
  displayAuthor?: string;
  timeListening: number;
  updatedAt?: number;
}

interface ListeningStats {
  totalTime: number;
  days: Record<string, number>;
  today: number;
  recentSessions: RecentSession[];
}

// Mirrors the original app's $elapsedPretty helper
function elapsedPretty(seconds: number): string {
  if (!seconds || seconds < 60) {
    return `${Math.floor(seconds || 0)} sec`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 70) {
    return `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  const min = minutes - hours * 60;
  if (!min) {
    return `${hours} hr`;
  }
  return `${hours} hr ${min} min`;
}

function dateDistanceFromNow(ts?: number): string {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  const days = Math.floor(hrs / 24);
  if (days < 30) return days + 'd ago';
  const months = Math.floor(days / 30);
  if (months < 12) return months + 'mo ago';
  return Math.floor(months / 12) + 'y ago';
}

function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

interface DayPoint {
  label: string;
  date: string;
  minutes: number;
}

// Build the last 7 days (oldest -> newest), matching DailyListeningChart.vue.
function buildLast7Days(days: Record<string, number>): DayPoint[] {
  const now = new Date();
  const out: DayPoint[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getTime() - i * DAY_MS);
    const key = ymd(d);
    out.push({
      label: DOW[d.getDay()],
      date: key,
      minutes: Math.round((days?.[key] || 0) / 60),
    });
  }
  return out;
}

export default function StatsScreen({ navigation }: any) {
  const colors = useThemeColors();
  const user = useUserStore((state) => state.user);
  const hasSession = usePlaybackStore((s) => s.currentSession !== null);
  const [stats, setStats] = useState<ListeningStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadStats();
  }, []);

  async function loadStats() {
    try {
      setLoading(true);
      setError(null);
      const response = await api.get<ListeningStats>('/api/me/listening-stats');
      setStats(response.data);
    } catch (err: any) {
      setError(err?.message || 'Failed to load stats');
    } finally {
      setLoading(false);
    }
  }

  const mediaProgress: any[] = Array.isArray(user?.mediaProgress) ? user.mediaProgress : [];
  const itemsFinished = mediaProgress.filter((lip) => !!lip?.isFinished).length;
  const days = stats?.days ?? {};
  const daysListened = Object.keys(days).length;
  const minutesListening = stats ? Math.round(stats.totalTime / 60) : 0;
  const recentSessions = stats?.recentSessions ?? [];

  const last7 = buildLast7Days(days);
  const weekMinutes = last7.reduce((sum, d) => sum + d.minutes, 0);
  const dailyAverage = Math.round(weekMinutes / 7);
  const bestDay = last7.reduce((m, d) => Math.max(m, d.minutes), 0);

  // Consecutive days (including today) with listening, matching daysInARow.
  let daysInARow = 0;
  {
    const now = new Date();
    for (let i = 0; i < 10000; i++) {
      const key = ymd(new Date(now.getTime() - i * DAY_MS));
      if (!days[key]) break;
      daysInARow++;
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      {/* Header */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingTop: 56,
          paddingBottom: 16,
          paddingHorizontal: 16,
        }}
      >
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={{ paddingRight: 16, paddingVertical: 4 }}
        >
          <Icon name="back" size={24} color={colors.onSurface} />
        </TouchableOpacity>
        <Text style={{ color: colors.onSurface, fontSize: 22, fontWeight: '600' }}>
          Your Stats
        </Text>
      </View>

      {loading ? (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : error ? (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 32 }}>
          <Text style={{ color: colors.error, fontSize: 15, textAlign: 'center', marginBottom: 16 }}>
            {error}
          </Text>
          <TouchableOpacity
            onPress={loadStats}
            style={{
              backgroundColor: colors.primary,
              paddingHorizontal: 24,
              paddingVertical: 10,
              borderRadius: 8,
            }}
          >
            <Text style={{ color: colors.onPrimary, fontWeight: '600', fontSize: 14 }}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: hasSession ? 100 : 40 }}>
          {/* Totals row */}
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'center',
              marginTop: 4,
              marginBottom: 32,
              paddingHorizontal: 16,
            }}
          >
            <StatTotal value={formatNumber(itemsFinished)} label="Items Finished" />
            <StatTotal value={formatNumber(daysListened)} label="Days Listened" />
            <StatTotal value={formatNumber(minutesListening)} label="Minutes Listening" />
          </View>

          {/* Chart heading */}
          <Text
            style={{
              color: colors.onSurface,
              fontSize: 24,
              marginBottom: 8,
              paddingHorizontal: 24,
            }}
          >
            Minutes Listening (last 7 days)
          </Text>

          <ListeningChart data={last7} colors={colors} />

          {/* 4-up mini stats */}
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              marginTop: 32,
              marginBottom: 8,
              paddingHorizontal: 20,
            }}
          >
            <MiniStat title="Week Listening" value={formatNumber(weekMinutes)} unit="minutes" colors={colors} />
            <MiniStat title="Daily Average" value={formatNumber(dailyAverage)} unit="minutes" colors={colors} />
            <MiniStat title="Best Day" value={formatNumber(bestDay)} unit="minutes" colors={colors} />
            <MiniStat title="Days" value={formatNumber(daysInARow)} unit="in a row" colors={colors} />
          </View>

          {/* Recent Sessions */}
          <Text
            style={{
              color: colors.onSurface,
              fontSize: 24,
              marginTop: 32,
              marginBottom: 12,
              paddingHorizontal: 24,
            }}
          >
            Recent Sessions
          </Text>

          <View style={{ paddingHorizontal: 24 }}>
            {recentSessions.length > 0 ? (
              recentSessions.map((session, index) => (
                <View
                  key={session.id || index}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingVertical: 6,
                  }}
                >
                  <Text style={{ color: colors.onSurfaceVariant, fontSize: 13, width: 28 }}>
                    {index + 1}.
                  </Text>
                  <View style={{ flex: 1, marginRight: 12 }}>
                    <Text
                      style={{ color: colors.onSurface, fontSize: 14 }}
                      numberOfLines={1}
                    >
                      {session.mediaMetadata?.title || session.displayTitle || ''}
                    </Text>
                    <Text
                      style={{ color: colors.onSurfaceVariant, fontSize: 12, marginTop: 2 }}
                      numberOfLines={1}
                    >
                      {dateDistanceFromNow(session.updatedAt)}
                    </Text>
                  </View>
                  <Text style={{ color: colors.onSurface, fontSize: 12, fontWeight: '700' }}>
                    {elapsedPretty(session.timeListening)}
                  </Text>
                </View>
              ))
            ) : (
              <Text style={{ color: colors.onSurfaceVariant, fontSize: 14, paddingVertical: 16 }}>
                No listening sessions yet
              </Text>
            )}
          </View>
        </ScrollView>
      )}
    </View>
  );
}

function StatTotal({ label, value }: { label: string; value: string }) {
  const colors = useThemeColors();
  return (
    <View style={{ flex: 1, alignItems: 'center', paddingHorizontal: 4 }}>
      <Text style={{ color: colors.onSurface, fontSize: 30, fontWeight: '800' }}>{value}</Text>
      <Text
        style={{ color: colors.onSurfaceVariant, fontSize: 12, marginTop: 4, textAlign: 'center' }}
      >
        {label}
      </Text>
    </View>
  );
}

function MiniStat({
  title,
  value,
  unit,
  colors,
}: {
  title: string;
  value: string;
  unit: string;
  colors: any;
}) {
  return (
    <View style={{ flex: 1, alignItems: 'center', paddingHorizontal: 2 }}>
      <Text
        style={{ color: colors.onSurface, fontSize: 12, textAlign: 'center' }}
        numberOfLines={1}
      >
        {title}
      </Text>
      <Text style={{ color: colors.onSurface, fontSize: 34, fontWeight: '700', lineHeight: 40 }}>
        {value}
      </Text>
      <Text style={{ color: colors.onSurface, fontSize: 12, textAlign: 'center' }} numberOfLines={1}>
        {unit}
      </Text>
    </View>
  );
}

// View-based line chart (react-native-svg is not installed). Renders a gold
// polyline via rotated segment Views + dots over a gridded plot area, with a
// left Y axis and weekday labels along the bottom — matching screenshot 13.
function ListeningChart({ data, colors }: { data: DayPoint[]; colors: any }) {
  const PLOT_H = 220;
  const Y_LABEL_W = 30;
  const DOT = 9;

  // Y axis: 6 steps like the original (yAxisFactor = ceil(bestDay / 5)).
  const bestDay = data.reduce((m, d) => Math.max(m, d.minutes), 0);
  let factor = Math.ceil(bestDay / 5);
  if (factor > 25) factor = Math.ceil(factor / 5) * 5;
  factor = Math.max(1, factor);
  const yMax = factor * 6;
  const yLabels: number[] = [];
  for (let i = 6; i >= 0; i--) yLabels.push(i * factor);

  const [plotW, setPlotW] = useState(0);
  const stepX = data.length > 1 ? plotW / (data.length - 1) : 0;

  // Point coords in plot space (origin top-left, y grows downward).
  const points = data.map((d, i) => {
    const yPct = yMax > 0 ? Math.min(1, d.minutes / yMax) : 0;
    return { x: i * stepX, y: PLOT_H - yPct * PLOT_H };
  });

  const segments = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const width = Math.sqrt(dx * dx + dy * dy);
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
    segments.push({ x: a.x, y: a.y, width, angle });
  }

  return (
    <View style={{ paddingHorizontal: 24 }}>
      <View style={{ flexDirection: 'row' }}>
        {/* Y axis labels */}
        <View style={{ width: Y_LABEL_W, height: PLOT_H }}>
          {yLabels.map((lbl, i) => (
            <View
              key={i}
              style={{
                position: 'absolute',
                top: (PLOT_H / 6) * i - 8,
                right: 6,
                width: Y_LABEL_W,
                alignItems: 'flex-end',
              }}
            >
              <Text style={{ color: colors.onSurface, fontSize: 11, fontWeight: '600' }}>
                {lbl}
              </Text>
            </View>
          ))}
        </View>

        {/* Plot area */}
        <View
          style={{ flex: 1, height: PLOT_H }}
          onLayout={(e) => setPlotW(e.nativeEvent.layout.width)}
        >
          {/* Gridlines */}
          {yLabels.map((_, i) => (
            <View
              key={i}
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                top: (PLOT_H / 6) * i,
                height: 1,
                backgroundColor: colors.outlineVariant,
                opacity: 0.5,
              }}
            />
          ))}

          {plotW > 0 && (
            <>
              {/* Line segments */}
              {segments.map((s, i) => (
                <View
                  key={`seg-${i}`}
                  style={{
                    position: 'absolute',
                    left: s.x,
                    top: s.y,
                    width: s.width,
                    height: 2.5,
                    backgroundColor: CHART_GOLD,
                    transform: [
                      { translateY: -1.25 },
                      { rotateZ: `${s.angle}deg` },
                    ],
                    // rotate around the left edge, not the center
                    transformOrigin: 'left center',
                  }}
                />
              ))}

              {/* Dots */}
              {points.map((p, i) => (
                <View
                  key={`dot-${i}`}
                  style={{
                    position: 'absolute',
                    left: p.x - DOT / 2,
                    top: p.y - DOT / 2,
                    width: DOT,
                    height: DOT,
                    borderRadius: DOT / 2,
                    backgroundColor: CHART_GOLD,
                  }}
                />
              ))}
            </>
          )}
        </View>
      </View>

      {/* X axis weekday labels, edge-anchored to line up under the points */}
      <View style={{ marginLeft: Y_LABEL_W, height: 20, marginTop: 6 }}>
        {plotW > 0 &&
          data.map((d, i) => {
            const align =
              i === 0 ? 'flex-start' : i === data.length - 1 ? 'flex-end' : 'center';
            return (
              <View
                key={i}
                style={{
                  position: 'absolute',
                  left: i * stepX - stepX / 2,
                  width: stepX,
                  alignItems: align as any,
                }}
              >
                <Text style={{ color: colors.onSurface, fontSize: 13 }}>{d.label}</Text>
              </View>
            );
          })}
      </View>
    </View>
  );
}
