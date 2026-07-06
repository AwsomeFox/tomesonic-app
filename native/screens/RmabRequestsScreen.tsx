import React, { useCallback, useEffect, useState } from "react";
import { View, Text, FlatList, TouchableOpacity, ActivityIndicator, RefreshControl } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Image } from "expo-image";
import { useThemeColors } from "../theme/useThemeColors";
import Icon from "../components/Icon";
import { listMyRequests } from "../utils/rmab";

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
              </View>
            );
          }}
        />
      )}
    </SafeAreaView>
  );
}
