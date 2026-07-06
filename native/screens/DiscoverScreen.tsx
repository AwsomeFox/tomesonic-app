import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  ActivityIndicator,
  Animated,
  Easing,
  useWindowDimensions,
  ScrollView,
  FlatList,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Image } from "expo-image";
import { useThemeColors } from "../theme/useThemeColors";
import Icon from "../components/Icon";
import Pressable from "../components/HintPressable";
import TopAppBar from "../components/TopAppBar";
import RmabBookDetailSheet from "../components/RmabBookDetailSheet";
import { useRmabStore } from "../store/useRmabStore";
import {
  getBookdateRecommendations,
  swipeBookdate,
  undoBookdateSwipe,
  getPopularBooks,
  getNewReleases,
  getAudibleCategories,
  getCategoryBooks,
  resolveRmabUrl,
  RmabBook,
  BookdateRec,
} from "../utils/rmab";

const MAX_CATEGORY_SHELVES = 6;

/**
 * Discover — RMAB's home page in the app: the BookDate swipe deck up top
 * (when the server has it enabled), then Popular / New Releases / Audible
 * category shelves. Shelf books open the shared detail sheet with a Request
 * action; the deck requests via Like.
 */
export default function DiscoverScreen({ navigation }: any) {
  const colors = useThemeColors();
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const requestedAsins = useRmabStore((s) => s.requestedAsins);
  const requestBook = useRmabStore((s) => s.requestBook);

  // ── BookDate deck ────────────────────────────────────────────────────────
  const [deck, setDeck] = useState<BookdateRec[] | null>(null);
  const [bdDisabled, setBdDisabled] = useState(false);
  const [bdError, setBdError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastLiked, setLastLiked] = useState<string | null>(null);

  // ── Shelves ──────────────────────────────────────────────────────────────
  const [popular, setPopular] = useState<RmabBook[] | null>(null);
  const [fresh, setFresh] = useState<RmabBook[] | null>(null);
  const [shelves, setShelves] = useState<{ id: string; name: string; books: RmabBook[] | null }[]>([]);

  // ── Detail sheet ─────────────────────────────────────────────────────────
  const [detail, setDetail] = useState<RmabBook | null>(null);
  const [requesting, setRequesting] = useState(false);

  const translateX = useRef(new Animated.Value(0)).current;
  const enter = useRef(new Animated.Value(0)).current;

  const playEnter = useCallback(() => {
    enter.setValue(0);
    translateX.setValue(0);
    Animated.spring(enter, { toValue: 1, tension: 90, friction: 8, useNativeDriver: true }).start();
  }, [enter, translateX]);

  const loadDeck = useCallback(async () => {
    try {
      setBdError(null);
      setBdDisabled(false);
      const recs = await getBookdateRecommendations();
      setDeck(recs);
      playEnter();
    } catch (e: any) {
      const status = e?.response?.status;
      // 400 (older builds 503) = BookDate isn't configured/enabled.
      if (status === 400 || status === 503) setBdDisabled(true);
      else {
        console.warn("[BookDate] load failed", status, e?.message);
        setBdError(e?.response?.data?.error || (status ? `Server error (HTTP ${status})` : "Network error"));
      }
      setDeck([]);
    }
  }, [playEnter]);

  const loadShelves = useCallback(() => {
    getPopularBooks()
      .then(setPopular)
      .catch(() => setPopular([]));
    getNewReleases()
      .then(setFresh)
      .catch(() => setFresh([]));
    getAudibleCategories()
      .then((cats) => {
        const chosen = (cats || []).slice(0, MAX_CATEGORY_SHELVES);
        setShelves(chosen.map((c) => ({ id: String(c.id), name: c.name, books: null })));
        chosen.forEach((c) =>
          getCategoryBooks(String(c.id))
            .then((books) =>
              setShelves((prev) => prev.map((s) => (s.id === String(c.id) ? { ...s, books } : s)))
            )
            .catch(() =>
              setShelves((prev) => prev.map((s) => (s.id === String(c.id) ? { ...s, books: [] } : s)))
            )
        );
      })
      .catch(() => setShelves([]));
  }, []);

  useEffect(() => {
    loadDeck();
    loadShelves();
  }, [loadDeck, loadShelves]);

  const current = deck && deck.length > 0 ? deck[0] : null;

  const flyOut = useCallback(
    (dir: 1 | -1, after: () => void) => {
      Animated.timing(translateX, {
        toValue: dir * (screenWidth + 120),
        duration: 240,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }).start(() => {
        after();
        playEnter();
      });
    },
    [translateX, screenWidth, playEnter]
  );

  const onSwipe = useCallback(
    async (action: "right" | "left") => {
      if (!current || busy) return;
      setBusy(true);
      const rec = current;
      flyOut(action === "right" ? 1 : -1, () => {
        setDeck((d) => (d || []).slice(1));
        if (action === "right") {
          setLastLiked(rec.title);
          setTimeout(() => setLastLiked((t) => (t === rec.title ? null : t)), 2400);
        }
      });
      try {
        await swipeBookdate(rec.id, action);
      } catch (e) {
        console.warn("[BookDate] swipe failed", e);
      } finally {
        setBusy(false);
      }
    },
    [current, busy, flyOut]
  );

  const onUndo = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await undoBookdateSwipe();
      const rec = res?.recommendation;
      if (rec) {
        setDeck((d) => [rec, ...(d || [])]);
        playEnter();
      }
    } catch (e) {
      console.warn("[BookDate] undo failed", e);
    } finally {
      setBusy(false);
    }
  }, [busy, playEnter]);

  const onRequestFromSheet = useCallback(
    async (book: RmabBook) => {
      setRequesting(true);
      await requestBook(book);
      setRequesting(false);
    },
    [requestBook]
  );

  const heroHeight = Math.min(560, Math.round(screenHeight * 0.6));

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }} edges={["top", "left", "right"]}>
      <TopAppBar navigation={navigation} />
      <ScrollView contentContainerStyle={{ paddingBottom: 110 }} showsVerticalScrollIndicator={false}>
        <View style={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: 4 }}>
          <Text style={{ color: colors.onSurface, fontSize: 22, fontWeight: "700" }}>Discover</Text>
        </View>

        {/* ── BookDate deck (hidden entirely when the server has it off) ── */}
        {!bdDisabled ? (
          <View style={{ paddingHorizontal: 20 }}>
            <Text style={{ color: colors.onSurface, fontSize: 18, fontWeight: "600", marginTop: 8, marginBottom: 8 }}>
              BookDate picks
            </Text>
            {deck === null ? (
              <View
                style={{
                  height: 180,
                  borderRadius: 24,
                  backgroundColor: colors.surfaceContainer,
                  alignItems: "center",
                  justifyContent: "center",
                  padding: 24,
                }}
              >
                <ActivityIndicator size="large" color={colors.primary} />
                <Text style={{ color: colors.onSurfaceVariant, marginTop: 12, textAlign: "center", fontSize: 13 }}>
                  Asking BookDate for picks — a fresh batch can take a minute.
                </Text>
              </View>
            ) : bdError ? (
              <View
                style={{
                  borderRadius: 24,
                  backgroundColor: colors.surfaceContainer,
                  alignItems: "center",
                  padding: 24,
                }}
              >
                <Text style={{ color: colors.onSurface, fontSize: 15, fontWeight: "600" }}>Couldn't load picks</Text>
                <Text style={{ color: colors.onSurfaceVariant, fontSize: 13, marginTop: 4, textAlign: "center" }}>
                  {bdError}
                </Text>
                <Pressable
                  onPress={loadDeck}
                  accessibilityRole="button"
                  accessibilityLabel="Retry"
                  android_ripple={{ color: colors.onSecondaryContainer + "22" }}
                  style={{
                    marginTop: 12,
                    backgroundColor: colors.secondaryContainer,
                    borderRadius: 20,
                    height: 40,
                    paddingHorizontal: 22,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Text style={{ color: colors.onSecondaryContainer, fontSize: 14, fontWeight: "600" }}>Retry</Text>
                </Pressable>
              </View>
            ) : deck.length === 0 ? (
              <View
                style={{
                  borderRadius: 24,
                  backgroundColor: colors.surfaceContainer,
                  alignItems: "center",
                  padding: 24,
                }}
              >
                <Icon name="check" size={32} color={colors.onSurfaceVariant} />
                <Text style={{ color: colors.onSurface, fontSize: 15, fontWeight: "600", marginTop: 8 }}>
                  All caught up
                </Text>
                <Pressable
                  onPress={loadDeck}
                  accessibilityRole="button"
                  accessibilityLabel="Get more picks"
                  android_ripple={{ color: colors.onPrimary + "22" }}
                  style={{
                    marginTop: 12,
                    backgroundColor: colors.primary,
                    borderRadius: 20,
                    height: 40,
                    paddingHorizontal: 22,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Text style={{ color: colors.onPrimary, fontSize: 14, fontWeight: "600" }}>Get more picks</Text>
                </Pressable>
              </View>
            ) : current ? (
              <View style={{ height: heroHeight }}>
                <Animated.View
                  style={{
                    flex: 1,
                    transform: [
                      { translateX },
                      {
                        rotate: translateX.interpolate({
                          inputRange: [-screenWidth, 0, screenWidth],
                          outputRange: ["-8deg", "0deg", "8deg"],
                        }),
                      },
                      { scale: enter.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] }) },
                    ],
                    opacity: enter,
                    backgroundColor: colors.surfaceContainer,
                    borderRadius: 24,
                    overflow: "hidden",
                  }}
                >
                  <ScrollView showsVerticalScrollIndicator={false} nestedScrollEnabled>
                    <Pressable
                      onPress={() => setDetail(current as any)}
                      accessibilityRole="button"
                      accessibilityLabel={`Details for ${current.title}`}
                    >
                      <Image
                        source={
                          resolveRmabUrl(current.coverUrl) ? { uri: resolveRmabUrl(current.coverUrl) } : undefined
                        }
                        style={{ width: "100%", aspectRatio: 1, backgroundColor: colors.surfaceContainerHigh }}
                        contentFit="cover"
                      />
                      <View style={{ padding: 18 }}>
                        <Text style={{ color: colors.onSurface, fontSize: 20, fontWeight: "700" }}>
                          {current.title}
                        </Text>
                        {current.author ? (
                          <Text style={{ color: colors.onSurfaceVariant, fontSize: 14, marginTop: 4 }}>
                            {current.author}
                            {current.narrator ? ` • read by ${current.narrator}` : ""}
                          </Text>
                        ) : null}
                        {current.description ? (
                          <Text
                            style={{ color: colors.onSurfaceVariant, fontSize: 13, lineHeight: 19, marginTop: 10 }}
                            numberOfLines={4}
                          >
                            {String(current.description).replace(/<[^>]+>/g, "").trim()}
                          </Text>
                        ) : null}
                      </View>
                    </Pressable>
                  </ScrollView>
                </Animated.View>

                {lastLiked ? (
                  <View
                    style={{
                      position: "absolute",
                      top: 12,
                      alignSelf: "center",
                      backgroundColor: colors.primaryContainer,
                      borderRadius: 16,
                      paddingHorizontal: 14,
                      paddingVertical: 6,
                      flexDirection: "row",
                      alignItems: "center",
                    }}
                  >
                    <Icon name="check" size={16} color={colors.onPrimaryContainer} />
                    <Text
                      style={{ color: colors.onPrimaryContainer, fontSize: 13, fontWeight: "600", marginLeft: 6 }}
                    >
                      Requested
                    </Text>
                  </View>
                ) : null}
              </View>
            ) : null}

            {current && !bdError ? (
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "center",
                  columnGap: 20,
                  paddingVertical: 12,
                }}
              >
                <Pressable
                  onPress={() => onSwipe("left")}
                  disabled={busy}
                  accessibilityRole="button"
                  accessibilityLabel="Pass"
                  android_ripple={{ color: colors.onSurfaceVariant + "22" }}
                  style={{
                    width: 60,
                    height: 60,
                    borderRadius: 30,
                    backgroundColor: colors.surfaceContainerHigh,
                    alignItems: "center",
                    justifyContent: "center",
                    opacity: busy ? 0.5 : 1,
                  }}
                >
                  <Icon name="close" size={28} color={colors.onSurfaceVariant} />
                </Pressable>
                <Pressable
                  onPress={onUndo}
                  disabled={busy}
                  accessibilityRole="button"
                  accessibilityLabel="Undo last swipe"
                  android_ripple={{ color: colors.onSurfaceVariant + "22" }}
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 22,
                    backgroundColor: colors.surfaceContainer,
                    alignItems: "center",
                    justifyContent: "center",
                    opacity: busy ? 0.5 : 1,
                  }}
                >
                  <Icon name="undo" size={20} color={colors.onSurfaceVariant} />
                </Pressable>
                <Pressable
                  onPress={() => onSwipe("right")}
                  disabled={busy}
                  accessibilityRole="button"
                  accessibilityLabel="Like and request"
                  android_ripple={{ color: colors.onPrimaryContainer + "22" }}
                  style={{
                    width: 60,
                    height: 60,
                    borderRadius: 30,
                    backgroundColor: colors.primaryContainer,
                    alignItems: "center",
                    justifyContent: "center",
                    opacity: busy ? 0.5 : 1,
                  }}
                >
                  <Icon name="heart" size={28} color={colors.onPrimaryContainer} />
                </Pressable>
              </View>
            ) : null}
          </View>
        ) : null}

        {/* ── RMAB home shelves ── */}
        <Shelf title="Popular" books={popular} onPressBook={setDetail} colors={colors} />
        <Shelf title="New Releases" books={fresh} onPressBook={setDetail} colors={colors} />
        {shelves.map((s) => (
          <Shelf key={s.id} title={s.name} books={s.books} onPressBook={setDetail} colors={colors} />
        ))}
      </ScrollView>

      <RmabBookDetailSheet
        book={detail}
        onClose={() => setDetail(null)}
        // BookDate recs carry audnexusAsin, not asin — RMAB's request payload
        // needs the real asin, so deck details stay info-only (Like requests).
        onRequest={detail && detail.asin && !detail.isAvailable ? onRequestFromSheet : undefined}
        requested={!!(detail && (requestedAsins[detail.asin] || detail.requestStatus))}
        requesting={requesting}
      />
    </SafeAreaView>
  );
}

/** Horizontal cover shelf. null books = loading row; empty = hidden. */
function Shelf({
  title,
  books,
  onPressBook,
  colors,
}: {
  title: string;
  books: RmabBook[] | null;
  onPressBook: (b: RmabBook) => void;
  colors: any;
}) {
  if (books !== null && books.length === 0) return null;
  return (
    <View style={{ marginTop: 20 }}>
      <Text
        style={{ color: colors.onSurface, fontSize: 18, fontWeight: "600", paddingHorizontal: 20, marginBottom: 10 }}
      >
        {title}
      </Text>
      {books === null ? (
        <View style={{ height: 150, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator size="small" color={colors.primary} />
        </View>
      ) : (
        <FlatList
          horizontal
          data={books}
          keyExtractor={(b) => b.asin}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 20, columnGap: 12 }}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => onPressBook(item)}
              accessibilityRole="button"
              accessibilityLabel={`Details for ${item.title}`}
              style={{ width: 110 }}
            >
              <View>
                <Image
                  source={resolveRmabUrl(item.coverArtUrl) ? { uri: resolveRmabUrl(item.coverArtUrl) } : undefined}
                  style={{ width: 110, height: 110, borderRadius: 10, backgroundColor: colors.surfaceContainerHigh }}
                  contentFit="cover"
                />
                {item.isAvailable ? (
                  <View
                    style={{
                      position: "absolute",
                      top: 6,
                      right: 6,
                      backgroundColor: colors.primaryContainer,
                      borderRadius: 10,
                      width: 20,
                      height: 20,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Icon name="check" size={13} color={colors.onPrimaryContainer} />
                  </View>
                ) : null}
              </View>
              <Text numberOfLines={2} style={{ color: colors.onSurface, fontSize: 12, fontWeight: "500", marginTop: 6 }}>
                {item.title}
              </Text>
              {item.author ? (
                <Text numberOfLines={1} style={{ color: colors.onSurfaceVariant, fontSize: 11, marginTop: 1 }}>
                  {item.author}
                </Text>
              ) : null}
            </Pressable>
          )}
        />
      )}
    </View>
  );
}
