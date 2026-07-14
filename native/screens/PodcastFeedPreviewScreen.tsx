import React, { useEffect, useMemo, useRef, useState } from "react";
import { View, Text, ScrollView, ActivityIndicator, Pressable } from "react-native";
import { Image } from "expo-image";
import { SafeAreaView } from "react-native-safe-area-context";
import { useThemeColors } from "../theme/useThemeColors";
import { withAlpha } from "../theme/palette";
import Icon from "../components/Icon";
import ErrorState from "../components/ErrorState";
import { SectionHeader, SelectRow, ToggleRow } from "../components/SettingsRows";
import SettingSelectModal from "../components/SettingSelectModal";
import { api } from "../utils/api";
import { AbsError, normalizeAbsError, absErrorToErrorStateProps } from "../utils/abs/errors";
import { getPodcastFeed, createPodcast } from "../utils/abs/podcasts";
import { CRON_PRESETS } from "../utils/podcastCron";
import type { AbsPodcastFeed, AbsPodcastSearchResult } from "../utils/abs/types";
import { showAppDialog } from "../store/useDialogStore";

/**
 * PodcastFeedPreviewScreen — preview a podcast RSS feed and add it to the
 * server (issue #56 P2).
 *
 * Route: "PodcastFeedPreview"
 * Params: {
 *   feedUrl: string;                    // the RSS feed to preview
 *   seed?: AbsPodcastSearchResult;      // provider hit (cover/title fallback)
 *   libraryId?: string;                 // preselected destination library
 * }
 *
 * On mount the server fetches + parses the feed (POST /api/podcasts/feed) and
 * the destination pickers load fresh from GET /api/libraries (podcast-type
 * only). The computed destination path is `${folder.fullPath}/${sanitized
 * title}` — see sanitizePodcastDirName. "Add podcast" confirms, then POSTs
 * /api/podcasts with the web-client-mirrored payload shape (metadata +
 * autoDownload* nested under `media`; path/folderId/libraryId top-level —
 * utils/abs/podcasts.ts documents that pin). Success offers a "Done" dialog
 * that pops back (deep-linking into the P3-owned podcast screens is
 * deliberately not done here). Navigator registration is owned by P3.
 */

/**
 * Sanitize a show title into a directory name the server can create: keep
 * alphanumerics, spaces, dashes, and underscores; collapse whitespace; trim.
 * Falls back to "podcast" when nothing survives. Exported for unit assertion.
 */
export function sanitizePodcastDirName(title: string): string {
  const cleaned = String(title || "")
    .replace(/[^a-zA-Z0-9 _-]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "podcast";
}

export default function PodcastFeedPreviewScreen({ navigation, route }: any) {
  const colors = useThemeColors();
  const params = route?.params || {};
  const feedUrl: string = params.feedUrl || "";
  const seed: AbsPodcastSearchResult | undefined = params.seed;

  const [feed, setFeed] = useState<AbsPodcastFeed | null>(null);
  const [libraries, setLibraries] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AbsError | null>(null);
  const [retryTick, setRetryTick] = useState(0);

  const [selectedLibraryId, setSelectedLibraryId] = useState<string | undefined>(
    params.libraryId
  );
  const [selectedFolderId, setSelectedFolderId] = useState<string | undefined>(undefined);
  const [libraryPickerOpen, setLibraryPickerOpen] = useState(false);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);

  const [autoDownload, setAutoDownload] = useState(false);
  // Server default schedule (hourly) — chips below override.
  const [schedule, setSchedule] = useState("0 * * * *");

  const [busy, setBusy] = useState(false);
  // Synchronous re-entrancy guard (OpenFeedSheet idiom): a double-tap on the
  // confirm dialog can fire before setBusy(true) has flushed.
  const busyRef = useRef(false);

  useEffect(() => {
    if (!feedUrl) {
      setError(new AbsError("unknown", "No feed URL was provided."));
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        // The feed parse is the gating fetch; libraries ride along so the
        // destination pickers are ready when the form appears.
        const [feedRes, libsRes] = await Promise.all([
          getPodcastFeed(feedUrl),
          api.get("/api/libraries"),
        ]);
        if (cancelled) return;
        setFeed(feedRes || {});
        const raw = libsRes.data?.libraries || libsRes.data || [];
        setLibraries(
          Array.isArray(raw) ? raw.filter((l: any) => l && typeof l === "object" && l.id) : []
        );
      } catch (e) {
        if (!cancelled) setError(normalizeAbsError(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [feedUrl, retryTick]);

  const podcastLibraries = useMemo(
    () => libraries.filter((l: any) => l.mediaType === "podcast"),
    [libraries]
  );

  // Keep the preselect only when it's a real podcast library; else first one.
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

  const metadata: any = feed?.metadata || {};
  const title: string = metadata.title || seed?.title || "Podcast";
  const author: string = metadata.author || seed?.artistName || "";
  const description: string = metadata.description || "";
  const cover: string | undefined = seed?.cover || metadata.imageUrl || undefined;
  const episodes: any[] = Array.isArray(feed?.episodes) ? feed!.episodes! : [];

  const sanitizedTitle = sanitizePodcastDirName(title);
  const destinationPath = selectedFolder ? `${selectedFolder.fullPath}/${sanitizedTitle}` : null;

  const canAdd = !!feed && !!selectedLibrary && !!selectedFolder && !busy;

  const doAdd = async () => {
    if (busyRef.current || !selectedLibrary || !selectedFolder || !destinationPath) return;
    busyRef.current = true;
    setBusy(true);
    try {
      // media.metadata from the parsed feed (falling back to the provider seed
      // where the feed is silent); optional fields ride along only when the
      // feed carries them so the server keeps its own defaults otherwise.
      const md: any = {
        title,
        author: author || null,
        description: description || null,
        feedUrl: metadata.feedUrl || feedUrl,
        imageUrl: metadata.imageUrl || seed?.cover || null,
        // Send itunesId as a string to match the metadata editor's write path
        // (EditMetadataScreen coerces with String()), so the two paths agree.
        ...(metadata.itunesId != null ? { itunesId: String(metadata.itunesId) } : {}),
        ...(metadata.language ? { language: metadata.language } : {}),
        ...(metadata.explicit != null ? { explicit: !!metadata.explicit } : {}),
        ...(Array.isArray(metadata.genres) && metadata.genres.length
          ? { genres: metadata.genres }
          : {}),
      };
      await createPodcast({
        path: destinationPath,
        folderId: selectedFolder.id,
        libraryId: selectedLibrary.id,
        media: {
          metadata: md,
          autoDownloadEpisodes: autoDownload,
          // A schedule without the toggle would be dead config — only send it
          // when auto-download is actually on.
          ...(autoDownload ? { autoDownloadSchedule: schedule } : {}),
        },
      });
      showAppDialog({
        title: "Podcast added",
        message: `"${title}" was added to ${selectedLibrary.name}. The server is fetching its episodes now.`,
        buttons: [{ text: "Done", onPress: () => navigation.goBack() }],
      });
    } catch (e) {
      const err = normalizeAbsError(e);
      showAppDialog({ title: "Couldn't add the podcast", message: err.message });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const handleAddPress = () => {
    if (!canAdd || !selectedLibrary) return;
    showAppDialog({
      title: "Add podcast",
      message: `Add "${title}" to ${selectedLibrary.name}?`,
      buttons: [
        { text: "Cancel", style: "cancel" },
        { text: "Add", onPress: doAdd },
      ],
    });
  };

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
          Add podcast
        </Text>
      </View>

      {loading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : error ? (
        <ErrorState
          style={{ flex: 1 }}
          {...absErrorToErrorStateProps(error, {
            subject: "this feed",
            overrides: {
              offline: { message: "Previewing a feed needs a connection to the server." },
              server: {
                title: "Couldn't read that feed",
                message: "The server couldn't fetch or parse this RSS feed.",
              },
            },
          })}
          onRetry={() => setRetryTick((t) => t + 1)}
        />
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 40 }}>
          {/* Show header: cover + title/author/description. */}
          <View style={{ flexDirection: "row", paddingHorizontal: 16, paddingTop: 16 }}>
            <View
              style={{
                width: 96,
                height: 96,
                borderRadius: 12,
                overflow: "hidden",
                backgroundColor: colors.surfaceContainerHigh,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {cover ? (
                <Image source={{ uri: cover }} style={{ width: 96, height: 96 }} contentFit="cover" />
              ) : (
                <Icon name="podcast" size={36} color={colors.onSurfaceVariant} />
              )}
            </View>
            <View style={{ flex: 1, marginLeft: 14 }}>
              <Text
                accessibilityRole="header"
                numberOfLines={2}
                style={{ color: colors.onSurface, fontSize: 18, fontWeight: "700" }}
              >
                {title}
              </Text>
              {author ? (
                <Text
                  numberOfLines={1}
                  style={{ color: colors.onSurfaceVariant, fontSize: 14, marginTop: 2 }}
                >
                  {author}
                </Text>
              ) : null}
              {description ? (
                <Text
                  numberOfLines={4}
                  style={{ color: colors.onSurfaceVariant, fontSize: 13, marginTop: 6 }}
                >
                  {description}
                </Text>
              ) : null}
            </View>
          </View>

          <SectionHeader label="Destination" colors={colors} />
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
          <View style={{ paddingHorizontal: 16, paddingVertical: 6 }}>
            <Text style={{ color: colors.onSurfaceVariant, fontSize: 12 }}>
              {destinationPath
                ? `Will be created at: ${destinationPath}`
                : "Choose a folder to see the destination path."}
            </Text>
          </View>

          <SectionHeader label="Auto-download" colors={colors} />
          <ToggleRow
            icon="download"
            title="Auto-download episodes"
            subtitle="The server checks the feed on a schedule"
            value={autoDownload}
            onValueChange={setAutoDownload}
            colors={colors}
          />
          {autoDownload ? (
            <>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 8, alignItems: "center" }}
              >
                {CRON_PRESETS.map((preset) => {
                  const active = schedule === preset.cron;
                  return (
                    <Pressable
                      key={preset.cron}
                      onPress={() => setSchedule(preset.cron)}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                      accessibilityLabel={`Schedule: ${preset.label}`}
                      android_ripple={{ color: withAlpha(colors.onSurfaceVariant, 0.12) }}
                      hitSlop={{ top: 6, bottom: 6 }}
                      style={{
                        paddingHorizontal: 14,
                        height: 34,
                        borderRadius: 17,
                        overflow: "hidden",
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
                        {preset.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
              <Text style={{ color: colors.onSurfaceVariant, fontSize: 12, paddingHorizontal: 16 }}>
                Cron schedule: {schedule}
              </Text>
            </>
          ) : null}

          <SectionHeader label="Episodes in feed" colors={colors} />
          {episodes.length === 0 ? (
            <Text
              style={{ color: colors.onSurfaceVariant, fontSize: 14, paddingHorizontal: 16 }}
            >
              The feed lists no episodes.
            </Text>
          ) : (
            <>
              {episodes.slice(0, 10).map((ep: any, i: number) => (
                <Text
                  key={ep?.guid || i}
                  numberOfLines={1}
                  style={{
                    color: colors.onSurface,
                    fontSize: 14,
                    paddingHorizontal: 16,
                    paddingVertical: 6,
                  }}
                >
                  {ep?.title || "Untitled episode"}
                </Text>
              ))}
              {episodes.length > 10 ? (
                <Text
                  style={{
                    color: colors.onSurfaceVariant,
                    fontSize: 13,
                    paddingHorizontal: 16,
                    paddingTop: 4,
                  }}
                >
                  …and {episodes.length - 10} more
                </Text>
              ) : null}
            </>
          )}

          {/* Primary action. */}
          <Pressable
            onPress={handleAddPress}
            disabled={!canAdd}
            accessibilityRole="button"
            accessibilityLabel="Add podcast"
            accessibilityState={{ disabled: !canAdd, busy }}
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
              opacity: canAdd ? 1 : 0.5,
            }}
          >
            {busy ? (
              <ActivityIndicator size="small" color={colors.onPrimary} />
            ) : (
              <Text style={{ color: colors.onPrimary, fontSize: 15, fontWeight: "700" }}>
                Add podcast
              </Text>
            )}
          </Pressable>
        </ScrollView>
      )}

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
    </SafeAreaView>
  );
}
