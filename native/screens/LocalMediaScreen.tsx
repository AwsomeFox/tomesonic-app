import React from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  Alert,
  Linking,
  Image,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useThemeColors } from "../theme/useThemeColors";
import { withAlpha } from "../theme/palette";
import Icon from "../components/Icon";
import { useDownloadStore } from "../store/useDownloadStore";
import { usePlaybackStore } from "../store/usePlaybackStore";
import { haptic } from "../utils/haptics";

const GUIDE_URL =
  "https://www.audiobookshelf.org/guides/android_app_shared_storage";

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 MB";
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

function itemBytes(item: any): number {
  return (item?.parts || []).reduce(
    (acc: number, p: any) => acc + (p.fileSize || 0),
    0
  );
}

/**
 * Local Media — the app's offline library. Lists books downloaded to internal
 * app storage with total usage, and lets you play or delete each one.
 */
export default function LocalMediaScreen({ navigation }: any) {
  const colors = useThemeColors();
  const completedDownloads = useDownloadStore((s) => s.completedDownloads);
  const removeDownload = useDownloadStore((s) => s.removeDownload);
  const startPlayback = usePlaybackStore((s) => s.startPlayback);

  const items = Object.values(completedDownloads);
  const totalBytes = items.reduce((acc, it) => acc + itemBytes(it), 0);

  const [busyId, setBusyId] = React.useState<string | null>(null);

  const showInfo = () => {
    Alert.alert(
      "Local Media",
      "Books you download are stored in the app's internal storage and play offline. Delete a book here to free up space.",
      [
        { text: "View More", onPress: () => Linking.openURL(GUIDE_URL) },
        { text: "OK", style: "cancel" },
      ]
    );
  };

  const play = async (item: any) => {
    if (busyId) return;
    haptic();
    setBusyId(item.id);
    try {
      const ok = await startPlayback(item.libraryItemId || item.id);
      if (ok) navigation.navigate("Player");
    } finally {
      setBusyId(null);
    }
  };

  const confirmDelete = (item: any) => {
    Alert.alert(
      "Delete download",
      `Remove "${item.title}" from this device? The book stays in your library.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            haptic();
            removeDownload(item.id);
          },
        },
      ]
    );
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }}>
      {/* Header */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingTop: 8,
          paddingBottom: 8,
          paddingHorizontal: 16,
        }}
      >
        <Pressable
          onPress={() => navigation.goBack()}
          hitSlop={8}
          style={{ paddingRight: 16, paddingVertical: 4 }}
        >
          <Icon name="back" size={26} color={colors.onSurface} />
        </Pressable>
        <Text style={{ color: colors.onSurface, fontSize: 22, fontWeight: "600", flex: 1 }}>
          Local Media
        </Text>
        <Pressable
          onPress={showInfo}
          hitSlop={8}
          style={{
            width: 34,
            height: 34,
            borderRadius: 17,
            backgroundColor: colors.secondaryContainer,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name="info" size={18} color={colors.onSurface} />
        </Pressable>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 32 }}
      >
        {/* Internal App Storage summary card */}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            paddingHorizontal: 18,
            paddingVertical: 18,
            borderWidth: 1,
            borderColor: colors.outlineVariant,
            borderRadius: 20,
            marginBottom: 20,
          }}
        >
          <Icon name="folder" size={24} color="#FBC02D" />
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={{ color: colors.onSurface, fontSize: 17 }}>Internal App Storage</Text>
            <Text style={{ color: colors.onSurfaceVariant, fontSize: 13, marginTop: 2 }}>
              {items.length} {items.length === 1 ? "book" : "books"} · {formatBytes(totalBytes)} used
            </Text>
          </View>
        </View>

        {items.length === 0 ? (
          <View style={{ alignItems: "center", paddingTop: 60, paddingHorizontal: 24 }}>
            <Icon name="download" size={48} color={colors.onSurfaceVariant} />
            <Text
              style={{
                color: colors.onSurface,
                fontSize: 17,
                fontWeight: "600",
                marginTop: 16,
                textAlign: "center",
              }}
            >
              No downloaded books
            </Text>
            <Text
              style={{
                color: colors.onSurfaceVariant,
                fontSize: 14,
                marginTop: 6,
                textAlign: "center",
              }}
            >
              Download a book from its details page to listen offline. It'll show up here.
            </Text>
          </View>
        ) : (
          items.map((item: any) => (
            <View
              key={item.id}
              style={{ flexDirection: "row", alignItems: "center", paddingVertical: 10 }}
            >
              {/* Cover */}
              <View
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: 8,
                  overflow: "hidden",
                  backgroundColor: colors.surfaceContainerHighest,
                }}
              >
                {item.coverUrl ? (
                  <Image source={{ uri: item.coverUrl }} style={{ width: 56, height: 56 }} />
                ) : (
                  <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
                    <Icon name="book" size={24} color={colors.onSurfaceVariant} />
                  </View>
                )}
              </View>

              {/* Title / author / size */}
              <View style={{ flex: 1, marginLeft: 12, marginRight: 8 }}>
                <Text numberOfLines={1} style={{ color: colors.onSurface, fontSize: 15, fontWeight: "600" }}>
                  {item.title}
                </Text>
                {item.author ? (
                  <Text numberOfLines={1} style={{ color: colors.onSurfaceVariant, fontSize: 13, marginTop: 1 }}>
                    {item.author}
                  </Text>
                ) : null}
                <Text style={{ color: colors.onSurfaceVariant, fontSize: 12, marginTop: 2 }}>
                  {formatBytes(itemBytes(item))}
                </Text>
              </View>

              {/* Play */}
              <Pressable
                onPress={() => play(item)}
                hitSlop={6}
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 22,
                  backgroundColor: colors.primary,
                  alignItems: "center",
                  justifyContent: "center",
                  marginRight: 6,
                }}
              >
                {busyId === item.id ? (
                  <ActivityIndicator size="small" color={colors.onPrimary} />
                ) : (
                  <Icon name="play" size={22} color={colors.onPrimary} />
                )}
              </Pressable>

              {/* Delete */}
              <Pressable
                onPress={() => confirmDelete(item)}
                hitSlop={6}
                android_ripple={{ color: withAlpha(colors.error, 0.12), borderless: true }}
                style={{ width: 40, height: 44, alignItems: "center", justifyContent: "center" }}
              >
                <Icon name="trash" size={22} color={colors.error} />
              </Pressable>
            </View>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
