import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  FlatList,
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
import SettingSelectModal from "../components/SettingSelectModal";
import { AbsError, normalizeAbsError, absErrorToErrorStateProps } from "../utils/abs/errors";
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
  getLibraryItemFilterCount,
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

// AbsError → ErrorState props via the shared engine; auth and unknown keep
// this screen's historical generic "Something went wrong" fallback.
function errorStateProps(err: AbsError) {
  return absErrorToErrorStateProps(err, {
    overrides: {
      offline: { message: "Server maintenance needs a connection." },
      auth: { icon: "warning", title: "Something went wrong" },
      unknown: { title: "Something went wrong" },
    },
  });
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
  // Mirror of `segment` for the stable FlatList viewability callback (which is
  // created once and must not close over a stale segment value).
  const segmentRef = useRef<Segment>("tags");
  useEffect(() => {
    segmentRef.current = segment;
  }, [segment]);
  const [tags, setTags] = useState<string[]>([]);
  const [genres, setGenres] = useState<string[]>([]);
  const [narrators, setNarrators] = useState<AbsNarrator[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AbsError | null>(null);
  const [retryTick, setRetryTick] = useState(0);

  // Narrators are per-library. The id is DERIVED from the store (falling back
  // to the current library, then the first one) rather than seeded once at
  // mount, so a library list that loads late still populates the picker —
  // an explicit pick simply overrides the derivation.
  const [narratorLibraryChoice, setNarratorLibraryChoice] = useState<string | null>(null);
  const narratorLibraryId = narratorLibraryChoice || currentLibraryId || storeLibraries[0]?.id || null;
  const narratorLibrary = storeLibraries.find((l) => l.id === narratorLibraryId) || null;
  const [libraryPickerOpen, setLibraryPickerOpen] = useState(false);

  // Inline rename state: which row is being edited and the draft value.
  const [editingName, setEditingName] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  // Tags / genres load. Deliberately NOT keyed on narratorLibraryId: a late
  // library-list load (which changes the derived narratorLibraryId) must not
  // pointlessly refetch tags/genres — only the narrators effect below depends
  // on it.
  useEffect(() => {
    if (segment === "narrators") return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      setEditingName(null);
      try {
        if (segment === "tags") {
          const list = await getTags();
          if (!cancelled) setTags(list);
        } else {
          const list = await getGenres();
          if (!cancelled) setGenres(list);
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
  }, [segment, retryTick]);

  // Narrators load — per-library, so narratorLibraryId drives ONLY this fetch.
  useEffect(() => {
    if (segment !== "narrators") return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      setEditingName(null);
      try {
        if (narratorLibraryId) {
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

  // ---- tag/genre item counts -----------------------------------------------
  // Tags/genres are server-wide, but item counts are PER-LIBRARY, so a value's
  // displayed count is the SUM of getLibraryItemFilterCount across every
  // library. Fetched LAZILY and ON DEMAND for the rows the user actually SEES
  // (FlatList viewability), so the fan-out scales with what's scrolled into
  // view rather than the whole vocabulary — a server with hundreds of tags is
  // never stormed up front. A shared queue caps TOTAL in-flight requests at 4;
  // each value is fetched at most once per session (countAttemptedRef); a fetch
  // failure degrades to no subtitle, never a screen-level ErrorState.
  const [counts, setCounts] = useState<Record<string, number>>({});
  const countAttemptedRef = useRef<Set<string>>(new Set());
  const countQueueRef = useRef<{ type: "tags" | "genres"; value: string }[]>([]);
  const countActiveRef = useRef(0);
  const mountedRef = useRef(true);
  // Libraries change rarely; read them off a ref so the stable viewability
  // callback always sees the current set without being re-created.
  const libIdsRef = useRef<string[]>([]);
  useEffect(() => {
    libIdsRef.current = storeLibraries.map((l) => l.id).filter(Boolean);
  }, [storeLibraries]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const pumpRef = useRef<() => void>(() => {});
  pumpRef.current = () => {
    const CONCURRENCY = 4;
    while (countActiveRef.current < CONCURRENCY && countQueueRef.current.length > 0) {
      const { type, value } = countQueueRef.current.shift()!;
      const libIds = libIdsRef.current;
      if (libIds.length === 0) {
        // No libraries to sum over — nothing to show; leave it attempted.
        continue;
      }
      countActiveRef.current += 1;
      (async () => {
        let total = 0;
        let ok = true;
        // Sum sequentially across libraries; a single failure drops the whole
        // value (no understated partial), matching the graceful-degrade rule.
        for (const libId of libIds) {
          try {
            total += await getLibraryItemFilterCount(libId, type, value);
          } catch {
            ok = false;
            break;
          }
        }
        if (ok && mountedRef.current) {
          setCounts((prev) => ({ ...prev, [`${type}:${value}`]: total }));
        }
      })().finally(() => {
        countActiveRef.current -= 1;
        pumpRef.current();
      });
    }
  };

  // Enqueue a single value's count once. Called from FlatList viewability, so
  // only on-screen rows ever trigger a fetch.
  const requestCount = (type: "tags" | "genres", value: string) => {
    const key = `${type}:${value}`;
    if (countAttemptedRef.current.has(key)) return;
    countAttemptedRef.current.add(key);
    countQueueRef.current.push({ type, value });
    pumpRef.current();
  };

  const onValueRowsViewable = useRef(
    ({ viewableItems }: { viewableItems: Array<{ item?: { name?: string } }> }) => {
      const seg = segmentRef.current;
      if (seg === "narrators") return;
      for (const vi of viewableItems) {
        const name = vi.item?.name;
        if (name) requestCount(seg, name);
      }
    }
  ).current;
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 1 }).current;

  const countSubtitle = (type: "tags" | "genres", value: string): string | undefined => {
    const n = counts[`${type}:${value}`];
    if (n === undefined) return undefined;
    return `${n} item${n === 1 ? "" : "s"}`;
  };

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
        {
          text: isMerge ? "Merge" : "Rename",
          // A merge collapses two names across every item with no undo —
          // destructive styling, matching delete.
          ...(isMerge ? { style: "destructive" as const } : {}),
          onPress: () => doRename(oldName, newName),
        },
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
  // Select-sheet idiom (SettingsScreen's SettingSelectModal) rather than a
  // dialog with buttons-as-menu.

  const bookLibraries = storeLibraries.filter((l) => l.mediaType !== "podcast");

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

  // Row models for the FlatList (tags/genres/narrators can run to hundreds of
  // entries on a big server — virtualize instead of ScrollView+map).
  type ValueRow = { name: string; subtitle?: string; canDelete: boolean };
  const rows: ValueRow[] = useMemo(() => {
    if (loading || error) return [];
    if (segment === "tags")
      return tags.map((t) => ({ name: t, subtitle: countSubtitle("tags", t), canDelete: true }));
    if (segment === "genres")
      return genres.map((g) => ({ name: g, subtitle: countSubtitle("genres", g), canDelete: true }));
    if (!narratorLibraryId) return [];
    return narrators.map((n) => ({
      name: n.name,
      subtitle: `${n.numBooks} book${n.numBooks === 1 ? "" : "s"}`,
      // No delete endpoint for narrators — rename-to-merge is the cleanup.
      canDelete: false,
    }));
  }, [loading, error, segment, tags, genres, narrators, narratorLibraryId, counts]);

  const renderListEmpty = () => {
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
      return <EmptyState icon="bookmark" title="No tags" message="Items on this server have no tags yet." />;
    }
    if (segment === "genres") {
      return <EmptyState icon="books" title="No genres" message="Items on this server have no genres yet." />;
    }
    if (!narratorLibraryId) {
      return (
        <EmptyState
          icon="mic"
          title="No library"
          message="Narrator cleanup needs a book library to work in."
        />
      );
    }
    return <EmptyState icon="mic" title="No narrators" message="This library has no narrators yet." />;
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

      <FlatList
        testID="maintenance-list"
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 40 }}
        data={rows}
        keyExtractor={(item) => item.name}
        renderItem={({ item }) => renderValueRow(item.name, item.subtitle, item.canDelete)}
        // Fetch tag/genre item counts only for rows scrolled into view.
        onViewableItemsChanged={onValueRowsViewable}
        viewabilityConfig={viewabilityConfig}
        // Inline rename state lives outside the rows — make sure an edit
        // toggle re-renders the virtualized items.
        extraData={`${editingName ?? ""}:${editValue}`}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <>
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

            {segment === "narrators" && narratorLibraryId && !loading && !error ? (
              <>
                <RowBase
                  icon="library"
                  title="Library"
                  subtitle={narratorLibrary?.name || narratorLibraryId}
                  onPress={() => setLibraryPickerOpen(true)}
                  colors={colors}
                />
                <Divider colors={colors} />
              </>
            ) : null}
          </>
        }
        ListEmptyComponent={renderListEmpty()}
        ListFooterComponent={
          <>
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
          </>
        }
      />

      <SettingSelectModal
        visible={libraryPickerOpen}
        title="Choose a library"
        options={bookLibraries.map((l) => ({ label: l.name, value: l.id }))}
        selected={narratorLibraryId}
        onSelect={(v) => setNarratorLibraryChoice(String(v))}
        onClose={() => setLibraryPickerOpen(false)}
      />
    </SafeAreaView>
  );
}
