import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  ActivityIndicator,
  Animated,
  Easing,
  PanResponder,
  RefreshControl,
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
import BookdatePreferencesSheet from "../components/BookdatePreferencesSheet";
import { useRmabStore } from "../store/useRmabStore";
import {
  getBookdateRecommendations,
  clearRmabCaches,
  swipeBookdate,
  undoBookdateSwipe,
  getPopularBooks,
  getNewReleases,
  getAudibleCategories,
  getCategoryBooks,
  getHomeSections,
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

  // ── Shelves (the user's configured home sections, in their order) ───────
  const [shelves, setShelves] = useState<{ id: string; name: string; books: RmabBook[] | null }[]>([]);

  // ── Detail sheet ─────────────────────────────────────────────────────────
  const [detail, setDetail] = useState<RmabBook | null>(null);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [requesting, setRequesting] = useState(false);

  const translateX = useRef(new Animated.Value(0)).current;
  const enter = useRef(new Animated.Value(0)).current;

  // Async loads + the "Requested" chip timer resolve after navigation away —
  // guard every deferred setState and clear the timer on unmount.
  const aliveRef = useRef(true);
  const likedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Monotonic id per loadShelves() run: shelf ids repeat across runs
  // ("popular-0"…), so a load kicked off before a refresh could resolve after
  // it and clobber the fresh books with stale ones. Only the latest run may
  // write shelf state.
  const shelfLoadIdRef = useRef(0);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (likedTimerRef.current) clearTimeout(likedTimerRef.current);
    };
  }, []);

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
      if (!aliveRef.current) return;
      setDeck(recs);
      playEnter();
    } catch (e: any) {
      if (!aliveRef.current) return;
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

  const loadShelves = useCallback(async () => {
    const loadId = ++shelfLoadIdRef.current;
    // Shelf plan: the USER'S configured home sections (same as RMAB's web
    // home). Fallback for older servers: Popular + New Releases + the first
    // few Audible categories.
    type Plan = { id: string; name: string; load: () => Promise<RmabBook[]> };
    let plan: Plan[] = [];
    try {
      const sections = await getHomeSections();
      plan = (sections || [])
        .slice()
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((sec, i): Plan | null => {
          if (sec.sectionType === "popular")
            return { id: `popular-${i}`, name: "Popular", load: () => getPopularBooks() };
          if (sec.sectionType === "new_releases")
            return { id: `new-${i}`, name: "New Releases", load: () => getNewReleases() };
          if (sec.sectionType === "category" && sec.categoryId)
            return {
              id: `cat-${sec.categoryId}`,
              name: sec.categoryName || "Category",
              load: () => getCategoryBooks(String(sec.categoryId)),
            };
          return null;
        })
        .filter(Boolean) as Plan[];
    } catch (e) {
      console.warn("[Discover] home-sections unavailable, using defaults", e);
    }
    if (plan.length === 0) {
      plan = [
        { id: "popular", name: "Popular", load: () => getPopularBooks() },
        { id: "new", name: "New Releases", load: () => getNewReleases() },
      ];
      try {
        const cats = await getAudibleCategories();
        plan.push(
          ...(cats || []).slice(0, MAX_CATEGORY_SHELVES).map((c) => ({
            id: `cat-${c.id}`,
            name: c.name,
            load: () => getCategoryBooks(String(c.id)),
          }))
        );
      } catch {}
    }
    if (!aliveRef.current || loadId !== shelfLoadIdRef.current) return;
    setShelves(plan.map((p) => ({ id: p.id, name: p.name, books: null })));
    plan.forEach((p) =>
      p
        .load()
        .then((books) => {
          if (!aliveRef.current || loadId !== shelfLoadIdRef.current) return;
          setShelves((prev) => prev.map((s) => (s.id === p.id ? { ...s, books } : s)));
        })
        .catch(() => {
          if (!aliveRef.current || loadId !== shelfLoadIdRef.current) return;
          setShelves((prev) => prev.map((s) => (s.id === p.id ? { ...s, books: [] } : s)));
        })
    );
  }, []);

  useEffect(() => {
    loadDeck();
    loadShelves();
  }, [loadDeck, loadShelves]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    // Bypass the 15-minute discovery cache — a pull means "give me fresh".
    clearRmabCaches();
    setDeck(null);
    await Promise.all([loadDeck(), Promise.resolve(loadShelves())]);
    if (aliveRef.current) setRefreshing(false);
  }, [loadDeck, loadShelves]);

  const current = deck && deck.length > 0 ? deck[0] : null;
  const currentCover = current ? resolveRmabUrl(current.coverUrl) : undefined;

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
          // Keyed by the rec's stable id — duplicate titles must not clear
          // each other's chip.
          setLastLiked(rec.id);
          if (likedTimerRef.current) clearTimeout(likedTimerRef.current);
          likedTimerRef.current = setTimeout(() => {
            if (aliveRef.current) setLastLiked((t) => (t === rec.id ? null : t));
          }, 2400);
        }
      });
      try {
        await swipeBookdate(rec.id, action);
      } catch (e) {
        console.warn("[BookDate] swipe failed", e);
      } finally {
        if (aliveRef.current) setBusy(false);
      }
    },
    [current, busy, flyOut]
  );

  const onUndo = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await undoBookdateSwipe();
      if (!aliveRef.current) return;
      const rec = res?.recommendation;
      if (rec) {
        setDeck((d) => [rec, ...(d || [])]);
        playEnter();
      }
    } catch (e) {
      console.warn("[BookDate] undo failed", e);
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }, [busy, playEnter]);

  // ── Tinder-style drag on the card ────────────────────────────────────────
  // PanResponder is created once, so it reads live values through refs.
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const hasCardRef = useRef(false);
  hasCardRef.current = !!current;
  const onSwipeRef = useRef(onSwipe);
  onSwipeRef.current = onSwipe;
  const widthRef = useRef(screenWidth);
  widthRef.current = screenWidth;

  const springBack = useCallback(() => {
    Animated.spring(translateX, {
      toValue: 0,
      tension: 120,
      friction: 9,
      useNativeDriver: true,
    }).start();
  }, [translateX]);

  const panResponder = useRef(
    PanResponder.create({
      // Claim only clearly-horizontal drags: taps keep opening details and
      // vertical drags stay with the card's inner ScrollView.
      onMoveShouldSetPanResponder: (_, g) =>
        hasCardRef.current &&
        !busyRef.current &&
        Math.abs(g.dx) > 14 &&
        Math.abs(g.dx) > Math.abs(g.dy) * 1.4,
      onPanResponderMove: (_, g) => translateX.setValue(g.dx),
      onPanResponderRelease: (_, g) => {
        const w = widthRef.current;
        // Distance OR flick velocity commits the swipe; flyOut animates from
        // the card's current offset, so the motion continues seamlessly.
        if (g.dx > w * 0.3 || g.vx > 0.9) onSwipeRef.current("right");
        else if (g.dx < -w * 0.3 || g.vx < -0.9) onSwipeRef.current("left");
        else springBack();
      },
      onPanResponderTerminate: () => springBack(),
    })
  ).current;

  // Drag-direction stamps (Tinder-style): fade in as the card commits.
  const likeStampOpacity = translateX.interpolate({
    inputRange: [24, 120],
    outputRange: [0, 1],
    extrapolate: "clamp",
  });
  const passStampOpacity = translateX.interpolate({
    inputRange: [-120, -24],
    outputRange: [1, 0],
    extrapolate: "clamp",
  });

  const onRequestFromSheet = useCallback(
    async (book: RmabBook) => {
      setRequesting(true);
      try {
        await requestBook(book);
      } finally {
        // The request may resolve after navigation away.
        if (aliveRef.current) setRequesting(false);
      }
    },
    [requestBook]
  );

  const heroHeight = Math.min(560, Math.round(screenHeight * 0.6));

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }} edges={["top", "left", "right"]}>
      <TopAppBar navigation={navigation} />
      <ScrollView
        contentContainerStyle={{ paddingBottom: 110 }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
        }
      >
        {/* ── BookDate deck (hidden entirely when the server has it off) ── */}
        {!bdDisabled ? (
          <View style={{ paddingHorizontal: 20 }}>
            <View style={{ flexDirection: "row", alignItems: "center", marginTop: 8, marginBottom: 8 }}>
              <Text style={{ flex: 1, color: colors.onSurface, fontSize: 18, fontWeight: "600" }}>
                BookDate picks
              </Text>
              <Pressable
                onPress={() => setPrefsOpen(true)}
                accessibilityRole="button"
                accessibilityLabel="BookDate preferences"
                android_ripple={{ color: colors.onSurfaceVariant + "22", borderless: true, radius: 20 }}
                style={{ padding: 6 }}
              >
                <Icon name="settings" size={20} color={colors.onSurfaceVariant} />
              </Pressable>
            </View>
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
                  {...panResponder.panHandlers}
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
                  {/* Drag stamps */}
                  <Animated.View
                    pointerEvents="none"
                    style={{
                      position: "absolute",
                      top: 18,
                      left: 18,
                      zIndex: 2,
                      opacity: likeStampOpacity,
                      transform: [{ rotate: "-12deg" }],
                      borderWidth: 3,
                      borderColor: colors.primary,
                      borderRadius: 10,
                      paddingHorizontal: 10,
                      paddingVertical: 4,
                      backgroundColor: colors.primaryContainer + "E6",
                      flexDirection: "row",
                      alignItems: "center",
                    }}
                  >
                    <Icon name="heart" size={18} color={colors.onPrimaryContainer} />
                    <Text style={{ color: colors.onPrimaryContainer, fontSize: 16, fontWeight: "800", marginLeft: 6 }}>
                      REQUEST
                    </Text>
                  </Animated.View>
                  <Animated.View
                    pointerEvents="none"
                    style={{
                      position: "absolute",
                      top: 18,
                      right: 18,
                      zIndex: 2,
                      opacity: passStampOpacity,
                      transform: [{ rotate: "12deg" }],
                      borderWidth: 3,
                      borderColor: colors.error,
                      borderRadius: 10,
                      paddingHorizontal: 10,
                      paddingVertical: 4,
                      backgroundColor: (colors.errorContainer || "#F9DEDC") + "E6",
                      flexDirection: "row",
                      alignItems: "center",
                    }}
                  >
                    <Icon name="close" size={18} color={colors.error} />
                    <Text style={{ color: colors.error, fontSize: 16, fontWeight: "800", marginLeft: 6 }}>
                      PASS
                    </Text>
                  </Animated.View>
                  <ScrollView showsVerticalScrollIndicator={false} nestedScrollEnabled>
                    <Pressable
                      onPress={() => setDetail(current as any)}
                      accessibilityRole="button"
                      accessibilityLabel={`Details for ${current.title}`}
                    >
                      <Image
                        source={currentCover ? { uri: currentCover } : undefined}
                        // Fixed height (~half the hero): a full-width square
                        // cover ate the entire card and pushed the text out.
                        style={{
                          width: "100%",
                          height: Math.round(heroHeight * 0.52),
                          backgroundColor: colors.surfaceContainerHigh,
                        }}
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
                        {(current as any).aiReason ? (
                          <View
                            style={{
                              backgroundColor: colors.secondaryContainer,
                              borderRadius: 14,
                              padding: 12,
                              marginTop: 12,
                            }}
                          >
                            <Text
                              style={{
                                color: colors.onSecondaryContainer,
                                fontSize: 11,
                                fontWeight: "700",
                                letterSpacing: 0.8,
                                marginBottom: 4,
                              }}
                            >
                              WHY THIS WAS RECOMMENDED
                            </Text>
                            <Text style={{ color: colors.onSecondaryContainer, fontSize: 13, lineHeight: 19 }}>
                              {(current as any).aiReason}
                            </Text>
                          </View>
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
                    width: 60,
                    height: 60,
                    borderRadius: 30,
                    backgroundColor: colors.surfaceContainer,
                    alignItems: "center",
                    justifyContent: "center",
                    opacity: busy ? 0.5 : 1,
                  }}
                >
                  <Icon name="undo" size={26} color={colors.onSurfaceVariant} />
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

        {/* ── The user's configured home shelves ── */}
        {shelves.map((s) => (
          <Shelf key={s.id} title={s.name} books={s.books} onPressBook={setDetail} colors={colors} />
        ))}
      </ScrollView>

      <BookdatePreferencesSheet
        visible={prefsOpen}
        onClose={() => setPrefsOpen(false)}
        onSaved={() => loadDeck()}
      />

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
          renderItem={({ item }) => {
            const cover = resolveRmabUrl(item.coverArtUrl);
            return (
            <Pressable
              onPress={() => onPressBook(item)}
              accessibilityRole="button"
              accessibilityLabel={`Details for ${item.title}`}
              style={{ width: 110 }}
            >
              <View>
                <Image
                  source={cover ? { uri: cover } : undefined}
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
            );
          }}
        />
      )}
    </View>
  );
}
