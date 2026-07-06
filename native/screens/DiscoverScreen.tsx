import React, { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, ActivityIndicator, Animated, Easing, useWindowDimensions, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Image } from "expo-image";
import { useThemeColors } from "../theme/useThemeColors";
import Icon from "../components/Icon";
import Pressable from "../components/HintPressable";
import TopAppBar from "../components/TopAppBar";
import RmabBookDetailSheet from "../components/RmabBookDetailSheet";
import {
  getBookdateRecommendations,
  swipeBookdate,
  undoBookdateSwipe,
  resolveRmabUrl,
  BookdateRec,
} from "../utils/rmab";

/**
 * BookDate — ReadMeABook's AI recommendations as a swipe deck. Like (right)
 * asks the server to REQUEST the book; Pass (left) just records the swipe so
 * it never comes back. The deck refills from the server (cached unswiped recs
 * first, then a fresh AI generation — which can take a minute cold).
 */
export default function DiscoverScreen({ navigation }: any) {
  const colors = useThemeColors();
  const { width: screenWidth } = useWindowDimensions();
  const [deck, setDeck] = useState<BookdateRec[] | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [error, setError] = useState(false);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [lastLiked, setLastLiked] = useState<string | null>(null);
  const [detail, setDetail] = useState<any | null>(null);

  // Card motion: enters with a springy pop, exits flying left/right.
  const translateX = useRef(new Animated.Value(0)).current;
  const enter = useRef(new Animated.Value(0)).current;

  const playEnter = useCallback(() => {
    enter.setValue(0);
    translateX.setValue(0);
    Animated.spring(enter, { toValue: 1, tension: 90, friction: 8, useNativeDriver: true }).start();
  }, [enter, translateX]);

  const load = useCallback(async () => {
    try {
      setError(false);
      setDisabled(false);
      setGenerating(true);
      const recs = await getBookdateRecommendations();
      setDeck(recs);
      playEnter();
    } catch (e: any) {
      const status = e?.response?.status;
      const serverMsg = e?.response?.data?.error;
      // The server answers 400 (older builds 503) when BookDate isn't
      // configured/enabled.
      if (status === 400 || status === 503) setDisabled(true);
      else {
        console.warn("[BookDate] load failed", status, serverMsg || e?.message);
        setErrorDetail(serverMsg || (status ? `Server error (HTTP ${status})` : "Network error"));
        setError(true);
      }
      setDeck([]);
    } finally {
      setGenerating(false);
    }
  }, [playEnter]);

  useEffect(() => {
    load();
  }, [load]);

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

  // Deck ran dry: offer a manual refresh (a fresh AI generation).
  const empty = deck !== null && deck.length === 0;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }} edges={["top", "left", "right"]}>
      <TopAppBar navigation={navigation} />
      <View style={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: 4 }}>
        <Text style={{ color: colors.onSurface, fontSize: 22, fontWeight: "700" }}>Discover</Text>
        <Text style={{ color: colors.onSurfaceVariant, fontSize: 13, marginTop: 2 }}>
          BookDate picks based on your library — like to request
        </Text>
      </View>

      {deck === null ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 32 }}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={{ color: colors.onSurfaceVariant, marginTop: 16, textAlign: "center" }}>
            {generating ? "Asking BookDate for recommendations…\nA fresh batch can take a minute." : "Loading…"}
          </Text>
        </View>
      ) : disabled ? (
        <Empty
          icon="explore"
          title="BookDate isn't enabled"
          body="Ask your ReadMeABook admin to configure BookDate (AI recommendations) on the server."
          colors={colors}
        />
      ) : error ? (
        <Empty
          icon="warning"
          title="Couldn't load recommendations"
          body={errorDetail || "Check your connection and try again."}
          colors={colors}
          action={{ label: "Retry", onPress: load }}
        />
      ) : empty ? (
        <Empty
          icon="check"
          title="All caught up"
          body="You've been through this batch. Generate a fresh set of picks?"
          colors={colors}
          action={{ label: "Get more picks", onPress: load }}
        />
      ) : current ? (
        <View style={{ flex: 1, paddingHorizontal: 20, paddingTop: 8 }}>
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
            <ScrollView showsVerticalScrollIndicator={false}>
              <Pressable
                onPress={() => setDetail(current)}
                accessibilityRole="button"
                accessibilityLabel={`Details for ${current.title}`}
              >
              <Image
                source={resolveRmabUrl(current.coverUrl) ? { uri: resolveRmabUrl(current.coverUrl) } : undefined}
                style={{ width: "100%", aspectRatio: 1, backgroundColor: colors.surfaceContainerHigh }}
                contentFit="cover"
              />
              <View style={{ padding: 18 }}>
                <Text style={{ color: colors.onSurface, fontSize: 22, fontWeight: "700" }}>
                  {current.title}
                </Text>
                {current.author ? (
                  <Text style={{ color: colors.onSurfaceVariant, fontSize: 15, marginTop: 4 }}>
                    {current.author}
                    {current.narrator ? ` • read by ${current.narrator}` : ""}
                  </Text>
                ) : null}
                {current.description ? (
                  <Text style={{ color: colors.onSurfaceVariant, fontSize: 14, lineHeight: 21, marginTop: 12 }}>
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
                top: 16,
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
              <Text style={{ color: colors.onPrimaryContainer, fontSize: 13, fontWeight: "600", marginLeft: 6 }}>
                Requested
              </Text>
            </View>
          ) : null}

          {/* Pass / Undo / Like */}
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              columnGap: 20,
              paddingVertical: 16,
            }}
          >
            <Pressable
              onPress={() => onSwipe("left")}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel="Pass"
              android_ripple={{ color: colors.onSurfaceVariant + "22" }}
              style={{
                width: 64,
                height: 64,
                borderRadius: 32,
                backgroundColor: colors.surfaceContainerHigh,
                alignItems: "center",
                justifyContent: "center",
                opacity: busy ? 0.5 : 1,
              }}
            >
              <Icon name="close" size={30} color={colors.onSurfaceVariant} />
            </Pressable>
            <Pressable
              onPress={onUndo}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel="Undo last swipe"
              android_ripple={{ color: colors.onSurfaceVariant + "22" }}
              style={{
                width: 48,
                height: 48,
                borderRadius: 24,
                backgroundColor: colors.surfaceContainer,
                alignItems: "center",
                justifyContent: "center",
                opacity: busy ? 0.5 : 1,
              }}
            >
              <Icon name="undo" size={22} color={colors.onSurfaceVariant} />
            </Pressable>
            <Pressable
              onPress={() => onSwipe("right")}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel="Like and request"
              android_ripple={{ color: colors.onPrimaryContainer + "22" }}
              style={{
                width: 64,
                height: 64,
                borderRadius: 32,
                backgroundColor: colors.primaryContainer,
                alignItems: "center",
                justifyContent: "center",
                opacity: busy ? 0.5 : 1,
              }}
            >
              <Icon name="heart" size={30} color={colors.onPrimaryContainer} />
            </Pressable>
          </View>
        </View>
      ) : null}
      <RmabBookDetailSheet book={detail} onClose={() => setDetail(null)} />
    </SafeAreaView>
  );
}

function Empty({
  icon,
  title,
  body,
  colors,
  action,
}: {
  icon: any;
  title: string;
  body: string;
  colors: any;
  action?: { label: string; onPress: () => void };
}) {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 32 }}>
      <Icon name={icon} size={48} color={colors.onSurfaceVariant} />
      <Text style={{ color: colors.onSurface, fontSize: 18, fontWeight: "600", marginTop: 16, textAlign: "center" }}>
        {title}
      </Text>
      <Text style={{ color: colors.onSurfaceVariant, fontSize: 14, marginTop: 8, textAlign: "center" }}>
        {body}
      </Text>
      {action ? (
        <Pressable
          onPress={action.onPress}
          accessibilityRole="button"
          accessibilityLabel={action.label}
          android_ripple={{ color: colors.onPrimary + "22" }}
          style={{
            marginTop: 20,
            backgroundColor: colors.primary,
            borderRadius: 24,
            height: 48,
            paddingHorizontal: 28,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text style={{ color: colors.onPrimary, fontSize: 15, fontWeight: "600" }}>{action.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
