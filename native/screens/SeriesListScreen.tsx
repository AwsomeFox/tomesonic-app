import React, { useEffect, useState, useCallback, useRef } from "react";
import { View, Text, FlatList, Image, Pressable, ActivityIndicator } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Animated, { FadeIn } from "react-native-reanimated";
import { LinearGradient } from "expo-linear-gradient";
import { api } from "../utils/api";
import { useLibraryStore } from "../store/useLibraryStore";
import { useUserStore } from "../store/useUserStore";
import { useThemeColors } from "../theme/useThemeColors";
import TopAppBar from "../components/TopAppBar";
import { GridSkeleton } from "../components/Skeleton";
import Icon from "../components/Icon";
import OrderModal from "../components/OrderModal";
import { usePlaybackStore } from "../store/usePlaybackStore";
import { useUiStore } from "../store/useUiStore";
import SearchContent from "../components/SearchContent";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

const NUM_COLUMNS = 2;
const CARD_SIZE = 170;
const PAGE_LIMIT = 20;

// Mirrors the original app's $encode: base64 then URI-encode. Used to build the
// `series.<id>` filter for the items endpoint that backs the cover collage.
function encodeFilter(value: string): string {
  try {
    // btoa isn't always present in RN; use a global fallback if available.
    const b64 =
      typeof btoa === "function"
        ? btoa(value)
        : (globalThis as any).Buffer?.from(value, "utf8").toString("base64") || value;
    return encodeURIComponent(b64);
  } catch {
    return encodeURIComponent(value);
  }
}

interface SeriesBook {
  id: string;
  media?: {
    metadata?: {
      title?: string;
    };
    coverPath?: string;
  };
}

interface Series {
  id: string;
  name: string;
  nameIgnorePrefix?: string;
  numBooks?: number;
  books: SeriesBook[];
}

export default function SeriesListScreen({ navigation }: any) {
  const colors = useThemeColors();
  const isSearchActive = useUiStore((s) => s.isSearchActive);
  const { currentLibraryId } = useLibraryStore();
  const hasSession = usePlaybackStore((state) => state.currentSession !== null);
  const { serverConnectionConfig } = useUserStore();

  const [seriesList, setSeriesList] = useState<Series[]>([]);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const isFetchingRef = useRef(false);
  // Sort state (series support name / added at / total duration).
  const [orderBy, setOrderBy] = useState("name");
  const [descending, setDescending] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  // Cover books fetched lazily per-series when the series payload omits `books`.
  const [coverBooksMap, setCoverBooksMap] = useState<Record<string, SeriesBook[]>>({});
  const fetchingCoversRef = useRef<Set<string>>(new Set());

  const serverAddress = serverConnectionConfig?.address?.replace(/\/$/, "") || "";
  const token = serverConnectionConfig?.token || "";

  const getCoverUrl = (itemId: string) => {
    if (!itemId || !serverAddress || !token) return null;
    return `${serverAddress}/api/items/${itemId}/cover?token=${token}`;
  };

  const fetchSeries = useCallback(
    async (pageNum: number, reset = false) => {
      if (!currentLibraryId || isFetchingRef.current) return;
      isFetchingRef.current = true;
      if (reset) setInitialLoading(true);
      setLoading(true);

      try {
        const response = await api.get(
          `/api/libraries/${currentLibraryId}/series?limit=${PAGE_LIMIT}&page=${pageNum}&minified=1&sort=${encodeURIComponent(
            orderBy
          )}&desc=${descending ? 1 : 0}`
        );
        const data = response.data || {};
        const results: Series[] = data.results || [];
        const totalCount = data.total || 0;

        setTotal(totalCount);
        setSeriesList((prev) => (reset ? results : [...prev, ...results]));
        setPage(pageNum);
      } catch (err) {
        console.error("[SeriesListScreen] Failed to fetch series:", err);
      } finally {
        setLoading(false);
        setInitialLoading(false);
        isFetchingRef.current = false;
      }
    },
    [currentLibraryId, orderBy, descending]
  );

  useEffect(() => {
    setSeriesList([]);
    setPage(0);
    setTotal(0);
    setCoverBooksMap({});
    fetchingCoversRef.current = new Set();
    fetchSeries(0, true);
  }, [currentLibraryId, fetchSeries]);

  // Lazily fetch up to 4 cover books for a series whose payload lacks a usable
  // `books` array. Mirrors LazySeriesCard.maybeFetchCoverBooks in the original
  // app: query the library items endpoint filtered by `series.<encoded id>`.
  const fetchCoverBooks = useCallback(
    async (series: Series) => {
      const sid = series.id;
      if (!currentLibraryId || !sid) return;
      if (coverBooksMap[sid] || fetchingCoversRef.current.has(sid)) return;
      fetchingCoversRef.current.add(sid);
      try {
        const filter = `series.${encodeFilter(sid)}`;
        const response = await api.get(
          `/api/libraries/${currentLibraryId}/items?filter=${filter}&limit=4&page=0&minified=1`
        );
        const results: SeriesBook[] = response.data?.results || [];
        setCoverBooksMap((prev) => ({ ...prev, [sid]: results.slice(0, 4) }));
      } catch (err) {
        console.error("[SeriesListScreen] Failed to fetch cover books:", err);
        setCoverBooksMap((prev) => ({ ...prev, [sid]: [] }));
      } finally {
        fetchingCoversRef.current.delete(sid);
      }
    },
    [currentLibraryId, coverBooksMap]
  );

  const handleLoadMore = () => {
    if (loading || seriesList.length >= total) return;
    fetchSeries(page + 1);
  };

  // Full-bleed series collage — mirrors .series-collage count-1..4 grid layouts.
  const renderCollage = (coverBooks: SeriesBook[]) => {
    const count = coverBooks.length;

    // count-1: single full cover
    if (count === 1) {
      const uri = getCoverUrl(coverBooks[0].id);
      return (
        <Image source={{ uri: uri || undefined }} style={{ width: "100%", height: "100%" }} resizeMode="cover" />
      );
    }

    // count-2: two side-by-side columns, full height
    if (count === 2) {
      return (
        <View style={{ flexDirection: "row", width: "100%", height: "100%" }}>
          {coverBooks.map((b, idx) => (
            <Image
              key={b.id || idx}
              source={{ uri: getCoverUrl(b.id) || undefined }}
              style={{ width: "50%", height: "100%" }}
              resizeMode="cover"
            />
          ))}
        </View>
      );
    }

    // count-3: two on top row, one spanning full width on bottom
    if (count === 3) {
      return (
        <View style={{ width: "100%", height: "100%" }}>
          <View style={{ flexDirection: "row", height: "50%" }}>
            <Image source={{ uri: getCoverUrl(coverBooks[0].id) || undefined }} style={{ width: "50%", height: "100%" }} resizeMode="cover" />
            <Image source={{ uri: getCoverUrl(coverBooks[1].id) || undefined }} style={{ width: "50%", height: "100%" }} resizeMode="cover" />
          </View>
          <Image source={{ uri: getCoverUrl(coverBooks[2].id) || undefined }} style={{ width: "100%", height: "50%" }} resizeMode="cover" />
        </View>
      );
    }

    // count-4: 2x2 grid
    return (
      <View style={{ flexDirection: "row", flexWrap: "wrap", width: "100%", height: "100%" }}>
        {coverBooks.map((b, idx) => (
          <Image
            key={b.id || idx}
            source={{ uri: getCoverUrl(b.id) || undefined }}
            style={{ width: "50%", height: "50%" }}
            resizeMode="cover"
          />
        ))}
      </View>
    );
  };

  const renderItem = ({ item, index }: { item: Series; index: number }) => {
    // Prefer books embedded in the series payload; fall back to lazily-fetched
    // cover books (some server versions omit `books` from the series list).
    const embeddedBooks = (item.books || []).filter((b) => b && b.id);
    const fetchedBooks = coverBooksMap[item.id] || [];
    const coverBooks = (embeddedBooks.length ? embeddedBooks : fetchedBooks).slice(0, 4);

    // Kick off a lazy fetch when the payload didn't include usable books.
    if (!embeddedBooks.length && !coverBooksMap[item.id]) {
      fetchCoverBooks(item);
    }

    const booksInSeries =
      Number.isFinite(Number(item.numBooks)) && Number(item.numBooks) >= 0
        ? Number(item.numBooks)
        : embeddedBooks.length || fetchedBooks.length;
    const seriesName = item.name || "";

    return (
      // material-3-card series-card-shell rounded-2xl bg-surface-container shadow-elevation-1 overflow-hidden
      <AnimatedPressable
        entering={FadeIn.delay(Math.min(index * 40, 400)).duration(300)}
        onPress={() =>
          navigation.navigate("SeriesDetail", {
            seriesId: item.id,
            seriesName: item.name,
          })
        }
        style={{
          borderRadius: 16,
          backgroundColor: colors.surfaceContainer,
          elevation: 1,
          overflow: "hidden",
          position: "relative",
          width: CARD_SIZE,
          height: CARD_SIZE,
          marginBottom: 14,
        }}
      >
        {/* Cover container — fills entire card (series-image-container z-0) */}
        <View style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, backgroundColor: colors.surfaceContainer }}>
          {coverBooks.length ? (
            renderCollage(coverBooks)
          ) : (
            // Placeholder Cover Title — bg-primary, name + book count centered
            <View style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, flexDirection: "column", alignItems: "center", justifyContent: "center", backgroundColor: colors.primary, padding: 16 }}>
              <Text numberOfLines={3} style={{ color: colors.onPrimary, fontWeight: "500", textAlign: "center", fontSize: 14, marginBottom: 8 }}>
                {seriesName}
              </Text>
              <Text style={{ color: colors.onPrimary, textAlign: "center", fontSize: 12, opacity: 0.75 }}>
                {booksInSeries} Books
              </Text>
            </View>
          )}
        </View>

        {/* Books-left / count badge — absolute top-2 right-2, secondary-container mint pill */}
        <View
          style={{ position: "absolute", zIndex: 30, flexDirection: "row", alignItems: "center", backgroundColor: colors.secondaryContainer, borderRadius: 20, top: 8, right: 8, paddingHorizontal: 8, paddingVertical: 3 }}
        >
          <Icon name="book" size={13} color={colors.onSecondaryContainer} />
          <Text style={{ color: colors.onSecondaryContainer, fontWeight: "bold", fontSize: 11, marginLeft: 3 }}>
            {booksInSeries}
          </Text>
        </View>

        {/* series-meta overlay — absolute bottom, gradient scrim + name + book count */}
        <LinearGradient
          colors={[
            "rgba(0,0,0,0)",
            "rgba(0,0,0,0.55)",
            "rgba(0,0,0,0.85)",
          ]}
          style={{ position: "absolute", left: 0, right: 0, bottom: 0, zIndex: 20, paddingTop: 22, paddingBottom: 12, paddingHorizontal: 12 }}
        >
          {/* series-name */}
          <Text numberOfLines={1} style={{ color: colors.onMedia, fontSize: 14, lineHeight: 17, fontWeight: "600" }}>
            {seriesName}
          </Text>
          {/* series-books — menu_book icon + "N Books" */}
          <View style={{ flexDirection: "row", alignItems: "center", marginTop: 4 }}>
            <Icon name="book" size={12} color={colors.onMediaVariant} />
            <Text numberOfLines={1} style={{ color: colors.onMediaVariant, fontSize: 12, marginLeft: 4, fontWeight: "500" }}>
              {booksInSeries} Books
            </Text>
          </View>
        </LinearGradient>
      </AnimatedPressable>
    );
  };

  const renderFooter = () => {
    if (!loading || initialLoading) return null;
    return (
      <View style={{ paddingVertical: 20, alignItems: "center" }}>
        <ActivityIndicator size="small" color={colors.primary} />
      </View>
    );
  };

  if (initialLoading) {
    return (
      <SafeAreaView
        style={{ flex: 1, backgroundColor: colors.surface }}
        edges={["top", "left", "right"]}
      >
        <TopAppBar navigation={navigation} showSort onSort={() => setSortOpen(true)} />
        <GridSkeleton columns={NUM_COLUMNS} count={NUM_COLUMNS * 4} aspectRatio={1} />
      </SafeAreaView>
    );
  }

  if (isSearchActive) {
    return (
      <SafeAreaView
        style={{ flex: 1, backgroundColor: colors.surface }}
        edges={["top", "left", "right"]}
      >
        <TopAppBar navigation={navigation} showSort onSort={() => setSortOpen(true)} />
        <SearchContent navigation={navigation} />
      </SafeAreaView>
    );
  }

  if (!initialLoading && seriesList.length === 0) {
    return (
      <SafeAreaView
        style={{ flex: 1, backgroundColor: colors.surface }}
        edges={["top", "left", "right"]}
      >
        <TopAppBar navigation={navigation} showSort onSort={() => setSortOpen(true)} />
        <OrderModal
          visible={sortOpen}
          onClose={() => setSortOpen(false)}
          orderBy={orderBy}
          descending={descending}
          series
          onChange={(o, d) => {
            setOrderBy(o);
            setDescending(d);
          }}
        />
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 32 }}>
          <Icon name="series" size={48} color={colors.onSurfaceVariant} />
          <Text style={{ color: colors.onSurface, fontSize: 22, fontWeight: "bold", marginTop: 16, marginBottom: 8 }}>
            No series found
          </Text>
          <Text style={{ color: colors.onSurfaceVariant, fontSize: 14, textAlign: "center" }}>
            No series have been created in this library yet.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: colors.surface }}
      edges={["top", "left", "right"]}
    >
      <TopAppBar navigation={navigation} showSort onSort={() => setSortOpen(true)} />

      <OrderModal
        visible={sortOpen}
        onClose={() => setSortOpen(false)}
        orderBy={orderBy}
        descending={descending}
        series
        onChange={(o, d) => {
          setOrderBy(o);
          setDescending(d);
        }}
      />

      {/* Grid — flex flex-wrap justify-center, p-4 */}
      <FlatList
        data={seriesList}
        renderItem={renderItem}
        keyExtractor={(item) => item.id}
        numColumns={NUM_COLUMNS}
        columnWrapperStyle={{ justifyContent: "space-evenly", paddingHorizontal: 8 }}
        contentContainerStyle={{ paddingBottom: hasSession ? 100 : 32, paddingTop: 8 }}
        onEndReached={handleLoadMore}
        onEndReachedThreshold={0.5}
        ListFooterComponent={renderFooter}
        showsVerticalScrollIndicator={false}
      />
    </SafeAreaView>
  );
}
