import React, { useCallback, useEffect, useState } from "react";
import { View, Text, ScrollView, ActivityIndicator } from "react-native";
import { useThemeColors } from "../theme/useThemeColors";
import Icon from "./Icon";
import { api } from "../utils/api";
import {
  queueBookmark,
  pendingBookmarksFor,
  removePendingBookmark,
  queueBookmarkDeletion,
  pendingBookmarkDeletionsFor,
} from "../utils/progressSync";
import BottomSheet from "./BottomSheet";
import Pressable from "./HintPressable";

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
  // Which item the current `bookmarks` state belongs to — the modal stays
  // mounted across book switches, so an offline load must not merge the new
  // item's queued bookmarks into (or silently keep) the PREVIOUS item's list.
  const loadedForRef = React.useRef<string | null>(null);

  const loadBookmarks = useCallback(async () => {
    if (!libraryItemId) {
      // No server id (local-only item): clear rather than showing whatever the
      // previously-opened book left in state.
      setBookmarks([]);
      return;
    }
    setLoading(true);
    try {
      const res = await api.get("/api/me");
      const all: Bookmark[] = res.data?.bookmarks || [];
      // Hide server bookmarks whose offline DELETION hasn't flushed yet —
      // they'd otherwise reappear here until the queued delete lands.
      const deletions = pendingBookmarkDeletionsFor(libraryItemId);
      const server = all.filter(
        (b) =>
          b.libraryItemId === libraryItemId && !deletions.includes(Math.floor(b.time))
      );
      // Merge queued-offline bookmarks not yet flushed to the server.
      const pending = pendingBookmarksFor(libraryItemId)
        .filter((p) => !server.some((s) => Math.floor(s.time) === p.time))
        .map((p) => ({ libraryItemId, title: p.title, time: p.time }));
      setBookmarks([...server, ...pending].sort((a, b) => a.time - b.time));
      loadedForRef.current = libraryItemId;
    } catch (e) {
      // Offline / local item: show the queued bookmarks so they aren't
      // invisible until connectivity returns.
      const pending = pendingBookmarksFor(libraryItemId).map((p) => ({
        libraryItemId,
        title: p.title,
        time: p.time,
      }));
      setBookmarks((prev) => {
        // Keep previously-loaded rows only if they belong to THIS item —
        // otherwise a book switched to while offline showed (and let the user
        // "delete") the previous book's bookmarks against the wrong id.
        const merged = loadedForRef.current === libraryItemId ? [...prev] : [];
        for (const p of pending) {
          if (!merged.some((b) => Math.floor(b.time) === p.time)) merged.push(p);
        }
        return merged.sort((a, b) => a.time - b.time);
      });
      loadedForRef.current = libraryItemId;
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
      // Offline: queue it durably — the optimistic row alone died with the
      // modal, silently losing the bookmark. Flushed with the sync queues.
      queueBookmark(libraryItemId, time, title);
    }
  };

  const deleteBookmark = async (bm: Bookmark) => {
    setBookmarks((prev) => prev.filter((b) => b.time !== bm.time));
    if (!libraryItemId) return;
    // If it was queued offline, unqueue it too (there's no server row yet —
    // without this the flush would resurrect a deleted bookmark).
    removePendingBookmark(libraryItemId, bm.time);
    try {
      await api.delete(`/api/me/item/${libraryItemId}/bookmark/${bm.time}`);
    } catch (e) {
      // Offline: queue the deletion so it replays on reconnect — a synced
      // bookmark deleted offline used to silently reappear from the server.
      queueBookmarkDeletion(libraryItemId, bm.time);
    }
  };

  return (
    <BottomSheet visible={visible} onClose={onClose}>
            {/* Header */}
            <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 24, paddingTop: 8, paddingBottom: 12 }}>
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
                      accessibilityRole="button"
                      accessibilityLabel={`Bookmark ${bm.title}, ${fmt(bm.time)}`}
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
                      <Pressable
                        onPress={() => deleteBookmark(bm)}
                        hitSlop={12}
                        accessibilityRole="button"
                        accessibilityLabel="Delete bookmark"
                        style={{ padding: 4 }}
                      >
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
                accessibilityRole="button"
                accessibilityLabel={`Add bookmark at ${fmt(currentTime)}`}
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
    </BottomSheet>
  );
}
