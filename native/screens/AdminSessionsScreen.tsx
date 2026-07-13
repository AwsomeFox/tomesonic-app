import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  FlatList,
  Pressable,
  ActivityIndicator,
  AccessibilityInfo,
  RefreshControl,
  TouchableOpacity,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useThemeColors } from "../theme/useThemeColors";
import { withAlpha } from "../theme/palette";
import Icon from "../components/Icon";
import ErrorState from "../components/ErrorState";
import EmptyState from "../components/EmptyState";
import StatusChip from "../components/StatusChip";
import SessionDetailSheet from "../components/SessionDetailSheet";
import { usePolling } from "../hooks/usePolling";
import { showAppDialog } from "../store/useDialogStore";
import { showSnackbar } from "../store/useSnackbarStore";
import { getAllSessions, deleteSession, batchDeleteSessions } from "../utils/abs/sessions";
import { getOnlineUsers } from "../utils/abs/users";
import { absErrorToErrorStateProps } from "../utils/abs/errors";
import { formatListeningTime, formatDateTime } from "../utils/format";
import type { AbsListeningSession } from "../utils/abs/types";

/**
 * AdminSessionsScreen — the server's listening sessions (admin-only).
 *
 * Route: "AdminSessions"
 * Params: { userId?: string; username?: string } — when userId is present
 * (navigated from a user's detail screen) the list is pre-filtered to that
 * user, with a clearable filter chip; username names the chip.
 *
 * Paginated via GET /api/sessions (infinite scroll). Single delete via each
 * row's trash button; batch delete via long-press selection mode (the M3
 * contextual pattern: header morphs to count + delete). Every delete goes
 * through a showAppDialog confirm — session deletion removes listening time
 * from the server's stats.
 *
 * NOTE: the sessions endpoint answers a NON-admin with 404 (not 403), so both
 * `forbidden` and `unsupported` error kinds render the admin-required state.
 */

const PER_PAGE = 30;

function sessionSubtitle(s: AbsListeningSession): string {
  const who = s.user?.username || "Unknown user";
  const device =
    s.mediaPlayer || s.deviceInfo?.deviceName || s.deviceInfo?.clientName || "Unknown device";
  // Date-only, en-US, "Unknown" fallback — the shared formatDateTime reproduces
  // the former local formatWhen exactly.
  const when = formatDateTime(s.updatedAt, { locale: "en-US", fallback: "Unknown" });
  return `${who} · ${device} · ${formatListeningTime(s.timeListening)} · ${when}`;
}

// Non-admins get 404 (`unsupported`) from this endpoint, not just 403, so
// both kinds render the admin-required state. auth/server keep this screen's
// historical generic "Couldn't load sessions" fallback.
const ADMIN_REQUIRED = {
  icon: "lock",
  title: "Admin access required",
  message: "Only server admins can view listening sessions.",
} as const;
const GENERIC_LOAD_ERROR = { icon: "warning", title: "Couldn't load sessions" } as const;
function errorViewProps(e: any) {
  return absErrorToErrorStateProps(e, {
    subject: "sessions",
    overrides: {
      forbidden: ADMIN_REQUIRED,
      unsupported: ADMIN_REQUIRED,
      auth: GENERIC_LOAD_ERROR,
      server: GENERIC_LOAD_ERROR,
    },
  });
}

export default function AdminSessionsScreen({ navigation, route }: any) {
  const colors = useThemeColors();
  const initialUserId: string | undefined = route?.params?.userId;
  const filterUsername: string | undefined = route?.params?.username;

  const [userFilter, setUserFilter] = useState<string | undefined>(initialUserId);
  const [sessions, setSessions] = useState<AbsListeningSession[]>([]);
  const [total, setTotal] = useState(0);
  const [numPages, setNumPages] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<any>(null);
  const [retryTick, setRetryTick] = useState(0);
  // null = normal mode; a Set = selection (batch) mode.
  const [selected, setSelected] = useState<Set<string> | null>(null);
  // Live "open" (in-progress) session ids from the /api/users/online poll —
  // decoupled from the sessions load: poll failures NEVER set the screen error.
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  // The session whose detail sheet is open (read-only), or null.
  const [detail, setDetail] = useState<AbsListeningSession | null>(null);

  // Pagination race guards. `loadMoreInFlightRef` is a REF (not state) so an
  // onEndReached storm can't start a second fetch of the same page before the
  // state update lands. `listGenRef` is a generation counter: any full list
  // replacement (initial load, filter change, pull-to-refresh) bumps it, and a
  // loadMore that resolves under an older generation discards its page instead
  // of appending stale rows onto the fresh list.
  const loadMoreInFlightRef = useRef(false);
  const listGenRef = useRef(0);

  const fetchPage = (pageNum: number, user: string | undefined) =>
    getAllSessions({
      ...(user ? { user } : {}),
      sort: "updatedAt",
      desc: true,
      itemsPerPage: PER_PAGE,
      page: pageNum,
    });

  useEffect(() => {
    let cancelled = false;
    listGenRef.current += 1; // invalidate any in-flight loadMore
    const load = async () => {
      setLoading(true);
      setError(null);
      setSelected(null);
      try {
        const res = await fetchPage(0, userFilter);
        if (cancelled) return;
        setSessions(res.sessions || []);
        setTotal(res.total || 0);
        setNumPages(res.numPages || 0);
        setPage(0);
      } catch (e) {
        if (!cancelled) setError(e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [userFilter, retryTick]);

  const loadMore = async () => {
    if (loadMoreInFlightRef.current) return; // ref, not state: survives onEndReached storms
    if (loading || loadingMore || refreshing || error) return;
    if (page + 1 >= numPages) return;
    loadMoreInFlightRef.current = true;
    const gen = listGenRef.current;
    setLoadingMore(true);
    try {
      const res = await fetchPage(page + 1, userFilter);
      // A refresh/reload replaced the list while we were fetching — this page
      // belongs to the OLD list, so drop it.
      if (gen !== listGenRef.current) return;
      setSessions((cur) => [...cur, ...(res.sessions || [])]);
      setPage(page + 1);
      setNumPages(res.numPages || numPages);
      setTotal(res.total || total);
    } catch {
      // Silent: the user can scroll again (or pull-to-refresh) to retry.
    } finally {
      loadMoreInFlightRef.current = false;
      setLoadingMore(false);
    }
  };

  const onRefresh = async () => {
    listGenRef.current += 1; // any in-flight loadMore page is now stale
    setRefreshing(true);
    // Best-effort: refresh the open-session overlay alongside the list, but a
    // poll failure must never fail the pull-to-refresh (or set the error).
    void refreshOpen().catch(() => {});
    try {
      const res = await fetchPage(0, userFilter);
      setSessions(res.sessions || []);
      setTotal(res.total || 0);
      setNumPages(res.numPages || 0);
      setPage(0);
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setRefreshing(false);
    }
  };

  const reload = () => setRetryTick((t) => t + 1);

  // Live "open sessions" overlay: focus-gated poll (30s), fully decoupled from
  // the list's load/error state — a poll failure is swallowed by usePolling's
  // backoff and just leaves the "Open" chips stale, never a screen error.
  const pollOpen = useCallback(async () => {
    const { openSessions } = await getOnlineUsers();
    setOpenIds(new Set(openSessions.map((s: any) => s?.id).filter(Boolean)));
  }, []);
  const { refresh: refreshOpen } = usePolling(pollOpen, { intervalMs: 30_000 });

  // ---- Single delete (Tier-2 confirm) ----
  const handleDeleteOne = (s: AbsListeningSession) => {
    showAppDialog({
      title: "Delete session?",
      message: `${s.displayTitle} — listening time from this session is removed from the server's stats.`,
      buttons: [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              await deleteSession(s.id);
              setSessions((cur) => cur.filter((x) => x.id !== s.id));
              setTotal((t) => Math.max(0, t - 1));
              showSnackbar({ message: "Session deleted" });
            } catch (e: any) {
              showAppDialog({
                title: "Couldn't delete session",
                message:
                  e?.kind === "offline"
                    ? "You're offline. Reconnect and try again."
                    : e?.message || "The server rejected the delete.",
              });
            }
          },
        },
      ],
    });
  };

  // ---- Batch delete (selection mode, Tier-2 confirm) ----
  const toggleSelected = (id: string) => {
    setSelected((cur) => {
      if (!cur) return cur;
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next.size === 0 ? null : next;
    });
  };

  const handleBatchDelete = () => {
    if (!selected || selected.size === 0) return;
    const ids = Array.from(selected);
    const n = ids.length;
    showAppDialog({
      title: `Delete ${n} session${n === 1 ? "" : "s"}?`,
      message: "Listening time from these sessions is removed from the server's stats.",
      buttons: [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              await batchDeleteSessions(ids);
              setSelected(null);
              setSessions((cur) => cur.filter((x) => !ids.includes(x.id)));
              setTotal((t) => Math.max(0, t - n));
              showSnackbar({ message: `${n} session${n === 1 ? "" : "s"} deleted` });
            } catch (e: any) {
              showAppDialog({
                title: "Couldn't delete sessions",
                message:
                  e?.kind === "offline"
                    ? "You're offline. Reconnect and try again."
                    : e?.message || "The server rejected the delete.",
              });
            }
          },
        },
      ],
    });
  };

  const selectionMode = selected !== null;

  // Announce selection-mode transitions — the header morph is visual-only, so
  // screen-reader users need to hear that the interaction model just changed.
  const prevSelectionModeRef = useRef(selectionMode);
  useEffect(() => {
    if (selectionMode === prevSelectionModeRef.current) return;
    prevSelectionModeRef.current = selectionMode;
    AccessibilityInfo.announceForAccessibility(
      selectionMode
        ? "Selection mode. Tap sessions to select, then delete from the header."
        : "Selection mode off."
    );
  }, [selectionMode]);

  const enterSelectionWith = (id: string) => {
    if (!selectionMode) setSelected(new Set([id]));
  };

  const renderRow = ({ item }: { item: AbsListeningSession }) => {
    const checked = !!selected?.has(item.id);
    const isOpen = openIds.has(item.id);
    return (
      <Pressable
        // Normal mode opens the read-only detail sheet on tap; the long-press
        // affordance (selection mode) stays a custom accessibility action so a
        // screen reader still hears both. Selection mode swaps to checkbox.
        onPress={selectionMode ? () => toggleSelected(item.id) : () => setDetail(item)}
        onLongPress={() => enterSelectionWith(item.id)}
        accessibilityRole={selectionMode ? "checkbox" : "button"}
        accessibilityState={selectionMode ? { checked } : undefined}
        accessibilityLabel={
          `Session: ${item.displayTitle}, ${sessionSubtitle(item)}` + (isOpen ? ", open" : "")
        }
        accessibilityHint={
          selectionMode
            ? undefined
            : "Opens session details. Long press to select multiple sessions"
        }
        accessibilityActions={
          selectionMode ? undefined : [{ name: "longpress", label: "Select session" }]
        }
        onAccessibilityAction={(e) => {
          if (e.nativeEvent.actionName === "longpress") enterSelectionWith(item.id);
        }}
        android_ripple={{ color: withAlpha(colors.onSurfaceVariant, 0.08) }}
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 16,
          paddingVertical: 12,
          backgroundColor: checked ? withAlpha(colors.primary, 0.08) : "transparent",
        }}
      >
        {selectionMode ? (
          <View
            style={{
              width: 22,
              height: 22,
              borderRadius: 6,
              borderWidth: 2,
              borderColor: checked ? colors.primary : colors.outline,
              backgroundColor: checked ? colors.primary : "transparent",
              alignItems: "center",
              justifyContent: "center",
              marginRight: 14,
            }}
          >
            {checked ? <Icon name="check" size={16} color={colors.onPrimary} /> : null}
          </View>
        ) : null}
        <View style={{ flex: 1, marginRight: 10 }}>
          <Text numberOfLines={1} style={{ color: colors.onSurface, fontSize: 15, fontWeight: "600" }}>
            {item.displayTitle || "Unknown item"}
          </Text>
          <Text numberOfLines={1} style={{ color: colors.onSurfaceVariant, fontSize: 13, marginTop: 2 }}>
            {sessionSubtitle(item)}
          </Text>
        </View>
        {!selectionMode && isOpen ? (
          <View style={{ marginRight: 8 }}>
            <StatusChip label="Open" tone="success" dot />
          </View>
        ) : null}
        {!selectionMode ? (
          <Pressable
            onPress={() => handleDeleteOne(item)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={`Delete session: ${item.displayTitle}`}
            style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" }}
          >
            <Icon name="trash" size={22} color={colors.onSurfaceVariant} />
          </Pressable>
        ) : null}
      </Pressable>
    );
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }} edges={["top", "left", "right"]}>
      {/* Settings-family header — morphs into the selection-mode header. */}
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
        {selectionMode ? (
          <>
            <Pressable
              onPress={() => setSelected(null)}
              style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", marginRight: 4 }}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Exit selection"
            >
              <Icon name="close" size={24} color={colors.onSurface} />
            </Pressable>
            <Text
              accessibilityRole="header"
              style={{ color: colors.onSurface, fontSize: 20, fontWeight: "700", flex: 1 }}
            >
              {selected?.size ?? 0} selected
            </Text>
            <Pressable
              onPress={handleBatchDelete}
              style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" }}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Delete selected sessions"
            >
              <Icon name="trash" size={24} color={colors.error} />
            </Pressable>
          </>
        ) : (
          <>
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
              Listening sessions
            </Text>
          </>
        )}
      </View>

      {/* User filter chip (pre-applied when navigated from a user's detail) */}
      {userFilter && !loading && !error ? (
        <View style={{ flexDirection: "row", paddingHorizontal: 16, paddingTop: 10 }}>
          <Pressable
            onPress={() => setUserFilter(undefined)}
            accessibilityRole="button"
            accessibilityLabel="Clear user filter"
            hitSlop={{ top: 6, bottom: 6 }}
            style={{
              flexDirection: "row",
              alignItems: "center",
              paddingHorizontal: 12,
              height: 32,
              borderRadius: 16,
              backgroundColor: colors.secondaryContainer,
            }}
          >
            <Text style={{ color: colors.onSecondaryContainer, fontSize: 13, fontWeight: "600", marginRight: 6 }}>
              {filterUsername ? `Sessions: ${filterUsername}` : "One user"}
            </Text>
            <Icon name="close" size={16} color={colors.onSecondaryContainer} />
          </Pressable>
        </View>
      ) : null}

      {loading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : error ? (
        <ErrorState style={{ flex: 1 }} {...errorViewProps(error)} onRetry={reload} />
      ) : sessions.length === 0 ? (
        <EmptyState
          style={{ flex: 1 }}
          icon="clock"
          title="No sessions"
          message={userFilter ? "This user has no listening sessions." : "Nobody has listened yet."}
        />
      ) : (
        <FlatList
          testID="sessions-list"
          data={sessions}
          keyExtractor={(s) => s.id}
          renderItem={renderRow}
          onEndReached={loadMore}
          onEndReachedThreshold={0.4}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
          }
          ListHeaderComponent={
            <Text
              style={{
                color: colors.onSurfaceVariant,
                fontSize: 12,
                paddingHorizontal: 16,
                paddingTop: 10,
                paddingBottom: 4,
              }}
            >
              {total} session{total === 1 ? "" : "s"}
            </Text>
          }
          ListFooterComponent={
            loadingMore ? (
              <View style={{ paddingVertical: 16 }}>
                <ActivityIndicator size="small" color={colors.primary} />
              </View>
            ) : null
          }
          ItemSeparatorComponent={() => (
            <View style={{ height: 1, backgroundColor: colors.outlineVariant, marginLeft: 16, opacity: 0.6 }} />
          )}
          contentContainerStyle={{ paddingBottom: 40 }}
        />
      )}

      <SessionDetailSheet
        session={detail}
        isOpen={detail ? openIds.has(detail.id) : false}
        onClose={() => setDetail(null)}
      />
    </SafeAreaView>
  );
}
