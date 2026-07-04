import React, { useEffect, useState } from "react";
import { View, Text, Pressable, ScrollView, Image, RefreshControl } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import Animated, { FadeInRight } from "react-native-reanimated";
import { useLibraryStore } from "../store/useLibraryStore";
import { useUserStore } from "../store/useUserStore";
import { api } from "../utils/api";
import { useThemeColors } from "../theme/useThemeColors";
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
import { encodeFilterValue } from "../components/FilterModal";
import { hasEbook, hasAudio } from "../utils/bookMatch";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export default function BookshelfScreen({ navigation }: any) {
  const colors = useThemeColors();
  const hasSession = usePlaybackStore((s) => s.currentSession !== null);
  const { serverConnectionConfig } = useUserStore();
  const isSearchActive = useUiStore((s) => s.isSearchActive);
  const loadMediaProgress = useUserStore((s) => s.loadMediaProgress);
  const { personalizedShelves, loadPersonalizedShelves, currentLibraryId, loadLibraries } = useLibraryStore();
  const [continueReadingItems, setContinueReadingItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const { isConnected } = useNetworkStatus();
  const completedDownloads = useDownloadStore((s) => s.completedDownloads);
  const startPlayback = usePlaybackStore((s) => s.startPlayback);

  const loadContinueReading = async () => {
    if (!currentLibraryId) return;

    try {
      const mediaProgress = useUserStore.getState().mediaProgress || {};
      const filterVal = `progress.${encodeFilterValue("in-progress")}`;
      const res = await api.get(`/api/libraries/${currentLibraryId}/items?filter=${filterVal}&limit=40`);
      const items = res.data?.results || [];
      
      // Filter duplicates (just in case) and select in-progress ebooks
      const seenIds = new Set<string>();
      const ebooks = items.filter((item: any) => {
        if (!item?.id) return false;
        if (seenIds.has(item.id)) return false;
        seenIds.add(item.id);

        const progress = item?.userMediaProgress || mediaProgress[item.id];
        
        if (!hasEbook(item)) return false;
        if (!progress || progress.isFinished) return false;
        
        // If it's a pure ebook or has active ebook progress
        if (progress.ebookLocation || (progress.ebookProgress !== undefined && progress.ebookProgress > 0)) {
          return true;
        }
        return !hasAudio(item);
      });
      setContinueReadingItems(ebooks);
    } catch (e) {
      console.warn("[Bookshelf] failed to load continue reading items", e);
    }
  };

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await Promise.all([loadPersonalizedShelves(true), loadMediaProgress(), loadContinueReading()]);
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

  useEffect(() => {
    const initData = async () => {
      setLoading(true);
      await loadLibraries();
      await Promise.all([loadPersonalizedShelves(), loadMediaProgress(), loadContinueReading()]);
      setLoading(false);
    };
    initData();
  }, [currentLibraryId]);

  const serverAddress = serverConnectionConfig?.address?.replace(/\/$/, "") || "";
  const token = serverConnectionConfig?.token || "";

  const getCoverUrl = (id: string) => {
    if (!id || !serverAddress || !token) return null;
    return `${serverAddress}/api/items/${id}/cover?token=${token}`;
  };

  const getAuthorImageUrl = (author: any) => {
    if (!author?.imagePath || !author?.id || !serverAddress || !token) return null;
    return `${serverAddress}/api/authors/${author.id}/image?token=${token}`;
  };

  const fallbackShelves = [
    {
      id: "continue-listening",
      label: "Continue Listening",
      type: "book",
      entities: [
        {
          id: "book_exp_1",
          title: "Critical Mass",
          author: "Craig Alanson",
          progress: { currentTime: 18000, duration: 47940 }, // 8h 19m remaining
          coverUrl: "https://images-na.ssl-images-amazon.com/images/I/91aOpeW784L.jpg",
        },
        {
          id: "book_eye_2",
          title: "The Eye of the Bedlam Bride",
          author: "Matt Dinniman",
          progress: { currentTime: 10000, duration: 85000 }, // 20h 50m remaining
          coverUrl: "https://images-na.ssl-images-amazon.com/images/I/91tS2hLgGTL.jpg",
        },
      ],
    },
    {
      id: "continue-series",
      label: "Continue Series",
      type: "series",
      entities: [
        {
          id: "series_hp",
          title: "Harry Potter (Full-...",
          booksCount: 7,
          progressCount: 6,
          covers: [
            "https://images-na.ssl-images-amazon.com/images/I/81YOuOGFCJL.jpg",
            "https://images-na.ssl-images-amazon.com/images/I/81t2bCOY3JL.jpg",
            "https://images-na.ssl-images-amazon.com/images/I/81VqLoU2JLL.jpg",
            "https://images-na.ssl-images-amazon.com/images/I/81WjG4W6eaL.jpg",
          ],
        },
        {
          id: "series_murderbot",
          title: "Murderbot Diaries",
          booksCount: 4,
          progressCount: 2,
          covers: [
            "https://images-na.ssl-images-amazon.com/images/I/71t41G2zFmL.jpg",
            "https://images-na.ssl-images-amazon.com/images/I/816K856pS-L.jpg",
            "https://images-na.ssl-images-amazon.com/images/I/71N14299bLL.jpg",
            "https://images-na.ssl-images-amazon.com/images/I/81pL7pLhBGL.jpg",
          ],
        },
      ],
    },
    {
      id: "continue-authors",
      label: "Continue Authors",
      type: "authors",
      entities: [
        {
          id: "author_hp_stone",
          title: "Harry Potter and the Sorcerer's Stone",
          author: "J.K. Rowling",
          coverUrl: "https://images-na.ssl-images-amazon.com/images/I/81YOuOGFCJL.jpg",
        },
        {
          id: "author_fourth_wing",
          title: "Fourth Wing",
          author: "Rebecca Yarros",
          coverUrl: "https://images-na.ssl-images-amazon.com/images/I/91n7p-j+3eL.jpg",
        },
      ],
    },
  ];

  const activeShelves = personalizedShelves.length > 0 ? personalizedShelves : fallbackShelves;

  // "Continue Series" rendered as series folders (open the series list), merged
  // from the server's continue-series shelf (next book per series) AND the
  // in-progress books in continue-listening — so a series you're currently
  // reading also shows up. In-progress books only carry a `seriesName` string,
  // so we resolve their series id via the library's series list (one fetch).
  const [continueSeries, setContinueSeries] = useState<any[]>([]);

  useEffect(() => {
    let cancelled = false;
    const build = async () => {
      if (personalizedShelves.length === 0 || !currentLibraryId) {
        setContinueSeries([]);
        return;
      }
      // series name (lowercased, without the "#seq" suffix) -> series id
      const nameToId = new Map<string, string>();
      const idToSeries = new Map<string, any>();
      try {
        const r = await api.get(`/api/libraries/${currentLibraryId}/series?limit=1000&minified=1`);
        (r.data?.results || []).forEach((s: any) => {
          if (s?.id) {
            idToSeries.set(s.id, s);
            if (s?.name) nameToId.set(String(s.name).toLowerCase(), s.id);
          }
        });
      } catch {}

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
      // Then between-books series (already carry the id).
      const cs = personalizedShelves.find((s: any) => s.id === "continue-series");
      (cs?.entities || []).forEach((b: any) => {
        const s = b?.media?.metadata?.series;
        const so = Array.isArray(s) ? s[0] : s;
        if (so?.id) push(so.id, so.name);
      });

      if (!cancelled) setContinueSeries(ordered);
    };
    build();
    return () => { cancelled = true; };
  }, [personalizedShelves, currentLibraryId]);

  const displayShelves = activeShelves.reduce((acc: any[], shelf: any) => {
    if (shelf.id === "continue-series" && personalizedShelves.length > 0) {
      acc.push({ ...shelf, type: "series", entities: continueSeries });
    } else {
      acc.push(shelf);
    }
    if (shelf.id === "continue-listening" && continueReadingItems.length > 0) {
      acc.push({
        id: "continue-reading",
        label: "Continue Reading",
        type: "book",
        entities: continueReadingItems,
      });
    }
    return acc;
  }, []);

  const renderBookCard = (item: any, index: number) => {
    return (
      <Animated.View
        key={item.id || index}
        entering={FadeInRight.delay(index * 50).springify().damping(32).stiffness(150)}
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
    // Badge shows books-left-to-start when known, else the total book count.
    const badgeCount = series.progressCount ?? bookCount;

    return (
      <AnimatedPressable
        key={series.id || index}
        entering={FadeInRight.delay(index * 50).springify().damping(32).stiffness(150)}
        onPress={() =>
          navigation.navigate("SeriesDetail", { seriesId: series.id, seriesName: series.name || series.title })
        }
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
            source={{ uri: covers[0] }}
            style={{ width: "100%", height: "100%" }}
            resizeMode="cover"
          />
        ) : (
          <View style={{ flexDirection: "row", flexWrap: "wrap", width: "100%", height: "100%" }}>
            {covers.slice(0, 4).map((coverUri: string, idx: number) => (
              <Image
                key={idx}
                source={{ uri: coverUri }}
                style={{ width: cardSize / 2, height: cardSize / 2 }}
                resizeMode="cover"
              />
            ))}
            {covers.length === 0 && (
              <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.surfaceContainerHighest }}>
                <Icon name="series" size={40} color={colors.onSurfaceVariant} />
              </View>
            )}
          </View>
        )}

        {/* Book-count badge (top right) — mint secondary-container pill w/ book icon */}
        {badgeCount ? (
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
              backgroundColor: colors.secondaryContainer,
              borderRadius: 20,
            }}
          >
            <Icon name="book" size={12} color={colors.onSecondaryContainer} />
            <Text style={{ color: colors.onSecondaryContainer, fontSize: 11, fontWeight: "bold", marginLeft: 4 }}>
              {badgeCount}
            </Text>
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
        entering={FadeInRight.delay(index * 50).springify().damping(32).stiffness(150)}
        onPress={() =>
          navigation.navigate("AuthorDetail", {
            authorId: author.id,
            authorName: author.name || author.title || "Unknown Author",
          })
        }
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
            source={{ uri: imageUri }}
            style={{ width: "100%", height: "100%" }}
            resizeMode="cover"
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
      <TopAppBar navigation={navigation} />
      {!isConnected ? (
        // Offline: the server is unreachable, so show the on-device library.
        // Covers come from the locally-downloaded cover file, playback falls
        // back to the offline local-session path automatically.
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingTop: 16, paddingBottom: hasSession ? 100 : 16 }}>
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
              return (
                <Pressable
                  key={dl.id}
                  onPress={async () => {
                    const ok = await startPlayback(dl.libraryItemId || dl.id);
                    if (ok) navigation.navigate("Player");
                  }}
                  android_ripple={{ color: colors.surfaceContainerHighest }}
                  style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 10 }}
                >
                  <View style={{ width: 64, height: 64, borderRadius: 10, overflow: "hidden", backgroundColor: colors.surfaceContainerHighest }}>
                    {localCover ? (
                      <Image source={{ uri: localCover }} style={{ width: 64, height: 64 }} resizeMode="cover" />
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
                    <Icon name="play" size={22} color={colors.onPrimary} />
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
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingTop: 16, paddingBottom: hasSession ? 100 : 16 }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              colors={[colors.primary]}
              progressBackgroundColor={colors.surfaceContainerHigh}
            />
          }
        >
          {displayShelves.map((shelf: any) => {
            // Dispatch by shelf type. We transform "Continue Series" into a
            // series-type shelf (folders that open the series list).
            const isSeriesType = shelf.type === "series";
            if (isSeriesType && (!shelf.entities || shelf.entities.length === 0)) return null;

            return (
              <View key={shelf.id} style={{ width: "100%", position: "relative", paddingBottom: 4 }}>
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
              </View>
            );
          })}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}
