import React, { useEffect, useState, useRef, useCallback } from "react";
import { View, Text, Pressable, ScrollView, RefreshControl } from "react-native";
import { Image } from "expo-image";
import { coverSource } from "../utils/coverSource";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import Animated, { FadeIn, LinearTransition } from "react-native-reanimated";
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

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

// Map a personalized shelf to the Library-tab sort/filter that shows the rest
// of it (each shelf is a capped horizontal scroll, so its tail is otherwise
// unreachable). Returns null for shelves with no sensible full-list mapping —
// those stay non-pressable.
// Maps a home shelf to its "see all" destination on the Library hub tab. The hub
// consumes `filter`/`orderBy`/`descending` (seeds the Books facet) and `segment`
// (switches to the Series/Authors facet). Series/author shelves and Continue
// Reading all resolve to a destination here; a shelf with no sensible full-list
// view returns null. Returning a destination does NOT by itself make the header
// pressable — the call site also requires the row to overflow (see `showSeeAll`);
// a null return is what unconditionally leaves a header non-pressable.
function shelfToLibraryParams(shelf: any): Record<string, any> | null {
  // Synthetic shelves (e.g. the "Because you listened" affinity shelf) can
  // carry an explicit destination — honor it before the id/type heuristics.
  if (shelf?.libParams) return shelf.libParams;
  // Series/author shelves (incl. the transformed "Continue Series") open the
  // matching browse segment rather than a books filter.
  if (shelf?.type === "series") return { segment: "series" };
  if (shelf?.type === "authors" || shelf?.type === "author") return { segment: "authors" };
  switch (shelf?.id) {
    case "recently-added":
      return { orderBy: "addedAt", descending: true };
    // The ABS "Discover" shelf is a random sampling of the library — there's no
    // "see all random books", so its see-all opens the full library browse (the
    // Library hub's Books facet, default sort) where the rest of the catalog is
    // reachable. An empty destination is truthy, so the header still becomes a
    // pressable "see all" once the row overflows (see the `showSeeAll` gate).
    case "discover":
      return {};
    // Continue Reading is in-progress books too (its rows are ebooks-in-progress;
    // ABS filters are single-valued, so "in progress" is the closest full-list
    // match) — give it the same destination as Continue Listening.
    case "continue-listening":
    case "continue-reading":
      return { filter: `progress.${encodeFilterValue("in-progress")}` };
    case "listen-again":
      return { filter: `progress.${encodeFilterValue("finished")}` };
    default:
      return null;
  }
}

export default function BookshelfScreen({ navigation }: any) {
  const colors = useThemeColors();
  const hasSession = usePlaybackStore((s) => s.currentSession !== null);
  const { serverConnectionConfig } = useUserStore();
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
    // +4px slack so sub-pixel rounding on an exactly-fitting row isn't "overflow".
    const over = vw > 0 && cw > vw + 4;
    setShelfOverflow((prev) => (prev[id] === over ? prev : { ...prev, [id]: over }));
  }, []);
  // `isOffline` is the derived, debounced "effectively offline" signal (also
  // true for a captive portal / reachable-Wi-Fi-but-unreachable-server), which
  // the whole-screen offline gating below relies on so those cases actually
  // show the downloaded library instead of hanging on failed fetches.
  const { isOffline } = useNetworkStatus();
  const hideNonAudiobooks = useUserStore((s) => !!s.settings?.hideNonAudiobooksGlobal);
  const completedDownloads = useDownloadStore((s) => s.completedDownloads);
  const downloadsLoaded = useDownloadStore((s) => s.downloadsLoaded);
  const startPlayback = usePlaybackStore((s) => s.startPlayback);
  // In-flight guard for the offline downloaded-row tap: double-tapping a row
  // must not churn two playback sessions (or leave a rejection unhandled).
  const offlineStartingRef = useRef(false);

  const loadContinueReading = async () => {
    // Capture the library at call time: if the user switches libraries while
    // the fetch is in flight, the stale result must not clobber the new
    // library's shelf (checked again before every setState below).
    const libId = currentLibraryId;
    if (!libId) return;
    // "Hide non-audiobooks" suppresses the Continue Reading shelf — skip the
    // whole item-batch fetch while it's on.
    if (useUserStore.getState().settings?.hideNonAudiobooksGlobal) return;
    const libStillCurrent = () => useLibraryStore.getState().currentLibraryId === libId;

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
        try { storage.set(`continueReadingCache_${libId}`, "[]"); } catch {}
        if (libStillCurrent()) setContinueReadingItems([]);
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

      try { storage.set(`continueReadingCache_${libId}`, JSON.stringify(filtered)); } catch {}
      if (libStillCurrent()) setContinueReadingItems(filtered);
    } catch (e) {
      console.warn("[Bookshelf] failed to load continue reading items", e);
    }
  };

  // Load the "Want to Read" shelf from the favorites list. Mirrors Continue
  // Reading: ONE batch item fetch for the favorite ids (per-item fallback for
  // older servers), scoped to the current library. Purely additive and
  // resilient — any failure just leaves the shelf empty, never breaking Home.
  const loadWantToRead = async () => {
    const libId = currentLibraryId;
    if (!libId) return;
    // Favorites need the server (batch fetch) — skip entirely while offline.
    if (isOffline) return;
    const favIds = useFavoritesStore.getState().list();
    const libStillCurrent = () => useLibraryStore.getState().currentLibraryId === libId;

    if (favIds.length === 0) {
      if (libStillCurrent()) setWantToReadItems([]);
      return;
    }

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
      if (libStillCurrent()) setWantToReadItems(filtered);
    } catch (e) {
      console.warn("[Bookshelf] failed to load want-to-read items", e);
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
    const libId = currentLibraryId;
    if (!libId) return;
    const libStillCurrent = () => useLibraryStore.getState().currentLibraryId === libId;
    // Offline (or the "audiobooks only" setting) → no recommendation shelf.
    if (isOffline || useUserStore.getState().settings?.hideNonAudiobooksGlobal) {
      if (libStillCurrent()) setAffinityShelf(null);
      return;
    }
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
      continueReadingItems.forEach(consider);

      if (genreCounts.size === 0) {
        if (libStillCurrent()) setAffinityShelf(null);
        return;
      }
      // Top genre by engagement (ties broken alphabetically for stability).
      const topGenre = Array.from(genreCounts.entries()).sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
      )[0][0];

      const res = await api.get(
        `/api/libraries/${libId}/items?filter=genres.${encodeFilterValue(topGenre)}&minified=1&limit=24`
      );
      if (!libStillCurrent()) return;
      const results = Array.isArray(res.data?.results) ? res.data.results : [];
      // Exclude books already finished/in-progress — the shelf is for what's
      // NEXT, not a re-run of the reading history it was derived from.
      const mpNow = useUserStore.getState().mediaProgress || {};
      const filtered = results.filter(
        (it: any) => it && it.id && !hasProgress(mpNow[it.id])
      );
      if (filtered.length === 0) {
        if (libStillCurrent()) setAffinityShelf(null);
        return;
      }
      if (libStillCurrent()) {
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
      if (libStillCurrent()) setAffinityShelf(null);
    }
  };

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

  // Coming back online: flush queued offline progress and refresh the shelves
  // so the transition back is seamless (no manual pull-to-refresh needed).
  const wasOffline = React.useRef(false);
  useEffect(() => {
    if (isOffline) {
      wasOffline.current = true;
    } else if (wasOffline.current) {
      wasOffline.current = false;
      flushPendingSyncs().catch(() => {});
      onRefresh();
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
      loadMediaProgress().then(() => {
        loadContinueReading();
        loadAffinity();
      });
    });
    return unsubscribe;
  }, [navigation, currentLibraryId]);

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
  }, [personalizedShelves, currentLibraryId, continueReadingItems, seriesList]);

  // Shelf assembly. Structurally deduped by id so "Continue Reading" can never
  // render twice (e.g. a stale cached shelf list racing the fresh one that now
  // includes the server's own continue-reading shelf).
  const displayShelves: any[] = [];
  {
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
    // at all.
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
        displayShelves.push({ ...shelf, type: "series", entities: continueSeries });
      } else if (shelf.id === "continue-listening") {
        const entities = (shelf.entities || []).filter(
          (e: any) => !isEbookOnly(e) && !ebookOnlyProgress(e)
        );
        displayShelves.push({ ...shelf, entities });
      } else if (shelf.id === "continue-reading") {
        // Prefer the locally-built list (ebook-progress aware); fall back to
        // the server's entities so the shelf shows instantly while ours loads.
        displayShelves.push({
          ...shelf,
          type: "book",
          entities: continueReadingItems.length > 0 ? continueReadingItems : shelf.entities || [],
        });
      } else if (shelf.type === "authors" || shelf.type === "author" || shelf.type === "series") {
        displayShelves.push(shelf);
      } else {
        displayShelves.push({ ...shelf, entities: filterEbooks(shelf.entities) });
      }
    }
    // Synthetic Continue Reading ONLY when the server sent none at all
    // (older servers) — inserted right after Continue Listening.
    if (!seenShelfIds.has("continue-reading") && continueReadingItems.length > 0 && !hideNonAudiobooks) {
      const idx = displayShelves.findIndex((s) => s.id === "continue-listening");
      // When there's no Continue Listening shelf (older server), findIndex
      // returns -1 and idx+1 would force this to the TOP — append instead.
      const insertAt = idx < 0 ? displayShelves.length : idx + 1;
      displayShelves.splice(insertAt, 0, {
        id: "continue-reading",
        label: "Continue Reading",
        type: "book",
        entities: continueReadingItems,
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
        for (let i = 0; i < displayShelves.length; i++) {
          const sid = displayShelves[i]?.id;
          if (typeof sid === "string" && sid.startsWith("continue-")) insertAt = i + 1;
        }
        displayShelves.splice(insertAt, 0, {
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
      displayShelves.push(affinityShelf);
    }
  }

  const renderBookCard = (item: any, index: number) => {
    return (
      <Animated.View
        key={item.id || index}
        entering={shelfCardEnter(index)}
      >
        <BookCard item={item} size={165} navigation={navigation} />
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
      const pm = useUserStore.getState().mediaProgress;
      unread = books.filter((b: any) => !(pm[b.id] || b.userMediaProgress)?.isFinished).length;
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
            ) : (
              <EmptyState
                style={{ flex: 1 }}
                icon="library"
                title="Nothing on the shelf yet"
                message="Books added to this library will show up here. Pull down to refresh."
              />
            )
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
              // Fade the shelf in when it (later) appears, and animate the
              // layout shift of the shelves below it instead of snapping.
              <Animated.View
                key={shelf.id}
                entering={FadeIn.duration(220)}
                layout={LinearTransition.duration(250)}
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
                  contentContainerStyle={{ paddingHorizontal: 12, alignItems: "flex-end" }}
                >
                  {shelf.entities?.map((entity: any, index: number) => {
                    if (isSeriesType) {
                      return renderSeriesCard(entity, index);
                    } else if (shelf.type === "authors" || shelf.type === "author") {
                      return renderAuthorCard(entity, index);
                    } else {
                      return renderBookCard(entity, index);
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
