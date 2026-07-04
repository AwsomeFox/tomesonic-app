import React, { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  RefreshControl,
  Modal,
  TextInput,
  ActivityIndicator,
} from "react-native";
import { Image } from "expo-image";
import { SafeAreaView } from "react-native-safe-area-context";
import Animated from "react-native-reanimated";
import { listRowEnter } from "../theme/motion";
import { withAlpha } from "../theme/palette";
import { api } from "../utils/api";
import { useLibraryStore } from "../store/useLibraryStore";
import { useUserStore } from "../store/useUserStore";
import { usePlaybackStore } from "../store/usePlaybackStore";
import { useThemeColors } from "../theme/useThemeColors";
import TopAppBar from "../components/TopAppBar";
import Icon from "../components/Icon";
import { ListSkeleton } from "../components/Skeleton";
import { useUiStore } from "../store/useUiStore";
import SearchContent from "../components/SearchContent";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type Tab = "collections" | "playlists";

const ROW_COVER = 72;

export default function CollectionsPlaylistsScreen({ navigation }: any) {
  const colors = useThemeColors();
  const isSearchActive = useUiStore((s) => s.isSearchActive);
  const { currentLibraryId } = useLibraryStore();
  const { serverConnectionConfig } = useUserStore();
  const [activeTab, setActiveTab] = useState<Tab>("collections");
  const [collections, setCollections] = useState<any[]>([]);
  const [playlists, setPlaylists] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const hasSession = usePlaybackStore((s) => s.currentSession !== null);
  // Create-new dialog (for whichever tab is active).
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const serverAddress = serverConnectionConfig?.address?.replace(/\/$/, "") || "";
  const token = serverConnectionConfig?.token || "";

  const getCoverUrl = (itemId: string) => {
    if (!itemId || !serverAddress || !token) return null;
    return `${serverAddress}/api/items/${itemId}/cover?width=400&format=webp&token=${token}`;
  };

  const fetchData = useCallback(async () => {
    try {
      setLoadError(false);
      if (activeTab === "collections" && currentLibraryId) {
        const res = await api.get(`/api/libraries/${currentLibraryId}/collections`);
        setCollections(res.data?.results || res.data?.collections || res.data || []);
      } else if (activeTab === "playlists" && currentLibraryId) {
        // Library-scoped (matches the collections tab and the Add-to sheet) —
        // the global /api/playlists mixes in other libraries' playlists.
        const res = await api.get(`/api/libraries/${currentLibraryId}/playlists`);
        setPlaylists(res.data?.results || res.data?.playlists || res.data || []);
      }
    } catch (err) {
      console.error(`[CollectionsPlaylists] Failed to load ${activeTab}:`, err);
      setLoadError(true);
    }
  }, [activeTab, currentLibraryId]);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      await fetchData();
      setLoading(false);
    };
    load();
  }, [fetchData]);

  // Returning to the tab: silently revalidate (lists can change from a book's
  // "Add to…" sheet or a create elsewhere). fetchData doesn't flip `loading`,
  // so the visible list never flashes to a skeleton.
  const firstFocusRef = React.useRef(true);
  useEffect(() => {
    const unsub = navigation.addListener("focus", () => {
      if (firstFocusRef.current) {
        firstFocusRef.current = false;
        return;
      }
      fetchData();
    });
    return unsub;
  }, [navigation, fetchData]);

  const onRefresh = async () => {
    setRefreshing(true);
    await fetchData();
    setRefreshing(false);
  };

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      if (activeTab === "collections") {
        if (!currentLibraryId) throw new Error("No library selected");
        await api.post("/api/collections", { libraryId: currentLibraryId, name, books: [] });
      } else {
        if (!currentLibraryId) throw new Error("No library selected");
        await api.post("/api/playlists", { libraryId: currentLibraryId, name, items: [] });
      }
      setCreateOpen(false);
      setNewName("");
      await fetchData();
    } catch (e: any) {
      console.warn("[CollectionsPlaylists] create failed", e);
      setCreateError(
        e?.response?.data?.toString?.() || "Couldn't create it — check the server connection."
      );
    } finally {
      setCreating(false);
    }
  };

  // First up-to-4 book cover URLs for the collage. Collections use `books`;
  // playlists wrap each item's `libraryItem`.
  const getCollageCovers = (item: any): (string | null)[] => {
    const isCollection = activeTab === "collections";
    let ids: string[];
    if (isCollection) {
      ids = (item.books || [])
        .map((b: any) => b.id || b.libraryItemId)
        .filter(Boolean);
    } else {
      ids = (item.items || [])
        .map((pi: any) => pi.libraryItemId || pi.libraryItem?.id)
        .filter(Boolean);
    }
    return ids.slice(0, 4).map((id: string) => getCoverUrl(id));
  };

  const renderRow = (item: any, index: number) => {
    const isCollection = activeTab === "collections";
    const covers = getCollageCovers(item);
    const name = item.name || item.title || "Untitled";
    const itemCount = (isCollection ? item.books : item.items)?.length || 0;

    return (
      <AnimatedPressable
        key={item.id || index}
        entering={listRowEnter(index)}
        onPress={() =>
          navigation.navigate(isCollection ? "CollectionDetail" : "PlaylistDetail", {
            collectionId: item.id,
            playlistId: item.id,
          })
        }
        android_ripple={{ color: colors.surfaceContainerHighest }}
        accessibilityRole="button"
        accessibilityLabel={`${isCollection ? "Collection" : "Playlist"}: ${name}, ${itemCount} ${itemCount === 1 ? "item" : "items"}`}
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 16,
          paddingVertical: 10,
        }}
      >
        {/* Cover / collage */}
        <CollageCover covers={covers} size={ROW_COVER} colors={colors} />

        {/* Name + item count */}
        <View style={{ flex: 1, marginLeft: 16 }}>
          <Text
            numberOfLines={2}
            style={{ color: colors.onSurface, fontSize: 16, fontWeight: "700" }}
          >
            {name}
          </Text>
          <Text style={{ color: colors.onSurfaceVariant, fontSize: 14, marginTop: 2 }}>
            {itemCount} {itemCount === 1 ? "item" : "items"}
          </Text>
        </View>
      </AnimatedPressable>
    );
  };

  const data = activeTab === "collections" ? collections : playlists;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }} edges={["top", "left", "right"]}>
      <TopAppBar navigation={navigation} />

      {isSearchActive ? (
        <SearchContent navigation={navigation} />
      ) : (
        <>
          {/* Segmented toggle: Collections | Playlists (+ create button) */}
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              paddingHorizontal: 16,
              paddingTop: 10,
              paddingBottom: 6,
            }}
          >
        <View
          style={{
            flex: 1,
            flexDirection: "row",
            borderWidth: 1,
            borderColor: colors.outline,
            borderRadius: 20,
            overflow: "hidden",
          }}
        >
          {(["collections", "playlists"] as Tab[]).map((tab, i) => {
            const selected = activeTab === tab;
            return (
              <Pressable
                key={tab}
                onPress={() => setActiveTab(tab)}
                android_ripple={{ color: colors.surfaceContainerHighest }}
                accessibilityRole="tab"
                accessibilityState={{ selected }}
                style={{
                  flex: 1,
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "center",
                  paddingVertical: 10,
                  backgroundColor: selected ? colors.secondaryContainer : "transparent",
                  borderLeftWidth: i === 1 ? 1 : 0,
                  borderLeftColor: colors.outline,
                }}
              >
                <Icon
                  name={selected ? "check" : tab === "collections" ? "collections" : "list"}
                  size={18}
                  color={selected ? colors.onSecondaryContainer : colors.onSurfaceVariant}
                />
                <Text
                  style={{
                    color: selected ? colors.onSecondaryContainer : colors.onSurfaceVariant,
                    fontSize: 14,
                    fontWeight: "500",
                    marginLeft: 8,
                  }}
                >
                  {tab === "collections" ? "Collections" : "Playlists"}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {/* Create new (for the active tab) */}
        <Pressable
          onPress={() => {
            setNewName("");
            setCreateError(null);
            setCreateOpen(true);
          }}
          android_ripple={{ color: withAlpha(colors.onPrimary, 0.2), borderless: true, radius: 22 }}
          accessibilityRole="button"
          accessibilityLabel={`Create new ${activeTab === "collections" ? "collection" : "playlist"}`}
          style={{
            marginLeft: 10,
            width: 42,
            height: 42,
            borderRadius: 21,
            backgroundColor: colors.primary,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name="add" size={24} color={colors.onPrimary} />
        </Pressable>
      </View>

      {/* Content */}
      {loading && data.length === 0 ? (
        <ListSkeleton rows={7} thumb={72} />
      ) : loadError && data.length === 0 ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 32 }}>
          <Icon name="warning" size={48} color={colors.error} />
          <Text style={{ color: colors.onSurface, fontSize: 17, fontWeight: "600", marginTop: 16, marginBottom: 6, textAlign: "center" }}>
            Couldn't load {activeTab}
          </Text>
          <Text style={{ color: colors.onSurfaceVariant, fontSize: 14, textAlign: "center" }}>
            Check your connection to the server and try again.
          </Text>
          <Pressable
            onPress={() => {
              setLoading(true);
              fetchData().finally(() => setLoading(false));
            }}
            android_ripple={{ color: withAlpha(colors.onPrimary, 0.2) }}
            accessibilityRole="button"
            accessibilityLabel={`Retry loading ${activeTab}`}
            style={{ marginTop: 20, paddingHorizontal: 24, paddingVertical: 10, borderRadius: 24, overflow: "hidden", backgroundColor: colors.primary }}
          >
            <Text style={{ color: colors.onPrimary, fontSize: 15, fontWeight: "600" }}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingTop: 6, paddingBottom: hasSession ? 100 : 32, flexGrow: 1 }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.primary}
              colors={[colors.primary]}
              progressBackgroundColor={colors.surfaceContainerHigh}
            />
          }
        >
          {data.length > 0 ? (
            data.map((item, index) => renderRow(item, index))
          ) : (
            <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 32 }}>
              <Icon
                name={activeTab === "collections" ? "collections" : "list"}
                size={48}
                color={colors.onSurfaceVariant}
              />
              <Text style={{ color: colors.onSurface, fontSize: 17, fontWeight: "600", marginTop: 16, marginBottom: 6, textAlign: "center" }}>
                No {activeTab} yet
              </Text>
              <Text style={{ color: colors.onSurfaceVariant, fontSize: 14, textAlign: "center" }}>
                {activeTab === "collections"
                  ? "Collections you create on the server will show up here."
                  : "Playlists you create will show up here."}
              </Text>
            </View>
          )}
        </ScrollView>
      )}
        </>
      )}

      {/* Create collection/playlist dialog */}
      <Modal
        visible={createOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setCreateOpen(false)}
      >
        <Pressable
          onPress={() => setCreateOpen(false)}
          style={{
            flex: 1,
            backgroundColor: "rgba(0,0,0,0.45)",
            alignItems: "center",
            justifyContent: "center",
            padding: 32,
          }}
        >
          <Pressable
            onPress={() => {}}
            style={{
              width: "100%",
              maxWidth: 420,
              backgroundColor: colors.surfaceContainerHigh,
              borderRadius: 24,
              padding: 20,
            }}
          >
            <Text style={{ color: colors.onSurface, fontSize: 19, fontWeight: "700" }}>
              New {activeTab === "collections" ? "collection" : "playlist"}
            </Text>
            <TextInput
              value={newName}
              onChangeText={setNewName}
              placeholder={activeTab === "collections" ? "Collection name" : "Playlist name"}
              placeholderTextColor={colors.onSurfaceVariant}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={handleCreate}
              style={{
                marginTop: 16,
                color: colors.onSurface,
                fontSize: 16,
                backgroundColor: colors.surfaceContainerHighest,
                borderRadius: 14,
                paddingHorizontal: 14,
                paddingVertical: 12,
              }}
            />
            {createError ? (
              <Text style={{ color: colors.error, fontSize: 13, marginTop: 10 }}>{createError}</Text>
            ) : null}
            <View style={{ flexDirection: "row", justifyContent: "flex-end", marginTop: 18 }}>
              <Pressable
                onPress={() => setCreateOpen(false)}
                android_ripple={{ color: colors.surfaceContainerHighest }}
                accessibilityRole="button"
                accessibilityLabel="Cancel"
                style={{ paddingHorizontal: 18, paddingVertical: 10, borderRadius: 20, overflow: "hidden" }}
              >
                <Text style={{ color: colors.onSurfaceVariant, fontSize: 15, fontWeight: "600" }}>
                  Cancel
                </Text>
              </Pressable>
              <Pressable
                onPress={handleCreate}
                disabled={!newName.trim() || creating}
                android_ripple={{ color: withAlpha(colors.onPrimary, 0.2) }}
                accessibilityRole="button"
                accessibilityLabel="Create"
                style={{
                  marginLeft: 8,
                  paddingHorizontal: 22,
                  paddingVertical: 10,
                  borderRadius: 20,
                  overflow: "hidden",
                  backgroundColor: newName.trim() ? colors.primary : colors.surfaceContainerHighest,
                }}
              >
                {creating ? (
                  <ActivityIndicator size="small" color={colors.onPrimary} />
                ) : (
                  <Text
                    style={{
                      color: newName.trim() ? colors.onPrimary : colors.onSurfaceVariant,
                      fontSize: 15,
                      fontWeight: "700",
                    }}
                  >
                    Create
                  </Text>
                )}
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

// Rounded square cover: single fills the square, otherwise a 2x2 collage over
// a primary background (mirrors CollectionCover/PlaylistCover.vue).
function CollageCover({
  covers,
  size,
  colors,
}: {
  covers: (string | null)[];
  size: number;
  colors: any;
}) {
  const valid = covers.filter(Boolean) as string[];
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: 14,
        overflow: "hidden",
        backgroundColor: colors.primary,
      }}
    >
      {valid.length === 0 ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <Icon name="book" size={26} color={colors.onPrimary} />
        </View>
      ) : valid.length === 1 ? (
        <Image source={{ uri: valid[0] }} style={{ width: size, height: size }} contentFit="cover" />
      ) : (
        <View style={{ flexDirection: "row", flexWrap: "wrap", width: size, height: size }}>
          {valid.slice(0, 4).map((uri, idx) => (
            <Image
              key={idx}
              source={{ uri }}
              style={{ width: size / 2, height: valid.length <= 2 ? size : size / 2 }}
              contentFit="cover"
            />
          ))}
        </View>
      )}
    </View>
  );
}
