import React, { useEffect, useRef, useState } from "react";
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
import { api } from "../utils/api";
import { formatDateTime } from "../utils/format";

/**
 * ItemHistoryScreen — MY listening sessions for one library item (optionally
 * one podcast episode).
 *
 * Route: "ItemHistory"  Params: { libraryItemId: string; episodeId?: string }
 *
 * Data: utils/abs/me.getMyItemListeningSessions — throws AbsError, so the
 * error state can distinguish offline from a server rejection. The endpoint
 * is PAGED (~10 sessions/response with a `total`): after the first page lands
 * the screen silently pages through the remainder, appending as batches
 * arrive, so the list AND the summary reflect the real history rather than one
 * page of it. The summary's session count prefers the endpoint's `total` so
 * it's honest even before the last page arrives — but the endpoint returns no
 * grand-total listening TIME, only a per-page `timeListening` we sum from the
 * pages loaded so far. Pairing the full count with a partial time reads as a
 * contradiction ("42 sessions · 8m total") mid-load, so the time is labelled
 * "loaded so far" until the page-through completes, then flips to "total".
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
  // The endpoint's `total` (all pages) — null when the server didn't send one.
  const [serverTotal, setServerTotal] = useState<number | null>(null);
  // True once every page has been fetched (or there was nothing to page). While
  // false, the summed listening time only covers the pages loaded so far, so
  // the summary must not present it as the grand total.
  const [fullyLoaded, setFullyLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);

  // In-flight guard for the background page-through: every fresh load (mount,
  // retry, refresh, param change) bumps the sequence, so a stale loop can
  // never append into — or race — a newer load's list.
  const loadSeqRef = useRef(0);

  const sessionsPath = episodeId
    ? `/api/me/item/listening-sessions/${libraryItemId}/${episodeId}`
    : `/api/me/item/listening-sessions/${libraryItemId}`;

  const sortNewestFirst = (list: any[]) =>
    [...list].sort((a, b) => (sessionTimeMs(b) || 0) - (sessionTimeMs(a) || 0));

  /**
   * Fetch page 0 (throws AbsError — the caller owns the error state), publish
   * it, then page through the remainder in the background, appending batches.
   * A failed later page keeps whatever already loaded (the list stays usable).
   */
  const fetchSessions = async () => {
    const seq = ++loadSeqRef.current;
    setFullyLoaded(false);
    const first = await getMyItemListeningSessions(libraryItemId, episodeId);
    if (seq !== loadSeqRef.current) return;
    let list: any[] = Array.isArray(first?.sessions) ? [...first.sessions] : [];
    const total = Number(first?.total);
    const hasTotal = Number.isFinite(total) && total >= 0;
    setSessions(sortNewestFirst(list));
    setServerTotal(hasTotal ? total : null);
    if (!hasTotal || total <= list.length || list.length === 0) {
      // Nothing more to page: the summed time IS the grand total.
      setFullyLoaded(true);
      return;
    }

    // Background page-through (not awaited by callers' loading/refreshing
    // spinners — batches render as they land).
    const perPage = Number(first?.itemsPerPage) || list.length;
    const numPages = Number(first?.numPages) || Math.ceil(total / perPage);
    void (async () => {
      for (let page = 1; page < numPages; page++) {
        let data: any;
        try {
          data = (await api.get(`${sessionsPath}?page=${page}`)).data;
        } catch {
          return; // keep the pages we have (time stays "loaded so far")
        }
        if (seq !== loadSeqRef.current) return; // superseded by a newer load
        const batch = Array.isArray(data?.sessions) ? data.sessions : [];
        if (batch.length === 0) return;
        // A session added server-side mid-paging shifts page boundaries and
        // re-serves rows — dedupe by id so a straddling session isn't counted
        // (and summed) twice (mirrors ListeningHistoryScreen.loadMore).
        const seen = new Set(list.map((s: any) => s?.id).filter(Boolean));
        list = list.concat(batch.filter((s: any) => !s?.id || !seen.has(s.id)));
        setSessions(sortNewestFirst(list));
      }
      // Only reached when every page was fetched without a gap — the summed
      // time now covers the whole history and can be shown as the total.
      if (seq === loadSeqRef.current) setFullyLoaded(true);
    })();
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
        await fetchSessions();
      } catch (e: any) {
        if (!cancelled) setError(e?.message || "Failed to load listening history.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      // Invalidate any in-flight page-through so it can't setState after
      // unmount or bleed into the next load.
      loadSeqRef.current++;
    };
  }, [libraryItemId, episodeId, retryTick]);

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await fetchSessions();
      setError(null);
    } catch {
      // Keep the current list on a failed refresh.
    } finally {
      setRefreshing(false);
    }
  };

  const totalSeconds = sessions.reduce((sum, s) => sum + (Number(s?.timeListening) || 0), 0);
  // Session count prefers the endpoint's total — honest even mid-page-through.
  const sessionCount = serverTotal ?? sessions.length;
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
                {sessionCount} {sessionCount === 1 ? "session" : "sessions"} ·{" "}
                {formatListened(totalSeconds)} {fullyLoaded ? "total" : "loaded so far"}
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
            const dateStr = formatDateTime(sessionTimeMs(session) ?? undefined);
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
