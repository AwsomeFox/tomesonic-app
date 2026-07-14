import React, { useCallback, useRef, useState } from "react";
import { View, Text, FlatList, Pressable, ActivityIndicator } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useThemeColors } from "../theme/useThemeColors";
import { withAlpha } from "../theme/palette";
import Icon from "../components/Icon";
import ErrorState from "../components/ErrorState";
import EmptyState from "../components/EmptyState";
import TaskProgressRow from "../components/TaskProgressRow";
import { usePolling } from "../hooks/usePolling";
import { AbsError, normalizeAbsError, absErrorToErrorStateProps } from "../utils/abs/errors";
import {
  getPodcastEpisodeDownloads,
  getLibraryEpisodeDownloads,
  clearPodcastDownloadQueue,
} from "../utils/abs/podcasts";
import { showAppDialog } from "../store/useDialogStore";
import { showSnackbar } from "../store/useSnackbarStore";
import type { AbsEpisodeDownload } from "../utils/abs/types";

/**
 * PodcastDownloadQueueScreen — the server's episode-download queue (issue #56
 * P3), polled every ~5s while focused (usePolling's focus/app-state gates).
 *
 * Route: "PodcastDownloadQueue"
 * Params: exactly ONE of
 *   { libraryItemId } — one podcast's queue (GET /api/podcasts/:id/downloads),
 *     with a "Clear queue" header action (GET /api/podcasts/:id/clear-queue —
 *     a side-effecting GET, that's the route the server exposes). Clearing
 *     drops the QUEUED episodes only; the in-flight download keeps going.
 *   { libraryId } — the library-wide queue (GET /api/libraries/:id/
 *     episode-downloads). VIEW-ONLY: the server has no library-wide
 *     clear-queue route, so no clear action is offered here.
 *
 * The in-flight download renders as a TaskProgressRow under a "Downloading
 * now" section; queued rows list episodeDisplayTitle in order.
 */

const POLL_INTERVAL_MS = 5000;

function errorStateProps(err: AbsError) {
  return absErrorToErrorStateProps(err, {
    subject: "the download queue",
    overrides: {
      offline: { message: "Viewing the server's download queue needs a connection." },
      forbidden: { message: "Only server admins can view episode downloads." },
    },
  });
}

/** Adapt an AbsEpisodeDownload into the AbsTask shape TaskProgressRow renders. */
function downloadAsTask(dl: AbsEpisodeDownload): any {
  return {
    id: dl?.id || "current-download",
    action: "download-podcast-episode",
    data: {},
    title: dl?.episodeDisplayTitle || "Untitled episode",
    description: dl?.podcastTitle || undefined,
    error: null,
    isFailed: false,
    isFinished: false,
    startedAt: typeof dl?.startedAt === "number" ? dl.startedAt : undefined,
    finishedAt: null,
  };
}

export default function PodcastDownloadQueueScreen({ navigation, route }: any) {
  const colors = useThemeColors();
  const params = route?.params || {};
  const libraryItemId: string | undefined = params.libraryItemId;
  const libraryId: string | undefined = params.libraryId;
  // Exactly one of the two params selects the mode.
  const perPodcast = !!libraryItemId && !libraryId;
  const perLibrary = !!libraryId && !libraryItemId;
  const validParams = perPodcast || perLibrary;

  const [queue, setQueue] = useState<AbsEpisodeDownload[]>([]);
  const [current, setCurrent] = useState<AbsEpisodeDownload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AbsError | null>(null);
  const [clearing, setClearing] = useState(false);

  // Once any poll has succeeded, later poll failures keep the last-good rows
  // (stale beats an error flash mid-download); only a never-loaded screen
  // surfaces the ErrorState.
  const hasLoadedRef = useRef(false);

  const poll = useCallback(async () => {
    if (!validParams) return;
    try {
      const res = perPodcast
        ? await getPodcastEpisodeDownloads(libraryItemId!)
        : await getLibraryEpisodeDownloads(libraryId!);
      hasLoadedRef.current = true;
      setQueue(res.queue);
      setCurrent(res.currentDownload);
      setError(null);
    } catch (e) {
      if (!hasLoadedRef.current) setError(normalizeAbsError(e));
    } finally {
      setLoading(false);
    }
  }, [validParams, perPodcast, libraryItemId, libraryId]);

  const { refresh } = usePolling(poll, { intervalMs: POLL_INTERVAL_MS, enabled: validParams });

  const retry = () => {
    setLoading(true);
    setError(null);
    void refresh();
  };

  // ---- clear queue (per-podcast mode only) ----------------------------------
  const doClear = async () => {
    if (!libraryItemId) return;
    setClearing(true);
    try {
      await clearPodcastDownloadQueue(libraryItemId);
      showSnackbar({ message: "Download queue cleared" });
      await refresh(); // reflect the emptied queue immediately
    } catch (e) {
      showAppDialog({ title: "Couldn't clear the queue", message: normalizeAbsError(e).message });
    } finally {
      setClearing(false);
    }
  };

  const confirmClear = () => {
    if (clearing) return;
    showAppDialog({
      title: "Clear download queue?",
      message:
        "Removes the QUEUED episode downloads for this podcast. The episode currently downloading is not cancelled.",
      buttons: [
        { text: "Cancel", style: "cancel" },
        { text: "Clear queue", style: "destructive", onPress: () => void doClear() },
      ],
    });
  };

  // ---- rows -------------------------------------------------------------------
  const renderQueueRow = ({ item, index }: { item: AbsEpisodeDownload; index: number }) => (
    <View
      accessible
      accessibilityLabel={`Queued: ${item?.episodeDisplayTitle || "Untitled episode"}`}
      style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 12 }}
    >
      <Text style={{ color: colors.onSurfaceVariant, fontSize: 13, width: 28 }}>{index + 1}.</Text>
      <View style={{ flex: 1, marginRight: 10 }}>
        <Text numberOfLines={2} style={{ color: colors.onSurface, fontSize: 15, fontWeight: "600" }}>
          {item?.episodeDisplayTitle || "Untitled episode"}
        </Text>
        <Text numberOfLines={1} style={{ color: colors.onSurfaceVariant, fontSize: 12, marginTop: 2 }}>
          {item?.podcastTitle ? `Queued · ${item.podcastTitle}` : "Queued"}
        </Text>
      </View>
    </View>
  );

  const listHeader = current ? (
    <View testID="current-download">
      <Text
        style={{
          color: colors.primary,
          fontSize: 13,
          fontWeight: "700",
          textTransform: "uppercase",
          letterSpacing: 1,
          paddingTop: 16,
          paddingBottom: 4,
          paddingHorizontal: 20,
        }}
      >
        Downloading now
      </Text>
      <TaskProgressRow task={downloadAsTask(current)} showDescription />
      {queue.length > 0 ? (
        <Text
          style={{
            color: colors.onSurfaceVariant,
            fontSize: 12,
            paddingHorizontal: 16,
            paddingTop: 8,
            paddingBottom: 4,
          }}
        >
          {queue.length} queued
        </Text>
      ) : null}
    </View>
  ) : queue.length > 0 ? (
    <Text
      style={{
        color: colors.onSurfaceVariant,
        fontSize: 12,
        paddingHorizontal: 16,
        paddingTop: 10,
        paddingBottom: 4,
      }}
    >
      {queue.length} queued
    </Text>
  ) : null;

  let body: React.ReactNode;
  if (!validParams) {
    body = (
      <ErrorState
        style={{ flex: 1 }}
        icon="warning"
        title="No queue to show"
        message="This screen needs a podcast or a library to look up."
      />
    );
  } else if (loading) {
    body = (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  } else if (error) {
    body = <ErrorState style={{ flex: 1 }} {...errorStateProps(error)} onRetry={retry} />;
  } else if (!current && queue.length === 0) {
    body = (
      <EmptyState
        style={{ flex: 1 }}
        icon="download"
        title="No queued episode downloads"
        message={
          perPodcast
            ? "Episodes queued for this podcast will show up here."
            : "Episodes queued in this library will show up here."
        }
      />
    );
  } else {
    body = (
      <FlatList
        testID="download-queue-list"
        style={{ flex: 1 }}
        data={queue}
        keyExtractor={(d, i) => d?.id || `q-${i}`}
        renderItem={renderQueueRow}
        ListHeaderComponent={listHeader}
        ItemSeparatorComponent={() => (
          <View style={{ height: 1, backgroundColor: colors.outlineVariant, marginLeft: 16, opacity: 0.6 }} />
        )}
        contentContainerStyle={{ paddingBottom: 40 }}
      />
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }} edges={["top", "left", "right"]}>
      {/* Settings-family header. */}
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
          Download queue
        </Text>
        {/* Library mode is view-only: no library-wide clear-queue route exists
            on the server, so the action only renders per-podcast. */}
        {perPodcast && !loading && !error ? (
          <Pressable
            onPress={confirmClear}
            disabled={clearing}
            style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" }}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Clear queue"
            accessibilityState={{ disabled: clearing }}
            android_ripple={{ color: withAlpha(colors.onSurfaceVariant, 0.12), borderless: true }}
          >
            {clearing ? (
              <ActivityIndicator size="small" color={colors.error} />
            ) : (
              <Icon name="trash" size={24} color={colors.error} />
            )}
          </Pressable>
        ) : null}
      </View>
      {body}
    </SafeAreaView>
  );
}
