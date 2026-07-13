import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  Pressable,
  FlatList,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useThemeColors } from "../theme/useThemeColors";
import { withAlpha } from "../theme/palette";
import Icon from "../components/Icon";
import EmptyState from "../components/EmptyState";
import ErrorState from "../components/ErrorState";
import { getMyItemListeningSessions } from "../utils/abs/me";

/**
 * ItemHistoryScreen — MY listening sessions for one library item (optionally
 * one podcast episode).
 *
 * Route: "ItemHistory"  Params: { libraryItemId: string; episodeId?: string }
 *
 * Data: utils/abs/me.getMyItemListeningSessions — throws AbsError, so the
 * error state can distinguish offline from a server rejection.
 */

/** "Xh Ym" / "Xm" / "Xs" — a 40-second session must not read "0m". */
export function formatListened(seconds: number | undefined): string {
  if (!seconds || seconds <= 0) return "0m";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${Math.floor(seconds)}s`;
}

function sessionTimeMs(session: any): number | null {
  if (session?.updatedAt) return session.updatedAt;
  if (session?.startedAt) return session.startedAt;
  return null;
}

function formatDate(ms: number | null): string {
  if (!ms) return "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** A session's device line, from whichever deviceInfo fields are present. */
function deviceLabel(session: any): string {
  const info = session?.deviceInfo || {};
  return (
    info.deviceName ||
    [info.manufacturer, info.model].filter(Boolean).join(" ") ||
    info.clientName ||
    info.osName ||
    ""
  );
}

export default function ItemHistoryScreen({ route, navigation }: any) {
  const colors = useThemeColors();
  const { libraryItemId, episodeId } = route?.params || {};

  const [sessions, setSessions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);

  const fetchSessions = async () => {
    const res = await getMyItemListeningSessions(libraryItemId, episodeId);
    const list = Array.isArray(res?.sessions) ? res.sessions : [];
    // Most recent first — the API returns them in server order.
    return [...list].sort((a, b) => (sessionTimeMs(b) || 0) - (sessionTimeMs(a) || 0));
  };

  useEffect(() => {
    if (!libraryItemId) {
      setError("No item provided.");
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const list = await fetchSessions();
        if (!cancelled) setSessions(list);
      } catch (e: any) {
        if (!cancelled) setError(e?.message || "Failed to load listening history.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [libraryItemId, episodeId, retryTick]);

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      setSessions(await fetchSessions());
      setError(null);
    } catch {
      // Keep the current list on a failed refresh.
    } finally {
      setRefreshing(false);
    }
  };

  const totalSeconds = sessions.reduce((sum, s) => sum + (Number(s?.timeListening) || 0), 0);
  const itemTitle = sessions[0]?.displayTitle || "";

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
          android_ripple={{ color: withAlpha(colors.onSurface, 0.12), borderless: true, radius: 22 }}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Icon name="back" size={24} color={colors.onSurface} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text
            accessibilityRole="header"
            numberOfLines={1}
            style={{ color: colors.onSurface, fontSize: 20, fontWeight: "700" }}
          >
            Listening history
          </Text>
          {itemTitle ? (
            <Text numberOfLines={1} style={{ color: colors.onSurfaceVariant, fontSize: 13 }}>
              {itemTitle}
            </Text>
          ) : null}
        </View>
      </View>

      {loading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : error ? (
        <ErrorState
          style={{ flex: 1 }}
          message={error}
          onRetry={libraryItemId ? () => setRetryTick((t) => t + 1) : undefined}
        />
      ) : (
        <FlatList
          data={sessions}
          keyExtractor={(s, index) => (s?.id ? String(s.id) : String(index))}
          contentContainerStyle={{ padding: 16 }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              colors={[colors.primary]}
              progressBackgroundColor={colors.surfaceContainerHigh}
            />
          }
          ListHeaderComponent={
            sessions.length > 0 ? (
              <Text
                style={{
                  color: colors.onSurfaceVariant,
                  fontSize: 13,
                  fontWeight: "600",
                  marginBottom: 12,
                }}
              >
                {sessions.length} {sessions.length === 1 ? "session" : "sessions"} ·{" "}
                {formatListened(totalSeconds)} total
              </Text>
            ) : null
          }
          ListEmptyComponent={
            <EmptyState
              icon="clock"
              title="No listening history"
              message="Sessions for this item appear here as you listen."
            />
          }
          renderItem={({ item: session }) => {
            const dateStr = formatDate(sessionTimeMs(session));
            const listenedStr = `${formatListened(session?.timeListening)} listened`;
            const device = deviceLabel(session);
            const subtitle = [listenedStr, device].filter(Boolean).join(" · ");
            return (
              <View
                accessible
                accessibilityLabel={`${dateStr || "Session"}, ${subtitle}`}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  padding: 14,
                  minHeight: 64,
                  backgroundColor: colors.surfaceContainer,
                  borderRadius: 16,
                  marginBottom: 12,
                }}
              >
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
                  <Icon name="headphones" size={20} color={colors.onSecondaryContainer} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text numberOfLines={1} style={{ color: colors.onSurface, fontSize: 15, fontWeight: "600" }}>
                    {dateStr || session?.displayTitle || "Session"}
                  </Text>
                  <Text numberOfLines={1} style={{ color: colors.onSurfaceVariant, fontSize: 13, marginTop: 2 }}>
                    {subtitle}
                  </Text>
                </View>
              </View>
            );
          }}
        />
      )}
    </SafeAreaView>
  );
}
