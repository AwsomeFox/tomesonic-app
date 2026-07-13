import React, { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  ActivityIndicator,
  RefreshControl,
  Pressable,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useThemeColors } from "../theme/useThemeColors";
import { withAlpha } from "../theme/palette";
import Icon from "../components/Icon";
import HintPressable from "../components/HintPressable";
import ErrorState from "../components/ErrorState";
import { getLibraryStats } from "../utils/abs/libraries";
import type { AbsLibraryStats } from "../utils/abs/types";

/**
 * Library-wide stats (GET /api/libraries/:id/stats) — the non-admin sibling of
 * the personal StatsScreen: totals, largest/longest items, and top
 * genres/authors for the CURRENT library. Read-only; entered from StatsScreen
 * (route "LibraryStats" with { libraryId }).
 */

function durationPretty(seconds: number): string {
  if (!seconds || seconds <= 0) return "0 min";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return m > 0 ? `${h} hr ${m} min` : `${h} hr`;
  return `${m} min`;
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const rounded = v >= 100 ? Math.round(v) : Math.round(v * 10) / 10;
  return `${rounded} ${units[i]}`;
}

function formatNumber(n: number): string {
  return Number(n || 0).toLocaleString("en-US");
}

export default function LibraryStatsScreen({ route, navigation }: any) {
  const colors = useThemeColors();
  const libraryId: string | undefined = route?.params?.libraryId;

  const [stats, setStats] = useState<AbsLibraryStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const loadStats = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!libraryId) {
        setError("No library selected.");
        setLoading(false);
        return;
      }
      if (!opts?.silent) setLoading(true);
      setError(null);
      try {
        // getLibraryStats throws a normalized AbsError — its message is
        // already user-facing (offline vs forbidden vs unsupported vs server).
        const data = await getLibraryStats(libraryId);
        setStats(data || null);
      } catch (e: any) {
        // Keep already-rendered stats through a failed silent refresh.
        if (!stats) setError(e?.message || "Couldn't load library stats.");
      } finally {
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [libraryId]
  );

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await loadStats({ silent: true });
    } finally {
      setRefreshing(false);
    }
  };

  // Defensive slices: older servers omit the breakdown arrays entirely.
  const genres = Array.isArray(stats?.genresWithCount) ? stats!.genresWithCount!.slice(0, 8) : [];
  const authors = Array.isArray(stats?.authorsWithCount) ? stats!.authorsWithCount!.slice(0, 8) : [];
  const longest = Array.isArray(stats?.longestItems) ? stats!.longestItems!.slice(0, 5) : [];
  const largest = Array.isArray(stats?.largestItems) ? stats!.largestItems!.slice(0, 5) : [];
  const maxGenreCount = genres.reduce((m: number, g: any) => Math.max(m, Number(g?.count || 0)), 0);

  const openItem = (itemId?: string) => {
    if (itemId) navigation.navigate("ItemDetail", { itemId });
  };

  const card = {
    marginHorizontal: 20,
    marginBottom: 16,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 14,
    backgroundColor: colors.surfaceContainerHigh,
  } as const;

  const cardTitle = {
    color: colors.onSurface,
    fontSize: 16,
    fontWeight: "700" as const,
    marginBottom: 10,
  };

  const totalsRows: Array<{ label: string; value: string }> = stats
    ? [
        { label: "Items", value: formatNumber(stats.totalItems) },
        { label: "Authors", value: formatNumber(stats.totalAuthors || 0) },
        { label: "Genres", value: formatNumber(stats.totalGenres || 0) },
        { label: "Total time", value: durationPretty(Number(stats.totalDuration || 0)) },
        { label: "Size on disk", value: formatBytes(Number(stats.totalSize || 0)) },
        {
          label: "Audio tracks",
          // Older servers name this field numAudioTrack (singular).
          value: formatNumber(Number(stats.numAudioTracks ?? (stats as any).numAudioTrack ?? 0)),
        },
      ]
    : [];

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }} edges={["top", "left", "right"]}>
      {/* Header — same hand-rolled back+title idiom as StatsScreen */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingTop: 8,
          paddingBottom: 16,
          paddingHorizontal: 16,
        }}
      >
        <HintPressable
          onPress={() => navigation.goBack()}
          style={{ paddingRight: 16, paddingVertical: 4 }}
          android_ripple={{ color: withAlpha(colors.onSurface, 0.12), borderless: true, radius: 22 }}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Icon name="back" size={24} color={colors.onSurface} />
        </HintPressable>
        <Text accessibilityRole="header" style={{ color: colors.onSurface, fontSize: 22, fontWeight: "600" }}>
          Library Stats
        </Text>
      </View>

      {loading ? (
        <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : error ? (
        <ErrorState
          style={{ flex: 1 }}
          title="Couldn't load library stats"
          message={error}
          onRetry={libraryId ? () => loadStats() : undefined}
        />
      ) : stats ? (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: 40 }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              colors={[colors.primary]}
              progressBackgroundColor={colors.surfaceContainerHigh}
            />
          }
        >
          {/* Totals */}
          <View style={card}>
            <Text style={cardTitle}>Totals</Text>
            {totalsRows.map((row) => (
              <View
                key={row.label}
                accessible
                accessibilityLabel={`${row.label}: ${row.value}`}
                style={{ flexDirection: "row", alignItems: "center", paddingVertical: 5 }}
              >
                <Text style={{ flex: 1, color: colors.onSurfaceVariant, fontSize: 14 }}>{row.label}</Text>
                <Text style={{ color: colors.onSurface, fontSize: 15, fontWeight: "700" }}>{row.value}</Text>
              </View>
            ))}
          </View>

          {/* Top genres — horizontal bars */}
          {genres.length > 0 ? (
            <View style={card}>
              <Text style={cardTitle}>Top genres</Text>
              {genres.map((g: any, i: number) => {
                const count = Number(g?.count || 0);
                const frac = maxGenreCount > 0 ? count / maxGenreCount : 0;
                const name = g?.genre || g?.name || "";
                return (
                  <View
                    key={`${name}-${i}`}
                    accessible
                    accessibilityLabel={`${name}, ${count} ${count === 1 ? "item" : "items"}`}
                    style={{ paddingVertical: 5 }}
                  >
                    <View style={{ flexDirection: "row", marginBottom: 4 }}>
                      <Text numberOfLines={1} style={{ flex: 1, color: colors.onSurface, fontSize: 14 }}>
                        {name}
                      </Text>
                      <Text style={{ color: colors.onSurfaceVariant, fontSize: 13, marginLeft: 8 }}>
                        {formatNumber(count)}
                      </Text>
                    </View>
                    <View
                      style={{
                        height: 8,
                        borderRadius: 4,
                        backgroundColor: colors.surfaceContainerHighest,
                        overflow: "hidden",
                      }}
                    >
                      <View
                        style={{
                          width: `${Math.round(frac * 100)}%`,
                          height: "100%",
                          borderRadius: 4,
                          backgroundColor: colors.primary,
                        }}
                      />
                    </View>
                  </View>
                );
              })}
            </View>
          ) : null}

          {/* Top authors */}
          {authors.length > 0 ? (
            <View style={card}>
              <Text style={cardTitle}>Top authors</Text>
              {authors.map((a: any, i: number) => {
                const count = Number(a?.count || 0);
                return (
                  <View
                    key={a?.id || `${a?.name}-${i}`}
                    accessible
                    accessibilityLabel={`${a?.name || "Unknown author"}, ${count} ${count === 1 ? "book" : "books"}`}
                    style={{ flexDirection: "row", alignItems: "center", paddingVertical: 6 }}
                  >
                    <Text style={{ color: colors.onSurfaceVariant, fontSize: 13, width: 28 }}>{i + 1}.</Text>
                    <Text numberOfLines={1} style={{ flex: 1, color: colors.onSurface, fontSize: 14, marginRight: 8 }}>
                      {a?.name || "Unknown author"}
                    </Text>
                    <Text style={{ color: colors.onSurfaceVariant, fontSize: 13 }}>{formatNumber(count)}</Text>
                  </View>
                );
              })}
            </View>
          ) : null}

          {/* Longest items */}
          {longest.length > 0 ? (
            <View style={card}>
              <Text style={cardTitle}>Longest items</Text>
              {longest.map((it: any, i: number) => (
                <Pressable
                  key={it?.id || i}
                  onPress={() => openItem(it?.id)}
                  android_ripple={{ color: withAlpha(colors.onSurface, 0.08) }}
                  accessibilityRole="button"
                  accessibilityLabel={`${it?.title || "Item"}, ${durationPretty(Number(it?.duration || 0))}`}
                  style={{ flexDirection: "row", alignItems: "center", paddingVertical: 6 }}
                >
                  <Text style={{ color: colors.onSurfaceVariant, fontSize: 13, width: 28 }}>{i + 1}.</Text>
                  <Text numberOfLines={1} style={{ flex: 1, color: colors.onSurface, fontSize: 14, marginRight: 8 }}>
                    {it?.title || ""}
                  </Text>
                  <Text style={{ color: colors.onSurfaceVariant, fontSize: 13 }}>
                    {durationPretty(Number(it?.duration || 0))}
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : null}

          {/* Largest items */}
          {largest.length > 0 ? (
            <View style={card}>
              <Text style={cardTitle}>Largest items</Text>
              {largest.map((it: any, i: number) => (
                <Pressable
                  key={it?.id || i}
                  onPress={() => openItem(it?.id)}
                  android_ripple={{ color: withAlpha(colors.onSurface, 0.08) }}
                  accessibilityRole="button"
                  accessibilityLabel={`${it?.title || "Item"}, ${formatBytes(Number(it?.size || 0))}`}
                  style={{ flexDirection: "row", alignItems: "center", paddingVertical: 6 }}
                >
                  <Text style={{ color: colors.onSurfaceVariant, fontSize: 13, width: 28 }}>{i + 1}.</Text>
                  <Text numberOfLines={1} style={{ flex: 1, color: colors.onSurface, fontSize: 14, marginRight: 8 }}>
                    {it?.title || ""}
                  </Text>
                  <Text style={{ color: colors.onSurfaceVariant, fontSize: 13 }}>
                    {formatBytes(Number(it?.size || 0))}
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : null}
        </ScrollView>
      ) : null}
    </SafeAreaView>
  );
}
