import React, { useEffect, useMemo, useState, useCallback } from "react";
import { View, Text, Pressable, ScrollView, TextInput, ActivityIndicator } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useThemeColors } from "../theme/useThemeColors";
import { withAlpha } from "../theme/palette";
import { useLibraryStore } from "../store/useLibraryStore";
import { api } from "../utils/api";
import TopAppBar from "../components/TopAppBar";
import Icon from "../components/Icon";
import EmptyState from "../components/EmptyState";
import ErrorState from "../components/ErrorState";
import { encodeFilterValue } from "../components/FilterModal";
import { useNetworkStatus } from "../hooks/useNetworkStatus";

type Tab = "genres" | "tags";

/**
 * Browse the current library's genres/tags as a searchable, alphabetized list.
 * Tapping a value opens the existing pushed Library list filtered by it
 * (`genres.<enc>` / `tags.<enc>`), the same destination ItemDetail's genre/tag
 * chips use. Data comes from `/api/libraries/{id}/filterdata`. An optional
 * `initialTab` route param opens straight to genres (default) or tags.
 */
export default function GenreBrowseScreen({ navigation, route }: any) {
  const colors = useThemeColors();
  const { currentLibraryId } = useLibraryStore();
  const { isOffline } = useNetworkStatus();

  const initialTab: Tab = route?.params?.initialTab === "tags" ? "tags" : "genres";
  const [tab, setTab] = useState<Tab>(initialTab);
  const [query, setQuery] = useState("");
  const [genres, setGenres] = useState<string[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async () => {
    if (!currentLibraryId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(false);
    try {
      const res = await api.get(`/api/libraries/${currentLibraryId}/filterdata`);
      // Newer ABS returns the filter data at the top level; older/other paths
      // wrap it in `{ filterdata }`. Accept either.
      const data = res.data?.filterdata || res.data || {};
      const toStrings = (arr: any): string[] =>
        Array.isArray(arr)
          ? arr
              .map((x: any) => (typeof x === "string" ? x : x?.name))
              .filter((x: any) => typeof x === "string" && x.trim())
          : [];
      setGenres(toStrings(data.genres));
      setTags(toStrings(data.tags));
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [currentLibraryId]);

  useEffect(() => {
    load();
  }, [load]);

  const list = tab === "genres" ? genres : tags;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q ? list.filter((n) => n.toLowerCase().includes(q)) : list;
    return [...base].sort((a, b) => a.localeCompare(b));
  }, [list, query]);

  const openFiltered = (name: string) => {
    navigation.navigate("Library", {
      filter: `${tab}.${encodeFilterValue(name)}`,
      showBack: true,
      title: name,
    });
  };

  const renderTab = (value: Tab, label: string) => {
    const active = tab === value;
    return (
      <Pressable
        onPress={() => {
          setTab(value);
          setQuery("");
        }}
        accessibilityRole="button"
        accessibilityState={{ selected: active }}
        accessibilityLabel={label}
        android_ripple={{ color: withAlpha(colors.onSurface, 0.08) }}
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          paddingVertical: 10,
          borderRadius: 20,
          overflow: "hidden",
          backgroundColor: active ? colors.secondaryContainer : "transparent",
        }}
      >
        <Text
          style={{
            fontSize: 15,
            fontWeight: "600",
            color: active ? colors.onSecondaryContainer : colors.onSurfaceVariant,
          }}
        >
          {label}
        </Text>
      </Pressable>
    );
  };

  const renderBody = () => {
    if (isOffline) {
      return (
        <EmptyState
          style={{ flex: 1 }}
          icon="cloud-off"
          title="You're offline"
          message="Browse genres and tags when you're connected to your server."
        />
      );
    }
    if (loading) {
      return (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      );
    }
    if (loadError) {
      return (
        <ErrorState
          style={{ flex: 1 }}
          title="Couldn't load genres"
          message="Check your connection to the server, then try again."
          onRetry={load}
        />
      );
    }
    if (filtered.length === 0) {
      return (
        <EmptyState
          style={{ flex: 1 }}
          icon="explore"
          title={
            query.trim()
              ? `No ${tab === "genres" ? "genres" : "tags"} match "${query.trim()}"`
              : `No ${tab === "genres" ? "genres" : "tags"} yet`
          }
          message={
            query.trim()
              ? undefined
              : `Books added to this library will bring their ${tab} here.`
          }
        />
      );
    }
    return (
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 24 }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {filtered.map((name) => (
          <Pressable
            key={name}
            onPress={() => openFiltered(name)}
            accessibilityRole="button"
            accessibilityLabel={`${name}, opens list`}
            android_ripple={{ color: colors.surfaceContainerHighest }}
            style={{
              flexDirection: "row",
              alignItems: "center",
              paddingVertical: 14,
              paddingHorizontal: 12,
              borderRadius: 16,
            }}
          >
            <Icon
              name={tab === "genres" ? "explore" : "bookmark"}
              size={20}
              color={colors.onSurfaceVariant}
              style={{ marginRight: 14 }}
            />
            <Text numberOfLines={1} style={{ flex: 1, fontSize: 16, color: colors.onSurface }}>
              {name}
            </Text>
            <Icon name="chevron-right" size={22} color={colors.onSurfaceVariant} />
          </Pressable>
        ))}
      </ScrollView>
    );
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }} edges={["top", "left", "right"]}>
      <TopAppBar navigation={navigation} showBack title="Browse" />

      {/* Genres / Tags segmented toggle */}
      <View
        style={{
          flexDirection: "row",
          marginHorizontal: 16,
          marginTop: 8,
          padding: 4,
          borderRadius: 24,
          backgroundColor: colors.surfaceContainerHighest,
        }}
      >
        {renderTab("genres", "Genres")}
        {renderTab("tags", "Tags")}
      </View>

      {/* Search field */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          marginHorizontal: 16,
          marginTop: 12,
          marginBottom: 4,
          paddingHorizontal: 16,
          borderRadius: 24,
          backgroundColor: colors.surfaceContainerHighest,
        }}
      >
        <Icon name="search" size={20} color={colors.onSurfaceVariant} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={`Search ${tab === "genres" ? "genres" : "tags"}...`}
          placeholderTextColor={colors.onSurfaceVariant}
          accessibilityLabel={`Search ${tab === "genres" ? "genres" : "tags"}`}
          returnKeyType="search"
          style={{ flex: 1, color: colors.onSurface, fontSize: 16, paddingVertical: 10, marginLeft: 12 }}
        />
        {query.length > 0 ? (
          <Pressable
            onPress={() => setQuery("")}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Clear search"
            style={{ padding: 2 }}
          >
            <Icon name="close" size={18} color={colors.onSurfaceVariant} />
          </Pressable>
        ) : null}
      </View>

      <View style={{ flex: 1, paddingTop: 8 }}>{renderBody()}</View>
    </SafeAreaView>
  );
}
