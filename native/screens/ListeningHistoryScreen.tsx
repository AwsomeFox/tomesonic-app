import React, { useEffect, useState } from "react";
import { View, Text, Pressable, FlatList, ActivityIndicator, RefreshControl } from "react-native";
import { Image } from "expo-image";
import { SafeAreaView } from "react-native-safe-area-context";
import { api } from "../utils/api";
import { storageHelper } from "../utils/storage";
import { useThemeColors } from "../theme/useThemeColors";
import { withAlpha } from "../theme/palette";
import Icon from "../components/Icon";
import EmptyState from "../components/EmptyState";
import ErrorState from "../components/ErrorState";

/** Formats seconds listened as "Xh Ym" / "Xm" / "Xs", mirroring the
 *  remainingPretty conventions (a 40-second session must not read "0m"). */
function formatListened(seconds: number | undefined): string {
  if (!seconds || seconds <= 0) return "0m";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${Math.floor(seconds)}s`;
}

/** Resolves a session's timestamp from whichever field is present, in ms. */
function sessionTimeMs(session: any): number | null {
  if (session?.updatedAt) return session.updatedAt;
  if (session?.startedAt) return session.startedAt;
  if (session?.date) {
    const parsed = Date.parse(session.date);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function formatDate(ms: number | null): string {
  if (!ms) return "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const PAGE_SIZE = 50;

export default function ListeningHistoryScreen({ navigation }: any) {
  const colors = useThemeColors();
  const [sessions, setSessions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  // Next page to request + in-flight latch, kept in refs so rapid
  // onEndReached bursts can't double-fetch the same page.
  const pageRef = React.useRef(0);
  const fetchingMoreRef = React.useRef(false);

  const serverConfig = storageHelper.getServerConfig();
  const serverAddress = serverConfig?.address?.replace(/\/$/, "") || "";
  const token = serverConfig?.token || "";

  const fetchSessions = async (page: number) => {
    const res = await api.get("/api/me/listening-sessions", {
      params: { itemsPerPage: PAGE_SIZE, page },
    });
    const list = Array.isArray(res.data?.sessions) ? res.data.sessions : [];
    // Prefer the server's page count; fall back to "full page ⇒ maybe more"
    // for older servers that omit numPages.
    const numPages = typeof res.data?.numPages === "number" ? res.data.numPages : null;
    const more = numPages != null ? page + 1 < numPages : list.length === PAGE_SIZE;
    return { list, more };
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        setError(null);
        const { list, more } = await fetchSessions(0);
        if (!cancelled) {
          pageRef.current = 0;
          setSessions(list);
          setHasMore(more);
        }
      } catch (e) {
        if (!cancelled) setError("Failed to load listening history.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [retryTick]);

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      const { list, more } = await fetchSessions(0);
      pageRef.current = 0;
      setSessions(list);
      setHasMore(more);
      setError(null);
    } catch {
      // keep the current list on a failed refresh
    } finally {
      setRefreshing(false);
    }
  };

  const loadMore = async () => {
    if (fetchingMoreRef.current || !hasMore || loading || refreshing) return;
    fetchingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const nextPage = pageRef.current + 1;
      const { list, more } = await fetchSessions(nextPage);
      pageRef.current = nextPage;
      setSessions((prev) => {
        // Sessions still accrue while the user scrolls, shifting page
        // boundaries — dedupe by id so a row straddling pages isn't doubled.
        const seen = new Set(prev.map((s: any) => s?.id).filter(Boolean));
        return [...prev, ...list.filter((s: any) => !s?.id || !seen.has(s.id))];
      });
      setHasMore(more);
    } catch {
      // keep what we have; the next onEndReached retries this page
    } finally {
      fetchingMoreRef.current = false;
      setLoadingMore(false);
    }
  };

  const coverUri = (libraryItemId: string) =>
    libraryItemId && serverAddress && token
      ? `${serverAddress}/api/items/${libraryItemId}/cover?width=400&format=webp&token=${token}`
      : null;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }} edges={["top", "left", "right"]}>
      {/* Header */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 12,
          paddingTop: 8,
          paddingBottom: 8,
        }}
      >
        <Pressable
          onPress={() => navigation.goBack()}
          style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" }}
          hitSlop={8}
          android_ripple={{ color: withAlpha(colors.onSurface, 0.12), borderless: true, radius: 22 }}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Icon name="back" size={24} color={colors.onSurface} />
        </Pressable>
        <Text
          accessibilityRole="header"
          style={{ color: colors.onSurface, fontSize: 20, fontWeight: "700", marginLeft: 4 }}
        >
          Listening History
        </Text>
      </View>

      {loading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : error ? (
        <ErrorState
          style={{ flex: 1 }}
          message={error}
          onRetry={() => setRetryTick((t) => t + 1)}
        />
      ) : (
        <FlatList
          data={sessions}
          keyExtractor={(item, index) => item?.id ? String(item.id) : String(index)}
          contentContainerStyle={{ padding: 16 }}
          onEndReached={loadMore}
          onEndReachedThreshold={0.5}
          ListFooterComponent={
            loadingMore ? (
              <View style={{ paddingVertical: 16, alignItems: "center" }}>
                <ActivityIndicator size="small" color={colors.primary} />
              </View>
            ) : null
          }
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              colors={[colors.primary]}
              progressBackgroundColor={colors.surfaceContainerHigh}
            />
          }
          ListEmptyComponent={
            <EmptyState
              icon="clock"
              title="No listening history yet"
              message="Sessions appear here as you listen."
            />
          }
          renderItem={({ item }) => {
            const uri = coverUri(item?.libraryItemId);
            const dateStr = formatDate(sessionTimeMs(item));
            const listenedStr = formatListened(item?.timeListening);
            const subtitle = [dateStr, `${listenedStr} listened`].filter(Boolean).join(" · ");
            return (
              <Pressable
                onPress={() =>
                  item?.libraryItemId &&
                  navigation.navigate("ItemDetail", { itemId: item.libraryItemId })
                }
                accessibilityRole="button"
                accessibilityLabel={`${item?.displayTitle || "Untitled"}, ${item?.displayAuthor || ""}, ${subtitle}`}
                android_ripple={{ color: withAlpha(colors.onSurface, 0.12) }}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  padding: 10,
                  minHeight: 76,
                  backgroundColor: colors.surfaceContainer,
                  borderRadius: 16,
                  marginBottom: 12,
                  overflow: "hidden",
                }}
              >
                <View
                  style={{
                    width: 56,
                    height: 56,
                    borderRadius: 12,
                    overflow: "hidden",
                    backgroundColor: colors.surfaceContainerHighest,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {uri ? (
                    <Image source={{ uri }} style={{ width: 56, height: 56 }} contentFit="cover" />
                  ) : (
                    <Icon name="book" size={26} color={colors.onSurfaceVariant} />
                  )}
                </View>
                <View style={{ flex: 1, paddingHorizontal: 12 }}>
                  <Text numberOfLines={1} style={{ color: colors.onSurface, fontSize: 15, fontWeight: "600" }}>
                    {item?.displayTitle || "Untitled"}
                  </Text>
                  <Text numberOfLines={1} style={{ color: colors.onSurfaceVariant, fontSize: 13, marginTop: 2 }}>
                    {item?.displayAuthor || ""}
                  </Text>
                  <Text numberOfLines={1} style={{ color: colors.onSurfaceVariant, fontSize: 12, marginTop: 2 }}>
                    {subtitle}
                  </Text>
                </View>
                <Icon name="chevron-right" size={20} color={colors.onSurfaceVariant} />
              </Pressable>
            );
          }}
        />
      )}
    </SafeAreaView>
  );
}
