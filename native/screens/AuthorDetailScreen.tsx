import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  FlatList,
  Pressable,
} from "react-native";
import { Image } from "expo-image";
import { coverSource } from "../utils/coverSource";
import { useThemeColors } from "../theme/useThemeColors";
import { SafeAreaView } from "react-native-safe-area-context";
import Animated from "react-native-reanimated";
import { listRowEnter } from "../theme/motion";
import { api } from "../utils/api";
import { useUserStore } from "../store/useUserStore";
import Icon from "../components/Icon";
import { isEbookOnly, authorsMatch } from "../utils/bookMatch";
import { useRmabStore } from "../store/useRmabStore";
import BookProgressBadge, { bookStatusA11yLabel } from "../components/BookProgressBadge";
import Skeleton, { ListSkeleton } from "../components/Skeleton";
import ErrorState from "../components/ErrorState";
import EmptyState from "../components/EmptyState";
import { usePlaybackStore } from "../store/usePlaybackStore";
import RmabMissingSection from "../components/RmabMissingSection";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

// Square cover — audiobook art is square (album-art style), matching the rest
// of the app (LibraryScreen rows, BookCard, SeriesDetail). contentFit:"cover"
// fills a square source exactly; a rare portrait cover is center-cropped.
const COVER_WIDTH = 80;
const COVER_HEIGHT = 80;

interface AuthorBook {
  id: string;
  media?: {
    metadata?: {
      title?: string;
      subtitle?: string;
    };
  };
}

interface AuthorData {
  id: string;
  name: string;
  description?: string | null;
  imagePath?: string | null;
  libraryItems: AuthorBook[];
}

export default function AuthorDetailScreen({ route, navigation }: any) {
  const colors = useThemeColors();
  const hasSession = usePlaybackStore((s) => s.currentSession !== null);
  const { authorId, authorName } = route.params || {};
  const { serverConnectionConfig } = useUserStore();
  // Same progress map the badge reads, so the card's spoken label can fold in
  // the badge's Finished / remaining / Downloaded state (BookCard pattern).
  const mediaProgress = useUserStore((s) => s.mediaProgress);

  const [author, setAuthor] = useState<AuthorData | null>(null);

  const [loading, setLoading] = useState(true);

  // Missing-books discovery straight off Audible's catalog API (fast, free) —
  // diffed locally against the author's library items. RMAB only handles the
  // Request tap.
  const rmabName = author?.name || authorName;
  const authorLoading = loading;
  // Full-login (jwt) sessions can use RMAB's server-side author list, which
  // resolves the author by ASIN relationship instead of a fragile name
  // text-match — the reliable source. apiToken/none fall back to Audible.
  const rmabConfigured = useRmabStore((s) => s.configured);
  const rmabMode = useRmabStore((s) => s.authMode);
  const fetchMissingByAuthor = React.useCallback(async () => {
    const { audibleAuthorBooks, buildOwnedTitleMatcher } = require("../utils/audible");
    if (!rmabName || authorLoading) return [];
    // Derive the item list from `author` (a dep — new identity per load)
    // inside the callback: closing over a derived array keyed on .length
    // would go stale on a same-length content change.
    const authorItems = author?.libraryItems || [];
    const haveAsins = new Set(
      authorItems.map((b: any) => b.media?.metadata?.asin).filter(Boolean)
    );
    // Same subtitle-safe matching as the series screen (the pre-colon titleKey
    // diff collapsed an author's whole "Series: Volume" run into one key),
    // linear via precomputed key sets; candidates carry their own seriesTitle
    // for the bare-owned-title guard.
    const ownedMatches = buildOwnedTitleMatcher(
      authorItems.map((b: any) => b.media?.metadata?.title)
    );

    // JWT primary: RMAB's /api/authors/{asin}/books is a reliable ASIN-keyed
    // lookup (rows pre-enriched with isAvailable). Resolve the author ASIN via
    // searchAuthors, then fetch. Any miss/failure falls through to Audible.
    if (rmabConfigured && rmabMode === "jwt") {
      try {
        const { searchAuthors, getAuthorBooks } = require("../utils/rmab");
        const authors = await searchAuthors(rmabName);
        const match =
          (authors || []).find((a: any) => a?.name && authorsMatch(a.name, rmabName)) ||
          (authors || [])[0];
        const asin = match?.asin || match?.authorAsin || match?.id;
        if (asin) {
          const rows = await getAuthorBooks(asin);
          if (rows && rows.length) {
            // Still drop books we already own so this matches the Audible path;
            // RmabMissingSection additionally drops any isAvailable rows.
            return rows.filter(
              (b: any) => !haveAsins.has(b.asin) && !ownedMatches({ title: b.title })
            );
          }
        }
      } catch {
        // Fall through to the Audible discovery path on any RMAB failure.
      }
    }

    const all = await audibleAuthorBooks(rmabName);
    const missing = all.filter((b: any) => !haveAsins.has(b.asin) && !ownedMatches(b));
    if ((all as any).partial) (missing as any).partial = true;
    return missing;
  }, [rmabName, authorLoading, author, rmabConfigured, rmabMode]);

  const [loadError, setLoadError] = useState(false);
  const [retryTick, setRetryTick] = useState(0);
  const [descExpanded, setDescExpanded] = useState(false);

  const serverAddress = serverConnectionConfig?.address?.replace(/\/$/, "") || "";
  const token = serverConnectionConfig?.token || "";

  const getCoverUrl = (itemId: string) => {
    if (!itemId || !serverAddress || !token) return null;
    return `${serverAddress}/api/items/${itemId}/cover?width=400&format=webp&token=${token}`;
  };

  const getAuthorImageUrl = () => {
    if (!author?.imagePath || !serverAddress || !token) return null;
    return `${serverAddress}/api/authors/${author.id}/image?width=400&format=webp&token=${token}`;
  };

  useEffect(() => {
    const fetchAuthorDetail = async () => {
      if (!authorId) {
        setLoading(false);
        setLoadError(true);
        return;
      }
      setLoading(true);
      setLoadError(false);
      try {
        const response = await api.get(
          `/api/authors/${authorId}?include=items,series`
        );
        const data = response.data || {};
        setAuthor({
          id: data.id,
          name: data.name || authorName || "Unknown Author",
          description: data.description,
          imagePath: data.imagePath,
          libraryItems: data.libraryItems || data.items || [],
        });
      } catch (err) {
        console.error("[AuthorDetailScreen] Failed to fetch author:", err);
        setLoadError(true);
      } finally {
        setLoading(false);
      }
    };

    fetchAuthorDetail();
  }, [authorId, retryTick]);

  const renderBookCard = ({ item, index }: { item: AuthorBook; index: number }) => {
    const coverUri = getCoverUrl(item.id);
    const title = item.media?.metadata?.title || "Untitled";
    const subtitle = item.media?.metadata?.subtitle || "";
    const downloaded = (item as any).isLocal || !!(item as any).localLibraryItem;

    return (
      <AnimatedPressable
        entering={listRowEnter(index)}
        onPress={() => navigation.navigate("ItemDetail", { itemId: item.id })}
        android_ripple={{ color: colors.surfaceContainerHighest }}
        accessibilityRole="button"
        accessibilityLabel={[title, subtitle, bookStatusA11yLabel(item, mediaProgress, downloaded)]
          .filter(Boolean)
          .join(". ")}
        style={{
          flexDirection: "row",
          backgroundColor: colors.surfaceContainer,
          borderRadius: 16,
          marginBottom: 10,
          marginHorizontal: 16,
          overflow: "hidden",
          elevation: 3,
          shadowColor: "#000",
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: 0.25,
          shadowRadius: 4,
        }}
      >
        <View
          style={{
            width: COVER_WIDTH,
            height: COVER_HEIGHT,
            backgroundColor: colors.surfaceContainerHigh,
            position: "relative",
          }}
        >
          {coverUri ? (
            <Image
              source={coverSource(coverUri)}
              style={{ width: COVER_WIDTH, height: COVER_HEIGHT }}
              contentFit="cover"
            />
          ) : (
            <View
              style={{
                flex: 1,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: colors.surfaceContainerHigh,
              }}
            >
              <Icon name="book" size={28} color={colors.onSurfaceVariant} />
            </View>
          )}
        </View>

        <View
          style={{
            flex: 1,
            paddingVertical: 12,
            paddingHorizontal: 14,
            justifyContent: "center",
          }}
        >
          <Text
            numberOfLines={2}
            style={{
              color: colors.onSurface,
              fontSize: 15,
              fontWeight: "bold",
              marginBottom: 4,
            }}
          >
            {title}
          </Text>
          {subtitle ? (
            <Text
              numberOfLines={1}
              style={{ color: colors.onSurfaceVariant, fontSize: 12 }}
            >
              {subtitle}
            </Text>
          ) : null}
          <BookProgressBadge
            itemId={item.id}
            item={item}
            downloaded={downloaded}
            style={{ marginTop: 4 }}
          />
        </View>
      </AnimatedPressable>
    );
  };

  const imageUri = getAuthorImageUrl();
  // "Hide non-audiobooks": ebook-only rows are dropped when the setting is on.
  const hideNonAudiobooks = useUserStore((s) => !!s.settings?.hideNonAudiobooksGlobal);
  // filter(Boolean) first (matching Collection/Playlist/Series): a single null
  // row in the payload reaches keyExtractor's item.id and crashes the list.
  const books = (author?.libraryItems || [])
    .filter(Boolean)
    .filter((b: any) => !hideNonAudiobooks || !isEbookOnly(b));

  const renderHeader = () => (
    <View style={{ paddingBottom: 8 }}>
      {/* Author profile */}
      <View style={{ alignItems: "center", paddingTop: 12, paddingBottom: 16 }}>
        <View
          style={{
            width: 120,
            height: 120,
            borderRadius: 60,
            overflow: "hidden",
            backgroundColor: colors.primary,
            alignItems: "center",
            justifyContent: "center",
            marginBottom: 14,
          }}
        >
          {imageUri ? (
            <Image
              source={coverSource(imageUri)}
              style={{ width: 120, height: 120 }}
              contentFit="cover"
            />
          ) : (
            <Icon name="person" size={56} color={colors.onPrimary} />
          )}
        </View>
        <Text
          accessibilityRole="header"
          style={{
            color: colors.onSurface,
            fontSize: 22,
            fontWeight: "bold",
            textAlign: "center",
            paddingHorizontal: 24,
          }}
        >
          {author?.name || authorName}
        </Text>
        <Text
          style={{
            color: colors.onSurfaceVariant,
            fontSize: 13,
            marginTop: 4,
          }}
        >
          {books.length} {books.length === 1 ? "book" : "books"}
        </Text>

        {author?.description ? (
          <Pressable
            onPress={() => setDescExpanded((v) => !v)}
            accessibilityRole="button"
            accessibilityLabel={descExpanded ? "Show less" : "Show more"}
            accessibilityState={{ expanded: descExpanded }}
            style={{ paddingHorizontal: 24, marginTop: 12 }}
          >
            <Text
              numberOfLines={descExpanded ? undefined : 4}
              style={{
                color: colors.onSurfaceVariant,
                fontSize: 13,
                lineHeight: 19,
                textAlign: "center",
              }}
            >
              {author.description}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: colors.surface }}
      edges={["top", "left", "right"]}
    >
      {/* Header bar — rendered in every state so back stays reachable even
          while loading or after an error. */}
      <View
        style={{
          paddingHorizontal: 16,
          paddingVertical: 14,
          flexDirection: "row",
          alignItems: "center",
          borderBottomWidth: 1,
          borderBottomColor: colors.outlineVariant,
        }}
      >
        <Pressable
          onPress={() => navigation.goBack()}
          hitSlop={8}
          android_ripple={{ color: colors.surfaceContainerHighest, borderless: true, radius: 22 }}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={{ marginRight: 12, padding: 8, borderRadius: 20 }}
        >
          <Icon name="back" size={20} color={colors.onSurface} />
        </Pressable>
        <Text
          accessibilityRole="header"
          numberOfLines={1}
          style={{ color: colors.onSurface, fontSize: 20, fontWeight: "700", flex: 1 }}
        >
          {author?.name || authorName || "Author"}
        </Text>
      </View>

      {loading ? (
        <View>
          {/* Profile-circle + name placeholders matching the real header. */}
          <View style={{ alignItems: "center", paddingTop: 12, paddingBottom: 16 }}>
            <Skeleton width={120} height={120} radius={60} style={{ marginBottom: 14 }} />
            <Skeleton width={180} height={20} radius={6} />
            <Skeleton width={80} height={13} radius={5} style={{ marginTop: 8 }} />
          </View>
          {/* ListSkeleton only draws square thumbs; align to the real card
              cover WIDTH (COVER_WIDTH) so the horizontal reflow on load is
              minimized (the portrait height can't be matched here). */}
          <ListSkeleton rows={4} thumb={COVER_WIDTH} />
        </View>
      ) : loadError && !author ? (
        <ErrorState
          title="Couldn't load author"
          message="Check your connection to the server and try again."
          onRetry={() => setRetryTick((t) => t + 1)}
          style={{ flex: 1 }}
        />
      ) : books.length === 0 ? (
        <FlatList
          data={[]}
          renderItem={null as any}
          ListHeaderComponent={renderHeader}
          ListEmptyComponent={
            <EmptyState
              icon="book"
              title="No books by this author"
              message="Books appear here once this library has titles matched to this author."
            />
          }
          // Owning nothing by this author should still surface discovery/Request
          // — the missing-books section renders in the empty state too.
          ListFooterComponent={
            <RmabMissingSection title="Missing from your library" fetchMissing={fetchMissingByAuthor} />
          }
        />
      ) : (
        <FlatList
          data={books}
          renderItem={renderBookCard}
          keyExtractor={(item) => item.id}
          ListHeaderComponent={renderHeader}
          ListFooterComponent={
            <RmabMissingSection title="Missing from your library" fetchMissing={fetchMissingByAuthor} />
          }
          contentContainerStyle={{ paddingBottom: hasSession ? 100 : 32 }}
          showsVerticalScrollIndicator={false}
        />
      )}
    </SafeAreaView>
  );
}
