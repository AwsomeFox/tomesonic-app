import React, { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  Image,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Animated, { FadeInUp } from "react-native-reanimated";
import { api } from "../utils/api";
import { useLibraryStore } from "../store/useLibraryStore";
import { useUserStore } from "../store/useUserStore";
import { useThemeColors } from "../theme/useThemeColors";
import TopAppBar from "../components/TopAppBar";
import Icon from "../components/Icon";
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

  const serverAddress = serverConnectionConfig?.address?.replace(/\/$/, "") || "";
  const token = serverConnectionConfig?.token || "";

  const getCoverUrl = (itemId: string) => {
    if (!itemId || !serverAddress || !token) return null;
    return `${serverAddress}/api/items/${itemId}/cover?token=${token}`;
  };

  const fetchData = useCallback(async () => {
    try {
      if (activeTab === "collections" && currentLibraryId) {
        const res = await api.get(`/api/libraries/${currentLibraryId}/collections`);
        setCollections(res.data?.results || res.data?.collections || res.data || []);
      } else if (activeTab === "playlists") {
        const res = await api.get("/api/playlists");
        setPlaylists(res.data?.results || res.data?.playlists || res.data || []);
      }
    } catch (err) {
      console.error(`[CollectionsPlaylists] Failed to load ${activeTab}:`, err);
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

  const onRefresh = async () => {
    setRefreshing(true);
    await fetchData();
    setRefreshing(false);
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
        entering={FadeInUp.delay(index * 50).springify().damping(32).stiffness(150)}
        onPress={() =>
          navigation.navigate(isCollection ? "CollectionDetail" : "PlaylistDetail", {
            collectionId: item.id,
            playlistId: item.id,
          })
        }
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
          {/* Segmented toggle: Collections | Playlists */}
          <View style={{ paddingHorizontal: 16, paddingTop: 10, paddingBottom: 6 }}>
        <View
          style={{
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
      </View>

      {/* Content */}
      {loading && data.length === 0 ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingTop: 6, paddingBottom: 32 }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
          }
        >
          {data.length > 0 ? (
            data.map((item, index) => renderRow(item, index))
          ) : (
            <View style={{ alignItems: "center", justifyContent: "center", paddingTop: 80 }}>
              <Icon
                name={activeTab === "collections" ? "collections" : "list"}
                size={48}
                color={colors.onSurfaceVariant}
                style={{ marginBottom: 8 }}
              />
              <Text style={{ color: colors.onSurfaceVariant, fontSize: 16, textAlign: "center" }}>
                No {activeTab} found.
              </Text>
            </View>
          )}
        </ScrollView>
      )}
        </>
      )}
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
        <Image source={{ uri: valid[0] }} style={{ width: size, height: size }} resizeMode="cover" />
      ) : (
        <View style={{ flexDirection: "row", flexWrap: "wrap", width: size, height: size }}>
          {valid.slice(0, 4).map((uri, idx) => (
            <Image
              key={idx}
              source={{ uri }}
              style={{ width: size / 2, height: valid.length <= 2 ? size : size / 2 }}
              resizeMode="cover"
            />
          ))}
        </View>
      )}
    </View>
  );
}
