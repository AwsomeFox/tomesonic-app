import React, { useEffect, useMemo, useRef, useState } from "react";
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
import { SectionHeader } from "../components/SettingsRows";
import { api } from "../utils/api";
import { AbsError, normalizeAbsError } from "../utils/abs/errors";
import { createLibrary, updateLibrary, deleteLibrary } from "../utils/abs/libraries";
import { showAppDialog } from "../store/useDialogStore";
import { showSnackbar } from "../store/useSnackbarStore";

/**
 * AdminLibraryEditScreen — create or edit a server library.
 *
 * Route: "AdminLibraryEdit"
 * Params: { libraryId?: string } — absent means CREATE mode.
 *
 * Danger-tier policy (per the admin UX plan):
 *  - Removing an EXISTING folder is Tier-3: typed confirm of the folder's last
 *    path segment (items in it leave the library on save; files stay on disk).
 *  - Deleting the library is Tier-3: typed confirm of the library name.
 *  - Dirty removal is Tier-2 (discard confirm) via a beforeRemove listener,
 *    so header back, hardware back, and gestures are all guarded. Saving
 *    itself (header Save, disabled until dirty && valid) needs no confirm.
 */

interface FolderDraft {
  /** Present on folders the server already knows; absent on newly added ones. */
  id?: string;
  fullPath: string;
}

// Map an AbsError kind onto the ErrorState idiom (offline vs forbidden vs
// unsupported vs server all read differently).
function errorStateProps(err: AbsError): { icon: IconName; title: string; message: string } {
  switch (err.kind) {
    case "offline":
      return {
        icon: "cloud-off",
        title: "You're offline",
        message: "Editing a library needs a connection to the server.",
      };
    case "forbidden":
      return { icon: "lock", title: "Admin access required", message: err.message };
    case "unsupported":
      return { icon: "info", title: "Not supported by this server", message: err.message };
    case "server":
      return { icon: "warning", title: "The server hit an error", message: err.message };
    default:
      return { icon: "warning", title: "Couldn't load the library", message: err.message };
  }
}

const BOOK_DEFAULT_PROVIDER = "google";
const PODCAST_DEFAULT_PROVIDER = "itunes";

// Metadata providers ABS ships per media type (superset of EditMetadata's
// match-tab list — the library provider also drives quick-match and cover
// search). A loaded library whose provider isn't listed here (regional
// Audible like "audible.de", custom providers) still renders as an extra
// selected chip so existing configs survive a round-trip untouched.
const BOOK_PROVIDERS: { id: string; label: string }[] = [
  { id: "google", label: "Google Books" },
  { id: "audible", label: "Audible" },
  { id: "itunes", label: "iTunes" },
  { id: "openlibrary", label: "Open Library" },
  { id: "fantlab", label: "FantLab" },
  { id: "audiobookcovers", label: "AudiobookCovers" },
];
const PODCAST_PROVIDERS: { id: string; label: string }[] = [{ id: "itunes", label: "iTunes" }];

/** Last path segment ("/books/audiobooks/" → "audiobooks") for the typed confirm. */
function lastPathSegment(fullPath: string): string {
  const trimmed = (fullPath || "").replace(/[/\\]+$/, "");
  const parts = trimmed.split(/[/\\]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : trimmed;
}

export default function AdminLibraryEditScreen({ navigation, route }: any) {
  const colors = useThemeColors();
  const libraryId: string | undefined = route?.params?.libraryId;
  const isEdit = !!libraryId;

  const [loading, setLoading] = useState(isEdit);
  const [error, setError] = useState<AbsError | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  const [saving, setSaving] = useState(false);

  const [name, setName] = useState("");
  const [mediaType, setMediaType] = useState<"book" | "podcast">("book");
  const [provider, setProvider] = useState(BOOK_DEFAULT_PROVIDER);
  const [folders, setFolders] = useState<FolderDraft[]>([]);

  // Loaded snapshot for the dirty check (create mode compares against the
  // pristine defaults).
  const [original, setOriginal] = useState<{
    name: string;
    provider: string;
    folders: FolderDraft[];
  }>({ name: "", provider: BOOK_DEFAULT_PROVIDER, folders: [] });

  useEffect(() => {
    if (!isEdit) return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await api.get(`/api/libraries/${libraryId}`);
        if (cancelled) return;
        const data = res.data || {};
        // Newer ABS wraps the library in { library }; older returns it flat.
        const lib = data.library || (data.id ? data : null);
        if (!lib || !lib.id) throw new Error("Malformed library response");
        const seededFolders: FolderDraft[] = Array.isArray(lib.folders)
          ? lib.folders
              .filter((f: any) => f && f.fullPath)
              .map((f: any) => ({ id: f.id, fullPath: String(f.fullPath) }))
          : [];
        setName(lib.name || "");
        setMediaType(lib.mediaType === "podcast" ? "podcast" : "book");
        setProvider(lib.provider || BOOK_DEFAULT_PROVIDER);
        setFolders(seededFolders);
        setOriginal({
          name: lib.name || "",
          provider: lib.provider || BOOK_DEFAULT_PROVIDER,
          folders: seededFolders,
        });
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
  }, [isEdit, libraryId, retryTick]);

  const dirty = useMemo(() => {
    if (name.trim() !== original.name.trim()) return true;
    if (provider.trim() !== original.provider.trim()) return true;
    if (folders.length !== original.folders.length) return true;
    return folders.some(
      (f, i) => f.fullPath !== original.folders[i]?.fullPath || f.id !== original.folders[i]?.id
    );
  }, [name, provider, folders, original]);

  // Saveable = something changed AND the form is complete. Create mode is
  // implicitly dirty once valid (any name differs from the pristine "").
  const valid = name.trim().length > 0 && folders.some((f) => f.fullPath.trim().length > 0);
  const canSave = !saving && dirty && valid;

  // Unsaved-changes guard (ChapterEditor pattern): intercept ANY navigation
  // that would remove this screen — header back, hardware back, gestures all
  // flow through beforeRemove. Refs keep the listener stable; `saving` is
  // excluded so the post-save goBack() isn't re-guarded.
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty && !saving;
  useEffect(() => {
    if (!navigation?.addListener) return undefined;
    const unsub = navigation.addListener("beforeRemove", (e: any) => {
      if (!dirtyRef.current) return;
      e.preventDefault();
      showAppDialog({
        title: "Discard changes?",
        message: "Your library edits haven't been saved.",
        buttons: [
          { text: "Keep editing", style: "cancel" },
          {
            text: "Discard",
            style: "destructive",
            onPress: () => navigation.dispatch(e.data.action),
          },
        ],
      });
    });
    return unsub;
  }, [navigation]);

  const setMediaTypeChecked = (type: "book" | "podcast") => {
    setMediaType(type);
    // Follow the media type with its default provider unless the admin
    // already typed a custom one.
    setProvider((prev) =>
      prev === BOOK_DEFAULT_PROVIDER || prev === PODCAST_DEFAULT_PROVIDER
        ? type === "podcast"
          ? PODCAST_DEFAULT_PROVIDER
          : BOOK_DEFAULT_PROVIDER
        : prev
    );
  };

  const removeFolderAt = (index: number) => {
    setFolders((prev) => prev.filter((_, i) => i !== index));
  };

  const confirmRemoveFolder = (index: number) => {
    const folder = folders[index];
    if (!folder) return;
    if (!folder.id) {
      // A just-added draft row — nothing exists server-side yet.
      removeFolderAt(index);
      return;
    }
    const segment = lastPathSegment(folder.fullPath);
    showAppDialog({
      title: "Remove folder",
      message: `Items in "${folder.fullPath}" will be removed from this library when you save. Files on disk are NOT deleted. Type the folder's last path segment to confirm.`,
      confirmInput: {
        placeholder: segment,
        requiredText: segment,
      },
      buttons: [
        { text: "Cancel", style: "cancel" },
        { text: "Remove", style: "destructive", onPress: () => removeFolderAt(index) },
      ],
    });
  };

  const doSave = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      showAppDialog({ title: "Missing name", message: "Give the library a name before saving." });
      return;
    }
    const cleanFolders = folders
      .map((f) => ({ ...f, fullPath: f.fullPath.trim() }))
      .filter((f) => f.fullPath.length > 0);
    if (cleanFolders.length === 0) {
      showAppDialog({
        title: "Missing folder",
        message: "A library needs at least one folder path on the server.",
      });
      return;
    }
    setSaving(true);
    try {
      if (isEdit) {
        await updateLibrary(libraryId!, {
          name: trimmedName,
          provider: provider.trim(),
          folders: cleanFolders.map((f) => (f.id ? { id: f.id, fullPath: f.fullPath } : { fullPath: f.fullPath })),
        });
        showSnackbar({ message: "Library saved" });
      } else {
        await createLibrary({
          name: trimmedName,
          mediaType,
          provider: provider.trim(),
          folders: cleanFolders.map((f) => ({ fullPath: f.fullPath })),
        });
        showSnackbar({ message: "Library created" });
      }
      navigation.goBack();
    } catch (e) {
      const err = normalizeAbsError(e);
      showAppDialog({
        title: isEdit ? "Couldn't save the library" : "Couldn't create the library",
        message: err.message,
      });
    } finally {
      setSaving(false);
    }
  };

  const doDelete = async () => {
    try {
      await deleteLibrary(libraryId!);
      showSnackbar({ message: "Library deleted" });
      // The library is gone — any pending edits are moot, so bypass the
      // dirty guard for this programmatic pop.
      dirtyRef.current = false;
      navigation.goBack();
    } catch (e) {
      const err = normalizeAbsError(e);
      showAppDialog({ title: "Couldn't delete the library", message: err.message });
    }
  };

  const confirmDelete = () => {
    showAppDialog({
      title: "Delete library",
      message: `This removes "${original.name}" with all of its items, progress, and collections from the server. Files on disk are NOT deleted. Type the library name to confirm.`,
      confirmInput: {
        placeholder: original.name,
        requiredText: original.name,
      },
      buttons: [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: doDelete },
      ],
    });
  };

  // Borderless Field skin (AdminUserDetail/EditMetadata idiom): label +
  // optional helper over a surfaceContainer-filled, borderless input.
  const textField = (
    label: string,
    value: string,
    onChangeText: (t: string) => void,
    accessibilityLabel: string,
    helper?: string,
    autoCapitalize: "none" | "words" = "none"
  ) => (
    <View style={{ paddingHorizontal: 16, paddingVertical: 10 }}>
      <Text style={{ color: colors.onSurface, fontSize: 15, fontWeight: "600" }}>{label}</Text>
      {helper ? (
        <Text style={{ color: colors.onSurfaceVariant, fontSize: 12, marginTop: 2, marginBottom: 8 }}>
          {helper}
        </Text>
      ) : (
        <View style={{ height: 8 }} />
      )}
      <TextInput
        value={value}
        onChangeText={onChangeText}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        accessibilityLabel={accessibilityLabel}
        placeholderTextColor={colors.onSurfaceVariant}
        style={{
          backgroundColor: colors.surfaceContainer,
          color: colors.onSurface,
          borderRadius: 12,
          paddingHorizontal: 14,
          paddingVertical: 10,
          fontSize: 15,
        }}
      />
    </View>
  );

  // Provider options for the current media type, plus the loaded value as an
  // extra chip when the server config uses one we don't list.
  const providerOptions = useMemo(() => {
    const base = mediaType === "podcast" ? PODCAST_PROVIDERS : BOOK_PROVIDERS;
    if (!provider || base.some((p) => p.id === provider)) return base;
    return [...base, { id: provider, label: provider }];
  }, [mediaType, provider]);

  const mediaTypeChip = (type: "book" | "podcast", label: string) => {
    const selected = mediaType === type;
    return (
      <Pressable
        key={type}
        onPress={() => setMediaTypeChecked(type)}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        accessibilityLabel={`Media type: ${label}`}
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
          {isEdit ? "Edit library" : "New library"}
        </Text>
        {isEdit && !loading && !error ? (
          <Pressable
            onPress={confirmDelete}
            style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" }}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Delete library"
          >
            <Icon name="trash" size={22} color={colors.error} />
          </Pressable>
        ) : null}
        {!loading && !error ? (
          // Header Save text button (EditMetadata/ChapterEditor idiom) —
          // disabled until the form is dirty AND valid.
          <Pressable
            onPress={doSave}
            disabled={!canSave}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={isEdit ? "Save library" : "Create library"}
            accessibilityState={{ disabled: !canSave, busy: saving }}
            style={{ paddingHorizontal: 8, paddingVertical: 6, opacity: !canSave ? 0.4 : 1 }}
          >
            {saving ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : (
              <Text style={{ color: colors.primary, fontSize: 16, fontWeight: "700" }}>
                {isEdit ? "Save" : "Create"}
              </Text>
            )}
          </Pressable>
        ) : null}
      </View>

      {loading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : error ? (
        <ErrorState
          style={{ flex: 1 }}
          {...errorStateProps(error)}
          onRetry={() => setRetryTick((t) => t + 1)}
        />
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 40 }}>
          <SectionHeader label="Library" colors={colors} />
          {textField("Name", name, setName, "Library name", undefined, "words")}

          {/* Media type: pickable on create, immutable after (server constraint). */}
          <View style={{ paddingHorizontal: 16, paddingVertical: 10 }}>
            <Text style={{ color: colors.onSurface, fontSize: 15, fontWeight: "600", marginBottom: 8 }}>
              Media type
            </Text>
            {isEdit ? (
              <Text style={{ color: colors.onSurfaceVariant, fontSize: 14 }}>
                {mediaType === "podcast" ? "Podcasts" : "Books"} (can't be changed after creation)
              </Text>
            ) : (
              <View style={{ flexDirection: "row" }}>
                {mediaTypeChip("book", "Books")}
                {mediaTypeChip("podcast", "Podcasts")}
              </View>
            )}
          </View>

          {/* Provider chip row — same idiom as EditMetadata's match tab. */}
          <View style={{ paddingVertical: 10 }}>
            <Text
              style={{
                color: colors.onSurface,
                fontSize: 15,
                fontWeight: "600",
                paddingHorizontal: 16,
              }}
            >
              Metadata provider
            </Text>
            <Text
              style={{
                color: colors.onSurfaceVariant,
                fontSize: 12,
                marginTop: 2,
                paddingHorizontal: 16,
              }}
            >
              Provider used for quick match and cover search.
            </Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 10, alignItems: "center" }}
            >
              {providerOptions.map((p) => {
                const active = provider === p.id;
                return (
                  <Pressable
                    key={p.id}
                    onPress={() => setProvider(p.id)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    accessibilityLabel={`Provider: ${p.label}`}
                    hitSlop={{ top: 6, bottom: 6 }}
                    style={{
                      paddingHorizontal: 14,
                      height: 34,
                      borderRadius: 17,
                      alignItems: "center",
                      justifyContent: "center",
                      marginRight: 8,
                      backgroundColor: active ? colors.secondaryContainer : "transparent",
                      borderWidth: 1,
                      borderColor: active ? colors.secondaryContainer : colors.outlineVariant,
                    }}
                  >
                    <Text
                      style={{
                        color: active ? colors.onSecondaryContainer : colors.onSurfaceVariant,
                        fontSize: 13,
                        fontWeight: "600",
                      }}
                    >
                      {p.label}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>

          <SectionHeader label="Folders" colors={colors} />
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              marginHorizontal: 16,
              marginBottom: 6,
              padding: 12,
              borderRadius: 12,
              backgroundColor: colors.tertiaryContainer,
            }}
          >
            <Icon name="warning" size={18} color={colors.onTertiaryContainer} style={{ marginRight: 10 }} />
            <Text style={{ color: colors.onTertiaryContainer, fontSize: 13, flex: 1 }}>
              The app can't browse the server's disk — type the exact absolute path as the server
              sees it. A wrong path scans nothing.
            </Text>
          </View>

          {folders.map((folder, index) => (
            <View
              key={folder.id ?? `new-${index}`}
              style={{
                flexDirection: "row",
                alignItems: "center",
                paddingHorizontal: 16,
                paddingVertical: 6,
              }}
            >
              {folder.id ? (
                <Text
                  style={{
                    flex: 1,
                    color: colors.onSurface,
                    fontSize: 14,
                    backgroundColor: colors.surfaceContainer,
                    borderRadius: 12,
                    paddingHorizontal: 14,
                    paddingVertical: 12,
                  }}
                  numberOfLines={1}
                >
                  {folder.fullPath}
                </Text>
              ) : (
                <TextInput
                  value={folder.fullPath}
                  onChangeText={(t) =>
                    setFolders((prev) => prev.map((f, i) => (i === index ? { ...f, fullPath: t } : f)))
                  }
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder="/path/on/the/server"
                  placeholderTextColor={colors.onSurfaceVariant}
                  accessibilityLabel={`Folder path ${index + 1}`}
                  style={{
                    flex: 1,
                    backgroundColor: colors.surfaceContainer,
                    color: colors.onSurface,
                    borderRadius: 12,
                    paddingHorizontal: 14,
                    paddingVertical: 10,
                    fontSize: 14,
                  }}
                />
              )}
              <Pressable
                onPress={() => confirmRemoveFolder(index)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={`Remove folder ${folder.fullPath || index + 1}`}
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 20,
                  alignItems: "center",
                  justifyContent: "center",
                  marginLeft: 6,
                }}
              >
                <Icon name="close" size={22} color={colors.onSurfaceVariant} />
              </Pressable>
            </View>
          ))}

          <Pressable
            onPress={() => setFolders((prev) => [...prev, { fullPath: "" }])}
            accessibilityRole="button"
            accessibilityLabel="Add folder"
            android_ripple={{ color: withAlpha(colors.onSurfaceVariant, 0.12) }}
            style={{
              flexDirection: "row",
              alignItems: "center",
              paddingHorizontal: 16,
              paddingVertical: 12,
            }}
          >
            <Icon name="add" size={22} color={colors.primary} style={{ marginRight: 10 }} />
            <Text style={{ color: colors.primary, fontSize: 15, fontWeight: "600" }}>Add folder</Text>
          </Pressable>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}
