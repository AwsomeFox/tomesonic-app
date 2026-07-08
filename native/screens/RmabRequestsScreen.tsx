import React, { useCallback, useEffect, useState } from "react";
import { View, Text, FlatList, TouchableOpacity, ActivityIndicator, RefreshControl } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Image } from "expo-image";
import { useThemeColors } from "../theme/useThemeColors";
import { withAlpha } from "../theme/palette";
import Icon from "../components/Icon";
import EmptyState from "../components/EmptyState";
import { listMyRequests, deleteRequest, approveRequest, resolveRmabUrl } from "../utils/rmab";
import BottomSheet from "../components/BottomSheet";
import BookDescription from "../components/BookDescription";
import RmabSessionExpiredBanner from "../components/RmabSessionExpiredBanner";
import { useRmabStore } from "../store/useRmabStore";
import { showAppDialog } from "../store/useDialogStore";
import Pressable from "../components/HintPressable";

// Statuses the RMAB server lets the REQUESTER cancel (mirrors the server's
// CANCELLABLE_STATUSES in src/lib/constants/request-statuses.ts). Terminal /
// fulfilled states are deliberately omitted — the server 400s ("Cannot cancel
// request with status: …") on those, so we never offer the action for them.
const CANCELLABLE_STATUSES = new Set([
  "pending",
  "searching",
  "downloading",
  "awaiting_search",
  "awaiting_approval",
  "awaiting_release",
  // The screen treats this as an alias of awaiting_approval elsewhere.
  "pending_approval",
]);
const isCancellable = (status?: string) => CANCELLABLE_STATUSES.has((status || "").toLowerCase());

// Human-readable summary of the non-admin fulfillment banner. Singular/plural
// aware, and combines both outcomes when a poll surfaced fulfilled AND failed.
function updatesBannerMessage(fulfilled: number, failed: number): string {
  const parts: string[] = [];
  if (fulfilled > 0) {
    parts.push(fulfilled === 1 ? "1 request is ready to read" : `${fulfilled} requests are ready to read`);
  }
  if (failed > 0) {
    parts.push(failed === 1 ? "1 request failed" : `${failed} requests failed`);
  }
  return parts.join(" • ");
}

/** Friendly label + color role per RMAB request status. */
function statusMeta(status: string, colors: any): { label: string; bg: string; fg: string } {
  switch ((status || "").toLowerCase()) {
    case "available":
    case "completed":
    case "fulfilled":
      return { label: "Available", bg: colors.primaryContainer, fg: colors.onPrimaryContainer };
    // Ebook requests never reach "available" — `downloaded` is their terminal
    // success (the file is organized next to the audiobook).
    case "downloaded":
      return { label: "Downloaded", bg: colors.primaryContainer, fg: colors.onPrimaryContainer };
    case "awaiting_import":
      return { label: "Waiting for import", bg: colors.secondaryContainer, fg: colors.onSecondaryContainer };
    case "downloading":
    case "processing":
    case "importing":
      return { label: "Processing", bg: colors.secondaryContainer, fg: colors.onSecondaryContainer };
    case "failed":
    case "error":
      return { label: "Failed", bg: colors.errorContainer, fg: colors.onErrorContainer };
    // Terminal/negative outcomes must NOT fall through to the neutral
    // "Requested" default — they read as still-in-progress otherwise.
    case "denied":
      return { label: "Denied", bg: colors.errorContainer, fg: colors.onErrorContainer };
    case "rejected":
      return { label: "Rejected", bg: colors.errorContainer, fg: colors.onErrorContainer };
    case "cancelled":
    case "canceled":
      return { label: "Cancelled", bg: colors.errorContainer, fg: colors.onErrorContainer };
    case "pending_approval":
    case "awaiting_approval":
      return { label: "Awaiting approval", bg: colors.surfaceContainerHigh, fg: colors.onSurfaceVariant };
    default:
      return { label: "Requested", bg: colors.surfaceContainerHigh, fg: colors.onSurfaceVariant };
  }
}

export default function RmabRequestsScreen({ navigation }: any) {
  const colors = useThemeColors();
  const [requests, setRequests] = useState<any[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);
  // Manage actions are server-enforced to admin JWT sessions — static rmab_
  // API tokens can't hit delete/approve regardless of the token owner's role.
  const isAdmin = useRmabStore((s) => s.isAdmin);
  const authMode = useRmabStore((s) => s.authMode);
  const refreshPendingCount = useRmabStore((s) => s.refreshPendingCount);
  const cancelMyRequest = useRmabStore((s) => s.cancelMyRequest);
  // PO4 non-admin fulfillment awareness: a request quietly finishing (or
  // failing) is otherwise invisible to a requester (they get no approval badge).
  const refreshMyRequestStatuses = useRmabStore((s) => s.refreshMyRequestStatuses);
  const clearMyRequestUpdates = useRmabStore((s) => s.clearMyRequestUpdates);
  const myRequestUpdates = useRmabStore((s) => s.myRequestUpdates);
  const canManage = isAdmin && authMode === "jwt";
  // When NOT an admin manager, /api/requests returns only the caller's own
  // requests, so every row is theirs — offer requester self-cancel on the ones
  // still in a cancellable state.
  const canCancelOwn = !canManage;
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [detail, setDetail] = useState<any | null>(null);
  // Disarm timer for the two-tap delete confirm. Kept in a ref so re-arming
  // replaces (not stacks) it, and so unmount can cancel it — the 3s callback
  // would otherwise setState after navigating away.
  const confirmTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    };
  }, []);

  const onApprove = async (id: string, action: "approve" | "deny") => {
    setActing(id);
    try {
      await approveRequest(id, action);
      await load();
      refreshPendingCount();
    } catch (e) {
      console.warn("[RMAB] approve failed", e);
      // The row un-dims on failure with no other signal — say WHY the action
      // didn't stick (expired session, offline) instead of looking swallowed.
      showAppDialog({
        title: action === "approve" ? "Couldn't approve" : "Couldn't deny",
        message: "The request couldn't be updated. Check your connection (or reconnect ReadMeABook in Settings) and try again."
      });
    } finally {
      setActing(null);
    }
  };

  const onDelete = async (id: string) => {
    // Two-tap confirm: first tap arms, second within 3s deletes.
    if (confirmingDelete !== id) {
      setConfirmingDelete(id);
      // Arming a new row replaces the previous disarm timer instead of
      // letting a stale one linger.
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = setTimeout(() => setConfirmingDelete((c) => (c === id ? null : c)), 3000);
      return;
    }
    // Confirmed: the disarm timer is now moot — clear it so it can't fire a
    // redundant setState later.
    if (confirmTimerRef.current) {
      clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = null;
    }
    setConfirmingDelete(null);
    setActing(id);
    try {
      await deleteRequest(id);
      setRequests((prev) => (prev || []).filter((r: any) => String(r?.id) !== id));
      refreshPendingCount();
    } catch (e) {
      console.warn("[RMAB] delete failed", e);
      showAppDialog({
        title: "Couldn't delete",
        message: "The request couldn't be deleted. Check your connection (or reconnect ReadMeABook in Settings) and try again."
      });
    } finally {
      setActing(null);
    }
  };

  // Requester self-cancel: a themed confirm, then an optimistic row removal that
  // reverts (and explains) if the server refuses — e.g. a 403 on a server that
  // doesn't permit owner-cancel, or a 400 if the status left the cancellable
  // window between render and tap.
  const onCancelOwn = (item: any) => {
    const id = String(item?.id ?? "");
    if (!id) return;
    const asin = item?.audiobook?.asin || item?.asin;
    const title = item?.title || item?.audiobook?.title || "This request";
    showAppDialog({
      title: "Cancel request?",
      message: `"${title}" will be withdrawn from ReadMeABook. You can request it again later.`,
      buttons: [
        { text: "Keep", style: "cancel" },
        {
          text: "Cancel request",
          style: "destructive",
          onPress: async () => {
            // Snapshot for revert, then remove optimistically so the row leaves
            // immediately on the happy path.
            const snapshot = requests;
            setActing(id);
            setRequests((prev) => (prev || []).filter((r: any) => String(r?.id) !== id));
            try {
              const res = await cancelMyRequest(id, asin);
              if (!res.ok) {
                setRequests(snapshot);
                showAppDialog({
                  title: "Couldn't cancel",
                  message:
                    res.message ||
                    "The request couldn't be cancelled. Check your connection and try again.",
                });
              }
            } finally {
              setActing(null);
            }
          },
        },
      ],
    });
  };

  // Guards a focus/mount refetch against stacking a second in-flight load on
  // top of one already running (rapid tab switches, a resume landing mid-load).
  const loadingRef = React.useRef(false);
  const load = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      setError(false);
      // /api/requests returns the caller's own requests — and for admins,
      // everyone's — always with the rich audiobook include.
      const list = await listMyRequests();
      setRequests(Array.isArray(list) ? list : []);
    } catch (e) {
      console.warn("[RMAB] requests load failed", e);
      setError(true);
      setRequests((prev) => prev ?? []);
    } finally {
      loadingRef.current = false;
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Non-admins get no approval badge, so poll their own request statuses on
  // mount/focus — the store diffs against a persisted baseline and accumulates
  // newly-fulfilled/newly-failed counts into myRequestUpdates (a no-op for
  // admins, and self-debounced against an overlapping in-flight poll).
  const pollMyRequestStatuses = useCallback(() => {
    if (isAdmin) return;
    refreshMyRequestStatuses();
  }, [isAdmin, refreshMyRequestStatuses]);

  useEffect(() => {
    pollMyRequestStatuses();
  }, [pollMyRequestStatuses]);

  // Re-fetch when the screen regains focus (returning from another screen, or
  // the app resuming) so a since-fulfilled/denied status appears without a
  // manual pull-to-refresh. The initial mount already loads via the effect
  // above, so skip the first focus event to avoid a duplicate startup fetch;
  // the loadingRef guard covers any overlap regardless.
  const firstFocusRef = React.useRef(true);
  useEffect(() => {
    const unsubscribe = navigation?.addListener?.("focus", () => {
      if (firstFocusRef.current) {
        firstFocusRef.current = false;
        return;
      }
      load();
      // Also re-poll fulfillment status on a genuine refocus so a since-fulfilled
      // request surfaces its banner without a manual pull-to-refresh.
      pollMyRequestStatuses();
    });
    return unsubscribe;
  }, [navigation, load, pollMyRequestStatuses]);

  // Snapshot store-accumulated fulfillment updates into a local, dismissible
  // banner, then immediately clear the store counter. Snapshotting into local
  // state BEFORE clearing means the banner still renders (from the snapshot)
  // even though the store is reset — so a pending→available transition that
  // happens while the app is open is surfaced, never silently re-baselined away.
  // A later re-poll re-accumulates into a fresh counter, which merges in here.
  const [updatesBanner, setUpdatesBanner] = useState<{ fulfilled: number; failed: number } | null>(
    null
  );
  useEffect(() => {
    if (myRequestUpdates.fulfilled > 0 || myRequestUpdates.failed > 0) {
      setUpdatesBanner((prev) => ({
        fulfilled: (prev?.fulfilled ?? 0) + myRequestUpdates.fulfilled,
        failed: (prev?.failed ?? 0) + myRequestUpdates.failed,
      }));
      clearMyRequestUpdates();
    }
  }, [myRequestUpdates, clearMyRequestUpdates]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const detailCover = detail
    ? resolveRmabUrl(detail.coverArtUrl || detail.audiobook?.coverArtUrl)
    : undefined;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }} edges={["top", "left", "right"]}>
      <View style={{ flexDirection: "row", alignItems: "center", paddingVertical: 12, paddingHorizontal: 8 }}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={{ padding: 8, marginRight: 4 }}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Icon name="back" size={24} color={colors.onSurface} />
        </TouchableOpacity>
        <Text style={{ color: colors.onSurface, fontSize: 22, fontWeight: "600" }}>{canManage ? "Requests" : "My Requests"}</Text>
      </View>

      <RmabSessionExpiredBanner
        onManualReconnect={(msg) => navigation.navigate("Settings", { openRmabConnect: true, rmabConnectError: msg })}
      />

      {updatesBanner && (updatesBanner.fulfilled > 0 || updatesBanner.failed > 0) ? (
        // Failures read as the more urgent signal, so a mixed banner uses the
        // error role; an all-good banner uses the primary (success) role.
        (() => {
          const isError = updatesBanner.failed > 0;
          const bg = isError ? colors.errorContainer : colors.primaryContainer;
          const fg = isError ? colors.onErrorContainer : colors.onPrimaryContainer;
          const message = updatesBannerMessage(updatesBanner.fulfilled, updatesBanner.failed);
          return (
            <View
              accessibilityLiveRegion="polite"
              accessibilityRole="alert"
              style={{
                flexDirection: "row",
                alignItems: "center",
                marginHorizontal: 16,
                marginBottom: 8,
                paddingHorizontal: 14,
                paddingVertical: 10,
                backgroundColor: bg,
                borderRadius: 12,
              }}
            >
              <Icon name={isError ? "warning" : "check"} size={18} color={fg} />
              <Text style={{ color: fg, fontSize: 14, fontWeight: "600", marginLeft: 8, flex: 1 }}>
                {message}
              </Text>
              <Pressable
                onPress={() => setUpdatesBanner(null)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Dismiss"
                android_ripple={{ color: withAlpha(fg, 0.13) }}
                style={{ padding: 4, marginLeft: 8 }}
              >
                <Icon name="close" size={16} color={fg} />
              </Pressable>
            </View>
          );
        })()
      ) : null}

      {requests === null ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : (
        <FlatList
          data={requests}
          keyExtractor={(r: any, i) => String(r?.id ?? i)}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
          contentContainerStyle={{ paddingBottom: 32 }}
          // A failed refresh with a list already showing was silent — the
          // stale statuses just sat there looking current.
          ListHeaderComponent={
            error && (requests?.length ?? 0) > 0 ? (
              <View
                accessibilityLiveRegion="polite"
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  marginHorizontal: 16,
                  marginBottom: 8,
                  paddingHorizontal: 14,
                  paddingVertical: 10,
                  backgroundColor: colors.errorContainer,
                  borderRadius: 12,
                }}
              >
                <Icon name="warning" size={16} color={colors.onErrorContainer} />
                <Text style={{ color: colors.onErrorContainer, fontSize: 13, marginLeft: 8, flex: 1 }}>
                  Couldn't refresh — showing older statuses. Pull to retry.
                </Text>
              </View>
            ) : null
          }
          ListEmptyComponent={
            <EmptyState
              icon={error ? "warning" : "send"}
              title={error ? "Couldn't load requests" : "No requests yet"}
              message={
                error
                  ? "Pull to retry."
                  : "Request missing books from search, series, or author pages."
              }
            />
          }
          renderItem={({ item }: any) => {
            const meta = statusMeta(item?.status, colors);
            const cover = item?.coverArtUrl || item?.audiobook?.coverArtUrl;
            const id = String(item?.id ?? "");
            const awaiting = ["pending_approval", "awaiting_approval"].includes(
              (item?.status || "").toLowerCase()
            );
            const coverUri = resolveRmabUrl(cover);
            return (
              // Plain View row: were this a Pressable (accessible=true), TalkBack/
              // VoiceOver would collapse the row into one node and the nested
              // Approve/Deny/Delete buttons would be unreachable. The details
              // target is the cover/title/status area; actions are siblings.
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  paddingHorizontal: 16,
                  paddingVertical: 10,
                }}
              >
                <Pressable
                  onPress={() => setDetail(item)}
                  accessibilityRole="button"
                  accessibilityLabel={`Details for ${item?.title || item?.audiobook?.title || "request"}`}
                  android_ripple={{ color: withAlpha(colors.primary, 0.08) }}
                  style={{ flex: 1, flexDirection: "row", alignItems: "center" }}
                >
                  <Image
                    source={coverUri ? { uri: coverUri } : undefined}
                    style={{ width: 48, height: 48, borderRadius: 6, backgroundColor: colors.surfaceContainerHigh }}
                    contentFit="cover"
                  />
                  <View style={{ flex: 1, marginLeft: 12 }}>
                    <Text numberOfLines={1} style={{ color: colors.onSurface, fontSize: 16, fontWeight: "500" }}>
                      {item?.title || item?.audiobook?.title || "Unknown"}
                    </Text>
                    <Text numberOfLines={1} style={{ color: colors.onSurfaceVariant, fontSize: 13, marginTop: 2 }}>
                      {[
                        item?.author || item?.audiobook?.author,
                        // Admin view: whose request this is.
                        canManage
                          ? item?.user?.plexUsername || item?.username || item?.user?.username
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" • ")}
                    </Text>
                  </View>
                  <View
                    style={{
                      backgroundColor: meta.bg,
                      borderRadius: 12,
                      paddingHorizontal: 10,
                      paddingVertical: 4,
                      marginLeft: 8,
                    }}
                  >
                    <Text style={{ color: meta.fg, fontSize: 12, fontWeight: "600" }}>{meta.label}</Text>
                  </View>
                </Pressable>

                {canManage && awaiting ? (
                  <>
                    <Pressable
                      onPress={() => onApprove(id, "approve")}
                      disabled={acting === id}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel={`Approve ${item?.title || "request"}`}
                      android_ripple={{ color: withAlpha(colors.onPrimaryContainer, 0.13) }}
                      style={{
                        marginLeft: 8,
                        width: 36,
                        height: 36,
                        borderRadius: 18,
                        backgroundColor: colors.primaryContainer,
                        alignItems: "center",
                        justifyContent: "center",
                        opacity: acting === id ? 0.5 : 1,
                      }}
                    >
                      <Icon name="check" size={18} color={colors.onPrimaryContainer} />
                    </Pressable>
                    <Pressable
                      onPress={() => onApprove(id, "deny")}
                      disabled={acting === id}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel={`Deny ${item?.title || "request"}`}
                      android_ripple={{ color: withAlpha(colors.onSurfaceVariant, 0.13) }}
                      style={{
                        marginLeft: 6,
                        width: 36,
                        height: 36,
                        borderRadius: 18,
                        backgroundColor: colors.surfaceContainerHigh,
                        alignItems: "center",
                        justifyContent: "center",
                        opacity: acting === id ? 0.5 : 1,
                      }}
                    >
                      <Icon name="close" size={18} color={colors.onSurfaceVariant} />
                    </Pressable>
                  </>
                ) : null}

                {canManage ? (
                  <Pressable
                    onPress={() => onDelete(id)}
                    disabled={acting === id}
                    accessibilityRole="button"
                    accessibilityLabel={
                      confirmingDelete === id
                        ? `Confirm delete ${item?.title || "request"}`
                        : `Delete ${item?.title || "request"}`
                    }
                    android_ripple={{ color: withAlpha(colors.error, 0.13) }}
                    style={{
                      marginLeft: 6,
                      height: 36,
                      minWidth: 36,
                      borderRadius: 18,
                      paddingHorizontal: confirmingDelete === id ? 12 : 0,
                      backgroundColor:
                        confirmingDelete === id ? colors.error : withAlpha(colors.error, 0.08),
                      alignItems: "center",
                      justifyContent: "center",
                      flexDirection: "row",
                      opacity: acting === id ? 0.5 : 1,
                    }}
                  >
                    <Icon
                      name="trash"
                      size={18}
                      color={confirmingDelete === id ? colors.onError : colors.error}
                    />
                    {confirmingDelete === id ? (
                      <Text style={{ color: colors.onError, fontSize: 12, fontWeight: "700", marginLeft: 4 }}>
                        Sure?
                      </Text>
                    ) : null}
                  </Pressable>
                ) : null}

                {canCancelOwn && isCancellable(item?.status) ? (
                  <Pressable
                    onPress={() => onCancelOwn(item)}
                    disabled={acting === id}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={`Cancel ${item?.title || item?.audiobook?.title || "request"}`}
                    android_ripple={{ color: withAlpha(colors.error, 0.13) }}
                    style={{
                      marginLeft: 8,
                      height: 36,
                      borderRadius: 18,
                      paddingHorizontal: 14,
                      backgroundColor: withAlpha(colors.error, 0.08),
                      alignItems: "center",
                      justifyContent: "center",
                      flexDirection: "row",
                      opacity: acting === id ? 0.5 : 1,
                    }}
                  >
                    <Icon name="close" size={16} color={colors.error} />
                    <Text style={{ color: colors.error, fontSize: 13, fontWeight: "600", marginLeft: 4 }}>
                      Cancel
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            );
          }}
        />
      )}

      {/* Request details */}
      <BottomSheet visible={!!detail} onClose={() => setDetail(null)}>
        {detail ? (
          <View style={{ paddingHorizontal: 24, paddingBottom: 16 }}>
            <View style={{ flexDirection: "row" }}>
              <Image
                source={detailCover ? { uri: detailCover } : undefined}
                style={{ width: 96, height: 96, borderRadius: 10, backgroundColor: colors.surfaceContainerHigh }}
                contentFit="cover"
              />
              <View style={{ flex: 1, marginLeft: 16, justifyContent: "center" }}>
                <Text style={{ color: colors.onSurface, fontSize: 19, fontWeight: "600" }} numberOfLines={3}>
                  {detail.title || detail.audiobook?.title || "Unknown"}
                </Text>
                {detail.author || detail.audiobook?.author ? (
                  <Text style={{ color: colors.onSurfaceVariant, fontSize: 14, marginTop: 4 }} numberOfLines={1}>
                    {detail.author || detail.audiobook?.author}
                  </Text>
                ) : null}
                {detail.audiobook?.narrator ? (
                  <Text style={{ color: colors.onSurfaceVariant, fontSize: 13, marginTop: 2 }} numberOfLines={1}>
                    Read by {detail.audiobook.narrator}
                  </Text>
                ) : null}
              </View>
            </View>

            <View style={{ flexDirection: "row", alignItems: "center", marginTop: 14, flexWrap: "wrap", gap: 8 }}>
              {(() => {
                const meta = statusMeta(detail.status, colors);
                return (
                  <View style={{ backgroundColor: meta.bg, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4 }}>
                    <Text style={{ color: meta.fg, fontSize: 12, fontWeight: "600" }}>{meta.label}</Text>
                  </View>
                );
              })()}
              {detail.audiobook?.series ? (
                <View style={{ backgroundColor: colors.surfaceContainerHigh, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4 }}>
                  <Text style={{ color: colors.onSurfaceVariant, fontSize: 12, fontWeight: "600" }}>
                    {detail.audiobook.series}
                    {detail.audiobook.seriesPart ? ` #${detail.audiobook.seriesPart}` : ""}
                  </Text>
                </View>
              ) : null}
              {detail.audiobook?.year ? (
                <View style={{ backgroundColor: colors.surfaceContainerHigh, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4 }}>
                  <Text style={{ color: colors.onSurfaceVariant, fontSize: 12, fontWeight: "600" }}>
                    {detail.audiobook.year}
                  </Text>
                </View>
              ) : null}
            </View>

            {(detail.user?.plexUsername || detail.createdAt) ? (
              <Text style={{ color: colors.onSurfaceVariant, fontSize: 12, marginTop: 12 }}>
                {[
                  detail.user?.plexUsername ? `Requested by ${detail.user.plexUsername}` : null,
                  detail.createdAt ? new Date(detail.createdAt).toLocaleDateString() : null,
                ]
                  .filter(Boolean)
                  .join(" • ")}
              </Text>
            ) : null}

            <BookDescription
              text={detail.audiobook?.description}
              asin={detail.audiobook?.audibleAsin || detail.asin}
            />

            {canManage ? (
              <View style={{ flexDirection: "row", justifyContent: "flex-end", columnGap: 10, marginTop: 18 }}>
                {["pending_approval", "awaiting_approval"].includes((detail.status || "").toLowerCase()) ? (
                  <>
                    <Pressable
                      onPress={async () => {
                        const id = String(detail.id ?? "");
                        setDetail(null);
                        await onApprove(id, "approve");
                      }}
                      accessibilityRole="button"
                      accessibilityLabel="Approve request"
                      android_ripple={{ color: withAlpha(colors.onPrimaryContainer, 0.13) }}
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        backgroundColor: colors.primaryContainer,
                        borderRadius: 20,
                        height: 40,
                        paddingHorizontal: 18,
                      }}
                    >
                      <Icon name="check" size={18} color={colors.onPrimaryContainer} />
                      <Text style={{ color: colors.onPrimaryContainer, fontSize: 14, fontWeight: "600", marginLeft: 6 }}>
                        Approve
                      </Text>
                    </Pressable>
                    <Pressable
                      onPress={async () => {
                        const id = String(detail.id ?? "");
                        setDetail(null);
                        await onApprove(id, "deny");
                      }}
                      accessibilityRole="button"
                      accessibilityLabel="Deny request"
                      android_ripple={{ color: withAlpha(colors.onSurfaceVariant, 0.13) }}
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        backgroundColor: colors.surfaceContainerHigh,
                        borderRadius: 20,
                        height: 40,
                        paddingHorizontal: 18,
                      }}
                    >
                      <Icon name="close" size={18} color={colors.onSurfaceVariant} />
                      <Text style={{ color: colors.onSurfaceVariant, fontSize: 14, fontWeight: "600", marginLeft: 6 }}>
                        Deny
                      </Text>
                    </Pressable>
                  </>
                ) : null}
                <Pressable
                  onPress={async () => {
                    const id = String(detail.id ?? "");
                    setDetail(null);
                    // Detail-sheet delete is already a deliberate action — skip
                    // the list's two-tap arm step.
                    setActing(id);
                    try {
                      await deleteRequest(id);
                      setRequests((prev) => (prev || []).filter((r: any) => String(r?.id) !== id));
                      refreshPendingCount();
                    } catch (e) {
                      console.warn("[RMAB] delete failed", e);
                      // The sheet already closed — without this the item just
                      // stays in the list with no explanation.
                      showAppDialog({
                        title: "Couldn't delete",
                        message: "The request couldn't be deleted. Check your connection (or reconnect ReadMeABook in Settings) and try again."
                      });
                    } finally {
                      setActing(null);
                    }
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="Delete request"
                  android_ripple={{ color: withAlpha(colors.error, 0.13) }}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    backgroundColor: withAlpha(colors.error, 0.08),
                    borderRadius: 20,
                    height: 40,
                    paddingHorizontal: 18,
                  }}
                >
                  <Icon name="trash" size={18} color={colors.error} />
                  <Text style={{ color: colors.error, fontSize: 14, fontWeight: "600", marginLeft: 6 }}>
                    Delete
                  </Text>
                </Pressable>
              </View>
            ) : null}

            {canCancelOwn && isCancellable(detail.status) ? (
              <View style={{ flexDirection: "row", justifyContent: "flex-end", marginTop: 18 }}>
                <Pressable
                  onPress={() => {
                    const item = detail;
                    setDetail(null);
                    onCancelOwn(item);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="Cancel request"
                  android_ripple={{ color: withAlpha(colors.error, 0.13) }}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    backgroundColor: withAlpha(colors.error, 0.08),
                    borderRadius: 20,
                    height: 40,
                    paddingHorizontal: 18,
                  }}
                >
                  <Icon name="close" size={18} color={colors.error} />
                  <Text style={{ color: colors.error, fontSize: 14, fontWeight: "600", marginLeft: 6 }}>
                    Cancel request
                  </Text>
                </Pressable>
              </View>
            ) : null}
          </View>
        ) : null}
      </BottomSheet>
    </SafeAreaView>
  );
}
