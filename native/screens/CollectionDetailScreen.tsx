import React, { useEffect, useState } from "react";
import { View, Text, Pressable, ScrollView, ActivityIndicator, Alert } from "react-native";
import { Image } from "expo-image";
import { coverSource } from "../utils/coverSource";
import { useThemeColors } from "../theme/useThemeColors";
import { SafeAreaView } from "react-native-safe-area-context";
import Animated from "react-native-reanimated";
import { listRowEnter } from "../theme/motion";
import { withAlpha } from "../theme/palette";
import { api } from "../utils/api";
import { useUserStore } from "../store/useUserStore";
import { usePlaybackStore } from "../store/usePlaybackStore";
import Icon from "../components/Icon";
import EmptyState from "../components/EmptyState";
import { isEbookOnly, hasAudio } from "../utils/bookMatch";
import BookProgressBadge from "../components/BookProgressBadge";
import { ListSkeleton } from "../components/Skeleton";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface CollectionBook {
  id: string;
  media?: {
    metadata?: {
      title?: string;
      authorName?: string;
    };
    duration?: number;
    tracks?: any[];
  };
  isMissing?: boolean;
  isInvalid?: boolean;
  userMediaProgress?: {
    isFinished?: boolean;
    progress?: number;
  };
}

function elapsedPretty(seconds: number): string {
  if (!seconds || seconds <= 0) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h} hr ${m} min`;
  if (m > 0) return `${m} min`;
  return `${Math.floor(seconds)} sec`;
}

export default function CollectionDetailScreen({ route, navigation }: any) {
  const colors = useThemeColors();
  const { collectionId } = route.params || {};
  const { serverConnectionConfig } = useUserStore();
  const startPlayback = usePlaybackStore((state) => state.startPlayback);
  const hasSession = usePlaybackStore((state) => state.currentSession !== null);

  const [collection, setCollection] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  const [starting, setStarting] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const serverAddress = serverConnectionConfig?.address?.replace(/\/$/, "") || "";
  const token = serverConnectionConfig?.token || "";

  const getCoverUrl = (itemId: string) => {
    if (!itemId || !serverAddress || !token) return null;
    return `${serverAddress}/api/items/${itemId}/cover?width=400&format=webp&token=${token}`;
  };

  useEffect(() => {
    if (!collectionId) {
      setError("No collection ID provided.");
      setLoading(false);
      return;
    }

    const fetchCollection = async () => {
      try {
        setLoading(true);
        setError(null);
        const response = await api.get(`/api/collections/${collectionId}`);
        setCollection(response.data);
      } catch (err) {
        console.error("[CollectionDetail] Failed to fetch collection:", err);
        setError("Failed to load collection.");
      } finally {
        setLoading(false);
      }
    };

    fetchCollection();
  }, [collectionId, retryTick]);

  // Coming back to this screen (e.g. after toggling this collection's
  // membership from a book's "Add to…" sheet): silently revalidate — no
  // loading flip, so no skeleton flash over the already-rendered list.
  const firstFocusRef = React.useRef(true);
  useEffect(() => {
    const unsub = navigation.addListener("focus", () => {
      if (firstFocusRef.current) {
        firstFocusRef.current = false;
        return;
      }
      if (!collectionId) return;
      api
        .get(`/api/collections/${collectionId}`)
        .then((r) => setCollection(r.data))
        .catch(() => {});
    });
    return unsub;
  }, [navigation, collectionId]);

  // "Hide non-audiobooks": ebook-only rows are dropped when the setting is on.
  const hideNonAudiobooks = useUserStore((s) => !!s.settings?.hideNonAudiobooksGlobal);
  // filter(Boolean) first: a single null entry in the payload threw during
  // render and blanked the whole app to the root error boundary.
  const bookItems: CollectionBook[] = (Array.isArray(collection?.books) ? collection.books : [])
    .filter(Boolean)
    .filter((b: any) => !hideNonAudiobooks || !isEbookOnly(b));
  const collectionName = collection?.name || "";
  const description = collection?.description || "";

  const playableItems = bookItems.filter(
    // hasAudio also understands minified payloads (numTracks/numAudioFiles) —
    // a raw media.tracks check hides play on collections the server minifies.
    (b) => !b.isMissing && !b.isInvalid && hasAudio(b)
  );
  const showPlayButton = playableItems.length > 0;
  const totalDuration = bookItems.reduce((t, b) => t + (b.media?.duration || 0), 0);

  // The collection payload carries no user progress — consult the global map
  // (fallback to the payload field) or "Play" always restarts the first book.
  const progressMap = useUserStore((s) => s.mediaProgress);
  const playNextItem = async () => {
    const next =
      playableItems.find(
        (pb) => !(progressMap[pb.id] || pb.userMediaProgress)?.isFinished
      ) || playableItems[0];
    if (!next || starting) return;
    setStarting(true);
    try {
      await startPlayback(next.id);
    } finally {
      setStarting(false);
    }
  };

  const playBook = async (bookId: string) => {
    if (starting) return;
    setStarting(true);
    try {
      await startPlayback(bookId);
    } finally {
      setStarting(false);
    }
  };

  const renderBookRow = (book: CollectionBook, index: number) => {
    const coverUrl = getCoverUrl(book.id);
    const bookTitle = book.media?.metadata?.title || "";
    const bookAuthor = book.media?.metadata?.authorName || "";
    const duration = book.media?.duration || 0;
    const showPlayBtn = !book.isMissing && !book.isInvalid && hasAudio(book);

    return (
      <AnimatedPressable
        key={book.id}
        entering={listRowEnter(index)}
        android_ripple={{ color: colors.surfaceContainerHighest }}
        style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 8 }}
        onPress={() => navigation.navigate("ItemDetail", { itemId: book.id })}
        accessibilityRole="button"
        accessibilityLabel={bookAuthor ? `${bookTitle} by ${bookAuthor}` : bookTitle}
        // The nested Play button collapses into this accessible row and is
        // unreachable by TalkBack — expose it as a custom action instead.
        accessibilityActions={showPlayBtn ? [{ name: "play", label: "Play" }] : undefined}
        onAccessibilityAction={(e) => {
          if (e.nativeEvent.actionName === "play") playBook(book.id);
        }}
      >
        {/* cover */}
        <View
          style={{
            width: 56,
            height: 80,
            borderRadius: 8,
            overflow: "hidden",
            backgroundColor: colors.surfaceContainerHigh,
            position: "relative",
          }}
        >
          {coverUrl ? (
            <Image source={coverSource(coverUrl)} style={{ width: 56, height: 80 }} contentFit="cover" />
          ) : (
            <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
              <Icon name="book" size={22} color={colors.onSurfaceVariant} />
            </View>
          )}
        </View>

        {/* title / author / duration */}
        <View style={{ flex: 1, marginLeft: 14 }}>
          <Text numberOfLines={2} style={{ color: colors.onSurface, fontSize: 15, fontWeight: "600", lineHeight: 20 }}>
            {bookTitle}
          </Text>
          {bookAuthor ? (
            <Text numberOfLines={1} style={{ color: colors.onSurfaceVariant, fontSize: 13, marginTop: 2 }}>
              {bookAuthor}
            </Text>
          ) : null}
          {duration ? (
            <Text style={{ color: colors.onSurfaceVariant, fontSize: 12, marginTop: 2 }}>
              {elapsedPretty(duration)}
            </Text>
          ) : null}
          <BookProgressBadge
            itemId={book.id}
            item={book}
            downloaded={(book as any).isLocal || !!(book as any).localLibraryItem}
            style={{ marginTop: 4 }}
          />
        </View>

        {/* pine-green circular play */}
        {showPlayBtn ? (
          <Pressable
            onPress={() => playBook(book.id)}
            hitSlop={6}
            android_ripple={{ color: withAlpha(colors.onPrimary, 0.2), radius: 24 }}
            accessibilityRole="button"
            accessibilityLabel={`Play ${bookTitle || "book"}`}
            style={{
              width: 48,
              height: 48,
              borderRadius: 24,
              overflow: "hidden",
              backgroundColor: colors.primary,
              alignItems: "center",
              justifyContent: "center",
              marginLeft: 8,
              elevation: 2,
              shadowColor: "#000",
              shadowOffset: { width: 0, height: 1 },
              shadowOpacity: 0.2,
              shadowRadius: 2,
            }}
          >
            <Icon name="play" size={26} color={colors.onPrimary} />
          </Pressable>
        ) : null}
      </AnimatedPressable>
    );
  };

  const handleDelete = () => {
    Alert.alert(
      "Delete collection?",
      `"${collectionName || "This collection"}" will be removed from your server. Your books aren't affected.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            if (!collectionId || deleting) return;
            setDeleting(true);
            try {
              await api.delete(`/api/collections/${collectionId}`);
              navigation.goBack();
            } catch {
              setDeleting(false);
              Alert.alert("Couldn't delete", "The collection couldn't be deleted. Check your connection and try again.");
            }
          },
        },
      ]
    );
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }} edges={["top", "left", "right"]}>
      {/* Header bar */}
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
          hitSlop={8}
          android_ripple={{ color: colors.surfaceContainerHighest, borderless: true, radius: 22 }}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={{ marginRight: 12, padding: 8, borderRadius: 20 }}
        >
          <Icon name="back" size={20} color={colors.onSurface} />
        </Pressable>
        <Text numberOfLines={1} style={{ flex: 1, color: colors.onSurface, fontSize: 20, fontWeight: "700" }}>
          {collectionName || "Collection"}
        </Text>
        {collection ? (
          <Pressable
            onPress={handleDelete}
            disabled={deleting}
            hitSlop={8}
            android_ripple={{ color: colors.surfaceContainerHighest, borderless: true, radius: 22 }}
            accessibilityRole="button"
            accessibilityLabel="Delete collection"
            accessibilityState={{ disabled: deleting, busy: deleting }}
            style={{ marginLeft: 8, padding: 8, borderRadius: 20, opacity: deleting ? 0.5 : 1 }}
          >
            <Icon name="trash" size={20} color={colors.onSurfaceVariant} />
          </Pressable>
        ) : null}
      </View>

      {loading ? (
        <ListSkeleton rows={7} thumb={64} />
      ) : error ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
          <Icon name="warning" size={40} color={colors.error} style={{ marginBottom: 12 }} />
          <Text style={{ color: colors.onSurfaceVariant, fontSize: 15, textAlign: "center" }}>{error}</Text>
          {collectionId ? (
            <Pressable
              onPress={() => setRetryTick((t) => t + 1)}
              android_ripple={{ color: withAlpha(colors.onPrimary, 0.2) }}
              accessibilityRole="button"
              accessibilityLabel="Retry loading collection"
              style={{ marginTop: 20, paddingHorizontal: 24, paddingVertical: 10, borderRadius: 24, overflow: "hidden", backgroundColor: colors.primary }}
            >
              <Text style={{ color: colors.onPrimary, fontSize: 15, fontWeight: "600" }}>Retry</Text>
            </Pressable>
          ) : null}
        </View>
      ) : collection ? (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: hasSession ? 100 : 32 }}>
          {/* Detail header: cover collage + title + count + Play all */}
          <View style={{ flexDirection: "row", paddingHorizontal: 16, paddingTop: 20, paddingBottom: 16 }}>
            <CollageCover bookItems={bookItems} size={120} getCoverUrl={getCoverUrl} colors={colors} />
            <View style={{ flex: 1, marginLeft: 16, justifyContent: "center" }}>
              <Text numberOfLines={3} style={{ color: colors.onSurface, fontSize: 22, fontWeight: "800" }}>
                {collectionName}
              </Text>
              <Text style={{ color: colors.onSurfaceVariant, fontSize: 14, marginTop: 4 }}>
                {bookItems.length} {bookItems.length === 1 ? "item" : "items"}
                {totalDuration ? `  ·  ${elapsedPretty(totalDuration)}` : ""}
              </Text>
              {showPlayButton ? (
                <Pressable
                  onPress={playNextItem}
                  disabled={starting}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "center",
                    alignSelf: "flex-start",
                    marginTop: 14,
                    paddingHorizontal: 20,
                    paddingVertical: 10,
                    borderRadius: 24,
                    backgroundColor: colors.primary,
                    opacity: starting ? 0.6 : 1,
                  }}
                >
                  {starting ? (
                    <ActivityIndicator size="small" color={colors.onPrimary} />
                  ) : (
                    <>
                      <Icon name="play" size={20} color={colors.onPrimary} />
                      <Text style={{ color: colors.onPrimary, fontSize: 15, fontWeight: "600", marginLeft: 6 }}>
                        Play all
                      </Text>
                    </>
                  )}
                </Pressable>
              ) : null}
            </View>
          </View>

          {description ? (
            <Text style={{ color: colors.onSurface, fontSize: 14, lineHeight: 20, paddingHorizontal: 16, paddingBottom: 12 }}>
              {description}
            </Text>
          ) : null}

          <View style={{ height: 1, backgroundColor: colors.outlineVariant, marginHorizontal: 16, marginBottom: 6 }} />

          {bookItems.length > 0 ? (
            bookItems.map((book, index) => renderBookRow(book, index))
          ) : (
            <EmptyState
              icon="collections"
              title="No items yet"
              message="Add books to this collection from a book's details screen."
            />
          )}
        </ScrollView>
      ) : null}
    </SafeAreaView>
  );
}

// Rounded collage: single cover fills, else 2 side-by-side over primary bg.
function CollageCover({
  bookItems,
  size,
  getCoverUrl,
  colors,
}: {
  bookItems: any[];
  size: number;
  getCoverUrl: (id: string) => string | null;
  colors: any;
}) {
  const covers = bookItems.slice(0, 2);
  return (
    <View style={{ width: size, height: size, borderRadius: 14, overflow: "hidden", backgroundColor: colors.primary }}>
      {covers.length === 0 ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 8 }}>
          <Text style={{ color: colors.onPrimary, fontSize: 12, textAlign: "center" }}>Empty Collection</Text>
        </View>
      ) : (
        <View style={{ flexDirection: "row", width: size, height: size }}>
          {covers.map((b, i) => {
            const uri = getCoverUrl(b.id);
            const w = covers.length === 1 ? size : size / 2;
            return (
              <View key={b.id || i} style={{ width: w, height: size }}>
                {uri ? (
                  <Image source={{ uri }} style={{ width: w, height: size }} contentFit="cover" />
                ) : (
                  <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
                    <Icon name="book" size={24} color={colors.onPrimary} />
                  </View>
                )}
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}
