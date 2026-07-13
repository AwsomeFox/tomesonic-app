import React, { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, FlatList, ActivityIndicator, Pressable, RefreshControl } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useThemeColors } from "../theme/useThemeColors";
import { withAlpha } from "../theme/palette";
import Icon from "../components/Icon";
import HintPressable from "../components/HintPressable";
import ErrorState from "../components/ErrorState";
import EmptyState from "../components/EmptyState";
import { getServerLogs } from "../utils/abs/server";

/**
 * AdminServerLogsScreen — read-only viewer for the SERVER's log snapshot
 * (admin-and-up). Distinct from the existing "Logs" route, which shows the
 * app's own client-side logs.
 *
 * Route: "AdminServerLogs" (no params)
 *
 * TRANSPORT LIMITATION (documented in utils/abs/server.ts): the ABS web
 * client's live log view is socket-only; the sole REST surface is
 * GET /api/logger-data, a snapshot of the most recent current-day log lines.
 * So this screen is a SNAPSHOT viewer with a manual refresh — not a live
 * tail — and says so in its caption. On servers without the endpoint (404 →
 * AbsError kind "unsupported") it degrades to a "use the web UI" empty state.
 */

// ABS Logger numeric levels (server/Logger.js): TRACE=0 DEBUG=1 INFO=2 WARN=3
// ERROR=4 FATAL=5. Snapshot entries usually carry `levelName` already; the
// numeric map is the fallback.
const LEVEL_BY_NUM: Record<number, string> = {
  0: "TRACE",
  1: "DEBUG",
  2: "INFO",
  3: "WARN",
  4: "ERROR",
  5: "FATAL",
};

function levelOf(entry: any): string {
  if (typeof entry?.levelName === "string" && entry.levelName) {
    return entry.levelName.toUpperCase();
  }
  return LEVEL_BY_NUM[entry?.level] || "INFO";
}

function describeLoadError(e: any): { title: string; message: string } {
  switch (e?.kind) {
    case "offline":
      return { title: "You're offline", message: "Reconnect to view the server's logs." };
    case "forbidden":
      return { title: "Admin access required", message: "Only server admins can view server logs." };
    default:
      return {
        title: "Couldn't load server logs",
        message: e?.message || "The server hit an error handling this request.",
      };
  }
}

export default function AdminServerLogsScreen({ navigation }: any) {
  const colors = useThemeColors();

  const [entries, setEntries] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<any>(null);
  const [retryTick, setRetryTick] = useState(0);
  const [levelFilter, setLevelFilter] = useState<string>("ALL");
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const logs = await getServerLogs();
        if (cancelled) return;
        setEntries(logs);
        setUpdatedAt(new Date());
      } catch (e) {
        if (cancelled) return;
        setError(e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [retryTick]);

  // Manual snapshot refresh (the endpoint has no live/tail mode — see header).
  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const logs = await getServerLogs();
      setEntries(logs);
      setUpdatedAt(new Date());
      setError(null);
    } catch (e) {
      // If nothing rendered yet, promote to the full-screen error; otherwise
      // keep the stale snapshot on screen (it's still labeled with its time).
      setError((prev: any) => (entries.length === 0 ? e : prev));
    } finally {
      setRefreshing(false);
    }
  };

  // DEBUG/TRACE chips appear only when the snapshot actually contains such
  // entries — most servers don't emit them, and a dead chip is noise.
  const levelChips = useMemo(() => {
    const present = new Set(entries.map(levelOf));
    const chips = ["ALL"];
    if (present.has("TRACE")) chips.push("TRACE");
    if (present.has("DEBUG")) chips.push("DEBUG");
    chips.push("INFO", "WARN", "ERROR");
    return chips;
  }, [entries]);

  const visibleEntries = useMemo(
    () =>
      levelFilter === "ALL" ? entries : entries.filter((e) => levelOf(e) === levelFilter),
    [entries, levelFilter]
  );

  const LEVEL_COLORS: Record<string, string> = useMemo(
    () => ({
      FATAL: colors.error,
      ERROR: colors.error,
      WARN: colors.tertiary,
      INFO: colors.primary,
      DEBUG: colors.onSurfaceVariant,
      TRACE: colors.onSurfaceVariant,
    }),
    [colors]
  );

  // FlatList row — a busy server's snapshot can run to thousands of lines, so
  // the list is virtualized (ScrollView+map rendered every row up front).
  const renderLogEntry = useCallback(
    ({ item: entry, index }: { item: any; index: number }) => {
      const level = levelOf(entry);
      return (
        <View
          style={{
            paddingVertical: 10,
            paddingHorizontal: 16,
            backgroundColor: index % 2 === 0 ? colors.surfaceContainerLowest : "transparent",
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 4 }}>
            <Text
              style={{
                color: LEVEL_COLORS[level] || colors.primary,
                fontSize: 12,
                fontWeight: "700",
                letterSpacing: 0.5,
              }}
            >
              {level}
            </Text>
            {entry?.timestamp ? (
              <Text style={{ color: colors.onSurfaceVariant, fontSize: 12, marginLeft: 12 }}>
                {String(entry.timestamp)}
              </Text>
            ) : null}
            <View style={{ flex: 1 }} />
            {entry?.source ? (
              <Text style={{ color: colors.onSurfaceVariant, fontSize: 12 }} numberOfLines={1}>
                {String(entry.source)}
              </Text>
            ) : null}
          </View>
          <Text style={{ color: colors.onSurface, fontSize: 13, lineHeight: 19 }}>
            {String(entry?.message ?? "")}
          </Text>
        </View>
      );
    },
    [colors, LEVEL_COLORS]
  );

  const unsupported = error?.kind === "unsupported";

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }} edges={["top", "left", "right"]}>
      {/* Settings-family header + snapshot refresh */}
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
        <HintPressable
          onPress={() => navigation.goBack()}
          style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", marginRight: 4 }}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Icon name="back" size={24} color={colors.onSurface} />
        </HintPressable>
        <Text
          accessibilityRole="header"
          numberOfLines={1}
          style={{ color: colors.onSurface, fontSize: 20, fontWeight: "700", flex: 1 }}
        >
          Server logs
        </Text>
        {!loading && !unsupported ? (
          <HintPressable
            onPress={handleRefresh}
            disabled={refreshing}
            style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" }}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Refresh logs"
            accessibilityState={{ disabled: refreshing, busy: refreshing }}
            android_ripple={{ color: withAlpha(colors.onSurface, 0.12), borderless: true, radius: 22 }}
          >
            {refreshing ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : (
              <Icon name="refresh" size={24} color={colors.onSurface} />
            )}
          </HintPressable>
        ) : null}
      </View>

      {loading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : unsupported ? (
        // Older servers have no REST log surface at all — not an error, a
        // missing feature. Point at the web UI's live (socket) log view.
        <EmptyState
          style={{ flex: 1 }}
          icon="logs"
          title="Not available on this server"
          message="This server version doesn't provide log snapshots over the API. View live logs on the web dashboard."
        />
      ) : error ? (
        <ErrorState
          style={{ flex: 1 }}
          icon="logs"
          title={describeLoadError(error).title}
          message={describeLoadError(error).message}
          onRetry={() => setRetryTick((t) => t + 1)}
        />
      ) : (
        <FlatList
          testID="server-logs-list"
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: 24 }}
          data={visibleEntries}
          keyExtractor={(entry, index) => `${entry?.timestamp ?? ""}-${index}`}
          renderItem={renderLogEntry}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handleRefresh}
              tintColor={colors.primary}
            />
          }
          ListHeaderComponent={
            <>
              {/* Snapshot caption — sets expectations that this is not a live tail. */}
              <Text
                style={{
                  color: colors.onSurfaceVariant,
                  fontSize: 12,
                  paddingHorizontal: 16,
                  paddingTop: 8,
                  paddingBottom: 4,
                }}
              >
                Snapshot of today's server log
                {updatedAt ? ` · updated ${updatedAt.toLocaleTimeString()}` : ""} — refresh for new
                entries.
              </Text>

              {/* Level filter chips (LogsScreen idiom; 34dp + vertical hitSlop for
                  a ~46dp effective touch target, matching the sibling chips). */}
              <View style={{ flexDirection: "row", flexWrap: "wrap", paddingHorizontal: 16, paddingBottom: 8, columnGap: 8, rowGap: 8 }}>
                {levelChips.map((lvl) => {
                  const selected = levelFilter === lvl;
                  return (
                    <Pressable
                      key={lvl}
                      onPress={() => setLevelFilter(lvl)}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      accessibilityLabel={lvl === "ALL" ? "Show all logs" : `Show ${lvl.toLowerCase()} logs`}
                      hitSlop={{ top: 6, bottom: 6 }}
                      style={{
                        paddingHorizontal: 14,
                        height: 34,
                        borderRadius: 17,
                        alignItems: "center",
                        justifyContent: "center",
                        backgroundColor: selected ? colors.secondaryContainer : "transparent",
                        borderWidth: 1,
                        borderColor: selected ? "transparent" : colors.outlineVariant,
                      }}
                    >
                      <Text
                        style={{
                          color: selected ? colors.onSecondaryContainer : colors.onSurfaceVariant,
                          fontSize: 13,
                          fontWeight: "600",
                        }}
                      >
                        {lvl === "ALL" ? "All" : lvl.charAt(0) + lvl.slice(1).toLowerCase()}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </>
          }
          ListEmptyComponent={
            <View style={{ paddingTop: 48, alignItems: "center" }}>
              <Text style={{ color: colors.onSurfaceVariant, fontSize: 14 }}>
                {entries.length === 0
                  ? "No log entries in today's snapshot"
                  : `No ${levelFilter.toLowerCase()} logs`}
              </Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}
