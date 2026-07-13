import React, { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  FlatList,
  Pressable,
  ActivityIndicator,
  RefreshControl,
  TouchableOpacity,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useThemeColors } from "../theme/useThemeColors";
import Icon from "../components/Icon";
import ErrorState from "../components/ErrorState";
import StatusChip from "../components/StatusChip";
import { usePolling } from "../hooks/usePolling";
import { getUsers, getOnlineUsers } from "../utils/abs/users";
import { absErrorToErrorStateProps } from "../utils/abs/errors";
import type { AbsUser } from "../utils/abs/types";

/**
 * AdminUsersScreen — the server's user accounts (admin-only).
 *
 * Route: "AdminUsers" (no params)
 *
 * Lists every account (GET /api/users) with role + last-seen, and overlays a
 * live "Online" badge polled from GET /api/users/online while the screen is
 * focused (usePolling — there's no websocket in this app, so the caption row
 * states how fresh the status is). Rows navigate to AdminUserDetail; the
 * header's add button opens the same screen in create mode (no userId).
 */

// Relative-time ladder ("just now" → "3d ago" → date) — unlike the date-only
// formatters elsewhere; see utils/format.ts before adding another variant.
function formatLastSeen(ts: number | null | undefined): string {
  if (!ts) return "Never";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "Never";
  const diffMin = Math.floor((Date.now() - d.getTime()) / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const h = Math.floor(diffMin / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// Time-of-day only ("2:05 PM") for the freshness caption — not a candidate
// for the utils/format date family (those render dates, not clocks).
function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

// Map a (normalized) AbsError to the ErrorState treatment. 403 gets an
// explicit "Admin access required" per the UX plan — never a silent screen.
// This screen historically lumped auth/server/unsupported into the generic
// "Couldn't load users" fallback, so those overrides preserve that copy.
const GENERIC_LOAD_ERROR = { icon: "warning", title: "Couldn't load users" } as const;
function errorViewProps(e: any) {
  return absErrorToErrorStateProps(e, {
    subject: "users",
    overrides: {
      forbidden: { message: "Only server admins can manage user accounts." },
      auth: GENERIC_LOAD_ERROR,
      server: GENERIC_LOAD_ERROR,
      unsupported: GENERIC_LOAD_ERROR,
    },
  });
}

export default function AdminUsersScreen({ navigation }: any) {
  const colors = useThemeColors();

  const [users, setUsers] = useState<AbsUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<any>(null);
  const [retryTick, setRetryTick] = useState(0);
  const [onlineIds, setOnlineIds] = useState<Set<string>>(new Set());

  // `silent` refetches WITHOUT the full-screen spinner — used on focus so a
  // list that's already on screen just updates in place.
  const load = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = !!opts?.silent;
    if (!silent) {
      setLoading(true);
      setError(null);
    }
    try {
      const list = await getUsers();
      setUsers(list);
      if (silent) setError(null); // a stale error state heals on a good refetch
    } catch (e) {
      // Silent refetch failures keep whatever's already rendered.
      if (!silent) setError(e);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [retryTick, load]);

  // Reload on focus (AdminApiKeysScreen idiom) so a create/edit/delete done in
  // AdminUserDetail is reflected the moment the admin navigates back.
  useEffect(() => {
    if (!navigation?.addListener) return;
    const unsub = navigation.addListener("focus", () => void load({ silent: true }));
    return unsub;
  }, [navigation, load]);

  // Online badge: focus-gated poll (30s). Poll failures are swallowed by
  // usePolling's backoff — the badges just go stale, and the caption row
  // (lastUpdatedAt) tells the admin how fresh they are.
  const pollOnline = useCallback(async () => {
    const { usersOnline } = await getOnlineUsers();
    setOnlineIds(new Set(usersOnline.map((u: any) => u?.id).filter(Boolean)));
  }, []);
  const { lastUpdatedAt, refresh } = usePolling(pollOnline, { intervalMs: 30_000 });

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      const [list] = await Promise.all([getUsers(), refresh().catch(() => {})]);
      setUsers(list as AbsUser[]);
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setRefreshing(false);
    }
  };

  const renderRow = ({ item }: { item: AbsUser }) => {
    const online = onlineIds.has(item.id);
    const isRoot = item.type === "root";
    const label =
      `${item.username}, ${item.type}` +
      (online ? ", online" : "") +
      (item.isActive === false ? ", disabled" : "") +
      `, last seen ${formatLastSeen(item.lastSeen)}`;
    return (
      <TouchableOpacity
        onPress={() => navigation.navigate("AdminUserDetail", { userId: item.id })}
        accessibilityRole="button"
        accessibilityLabel={label}
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 16,
          paddingVertical: 12,
        }}
      >
        {/* Avatar: initial in a secondaryContainer circle */}
        <View
          style={{
            width: 40,
            height: 40,
            borderRadius: 20,
            backgroundColor: colors.secondaryContainer,
            alignItems: "center",
            justifyContent: "center",
            marginRight: 14,
          }}
        >
          <Text style={{ color: colors.onSecondaryContainer, fontSize: 16, fontWeight: "700" }}>
            {(item.username || "?").charAt(0).toUpperCase()}
          </Text>
        </View>
        <View style={{ flex: 1, marginRight: 10 }}>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <Text
              numberOfLines={1}
              style={{ color: colors.onSurface, fontSize: 16, fontWeight: "600", marginRight: 8, flexShrink: 1 }}
            >
              {item.username}
            </Text>
            {isRoot ? (
              <Icon name="lock" size={14} color={colors.onSurfaceVariant} style={{ marginRight: 6 }} />
            ) : null}
            <StatusChip
              label={item.type}
              tone={isRoot ? "warning" : item.type === "admin" ? "info" : "neutral"}
            />
          </View>
          <Text style={{ color: colors.onSurfaceVariant, fontSize: 13, marginTop: 2 }}>
            Last seen {formatLastSeen(item.lastSeen)}
          </Text>
        </View>
        {online ? (
          <StatusChip label="Online" tone="success" dot />
        ) : item.isActive === false ? (
          <StatusChip label="Disabled" tone="neutral" />
        ) : null}
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }} edges={["top", "left", "right"]}>
      {/* Settings-family header */}
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
        <Pressable
          onPress={() => navigation.goBack()}
          style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", marginRight: 4 }}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Icon name="back" size={24} color={colors.onSurface} />
        </Pressable>
        <Text
          accessibilityRole="header"
          numberOfLines={1}
          style={{ color: colors.onSurface, fontSize: 20, fontWeight: "700", flex: 1 }}
        >
          Users
        </Text>
        <Pressable
          onPress={() => navigation.navigate("AdminUserDetail", {})}
          style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" }}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Add user"
        >
          <Icon name="add" size={24} color={colors.onSurface} />
        </Pressable>
      </View>

      {loading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : error ? (
        <ErrorState
          style={{ flex: 1 }}
          {...errorViewProps(error)}
          onRetry={() => setRetryTick((t) => t + 1)}
        />
      ) : (
        <FlatList
          testID="users-list"
          data={users}
          keyExtractor={(u) => u.id}
          renderItem={renderRow}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
          }
          ListHeaderComponent={
            lastUpdatedAt ? (
              <Text
                style={{
                  color: colors.onSurfaceVariant,
                  fontSize: 12,
                  paddingHorizontal: 16,
                  paddingTop: 10,
                  paddingBottom: 4,
                }}
              >
                Online status as of {formatClock(lastUpdatedAt)} — pull to refresh
              </Text>
            ) : null
          }
          ItemSeparatorComponent={() => (
            <View style={{ height: 1, backgroundColor: colors.outlineVariant, marginLeft: 70, opacity: 0.6 }} />
          )}
          contentContainerStyle={{ paddingBottom: 40 }}
        />
      )}
    </SafeAreaView>
  );
}
