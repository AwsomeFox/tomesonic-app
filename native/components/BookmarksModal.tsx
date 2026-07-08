import React, { useCallback, useEffect, useState } from "react";
import { View, Text, ScrollView, ActivityIndicator, TextInput } from "react-native";
import { useThemeColors } from "../theme/useThemeColors";
import { showAppDialog } from "../store/useDialogStore";
import Icon from "./Icon";
import { api } from "../utils/api";
import {
  queueBookmark,
  pendingBookmarksFor,
  removePendingBookmark,
  queueBookmarkDeletion,
  pendingBookmarkDeletionsFor,
  queueBookmarkRename,
  pendingBookmarkRenamesFor,
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
  // Title typed into the "add bookmark" field (blank → timestamp default, so
  // the add behavior is unchanged when left empty).
  const [newTitle, setNewTitle] = useState("");
  // Which bookmark row is being renamed (its `time`), and the in-progress title.
  const [editingTime, setEditingTime] = useState<number | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  // Which item the current `bookmarks` state belongs to — the modal stays
  // mounted across book switches, so an offline load must not merge the new
  // item's queued bookmarks into (or silently keep) the PREVIOUS item's list.
  const loadedForRef = React.useRef<string | null>(null);

  // Apply any queued-offline renames over a list's titles (matched by floored
  // time), so an offline rename shows immediately and survives a reload before
  // it flushes — mirrors the pending create/delete merge behavior.
  const applyRenames = useCallback(
    (list: Bookmark[]): Bookmark[] => {
      if (!libraryItemId) return list;
      const renames = pendingBookmarkRenamesFor(libraryItemId);
      if (!renames.length) return list;
      return list.map((b) => {
        const rn = renames.find((r) => Math.floor(r.time) === Math.floor(b.time));
        return rn ? { ...b, title: rn.title } : b;
      });
    },
    [libraryItemId]
  );

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
      setBookmarks(applyRenames([...server, ...pending]).sort((a, b) => a.time - b.time));
      loadedForRef.current = libraryItemId;
    } catch (e) {
      // Offline / local item: show the queued bookmarks so they aren't
      // invisible until connectivity returns.
      const pending = pendingBookmarksFor(libraryItemId).map((p) => ({
        libraryItemId,
        title: p.title,
        time: p.time,
      }));
      // Keep previously-loaded rows only if they belong to THIS item —
      // otherwise a book switched to while offline showed (and let the user
      // "delete") the previous book's bookmarks against the wrong id.
      // Captured BEFORE setBookmarks: React defers the functional updater, so
      // reading the ref inside it would see the reassignment below.
      const sameItem = loadedForRef.current === libraryItemId;
      setBookmarks((prev) => {
        const merged = sameItem ? [...prev] : [];
        for (const p of pending) {
          if (!merged.some((b) => Math.floor(b.time) === p.time)) merged.push(p);
        }
        return applyRenames(merged).sort((a, b) => a.time - b.time);
      });
      loadedForRef.current = libraryItemId;
    } finally {
      setLoading(false);
    }
  }, [libraryItemId, applyRenames]);

  useEffect(() => {
    if (visible) loadBookmarks();
  }, [visible, loadBookmarks]);

  const alreadyBookmarked = bookmarks.some((b) => Math.floor(b.time) === Math.floor(currentTime));

  const addBookmark = async () => {
    const time = Math.floor(currentTime);
    // A typed title wins; a blank field falls back to the timestamp string, so
    // the auto-named behavior is unchanged when the user adds without typing.
    const title = newTitle.trim() || new Date().toLocaleString();
    const local: Bookmark = { libraryItemId, title, time };
    // Optimistic local insert (also the fallback when offline).
    setBookmarks((prev) => [...prev, local].sort((a, b) => a.time - b.time));
    setNewTitle("");
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

  const startRename = (bm: Bookmark) => {
    setEditingTime(bm.time);
    setEditingTitle(bm.title);
  };

  const performRename = async (bm: Bookmark, rawTitle: string) => {
    // Blank falls back to the existing title (a rename never blanks a bookmark).
    const title = rawTitle.trim() || bm.title;
    // Optimistic local update (also the fallback when offline).
    setBookmarks((prev) => prev.map((b) => (b.time === bm.time ? { ...b, title } : b)));
    setEditingTime(null);
    setEditingTitle("");
    if (!libraryItemId) return;
    try {
      // Server matches the bookmark by its exact time and updates the title.
      await api.patch(`/api/me/item/${libraryItemId}/bookmark`, { time: bm.time, title });
    } catch (e) {
      // Offline: queue the rename so it replays on reconnect — a swallowed
      // rename otherwise reverted to the server title on the next load.
      queueBookmarkRename(libraryItemId, bm.time, title);
    }
  };

  const performDeleteBookmark = async (bm: Bookmark) => {
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

  // Deleting a bookmark is destructive and irreversible offline — confirm first
  // (a mis-tap on the small delete affordance otherwise lost it silently).
  const deleteBookmark = (bm: Bookmark) => {
    showAppDialog({
      title: "Delete bookmark",
      message: bm.title ? `Delete "${bm.title}"?` : "Delete this bookmark?",
      buttons: [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: () => performDeleteBookmark(bm) },
      ],
    });
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
                  // Inline rename mode: swap the seek row for a title editor so
                  // the user can rename without leaving the sheet.
                  if (editingTime === bm.time) {
                    return (
                      <View
                        key={bm.time}
                        style={{
                          flexDirection: "row",
                          alignItems: "center",
                          paddingHorizontal: 16,
                          height: 56,
                          borderRadius: 20,
                          backgroundColor: colors.secondaryContainer,
                        }}
                      >
                        <TextInput
                          value={editingTitle}
                          onChangeText={setEditingTitle}
                          autoFocus
                          placeholder={fmt(bm.time)}
                          placeholderTextColor={colors.onSurfaceVariant}
                          accessibilityLabel="Edit bookmark title"
                          onSubmitEditing={() => performRename(bm, editingTitle)}
                          style={{
                            flex: 1,
                            fontSize: 16,
                            color: colors.onSecondaryContainer,
                            paddingVertical: 0,
                          }}
                        />
                        <Pressable
                          onPress={() => performRename(bm, editingTitle)}
                          hitSlop={12}
                          accessibilityRole="button"
                          accessibilityLabel="Save bookmark title"
                          style={{ padding: 4, marginLeft: 8 }}
                        >
                          <Icon name="check" size={20} color={colors.primary} />
                        </Pressable>
                      </View>
                    );
                  }
                  return (
                    <Pressable
                      key={bm.time}
                      onPress={() => {
                        onSeek(bm.time);
                        onClose();
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={`Bookmark ${bm.title}, ${fmt(bm.time)}`}
                      // The row is one accessible button (its children collapse
                      // into it), so the nested trash/edit Pressables are
                      // unreachable by TalkBack — expose them as custom a11y
                      // actions instead.
                      accessibilityActions={[
                        { name: "rename", label: "Rename bookmark" },
                        { name: "delete", label: "Delete bookmark" },
                      ]}
                      onAccessibilityAction={(e) => {
                        if (e.nativeEvent.actionName === "delete") deleteBookmark(bm);
                        if (e.nativeEvent.actionName === "rename") startRename(bm);
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
                      <Pressable
                        onPress={() => startRename(bm)}
                        hitSlop={12}
                        accessibilityRole="button"
                        accessibilityLabel="Rename bookmark"
                        style={{ padding: 4 }}
                      >
                        <Icon name="edit" size={20} color={colors.onSurfaceVariant} />
                      </Pressable>
                      <Pressable
                        onPress={() => deleteBookmark(bm)}
                        hitSlop={12}
                        accessibilityRole="button"
                        accessibilityLabel="Delete bookmark"
                        style={{ padding: 4, marginLeft: 4 }}
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
              <View style={{ marginTop: 8 }}>
                {/* Optional title — blank falls back to a timestamp, so adding
                    without typing keeps the original auto-named behavior. */}
                <TextInput
                  value={newTitle}
                  onChangeText={setNewTitle}
                  placeholder="Bookmark title (optional)"
                  placeholderTextColor={colors.onSurfaceVariant}
                  accessibilityLabel="Bookmark title"
                  onSubmitEditing={addBookmark}
                  style={{
                    marginHorizontal: 20,
                    marginBottom: 8,
                    paddingHorizontal: 16,
                    height: 44,
                    borderRadius: 12,
                    borderWidth: 1,
                    borderColor: colors.outlineVariant,
                    color: colors.onSurface,
                    fontSize: 15,
                  }}
                />
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
                  }}
                >
                  <Icon name="bookmark" size={22} color={colors.onPrimaryContainer} />
                  <Text style={{ flex: 1, fontSize: 15, fontWeight: "500", color: colors.onPrimaryContainer, paddingLeft: 10 }}>
                    Add bookmark at current time
                  </Text>
                  <Text style={{ fontFamily: "monospace", fontSize: 13, color: colors.onPrimaryContainer }}>{fmt(currentTime)}</Text>
                </Pressable>
              </View>
            ) : null}
    </BottomSheet>
  );
}
