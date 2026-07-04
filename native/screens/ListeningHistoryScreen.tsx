import React, { useEffect, useState } from "react";
import { View, Text, Pressable, FlatList, ActivityIndicator } from "react-native";
import { Image } from "expo-image";
import { SafeAreaView } from "react-native-safe-area-context";
import { api } from "../utils/api";
import { storageHelper } from "../utils/storage";
import { useThemeColors } from "../theme/useThemeColors";
import Icon from "../components/Icon";

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

export default function ListeningHistoryScreen({ navigation }: any) {
  const colors = useThemeColors();
  const [sessions, setSessions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const serverConfig = storageHelper.getServerConfig();
  const serverAddress = serverConfig?.address?.replace(/\/$/, "") || "";
  const token = serverConfig?.token || "";

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        setError(null);
        const res = await api.get("/api/me/listening-sessions", {
          params: { itemsPerPage: 100, page: 0 },
        });
        if (!cancelled) {
          setSessions(Array.isArray(res.data?.sessions) ? res.data.sessions : []);
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
  }, []);

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
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Icon name="back" size={24} color={colors.onSurface} />
        </Pressable>
        <Text style={{ color: colors.onSurface, fontSize: 20, fontWeight: "700", marginLeft: 4 }}>
          Listening History
        </Text>
      </View>

      {loading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : error ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 32 }}>
          <Icon name="warning" size={36} color={colors.onSurfaceVariant} />
          <Text style={{ color: colors.onSurfaceVariant, fontSize: 15, marginTop: 12, textAlign: "center" }}>
            {error}
          </Text>
        </View>
      ) : (
        <FlatList
          data={sessions}
          keyExtractor={(item, index) => item?.id ? String(item.id) : String(index)}
          contentContainerStyle={{ padding: 16 }}
          ListEmptyComponent={
            <View style={{ alignItems: "center", justifyContent: "center", paddingVertical: 80 }}>
              <View
                style={{
                  width: 72,
                  height: 72,
                  borderRadius: 36,
                  backgroundColor: colors.secondaryContainer,
                  alignItems: "center",
                  justifyContent: "center",
                  marginBottom: 16,
                }}
              >
                <Icon name="clock" size={36} color={colors.onSecondaryContainer} />
              </View>
              <Text style={{ color: colors.onSurfaceVariant, fontSize: 15, textAlign: "center" }}>
                No listening history yet.
              </Text>
            </View>
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
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  padding: 10,
                  minHeight: 76,
                  backgroundColor: colors.surfaceContainer,
                  borderRadius: 16,
                  marginBottom: 12,
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
