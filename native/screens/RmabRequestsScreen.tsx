import React, { useCallback, useEffect, useState } from "react";
import { View, Text, FlatList, TouchableOpacity, ActivityIndicator, RefreshControl } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Image } from "expo-image";
import { useThemeColors } from "../theme/useThemeColors";
import Icon from "../components/Icon";
import { listMyRequests, deleteRequest, approveRequest, resolveRmabUrl } from "../utils/rmab";
import BottomSheet from "../components/BottomSheet";
import BookDescription from "../components/BookDescription";
import { useRmabStore } from "../store/useRmabStore";
import Pressable from "../components/HintPressable";

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
      return { label: "Failed", bg: colors.errorContainer || "#F9DEDC", fg: colors.error };
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
  const canManage = isAdmin && authMode === "jwt";
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
    } finally {
      setActing(null);
    }
  };

  const load = useCallback(async () => {
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
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

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
          ListEmptyComponent={
            <View style={{ alignItems: "center", paddingTop: 64, paddingHorizontal: 32 }}>
              <Icon name="send" size={44} color={colors.onSurfaceVariant} />
              <Text style={{ color: colors.onSurface, fontSize: 18, fontWeight: "600", marginTop: 16 }}>
                {error ? "Couldn't load requests" : "No requests yet"}
              </Text>
              <Text style={{ color: colors.onSurfaceVariant, textAlign: "center", marginTop: 8 }}>
                {error
                  ? "Pull to retry."
                  : "Request missing books from search, series, or author pages."}
              </Text>
            </View>
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
                  android_ripple={{ color: colors.primary + "14" }}
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
                      accessibilityRole="button"
                      accessibilityLabel={`Approve ${item?.title || "request"}`}
                      android_ripple={{ color: colors.onPrimaryContainer + "22" }}
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
                      accessibilityRole="button"
                      accessibilityLabel={`Deny ${item?.title || "request"}`}
                      android_ripple={{ color: colors.onSurfaceVariant + "22" }}
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
                    android_ripple={{ color: colors.error + "22" }}
                    style={{
                      marginLeft: 6,
                      height: 36,
                      minWidth: 36,
                      borderRadius: 18,
                      paddingHorizontal: confirmingDelete === id ? 12 : 0,
                      backgroundColor:
                        confirmingDelete === id ? colors.error : "rgba(179, 38, 30, 0.08)",
                      alignItems: "center",
                      justifyContent: "center",
                      flexDirection: "row",
                      opacity: acting === id ? 0.5 : 1,
                    }}
                  >
                    <Icon
                      name="trash"
                      size={18}
                      color={confirmingDelete === id ? colors.onPrimary : colors.error}
                    />
                    {confirmingDelete === id ? (
                      <Text style={{ color: colors.onPrimary, fontSize: 12, fontWeight: "700", marginLeft: 4 }}>
                        Sure?
                      </Text>
                    ) : null}
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
                      android_ripple={{ color: colors.onPrimaryContainer + "22" }}
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
                      android_ripple={{ color: colors.onSurfaceVariant + "22" }}
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
                    } finally {
                      setActing(null);
                    }
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="Delete request"
                  android_ripple={{ color: colors.error + "22" }}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    backgroundColor: "rgba(179, 38, 30, 0.08)",
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
          </View>
        ) : null}
      </BottomSheet>
    </SafeAreaView>
  );
}
