import React, { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { View, Text, Pressable, ScrollView, RefreshControl } from "react-native";
import { Image } from "expo-image";
import { coverSource } from "../utils/coverSource";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import Animated, { FadeIn } from "react-native-reanimated";
import { shelfCardEnter } from "../theme/motion";
import { useLibraryStore } from "../store/useLibraryStore";
import { useUserStore } from "../store/useUserStore";
import { api } from "../utils/api";
import { storage } from "../utils/storage";
import { useThemeColors } from "../theme/useThemeColors";
import { withAlpha } from "../theme/palette";
import TopAppBar from "../components/TopAppBar";
import BookCard from "../components/BookCard";
import Icon from "../components/Icon";
import ErrorState from "../components/ErrorState";
import EmptyState from "../components/EmptyState";
import { encodeFilterValue } from "../components/FilterModal";
import { usePlaybackStore } from "../store/usePlaybackStore";
import { useUiStore } from "../store/useUiStore";
import SearchContent from "../components/SearchContent";
import { ShelfSkeleton } from "../components/Skeleton";
import { useDownloadStore } from "../store/useDownloadStore";
import { useFavoritesStore } from "../store/useFavoritesStore";
import { useNetworkStatus } from "../hooks/useNetworkStatus";
import { flushPendingSyncs } from "../utils/progressSync";
import { hasEbook, isEbookOnly } from "../utils/bookMatch";
import { shelfOverflows, shelfToLibraryParams } from "../utils/shelfLayout";
import { hideFromContinueListening } from "../utils/abs/me";
import { showSnackbar } from "../store/useSnackbarStore";
import { bookStatusA11yLabel } from "../components/BookProgressBadge";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

// shelfToLibraryParams (the shelf → Library-tab "see all" destination mapping)
// and shelfOverflows (the row-overflow predicate gating the header arrow) are
// pure and live in utils/shelfLayout.ts so unit tests can lock them down.

export default function BookshelfScreen({ navigation }: any) {
  const colors = useThemeColors();
  const hasSession = usePlaybackStore((s) => s.currentSession !== null);
  // Narrow selector (was a whole-store `useUserStore()` destructure, which
  // re-rendered the screen on every mediaProgress tick).
  const serverConnectionConfig = useUserStore((s) => s.serverConnectionConfig);
  // Reactive per-tick map, used ONLY for the series "N left" badge below so it
  // updates when progress changes. Cards are memoized, so a screen re-render
  // here doesn't cascade into re-rendering every book card.
  const mediaProgressMap = useUserStore((s) => s.mediaProgress);
  const isSearchActive = useUiStore((s) => s.isSearchActive);
  const loadMediaProgress = useUserStore((s) => s.loadMediaProgress);
  const { personalizedShelves, loadPersonalizedShelves, currentLibraryId, loadLibraries, shelvesLoadError, libraries } = useLibraryStore();
  // A podcast library gets a "Latest Episodes" entry point (the recent-episodes
  // screen is otherwise unreachable — nothing else navigates to it).
  const isPodcastLibrary = React.useMemo(
    () => libraries.some((l: any) => l.id === currentLibraryId && l.mediaType === "podcast"),
    [libraries, currentLibraryId]
  );
  // Continue Reading is cached per library (stale-while-revalidate, like the
  // shelves) so it renders on the first frame instead of popping in after the
  // per-item fetches finish.
  const readContinueReadingCache = (libId: string | null): any[] => {
    if (!libId) return [];
    try {
      const raw = storage.getString(`continueReadingCache_${libId}`);
      const parsed = raw ? JSON.parse(raw) : null;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };
  const [continueReadingItems, setContinueReadingItems] = useState<any[]>(() =>
    readContinueReadingCache(useLibraryStore.getState().currentLibraryId)
  );
  // Latest continueReadingItems, mirrored into a ref so loadAffinity (which can
  // be invoked from a stale focus/online-recovery closure) always tallies genres
  // against the CURRENT list instead of a snapshot captured at closure time.
  const continueReadingItemsRef = useRef(continueReadingItems);
  useEffect(() => {
    continueReadingItemsRef.current = continueReadingItems;
  }, [continueReadingItems]);
  // "Want to Read": the device-local favorites list (store/useFavoritesStore),
  // written from ItemDetail, surfaced here as a normal book shelf. Subscribing to
  // the `favorites` array makes the shelf refresh the moment an item is
  // (un)favorited elsewhere. The fetched, library-scoped items live in state.
  const favoriteIds = useFavoritesStore((s) => s.favorites);
  const [wantToReadItems, setWantToReadItems] = useState<any[]>([]);
  // "Because you listened": a client-side genre-affinity shelf. Derived from the
  // genres of the books the user has finished/started (tallied over the loaded
  // shelves + Continue Reading), then a single items query for the top genre,
  // with already-finished/in-progress items filtered back out. Null whenever
  // there's no affinity/data or we're offline — the shelf is purely additive.
  const [affinityShelf, setAffinityShelf] = useState<any | null>(null);
  // Continue-Listening entries the user hid via long-press, removed
  // OPTIMISTICALLY (before the server call even fires) so the card disappears
  // immediately; restored by the snackbar's Undo or if the request fails.
  // Cleared on library switch, superseded by the post-hide shelf refetch, and
  // pruned once a refetched shelf no longer carries the id (see below).
  const [hiddenContinueIds, setHiddenContinueIds] = useState<string[]>([]);
  // Starts true so the very first frame of a fresh install shows the skeleton
  // (not an empty screen). Warm starts hydrate shelves synchronously from the
  // MMKV cache, so the `shelves.length === 0` half of the gate skips it.
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // Per-shelf "does the horizontal row overflow its viewport" flag. A shelf only
  // gets a "see all" arrow when its content is wider than the screen (i.e. there
  // are more items than fit) AND it maps to a full-list destination — a short
  // row that shows everything already has nothing more to see. Viewport and
  // content widths arrive from separate callbacks (onLayout / onContentSizeChange)
  // and in either order, so both are stashed in refs and the flag is recomputed
  // whenever either changes.
  const [shelfOverflow, setShelfOverflow] = useState<Record<string, boolean>>({});
  const shelfViewportW = useRef<Record<string, number>>({});
  const shelfContentW = useRef<Record<string, number>>({});
  const recomputeShelfOverflow = useCallback((id: string) => {
    const vw = shelfViewportW.current[id] || 0;
    const cw = shelfContentW.current[id] || 0;
    const over = shelfOverflows(vw, cw);
    setShelfOverflow((prev) => (prev[id] === over ? prev : { ...prev, [id]: over }));
  }, []);
  // `isOffline` is the derived, debounced "effectively offline" signal (also
  // true for a captive portal / reachable-Wi-Fi-but-unreachable-server), which
  // the whole-screen offline gating below relies on so those cases actually
  // show the downloaded library instead of hanging on failed fetches.
  const { isOffline } = useNetworkStatus();
  // Latest `isOffline`, mirrored into a ref so the async loaders read the CURRENT
  // connectivity even when invoked from a stale focus/online-recovery closure.
  const isOfflineRef = useRef(isOffline);
  useEffect(() => {
    isOfflineRef.current = isOffline;
  }, [isOffline]);
  const hideNonAudiobooks = useUserStore((s) => !!s.settings?.hideNonAudiobooksGlobal);
  const completedDownloads = useDownloadStore((s) => s.completedDownloads);
  const downloadsLoaded = useDownloadStore((s) => s.downloadsLoaded);
  const startPlayback = usePlaybackStore((s) => s.startPlayback);
  // In-flight guard for the offline downloaded-row tap: double-tapping a row
  // must not churn two playback sessions (or leave a rejection unhandled).
  const offlineStartingRef = useRef(false);

  // Mounted flag: the async shelf loaders below fire from several triggers
  // (initData / focus / refresh / online-recovery) and can resolve after the
  // screen unmounts — never setState on an unmounted screen.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Per-loader monotonic request ids. Each loader captures the next id at call
  // time and re-checks it before every setState, so an earlier (slower) request
  // resolving after a newer one can't clobber the newer result — the classic
  // last-writer-wins stale-async bug, since multiple can be in flight at once.
  const continueReadingReqId = useRef(0);
  const wantToReadReqId = useRef(0);
  const affinityReqId = useRef(0);

  // Count of in-flight async shelf loaders. Gates the empty state so it can't
  // flash before the async-built shelves (continue-reading/want-to-read/
  // affinity) have had a chance to populate.
  const [pendingLoads, setPendingLoads] = useState(0);
  const beginLoad = useCallback(() => {
    if (mountedRef.current) setPendingLoads((n) => n + 1);
  }, []);
  const endLoad = useCallback(() => {
    if (mountedRef.current) setPendingLoads((n) => Math.max(0, n - 1));
  }, []);

  const loadContinueReading = async () => {
    // Capture the library at call time: if the user switches libraries while
    // the fetch is in flight, the stale result must not clobber the new
    // library's shelf (checked again before every setState below).
    const libId = useLibraryStore.getState().currentLibraryId;
    if (!libId) return;
    // "Hide non-audiobooks" suppresses the Continue Reading shelf — skip the
    // whole item-batch fetch while it's on.
    if (useUserStore.getState().settings?.hideNonAudiobooksGlobal) return;
    // Request recency + same-library + still-mounted: an earlier request that
    // resolves after a newer one (or after unmount) is discarded.
    const reqId = ++continueReadingReqId.current;
    const isCurrent = () =>
      mountedRef.current && reqId === continueReadingReqId.current && useLibraryStore.getState().currentLibraryId === libId;

    beginLoad();
    try {
      const mediaProgress = useUserStore.getState().mediaProgress || {};
      
      // Find all library item IDs with active ebook progress from the user's
      // progress store. Use the progress object's libraryItemId — the map key
      // can be a composite `${libraryItemId}-${episodeId}` for podcast episodes,
      // which would poison the batch item request. Episodes can't be ebooks,
      // so skip episode-progress rows entirely.
      const inProgressIds = Array.from(
        new Set(
          Object.values(mediaProgress)
            .filter((p: any) => {
              if (!p || p.isFinished || p.episodeId) return false;
              // A fully-read ebook (>=99%) is done — don't offer to "continue".
              if ((p.ebookProgress || 0) >= 0.99) return false;
              return p.ebookLocation || (p.ebookProgress !== undefined && p.ebookProgress > 0);
            })
            .map((p: any) => p.libraryItemId)
            .filter(Boolean)
        )
      );

      if (inProgressIds.length === 0) {
        if (isCurrent()) {
          try { storage.set(`continueReadingCache_${libId}`, "[]"); } catch {}
          setContinueReadingItems([]);
        }
        return;
      }

      // Fetch all items in ONE batch request instead of N sequential item
      // fetches (this was the main reason Continue Reading appeared late).
      let fetchedItems: any[] = [];
      try {
        const res = await api.post(`/api/items/batch/get`, { libraryItemIds: inProgressIds });
        fetchedItems = res.data?.libraryItems || [];
      } catch (err) {
        // Older servers without batch/get: fall back to per-item fetches.
        console.warn("[Bookshelf] batch item fetch failed, falling back", err);
        const itemRequests = inProgressIds.map(async (id) => {
          try {
            const r = await api.get(`/api/items/${id}`);
            return r.data;
          } catch {
            return null;
          }
        });
        fetchedItems = (await Promise.all(itemRequests)).filter(Boolean);
      }
      
      // Scope to the CURRENT library (the shelf lives under this library's
      // header — cross-library rows read as leaks) and require an ebook.
      // The candidate ids come from the global mediaProgress map, so the
      // libraryId check is what keeps other libraries' books out.
      const filtered = fetchedItems.filter(
        (item: any) => item.libraryId === libId && hasEbook(item)
      );

      if (isCurrent()) {
        try { storage.set(`continueReadingCache_${libId}`, JSON.stringify(filtered)); } catch {}
        setContinueReadingItems(filtered);
      }
    } catch (e) {
      console.warn("[Bookshelf] failed to load continue reading items", e);
    } finally {
      endLoad();
    }
  };

  // Load the "Want to Read" shelf from the favorites list. Mirrors Continue
  // Reading: ONE batch item fetch for the favorite ids (per-item fallback for
  // older servers), scoped to the current library. Purely additive and
  // resilient — any failure just leaves the shelf empty, never breaking Home.
  const loadWantToRead = async () => {
    const libId = useLibraryStore.getState().currentLibraryId;
    if (!libId) return;
    // Favorites need the server (batch fetch) — skip entirely while offline.
    if (isOfflineRef.current) return;
    const favIds = useFavoritesStore.getState().list();
    const reqId = ++wantToReadReqId.current;
    const isCurrent = () =>
      mountedRef.current && reqId === wantToReadReqId.current && useLibraryStore.getState().currentLibraryId === libId;

    if (favIds.length === 0) {
      if (isCurrent()) setWantToReadItems([]);
      return;
    }

    beginLoad();
    try {
      // Fetch all favorites in ONE batch request (same pattern as Continue
      // Reading), falling back to per-item fetches on servers without batch/get.
      let fetchedItems: any[] = [];
      try {
        const res = await api.post(`/api/items/batch/get`, { libraryItemIds: favIds });
        fetchedItems = res.data?.libraryItems || [];
      } catch (err) {
        console.warn("[Bookshelf] batch item fetch failed (want-to-read), falling back", err);
        const itemRequests = favIds.map(async (id) => {
          try {
            const r = await api.get(`/api/items/${id}`);
            return r.data;
          } catch {
            return null;
          }
        });
        fetchedItems = (await Promise.all(itemRequests)).filter(Boolean);
      }

      // Scope to the CURRENT library — the shelf lives under this library's
      // header, and favorites can span libraries. Favorites are books the user
      // wants to read (audio or ebook), so no media-type filter is applied.
      const filtered = fetchedItems.filter((item: any) => item && item.libraryId === libId);
      if (isCurrent()) setWantToReadItems(filtered);
    } catch (e) {
      console.warn("[Bookshelf] failed to load want-to-read items", e);
    } finally {
      endLoad();
    }
  };

  // "Started/finished" test used both for building affinity (which genres the
  // user engages with) and for excluding books they've already touched from the
  // recommendation.
  const hasProgress = (p: any) =>
    !!p && (p.isFinished || Number(p.progress || 0) > 0 || Number(p.ebookProgress || 0) > 0);

  // Build the "Because you listened" shelf. Resilient by design: any missing
  // piece (offline, no affinity, empty/failed query) just clears the shelf.
  const loadAffinity = async () => {
    const libId = useLibraryStore.getState().currentLibraryId;
    if (!libId) return;
    const reqId = ++affinityReqId.current;
    const isCurrent = () =>
      mountedRef.current && reqId === affinityReqId.current && useLibraryStore.getState().currentLibraryId === libId;
    // Offline (or the "audiobooks only" setting) → no recommendation shelf.
    if (isOfflineRef.current || useUserStore.getState().settings?.hideNonAudiobooksGlobal) {
      if (isCurrent()) setAffinityShelf(null);
      return;
    }
    beginLoad();
    try {
      const mp = useUserStore.getState().mediaProgress || {};
      // Tally genres over every book the user has engaged with that we already
      // have metadata for (the loaded shelves + the Continue Reading batch).
      const genreCounts = new Map<string, number>();
      const consider = (item: any) => {
        const id = item?.id;
        if (!id || !hasProgress(mp[id])) return;
        const genres = item?.media?.metadata?.genres;
        if (!Array.isArray(genres)) return;
        for (const g of genres) {
          if (typeof g === "string" && g.trim()) genreCounts.set(g, (genreCounts.get(g) || 0) + 1);
        }
      };
      const shelves = useLibraryStore.getState().personalizedShelves || [];
      shelves.forEach((sh: any) => (Array.isArray(sh?.entities) ? sh.entities : []).forEach(consider));
      // Read the CURRENT continue-reading list via the ref (not the closed-over
      // snapshot) so a stale focus/online-recovery invocation still tallies the
      // latest items.
      continueReadingItemsRef.current.forEach(consider);

      if (genreCounts.size === 0) {
        if (isCurrent()) setAffinityShelf(null);
        return;
      }
      // Top genre by engagement (ties broken alphabetically for stability).
      const topGenre = Array.from(genreCounts.entries()).sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
      )[0][0];

      const res = await api.get(
        `/api/libraries/${libId}/items?filter=genres.${encodeFilterValue(topGenre)}&minified=1&limit=24`
      );
      if (!isCurrent()) return;
      const results = Array.isArray(res.data?.results) ? res.data.results : [];
      // Exclude books already finished/in-progress — the shelf is for what's
      // NEXT, not a re-run of the reading history it was derived from.
      const mpNow = useUserStore.getState().mediaProgress || {};
      const filtered = results.filter(
        (it: any) => it && it.id && !hasProgress(mpNow[it.id])
      );
      if (filtered.length === 0) {
        if (isCurrent()) setAffinityShelf(null);
        return;
      }
      if (isCurrent()) {
        setAffinityShelf({
          id: "because-you-listened",
          label: "Because you listened",
          type: "book",
          entities: filtered,
          // See-all opens the full genre list (same destination as a genre chip).
          libParams: { filter: `genres.${encodeFilterValue(topGenre)}`, showBack: true, title: topGenre },
        });
      }
    } catch {
      // Older server without the filter, transient failure, etc. — stay silent.
      if (isCurrent()) setAffinityShelf(null);
    } finally {
      endLoad();
    }
  };

  // The Continue Listening hide route is keyed by the MEDIA-PROGRESS row id
  // (user.mediaProgress[].id) — NOT the libraryItemId. Podcast rows live under
  // composite `${itemId}-${episodeId}` keys, so try the episode key first.
  const resolveContinueProgress = (item: any) => {
    const mp = useUserStore.getState().mediaProgress || {};
    const epId = item?.recentEpisode?.id;
    return (epId ? mp[`${item?.id}-${epId}`] : null) || mp[item?.id] || item?.userMediaProgress || null;
  };

  // How long the Undo window stays open before the hide is committed to the
  // server — matches the snackbar's visible duration, so Undo works for
  // exactly as long as the affordance is on screen.
  const HIDE_UNDO_MS = 4000;
  // Pending hide commits, keyed by libraryItemId. The server call is DELAYED
  // until the Undo window closes: ABS has no un-hide route (the flag only
  // resets on new listening), so an immediate call could never honor Undo.
  // This is the documented "delay + cancel on Undo" flow — Undo clears the
  // timer and restores the card, and the request then never fires. Timers are
  // deliberately NOT cleared on unmount/library switch: the user asked for the
  // removal, and only Undo cancels it (the commit's setState is mount-guarded).
  const pendingHideTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // Long-press action on a Continue Listening card (Tier-1, no confirm):
  // optimistic removal right away + an Undo snackbar → delayed server hide
  // (progress id) → shelf/progress refetch. Failure restores the card, so the
  // shelf never silently disagrees with the server.
  const promptHideFromContinueListening = (item: any) => {
    const progressId = resolveContinueProgress(item)?.id;
    if (!progressId) {
      // Without the media-progress row id the server route can't be addressed
      // (e.g. a shelf payload that raced the progress fetch) — never guess.
      showSnackbar({ message: "Can't hide this right now — pull to refresh and try again." });
      return;
    }
    const itemId = item?.id;
    if (!itemId || pendingHideTimers.current[itemId]) return;
    // Optimistic: the card disappears immediately; Undo (or a failure) restores it.
    setHiddenContinueIds((prev) => (prev.includes(itemId) ? prev : [...prev, itemId]));
    const commit = async () => {
      delete pendingHideTimers.current[itemId];
      try {
        await hideFromContinueListening(progressId);
        // Converge with the server: the refreshed shelf no longer carries
        // the hidden entry, and the progress map picks up the flag.
        loadPersonalizedShelves(true).catch(() => {});
        loadMediaProgress().catch(() => {});
      } catch (e: any) {
        // Restore the optimistically-removed card — the hide didn't land.
        if (mountedRef.current) {
          setHiddenContinueIds((prev) => prev.filter((id) => id !== itemId));
        }
        showSnackbar({ message: e?.message || "Couldn't remove it. Try again." });
      }
    };
    pendingHideTimers.current[itemId] = setTimeout(commit, HIDE_UNDO_MS);
    showSnackbar({
      message: "Removed from Continue Listening",
      durationMs: HIDE_UNDO_MS,
      action: {
        label: "Undo",
        onPress: () => {
          const t = pendingHideTimers.current[itemId];
          if (t) {
            clearTimeout(t);
            delete pendingHideTimers.current[itemId];
          }
          setHiddenContinueIds((prev) => prev.filter((id) => id !== itemId));
        },
      },
    });
  };

  // Prune hidden ids that the server no longer surfaces at all: once a
  // refetched shelf list omits an id (the hide converged, or the entry aged
  // out), keeping it in hiddenContinueIds would suppress the book for the rest
  // of the session even if the server legitimately RE-surfaces it (new
  // listening resets the flag). Ids still present on either continue shelf are
  // kept — that's the optimistic window doing its job.
  useEffect(() => {
    setHiddenContinueIds((prev) => {
      if (prev.length === 0) return prev;
      const present = new Set<string>();
      for (const sh of personalizedShelves) {
        if (sh?.id !== "continue-listening" && sh?.id !== "continue-reading") continue;
        (Array.isArray(sh?.entities) ? sh.entities : []).forEach((e: any) => {
          if (e?.id) present.add(e.id);
        });
      }
      const next = prev.filter((id) => present.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [personalizedShelves]);

  // Bumped by pull-to-refresh so the series-list effect below revalidates too
  // (otherwise Continue Series folders keep stale covers/counts).
  const [seriesRefreshTick, setSeriesRefreshTick] = useState(0);

  const onRefresh = async () => {
    setRefreshing(true);
    setSeriesRefreshTick((t) => t + 1);
    try {
      // Reload the library list FIRST so a refresh can recover a lost/wrong
      // currentLibraryId. If a transient empty /api/libraries had nulled it,
      // loadPersonalizedShelves early-returns and the pull gesture would
      // otherwise be a no-op for shelves — the exact "refresh doesn't fix it"
      // symptom. force=true bypasses the 5-minute throttle.
      await loadLibraries(true).catch(() => {});
      await Promise.all([loadPersonalizedShelves(true), loadMediaProgress()]);
      await loadContinueReading();
      loadWantToRead();
      loadAffinity();
    } finally {
      setRefreshing(false);
    }
  };

  // Always-latest handlers, so long-lived effects (focus / online-recovery) call
  // the freshest loader closures instead of ones captured at a stale render.
  const handlersRef = useRef({ loadContinueReading, loadAffinity, onRefresh });
  handlersRef.current = { loadContinueReading, loadAffinity, onRefresh };

  // Coming back online: flush queued offline progress and refresh the shelves
  // so the transition back is seamless (no manual pull-to-refresh needed).
  const wasOffline = React.useRef(false);
  useEffect(() => {
    if (isOffline) {
      wasOffline.current = true;
    } else if (wasOffline.current) {
      wasOffline.current = false;
      flushPendingSyncs().catch(() => {});
      handlersRef.current.onRefresh();
    }
  }, [isOffline]);

  // Library switch: swap Continue Reading to the new library's cache right
  // away (matches how the store swaps the shelves cache).
  const prevLibraryRef = React.useRef(currentLibraryId);
  useEffect(() => {
    if (prevLibraryRef.current !== currentLibraryId) {
      prevLibraryRef.current = currentLibraryId;
      setContinueReadingItems(readContinueReadingCache(currentLibraryId));
      // The affinity shelf is a per-library recommendation — never carry the
      // old library's genre picks under the new library's header.
      setAffinityShelf(null);
      // Want to Read is scoped to the current library — clear the old library's
      // items so they don't flash under the new header before the refetch lands.
      setWantToReadItems([]);
      // Optimistically-hidden Continue Listening entries belong to the OLD
      // library's shelf — never suppress the new library's cards by shared id.
      setHiddenContinueIds([]);
      // Shelf GEOMETRY caches are keyed by bare shelf.id, which repeats across
      // libraries (recently-added, continue-listening, …) while the rows now
      // remount per-library. Without a reset, the new library's rows briefly
      // reuse the OLD library's viewport/content widths — flashing the "See
      // all" chevron (and overflow state) incorrectly until fresh onLayout /
      // onContentSizeChange measurements land.
      shelfViewportW.current = {};
      shelfContentW.current = {};
      setShelfOverflow({});
    }
  }, [currentLibraryId]);

  useEffect(() => {
    const initData = async () => {
      setLoading(true);
      // currentLibraryId is seeded synchronously from MMKV, so on warm starts
      // shelves/progress fetch immediately — loadLibraries runs in PARALLEL
      // (it only re-picks the library if the saved one disappeared, which
      // re-runs this effect via the currentLibraryId change).
      if (currentLibraryId) {
        // Everything fans out in parallel. Continue Reading only needs
        // mediaProgress, so it chains off that alone (it used to also wait for
        // the shelves fetch) and doesn't hold the skeleton gate. The series
        // list for Continue Series has its own parallel effect.
        const librariesPromise = loadLibraries().catch(() => {});
        const progressPromise = loadMediaProgress();
        progressPromise.then(() => loadContinueReading()).catch(() => {});
        await Promise.all([loadPersonalizedShelves(), progressPromise]);
        // Affinity needs both the shelves (for genres) and progress — run it
        // once both have landed. It's fire-and-forget and never gates the UI.
        loadAffinity();
        await librariesPromise;
      } else {
        // True first run: discover libraries first (sets currentLibraryId,
        // which re-runs this effect and takes the fast path above).
        await loadLibraries();
      }
      setLoading(false);
    };
    initData();
  }, [currentLibraryId]);

  // (Re)load the Want to Read shelf whenever the favorites list, the current
  // library, or connectivity changes. This alone keeps the shelf in sync with
  // (un)favoriting done from ItemDetail — the store subscription re-renders and
  // this effect re-fetches — so it doesn't need to piggyback on initData/focus.
  useEffect(() => {
    loadWantToRead();
  }, [favoriteIds, currentLibraryId, isOffline]);

  // Refresh progress (and the Continue Reading shelf derived from it) when
  // returning to the tab — skipping the initial-mount focus event, which
  // would double up initData's identical fetches at startup.
  const firstFocusRef = React.useRef(true);
  useEffect(() => {
    const unsubscribe = navigation.addListener("focus", () => {
      if (firstFocusRef.current) {
        firstFocusRef.current = false;
        return;
      }
      // Route through the handlers ref so focus always runs the freshest loaders
      // (against the current library/progress), not closures from mount time.
      loadMediaProgress().then(() => {
        handlersRef.current.loadContinueReading();
        handlersRef.current.loadAffinity();
      });
    });
    return unsubscribe;
  }, [navigation, loadMediaProgress]);

  const serverAddress = serverConnectionConfig?.address?.replace(/\/$/, "") || "";
  const token = serverConnectionConfig?.token || "";

  const getCoverUrl = (id: string) => {
    if (!id || !serverAddress || !token) return null;
    return `${serverAddress}/api/items/${id}/cover?width=400&format=webp&token=${token}`;
  };

  const getAuthorImageUrl = (author: any) => {
    if (!author?.imagePath || !author?.id || !serverAddress || !token) return null;
    return `${serverAddress}/api/authors/${author.id}/image?width=400&format=webp&token=${token}`;
  };

  const activeShelves = personalizedShelves;

  // "Continue Series" rendered as series folders (open the series list), merged
  // from the server's continue-series shelf (next book per series) AND the
  // in-progress books in continue-listening — so a series you're currently
  // reading also shows up. In-progress books only carry a `seriesName` string,
  // so we resolve their series id via the library's series list (one fetch).
  const [continueSeries, setContinueSeries] = useState<any[]>([]);

  // The library's series list — needed to resolve series names → ids for the
  // Continue Series shelf. Fetched at MOUNT (parallel with shelves/progress,
  // it doesn't depend on them) and cached per library, so the build below is
  // purely synchronous.
  const [seriesList, setSeriesList] = useState<any[]>(() => {
    const libId = useLibraryStore.getState().currentLibraryId;
    if (!libId) return [];
    try {
      const raw = storage.getString(`seriesListCache_${libId}`);
      const parsed = raw ? JSON.parse(raw) : null;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    let cancelled = false;
    if (!currentLibraryId) {
      setSeriesList([]);
      return;
    }
    // Swap to this library's cache immediately, then revalidate from network.
    try {
      const raw = storage.getString(`seriesListCache_${currentLibraryId}`);
      const cached = raw ? JSON.parse(raw) : null;
      if (Array.isArray(cached)) setSeriesList(cached);
    } catch {}
    (async () => {
      try {
        const r = await api.get(`/api/libraries/${currentLibraryId}/series?limit=1000&minified=1`);
        const fresh = r.data?.results || [];
        try { storage.set(`seriesListCache_${currentLibraryId}`, JSON.stringify(fresh)); } catch {}
        if (!cancelled) setSeriesList(fresh);
      } catch {
        // Offline / transient failure — cached list (if any) stands.
      }
    })();
    return () => { cancelled = true; };
  }, [currentLibraryId, seriesRefreshTick]);

  useEffect(() => {
    // Pure transform: shelves + a series list → ordered continue-series rows.
    const buildFrom = (seriesList: any[]) => {
      // series name (lowercased, without the "#seq" suffix) -> series id
      const nameToId = new Map<string, string>();
      const idToSeries = new Map<string, any>();
      (seriesList || []).forEach((s: any) => {
        if (s?.id) {
          idToSeries.set(s.id, s);
          if (s?.name) nameToId.set(String(s.name).toLowerCase(), s.id);
        }
      });

      const stripSeq = (n: string) => n.replace(/\s+#[\d.]+\s*$/, "").trim();
      const ordered: any[] = [];
      const seen = new Set<string>();
      const push = (id: string, name: string) => {
        if (id && !seen.has(id)) {
          seen.add(id);
          const seriesObj = idToSeries.get(id);
          const seriesBooks = seriesObj?.books || [];
          const covers = seriesBooks.slice(0, 4).map((b: any) => getCoverUrl(b.id)).filter(Boolean);
          ordered.push({
            id,
            name,
            books: seriesBooks,
            covers: covers.length > 0 ? covers : [],
            booksCount: seriesObj?.booksCount || seriesBooks.length || 0,
          });
        }
      };

      // In-progress series first (most active).
      const cl = personalizedShelves.find((s: any) => s.id === "continue-listening");
      (cl?.entities || []).forEach((b: any) => {
        const sn = b?.media?.metadata?.seriesName;
        if (!sn) return;
        const name = stripSeq(sn);
        const id = nameToId.get(name.toLowerCase());
        if (id) push(id, name);
      });
      // Scan read-in-progress series as well!
      continueReadingItems.forEach((b: any) => {
        const sn = b?.media?.metadata?.seriesName;
        if (!sn) return;
        const name = stripSeq(sn);
        const id = nameToId.get(name.toLowerCase());
        if (id) push(id, name);
      });
      // Then between-books series (already carry the id).
      const cs = personalizedShelves.find((s: any) => s.id === "continue-series");
      (cs?.entities || []).forEach((b: any) => {
        const s = b?.media?.metadata?.series;
        const so = Array.isArray(s) ? s[0] : s;
        if (so?.id) push(so.id, so.name);
      });

      return ordered;
    };

    // Fallback when the series-list fetch failed on a cold cache: the
    // server's own continue-series shelf entities carry series ids, so the
    // shelf can still render (single-cover cards) instead of vanishing.
    const buildFromServerShelf = () => {
      const cs = personalizedShelves.find((s: any) => s.id === "continue-series");
      const ordered: any[] = [];
      const seen = new Set<string>();
      (cs?.entities || []).forEach((b: any) => {
        const s = b?.media?.metadata?.series;
        const so = Array.isArray(s) ? s[0] : s;
        if (so?.id && !seen.has(so.id)) {
          seen.add(so.id);
          const cover = getCoverUrl(b?.id);
          ordered.push({
            id: so.id,
            name: so.name || "",
            books: [b],
            covers: cover ? [cover] : [],
            booksCount: 1,
          });
        }
      });
      return ordered;
    };

    // Fully synchronous: the series list arrives via its own parallel fetch
    // above, so this just re-derives whenever any input changes.
    if (personalizedShelves.length === 0 || !currentLibraryId) {
      setContinueSeries([]);
      return;
    }
    if (seriesList.length === 0) {
      setContinueSeries(buildFromServerShelf());
      return;
    }
    setContinueSeries(buildFrom(seriesList));
    // serverConnectionConfig is a dep because buildFrom/buildFromServerShelf call
    // getCoverUrl, whose URLs embed the current server address + token — after a
    // token refresh the covers must rebuild, or they keep the old (401'd) token.
  }, [personalizedShelves, currentLibraryId, continueReadingItems, seriesList, serverConnectionConfig]);

  // Shelf assembly. Structurally deduped by id so "Continue Reading" can never
  // render twice (e.g. a stale cached shelf list racing the fresh one that now
  // includes the server's own continue-reading shelf).
  // Memoized on its real inputs so a playback progress tick (which re-renders
  // the screen via the reactive mediaProgress subscription) doesn't rebuild the
  // whole shelf list every frame.
  const displayShelves = useMemo<any[]>(() => {
    const result: any[] = [];
    const seenShelfIds = new Set<string>();
    // "Hide non-audiobooks": drop the reading shelf entirely and filter
    // ebook-only items out of every book shelf (they appear in Recently
    // Added / Discover etc. regardless of progress).
    const filterEbooks = (entities: any[]) =>
      hideNonAudiobooks ? (entities || []).filter((e: any) => !isEbookOnly(e)) : entities || [];
    // Normalize entities at the boundary: null entries / non-array shapes in
    // a shelf (corrupt cache blob, misbehaving server) crashed the card
    // renderers (`item.id` on null, `.map` on a string).
    const cleanEntities = (ents: any) =>
      Array.isArray(ents) ? ents.filter((e: any) => e && typeof e === "object") : [];
    // "Continue Listening" must reflect AUDIO progress only. The server's
    // shelf includes any in-progress item — including books whose only
    // progress is READING (ebookProgress from the reader) — and those belong
    // exclusively in Continue Reading. Ebook-only items can't be listened to
    // at all. Read non-reactively (getState) so this memo isn't invalidated by
    // every per-tick mediaProgress write.
    const ebookOnlyProgress = (e: any) => {
      const p = useUserStore.getState().mediaProgress[e?.id] || e?.userMediaProgress;
      if (!p) return false;
      const hasAudioProgress = Number(p.currentTime || 0) > 0 || Number(p.progress || 0) > 0;
      const hasEbookProgress = Number(p.ebookProgress || 0) > 0 || !!p.ebookLocation;
      return !hasAudioProgress && hasEbookProgress;
    };
    for (const rawShelf of activeShelves) {
      if (!rawShelf?.id || seenShelfIds.has(rawShelf.id)) continue;
      const shelf = { ...rawShelf, entities: cleanEntities(rawShelf.entities) };
      seenShelfIds.add(shelf.id);
      if (shelf.id === "continue-reading" && hideNonAudiobooks) continue;
      if (shelf.id === "continue-series") {
        result.push({ ...shelf, type: "series", entities: continueSeries });
      } else if (shelf.id === "continue-listening") {
        const entities = (shelf.entities || []).filter(
          (e: any) =>
            !isEbookOnly(e) &&
            !ebookOnlyProgress(e) &&
            // Optimistically hidden via long-press "Remove from Continue
            // Listening" — dropped here until the shelf refetch converges.
            !hiddenContinueIds.includes(e?.id)
        );
        result.push({ ...shelf, entities });
      } else if (shelf.id === "continue-reading") {
        // Prefer the locally-built list (ebook-progress aware); fall back to
        // the server's entities so the shelf shows instantly while ours loads.
        // The hide gate applies here too: the server's hideFromContinueListening
        // flag removes an item from BOTH continue shelves, so the optimistic
        // filter must match until the refetch converges.
        const source = continueReadingItems.length > 0 ? continueReadingItems : shelf.entities || [];
        result.push({
          ...shelf,
          type: "book",
          entities: source.filter((e: any) => !hiddenContinueIds.includes(e?.id)),
        });
      } else if (shelf.type === "authors" || shelf.type === "author" || shelf.type === "series") {
        result.push(shelf);
      } else {
        result.push({ ...shelf, entities: filterEbooks(shelf.entities) });
      }
    }
    // Synthetic Continue Reading ONLY when the server sent none at all
    // (older servers) — inserted right after Continue Listening. Same hide
    // gate as the server-provided shelf above.
    if (!seenShelfIds.has("continue-reading") && continueReadingItems.length > 0 && !hideNonAudiobooks) {
      const idx = result.findIndex((s) => s.id === "continue-listening");
      // When there's no Continue Listening shelf (older server), findIndex
      // returns -1 and idx+1 would force this to the TOP — append instead.
      const insertAt = idx < 0 ? result.length : idx + 1;
      result.splice(insertAt, 0, {
        id: "continue-reading",
        label: "Continue Reading",
        type: "book",
        entities: continueReadingItems.filter((e: any) => !hiddenContinueIds.includes(e?.id)),
      });
    }
    // "Want to Read": the device-local favorites, surfaced near the top of the
    // personalized content (just after the Continue* shelves). Additive and
    // library-scoped; hidden while offline/empty. Favorites are books the user
    // explicitly wants to read (audio OR ebook), so this shelf is EXEMPT from
    // the audiobook-only filter — otherwise ebook favorites would silently
    // vanish under "hide non-audiobooks".
    if (!isOffline && wantToReadItems.length > 0) {
      const wantEntities = wantToReadItems;
      if (wantEntities.length > 0) {
        // Slot it right after the last Continue* shelf so the primary resume
        // actions stay first; falls to the top if there are none.
        let insertAt = 0;
        for (let i = 0; i < result.length; i++) {
          const sid = result[i]?.id;
          if (typeof sid === "string" && sid.startsWith("continue-")) insertAt = i + 1;
        }
        result.splice(insertAt, 0, {
          id: "want-to-read",
          label: "Want to Read",
          type: "book",
          entities: wantEntities,
        });
      }
    }
    // "Because you listened" is purely additive — appended last so it never
    // displaces an existing shelf. Only shown once it has recommendations.
    if (affinityShelf && Array.isArray(affinityShelf.entities) && affinityShelf.entities.length > 0) {
      result.push(affinityShelf);
    }
    return result;
  }, [activeShelves, hideNonAudiobooks, continueSeries, continueReadingItems, wantToReadItems, affinityShelf, isOffline, hiddenContinueIds]);

  // Prune per-shelf geometry state/refs for shelves that have left the list.
  // Otherwise stale entries linger: a chevron can flash from a previous shelf's
  // overflow geometry when an id is reused, and the refs grow unbounded across a
  // long session of library/shelf churn.
  const shelfIdsKey = displayShelves.map((s: any) => s.id).join("|");
  useEffect(() => {
    const ids = new Set(displayShelves.map((s: any) => s.id));
    Object.keys(shelfViewportW.current).forEach((id) => {
      if (!ids.has(id)) delete shelfViewportW.current[id];
    });
    Object.keys(shelfContentW.current).forEach((id) => {
      if (!ids.has(id)) delete shelfContentW.current[id];
    });
    setShelfOverflow((prev) => {
      let changed = false;
      const next: Record<string, boolean> = {};
      for (const id of Object.keys(prev)) {
        if (ids.has(id)) next[id] = prev[id];
        else changed = true;
      }
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shelfIdsKey]);

  const renderBookCard = (item: any, index: number, shelfId?: string) => {
    if (shelfId !== "continue-listening") {
      return (
        <Animated.View
          key={item.id || index}
          entering={shelfCardEnter(index)}
        >
          <BookCard item={item} size={165} navigation={navigation} />
        </Animated.View>
      );
    }
    // Continue Listening cards gain a long-press "Remove from Continue
    // Listening" action. BookCard exposes no long-press, so a transparent
    // overlay Pressable captures the touches instead: tap keeps opening the
    // item, long-press opens the hide confirm. The card underneath is hidden
    // from accessibility so the overlay (which mirrors BookCard's label,
    // status included) is the single accessible element.
    const clTitle = item?.media?.metadata?.title || item?.title || "";
    const clAuthor =
      item?.media?.metadata?.authorName || item?.media?.metadata?.author || item?.author || "";
    const clLabel = [
      clAuthor ? `${clTitle} by ${clAuthor}` : clTitle || "Book",
      bookStatusA11yLabel(
        item,
        useUserStore.getState().mediaProgress,
        !!useDownloadStore.getState().completedDownloads?.[item?.id]
      ),
    ]
      .filter(Boolean)
      .join(". ");
    return (
      <Animated.View
        key={item.id || index}
        entering={shelfCardEnter(index)}
      >
        <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
          <BookCard item={item} size={165} navigation={navigation} />
        </View>
        <Pressable
          onPress={() => {
            if (item?.id) navigation.navigate("ItemDetail", { itemId: item.id });
          }}
          onLongPress={() => promptHideFromContinueListening(item)}
          accessibilityRole="button"
          accessibilityLabel={clLabel}
          accessibilityHint="Long press to remove from Continue Listening"
          // TalkBack users shouldn't depend on long-press timing — expose the
          // shelf action as a standard custom accessibility action too.
          accessibilityActions={[{ name: "longpress", label: "Remove from Continue Listening" }]}
          onAccessibilityAction={(e) => {
            if (e.nativeEvent.actionName === "longpress") promptHideFromContinueListening(item);
          }}
          // Match BookCard's footprint (165² with 4dp horizontal margins).
          style={{ position: "absolute", top: 0, bottom: 0, left: 4, right: 4, borderRadius: 20 }}
        />
      </Animated.View>
    );
  };

  const renderSeriesCard = (series: any, index: number) => {
    const cardSize = 165;
    // Real personalized "series" entities carry a `books` array; fall back to
    // mock `covers`. Build cover URLs from book ids.
    const books = series.books || [];
    const covers = series.covers
      ? series.covers
      : books.slice(0, 4).map((b: any) => getCoverUrl(b.id)).filter(Boolean);
    const bookCount = series.booksCount || books.length || 0;
    // Top-right badge = UNFINISHED count ("N left") — the bottom line already
    // shows the total, so repeating it here displayed the same number twice.
    // Only computable when the FULL book list is present; a partial list would
    // undercount, so hide the badge instead of guessing.
    let unread: number | null = null;
    if (books.length && (!bookCount || books.length >= bookCount)) {
      // Reactive read (mediaProgressMap) so the "N left" badge updates when a
      // book in the series is finished, instead of a non-reactive getState()
      // snapshot that only refreshed on an unrelated re-render.
      unread = books.filter((b: any) => !(mediaProgressMap[b.id] || b.userMediaProgress)?.isFinished).length;
    }

    return (
      <AnimatedPressable
        key={series.id || index}
        entering={shelfCardEnter(index)}
        onPress={() =>
          navigation.navigate("SeriesDetail", { seriesId: series.id, seriesName: series.name || series.title })
        }
        android_ripple={{ color: withAlpha(colors.onSurface, 0.12) }}
        accessibilityRole="button"
        accessibilityLabel={`Series: ${series.name || series.title}`}
        style={{
          width: cardSize,
          height: cardSize,
          borderRadius: 20,
          marginHorizontal: 4,
          overflow: "hidden",
          position: "relative",
          backgroundColor: colors.surfaceContainerHighest,
          elevation: 1,
        }}
      >
        {/* Cover: single books show full-bleed; multiple form a 2x2 collage. */}
        {covers.length === 1 ? (
          <Image
            source={coverSource(covers[0])}
            style={{ width: "100%", height: "100%" }}
            contentFit="cover"
          />
        ) : (
          <View style={{ flexDirection: "row", flexWrap: "wrap", width: "100%", height: "100%" }}>
            {covers.slice(0, 4).map((coverUri: string, idx: number) => (
              <Image
                key={idx}
                source={coverSource(coverUri)}
                // 2 covers: full-height halves (no empty bottom row) — matches
                // the playlist/series-detail collage treatment.
                style={{ width: cardSize / 2, height: covers.length <= 2 ? cardSize : cardSize / 2 }}
                contentFit="cover"
              />
            ))}
            {covers.length === 0 && (
              <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.surfaceContainerHighest }}>
                <Icon name="series" size={40} color={colors.onSurfaceVariant} />
              </View>
            )}
          </View>
        )}

        {/* Unread badge (top right): "N left" while the series is in progress,
            a check once every book is finished. The bottom panel shows the
            TOTAL, so this pill only carries remaining-progress info. */}
        {unread != null ? (
          <View
            style={{
              position: "absolute",
              top: 8,
              right: 8,
              paddingHorizontal: 8,
              paddingVertical: 3,
              zIndex: 10,
              flexDirection: "row",
              alignItems: "center",
              backgroundColor: unread > 0 ? colors.secondaryContainer : colors.tertiaryContainer,
              borderRadius: 20,
            }}
            accessibilityLabel={unread > 0 ? `${unread} books left` : "Series finished"}
          >
            {unread > 0 ? (
              <Text style={{ color: colors.onSecondaryContainer, fontSize: 11, fontWeight: "bold" }}>
                {unread} left
              </Text>
            ) : (
              <Icon name="check" size={13} color={colors.onTertiaryContainer} />
            )}
          </View>
        ) : null}

        {/* Bottom gradient meta panel */}
        <LinearGradient
          colors={["transparent", "rgba(0,0,0,0.55)", "rgba(0,0,0,0.85)"]}
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            paddingTop: 24,
            paddingBottom: 12,
            paddingHorizontal: 12,
            zIndex: 10,
          }}
        >
          <Text numberOfLines={1} style={{ color: "#FFFFFF", fontWeight: "700", fontSize: 15, letterSpacing: -0.1 }}>
            {series.name || series.title}
          </Text>
          {bookCount ? (
            <View style={{ flexDirection: "row", alignItems: "center", marginTop: 2 }}>
               <Icon name="book" size={12} color="rgba(255,255,255,0.7)" />
              <Text numberOfLines={1} style={{ color: "rgba(255,255,255,0.7)", fontSize: 12, fontWeight: "500", marginLeft: 4 }}>
                {bookCount} {bookCount === 1 ? "Book" : "Books"}
              </Text>
            </View>
          ) : null}
        </LinearGradient>
      </AnimatedPressable>
    );
  };

  const renderAuthorCard = (author: any, index: number) => {
    const cardSize = 165;
    const imageUri = getAuthorImageUrl(author);
    const numBooks = author.numBooks || 0;

    return (
      <AnimatedPressable
        key={author.id || index}
        entering={shelfCardEnter(index)}
        onPress={() =>
          navigation.navigate("AuthorDetail", {
            authorId: author.id,
            authorName: author.name || author.title || "Unknown Author",
          })
        }
        android_ripple={{ color: withAlpha(colors.onSurface, 0.12) }}
        accessibilityRole="button"
        accessibilityLabel={`Author: ${author.name || author.title || "Unknown Author"}`}
        style={{
          width: cardSize,
          height: cardSize,
          borderRadius: 20,
          marginHorizontal: 4,
          overflow: "hidden",
          position: "relative",
          backgroundColor: colors.surfaceContainerHighest,
          elevation: 1,
        }}
      >
        {/* Author Image or Placeholder */}
        {imageUri ? (
          <Image
            source={coverSource(imageUri)}
            style={{ width: "100%", height: "100%" }}
            contentFit="cover"
          />
        ) : (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.surfaceContainerHighest }}>
            <Icon name="person" size={44} color={colors.onSurfaceVariant} />
          </View>
        )}

        {/* Bottom gradient meta panel */}
        <LinearGradient
          colors={["transparent", "rgba(0,0,0,0.55)", "rgba(0,0,0,0.85)"]}
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            paddingTop: 24,
            paddingBottom: 12,
            paddingHorizontal: 12,
            zIndex: 10,
          }}
        >
          <Text numberOfLines={1} style={{ color: "#FFFFFF", fontWeight: "700", fontSize: 15, letterSpacing: -0.1 }}>
            {author.name || author.title || "Unknown Author"}
          </Text>
          {numBooks ? (
            <View style={{ flexDirection: "row", alignItems: "center", marginTop: 2 }}>
              <Icon name="book" size={12} color="rgba(255,255,255,0.7)" />
              <Text numberOfLines={1} style={{ color: "rgba(255,255,255,0.7)", fontSize: 12, fontWeight: "500", marginLeft: 4 }}>
                {numBooks} {numBooks === 1 ? "Book" : "Books"}
              </Text>
            </View>
          ) : null}
        </LinearGradient>
      </AnimatedPressable>
    );
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }} edges={["top", "left", "right"]}>
      <TopAppBar navigation={navigation} hideSearch={isOffline} />
      {isOffline ? (
        // Offline: the server is unreachable, so show the on-device library.
        // Covers come from the locally-downloaded cover file, playback falls
        // back to the offline local-session path automatically.
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingTop: 16, paddingBottom: hasSession ? 100 : 32 }}>
          <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingBottom: 8 }}>
            <View style={{ width: 5, height: 22, borderRadius: 3, marginRight: 10, backgroundColor: colors.primary }} />
            <Text style={{ color: colors.onSurface, fontFamily: "serif", fontWeight: "700", fontSize: 21 }}>
              Available Offline
            </Text>
          </View>
          {!downloadsLoaded ? (
            // DB hydration hasn't landed yet (cold offline start) — a blank
            // beat beats flashing "No downloaded books" at someone whose
            // library is sitting right there on disk.
            <View style={{ paddingTop: 80 }} />
          ) : Object.values(completedDownloads).length === 0 ? (
            <View style={{ alignItems: "center", paddingTop: 80, paddingHorizontal: 32 }}>
              <Icon name="cloud-off" size={48} color={colors.onSurfaceVariant} />
              <Text style={{ color: colors.onSurface, fontSize: 17, fontWeight: "600", marginTop: 16, textAlign: "center" }}>
                No downloaded books
              </Text>
              <Text style={{ color: colors.onSurfaceVariant, fontSize: 14, marginTop: 6, textAlign: "center" }}>
                You're offline and nothing is downloaded yet. Books you download will play here without a connection.
              </Text>
            </View>
          ) : (
            Object.values(completedDownloads).map((dl: any) => {
              const localCover = (dl.parts || []).find((p: any) => p.id === "cover")?.localFilePath;
              // Ebook-only downloads (no audio tracks) open in the Reader —
              // startPlayback would reset the player into an empty queue.
              const ebookPart = (dl.parts || []).find((p: any) => p.id === "ebook");
              const isEbookOnly = !dl?.meta?.tracks?.length && !!ebookPart;
              const openOffline = async () => {
                if (isEbookOnly) {
                  const filename: string = ebookPart?.filename || "book.epub";
                  navigation.navigate("Reader", {
                    itemId: dl.libraryItemId || dl.id,
                    ebookFormat: filename.split(".").pop() || "epub",
                    title: dl.title,
                  });
                  return;
                }
                // Guard against a double-tap starting two sessions, and catch a
                // rejected start so it doesn't surface as an unhandled rejection.
                if (offlineStartingRef.current) return;
                offlineStartingRef.current = true;
                try {
                  await startPlayback(dl.libraryItemId || dl.id);
                } catch (e) {
                  console.warn("[Bookshelf] offline playback start failed", e);
                } finally {
                  offlineStartingRef.current = false;
                }
              };
              return (
                <Pressable
                  key={dl.id}
                  onPress={openOffline}
                  android_ripple={{ color: colors.surfaceContainerHighest }}
                  accessibilityRole="button"
                  accessibilityLabel={`${isEbookOnly ? "Read" : "Play"} ${dl.title} offline`}
                  style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 10 }}
                >
                  <View style={{ width: 64, height: 64, borderRadius: 10, overflow: "hidden", backgroundColor: colors.surfaceContainerHighest }}>
                    {localCover ? (
                      <Image source={coverSource(localCover)} style={{ width: 64, height: 64 }} contentFit="cover" />
                    ) : (
                      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
                        <Icon name="book" size={26} color={colors.onSurfaceVariant} />
                      </View>
                    )}
                  </View>
                  <View style={{ flex: 1, marginLeft: 14, marginRight: 8 }}>
                    <Text numberOfLines={1} style={{ color: colors.onSurface, fontSize: 16, fontWeight: "600" }}>
                      {dl.title}
                    </Text>
                    {dl.author ? (
                      <Text numberOfLines={1} style={{ color: colors.onSurfaceVariant, fontSize: 13, marginTop: 2 }}>
                        {dl.author}
                      </Text>
                    ) : null}
                  </View>
                  <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" }}>
                    {/* Ebook-only rows open the Reader, not the player. */}
                    <Icon name={isEbookOnly ? "book" : "play"} size={22} color={colors.onPrimary} />
                  </View>
                </Pressable>
              );
            })
          )}
        </ScrollView>
      ) : isSearchActive ? (
        <SearchContent navigation={navigation} />
      ) : loading && personalizedShelves.length === 0 ? (
        <ShelfSkeleton />
      ) : (
        // Soft fade when the shelves replace the skeleton (or first mount) —
        // avoids the hard cut between loading and content states.
        <Animated.ScrollView
          entering={FadeIn.duration(200)}
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingTop: 16, paddingBottom: hasSession ? 100 : 32, flexGrow: 1 }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              colors={[colors.primary]}
              progressBackgroundColor={colors.surfaceContainerHigh}
            />
          }
        >
          {/* Podcast libraries: entry point to the recent-episodes screen,
              which nothing else navigates to. Gated to podcast libraries so a
              book library never shows a dead "Latest Episodes" affordance. */}
          {isPodcastLibrary ? (
            <Pressable
              onPress={() => navigation.navigate("LatestEpisodes")}
              android_ripple={{ color: withAlpha(colors.onSurface, 0.08) }}
              accessibilityRole="button"
              accessibilityLabel="Latest Episodes"
              style={{
                flexDirection: "row",
                alignItems: "center",
                marginHorizontal: 16,
                marginBottom: 8,
                paddingHorizontal: 16,
                paddingVertical: 14,
                borderRadius: 20,
                overflow: "hidden",
                backgroundColor: colors.secondaryContainer,
              }}
            >
              <View
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 20,
                  backgroundColor: withAlpha(colors.onSecondaryContainer, 0.12),
                  alignItems: "center",
                  justifyContent: "center",
                  marginRight: 14,
                }}
              >
                <Icon name="podcast" size={22} color={colors.onSecondaryContainer} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.onSecondaryContainer, fontSize: 16, fontWeight: "700" }}>
                  Latest Episodes
                </Text>
                <Text style={{ color: colors.onSecondaryContainer, fontSize: 13, marginTop: 2, opacity: 0.8 }}>
                  Recent episodes across this library's podcasts
                </Text>
              </View>
              <Icon name="chevron-right" size={24} color={colors.onSecondaryContainer} />
            </Pressable>
          ) : null}
          {/* Loaded but nothing to shelve (fresh/empty library): a real empty
              state instead of a blank scroll area. RefreshControl stays live
              (flexGrow centers this within the scrollable viewport). */}
          {!displayShelves.some((s: any) => s.entities && s.entities.length > 0) ? (
            shelvesLoadError ? (
              // The fetch FAILED and there's no cache to show — an error
              // disguised as an empty library sends the user hunting through
              // their server for missing books.
              <ErrorState
                style={{ flex: 1 }}
                title="Couldn't load your library"
                message="Check your connection to the server, then try again."
                onRetry={() => loadPersonalizedShelves(true)}
              />
            ) : !loading && pendingLoads === 0 ? (
              // Only a TRUE empty library, not a transient gap: the async-built
              // shelves (continue-reading/want-to-read/affinity) can land a beat
              // after the sync shelves, so suppress the empty state while any of
              // those loaders are still in flight — otherwise it flashes.
              <EmptyState
                style={{ flex: 1 }}
                icon="library"
                title="Nothing on the shelf yet"
                message="Books added to this library will show up here. Pull down to refresh."
              />
            ) : null
          ) : null}
          {displayShelves.map((shelf: any) => {
            // Dispatch by shelf type. We transform "Continue Series" into a
            // series-type shelf (folders that open the series list).
            const isSeriesType = shelf.type === "series";
            // Never render a shelf header with nothing under it — async-built
            // shelves (Continue Reading/Series) simply appear once populated.
            if (!shelf.entities || shelf.entities.length === 0) return null;

            const shelfLabel = shelf.label || shelf.name;
            const libParams = shelfToLibraryParams(shelf);
            // Only offer "see all" when the row actually overflows the screen —
            // a row that already shows all its items has nothing more to reveal.
            const showSeeAll = !!libParams && !!shelfOverflow[shelf.id];

            return (
              // Fade the shelf in when it (later) appears. No layout transition:
              // displayShelves mutates repeatedly after first paint (Continue
              // Reading/Want to Read/affinity/Continue Series all arrive async),
              // and racing LinearTransition animations could commit a stale
              // resting offset that Reanimated then drives directly — leaving
              // two rows overlapping until a fresh mount. Plain flex flow can't
              // leave rows stacked on top of each other.
              <Animated.View
                // Key by library + shelf id: shelf ids like "recently-added"
                // exist in every library, so keying on the id alone reconciled
                // across a library switch (FadeIn never replayed and each row
                // kept the previous library's horizontal scroll offset). The
                // library prefix forces a remount instead.
                key={`${currentLibraryId}:${shelf.id}`}
                entering={FadeIn.duration(220)}
                style={{ width: "100%", position: "relative", paddingBottom: 4 }}
              >
                {/* Shelf header: teal rounded accent bar + prominent title. When
                    the shelf maps to a Library sort/filter AND its row overflows,
                    the whole header is a Pressable with a trailing chevron that
                    opens the full filtered list. */}
                {showSeeAll ? (
                  <Pressable
                    onPress={() => navigation.navigate("Library", libParams)}
                    android_ripple={{ color: withAlpha(colors.onSurface, 0.08) }}
                    accessibilityRole="button"
                    accessibilityLabel={`${shelfLabel}, see all`}
                    style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 }}
                  >
                    <View
                      style={{ width: 5, height: 22, borderRadius: 3, marginRight: 10, backgroundColor: colors.primary }}
                    />
                    <Text
                      style={{ flex: 1, color: colors.onSurface, fontFamily: "serif", fontWeight: "700", fontSize: 21, letterSpacing: 0 }}
                    >
                      {shelfLabel}
                    </Text>
                    <Icon name="chevron-right" size={24} color={colors.onSurfaceVariant} />
                  </Pressable>
                ) : (
                  <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 }}>
                    <View
                      style={{ width: 5, height: 22, borderRadius: 3, marginRight: 10, backgroundColor: colors.primary }}
                    />
                    <Text
                      style={{ color: colors.onSurface, fontFamily: "serif", fontWeight: "700", fontSize: 21, letterSpacing: 0 }}
                    >
                      {shelfLabel}
                    </Text>
                  </View>
                )}

                {/* Horizontal shelf row (flex items-end px-3). Viewport +
                    content widths drive the header's "see all" arrow (overflow). */}
                <ScrollView
                  horizontal
                  testID={`shelf-row-${shelf.id}`}
                  showsHorizontalScrollIndicator={false}
                  onLayout={(e) => {
                    shelfViewportW.current[shelf.id] = e.nativeEvent.layout.width;
                    recomputeShelfOverflow(shelf.id);
                  }}
                  onContentSizeChange={(w) => {
                    shelfContentW.current[shelf.id] = w;
                    recomputeShelfOverflow(shelf.id);
                  }}
                  // Stable minHeight matching the fixed card size (165) so a
                  // late cover image load can't change the row's height after
                  // first paint (which previously fed the layout animation stale
                  // geometry). Cards are fixed-size, so this is a safe floor.
                  contentContainerStyle={{ paddingHorizontal: 12, alignItems: "flex-end", minHeight: 165 }}
                >
                  {shelf.entities?.map((entity: any, index: number) => {
                    if (isSeriesType) {
                      return renderSeriesCard(entity, index);
                    } else if (shelf.type === "authors" || shelf.type === "author") {
                      return renderAuthorCard(entity, index);
                    } else {
                      return renderBookCard(entity, index, shelf.id);
                    }
                  })}
                </ScrollView>
              </Animated.View>
            );
          })}
          {/* Browse genres/tags entry point — opens the searchable genre list
              (the only navigation to it). Rendered AFTER the personalized
              shelves so the primary resume actions (Continue Listening/Reading)
              are never pushed below the fold; a lightweight bordered row so it
              reads as a secondary browse affordance at the end of the scroll. */}
          <Pressable
            onPress={() => navigation.navigate("GenreBrowse")}
            android_ripple={{ color: withAlpha(colors.onSurface, 0.08) }}
            accessibilityRole="button"
            accessibilityLabel="Browse genres"
            style={{
              flexDirection: "row",
              alignItems: "center",
              marginHorizontal: 16,
              marginTop: 8,
              marginBottom: 8,
              paddingHorizontal: 16,
              paddingVertical: 12,
              borderRadius: 20,
              borderWidth: 1,
              borderColor: colors.outlineVariant,
            }}
          >
            <View
              style={{
                width: 36,
                height: 36,
                borderRadius: 18,
                backgroundColor: colors.surfaceContainerHighest,
                alignItems: "center",
                justifyContent: "center",
                marginRight: 14,
              }}
            >
              <Icon name="explore" size={20} color={colors.onSurface} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.onSurface, fontSize: 15, fontWeight: "700" }}>
                Browse genres
              </Text>
              <Text style={{ color: colors.onSurfaceVariant, fontSize: 12, marginTop: 1 }}>
                Explore this library by genre and tag
              </Text>
            </View>
            <Icon name="chevron-right" size={22} color={colors.onSurfaceVariant} />
          </Pressable>
        </Animated.ScrollView>
      )}
    </SafeAreaView>
  );
}
