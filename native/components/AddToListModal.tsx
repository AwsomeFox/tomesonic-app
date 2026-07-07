import React, { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  TextInput,
  ActivityIndicator,
} from "react-native";
import { useThemeColors } from "../theme/useThemeColors";
import { withAlpha } from "../theme/palette";
import { api } from "../utils/api";
import Icon from "./Icon";
import BottomSheet from "./BottomSheet";

/**
 * "Add to…" bottom sheet for a library item: lists the library's collections
 * and the user's playlists with membership toggles, plus inline create-new
 * rows. Collections are book-only in ABS, so podcasts only see playlists.
 *
 * Endpoints (verified against the ABS server ApiRouter):
 *   GET    /api/libraries/:id/collections | /playlists
 *   POST   /api/collections {libraryId, name, books[]}
 *   POST   /api/collections/:id/book {id}
 *   DELETE /api/collections/:id/book/:bookId
 *   POST   /api/playlists {libraryId, name, items[]}
 *   POST   /api/playlists/:id/item {libraryItemId}
 *   DELETE /api/playlists/:id/item/:libraryItemId
 */

interface Props {
  visible: boolean;
  onClose: () => void;
  libraryItemId: string;
  libraryId: string;
  /** Collections are book-only — hide that section for podcasts. */
  isPodcast?: boolean;
}

type ListKind = "collection" | "playlist";

export default function AddToListModal({
  visible,
  onClose,
  libraryItemId,
  libraryId,
  isPodcast,
}: Props) {
  const colors = useThemeColors();
  const [collections, setCollections] = useState<any[]>([]);
  const [playlists, setPlaylists] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  // id currently being toggled (disables its row) / kind being created
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creating, setCreating] = useState<ListKind | null>(null);
  const [newName, setNewName] = useState("");
  // Inline failure message — toggles/creates used to fail with only a
  // console.warn (the checkmark silently reverted).
  const [actionError, setActionError] = useState<string | null>(null);

  const fetchLists = useCallback(async () => {
    if (!libraryId) return;
    setLoading(true);
    setLoadError(false);
    try {
      const [collRes, plRes] = await Promise.all([
        isPodcast
          ? Promise.resolve({ data: { results: [] } })
          : api.get(`/api/libraries/${libraryId}/collections`),
        api.get(`/api/libraries/${libraryId}/playlists`),
      ]);
      setCollections(collRes.data?.results || []);
      setPlaylists(plRes.data?.results || []);
    } catch (e) {
      console.warn("[AddToList] failed to load lists", e);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [libraryId, isPodcast]);

  useEffect(() => {
    if (visible) {
      setCreating(null);
      setNewName("");
      setActionError(null);
      fetchLists();
    }
  }, [visible, fetchLists]);

  const collectionHasItem = (c: any) =>
    (c.books || []).some((b: any) => b.id === libraryItemId || b.libraryItemId === libraryItemId);
  const playlistHasItem = (p: any) =>
    (p.items || []).some(
      (i: any) => i.libraryItemId === libraryItemId || i.libraryItem?.id === libraryItemId
    );

  const toggleCollection = async (c: any) => {
    if (busyId) return;
    setActionError(null);
    setBusyId(c.id);
    try {
      const res = collectionHasItem(c)
        ? await api.delete(`/api/collections/${c.id}/book/${libraryItemId}`)
        : await api.post(`/api/collections/${c.id}/book`, { id: libraryItemId });
      // The server returns the updated collection — swap it in place.
      const updated = res.data;
      if (updated?.id) {
        setCollections((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
      } else {
        fetchLists();
      }
    } catch (e) {
      console.warn("[AddToList] collection toggle failed", e);
      setActionError("Couldn't update the collection — check your connection.");
      // Resync — the server state may have diverged (e.g. deleted elsewhere).
      fetchLists();
    } finally {
      setBusyId(null);
    }
  };

  const togglePlaylist = async (p: any) => {
    if (busyId) return;
    setActionError(null);
    setBusyId(p.id);
    try {
      const res = playlistHasItem(p)
        ? await api.delete(`/api/playlists/${p.id}/item/${libraryItemId}`)
        : await api.post(`/api/playlists/${p.id}/item`, { libraryItemId });
      const updated = res.data;
      if (updated?.id) {
        // ABS deletes a playlist that loses its last item — drop it locally
        // too instead of leaving a dead row.
        if ((updated.items || []).length === 0) {
          setPlaylists((prev) => prev.filter((x) => x.id !== updated.id));
        } else {
          setPlaylists((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
        }
      } else {
        fetchLists();
      }
    } catch (e) {
      console.warn("[AddToList] playlist toggle failed", e);
      setActionError("Couldn't update the playlist — check your connection.");
      // Resync — ABS deletes a playlist when its last item is removed, so the
      // local copy can go stale mid-session.
      fetchLists();
    } finally {
      setBusyId(null);
    }
  };

  const createList = async (kind: ListKind) => {
    const name = newName.trim();
    if (!name || busyId) return;
    setActionError(null);
    setBusyId(`create_${kind}`);
    try {
      if (kind === "collection") {
        const res = await api.post(`/api/collections`, {
          libraryId,
          name,
          books: [libraryItemId],
        });
        if (res.data?.id) setCollections((prev) => [res.data, ...prev]);
      } else {
        const res = await api.post(`/api/playlists`, {
          libraryId,
          name,
          items: [{ libraryItemId }],
        });
        if (res.data?.id) setPlaylists((prev) => [res.data, ...prev]);
      }
      setCreating(null);
      setNewName("");
    } catch (e) {
      console.warn(`[AddToList] create ${kind} failed`, e);
      setActionError(`Couldn't create the ${kind} — check your connection.`);
    } finally {
      setBusyId(null);
    }
  };

  const renderRow = (item: any, kind: ListKind) => {
    const member = kind === "collection" ? collectionHasItem(item) : playlistHasItem(item);
    const count = (kind === "collection" ? item.books : item.items)?.length || 0;
    const busy = busyId === item.id;
    return (
      <Pressable
        key={item.id}
        onPress={() => (kind === "collection" ? toggleCollection(item) : togglePlaylist(item))}
        disabled={!!busyId}
        android_ripple={{ color: colors.surfaceContainerHighest }}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: member, disabled: !!busyId }}
        accessibilityLabel={`${item.name}, ${count} ${count === 1 ? "item" : "items"}`}
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingVertical: 12,
          paddingHorizontal: 12,
          borderRadius: 16,
          backgroundColor: member ? colors.secondaryContainer : "transparent",
          marginBottom: 2,
        }}
      >
        <Icon
          name={kind === "collection" ? "collections" : "list"}
          size={20}
          color={member ? colors.onSecondaryContainer : colors.onSurfaceVariant}
        />
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text
            numberOfLines={1}
            style={{
              fontSize: 16,
              color: member ? colors.onSecondaryContainer : colors.onSurface,
            }}
          >
            {item.name}
          </Text>
          <Text
            style={{
              fontSize: 12,
              marginTop: 1,
              color: member
                ? withAlpha(colors.onSecondaryContainer, 0.8)
                : colors.onSurfaceVariant,
            }}
          >
            {count} {count === 1 ? "item" : "items"}
          </Text>
        </View>
        {busy ? (
          <ActivityIndicator size="small" color={colors.primary} />
        ) : member ? (
          <Icon name="check" size={22} color={colors.onSecondaryContainer} />
        ) : (
          <Icon name="add" size={22} color={colors.onSurfaceVariant} />
        )}
      </Pressable>
    );
  };

  const renderCreateRow = (kind: ListKind) => {
    const active = creating === kind;
    const busy = busyId === `create_${kind}`;
    if (!active) {
      return (
        <Pressable
          onPress={() => {
            setCreating(kind);
            setNewName("");
          }}
          android_ripple={{ color: colors.surfaceContainerHighest }}
          accessibilityRole="button"
          accessibilityLabel={`Create new ${kind}`}
          style={{
            flexDirection: "row",
            alignItems: "center",
            paddingVertical: 12,
            paddingHorizontal: 12,
            borderRadius: 16,
          }}
        >
          <Icon name="add" size={20} color={colors.primary} />
          <Text style={{ fontSize: 16, color: colors.primary, marginLeft: 12, fontWeight: "600" }}>
            New {kind}…
          </Text>
        </Pressable>
      );
    }
    return (
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingVertical: 6,
          paddingHorizontal: 12,
        }}
      >
        <TextInput
          value={newName}
          onChangeText={setNewName}
          placeholder={`${kind === "collection" ? "Collection" : "Playlist"} name`}
          placeholderTextColor={colors.onSurfaceVariant}
          autoFocus
          returnKeyType="done"
          onSubmitEditing={() => createList(kind)}
          style={{
            flex: 1,
            color: colors.onSurface,
            fontSize: 16,
            backgroundColor: colors.surfaceContainerHighest,
            borderRadius: 12,
            paddingHorizontal: 14,
            paddingVertical: 10,
          }}
        />
        <Pressable
          onPress={() => createList(kind)}
          disabled={!newName.trim() || busy}
          accessibilityRole="button"
          accessibilityLabel={`Create ${kind}`}
          style={{
            marginLeft: 10,
            width: 44,
            height: 44,
            borderRadius: 22,
            backgroundColor: newName.trim() ? colors.primary : colors.surfaceContainerHighest,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {busy ? (
            <ActivityIndicator size="small" color={colors.onPrimary} />
          ) : (
            <Icon name="check" size={22} color={newName.trim() ? colors.onPrimary : colors.onSurfaceVariant} />
          )}
        </Pressable>
        <Pressable
          onPress={() => {
            setCreating(null);
            setNewName("");
          }}
          accessibilityRole="button"
          accessibilityLabel="Cancel"
          style={{ marginLeft: 6, padding: 10 }}
        >
          <Icon name="close" size={20} color={colors.onSurfaceVariant} />
        </Pressable>
      </View>
    );
  };

  const sectionHeader = (label: string) => (
    <Text
      style={{
        color: colors.onSurfaceVariant,
        fontSize: 13,
        fontWeight: "700",
        letterSpacing: 0.4,
        textTransform: "uppercase",
        paddingHorizontal: 12,
        paddingTop: 14,
        paddingBottom: 6,
      }}
    >
      {label}
    </Text>
  );

  return (
    <BottomSheet visible={visible} onClose={onClose}>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                paddingHorizontal: 20,
                paddingVertical: 8,
              }}
            >
              <Icon name="playlist-add" size={24} color={colors.onSurface} style={{ marginRight: 12 }} />
              {/* Match the bottom-sheet header type scale used across the app
                  (Bookmarks / Chapters / Speed / Sleep all use 22/500). */}
              <Text style={{ fontSize: 22, fontWeight: "500", color: colors.onSurface }}>
                Add to…
              </Text>
            </View>
            {actionError ? (
              <Text style={{ color: colors.error, fontSize: 13, paddingHorizontal: 20, paddingBottom: 4 }}>
                {actionError}
              </Text>
            ) : null}

            {loading ? (
              <View style={{ paddingVertical: 40, alignItems: "center" }}>
                <ActivityIndicator size="large" color={colors.primary} />
              </View>
            ) : loadError ? (
              <View style={{ paddingVertical: 32, alignItems: "center", paddingHorizontal: 24 }}>
                <Icon name="warning" size={36} color={colors.error} />
                <Text style={{ color: colors.onSurface, fontSize: 15, marginTop: 10, textAlign: "center" }}>
                  Couldn't load collections and playlists.
                </Text>
                <Pressable
                  onPress={fetchLists}
                  android_ripple={{ color: withAlpha(colors.onPrimary, 0.2) }}
                  style={{
                    marginTop: 14,
                    paddingHorizontal: 22,
                    paddingVertical: 9,
                    borderRadius: 22,
                    overflow: "hidden",
                    backgroundColor: colors.primary,
                  }}
                >
                  <Text style={{ color: colors.onPrimary, fontWeight: "600" }}>Retry</Text>
                </Pressable>
              </View>
            ) : (
              <ScrollView
                contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 12 }}
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
              >
                {!isPodcast ? (
                  <>
                    {sectionHeader("Collections")}
                    {collections.map((c) => renderRow(c, "collection"))}
                    {renderCreateRow("collection")}
                  </>
                ) : null}

                {sectionHeader("Playlists")}
                {playlists.map((p) => renderRow(p, "playlist"))}
                {renderCreateRow("playlist")}
              </ScrollView>
            )}
    </BottomSheet>
  );
}
