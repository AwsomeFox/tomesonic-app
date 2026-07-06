import React, { useCallback, useEffect, useState } from "react";
import { View, Text, FlatList, TouchableOpacity, Pressable, ActivityIndicator, RefreshControl } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Image } from "expo-image";
import { useThemeColors } from "../theme/useThemeColors";
import Icon from "../components/Icon";
import { listMyRequests, deleteRequest, approveRequest } from "../utils/rmab";
import { useRmabStore } from "../store/useRmabStore";

/** Friendly label + color role per RMAB request status. */
function statusMeta(status: string, colors: any): { label: string; bg: string; fg: string } {
  switch ((status || "").toLowerCase()) {
    case "available":
    case "completed":
    case "fulfilled":
      return { label: "Available", bg: colors.primaryContainer, fg: colors.onPrimaryContainer };
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
  const canManage = isAdmin && authMode === "jwt";
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);

  const onApprove = async (id: string, action: "approve" | "deny") => {
    setActing(id);
    try {
      await approveRequest(id, action);
      await load();
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
      setTimeout(() => setConfirmingDelete((c) => (c === id ? null : c)), 3000);
      return;
    }
    setConfirmingDelete(null);
    setActing(id);
    try {
      await deleteRequest(id);
      setRequests((prev) => (prev || []).filter((r: any) => String(r?.id) !== id));
    } catch (e) {
      console.warn("[RMAB] delete failed", e);
    } finally {
      setActing(null);
    }
  };

  const load = useCallback(async () => {
    try {
      setError(false);
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
        <Text style={{ color: colors.onSurface, fontSize: 22, fontWeight: "600" }}>My Requests</Text>
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
            return (
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  paddingHorizontal: 16,
                  paddingVertical: 10,
                }}
              >
                <Image
                  source={cover ? { uri: cover } : undefined}
                  style={{ width: 48, height: 48, borderRadius: 6, backgroundColor: colors.surfaceContainerHigh }}
                  contentFit="cover"
                />
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text numberOfLines={1} style={{ color: colors.onSurface, fontSize: 16, fontWeight: "500" }}>
                    {item?.title || item?.audiobook?.title || "Unknown"}
                  </Text>
                  <Text numberOfLines={1} style={{ color: colors.onSurfaceVariant, fontSize: 13, marginTop: 2 }}>
                    {item?.author || item?.audiobook?.author || ""}
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
    </SafeAreaView>
  );
}
