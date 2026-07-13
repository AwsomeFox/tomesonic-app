import React, { useEffect, useState } from "react";
import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useThemeColors } from "../theme/useThemeColors";
import Icon, { IconName } from "../components/Icon";
import ErrorState from "../components/ErrorState";
import TaskActivityCard from "../components/TaskActivityCard";
import { SectionHeader, Divider, NavRow } from "../components/SettingsRows";
import { refreshCapabilities, useServerCapabilities } from "../utils/abs/capabilities";
import { getTasksSnapshot, subscribeTasks } from "../utils/abs/tasks";
import type { AbsTask } from "../utils/abs/types";
import { usePlaybackStore } from "../store/usePlaybackStore";

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
          subtitle: "Open podcast feeds",
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
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: hasSession ? 100 : 48 }}
      >
        <TaskActivityCard tasks={tasks} />
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
                    subtitle={row.subtitle}
                    onPress={() => navigation.navigate(row.route)}
                    colors={colors}
                  />
                </View>
              ))}
            </View>
          );
        })}
      </ScrollView>
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
      {/* Settings-family header (back + title) so the admin area reads as part
          of the Settings family, not a pushed content screen. */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
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
        <Text style={{ color: colors.onSurface, fontSize: 22, fontWeight: "600" }}>
          Server administration
        </Text>
      </View>
      {body}
    </SafeAreaView>
  );
}
