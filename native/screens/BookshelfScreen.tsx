import React, { useEffect, useState } from "react";
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
import { usePlaybackStore } from "../store/usePlaybackStore";
import { useUiStore } from "../store/useUiStore";
import SearchContent from "../components/SearchContent";
import { ShelfSkeleton } from "../components/Skeleton";
import { useDownloadStore } from "../store/useDownloadStore";
import { useNetworkStatus } from "../hooks/useNetworkStatus";
import { flushPendingSyncs } from "../utils/progressSync";
import { hasEbook, isEbookOnly } from "../utils/bookMatch";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export default function BookshelfScreen({ navigation }: any) {
  const colors = useThemeColors();
  const hasSession = usePlaybackStore((s) => s.currentSession !== null);
  const { serverConnectionConfig } = useUserStore();
  const isSearchActive = useUiStore((s) => s.isSearchActive);
  const loadMediaProgress = useUserStore((s) => s.loadMediaProgress);
  const { personalizedShelves, loadPersonalizedShelves, currentLibraryId, loadLibraries } = useLibraryStore();
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
  // Starts true so the very first frame of a fresh install shows the skeleton
  // (not an empty screen). Warm starts hydrate shelves synchronously from the
  // MMKV cache, so the `shelves.length === 0` half of the gate skips it.
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const { isConnected } = useNetworkStatus();
  const hideNonAudiobooks = useUserStore((s) => !!s.settings?.hideNonAudiobooksGlobal);
  const completedDownloads = useDownloadStore((s) => s.completedDownloads);
  const startPlayback = usePlaybackStore((s) => s.startPlayback);

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
      
      // Keep any item with an ebook — in-progress ebooks are shown GLOBALLY
      // (ids come from the user's whole mediaProgress map), not just from the
      // current library: ebook and audio versions often live in separate
      // libraries, and the reading shelf must surface both.
      const filtered = fetchedItems.filter((item: any) => hasEbook(item));

      try { storage.set(`continueReadingCache_${libId}`, JSON.stringify(filtered)); } catch {}
      if (libStillCurrent()) setContinueReadingItems(filtered);
    } catch (e) {
      console.warn("[Bookshelf] failed to load continue reading items", e);
    }
  };

  // Bumped by pull-to-refresh so the series-list effect below revalidates too
  // (otherwise Continue Series folders keep stale covers/counts).
  const [seriesRefreshTick, setSeriesRefreshTick] = useState(0);

  const onRefresh = async () => {
    setRefreshing(true);
    setSeriesRefreshTick((t) => t + 1);
    try {
      await Promise.all([loadPersonalizedShelves(true), loadMediaProgress()]);
      await loadContinueReading();
    } finally {
      setRefreshing(false);
    }
  };

  // Coming back online: flush queued offline progress and refresh the shelves
  // so the transition back is seamless (no manual pull-to-refresh needed).
  const wasOffline = React.useRef(false);
  useEffect(() => {
    if (!isConnected) {
      wasOffline.current = true;
    } else if (wasOffline.current) {
      wasOffline.current = false;
      flushPendingSyncs().catch(() => {});
      onRefresh();
    }
  }, [isConnected]);

  // Library switch: swap Continue Reading to the new library's cache right
  // away (matches how the store swaps the shelves cache).
  const prevLibraryRef = React.useRef(currentLibraryId);
  useEffect(() => {
    if (prevLibraryRef.current !== currentLibraryId) {
      prevLibraryRef.current = currentLibraryId;
      setContinueReadingItems(readContinueReadingCache(currentLibraryId));
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

    // Fully synchronous: the series list arrives via its own parallel fetch
    // above, so this just re-derives whenever any input changes.
    if (personalizedShelves.length === 0 || !currentLibraryId || seriesList.length === 0) {
      setContinueSeries([]);
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
      displayShelves.splice(idx + 1, 0, {
        id: "continue-reading",
        label: "Continue Reading",
        type: "book",
        entities: continueReadingItems,
      });
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
      <TopAppBar navigation={navigation} hideSearch={!isConnected} />
      {!isConnected ? (
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
          {Object.values(completedDownloads).length === 0 ? (
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
              const openOffline = () => {
                if (isEbookOnly) {
                  const filename: string = ebookPart?.filename || "book.epub";
                  navigation.navigate("Reader", {
                    itemId: dl.libraryItemId || dl.id,
                    ebookFormat: filename.split(".").pop() || "epub",
                    title: dl.title,
                  });
                } else {
                  startPlayback(dl.libraryItemId || dl.id);
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
          {/* Loaded but nothing to shelve (fresh/empty library): a real empty
              state instead of a blank scroll area. RefreshControl stays live
              (flexGrow centers this within the scrollable viewport). */}
          {!displayShelves.some((s: any) => s.entities && s.entities.length > 0) ? (
            <View style={{ flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 32, paddingBottom: 48 }}>
              <Icon name="library" size={48} color={colors.onSurfaceVariant} />
              <Text style={{ color: colors.onSurface, fontSize: 17, fontWeight: "600", marginTop: 16, textAlign: "center" }}>
                Nothing on the shelf yet
              </Text>
              <Text style={{ color: colors.onSurfaceVariant, fontSize: 14, marginTop: 6, textAlign: "center" }}>
                Books added to this library will show up here. Pull down to refresh.
              </Text>
            </View>
          ) : null}
          {displayShelves.map((shelf: any) => {
            // Dispatch by shelf type. We transform "Continue Series" into a
            // series-type shelf (folders that open the series list).
            const isSeriesType = shelf.type === "series";
            // Never render a shelf header with nothing under it — async-built
            // shelves (Continue Reading/Series) simply appear once populated.
            if (!shelf.entities || shelf.entities.length === 0) return null;

            return (
              // Fade the shelf in when it (later) appears, and animate the
              // layout shift of the shelves below it instead of snapping.
              <Animated.View
                key={shelf.id}
                entering={FadeIn.duration(220)}
                layout={LinearTransition.duration(250)}
                style={{ width: "100%", position: "relative", paddingBottom: 4 }}
              >
                {/* Shelf header: teal rounded accent bar + prominent title */}
                <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 }}>
                  <View
                    style={{ width: 5, height: 22, borderRadius: 3, marginRight: 10, backgroundColor: colors.primary }}
                  />
                  <Text
                    style={{ color: colors.onSurface, fontFamily: "serif", fontWeight: "700", fontSize: 21, letterSpacing: 0 }}
                  >
                    {shelf.label || shelf.name}
                  </Text>
                </View>

                {/* Horizontal shelf row (flex items-end px-3) */}
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
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
        </Animated.ScrollView>
      )}
    </SafeAreaView>
  );
}
