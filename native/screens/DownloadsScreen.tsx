import React, { useEffect, useState } from "react";
import { View, Text, Pressable, FlatList, Alert } from "react-native";
import { Image } from "expo-image";
import { SafeAreaView } from "react-native-safe-area-context";
import { useThemeColors } from "../theme/useThemeColors";
import Icon from "../components/Icon";
import { useDownloadStore } from "../store/useDownloadStore";
import { usePlaybackStore } from "../store/usePlaybackStore";
import { formatBytes } from "../utils/format";

export default function DownloadsScreen({ navigation }: any) {
  const colors = useThemeColors();
  const { activeDownloads, completedDownloads, loadDownloadsFromDb, cancelDownload, retryDownload, removeDownload } = useDownloadStore();
  const startPlayback = usePlaybackStore((state) => state.startPlayback);
  const [activeTab, setActiveTab] = useState<"completed" | "active">("completed");

  useEffect(() => {
    loadDownloadsFromDb();
  }, [loadDownloadsFromDb]);

  const activeList = Object.values(activeDownloads);
  const completedList = Object.values(completedDownloads);

  const itemBytes = (item: any) =>
    (item?.parts || []).reduce((acc: number, p: any) => acc + (p.fileSize || 0), 0);

  const handlePlayOffline = async (item: any) => {
    // The playback store already prefers locally-downloaded files when
    // available, so just start a normal playback session for this item.
    await startPlayback(item.libraryItemId || item.id);
  };

  const Cover = ({ uri }: { uri?: string }) => (
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
  );

  const EmptyState = ({ icon, label }: { icon: any; label: string }) => (
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
        <Icon name={icon} size={36} color={colors.onSecondaryContainer} />
      </View>
      <Text style={{ color: colors.onSurfaceVariant, fontSize: 15, textAlign: "center" }}>{label}</Text>
    </View>
  );

  const Tab = ({ tab, label }: { tab: "completed" | "active"; label: string }) => {
    const selected = activeTab === tab;
    return (
      <Pressable
        onPress={() => setActiveTab(tab)}
        style={{ flex: 1, paddingVertical: 14, alignItems: "center", justifyContent: "center" }}
      >
        <Text style={{ color: selected ? colors.primary : colors.onSurfaceVariant, fontSize: 15, fontWeight: "700" }}>
          {label}
        </Text>
        {selected ? (
          <View
            style={{
              position: "absolute",
              bottom: 0,
              height: 3,
              width: "70%",
              backgroundColor: colors.primary,
              borderTopLeftRadius: 3,
              borderTopRightRadius: 3,
            }}
          />
        ) : null}
      </Pressable>
    );
  };

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
        >
          <Icon name="back" size={24} color={colors.onSurface} />
        </Pressable>
        <Text style={{ color: colors.onSurface, fontSize: 20, fontWeight: "700", marginLeft: 4 }}>Downloads</Text>
      </View>

      {/* Tabs */}
      <View
        style={{
          flexDirection: "row",
          borderBottomWidth: 1,
          borderBottomColor: colors.outlineVariant,
        }}
      >
        <Tab tab="completed" label={`Downloaded (${completedList.length})`} />
        <Tab tab="active" label={`Downloading (${activeList.length})`} />
      </View>

      {/* Content */}
      {activeTab === "completed" ? (
        <FlatList
          data={completedList}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ padding: 16 }}
          ListEmptyComponent={<EmptyState icon="download" label="No downloaded audiobooks found." />}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => handlePlayOffline(item)}
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
              <Cover uri={item.coverUrl} />
              <View style={{ flex: 1, paddingHorizontal: 12 }}>
                <Text numberOfLines={1} style={{ color: colors.onSurface, fontSize: 15, fontWeight: "600" }}>
                  {item.title}
                </Text>
                <Text numberOfLines={1} style={{ color: colors.onSurfaceVariant, fontSize: 13, marginTop: 2 }}>
                  {item.author}
                </Text>
                <Text numberOfLines={1} style={{ color: colors.onSurfaceVariant, fontSize: 12, marginTop: 2 }}>
                  {formatBytes(itemBytes(item))}
                </Text>
              </View>
              <Pressable
                onPress={() => handlePlayOffline(item)}
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 22,
                  backgroundColor: colors.primary,
                  alignItems: "center",
                  justifyContent: "center",
                  marginRight: 4,
                }}
                hitSlop={6}
              >
                <Icon name="play" size={24} color={colors.onPrimary} />
              </Pressable>
              <Pressable
                onPress={() =>
                  // cancelDownload only touches ACTIVE downloads — a completed
                  // one must go through removeDownload (deletes the files too).
                  // Destructive, so confirm first.
                  Alert.alert(
                    "Delete download",
                    `Remove "${item.title}" from this device? You can download it again later.`,
                    [
                      { text: "Cancel", style: "cancel" },
                      { text: "Delete", style: "destructive", onPress: () => removeDownload(item.id) },
                    ]
                  )
                }
                style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" }}
                hitSlop={6}
              >
                <Icon name="trash" size={22} color={colors.onSurfaceVariant} />
              </Pressable>
            </Pressable>
          )}
        />
      ) : (
        <FlatList
          data={activeList}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ padding: 16 }}
          ListEmptyComponent={<EmptyState icon="cloud" label="No active downloads in progress." />}
          renderItem={({ item }) => (
            <View
              style={{
                padding: 12,
                backgroundColor: colors.surfaceContainer,
                borderRadius: 16,
                marginBottom: 12,
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <Cover uri={item.coverUrl} />
                <View style={{ flex: 1, paddingHorizontal: 12 }}>
                  <Text numberOfLines={1} style={{ color: colors.onSurface, fontSize: 15, fontWeight: "600" }}>
                    {item.title}
                  </Text>
                  <Text numberOfLines={1} style={{ color: colors.onSurfaceVariant, fontSize: 13, marginTop: 2 }}>
                    {item.author}
                  </Text>
                  <Text
                    style={{
                      color: item.status === "failed" ? colors.error : colors.primary,
                      fontSize: 12,
                      marginTop: 2,
                    }}
                  >
                    {item.status.charAt(0).toUpperCase() + item.status.slice(1)}
                  </Text>
                </View>
                {item.status === "failed" ? (
                  <Pressable
                    onPress={() => retryDownload(item.id)}
                    style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" }}
                    hitSlop={6}
                  >
                    <Icon name="refresh" size={22} color={colors.primary} />
                  </Pressable>
                ) : null}
                <Pressable
                  onPress={() => cancelDownload(item.id)}
                  style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" }}
                  hitSlop={6}
                >
                  <Icon name="close" size={22} color={colors.onSurfaceVariant} />
                </Pressable>
              </View>

              {/* Progress bar */}
              <View
                style={{
                  height: 6,
                  backgroundColor: colors.surfaceContainerHighest,
                  borderRadius: 3,
                  overflow: "hidden",
                  marginTop: 12,
                }}
              >
                <View
                  style={{
                    height: "100%",
                    backgroundColor: colors.primary,
                    borderRadius: 3,
                    width: `${Math.round(item.progress * 100)}%`,
                  }}
                />
              </View>
              <Text style={{ color: colors.onSurfaceVariant, fontSize: 12, textAlign: "right", marginTop: 4 }}>
                {Math.round(item.progress * 100)}%
              </Text>
            </View>
          )}
        />
      )}
    </SafeAreaView>
  );
}
