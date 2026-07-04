import React, { useCallback, useEffect, useState } from "react";
import { View, Text, Pressable, Modal, ScrollView, ActivityIndicator } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useThemeColors } from "../theme/useThemeColors";
import Icon from "./Icon";
import { api } from "../utils/api";

interface Bookmark {
  libraryItemId?: string;
  title: string;
  time: number;
}

interface Props {
  visible: boolean;
  onClose: () => void;
  libraryItemId?: string;
  /** Current playback position in whole-book seconds. */
  currentTime: number;
  /** Seek callback (whole-book seconds). */
  onSeek: (time: number) => void;
}

function fmt(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

/**
 * Bookmarks bottom sheet. Mirrors the original BookmarksModal.vue: lists the
 * item's bookmarks (title + timestamp, tap to seek) and adds one at the current
 * time. Bookmarks are read/written via the ABS `/api/me/item/{id}/bookmark`
 * endpoints; if the server is unreachable it falls back to local state.
 */
export default function BookmarksModal({ visible, onClose, libraryItemId, currentTime, onSeek }: Props) {
  const colors = useThemeColors();
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [loading, setLoading] = useState(false);

  const loadBookmarks = useCallback(async () => {
    if (!libraryItemId) return;
    setLoading(true);
    try {
      const res = await api.get("/api/me");
      const all: Bookmark[] = res.data?.bookmarks || [];
      setBookmarks(all.filter((b) => b.libraryItemId === libraryItemId).sort((a, b) => a.time - b.time));
    } catch (e) {
      // Offline / local item: keep whatever local bookmarks we already have.
    } finally {
      setLoading(false);
    }
  }, [libraryItemId]);

  useEffect(() => {
    if (visible) loadBookmarks();
  }, [visible, loadBookmarks]);

  const alreadyBookmarked = bookmarks.some((b) => Math.floor(b.time) === Math.floor(currentTime));

  const addBookmark = async () => {
    const time = Math.floor(currentTime);
    const title = new Date().toLocaleString();
    const local: Bookmark = { libraryItemId, title, time };
    // Optimistic local insert (also the fallback when offline).
    setBookmarks((prev) => [...prev, local].sort((a, b) => a.time - b.time));
    if (!libraryItemId) return;
    try {
      await api.post(`/api/me/item/${libraryItemId}/bookmark`, { title, time });
      loadBookmarks();
    } catch (e) {
      // Keep the optimistic local bookmark.
    }
  };

  const deleteBookmark = async (bm: Bookmark) => {
    setBookmarks((prev) => prev.filter((b) => b.time !== bm.time));
    if (!libraryItemId) return;
    try {
      await api.delete(`/api/me/item/${libraryItemId}/bookmark/${bm.time}`);
    } catch (e) {
      // Already removed locally.
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0, 0, 0, 0.4)" }} onPress={onClose}>
        <Pressable
          onPress={() => {}}
          style={{
            backgroundColor: colors.surfaceContainerHigh,
            borderTopLeftRadius: 28,
            borderTopRightRadius: 28,
            maxHeight: "80%",
          }}
        >
          <SafeAreaView edges={["bottom"]}>
            {/* Header */}
            <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 24, paddingTop: 20, paddingBottom: 12 }}>
              <Icon name="bookmark" size={24} color={colors.onSurface} style={{ marginRight: 12 }} />
              <Text style={{ flex: 1, fontSize: 22, fontWeight: "500", color: colors.onSurface }}>Your Bookmarks</Text>
            </View>

            {loading ? (
              <View style={{ height: 96, alignItems: "center", justifyContent: "center" }}>
                <ActivityIndicator color={colors.primary} />
              </View>
            ) : bookmarks.length === 0 ? (
              <View style={{ height: 96, alignItems: "center", justifyContent: "center" }}>
                <Text style={{ fontSize: 16, color: colors.onSurfaceVariant }}>No bookmarks</Text>
              </View>
            ) : (
              <ScrollView style={{ maxHeight: 360 }} contentContainerStyle={{ paddingHorizontal: 16 }}>
                {bookmarks.map((bm) => {
                  const active = Math.floor(bm.time) === Math.floor(currentTime);
                  return (
                    <Pressable
                      key={bm.time}
                      onPress={() => {
                        onSeek(bm.time);
                        onClose();
                      }}
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        paddingHorizontal: 16,
                        height: 56,
                        borderRadius: 20,
                        backgroundColor: active ? colors.secondaryContainer : "transparent",
                      }}
                    >
                      <Text
                        numberOfLines={1}
                        style={{ flex: 1, fontSize: 16, color: active ? colors.onSecondaryContainer : colors.onSurface }}
                      >
                        {bm.title}
                      </Text>
                      <Text
                        style={{
                          fontFamily: "monospace",
                          fontSize: 14,
                          marginHorizontal: 10,
                          color: active ? colors.onSecondaryContainer : colors.onSurfaceVariant,
                        }}
                      >
                        {fmt(bm.time)}
                      </Text>
                      <Pressable onPress={() => deleteBookmark(bm)} hitSlop={8} style={{ padding: 4 }}>
                        <Icon name="trash" size={20} color={colors.onSurfaceVariant} />
                      </Pressable>
                    </Pressable>
                  );
                })}
              </ScrollView>
            )}

            {/* Add bookmark at current time */}
            {!alreadyBookmarked ? (
              <Pressable
                onPress={addBookmark}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  backgroundColor: colors.primaryContainer,
                  paddingHorizontal: 20,
                  paddingVertical: 16,
                  marginTop: 8,
                }}
              >
                <Icon name="bookmark" size={22} color={colors.onPrimaryContainer} />
                <Text style={{ flex: 1, fontSize: 15, fontWeight: "500", color: colors.onPrimaryContainer, paddingLeft: 10 }}>
                  Add bookmark at current time
                </Text>
                <Text style={{ fontFamily: "monospace", fontSize: 13, color: colors.onPrimaryContainer }}>{fmt(currentTime)}</Text>
              </Pressable>
            ) : null}
          </SafeAreaView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
