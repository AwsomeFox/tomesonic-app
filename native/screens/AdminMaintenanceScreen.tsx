import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  ActivityIndicator,
  Pressable,
  TextInput,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useThemeColors } from "../theme/useThemeColors";
import { withAlpha } from "../theme/palette";
import Icon, { IconName } from "../components/Icon";
import ErrorState from "../components/ErrorState";
import EmptyState from "../components/EmptyState";
import { SectionHeader, RowBase, Divider } from "../components/SettingsRows";
import { AbsError, normalizeAbsError } from "../utils/abs/errors";
import {
  getTags,
  renameTag,
  deleteTag,
  getGenres,
  renameGenre,
  deleteGenre,
  purgeCache,
  purgeItemsCache,
} from "../utils/abs/server";
import {
  getLibraryNarrators,
  updateNarrator,
  narratorNameToId,
} from "../utils/abs/libraries";
import type { AbsNarrator } from "../utils/abs/types";
import { useLibraryStore } from "../store/useLibraryStore";
import { showAppDialog } from "../store/useDialogStore";
import { showSnackbar } from "../store/useSnackbarStore";

/**
 * AdminMaintenanceScreen — bulk library cleanup + server cache maintenance.
 *
 * Route: "AdminMaintenance" (no params)
 *
 * Segments: Tags · Genres · Narrators (narrators are per-library — the picker
 * defaults to the app's current library). Below the segment list, a CACHE
 * section with the two purge actions.
 *
 * Every mutation is a bulk, no-undo server operation, so each goes through a
 * showAppDialog confirm (Tier-2 per the UX plan's destructive-action policy).
 * Narrator ids are the server's derived encodeURIComponent(base64(name)) —
 * we pass AbsNarrator.id through, falling back to narratorNameToId(name).
 */

type Segment = "tags" | "genres" | "narrators";

// Map an AbsError kind onto the ErrorState idiom (offline vs forbidden vs
// unsupported vs server all read differently).
function errorStateProps(err: AbsError): { icon: IconName; title: string; message: string } {
  switch (err.kind) {
    case "offline":
      return {
        icon: "cloud-off",
        title: "You're offline",
        message: "Server maintenance needs a connection.",
      };
    case "forbidden":
      return { icon: "lock", title: "Admin access required", message: err.message };
    case "unsupported":
      return { icon: "info", title: "Not supported by this server", message: err.message };
    case "server":
      return { icon: "warning", title: "The server hit an error", message: err.message };
    default:
      return { icon: "warning", title: "Something went wrong", message: err.message };
  }
}

const SEGMENTS: { key: Segment; label: string }[] = [
  { key: "tags", label: "Tags" },
  { key: "genres", label: "Genres" },
  { key: "narrators", label: "Narrators" },
];

export default function AdminMaintenanceScreen({ navigation }: any) {
  const colors = useThemeColors();

  const storeLibraries = useLibraryStore((s) => s.libraries);
  const currentLibraryId = useLibraryStore((s) => s.currentLibraryId);

  const [segment, setSegment] = useState<Segment>("tags");
  const [tags, setTags] = useState<string[]>([]);
  const [genres, setGenres] = useState<string[]>([]);
  const [narrators, setNarrators] = useState<AbsNarrator[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AbsError | null>(null);
  const [retryTick, setRetryTick] = useState(0);

  // Narrators are per-library; default to the app's current library.
  const [narratorLibraryId, setNarratorLibraryId] = useState<string | null>(
    currentLibraryId || storeLibraries[0]?.id || null
  );
  const narratorLibrary = storeLibraries.find((l) => l.id === narratorLibraryId) || null;

  // Inline rename state: which row is being edited and the draft value.
  const [editingName, setEditingName] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      setEditingName(null);
      try {
        if (segment === "tags") {
          const list = await getTags();
          if (!cancelled) setTags(list);
        } else if (segment === "genres") {
          const list = await getGenres();
          if (!cancelled) setGenres(list);
        } else if (narratorLibraryId) {
          const list = await getLibraryNarrators(narratorLibraryId);
          if (!cancelled) setNarrators(list);
        }
      } catch (e) {
        if (!cancelled) setError(normalizeAbsError(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [segment, retryTick, narratorLibraryId]);

  const reload = () => setRetryTick((t) => t + 1);

  const showAbsErrorDialog = (title: string, e: any) => {
    const err = normalizeAbsError(e);
    showAppDialog({ title, message: err.message });
  };

  // ---- rename flows ---------------------------------------------------------

  const startRename = (name: string) => {
    setEditingName(name);
    setEditValue(name);
  };

  const nounFor = (seg: Segment) =>
    seg === "tags" ? "tag" : seg === "genres" ? "genre" : "narrator";

  const doRename = async (oldName: string, newName: string) => {
    try {
      if (segment === "tags") {
        await renameTag(oldName, newName);
        showSnackbar({ message: "Tag renamed" });
      } else if (segment === "genres") {
        await renameGenre(oldName, newName);
        showSnackbar({ message: "Genre renamed" });
      } else {
        if (!narratorLibraryId) return;
        const narrator = narrators.find((n) => n.name === oldName);
        const narratorId = narrator?.id || narratorNameToId(oldName);
        const res = await updateNarrator(narratorLibraryId, narratorId, newName);
        showSnackbar({
          message:
            typeof res?.updated === "number"
              ? `Narrator renamed (${res.updated} book${res.updated === 1 ? "" : "s"} updated)`
              : "Narrator renamed",
        });
      }
      setEditingName(null);
      reload();
    } catch (e) {
      showAbsErrorDialog(`Couldn't rename the ${nounFor(segment)}`, e);
    }
  };

  const confirmRename = (oldName: string) => {
    const newName = editValue.trim();
    if (!newName || newName === oldName) {
      setEditingName(null);
      return;
    }
    const existing =
      segment === "tags" ? tags : segment === "genres" ? genres : narrators.map((n) => n.name);
    const isMerge = existing.includes(newName);
    const noun = nounFor(segment);
    showAppDialog({
      title: `Rename ${noun}`,
      message: isMerge
        ? `"${oldName}" will be merged into the existing ${noun} "${newName}" across all items. There is no undo.`
        : `Rename "${oldName}" to "${newName}" across all items on the server?`,
      buttons: [
        { text: "Cancel", style: "cancel" },
        { text: isMerge ? "Merge" : "Rename", onPress: () => doRename(oldName, newName) },
      ],
    });
  };

  // ---- delete flows ---------------------------------------------------------

  const doDelete = async (name: string) => {
    try {
      if (segment === "tags") {
        await deleteTag(name);
        showSnackbar({ message: "Tag deleted" });
      } else {
        await deleteGenre(name);
        showSnackbar({ message: "Genre deleted" });
      }
      reload();
    } catch (e) {
      showAbsErrorDialog(`Couldn't delete the ${nounFor(segment)}`, e);
    }
  };

  const confirmDelete = (name: string) => {
    const noun = nounFor(segment);
    showAppDialog({
      title: `Delete ${noun}`,
      message: `Remove "${name}" from every item on the server? There is no undo.`,
      buttons: [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: () => doDelete(name) },
      ],
    });
  };

  // ---- cache flows ----------------------------------------------------------

  const confirmPurgeCache = () => {
    showAppDialog({
      title: "Purge all cache",
      message: "Delete everything in the server's cache directory? It will be rebuilt as needed.",
      buttons: [
        { text: "Cancel", style: "cancel" },
        {
          text: "Purge",
          style: "destructive",
          onPress: async () => {
            try {
              await purgeCache();
              showSnackbar({ message: "Server cache purged" });
            } catch (e) {
              showAbsErrorDialog("Couldn't purge the cache", e);
            }
          },
        },
      ],
    });
  };

  const confirmPurgeItemsCache = () => {
    showAppDialog({
      title: "Purge items cache",
      message: "Delete the server's cached item covers and metadata? They will be rebuilt as needed.",
      buttons: [
        { text: "Cancel", style: "cancel" },
        {
          text: "Purge",
          style: "destructive",
          onPress: async () => {
            try {
              await purgeItemsCache();
              showSnackbar({ message: "Items cache purged" });
            } catch (e) {
              showAbsErrorDialog("Couldn't purge the items cache", e);
            }
          },
        },
      ],
    });
  };

  // ---- narrator library picker ----------------------------------------------

  const pickNarratorLibrary = () => {
    const bookLibraries = storeLibraries.filter((l) => l.mediaType !== "podcast");
    if (!bookLibraries.length) return;
    showAppDialog({
      title: "Choose a library",
      buttons: [
        ...bookLibraries.map((l) => ({
          text: l.name,
          onPress: () => setNarratorLibraryId(l.id),
        })),
        { text: "Cancel", style: "cancel" as const },
      ],
    });
  };

  // ---- rows -----------------------------------------------------------------

  const iconButton = (name: IconName, label: string, onPress: () => void, color?: string) => (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={label}
      android_ripple={{ color: withAlpha(colors.onSurfaceVariant, 0.12), borderless: true }}
      style={{
        width: 40,
        height: 40,
        borderRadius: 20,
        alignItems: "center",
        justifyContent: "center",
        marginLeft: 4,
        overflow: "hidden",
      }}
    >
      <Icon name={name} size={22} color={color || colors.onSurfaceVariant} />
    </Pressable>
  );

  const renderValueRow = (name: string, subtitle?: string, canDelete = true) => {
    const editing = editingName === name;
    return (
      <View
        key={name}
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 20,
          paddingVertical: 10,
        }}
      >
        {editing ? (
          <>
            <TextInput
              value={editValue}
              onChangeText={setEditValue}
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel={`New name for ${name}`}
              placeholderTextColor={colors.onSurfaceVariant}
              style={{
                flex: 1,
                backgroundColor: colors.surfaceContainer,
                color: colors.onSurface,
                borderRadius: 12,
                paddingHorizontal: 14,
                paddingVertical: 8,
                fontSize: 15,
              }}
            />
            {iconButton("check", `Confirm rename of ${name}`, () => confirmRename(name), colors.primary)}
            {iconButton("close", "Cancel rename", () => setEditingName(null))}
          </>
        ) : (
          <>
            <View style={{ flex: 1, marginRight: 8 }}>
              <Text style={{ color: colors.onSurface, fontSize: 16 }} numberOfLines={1}>
                {name}
              </Text>
              {subtitle ? (
                <Text style={{ color: colors.onSurfaceVariant, fontSize: 13, marginTop: 2 }}>
                  {subtitle}
                </Text>
              ) : null}
            </View>
            {iconButton("edit", `Rename ${name}`, () => startRename(name))}
            {canDelete ? iconButton("trash", `Delete ${name}`, () => confirmDelete(name), colors.error) : null}
          </>
        )}
      </View>
    );
  };

  const renderSegmentContent = () => {
    if (loading) {
      return (
        <View style={{ paddingVertical: 60, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      );
    }
    if (error) {
      return <ErrorState {...errorStateProps(error)} onRetry={reload} />;
    }
    if (segment === "tags") {
      return tags.length === 0 ? (
        <EmptyState icon="bookmark" title="No tags" message="Items on this server have no tags yet." />
      ) : (
        tags.map((t) => renderValueRow(t))
      );
    }
    if (segment === "genres") {
      return genres.length === 0 ? (
        <EmptyState icon="books" title="No genres" message="Items on this server have no genres yet." />
      ) : (
        genres.map((g) => renderValueRow(g))
      );
    }
    // Narrators
    if (!narratorLibraryId) {
      return (
        <EmptyState
          icon="mic"
          title="No library"
          message="Narrator cleanup needs a book library to work in."
        />
      );
    }
    return (
      <>
        <RowBase
          icon="library"
          title="Library"
          subtitle={narratorLibrary?.name || narratorLibraryId}
          onPress={pickNarratorLibrary}
          colors={colors}
        />
        <Divider colors={colors} />
        {narrators.length === 0 ? (
          <EmptyState icon="mic" title="No narrators" message="This library has no narrators yet." />
        ) : (
          narrators.map((n) =>
            renderValueRow(
              n.name,
              `${n.numBooks} book${n.numBooks === 1 ? "" : "s"}`,
              // No delete endpoint for narrators — rename-to-merge is the cleanup.
              false
            )
          )
        )}
      </>
    );
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }} edges={["top", "left", "right"]}>
      {/* Settings-family header */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 16,
          paddingVertical: 14,
          borderBottomWidth: 1,
          borderBottomColor: colors.outlineVariant,
        }}
      >
        <Pressable
          onPress={() => navigation.goBack()}
          style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", marginRight: 4 }}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Icon name="back" size={24} color={colors.onSurface} />
        </Pressable>
        <Text
          accessibilityRole="header"
          numberOfLines={1}
          style={{ color: colors.onSurface, fontSize: 20, fontWeight: "700", flex: 1 }}
        >
          Maintenance
        </Text>
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 40 }}>
        {/* Segment chips */}
        <View style={{ flexDirection: "row", paddingHorizontal: 16, paddingVertical: 12 }}>
          {SEGMENTS.map(({ key, label }) => {
            const selected = segment === key;
            return (
              <Pressable
                key={key}
                onPress={() => setSegment(key)}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                accessibilityLabel={label}
                android_ripple={{ color: withAlpha(colors.onSurfaceVariant, 0.12) }}
                hitSlop={{ top: 6, bottom: 6 }}
                style={{
                  paddingHorizontal: 16,
                  height: 36,
                  borderRadius: 18,
                  overflow: "hidden",
                  alignItems: "center",
                  justifyContent: "center",
                  marginRight: 8,
                  backgroundColor: selected ? colors.secondaryContainer : "transparent",
                  borderWidth: 1,
                  borderColor: selected ? colors.secondaryContainer : colors.outlineVariant,
                }}
              >
                <Text
                  style={{
                    color: selected ? colors.onSecondaryContainer : colors.onSurfaceVariant,
                    fontSize: 14,
                    fontWeight: "600",
                  }}
                >
                  {label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {renderSegmentContent()}

        {/* Cache maintenance — always available below the cleanup segments. */}
        <SectionHeader label="Cache" colors={colors} />
        <RowBase
          icon="trash"
          title="Purge all cache"
          subtitle="Clears the server's cache directory"
          onPress={confirmPurgeCache}
          colors={colors}
        />
        <Divider colors={colors} />
        <RowBase
          icon="image"
          title="Purge items cache"
          subtitle="Clears cached item covers and metadata"
          onPress={confirmPurgeItemsCache}
          colors={colors}
        />
      </ScrollView>
    </SafeAreaView>
  );
}
