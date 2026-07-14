import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  ScrollView,
  ActivityIndicator,
  Pressable,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as DocumentPicker from "expo-document-picker";
import { useThemeColors } from "../theme/useThemeColors";
import { withAlpha } from "../theme/palette";
import Icon from "../components/Icon";
import ErrorState from "../components/ErrorState";
import EmptyState from "../components/EmptyState";
import { SectionHeader, SelectRow } from "../components/SettingsRows";
import SettingSelectModal from "../components/SettingSelectModal";
import { api } from "../utils/api";
import { AbsError, normalizeAbsError } from "../utils/abs/errors";
import { refreshCapabilities, useServerCapabilities } from "../utils/abs/capabilities";
import { uploadMediaFiles, type MediaUploadHandle } from "../utils/mediaUploader";
import { formatSize } from "../utils/format";
import { showAppDialog } from "../store/useDialogStore";

/**
 * UploadMediaScreen — upload media files from the device into a server library
 * folder (issue #57 P2).
 *
 * Route: "UploadMedia"  Params: { libraryId?: string; sharedFiles?: PickedFile[] }
 *
 * A DELIBERATE FORK of PodcastFeedPreviewScreen's destination idiom (fresh GET
 * /api/libraries via allSettled with an independent, non-fatal librariesError;
 * SelectRow + SettingSelectModal library/folder pickers; a read-only
 * destination hint). The gate differs: uploading is a GRANTABLE non-admin
 * permission, so this screen gates on caps.canUpload (NOT isAdmin) behind the
 * mount-time refreshCapabilities() spinner (a cold-restored thin user has no
 * permissions until authorize hydrates them).
 *
 * The heavy multipart streaming (progress/cancel) lives in
 * utils/mediaUploader.uploadMediaFiles — this screen only assembles its params,
 * tracks the returned handle for Cancel, and drives a progress bar off
 * onProgress. Navigator registration is owned by the parent. (No auto-match:
 * POST /api/upload doesn't return a created-item id — the scan produces it
 * asynchronously — so there's nothing to match against at upload time.)
 */

interface PickedFile {
  uri: string;
  name: string;
  mimeType?: string;
  size?: number;
}

/** Strip a trailing file extension for the metadata-title prefill. */
function stripExtension(name: string): string {
  return String(name || "").replace(/\.[^/.]+$/, "");
}

/** Normalize an incoming asset list into PickedFile[], dropping anything without a uri. */
function toPickedFiles(raw: any): PickedFile[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((a) => a && typeof a === "object" && a.uri && a.name)
    .map((a) => ({ uri: a.uri, name: a.name, mimeType: a.mimeType, size: a.size }));
}

export default function UploadMediaScreen({ navigation, route }: any) {
  const colors = useThemeColors();
  const caps = useServerCapabilities();
  const params = route?.params || {};

  // Permission gate (ServerAdminHub pattern): a cold-restored thin user has no
  // permissions, so hold a spinner until the mount-time authorize probe settles,
  // then gate on the GRANTABLE upload permission (not admin).
  const [refreshDone, setRefreshDone] = useState(false);
  useEffect(() => {
    let mounted = true;
    refreshCapabilities().finally(() => {
      if (mounted) setRefreshDone(true);
    });
    return () => {
      mounted = false;
    };
  }, []);

  // Chosen files (sharedFiles seeds the initial list; dedupe by uri).
  const initialFiles = useMemo(() => {
    const seed = toPickedFiles(params.sharedFiles);
    const seen = new Set<string>();
    return seed.filter((f) => (seen.has(f.uri) ? false : (seen.add(f.uri), true)));
    // Seeded once from the route param — subsequent picks go through addFiles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [files, setFiles] = useState<PickedFile[]>(initialFiles);

  // Destination libraries (fresh, allSettled — the feed-preview idiom; a load
  // failure is NON-FATAL: file-picking still works, the section shows its own
  // inline retry).
  const [libraries, setLibraries] = useState<any[]>([]);
  const [librariesError, setLibrariesError] = useState(false);
  const [retryTick, setRetryTick] = useState(0);
  const [selectedLibraryId, setSelectedLibraryId] = useState<string | undefined>(
    params.libraryId
  );
  const [selectedFolderId, setSelectedFolderId] = useState<string | undefined>(undefined);
  const [libraryPickerOpen, setLibraryPickerOpen] = useState(false);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);

  // Metadata.
  const [title, setTitle] = useState<string>(
    initialFiles.length ? stripExtension(initialFiles[0].name) : ""
  );
  const [author, setAuthor] = useState("");
  const [series, setSeries] = useState("");

  // Upload lifecycle.
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0); // 0..1
  // Synchronous re-entrancy guard (a double-tap on the confirm dialog can fire
  // before setBusy(true) has flushed).
  const busyRef = useRef(false);
  const handleRef = useRef<MediaUploadHandle | null>(null);
  // Set when the user taps Cancel so the promise rejection isn't surfaced as a
  // failure dialog (cancel already tore everything down).
  const cancelledRef = useRef(false);
  // Stable per-mount id for the upload notification.
  const notifyIdRef = useRef(`upload-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  // Post-await UI (the completion/failure dialog + goBack) only fires while
  // mounted — an upload that outlives the screen keeps going in the background
  // and reports via its notification, but must not pop a dialog over whatever
  // screen replaced this one.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!caps.canUpload) return;
    let cancelled = false;
    (async () => {
      setLibrariesError(false);
      const [libsRes] = await Promise.allSettled([api.get("/api/libraries")]);
      if (cancelled) return;
      if (libsRes.status === "fulfilled") {
        const raw = libsRes.value.data?.libraries || libsRes.value.data || [];
        setLibraries(
          Array.isArray(raw) ? raw.filter((l: any) => l && typeof l === "object" && l.id) : []
        );
      } else {
        setLibrariesError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [caps.canUpload, retryTick]);

  // Media can only be uploaded to book-type libraries.
  const bookLibraries = useMemo(
    () => libraries.filter((l: any) => l.mediaType === "book"),
    [libraries]
  );

  // Preselect: keep params.libraryId when it's a real book library, else first.
  useEffect(() => {
    if (!bookLibraries.length) return;
    setSelectedLibraryId((cur) =>
      cur && bookLibraries.some((l: any) => l.id === cur) ? cur : bookLibraries[0].id
    );
  }, [bookLibraries]);

  const selectedLibrary = bookLibraries.find((l: any) => l.id === selectedLibraryId);
  const folders: any[] = Array.isArray(selectedLibrary?.folders)
    ? selectedLibrary.folders.filter((f: any) => f && f.id && f.fullPath)
    : [];

  // Folder follows the library: auto-select a lone folder; clear a selection
  // that no longer belongs to the chosen library.
  useEffect(() => {
    setSelectedFolderId((cur) => {
      if (cur && folders.some((f) => f.id === cur)) return cur;
      return folders.length === 1 ? folders[0].id : undefined;
    });
    // folders is derived from these two:
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLibraryId, libraries]);

  const selectedFolder = folders.find((f) => f.id === selectedFolderId);

  const addFiles = (assets: PickedFile[]) => {
    setFiles((prev) => {
      const seen = new Set(prev.map((f) => f.uri));
      const next = [...prev];
      for (const a of assets) {
        if (!seen.has(a.uri)) {
          seen.add(a.uri);
          next.push(a);
        }
      }
      // Prefill the metadata title from the first file the FIRST time any are
      // added and the field is still empty — user-editable thereafter.
      if (!prev.length && next.length) {
        setTitle((t) => (t.trim() ? t : stripExtension(next[0].name)));
      }
      return next;
    });
  };

  const pickFiles = async () => {
    const res = await DocumentPicker.getDocumentAsync({
      multiple: true,
      // Stream from the original content:// URI — copying a multi-hundred-MB
      // audiobook into the app cache would double disk use and defeat the whole
      // streaming design.
      copyToCacheDirectory: false,
      type: ["audio/*", "application/epub+zip", "application/octet-stream"],
    });
    // SDK-57 result shape: { canceled, assets: [...] | null }.
    if (!res || res.canceled || !res.assets) return;
    addFiles(toPickedFiles(res.assets));
  };

  const removeFile = (uri: string) => {
    setFiles((prev) => prev.filter((f) => f.uri !== uri));
  };

  const canSubmit = files.length > 0 && !!selectedLibrary && !!selectedFolder && !busy;

  const doUpload = async () => {
    if (busyRef.current || !selectedLibrary || !selectedFolder || !files.length) return;
    busyRef.current = true;
    cancelledRef.current = false;
    setBusy(true);
    setUploading(true);
    setProgress(0);
    try {
      const trimmedTitle = title.trim();
      const handle = uploadMediaFiles(
        {
          libraryId: selectedLibrary.id,
          folderId: selectedFolder.id,
          ...(trimmedTitle ? { title: trimmedTitle } : {}),
          ...(author.trim() ? { author: author.trim() } : {}),
          ...(series.trim() ? { series: series.trim() } : {}),
          files: files.map((a) => ({ uri: a.uri, name: a.name, type: a.mimeType })),
        },
        {
          onProgress: (sent: number, total: number) => setProgress(total ? sent / total : 0),
          notifyId: notifyIdRef.current,
          notifyTitle: trimmedTitle || "Uploading media",
        }
      );
      handleRef.current = handle;
      await handle.promise;

      // The upload continues in the background if the user navigated away (the
      // notification reports completion); only touch in-app UI while mounted, so
      // no stray dialog/goBack fires over another screen.
      if (!mountedRef.current) return;
      showAppDialog({
        title: "Upload complete",
        message: `${files.length} file${files.length === 1 ? "" : "s"} uploaded to ${
          selectedLibrary.name
        }. The server is scanning them now.`,
        buttons: [{ text: "Done", onPress: () => navigation.goBack() }],
      });
    } catch (e) {
      // A user-initiated cancel rejects the promise too, but that's not a
      // failure — the Cancel button already tore everything down silently.
      if (!mountedRef.current || cancelledRef.current) return;
      const message =
        e instanceof AbsError
          ? normalizeAbsError(e).message
          : (e as any)?.message || "The upload didn't finish.";
      showAppDialog({ title: "Upload failed", message });
    } finally {
      busyRef.current = false;
      handleRef.current = null;
      // Only touch state while mounted — an upload can settle after the screen
      // is gone (it runs on in the background), same guard as the dialogs above.
      if (mountedRef.current) {
        setBusy(false);
        setUploading(false);
        setProgress(0);
      }
    }
  };

  const handleUploadPress = () => {
    if (!canSubmit || !selectedLibrary || !selectedFolder) return;
    showAppDialog({
      title: "Upload media",
      message: `Upload ${files.length} file${files.length === 1 ? "" : "s"} to ${
        selectedLibrary.name
      }?`,
      buttons: [
        { text: "Cancel", style: "cancel" },
        { text: "Upload", onPress: doUpload },
      ],
    });
  };

  const cancelUpload = () => {
    cancelledRef.current = true;
    handleRef.current?.cancel();
  };

  const uploadLabel = `Upload ${files.length} file${files.length === 1 ? "" : "s"}`;
  const pct = Math.round(progress * 100);

  let body: React.ReactNode;
  if (caps.canUpload) {
    body = (
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 48 }}
        keyboardShouldPersistTaps="handled"
      >
        {/* Files */}
        <SectionHeader label="Files" colors={colors} />
        <View style={{ paddingHorizontal: 16 }}>
          <Pressable
            testID="choose-files"
            onPress={uploading ? undefined : pickFiles}
            disabled={uploading}
            accessibilityRole="button"
            accessibilityLabel="Choose files"
            accessibilityState={{ disabled: uploading }}
            android_ripple={{ color: withAlpha(colors.onSecondaryContainer, 0.14) }}
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              height: 44,
              borderRadius: 22,
              overflow: "hidden",
              backgroundColor: colors.secondaryContainer,
              opacity: uploading ? 0.5 : 1,
            }}
          >
            <Icon name="add" size={20} color={colors.onSecondaryContainer} />
            <Text
              style={{
                color: colors.onSecondaryContainer,
                fontSize: 15,
                fontWeight: "600",
                marginLeft: 6,
              }}
            >
              Choose files
            </Text>
          </Pressable>
        </View>

        {files.length === 0 ? (
          <EmptyState
            icon="folder"
            title="No files chosen"
            message="Pick audio files (or an EPUB) from your device to upload to the server."
          />
        ) : (
          files.map((f, i) => (
            <View
              key={f.uri}
              testID={`file-row-${i}`}
              accessible
              accessibilityLabel={`File: ${f.name}${
                f.size ? `, ${formatSize(f.size)}` : ""
              }`}
              style={{
                flexDirection: "row",
                alignItems: "center",
                paddingHorizontal: 16,
                paddingVertical: 12,
                borderBottomWidth: 1,
                borderBottomColor: colors.outlineVariant,
              }}
            >
              <Icon name="book" size={22} color={colors.onSurfaceVariant} />
              <View style={{ flex: 1, marginLeft: 12, marginRight: 12 }}>
                <Text numberOfLines={1} style={{ color: colors.onSurface, fontSize: 15 }}>
                  {f.name}
                </Text>
                {f.size ? (
                  <Text style={{ color: colors.onSurfaceVariant, fontSize: 13, marginTop: 2 }}>
                    {formatSize(f.size)}
                  </Text>
                ) : null}
              </View>
              <Pressable
                testID={`file-remove-${i}`}
                onPress={() => removeFile(f.uri)}
                disabled={uploading}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={`Remove ${f.name}`}
                accessibilityState={{ disabled: uploading }}
                style={{ padding: 4, opacity: uploading ? 0.5 : 1 }}
              >
                <Icon name="close" size={22} color={colors.onSurfaceVariant} />
              </Pressable>
            </View>
          ))
        )}

        {/* Destination */}
        <SectionHeader label="Destination" colors={colors} />
        {librariesError ? (
          <Pressable
            onPress={() => setRetryTick((t) => t + 1)}
            accessibilityRole="button"
            accessibilityLabel="Couldn't load libraries. Tap to retry."
            style={{ paddingHorizontal: 16, paddingVertical: 10 }}
          >
            <Text style={{ color: colors.error, fontSize: 13 }}>
              Couldn't load your libraries. Tap to retry.
            </Text>
          </Pressable>
        ) : null}
        {/* Destination is frozen during an upload — changing it wouldn't affect
            the in-flight request, only mislead about where files are going. */}
        <View style={{ opacity: uploading ? 0.5 : 1 }}>
          <SelectRow
            icon="library"
            title="Library"
            subtitle={selectedLibrary?.name || "Choose a library"}
            onPress={uploading ? undefined : () => setLibraryPickerOpen(true)}
            colors={colors}
          />
          <SelectRow
            icon="folder"
            title="Folder"
            subtitle={selectedFolder?.fullPath || "Choose a folder"}
            onPress={uploading ? undefined : () => setFolderPickerOpen(true)}
            colors={colors}
          />
        </View>
        <View style={{ paddingHorizontal: 16, paddingVertical: 6 }}>
          <Text style={{ color: colors.onSurfaceVariant, fontSize: 12 }}>
            {selectedFolder
              ? `Files will be placed under: ${selectedFolder.fullPath}`
              : "Choose a folder for the upload destination."}
          </Text>
        </View>

        {/* Metadata */}
        <SectionHeader label="Details (optional)" colors={colors} />
        <View style={{ paddingHorizontal: 16 }}>
          <MetaInput
            label="Title"
            value={title}
            onChangeText={setTitle}
            colors={colors}
            testID="meta-title"
          />
          <MetaInput
            label="Author"
            value={author}
            onChangeText={setAuthor}
            colors={colors}
            testID="meta-author"
          />
          <MetaInput
            label="Series"
            value={series}
            onChangeText={setSeries}
            colors={colors}
            testID="meta-series"
          />
        </View>

        {/* Upload action / progress */}
        {uploading ? (
          <View
            testID="upload-progress"
            style={{ paddingHorizontal: 16, marginTop: 20 }}
            // progressbar role + value announce advancement on iOS VoiceOver
            // (accessibilityLiveRegion below is Android-only).
            accessible
            accessibilityRole="progressbar"
            accessibilityValue={{ min: 0, max: 100, now: pct }}
            accessibilityLabel="Upload progress"
          >
            <Text
              accessibilityLiveRegion="polite"
              accessibilityLabel={`Uploading, ${pct} percent complete`}
              style={{ color: colors.onSurface, fontSize: 14, fontWeight: "600" }}
            >
              Uploading… {pct}%
            </Text>
            <View
              style={{
                height: 6,
                borderRadius: 3,
                backgroundColor: colors.surfaceContainerHighest,
                overflow: "hidden",
                marginTop: 8,
              }}
            >
              <View
                testID="upload-progress-fill"
                style={{ height: 6, width: `${pct}%`, backgroundColor: colors.primary }}
              />
            </View>
            <Pressable
              testID="upload-cancel"
              onPress={cancelUpload}
              accessibilityRole="button"
              accessibilityLabel="Cancel upload"
              android_ripple={{ color: withAlpha(colors.onSurfaceVariant, 0.12) }}
              style={{
                marginTop: 14,
                height: 44,
                borderRadius: 22,
                overflow: "hidden",
                alignItems: "center",
                justifyContent: "center",
                borderWidth: 1,
                borderColor: colors.outline,
              }}
            >
              <Text style={{ color: colors.onSurface, fontSize: 15, fontWeight: "600" }}>
                Cancel
              </Text>
            </Pressable>
          </View>
        ) : (
          <Pressable
            testID="upload-submit"
            onPress={handleUploadPress}
            disabled={!canSubmit}
            accessibilityRole="button"
            accessibilityLabel={uploadLabel}
            accessibilityState={{ disabled: !canSubmit, busy }}
            android_ripple={{ color: withAlpha(colors.onPrimary, 0.16) }}
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              marginHorizontal: 16,
              marginTop: 20,
              height: 48,
              borderRadius: 24,
              overflow: "hidden",
              backgroundColor: colors.primary,
              opacity: canSubmit ? 1 : 0.5,
            }}
          >
            <Text style={{ color: colors.onPrimary, fontSize: 15, fontWeight: "700" }}>
              {uploadLabel}
            </Text>
          </Pressable>
        )}
      </ScrollView>
    );
  } else if (!refreshDone) {
    body = (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator testID="upload-spinner" size="large" color={colors.primary} />
      </View>
    );
  } else {
    body = (
      <ErrorState
        icon="lock"
        title="Upload not allowed"
        message="You don't have permission to upload media to this server."
        style={{ flex: 1 }}
      />
    );
  }

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: colors.surface }}
      edges={["top", "left", "right"]}
    >
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
          style={{
            width: 40,
            height: 40,
            borderRadius: 20,
            alignItems: "center",
            justifyContent: "center",
            marginRight: 4,
          }}
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
          Upload media
        </Text>
      </View>

      {body}

      <SettingSelectModal
        visible={libraryPickerOpen}
        title="Library"
        options={bookLibraries.map((l: any) => ({ label: l.name || l.id, value: l.id }))}
        selected={selectedLibraryId}
        onSelect={(v) => setSelectedLibraryId(v)}
        onClose={() => setLibraryPickerOpen(false)}
      />
      <SettingSelectModal
        visible={folderPickerOpen}
        title="Folder"
        options={folders.map((f: any) => ({ label: f.fullPath, value: f.id }))}
        selected={selectedFolderId}
        onSelect={(v) => setSelectedFolderId(v)}
        onClose={() => setFolderPickerOpen(false)}
      />
    </SafeAreaView>
  );
}

/** Labeled single-line text input for the optional metadata fields. */
function MetaInput({
  label,
  value,
  onChangeText,
  colors,
  testID,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  colors: any;
  testID?: string;
}) {
  return (
    <View style={{ marginBottom: 12 }}>
      <Text
        style={{
          color: colors.onSurfaceVariant,
          fontSize: 12,
          fontWeight: "600",
          marginBottom: 4,
        }}
      >
        {label}
      </Text>
      <TextInput
        testID={testID}
        value={value}
        onChangeText={onChangeText}
        accessibilityLabel={label}
        placeholder={label}
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
}
