import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  FlatList,
  Pressable,
  ActivityIndicator,
  TextInput,
  RefreshControl,
  AccessibilityInfo,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useThemeColors } from "../theme/useThemeColors";
import { withAlpha } from "../theme/palette";
import Icon from "../components/Icon";
import ErrorState from "../components/ErrorState";
import EmptyState from "../components/EmptyState";
import StatusChip from "../components/StatusChip";
import { api } from "../utils/api";
import { AbsError, normalizeAbsError, absErrorToErrorStateProps, isUnsupportedError } from "../utils/abs/errors";
import { getPodcastFeed, downloadPodcastEpisodes, deletePodcastEpisode } from "../utils/abs/podcasts";
import { startTaskWatch } from "../utils/abs/tasks";
import { useServerCapabilities } from "../utils/abs/capabilities";
import { showAppDialog } from "../store/useDialogStore";
import { showSnackbar } from "../store/useSnackbarStore";
import type { AbsPodcastFeedEpisode } from "../utils/abs/types";

/**
 * PodcastEpisodesScreen — browse a podcast's RSS feed and manage which
 * episodes live ON THE SERVER (issue #56 P3). Two segments:
 *
 *  - "From feed": the parsed feed (POST /api/podcasts/feed via
 *    podcasts.getPodcastFeed), each episode diffed against the item's
 *    media.episodes — matches on enclosure.url first, then guid, then exact
 *    title — and badged "On server". Long-press multi-select (NOT-on-server
 *    episodes only) → "Download N to server" → confirm →
 *    podcasts.downloadPodcastEpisodes (BARE ARRAY of the raw feed episode
 *    objects) → startTaskWatch("download-podcast-episode" for this item) →
 *    refetch + re-diff on completion.
 *  - "On server": the item's episodes. Long-press multi-select → "Delete N" →
 *    destructive confirm with a record-only vs also-delete-files choice →
 *    podcasts.deletePodcastEpisode sequentially (a 404 → unsupported dialog,
 *    stop — the route is the module's weakest pin).
 *
 * Route: "PodcastEpisodes"
 * Params: { libraryItemId: string }
 *
 * Admin-gated up front (useServerCapabilities().isAdmin): every write here is
 * admin-only on the server, so a non-admin gets the lock ErrorState instead
 * of a screen of dead actions.
 */

type Segment = "feed" | "server";

const SEGMENTS: { key: Segment; label: string }[] = [
  { key: "feed", label: "From feed" },
  { key: "server", label: "On server" },
];

/**
 * On-server diff for one feed episode against the item's media.episodes:
 * enclosure.url is the strongest identity (it's what the server stores from
 * the download), then guid, then an exact-title fallback for feeds that
 * regenerate enclosure URLs.
 */
function isEpisodeOnServer(feedEp: AbsPodcastFeedEpisode, serverEpisodes: any[]): boolean {
  const encUrl = feedEp?.enclosure?.url;
  if (encUrl && serverEpisodes.some((se) => se?.enclosure?.url === encUrl)) return true;
  if (feedEp?.guid && serverEpisodes.some((se) => se?.guid === feedEp.guid)) return true;
  if (feedEp?.title && serverEpisodes.some((se) => se?.title === feedEp.title)) return true;
  return false;
}

/** Stable selection key for a feed episode (no server id exists yet). */
function feedEpisodeKey(ep: AbsPodcastFeedEpisode, index: number): string {
  return ep?.enclosure?.url || ep?.guid || (ep?.title ? `title:${ep.title}` : `idx:${index}`);
}

function formatPubDate(ep: any): string {
  const raw = ep?.pubDate || ep?.publishedAt;
  if (!raw) return "";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatEpisodeSize(ep: any): string {
  const bytes = Number(ep?.size ?? ep?.audioFile?.metadata?.size ?? ep?.enclosure?.length);
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

// AbsError → ErrorState props; both forbidden and unsupported read as the
// admin wall (podcast admin routes 404 for some non-admin cases).
function errorStateProps(err: AbsError) {
  return absErrorToErrorStateProps(err, {
    subject: "episodes",
    overrides: {
      offline: { message: "Managing server episodes needs a connection." },
    },
  });
}

export default function PodcastEpisodesScreen({ navigation, route }: any) {
  const colors = useThemeColors();
  const caps = useServerCapabilities();
  const libraryItemId: string | undefined = route?.params?.libraryItemId;

  const [item, setItem] = useState<any>(null);
  const [feedEpisodes, setFeedEpisodes] = useState<AbsPodcastFeedEpisode[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<AbsError | null>(null);
  // Feed failures are segment-scoped: the "On server" list must keep working
  // when the remote feed is down.
  const [feedError, setFeedError] = useState<AbsError | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  const [segment, setSegment] = useState<Segment>("feed");
  // Client-side title filter: the server exposes no search-episode endpoint
  // for a feed (episode search is omitted from the API surface), so narrowing
  // happens entirely on the fetched feed list.
  const [filter, setFilter] = useState("");
  // null = normal mode; a Set of row keys = selection (batch) mode.
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [busy, setBusy] = useState(false);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchItem = useCallback(async () => {
    // ?expanded=1 matches every other item fetch in the app (ChapterEditor,
    // EditMetadata, playback) so media.episodes is fully populated.
    const res = await api.get(`/api/items/${libraryItemId}?expanded=1`);
    return res?.data;
  }, [libraryItemId]);

  const fetchFeedFor = useCallback(async (it: any) => {
    const feedUrl = it?.media?.metadata?.feedUrl;
    if (!feedUrl) {
      // No feed URL on the podcast — not an error, the feed segment just has
      // nothing to browse.
      if (mountedRef.current) {
        setFeedEpisodes(null);
        setFeedError(null);
      }
      return;
    }
    try {
      const feed = await getPodcastFeed(feedUrl);
      if (!mountedRef.current) return;
      setFeedEpisodes(Array.isArray(feed?.episodes) ? feed.episodes : []);
      setFeedError(null);
    } catch (e) {
      if (!mountedRef.current) return;
      setFeedEpisodes(null);
      setFeedError(normalizeAbsError(e));
    }
  }, []);

  // Initial load + retry: item first (authoritative episodes), then its feed.
  useEffect(() => {
    if (!caps.isAdmin) {
      setLoading(false);
      return;
    }
    if (!libraryItemId) {
      setError(new AbsError("unknown", "No podcast provided."));
      setLoading(false);
      return;
    }
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      setSelected(null);
      try {
        const it = await fetchItem();
        if (cancelled) return;
        setItem(it);
        await fetchFeedFor(it);
      } catch (e) {
        if (!cancelled) setError(normalizeAbsError(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [libraryItemId, retryTick, caps.isAdmin, fetchItem, fetchFeedFor]);

  // Refetch the item only (post-download / post-delete re-diff).
  const refetchItem = useCallback(async () => {
    try {
      const it = await fetchItem();
      if (mountedRef.current) setItem(it);
    } catch {
      // Best-effort refresh — the action itself already reported its outcome.
    }
  }, [fetchItem]);

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      const it = await fetchItem();
      if (!mountedRef.current) return;
      setItem(it);
      setError(null);
      await fetchFeedFor(it);
    } catch (e) {
      if (mountedRef.current) setError(normalizeAbsError(e));
    } finally {
      if (mountedRef.current) setRefreshing(false);
    }
  };

  const serverEpisodes: any[] = useMemo(
    () => (Array.isArray(item?.media?.episodes) ? item.media.episodes : []),
    [item]
  );

  const podcastTitle = item?.media?.metadata?.title || "Episodes";

  // ---- feed rows (decorated with the on-server diff + title filter) --------
  type FeedRow = { key: string; ep: AbsPodcastFeedEpisode; onServer: boolean };
  const feedRows: FeedRow[] = useMemo(() => {
    if (!Array.isArray(feedEpisodes)) return [];
    const needle = filter.trim().toLowerCase();
    return feedEpisodes
      .map((ep, i) => ({
        key: feedEpisodeKey(ep, i),
        ep,
        onServer: isEpisodeOnServer(ep, serverEpisodes),
      }))
      .filter((r) => !needle || String(r.ep?.title || "").toLowerCase().includes(needle));
  }, [feedEpisodes, serverEpisodes, filter]);

  type ServerRow = { key: string; ep: any };
  const serverRows: ServerRow[] = useMemo(() => {
    const ms = (ep: any) => {
      const t = ep?.publishedAt ?? (ep?.pubDate ? new Date(ep.pubDate).getTime() : NaN);
      return Number.isFinite(t) ? t : 0;
    };
    return [...serverEpisodes]
      .sort((a, b) => ms(b) - ms(a))
      .map((ep, i) => ({ key: ep?.id || `sidx:${i}`, ep }));
  }, [serverEpisodes]);

  // ---- selection mode -------------------------------------------------------
  const selectionMode = selected !== null;

  const prevSelectionModeRef = useRef(selectionMode);
  useEffect(() => {
    if (selectionMode === prevSelectionModeRef.current) return;
    prevSelectionModeRef.current = selectionMode;
    AccessibilityInfo.announceForAccessibility(
      selectionMode
        ? "Selection mode. Tap episodes to select, then act from the bottom bar."
        : "Selection mode off."
    );
  }, [selectionMode]);

  const switchSegment = (s: Segment) => {
    setSegment(s);
    setSelected(null); // selections never carry across segments
  };

  const enterSelectionWith = (key: string) => {
    if (!selectionMode) setSelected(new Set([key]));
  };

  const toggleSelected = (key: string) => {
    setSelected((cur) => {
      if (!cur) return cur;
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next.size === 0 ? null : next;
    });
  };

  // ---- download to server ---------------------------------------------------
  const selectedFeedEpisodes = (): AbsPodcastFeedEpisode[] =>
    feedRows.filter((r) => !r.onServer && selected?.has(r.key)).map((r) => r.ep);

  const doDownload = async (eps: AbsPodcastFeedEpisode[]) => {
    if (!libraryItemId || eps.length === 0) return;
    setBusy(true);
    try {
      // BARE ARRAY of the RAW feed episode objects — the server re-reads
      // enclosure/guid/pubDate from them verbatim (contract pinned in
      // utils/abs/podcasts).
      await downloadPodcastEpisodes(libraryItemId, eps);
      setSelected(null);
      showSnackbar({ message: `Queued ${eps.length} episode${eps.length === 1 ? "" : "s"}` });
      // Completion is INFERRED: the ABS TaskManager removes finished tasks
      // from GET /api/tasks, so the watch resolves when this item's
      // download-podcast-episode task vanishes (or reports finished).
      const task = await startTaskWatch(
        (t) => t.action === "download-podcast-episode" && t.data?.libraryItemId === libraryItemId
      );
      if (!mountedRef.current) return;
      if (task) {
        showSnackbar({
          message: task.isFailed
            ? `Episode download failed${task.error ? `: ${task.error}` : ""}`
            : "Episode downloads finished",
        });
      }
      await refetchItem(); // re-diff the feed against the fresh episode list
    } catch (e) {
      if (mountedRef.current) {
        showAppDialog({ title: "Couldn't queue downloads", message: normalizeAbsError(e).message });
      }
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const confirmDownload = () => {
    const eps = selectedFeedEpisodes();
    if (eps.length === 0 || busy) return;
    const n = eps.length;
    showAppDialog({
      title: `Download ${n} episode${n === 1 ? "" : "s"} to server?`,
      message: "The server downloads the audio into this podcast's folder for everyone.",
      buttons: [
        { text: "Cancel", style: "cancel" },
        { text: "Download", onPress: () => void doDownload(eps) },
      ],
    });
  };

  // ---- delete from server ----------------------------------------------------
  const doDelete = async (ids: string[], hard: boolean) => {
    if (!libraryItemId || ids.length === 0) return;
    setBusy(true);
    setSelected(null);
    let done = 0;
    try {
      // Sequential on purpose: the delete route is the podcasts module's
      // weakest pin — the FIRST 404 means the server doesn't route it at all,
      // so firing the rest in parallel would just spam dead requests.
      for (const id of ids) {
        showSnackbar({ message: `Deleting episode ${done + 1} of ${ids.length}…` });
        try {
          await deletePodcastEpisode(libraryItemId, id, hard ? { hard: true } : undefined);
          done++;
        } catch (e) {
          if (isUnsupportedError(e)) {
            showAppDialog({
              title: "Not supported",
              message: "Episode deletion isn't supported by this server.",
            });
          } else {
            showAppDialog({ title: "Couldn't delete episode", message: normalizeAbsError(e).message });
          }
          break;
        }
      }
      if (done > 0) showSnackbar({ message: `Deleted ${done} episode${done === 1 ? "" : "s"}` });
      await refetchItem();
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const confirmDelete = () => {
    const ids = serverRows.filter((r) => selected?.has(r.key)).map((r) => r.ep?.id).filter(Boolean);
    if (ids.length === 0 || busy) return;
    const n = ids.length;
    // Single dialog with the record-only vs also-delete-files choice as
    // buttons — the same one-dialog-multi-choice idiom AdminLibraries' scan
    // confirm uses.
    showAppDialog({
      title: `Delete ${n} episode${n === 1 ? "" : "s"}?`,
      message:
        "Removes them from the server for every user. “Also delete files” permanently deletes the audio files from disk. There is no undo.",
      buttons: [
        { text: "Cancel", style: "cancel" },
        { text: "Also delete files", style: "destructive", onPress: () => void doDelete(ids, true) },
        { text: "Delete records", style: "destructive", onPress: () => void doDelete(ids, false) },
      ],
    });
  };

  // ---- rows -------------------------------------------------------------------
  const rowSubtitle = (ep: any): string => {
    const parts = [formatPubDate(ep), formatEpisodeSize(ep)].filter(Boolean);
    return parts.join(" · ");
  };

  const renderFeedRow = ({ item: row }: { item: FeedRow }) => {
    const checked = !!selected?.has(row.key);
    const title = row.ep?.title || "Untitled episode";
    const selectable = !row.onServer;
    const sub = rowSubtitle(row.ep);
    return (
      <Pressable
        onPress={
          selectionMode && selectable ? () => toggleSelected(row.key) : undefined
        }
        onLongPress={selectable ? () => enterSelectionWith(row.key) : undefined}
        accessibilityRole={selectionMode && selectable ? "checkbox" : undefined}
        accessibilityState={selectionMode && selectable ? { checked } : undefined}
        accessibilityLabel={`Episode: ${title}${row.onServer ? ", on server" : ""}`}
        accessibilityHint={
          !selectionMode && selectable ? "Long press to select episodes to download" : undefined
        }
        accessibilityActions={
          !selectionMode && selectable ? [{ name: "longpress", label: "Select episode" }] : undefined
        }
        onAccessibilityAction={(e) => {
          if (e.nativeEvent.actionName === "longpress" && selectable) enterSelectionWith(row.key);
        }}
        android_ripple={selectable ? { color: withAlpha(colors.onSurfaceVariant, 0.08) } : undefined}
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 16,
          paddingVertical: 12,
          backgroundColor: checked ? withAlpha(colors.primary, 0.08) : "transparent",
          opacity: selectionMode && !selectable ? 0.5 : 1,
        }}
      >
        {selectionMode && selectable ? (
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
        ) : null}
        <View style={{ flex: 1, marginRight: 10 }}>
          <Text numberOfLines={2} style={{ color: colors.onSurface, fontSize: 15, fontWeight: "600" }}>
            {title}
          </Text>
          {sub ? (
            <Text numberOfLines={1} style={{ color: colors.onSurfaceVariant, fontSize: 12, marginTop: 2 }}>
              {sub}
            </Text>
          ) : null}
        </View>
        {row.onServer ? <StatusChip label="On server" tone="success" testID="on-server-badge" /> : null}
      </Pressable>
    );
  };

  const renderServerRow = ({ item: row }: { item: ServerRow }) => {
    const checked = !!selected?.has(row.key);
    const title = row.ep?.title || "Untitled episode";
    const sub = rowSubtitle(row.ep);
    return (
      <Pressable
        onPress={selectionMode ? () => toggleSelected(row.key) : undefined}
        onLongPress={() => enterSelectionWith(row.key)}
        accessibilityRole={selectionMode ? "checkbox" : undefined}
        accessibilityState={selectionMode ? { checked } : undefined}
        accessibilityLabel={`Episode: ${title}`}
        accessibilityHint={!selectionMode ? "Long press to select episodes to delete" : undefined}
        accessibilityActions={
          !selectionMode ? [{ name: "longpress", label: "Select episode" }] : undefined
        }
        onAccessibilityAction={(e) => {
          if (e.nativeEvent.actionName === "longpress") enterSelectionWith(row.key);
        }}
        android_ripple={{ color: withAlpha(colors.onSurfaceVariant, 0.08) }}
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 16,
          paddingVertical: 12,
          backgroundColor: checked ? withAlpha(colors.primary, 0.08) : "transparent",
        }}
      >
        {selectionMode ? (
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
        ) : null}
        <View style={{ flex: 1, marginRight: 10 }}>
          <Text numberOfLines={2} style={{ color: colors.onSurface, fontSize: 15, fontWeight: "600" }}>
            {title}
          </Text>
          {sub ? (
            <Text numberOfLines={1} style={{ color: colors.onSurfaceVariant, fontSize: 12, marginTop: 2 }}>
              {sub}
            </Text>
          ) : null}
        </View>
      </Pressable>
    );
  };

  const listHeader = (
    <>
      {/* Segment chips (AdminMaintenance idiom). */}
      <View style={{ flexDirection: "row", paddingHorizontal: 16, paddingVertical: 12 }}>
        {SEGMENTS.map(({ key, label }) => {
          const active = segment === key;
          return (
            <Pressable
              key={key}
              onPress={() => switchSegment(key)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              // "Segment:" prefix keeps this chip's label distinct from the
              // per-row "On server" badge text for screen readers (and tests).
              accessibilityLabel={`Segment: ${label}`}
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
                backgroundColor: active ? colors.secondaryContainer : "transparent",
                borderWidth: 1,
                borderColor: active ? colors.secondaryContainer : colors.outlineVariant,
              }}
            >
              <Text
                style={{
                  color: active ? colors.onSecondaryContainer : colors.onSurfaceVariant,
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

      {segment === "feed" && Array.isArray(feedEpisodes) ? (
        <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
          <TextInput
            value={filter}
            onChangeText={setFilter}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="Filter by title"
            placeholderTextColor={colors.onSurfaceVariant}
            accessibilityLabel="Filter episodes by title"
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
      ) : null}

      <Text
        accessibilityLiveRegion="polite"
        style={{
          color: colors.onSurfaceVariant,
          fontSize: 12,
          paddingHorizontal: 16,
          paddingTop: 2,
          paddingBottom: 4,
        }}
      >
        {segment === "feed"
          ? `${feedRows.length} feed episode${feedRows.length === 1 ? "" : "s"}`
          : `${serverRows.length} on server`}
      </Text>
    </>
  );

  const renderListEmpty = () => {
    if (segment === "feed") {
      if (feedError) {
        return (
          <ErrorState
            {...errorStateProps(feedError)}
            title="Couldn't load the feed"
            onRetry={() => setRetryTick((t) => t + 1)}
          />
        );
      }
      if (!item?.media?.metadata?.feedUrl) {
        return (
          <EmptyState
            icon="rss"
            title="No feed URL"
            message="This podcast has no RSS feed URL on the server, so its feed can't be browsed."
          />
        );
      }
      if (filter.trim()) {
        return <EmptyState icon="search" title="No matches" message="No feed episodes match this filter." />;
      }
      return <EmptyState icon="podcast" title="No feed episodes" message="The feed has no episodes." />;
    }
    return (
      <EmptyState
        icon="podcast"
        title="No episodes on server"
        message="Download episodes from the feed to add them to the server."
      />
    );
  };

  const selectedCount = selected?.size ?? 0;

  let body: React.ReactNode;
  if (!caps.isAdmin) {
    body = (
      <ErrorState
        style={{ flex: 1 }}
        icon="lock"
        title="Admin access required"
        message="Only server admins can manage a podcast's server episodes."
      />
    );
  } else if (loading) {
    body = (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  } else if (error) {
    body = (
      <ErrorState
        style={{ flex: 1 }}
        {...errorStateProps(error)}
        onRetry={libraryItemId ? () => setRetryTick((t) => t + 1) : undefined}
      />
    );
  } else {
    body = (
      <>
        <FlatList
          testID="podcast-episodes-list"
          style={{ flex: 1 }}
          data={segment === "feed" ? (feedRows as any[]) : (serverRows as any[])}
          keyExtractor={(r: any) => r.key}
          renderItem={segment === "feed" ? (renderFeedRow as any) : (renderServerRow as any)}
          extraData={`${segment}:${selectedCount}:${selectionMode}`}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
          }
          ListHeaderComponent={listHeader}
          ListEmptyComponent={renderListEmpty()}
          ItemSeparatorComponent={() => (
            <View style={{ height: 1, backgroundColor: colors.outlineVariant, marginLeft: 16, opacity: 0.6 }} />
          )}
          contentContainerStyle={{ paddingBottom: selectionMode ? 96 : 40 }}
        />
        {/* Bottom action bar (selection mode). */}
        {selectionMode ? (
          <View
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 0,
              paddingHorizontal: 16,
              paddingVertical: 12,
              backgroundColor: colors.surfaceContainer,
              borderTopWidth: 1,
              borderTopColor: colors.outlineVariant,
            }}
          >
            <Pressable
              onPress={segment === "feed" ? confirmDownload : confirmDelete}
              disabled={busy || selectedCount === 0}
              accessibilityRole="button"
              accessibilityLabel={
                segment === "feed"
                  ? `Download ${selectedCount} to server`
                  : `Delete ${selectedCount}`
              }
              accessibilityState={{ disabled: busy || selectedCount === 0 }}
              android_ripple={{
                color: withAlpha(segment === "feed" ? colors.onPrimary : colors.onError, 0.16),
              }}
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                height: 48,
                borderRadius: 24,
                overflow: "hidden",
                backgroundColor: segment === "feed" ? colors.primary : colors.error,
                opacity: busy || selectedCount === 0 ? 0.6 : 1,
              }}
            >
              {busy ? (
                <ActivityIndicator
                  size="small"
                  color={segment === "feed" ? colors.onPrimary : colors.onError}
                />
              ) : (
                <>
                  <Icon
                    name={segment === "feed" ? "download" : "trash"}
                    size={18}
                    color={segment === "feed" ? colors.onPrimary : colors.onError}
                  />
                  <Text
                    style={{
                      color: segment === "feed" ? colors.onPrimary : colors.onError,
                      fontSize: 15,
                      fontWeight: "700",
                      marginLeft: 8,
                    }}
                  >
                    {segment === "feed"
                      ? `Download ${selectedCount} to server`
                      : `Delete ${selectedCount}`}
                  </Text>
                </>
              )}
            </Pressable>
          </View>
        ) : null}
      </>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }} edges={["top", "left", "right"]}>
      {/* Settings-family header — morphs into the selection-mode header. */}
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
        {selectionMode ? (
          <>
            <Pressable
              onPress={() => setSelected(null)}
              style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", marginRight: 4 }}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Exit selection"
            >
              <Icon name="close" size={24} color={colors.onSurface} />
            </Pressable>
            <Text
              accessibilityRole="header"
              style={{ color: colors.onSurface, fontSize: 20, fontWeight: "700", flex: 1 }}
            >
              {selectedCount} selected
            </Text>
          </>
        ) : (
          <>
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
              {podcastTitle}
            </Text>
          </>
        )}
      </View>
      {body}
    </SafeAreaView>
  );
}
