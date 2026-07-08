import React, { useEffect, useState, useCallback, useRef, forwardRef, useImperativeHandle } from "react";
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
import { coverSource } from "../utils/coverSource";
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
import EmptyState from "../components/EmptyState";
import ErrorState from "../components/ErrorState";
import { ListSkeleton } from "../components/Skeleton";
import { useUiStore } from "../store/useUiStore";
import SearchContent from "../components/SearchContent";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type Tab = "collections" | "playlists";

const ROW_COVER = 72;

/**
 * Imperative handle the Library-hub uses to scroll this facet to the top and to
 * open the create-new dialog from the hub's shared FAB (the hub owns the FAB so
 * it can position it above the mini-player on the collections/playlists
 * segments).
 */
export interface CollectionsPlaylistsScreenHandle {
  scrollToTop: () => void;
  openCreate: () => void;
}

// In the Library hub this screen is mounted twice — once per segment — with a
// locked `mode` ("collections" | "playlists") that seeds+pins its active tab.
// Standalone (non-embedded) it renders its own Collections/Playlists sub-tab
// row + inline create button and manages its own active tab.
function CollectionsPlaylistsScreen(
  { navigation, embedded, mode, listHeader, onScroll }: any,
  ref: React.Ref<CollectionsPlaylistsScreenHandle>
) {
  const colors = useThemeColors();
  const isSearchActive = useUiStore((s) => s.isSearchActive);
  const { currentLibraryId } = useLibraryStore();
  const { serverConnectionConfig } = useUserStore();
  const [internalTab, setInternalTab] = useState<Tab>("collections");
  // A hub-supplied `mode` pins the tab; standalone uses the internal toggle.
  const activeTab: Tab = (mode as Tab) ?? internalTab;
  const scrollRef = useRef<ScrollView>(null);
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

  const openCreate = useCallback(() => {
    setNewName("");
    setCreateError(null);
    setCreateOpen(true);
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      scrollToTop: () => scrollRef.current?.scrollTo({ y: 0, animated: true }),
      openCreate,
    }),
    [openCreate]
  );

  const serverAddress = serverConnectionConfig?.address?.replace(/\/$/, "") || "";
  const token = serverConnectionConfig?.token || "";

  const getCoverUrl = (itemId: string) => {
    if (!itemId || !serverAddress || !token) return null;
    return `${serverAddress}/api/items/${itemId}/cover?width=400&format=webp&token=${token}`;
  };

  const fetchData = useCallback(async () => {
    try {
      setLoadError(false);
      // Only ever install an ARRAY: a proxy/captive-portal HTML-or-object body
      // with HTTP 200 would otherwise land in state and crash the row map.
      const asArray = (v: any): any[] | null => (Array.isArray(v) ? v : null);
      if (activeTab === "collections" && currentLibraryId) {
        const res = await api.get(`/api/libraries/${currentLibraryId}/collections`);
        const list = asArray(res.data?.results) ?? asArray(res.data?.collections) ?? asArray(res.data);
        if (!list) {
          setLoadError(true);
          return;
        }
        setCollections(list);
      } else if (activeTab === "playlists" && currentLibraryId) {
        // Library-scoped (matches the collections tab and the Add-to sheet) —
        // the global /api/playlists mixes in other libraries' playlists.
        const res = await api.get(`/api/libraries/${currentLibraryId}/playlists`);
        const list = asArray(res.data?.results) ?? asArray(res.data?.playlists) ?? asArray(res.data);
        if (!list) {
          setLoadError(true);
          return;
        }
        setPlaylists(list);
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
      // Only string bodies — a JSON error body stringifies to "[object Object]".
      const body = e?.response?.data;
      setCreateError(
        typeof body === "string" && body.trim()
          ? body
          : "Couldn't create it — check the server connection."
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

  // Collections | Playlists sub-tab row + inline create button. Rendered ONLY
  // when standalone (!embedded) — inside the hub the segment lives in the top
  // pill row and creating is driven by the hub's shared FAB via openCreate().
  const subTabRow = (
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
        accessibilityRole="tablist"
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
              onPress={() => setInternalTab(tab)}
              android_ripple={{ color: colors.surfaceContainerHighest }}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              // Pills are ~38dp tall (under the 48dp min touch target); extend
              // the vertical hit area so they're comfortably tappable.
              hitSlop={{ top: 6, bottom: 6 }}
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
        onPress={openCreate}
        // 42dp button — pad the hit area up to a comfortable touch target.
        hitSlop={6}
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
  );

  // When embedded, the hub's pill row is passed down as listHeader and rendered
  // as the first child of the scroll body (so it collapses away with content);
  // for the non-scrolling skeleton/error states it sits statically on top.
  // Treat a not-yet-hydrated library id as a loading state: fetchData no-ops
  // without one, so falling through to EmptyState would flash "No collections
  // yet" for a frame on cold start before currentLibraryId hydrates.
  const content =
    (loading || !currentLibraryId) && data.length === 0 ? (
      <>
        {embedded ? listHeader : null}
        <ListSkeleton rows={7} thumb={72} />
      </>
    ) : loadError && data.length === 0 ? (
      <>
        {embedded ? listHeader : null}
        <ErrorState
          style={{ flex: 1 }}
          title={`Couldn't load ${activeTab}`}
          message="Check your connection to the server and try again."
          onRetry={() => {
            setLoading(true);
            fetchData().finally(() => setLoading(false));
          }}
        />
      </>
    ) : (
      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        onScroll={(e) => onScroll?.(e.nativeEvent.contentOffset.y)}
        scrollEventThrottle={16}
        contentContainerStyle={{ paddingTop: 4, paddingBottom: hasSession ? 100 : 32, flexGrow: 1 }}
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
        {embedded ? listHeader : null}
        {data.length > 0 ? (
          data.map((item, index) => renderRow(item, index))
        ) : (
          <EmptyState
            style={{ flex: 1 }}
            icon={activeTab === "collections" ? "collections" : "list"}
            title={`No ${activeTab} yet`}
            message={
              activeTab === "collections"
                ? "Tap + to create your first collection, or they'll appear here once created on the server."
                : "Playlists you create will show up here."
            }
          />
        )}
      </ScrollView>
    );

  const body =
    isSearchActive && !embedded ? (
      <SearchContent navigation={navigation} />
    ) : (
      <>
        {!embedded ? subTabRow : null}
        {content}
      </>
    );

  // Create collection/playlist dialog — always mounted (Modal is a portal).
  const createModal = (
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
            backgroundColor: "rgba(0,0,0,0.5)",
            alignItems: "center",
            justifyContent: "center",
            padding: 32,
          }}
        >
          <Pressable
            onPress={() => {}}
            accessibilityViewIsModal
            style={{
              width: "100%",
              maxWidth: 360,
              backgroundColor: colors.surfaceContainerHigh,
              borderRadius: 28,
              padding: 24,
            }}
          >
            <Text
              accessibilityRole="header"
              style={{ color: colors.onSurface, fontSize: 19, fontWeight: "700" }}
            >
              New {activeTab === "collections" ? "collection" : "playlist"}
            </Text>
            <TextInput
              value={newName}
              onChangeText={setNewName}
              placeholder={activeTab === "collections" ? "Collection name" : "Playlist name"}
              accessibilityLabel={activeTab === "collections" ? "Collection name" : "Playlist name"}
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
  );

  if (embedded) {
    return (
      <View style={{ flex: 1 }}>
        {body}
        {createModal}
      </View>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }} edges={["top", "left", "right"]}>
      <TopAppBar navigation={navigation} />
      {body}
      {createModal}
    </SafeAreaView>
  );
}

export default forwardRef(CollectionsPlaylistsScreen);

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
        <Image source={coverSource(valid[0])} style={{ width: size, height: size }} contentFit="cover" />
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
