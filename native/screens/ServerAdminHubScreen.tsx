import React, { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator, RefreshControl } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useThemeColors } from "../theme/useThemeColors";
import Icon, { IconName } from "../components/Icon";
import ErrorState from "../components/ErrorState";
import TaskActivityCard from "../components/TaskActivityCard";
import TasksSheet from "../components/TasksSheet";
import { SectionHeader, Divider, NavRow } from "../components/SettingsRows";
import { refreshCapabilities, useServerCapabilities } from "../utils/abs/capabilities";
import { getTasksSnapshot, subscribeTasks } from "../utils/abs/tasks";
import type { AbsTask } from "../utils/abs/types";
import { usePlaybackStore } from "../store/usePlaybackStore";
import {
  getUsersSummary,
  getBackupsSummary,
  getLibrariesSummary,
} from "../utils/abs/adminSummaries";

// Compact "time since" for the Backups row subtitle (issue #64). utils/format
// has no relative helper, so this small inline formatter covers it, showing an
// absolute date for anything older than a month.
function formatRelativeTime(ts: number, now: number = Date.now()): string {
  const d = new Date(ts);
  // Unparseable timestamp — never render a blank subtitle.
  if (Number.isNaN(d.getTime())) return "recently";
  const diff = Math.max(0, now - ts);
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  // Absolute date for older backups. Format the Date directly rather than via
  // formatDateTime(ts), which treats a valid-but-falsy epoch of 0 (1970) as
  // "no value" and would leave the subtitle as "on " with a blank date.
  return `on ${d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
}

/**
 * ServerAdminHubScreen — the one hub for every server-administration surface
 * (architect plan §3 route table / UX plan §F1).
 *
 * Route: "ServerAdmin", no params. Entered from the Settings "Server
 * administration" section (admin-only).
 *
 * - Capability-gated: rows render only for admin/root users. On a cold-restored
 *   session the store user is a thin {id, username} with no `type`, so the hub
 *   fires refreshCapabilities() (POST /api/authorize) on mount and holds a
 *   spinner until it answers; a confirmed non-admin gets an explicit
 *   ErrorState — never a silently empty screen (UX plan §0.1).
 * - Live task strip: subscribes to the shared task poller (utils/abs/tasks)
 *   while the screen is focused — the subscription is dropped on blur and
 *   re-taken on focus, so the ref-counted poller stops when nobody is looking
 *   (battery contract).
 * - The "API keys" row is version-gated (supportsApiKeys) and HIDDEN on older
 *   servers rather than erroring (gating is advisory; the screens behind the
 *   rows still handle 404 → unsupported themselves).
 */

interface HubRow {
  icon: IconName;
  title: string;
  subtitle: string;
  route: string;
  hidden?: boolean;
}

export default function ServerAdminHubScreen({ navigation }: any) {
  const colors = useThemeColors();
  const caps = useServerCapabilities();
  const hasSession = usePlaybackStore((s) => s.currentSession !== null);

  // True once the mount-time refreshCapabilities() attempt has settled (it
  // never throws — offline just leaves capabilities degraded). Until then a
  // thin cold-restore user shows a spinner instead of a premature "no access".
  const [refreshDone, setRefreshDone] = useState(false);
  useEffect(() => {
    let mounted = true;
    refreshCapabilities().finally(() => {
      if (mounted) setRefreshDone(true);
    });
    return () => {
      mounted = false;
    };
  }, []);

  // Task strip: hold the poller subscription only while focused. The initial
  // subscription happens on mount (this screen mounts focused); react-navigation
  // "blur"/"focus" events drop/retake it so a pushed admin sub-screen doesn't
  // keep this screen's subscription alive underneath it.
  const [tasks, setTasks] = useState<AbsTask[]>(() => getTasksSnapshot());
  // Full-activity TasksSheet (issue #64) — opened from the task card's
  // "View all" footer; it renders the same live `tasks` snapshot, so rows
  // keep updating while the sheet is open.
  const [tasksSheetVisible, setTasksSheetVisible] = useState(false);
  useEffect(() => {
    if (!caps.isAdmin) return;
    let unsub: (() => void) | null = subscribeTasks(setTasks);
    const focusUnsub = navigation?.addListener?.("focus", () => {
      if (!unsub) {
        setTasks(getTasksSnapshot());
        unsub = subscribeTasks(setTasks);
      }
    });
    const blurUnsub = navigation?.addListener?.("blur", () => {
      unsub?.();
      unsub = null;
    });
    return () => {
      unsub?.();
      focusUnsub?.();
      blurUnsub?.();
    };
  }, [navigation, caps.isAdmin]);

  // Row summary subtitles (issue #64): cheap parallel fetches, refreshed on
  // focus, that annotate a few rows with a live count / recency. Keyed by route
  // so a row falls back to its static subtitle whenever its fetch is missing or
  // failed. `offline` drives the subtle offline hint (see loadSummaries).
  const [summaries, setSummaries] = useState<Record<string, string>>({});
  const [offline, setOffline] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Request-id + mounted guards: focus refetch and pull-to-refresh both call
  // loadSummaries, so a slow earlier fetch must not clobber a newer one's
  // counts, and none may setState after unmount.
  const latestSummaryReq = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadSummaries = useCallback(async () => {
    // Never throws: allSettled means one failing endpoint can't block the hub
    // or wipe the others' subtitles. A failed row keeps its last-known subtitle
    // (static until its first success).
    const reqId = ++latestSummaryReq.current;
    const [usersR, backupsR, librariesR] = await Promise.allSettled([
      getUsersSummary(),
      getBackupsSummary(),
      getLibrariesSummary(),
    ]);
    // A newer load started (or we unmounted) while this one was in flight —
    // drop this stale result rather than overwrite the fresher counts.
    if (!mountedRef.current || reqId !== latestSummaryReq.current) return;

    setSummaries((prev) => {
      const next = { ...prev };
      if (usersR.status === "fulfilled") {
        const { total, online } = usersR.value;
        const users = `${total} user${total === 1 ? "" : "s"}`;
        next.AdminUsers = online != null ? `${users} · ${online} online` : users;
      }
      if (backupsR.status === "fulfilled") {
        // Explicit null check — a valid epoch of 0 is still a real backup time.
        next.AdminBackups =
          backupsR.value.lastCreatedAt != null
            ? `Last backup ${formatRelativeTime(backupsR.value.lastCreatedAt)}`
            : "No backups yet";
      }
      if (librariesR.status === "fulfilled") {
        const n = librariesR.value.count;
        next.AdminLibraries = `${n} librar${n === 1 ? "y" : "ies"}`;
      }
      return next;
    });

    // Offline hint only when nothing loaded AND the reason was offline — a lone
    // offline blip on one endpoint while others answered isn't "the hub is
    // offline". The rows stay tappable regardless (destinations render their
    // own offline state); this is a visual hint, not a navigation block.
    const results = [usersR, backupsR, librariesR];
    const anyOk = results.some((r) => r.status === "fulfilled");
    const anyOffline = results.some(
      (r) => r.status === "rejected" && (r.reason as any)?.kind === "offline"
    );
    setOffline(anyOffline && !anyOk);
  }, []);

  // Fetch summaries once we know the viewer is an admin, and again on every
  // focus so a count changed on a sub-screen (a deleted user, a new backup) is
  // reflected when the admin pops back.
  useEffect(() => {
    if (!caps.isAdmin) return;
    loadSummaries();
    const focusUnsub = navigation?.addListener?.("focus", () => {
      loadSummaries();
    });
    return () => {
      focusUnsub?.();
    };
  }, [caps.isAdmin, navigation, loadSummaries]);

  // Pull-to-refresh re-runs both the capability probe and the summary fetches.
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([refreshCapabilities(), loadSummaries()]);
    } finally {
      setRefreshing(false);
    }
  }, [loadSummaries]);

  const groups: { label: string; rows: HubRow[] }[] = [
    {
      label: "Library",
      rows: [
        {
          icon: "library",
          title: "Libraries",
          subtitle: "Create, edit, scan, and match",
          route: "AdminLibraries",
        },
        {
          icon: "refresh",
          title: "Maintenance",
          subtitle: "Tags, genres, narrators, and cache",
          route: "AdminMaintenance",
        },
      ],
    },
    {
      label: "Users & access",
      rows: [
        {
          icon: "person",
          title: "Users",
          subtitle: "Accounts and permissions",
          route: "AdminUsers",
        },
        {
          icon: "clock",
          title: "Listening sessions",
          subtitle: "Review and clean up sessions",
          route: "AdminSessions",
        },
        {
          icon: "rss",
          title: "RSS feeds",
          // "Manage", not "Open": feeds are OPENED from the web dashboard —
          // this screen lists and closes them (in-app opening is tracked
          // separately).
          subtitle: "Manage open RSS feeds",
          route: "AdminFeeds",
        },
      ],
    },
    {
      label: "Server",
      rows: [
        {
          icon: "settings",
          title: "Server settings",
          subtitle: "Scanner and display options",
          route: "AdminServerSettings",
        },
        {
          icon: "lock",
          title: "API keys",
          subtitle: "Tokens for integrations",
          route: "AdminApiKeys",
          // Version gate: the /api/api-keys routes only exist on newer servers.
          hidden: !caps.supportsApiKeys,
        },
        {
          icon: "database",
          title: "Backups",
          subtitle: "Create and manage server backups",
          route: "AdminBackups",
        },
        {
          icon: "send",
          title: "Email",
          subtitle: "SMTP and e-reader devices",
          route: "AdminEmail",
        },
        {
          icon: "bell",
          title: "Notifications",
          subtitle: "Apprise event notifications",
          route: "AdminNotifications",
        },
        {
          icon: "logs",
          title: "Server logs",
          subtitle: "Read server log output",
          route: "AdminServerLogs",
        },
      ],
    },
  ];

  let body: React.ReactNode;
  if (caps.isAdmin) {
    body = (
      <>
      <ScrollView
        testID="admin-hub-scroll"
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: hasSession ? 100 : 48 }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
        }
      >
        {offline ? (
          <View
            testID="admin-hub-offline"
            accessibilityRole="alert"
            style={{
              flexDirection: "row",
              alignItems: "center",
              marginHorizontal: 20,
              marginTop: 16,
              paddingVertical: 10,
              paddingHorizontal: 14,
              borderRadius: 12,
              backgroundColor: colors.surfaceContainerHighest,
            }}
          >
            <Icon name="cloud-off" size={18} color={colors.onSurfaceVariant} style={{ marginRight: 10 }} />
            <Text style={{ color: colors.onSurfaceVariant, fontSize: 13, flex: 1 }}>
              Offline — live counts unavailable. Pull to refresh once you're back online.
            </Text>
          </View>
        ) : null}
        <TaskActivityCard tasks={tasks} onViewAll={() => setTasksSheetVisible(true)} />
        {groups.map((group) => {
          const rows = group.rows.filter((r) => !r.hidden);
          if (!rows.length) return null;
          return (
            <View key={group.label}>
              <SectionHeader label={group.label} colors={colors} />
              {rows.map((row, i) => (
                <View key={row.route}>
                  {i > 0 ? <Divider colors={colors} /> : null}
                  <NavRow
                    icon={row.icon}
                    title={row.title}
                    subtitle={summaries[row.route] ?? row.subtitle}
                    onPress={() => navigation.navigate(row.route)}
                    colors={colors}
                  />
                </View>
              ))}
            </View>
          );
        })}
      </ScrollView>
      <TasksSheet
        visible={tasksSheetVisible}
        tasks={tasks}
        onClose={() => setTasksSheetVisible(false)}
      />
      </>
    );
  } else if (!refreshDone) {
    // Thin cold-restore user: wait for /api/authorize before judging access.
    body = (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator testID="admin-hub-loading" size="large" color={colors.primary} />
      </View>
    );
  } else {
    body = (
      <ErrorState
        icon="lock"
        title="Admin access required"
        message="Your account doesn't have administrator access on this server."
        style={{ flex: 1 }}
      />
    );
  }

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: colors.surface }}
      edges={["top", "left", "right"]}
    >
      {/* Settings-family header (back + title), on the same 20/700 + hairline
          spec as every admin child screen so the whole family reads as one. */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 16,
          paddingVertical: 14,
          borderBottomWidth: 1,
          borderBottomColor: colors.outlineVariant,
        }}
      >
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", marginRight: 4 }}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Icon name="back" size={24} color={colors.onSurface} />
        </TouchableOpacity>
        <Text
          accessibilityRole="header"
          numberOfLines={1}
          style={{ color: colors.onSurface, fontSize: 20, fontWeight: "700", flex: 1 }}
        >
          Server administration
        </Text>
      </View>
      {body}
    </SafeAreaView>
  );
}
