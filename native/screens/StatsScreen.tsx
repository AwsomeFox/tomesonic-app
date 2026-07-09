import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
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
import { hasAnyPendingSyncs } from '../utils/progressSync';
import { storage } from '../utils/storage';
import { showAppDialog } from '../store/useDialogStore';

// MMKV keys owned by this screen for the local listening goal.
const GOAL_MINUTES_KEY = 'listeningGoalMinutes';
const GOAL_PERIOD_KEY = 'listeningGoalPeriod';
type GoalPeriod = 'daily' | 'weekly';

// new Date() can be faked/garbage in tests — derive the calendar year/month
// defensively so the seasonal banner + Year-in-Review link never NaN out.
function currentYearSafe(): number {
  try {
    const y = new Date().getFullYear();
    if (Number.isFinite(y) && y >= 1970 && y <= 3000) return y;
  } catch {}
  return 2024;
}
function currentMonthSafe(): number {
  try {
    const m = new Date().getMonth();
    if (Number.isFinite(m) && m >= 0 && m <= 11) return m;
  } catch {}
  return -1;
}

// Gold accent for the data-viz line, matching the original app's `yellow-400`.
// The original app is dark-first — against a LIGHT surface yellow-400 is
// ~1.5:1 (invisible), so light theme swaps to a darker amber (~3:1+).
const CHART_GOLD = 'rgb(250, 204, 21)';
const CHART_GOLD_ON_LIGHT = 'rgb(180, 130, 10)';

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

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Local calendar date N days before today. Uses setDate (not ms arithmetic)
 *  so DST transitions can't skip or double-count a calendar day. */
function daysAgo(n: number): Date {
  const d = new Date();
  d.setHours(12, 0, 0, 0); // noon: immune to the 23/25-hour DST days
  d.setDate(d.getDate() - n);
  return d;
}

interface DayPoint {
  label: string;
  date: string;
  minutes: number;
}

// Build the last 7 days (oldest -> newest), matching DailyListeningChart.vue.
function buildLast7Days(days: Record<string, number>): DayPoint[] {
  const out: DayPoint[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = daysAgo(i);
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
  const progressMap = useUserStore((state) => state.mediaProgress);
  const loadMediaProgress = useUserStore((state) => state.loadMediaProgress);
  const hasSession = usePlaybackStore((s) => s.currentSession !== null);
  const [stats, setStats] = useState<ListeningStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingSync, setPendingSync] = useState(false);
  const { isConnected } = useNetworkStatus();

  // Local listening goal (persisted to MMKV). Default: no goal set.
  const [goalMinutes, setGoalMinutes] = useState<number | null>(null);
  const [goalPeriod, setGoalPeriod] = useState<GoalPeriod>('daily');
  const [editingGoal, setEditingGoal] = useState(false);
  const [draftMinutes, setDraftMinutes] = useState(30);
  const [draftPeriod, setDraftPeriod] = useState<GoalPeriod>('daily');

  // Load the saved goal once on mount.
  useEffect(() => {
    try {
      const savedMin = storage.getNumber(GOAL_MINUTES_KEY);
      const savedPeriod = storage.getString(GOAL_PERIOD_KEY);
      if (typeof savedMin === 'number' && savedMin > 0) setGoalMinutes(savedMin);
      if (savedPeriod === 'weekly' || savedPeriod === 'daily') setGoalPeriod(savedPeriod);
    } catch {}
  }, []);

  function openGoalEditor() {
    setDraftMinutes(goalMinutes && goalMinutes > 0 ? goalMinutes : 30);
    setDraftPeriod(goalPeriod);
    setEditingGoal(true);
  }

  function saveGoal() {
    const mins = Math.max(5, Math.round(draftMinutes));
    try {
      storage.set(GOAL_MINUTES_KEY, mins);
      storage.set(GOAL_PERIOD_KEY, draftPeriod);
    } catch {}
    setGoalMinutes(mins);
    setGoalPeriod(draftPeriod);
    setEditingGoal(false);
  }

  // Removing a goal wipes the saved target and its progress, so confirm first
  // via the themed dialog (never the OS Alert, which ignores our M3 theme).
  function removeGoal() {
    showAppDialog({
      title: 'Remove goal?',
      message: 'Your listening goal and its progress will be cleared.',
      buttons: [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: confirmRemoveGoal },
      ],
    });
  }

  function confirmRemoveGoal() {
    try {
      storage.remove(GOAL_MINUTES_KEY);
      storage.remove(GOAL_PERIOD_KEY);
    } catch {}
    setGoalMinutes(null);
    setEditingGoal(false);
  }

  // 'focus' fires on the initial mount too, so this both loads the screen and
  // refreshes it when the user comes back — a listening session that ended
  // since the last visit (or the mini player playing on top) shows up.
  useEffect(() => {
    const unsub = navigation.addListener('focus', () => {
      loadStats();
      // Ensure the progress map is fresh (Items Finished counts from it).
      loadMediaProgress().catch(() => {});
      try {
        setPendingSync(hasAnyPendingSyncs());
      } catch {}
    });
    return unsub;
  }, [navigation]);

  // While listening time is still syncing, re-check periodically so the
  // caption clears itself — and the freshly-landed minutes render — when the
  // background flush completes. Focus alone left the caption stuck if the
  // user stayed on the screen through a reconnect. The interval exists only
  // while the caption is showing, so there's no idle polling cost.
  useEffect(() => {
    if (!pendingSync) return;
    const id = setInterval(() => {
      let still = true;
      try {
        still = hasAnyPendingSyncs();
      } catch {}
      if (!still) {
        setPendingSync(false);
        loadStats();
      }
    }, 5000);
    return () => clearInterval(id);
  }, [pendingSync]);

  const hasDataRef = React.useRef(false);

  async function loadStats() {
    try {
      // Full-screen spinner only on first load; focus refreshes are silent so
      // the rendered stats don't flash away.
      if (!hasDataRef.current) setLoading(true);
      setError(null);
      const response = await api.get<ListeningStats>('/api/me/listening-stats');
      setStats(response.data);
      hasDataRef.current = true;
    } catch (err: any) {
      if (!hasDataRef.current) setError(err?.message || 'Failed to load stats');
    } finally {
      setLoading(false);
    }
  }

  // Count from the store's progress map — the `user` object only carries a
  // mediaProgress array right after a fresh login (not after app restart),
  // which made this stat read 0 most of the time.
  const itemsFinished = Object.values(progressMap || {}).filter((p: any) => !!p?.isFinished).length;
  const days = stats?.days ?? {};
  const daysListened = Object.keys(days).length;
  const minutesListening = stats ? Math.round(stats.totalTime / 60) : 0;
  const recentSessions = stats?.recentSessions ?? [];

  const last7 = buildLast7Days(days);
  const weekMinutes = last7.reduce((sum, d) => sum + d.minutes, 0);
  const dailyAverage = Math.round(weekMinutes / 7);
  const bestDay = last7.reduce((m, d) => Math.max(m, d.minutes), 0);

  // Consecutive days (including today) with listening, matching daysInARow.
  // Today with no listening *yet* isn't a break — otherwise the streak would
  // read 0 every morning until the first listen of the day. Only a gap before
  // the run ends the streak.
  let daysInARow = 0;
  for (let i = 0; i < 10000; i++) {
    const key = ymd(daysAgo(i));
    if (!days[key]) {
      if (i === 0) continue;
      break;
    }
    daysInARow++;
  }

  // Goal progress. Read today's minutes off the local calendar day rather than
  // the server's `today` field, whose timezone-naive boundary can attribute
  // late-night listening to the wrong day. days[] is keyed by the same DST-safe
  // local YYYY-MM-DD as the streak logic above (daysAgo/ymd both use noon +
  // setDate, so they can't skip or double-count a calendar day across DST).
  const todayKey = ymd(daysAgo(0));
  const todayMinutes = Math.round((days[todayKey] || 0) / 60);
  const goalCurrent = goalPeriod === 'weekly' ? weekMinutes : todayMinutes;
  const goalPct =
    goalMinutes && goalMinutes > 0 ? Math.min(1, goalCurrent / goalMinutes) : 0;
  const goalMet = !!goalMinutes && goalCurrent >= goalMinutes;

  // Seasonal Year-in-Review banner (Dec/Jan), reachable year-round otherwise.
  const month = currentMonthSafe();
  const seasonal = month === 11 || month === 0;
  // In January the just-started current year holds only ~a week of listening —
  // nobody wants that as their "Year in Review", so default to the year that
  // just ended. December (and the rest of the year) uses the current year.
  const currentYear = currentYearSafe();
  const reviewYear = month === 0 ? currentYear - 1 : currentYear;

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
          style={{ color: colors.onSurface, fontSize: 22, fontWeight: '600' }}
        >
          Your Stats
        </Text>
      </View>

      {loading ? (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : error ? (
        <ErrorState
          style={{ flex: 1 }}
          title="Couldn't load stats"
          message={error}
          onRetry={loadStats}
        />
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

          {/* Prominent streak banner */}
          {daysInARow > 0 && (
            <View
              accessible
              accessibilityLabel={`Current streak: ${daysInARow} ${daysInARow === 1 ? 'day' : 'days'} in a row`}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                marginHorizontal: 20,
                marginBottom: 20,
                paddingVertical: 12,
                paddingHorizontal: 16,
                borderRadius: 14,
                backgroundColor: colors.secondaryContainer,
              }}
            >
              <Icon name="headphones" size={22} color={colors.onSecondaryContainer} />
              <Text
                style={{
                  color: colors.onSecondaryContainer,
                  fontSize: 15,
                  fontWeight: '700',
                  marginLeft: 10,
                }}
              >
                {daysInARow}-day streak
              </Text>
              <Text
                style={{ color: colors.onSecondaryContainer, fontSize: 13, marginLeft: 8, flex: 1 }}
                numberOfLines={1}
              >
                {'Keep it going!'}
              </Text>
            </View>
          )}

          {/* Year in Review entry — highlighted in Dec/Jan, reachable year-round */}
          <HintPressable
            onPress={() => navigation.navigate('YearInReview', { year: reviewYear })}
            accessibilityRole="button"
            accessibilityLabel={`Your ${reviewYear} in Audio`}
            android_ripple={{ color: withAlpha(colors.onPrimaryContainer, 0.12) }}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              marginHorizontal: 20,
              marginBottom: 20,
              paddingVertical: 14,
              paddingHorizontal: 16,
              borderRadius: 14,
              backgroundColor: seasonal ? colors.primaryContainer : colors.surfaceContainerHigh,
            }}
          >
            <Icon
              name="calendar"
              size={22}
              color={seasonal ? colors.onPrimaryContainer : colors.onSurface}
            />
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text
                style={{
                  color: seasonal ? colors.onPrimaryContainer : colors.onSurface,
                  fontSize: 16,
                  fontWeight: '700',
                }}
              >
                Your Year in Audio
              </Text>
              <Text
                style={{
                  color: seasonal ? colors.onPrimaryContainer : colors.onSurfaceVariant,
                  fontSize: 13,
                  marginTop: 2,
                }}
                numberOfLines={1}
              >
                {seasonal ? `${reviewYear} wrapped — see your highlights` : `Look back on ${reviewYear}`}
              </Text>
            </View>
            <Icon
              name="chevron-right"
              size={22}
              color={seasonal ? colors.onPrimaryContainer : colors.onSurfaceVariant}
            />
          </HintPressable>

          {/* Listening goal */}
          <View
            style={{
              marginHorizontal: 20,
              marginBottom: 24,
              paddingVertical: 14,
              paddingHorizontal: 16,
              borderRadius: 14,
              backgroundColor: colors.surfaceContainerHigh,
            }}
          >
            {goalMinutes && !editingGoal ? (
              <>
                <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
                  <Text style={{ color: colors.onSurface, fontSize: 16, fontWeight: '700', flex: 1 }}>
                    {goalPeriod === 'weekly' ? 'Weekly goal (last 7 days)' : 'Daily goal'}
                  </Text>
                  <HintPressable
                    onPress={openGoalEditor}
                    accessibilityRole="button"
                    accessibilityLabel="Edit listening goal"
                    android_ripple={{ color: withAlpha(colors.onSurface, 0.12), borderless: true, radius: 20 }}
                    style={{ padding: 4 }}
                  >
                    <Icon name="edit" size={18} color={colors.onSurfaceVariant} />
                  </HintPressable>
                </View>
                <Text
                  accessibilityLabel={`Goal progress: ${goalCurrent} of ${goalMinutes} minutes${goalMet ? ', goal met' : ''}`}
                  style={{ color: colors.onSurfaceVariant, fontSize: 13, marginBottom: 8 }}
                >
                  {goalCurrent} / {goalMinutes} min{goalMet ? ' — goal met!' : ''}
                </Text>
                {/* Progress bar */}
                <View
                  style={{
                    height: 10,
                    borderRadius: 5,
                    backgroundColor: colors.surfaceContainerHighest,
                    overflow: 'hidden',
                  }}
                >
                  <View
                    style={{
                      width: `${Math.round(goalPct * 100)}%`,
                      height: '100%',
                      borderRadius: 5,
                      backgroundColor: goalMet ? colors.success : colors.primary,
                    }}
                  />
                </View>
              </>
            ) : editingGoal ? (
              <>
                <Text style={{ color: colors.onSurface, fontSize: 16, fontWeight: '700', marginBottom: 12 }}>
                  Set a listening goal
                </Text>
                {/* Period toggle */}
                <View style={{ flexDirection: 'row', marginBottom: 14 }}>
                  {(['daily', 'weekly'] as GoalPeriod[]).map((p) => {
                    const active = draftPeriod === p;
                    return (
                      <HintPressable
                        key={p}
                        onPress={() => setDraftPeriod(p)}
                        accessibilityRole="button"
                        accessibilityLabel={`${p === 'daily' ? 'Daily' : 'Weekly'} goal`}
                        accessibilityState={{ selected: active }}
                        style={{
                          flex: 1,
                          paddingVertical: 8,
                          marginRight: p === 'daily' ? 8 : 0,
                          borderRadius: 10,
                          alignItems: 'center',
                          backgroundColor: active ? colors.primary : colors.surfaceContainerHighest,
                        }}
                      >
                        <Text
                          style={{
                            color: active ? colors.onPrimary : colors.onSurface,
                            fontSize: 14,
                            fontWeight: '600',
                          }}
                        >
                          {p === 'daily' ? 'Daily' : 'Weekly'}
                        </Text>
                      </HintPressable>
                    );
                  })}
                </View>
                {/* Minutes stepper */}
                <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 16 }}>
                  <HintPressable
                    onPress={() => setDraftMinutes((m) => Math.max(5, m - 5))}
                    accessibilityRole="button"
                    accessibilityLabel="Decrease goal by 5 minutes"
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: 20,
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: colors.surfaceContainerHighest,
                    }}
                  >
                    <Text style={{ color: colors.onSurface, fontSize: 22, fontWeight: '700' }}>−</Text>
                  </HintPressable>
                  <View style={{ flex: 1, alignItems: 'center' }}>
                    <Text
                      accessibilityLabel={`${draftMinutes} minutes`}
                      style={{ color: colors.onSurface, fontSize: 24, fontWeight: '800' }}
                    >
                      {draftMinutes} min
                    </Text>
                  </View>
                  <HintPressable
                    onPress={() => setDraftMinutes((m) => m + 5)}
                    accessibilityRole="button"
                    accessibilityLabel="Increase goal by 5 minutes"
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: 20,
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: colors.surfaceContainerHighest,
                    }}
                  >
                    <Text style={{ color: colors.onSurface, fontSize: 22, fontWeight: '700' }}>+</Text>
                  </HintPressable>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <HintPressable
                    onPress={saveGoal}
                    accessibilityRole="button"
                    accessibilityLabel="Save goal"
                    style={{
                      flex: 1,
                      paddingVertical: 12,
                      borderRadius: 22,
                      alignItems: 'center',
                      backgroundColor: colors.primary,
                    }}
                  >
                    <Text style={{ color: colors.onPrimary, fontSize: 15, fontWeight: '600' }}>Save</Text>
                  </HintPressable>
                  {goalMinutes ? (
                    <HintPressable
                      onPress={removeGoal}
                      accessibilityRole="button"
                      accessibilityLabel="Remove goal"
                      style={{ marginLeft: 12, paddingVertical: 12, paddingHorizontal: 16 }}
                    >
                      <Text style={{ color: colors.error, fontSize: 15, fontWeight: '600' }}>Remove</Text>
                    </HintPressable>
                  ) : (
                    <HintPressable
                      onPress={() => setEditingGoal(false)}
                      accessibilityRole="button"
                      accessibilityLabel="Cancel"
                      style={{ marginLeft: 12, paddingVertical: 12, paddingHorizontal: 16 }}
                    >
                      <Text style={{ color: colors.onSurfaceVariant, fontSize: 15, fontWeight: '600' }}>
                        Cancel
                      </Text>
                    </HintPressable>
                  )}
                </View>
              </>
            ) : (
              <HintPressable
                onPress={openGoalEditor}
                accessibilityRole="button"
                accessibilityLabel="Set a listening goal"
                style={{ flexDirection: 'row', alignItems: 'center' }}
              >
                <Icon name="add" size={22} color={colors.primary} />
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={{ color: colors.onSurface, fontSize: 16, fontWeight: '700' }}>
                    Set a listening goal
                  </Text>
                  <Text style={{ color: colors.onSurfaceVariant, fontSize: 13, marginTop: 2 }}>
                    Track daily or weekly minutes
                  </Text>
                </View>
                <Icon name="chevron-right" size={22} color={colors.onSurfaceVariant} />
              </HintPressable>
            )}
          </View>

          {/* Chart heading */}
          <Text
            accessibilityRole="header"
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

          {(!isConnected || pendingSync) && (
            <Text
              style={{
                color: colors.onSurfaceVariant,
                fontSize: 12,
                paddingHorizontal: 24,
                marginTop: 8,
              }}
            >
              {!isConnected
                ? "You're offline — recent listening will be added to these stats once you reconnect."
                : 'Some recent listening is still syncing and may not be reflected yet.'}
            </Text>
          )}

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
            accessibilityRole="header"
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
                  accessible
                  accessibilityLabel={`${session.mediaMetadata?.title || session.displayTitle || 'Session'}, ${dateDistanceFromNow(session.updatedAt)}, ${elapsedPretty(session.timeListening)}`}
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
              <EmptyState icon="clock" title="No listening sessions yet" />
            )}
          </View>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function StatTotal({ label, value }: { label: string; value: string }) {
  const colors = useThemeColors();
  return (
    // Grouped so TalkBack reads "1,234 Items Finished" as one item instead of
    // the number and its label as two disconnected nodes.
    <View
      style={{ flex: 1, alignItems: 'center', paddingHorizontal: 4 }}
      accessible
      accessibilityLabel={`${value} ${label}`}
    >
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
    <View
      style={{ flex: 1, alignItems: 'center', paddingHorizontal: 2 }}
      accessible
      accessibilityLabel={`${title}: ${value} ${unit}`}
    >
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
  const chartAccent = colors.isDark ? CHART_GOLD : CHART_GOLD_ON_LIGHT;
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

  // TalkBack can't read a chart drawn from bare Views, so expose the series as
  // a single spoken summary and hide the decorative plot geometry beneath it.
  const chartSummary =
    'Minutes listening over the last 7 days. ' +
    data.map((d) => `${d.label} ${d.minutes}`).join(', ') +
    '.';

  return (
    <View
      style={{ paddingHorizontal: 24 }}
      accessible
      accessibilityRole="image"
      accessibilityLabel={chartSummary}
    >
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
                    backgroundColor: chartAccent,
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
                    backgroundColor: chartAccent,
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
