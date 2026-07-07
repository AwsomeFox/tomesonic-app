import React, { useEffect, useState } from "react";
import { View, Text, Pressable, FlatList, Alert } from "react-native";
import { Image } from "expo-image";
import { SafeAreaView } from "react-native-safe-area-context";
import { useThemeColors } from "../theme/useThemeColors";
import { withAlpha } from "../theme/palette";
import Icon from "../components/Icon";
import { useDownloadStore } from "../store/useDownloadStore";
import { usePlaybackStore } from "../store/usePlaybackStore";
import { formatBytes } from "../utils/format";
import * as FileSystem from "expo-file-system/legacy";

export default function DownloadsScreen({ navigation }: any) {
  const colors = useThemeColors();
  const { activeDownloads, completedDownloads, loadDownloadsFromDb, cancelDownload, retryDownload, removeDownload, removeAllDownloads } = useDownloadStore();
  const startPlayback = usePlaybackStore((state) => state.startPlayback);
  const [activeTab, setActiveTab] = useState<"completed" | "active">("completed");
  // Device free space, so "X used" has context — users can see whether there's
  // room to download more without leaving the app for system settings.
  const [freeBytes, setFreeBytes] = useState<number | null>(null);

  useEffect(() => {
    loadDownloadsFromDb();
  }, [loadDownloadsFromDb]);

  useEffect(() => {
    let alive = true;
    FileSystem.getFreeDiskStorageAsync()
      .then((b) => alive && typeof b === "number" && setFreeBytes(b))
      .catch(() => {});
    return () => {
      alive = false;
    };
    // Re-read after the set of downloads changes (a delete frees space).
  }, [Object.keys(completedDownloads).length, Object.keys(activeDownloads).length]);

  // Alphabetical so the list doesn't reorder by whatever the DB load order was.
  const byTitle = (a: any, b: any) => String(a.title || "").localeCompare(String(b.title || ""));
  const activeList = Object.values(activeDownloads);
  const downloadingCount = activeList.filter((d: any) => d.status !== "failed").length;
  const failedCount = activeList.length - downloadingCount;
  const completedList = Object.values(completedDownloads).sort(byTitle);

  // fileSize can be 0 for parts whose size the server never reported (e.g. the
  // cover) — fall back to the bytes actually written so sizes aren't understated.
  const itemBytes = (item: any) =>
    (item?.parts || []).reduce(
      (acc: number, p: any) => acc + Math.max(p.fileSize || 0, p.bytesDownloaded || 0),
      0
    );

  const ebookPartOf = (item: any) => (item?.parts || []).find((p: any) => p.id === "ebook");
  // Ebook without any audio tracks — "playing" it means opening the reader.
  const isEbookOnly = (item: any) => !item?.meta?.tracks?.length && !!ebookPartOf(item);

  // Prefer the downloaded cover file — item.coverUrl is the REMOTE server URL,
  // which renders blank exactly when downloads matter most (offline).
  const coverOf = (item: any) =>
    (item?.parts || []).find((p: any) => p.id === "cover")?.localFilePath || item?.coverUrl;

  const handlePlayOffline = async (item: any) => {
    if (isEbookOnly(item)) {
      // No audio to play — open the downloaded ebook in the reader instead
      // (ReaderScreen prefers the offline file for downloaded items).
      const filename: string = ebookPartOf(item)?.filename || "book.epub";
      navigation.navigate("Reader", {
        itemId: item.libraryItemId || item.id,
        ebookFormat: filename.split(".").pop() || "epub",
        title: item.title,
      });
      return;
    }
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

  const EmptyState = ({ icon, title, label }: { icon: any; title: string; label: string }) => (
    <View style={{ alignItems: "center", justifyContent: "center", paddingVertical: 80, paddingHorizontal: 32 }}>
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
      <Text style={{ color: colors.onSurface, fontSize: 18, fontWeight: "600" }}>{title}</Text>
      <Text style={{ color: colors.onSurfaceVariant, fontSize: 15, textAlign: "center", marginTop: 8 }}>
        {label}
      </Text>
    </View>
  );

  const Tab = ({ tab, label }: { tab: "completed" | "active"; label: string }) => {
    const selected = activeTab === tab;
    return (
      <Pressable
        onPress={() => setActiveTab(tab)}
        accessibilityRole="tab"
        accessibilityState={{ selected }}
        android_ripple={{ color: withAlpha(colors.primary, 0.12) }}
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
          accessibilityRole="button"
          accessibilityLabel="Go back"
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
        <Tab
          tab="active"
          label={
            failedCount > 0
              ? `Downloading (${downloadingCount}) · Failed (${failedCount})`
              : `Downloading (${downloadingCount})`
          }
        />
      </View>

      {/* Content */}
      {activeTab === "completed" ? (
        <FlatList
          data={completedList}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ padding: 16 }}
          // Storage summary (absorbed from the old Local Media screen — the
          // two screens were duplicates and were merged).
          ListHeaderComponent={
            completedList.length > 0 ? (
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  paddingHorizontal: 18,
                  paddingVertical: 16,
                  borderWidth: 1,
                  borderColor: colors.outlineVariant,
                  borderRadius: 20,
                  marginBottom: 16,
                }}
              >
                <Icon name="folder" size={24} color={colors.tertiary} />
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={{ color: colors.onSurface, fontSize: 16, fontWeight: "600" }}>
                    Internal App Storage
                  </Text>
                  <Text style={{ color: colors.onSurfaceVariant, fontSize: 13, marginTop: 2 }}>
                    {completedList.length} {completedList.length === 1 ? "item" : "items"} ·{" "}
                    {formatBytes(completedList.reduce((acc, it) => acc + itemBytes(it), 0))} used
                    {freeBytes != null ? ` · ${formatBytes(freeBytes)} free` : ""}
                  </Text>
                </View>
                <Pressable
                  onPress={() =>
                    Alert.alert(
                      "Delete all downloads",
                      // Honest scope: the wipe also aborts anything still
                      // downloading (and clears failed retries), not just the
                      // completed items counted in the header.
                      `Remove all ${completedList.length} downloaded ${
                        completedList.length === 1 ? "item" : "items"
                      }${
                        activeList.length > 0
                          ? ` and cancel ${activeList.length} in-progress/failed ${
                              activeList.length === 1 ? "download" : "downloads"
                            }`
                          : ""
                      } from this device? Your listening/reading progress is kept.`,
                      [
                        { text: "Cancel", style: "cancel" },
                        {
                          text: "Delete all",
                          style: "destructive",
                          onPress: () => removeAllDownloads(),
                        },
                      ]
                    )
                  }
                  accessibilityRole="button"
                  accessibilityLabel="Delete all downloads"
                  hitSlop={8}
                  style={{ padding: 8 }}
                >
                  <Icon name="trash" size={20} color={colors.error} />
                </Pressable>
              </View>
            ) : null
          }
          ListEmptyComponent={
            <EmptyState
              icon="download"
              title="No downloads yet"
              label="Downloaded books play offline. Download one from its details page."
            />
          }
          renderItem={({ item }) => (
            <Pressable
              onPress={() => handlePlayOffline(item)}
              accessibilityRole="button"
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
              <Cover uri={coverOf(item)} />
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
                accessibilityRole="button"
                accessibilityLabel={isEbookOnly(item) ? `Read ${item.title}` : `Play ${item.title}`}
              >
                <Icon name={isEbookOnly(item) ? "book" : "play"} size={24} color={colors.onPrimary} />
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
                accessibilityRole="button"
                accessibilityLabel={`Delete download of ${item.title}`}
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
          ListEmptyComponent={
            <EmptyState
              icon="cloud"
              title="Nothing downloading"
              label="Active and failed downloads show up here while they run."
            />
          }
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
                <Cover uri={coverOf(item)} />
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
                    {String(item.status || "failed").charAt(0).toUpperCase() + String(item.status || "failed").slice(1)}
                  </Text>
                  {item.status === "failed" && item.error ? (
                    // Why it failed (storage full, auth expired, network…) so
                    // the user knows whether retrying can help.
                    <Text
                      numberOfLines={2}
                      style={{ color: colors.onSurfaceVariant, fontSize: 11, marginTop: 2 }}
                    >
                      {item.error}
                    </Text>
                  ) : null}
                </View>
                {item.status === "failed" ? (
                  <Pressable
                    onPress={() => retryDownload(item.id)}
                    style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" }}
                    hitSlop={6}
                    accessibilityRole="button"
                    accessibilityLabel={`Retry download of ${item.title}`}
                  >
                    <Icon name="refresh" size={22} color={colors.primary} />
                  </Pressable>
                ) : null}
                <Pressable
                  onPress={() => {
                    // Cancel is a full DISCARD (record + partial files deleted)
                    // and the X sits beside Retry on failed rows — confirm for
                    // live downloads so a mistap can't throw away gigabytes.
                    // Failed rows stay one-tap (nothing in flight to lose).
                    if (item.status === "downloading" || item.status === "pending") {
                      Alert.alert(
                        "Cancel download?",
                        `"${item.title}" will stop downloading and its partial files will be deleted.`,
                        [
                          { text: "Keep downloading", style: "cancel" },
                          { text: "Cancel download", style: "destructive", onPress: () => cancelDownload(item.id) },
                        ]
                      );
                    } else {
                      cancelDownload(item.id);
                    }
                  }}
                  style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" }}
                  hitSlop={6}
                  accessibilityRole="button"
                  accessibilityLabel={`Cancel download of ${item.title}`}
                >
                  <Icon name="close" size={22} color={colors.onSurfaceVariant} />
                </Pressable>
              </View>

              {/* Progress bar — one accessible progressbar element; a bare
                  "42%" Text announced with no context. */}
              <View
                accessible
                accessibilityRole="progressbar"
                accessibilityLabel={`${item.title} download progress`}
                accessibilityValue={{
                  min: 0,
                  max: 100,
                  now: Number.isFinite(item.progress) ? Math.round(item.progress * 100) : 0,
                  text: `${Number.isFinite(item.progress) ? Math.round(item.progress * 100) : 0} percent downloaded`,
                }}
              >
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
                      width: `${Number.isFinite(item.progress) ? Math.round(item.progress * 100) : 0}%`,
                    }}
                  />
                </View>
                <Text style={{ color: colors.onSurfaceVariant, fontSize: 12, textAlign: "right", marginTop: 4 }}>
                  {Number.isFinite(item.progress) ? Math.round(item.progress * 100) : 0}%
                </Text>
              </View>
            </View>
          )}
        />
      )}
    </SafeAreaView>
  );
}
