import React, { useEffect, useMemo, useRef, useState } from "react";
import { View, Text, TextInput, ScrollView, ActivityIndicator } from "react-native";
import * as Clipboard from "expo-clipboard";
import BottomSheet from "./BottomSheet";
import Pressable from "./HintPressable";
import Icon from "./Icon";
import { SelectRow, ToggleRow } from "./SettingsRows";
import SettingSelectModal from "./SettingSelectModal";
import { useThemeColors } from "../theme/useThemeColors";
import { withAlpha } from "../theme/palette";
import { api } from "../utils/api";
import { normalizeAbsError } from "../utils/abs/errors";
import { parseOpml, createPodcastsFromOpml } from "../utils/abs/podcasts";
import type { AbsOpmlFeed } from "../utils/abs/types";
import { showAppDialog } from "../store/useDialogStore";
import { showSnackbar } from "../store/useSnackbarStore";

/**
 * OpmlImportSheet — bulk-add podcasts from an OPML export (issue #56 P2).
 *
 * Host pattern: { visible, libraryId?, onClose } — mounted once by
 * PodcastAddSearchScreen, seeded with its selected podcast library.
 *
 * Flow: paste OPML text (or read it from the clipboard) → server-side parse
 * (POST /api/podcasts/opml/parse) → per-feed checkbox rows (AdminSessions
 * selection idiom, all selected by default) → destination library + folder →
 * optional auto-download → confirm → POST /api/podcasts/opml/create. The
 * create runs as a server-side background job, so success is a "started"
 * snackbar and the sheet closes.
 */

export default function OpmlImportSheet({
  visible,
  libraryId,
  onClose,
}: {
  visible: boolean;
  /** Preselected destination library (must be a podcast library to stick). */
  libraryId?: string;
  onClose: () => void;
}) {
  const colors = useThemeColors();

  const [text, setText] = useState("");
  const [parsing, setParsing] = useState(false);
  // null = not parsed yet; [] = parsed but empty (inline message).
  const [feeds, setFeeds] = useState<AbsOpmlFeed[] | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const [libraries, setLibraries] = useState<any[]>([]);
  const [selectedLibraryId, setSelectedLibraryId] = useState<string | undefined>(libraryId);
  const [selectedFolderId, setSelectedFolderId] = useState<string | undefined>(undefined);
  const [libraryPickerOpen, setLibraryPickerOpen] = useState(false);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);

  const [autoDownload, setAutoDownload] = useState(false);
  const [importing, setImporting] = useState(false);
  // Synchronous re-entrancy guard (OpenFeedSheet idiom).
  const importingRef = useRef(false);

  // Adopt the host's library selection each time the sheet opens.
  useEffect(() => {
    if (visible && libraryId) setSelectedLibraryId(libraryId);
  }, [visible, libraryId]);

  // Clear the transient parse state whenever the sheet closes. The host mounts
  // this sheet ONCE and toggles `visible`, so without this a reopen after a
  // successful import still shows the previous OPML with every feed checked — a
  // second confirm would re-add the same shows. (Library/folder/auto-download
  // selections intentionally persist across opens.)
  useEffect(() => {
    if (!visible) {
      setText("");
      setFeeds(null);
      setSelected(new Set());
    }
  }, [visible]);

  // Fetch libraries lazily on first open (fresh GET — AdminLibraries idiom).
  const fetchedRef = useRef(false);
  useEffect(() => {
    if (!visible || fetchedRef.current) return;
    fetchedRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get("/api/libraries");
        if (cancelled) return;
        const raw = res.data?.libraries || res.data || [];
        setLibraries(
          Array.isArray(raw) ? raw.filter((l: any) => l && typeof l === "object" && l.id) : []
        );
      } catch {
        // Non-fatal here: the import button stays disabled without a library,
        // and reopening the sheet after reconnecting retries.
        fetchedRef.current = false;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible]);

  const podcastLibraries = useMemo(
    () => libraries.filter((l: any) => l.mediaType === "podcast"),
    [libraries]
  );

  useEffect(() => {
    if (!podcastLibraries.length) return;
    setSelectedLibraryId((cur) =>
      cur && podcastLibraries.some((l: any) => l.id === cur) ? cur : podcastLibraries[0].id
    );
  }, [podcastLibraries]);

  const selectedLibrary = podcastLibraries.find((l: any) => l.id === selectedLibraryId);
  const folders: any[] = Array.isArray(selectedLibrary?.folders)
    ? selectedLibrary.folders.filter((f: any) => f && f.id && f.fullPath)
    : [];

  // Folder follows the library (auto-select a lone folder).
  useEffect(() => {
    setSelectedFolderId((cur) => {
      if (cur && folders.some((f) => f.id === cur)) return cur;
      return folders.length === 1 ? folders[0].id : undefined;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLibraryId, libraries]);

  const selectedFolder = folders.find((f) => f.id === selectedFolderId);

  const handlePaste = async () => {
    try {
      const clip = await Clipboard.getStringAsync();
      if (clip) setText(clip);
    } catch {
      // Clipboard read denied/failed — the paste-area stays manual.
    }
  };

  const handleParse = async () => {
    const opmlText = text.trim();
    if (!opmlText || parsing) return;
    setParsing(true);
    try {
      const parsed = await parseOpml(opmlText);
      setFeeds(parsed);
      // Default: everything selected (deselect is the exception).
      setSelected(new Set(parsed.map((_, i) => i)));
    } catch (e) {
      showAppDialog({ title: "Couldn't parse the OPML", message: normalizeAbsError(e).message });
    } finally {
      setParsing(false);
    }
  };

  const toggleFeed = (index: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const selectedFeeds = feeds ? feeds.filter((_, i) => selected.has(i)) : [];
  const canImport =
    selectedFeeds.length > 0 && !!selectedLibrary && !!selectedFolder && !importing;

  const doImport = async () => {
    if (importingRef.current || !selectedLibrary || !selectedFolder) return;
    importingRef.current = true;
    setImporting(true);
    try {
      await createPodcastsFromOpml({
        feeds: selectedFeeds,
        libraryId: selectedLibrary.id,
        folderId: selectedFolder.id,
        autoDownloadEpisodes: autoDownload,
      });
      showSnackbar({ message: "Import started on the server" });
      onClose();
    } catch (e) {
      showAppDialog({
        title: "Couldn't import podcasts",
        message: normalizeAbsError(e).message,
      });
    } finally {
      importingRef.current = false;
      setImporting(false);
    }
  };

  const handleImportPress = () => {
    if (!canImport) return;
    const n = selectedFeeds.length;
    showAppDialog({
      title: "Import podcasts",
      message: `Add ${n} podcast${n === 1 ? "" : "s"} to ${selectedLibrary?.name}? The server creates them in the background.`,
      buttons: [
        { text: "Cancel", style: "cancel" },
        { text: "Import", onPress: doImport },
      ],
    });
  };

  const importLabel = `Import ${selectedFeeds.length} podcast${
    selectedFeeds.length === 1 ? "" : "s"
  }`;

  return (
    <BottomSheet visible={visible} onClose={onClose} maxHeight="85%">
      <View style={{ paddingHorizontal: 24, paddingTop: 4, paddingBottom: 8 }}>
        <Text
          accessibilityRole="header"
          style={{ fontSize: 18, fontWeight: "600", color: colors.onSurface }}
        >
          Import OPML
        </Text>
        <Text style={{ fontSize: 13, color: colors.onSurfaceVariant, marginTop: 2 }}>
          Paste an OPML export from another podcast app to add its feeds in bulk.
        </Text>
      </View>

      <ScrollView keyboardShouldPersistTaps="handled">
        <View style={{ paddingHorizontal: 24 }}>
          <TextInput
            value={text}
            onChangeText={setText}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="<opml> … </opml>"
            placeholderTextColor={colors.onSurfaceVariant}
            accessibilityLabel="OPML content"
            style={{
              backgroundColor: colors.surfaceContainer,
              color: colors.onSurface,
              borderRadius: 12,
              paddingHorizontal: 14,
              paddingVertical: 10,
              fontSize: 13,
              minHeight: 96,
              textAlignVertical: "top",
            }}
          />
          <View style={{ flexDirection: "row", marginTop: 10 }}>
            <Pressable
              onPress={handlePaste}
              accessibilityRole="button"
              accessibilityLabel="Paste from clipboard"
              android_ripple={{ color: withAlpha(colors.onSecondaryContainer, 0.14) }}
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                paddingHorizontal: 16,
                height: 40,
                borderRadius: 20,
                overflow: "hidden",
                backgroundColor: colors.secondaryContainer,
                marginRight: 10,
              }}
            >
              <Icon name="copy" size={16} color={colors.onSecondaryContainer} />
              <Text
                style={{
                  color: colors.onSecondaryContainer,
                  fontSize: 14,
                  fontWeight: "600",
                  marginLeft: 6,
                }}
              >
                Paste from clipboard
              </Text>
            </Pressable>
            <Pressable
              onPress={handleParse}
              disabled={!text.trim() || parsing}
              accessibilityRole="button"
              accessibilityLabel="Parse"
              accessibilityState={{ disabled: !text.trim() || parsing, busy: parsing }}
              android_ripple={{ color: withAlpha(colors.onPrimary, 0.16) }}
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                paddingHorizontal: 20,
                height: 40,
                borderRadius: 20,
                overflow: "hidden",
                backgroundColor: colors.primary,
                opacity: !text.trim() || parsing ? 0.5 : 1,
              }}
            >
              {parsing ? (
                <ActivityIndicator size="small" color={colors.onPrimary} />
              ) : (
                <Text style={{ color: colors.onPrimary, fontSize: 14, fontWeight: "700" }}>
                  Parse
                </Text>
              )}
            </Pressable>
          </View>
        </View>

        {feeds !== null && feeds.length === 0 ? (
          <Text
            accessibilityRole="alert"
            style={{
              color: colors.onSurfaceVariant,
              fontSize: 14,
              paddingHorizontal: 24,
              paddingTop: 16,
            }}
          >
            No feeds found in that OPML.
          </Text>
        ) : null}

        {feeds !== null && feeds.length > 0 ? (
          <>
            <Text
              style={{
                color: colors.onSurfaceVariant,
                fontSize: 12,
                fontWeight: "700",
                textTransform: "uppercase",
                letterSpacing: 0.5,
                paddingHorizontal: 24,
                paddingTop: 16,
                paddingBottom: 4,
              }}
            >
              Feeds ({feeds.length})
            </Text>
            {feeds.map((feedEntry, index) => {
              const checked = selected.has(index);
              const feedTitle = feedEntry.title || feedEntry.feedUrl || `Feed ${index + 1}`;
              return (
                <Pressable
                  key={feedEntry.feedUrl || index}
                  onPress={() => toggleFeed(index)}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked }}
                  accessibilityLabel={`Feed: ${feedTitle}`}
                  // A title-only row (no feedUrl line) is ~35dp tall; a vertical
                  // hitSlop lifts the effective touch target toward ~44dp.
                  hitSlop={{ top: 6, bottom: 6 }}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    paddingHorizontal: 24,
                    paddingVertical: 10,
                    backgroundColor: checked ? withAlpha(colors.primary, 0.08) : "transparent",
                  }}
                >
                  <View
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: 6,
                      borderWidth: 2,
                      borderColor: checked ? colors.primary : colors.outline,
                      backgroundColor: checked ? colors.primary : "transparent",
                      alignItems: "center",
                      justifyContent: "center",
                      marginRight: 14,
                    }}
                  >
                    {checked ? <Icon name="check" size={16} color={colors.onPrimary} /> : null}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text
                      numberOfLines={1}
                      style={{ color: colors.onSurface, fontSize: 15, fontWeight: "600" }}
                    >
                      {feedTitle}
                    </Text>
                    {feedEntry.feedUrl ? (
                      <Text
                        numberOfLines={1}
                        style={{ color: colors.onSurfaceVariant, fontSize: 12, marginTop: 2 }}
                      >
                        {feedEntry.feedUrl}
                      </Text>
                    ) : null}
                  </View>
                </Pressable>
              );
            })}

            <SelectRow
              icon="library"
              title="Library"
              subtitle={selectedLibrary?.name || "Choose a podcast library"}
              onPress={() => setLibraryPickerOpen(true)}
              colors={colors}
            />
            <SelectRow
              icon="folder"
              title="Folder"
              subtitle={selectedFolder?.fullPath || "Choose a folder"}
              onPress={() => setFolderPickerOpen(true)}
              colors={colors}
            />
            <ToggleRow
              icon="download"
              title="Auto-download episodes"
              subtitle="Apply to every imported podcast"
              value={autoDownload}
              onValueChange={setAutoDownload}
              colors={colors}
            />

            <Pressable
              onPress={handleImportPress}
              disabled={!canImport}
              accessibilityRole="button"
              accessibilityLabel={importLabel}
              accessibilityState={{ disabled: !canImport, busy: importing }}
              android_ripple={{ color: withAlpha(colors.onPrimary, 0.16) }}
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                marginHorizontal: 24,
                marginTop: 12,
                marginBottom: 8,
                height: 48,
                borderRadius: 24,
                overflow: "hidden",
                backgroundColor: colors.primary,
                opacity: canImport ? 1 : 0.5,
              }}
            >
              {importing ? (
                <ActivityIndicator size="small" color={colors.onPrimary} />
              ) : (
                <Text style={{ color: colors.onPrimary, fontSize: 15, fontWeight: "700" }}>
                  {importLabel}
                </Text>
              )}
            </Pressable>
          </>
        ) : null}
      </ScrollView>

      <SettingSelectModal
        visible={libraryPickerOpen}
        title="Library"
        options={podcastLibraries.map((l: any) => ({ label: l.name || l.id, value: l.id }))}
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
    </BottomSheet>
  );
}
