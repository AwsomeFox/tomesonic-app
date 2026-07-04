import React, { useRef, useState, useEffect } from "react";
import {
  View,
  Text,
  Pressable,
  Image,
  ScrollView,
  LayoutChangeEvent,
  PanResponder,
  useWindowDimensions,
  BackHandler,
  StyleSheet,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  interpolate,
  Easing,
} from "react-native-reanimated";
import { usePlaybackStore } from "../store/usePlaybackStore";
import { useThemeColors } from "../theme/useThemeColors";
import { withAlpha } from "../theme/palette";
import { navigationRef } from "../navigation/navigationRef";
import Icon from "./Icon";
import PlaybackSpeedModal from "./PlaybackSpeedModal";
import SleepTimerModal from "./SleepTimerModal";
import BookmarksModal from "./BookmarksModal";
import { CastContext, CastButton } from "react-native-google-cast";
import ChaptersModal from "./ChaptersModal";
import { useDownloadStore } from "../store/useDownloadStore";
import WavyProgress from "./WavyProgress";
import Confetti from "./Confetti";
import { haptic } from "../utils/haptics";

const MINIPLAYER_HEIGHT = 68;

function secondsToTimestamp(seconds: number) {
  let s = seconds;
  if (!s || s < 0) s = 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
  }
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

export default function PlayerBottomSheet() {
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const win = useWindowDimensions();
  // useWindowDimensions can lag behind (or not fire) on rotation on some
  // devices, leaving the player at portrait width inside a landscape window.
  // Drive layout from the actually-measured root size instead (onLayout below).
  const [measured, setMeasured] = useState<{ w: number; h: number } | null>(null);
  const screenWidth = measured?.w ?? win.width;
  const screenHeight = measured?.h ?? win.height;
  const isLandscape = screenWidth > screenHeight;


  const {
    currentSession,
    isPlaying,
    playPause,
    position,
    duration,
    playbackSpeed,
    setPlaybackSpeed,
    seekForward,
    seekBackward,
    seek,
    chapters,
    currentChapterIndex,
    nextChapter,
    previousChapter,
    seekToChapter,
    sleepTimer,
    setSleepTimer,
    cancelSleepTimer,
    isPlayerExpanded,
    setPlayerExpanded,
  } = usePlaybackStore();

  const isPlayerExpandedRef = useRef(isPlayerExpanded);
  useEffect(() => {
    isPlayerExpandedRef.current = isPlayerExpanded;
  }, [isPlayerExpanded]);

  const [showChapters, setShowChapters] = useState(false);
  const [showSpeed, setShowSpeed] = useState(false);
  const [showSleepTimer, setShowSleepTimer] = useState(false);
  const [showBookmarks, setShowBookmarks] = useState(false);

  const playProgress = useSharedValue(isPlaying ? 1 : 0);

  useEffect(() => {
    playProgress.value = withTiming(isPlaying ? 1 : 0, { duration: 300 });
  }, [isPlaying]);

  // Celebrate when a book reaches its end — fires once per session.
  const [showConfetti, setShowConfetti] = useState(false);
  const celebratedRef = useRef<string | null>(null);
  useEffect(() => {
    const sessionId = currentSession?.id;
    if (!sessionId || !duration || duration <= 0) return;
    if (position >= duration - 2 && celebratedRef.current !== sessionId) {
      celebratedRef.current = sessionId;
      setShowConfetti(true);
    }
  }, [position, duration, currentSession?.id]);

  const [onTabScreen, setOnTabScreen] = useState(true);

  useEffect(() => {
    const TAB_ROUTES = ["Home", "Library", "Series", "Collections", "Authors"];
    const checkRoute = () => {
      if (navigationRef.isReady()) {
        const route: any = navigationRef.getCurrentRoute();
        if (route) {
          const isTab = TAB_ROUTES.includes(route.name) && !route.params?.showBack;
          setOnTabScreen(isTab);
        } else {
          setOnTabScreen(true);
        }
      }
    };
    checkRoute();
    const unsubscribe = navigationRef.addListener("state", () => {
      checkRoute();
    });
    return unsubscribe;
  }, []);

  const bottomOffset = onTabScreen ? 64 + insets.bottom : insets.bottom;

  // Animate bottom offset transitions (sliding tab bar offset)
  const bottomOffsetVal = useSharedValue(bottomOffset);
  useEffect(() => {
    bottomOffsetVal.value = withTiming(bottomOffset, {
      duration: 300,
      easing: Easing.out(Easing.cubic),
    });
  }, [bottomOffset]);

  // Shared value tracking sheet progress (0 = collapsed, 1 = expanded)
  const sheetProgress = useSharedValue(0);


  useEffect(() => {
    if (isPlayerExpanded) {
      sheetProgress.value = withSpring(1, { damping: 30, stiffness: 150, overshootClamping: true });
    } else {
      setShowChapters(false);
      sheetProgress.value = withSpring(0, { damping: 30, stiffness: 150, overshootClamping: true });
    }
  }, [isPlayerExpanded]);

  // Intercept hardware back button when expanded
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (isPlayerExpanded) {
        setPlayerExpanded(false);
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [isPlayerExpanded, setPlayerExpanded]);

  // Responsive layout for the expanded player. Rather than stretching edge to
  // edge, the content lives in a centered, max-width column (PW) so it stays
  // balanced on tablets (Pixel Tablet portrait is ~800dp wide); on phones PW ==
  // screenWidth so nothing changes. On tablets the whole block is also centered
  // vertically instead of anchored to the top.
  const isTablet = Math.min(screenWidth, screenHeight) >= 600;
  // Landscape cover: sized to fit the (short) height, capped by width.
  const LS_COVER = Math.round(Math.min(screenHeight - insets.top - insets.bottom - 48, screenWidth * 0.42));
  const PW = Math.min(screenWidth, 480); // content column width
  const PX = (screenWidth - PW) / 2; // column left inset
  const COVER_SIZE_EXP = Math.min(PW - 80, Math.round(screenHeight * 0.42), isTablet ? 420 : 320);
  const TOP_BAR_Y = insets.top + 8;
  // Height of the cover→secondary-row block (matches the offsets cascaded below),
  // used to vertically center it in the available space on large screens.
  const CONTENT_BLOCK_H = COVER_SIZE_EXP + 24 + 28 + 16 + 36 + 20 + 64 + 24 + 88 + 24 + 56;
  const availH = screenHeight - (TOP_BAR_Y + 56) - insets.bottom - 20;
  const extraTop = isTablet ? Math.max(0, (availH - CONTENT_BLOCK_H) / 2) : 0;
  const SOURCE_LABEL_Y = TOP_BAR_Y + 56 + 12 + extraTop;
  const COVER_Y_EXP = SOURCE_LABEL_Y + 20 + 8;
  const BOOK_PROGRESS_Y = COVER_Y_EXP + COVER_SIZE_EXP + 24;
  const CHAPTER_PROGRESS_Y = BOOK_PROGRESS_Y + 28 + 16;
  const TITLE_Y_EXP = CHAPTER_PROGRESS_Y + 36 + 20;
  const TRANSPORT_Y_EXP = TITLE_Y_EXP + 64 + 24;

  const dragRange = screenHeight - MINIPLAYER_HEIGHT - bottomOffset;

  // PanResponder to drive sheet progress via vertical dragging
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false, // Let children handle taps first (makes buttons clickable)
      onMoveShouldSetPanResponder: (evt, gestureState) => {
        const isVertical = Math.abs(gestureState.dy) > 5 && Math.abs(gestureState.dx) < Math.abs(gestureState.dy);
        if (!isVertical) return false;

        if (!isPlayerExpandedRef.current) {
          // Collapsed: since the container height is exactly MINIPLAYER_HEIGHT,
          // any gesture reaching this container is on the miniplayer.
          return true;
        }

        // Expanded: drag touch must start in the top region
        return gestureState.y0 < COVER_Y_EXP + COVER_SIZE_EXP + 16;
      },
      onPanResponderMove: (evt, gestureState) => {
        const range = screenHeight - MINIPLAYER_HEIGHT - bottomOffsetVal.value;
        if (isPlayerExpandedRef.current) {
          const newProgress = 1 - gestureState.dy / range;
          sheetProgress.value = Math.max(0, Math.min(1, newProgress));
        } else {
          const newProgress = -gestureState.dy / range;
          sheetProgress.value = Math.max(0, Math.min(1, newProgress));
        }
      },
      onPanResponderRelease: (evt, gestureState) => {
        const p = sheetProgress.value;
        // Fast swipe checks
        if (gestureState.vy < -0.3) {
          setPlayerExpanded(true);
          sheetProgress.value = withSpring(1, { damping: 30, stiffness: 150, overshootClamping: true });
        } else if (gestureState.vy > 0.3) {
          setPlayerExpanded(false);
          sheetProgress.value = withSpring(0, { damping: 30, stiffness: 150, overshootClamping: true });
        } else {
          // Slow drag snaps to closest state
          if (p > 0.5) {
            setPlayerExpanded(true);
            sheetProgress.value = withSpring(1, { damping: 30, stiffness: 150, overshootClamping: true });
          } else {
            setPlayerExpanded(false);
            sheetProgress.value = withSpring(0, { damping: 30, stiffness: 150, overshootClamping: true });
          }
        }
      },
      onPanResponderTerminate: () => {
        const p = sheetProgress.value;
        if (p > 0.5) {
          setPlayerExpanded(true);
          sheetProgress.value = withSpring(1, { damping: 30, stiffness: 150, overshootClamping: true });
        } else {
          setPlayerExpanded(false);
          sheetProgress.value = withSpring(0, { damping: 30, stiffness: 150, overshootClamping: true });
        }
      },
    })
  ).current;

  // Chapter scrubber drag state.
  const [chapterBarWidth, setChapterBarWidth] = useState(0);
  const [dragFrac, setDragFrac] = useState<number | null>(null);
  const chapterBarWidthRef = useRef(0);
  const chapterBoundsRef = useRef({ start: 0, end: 0, span: 0 });

  // Draggable chapter scrubber PanResponder
  const chapterScrubPanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => {
        const w = chapterBarWidthRef.current;
        if (!w) return;
        haptic();
        setDragFrac(Math.max(0, Math.min(1, e.nativeEvent.locationX / w)));
      },
      onPanResponderMove: (e) => {
        const w = chapterBarWidthRef.current;
        if (!w) return;
        setDragFrac(Math.max(0, Math.min(1, e.nativeEvent.locationX / w)));
      },
      onPanResponderRelease: (e) => {
        const w = chapterBarWidthRef.current;
        if (w) {
          const frac = Math.max(0, Math.min(1, e.nativeEvent.locationX / w));
          const { start, span } = chapterBoundsRef.current;
          if (span > 0) seek(start + frac * span);
          else if (duration > 0) seek(frac * duration);
        }
        setDragFrac(null);
      },
      onPanResponderTerminate: () => setDragFrac(null),
    })
  ).current;

  // --- Reanimated Style Interpolations ---

  // Fade black backdrop behind sheet
  const scrimStyle = useAnimatedStyle(() => {
    const p = sheetProgress.value;
    return {
      opacity: interpolate(p, [0, 1], [0, 0.45]),
    };
  });

  // Slide/scale sheet container
  const animatedContainerStyle = useAnimatedStyle(() => {
    const p = sheetProgress.value;
    const collapsedY = screenHeight - MINIPLAYER_HEIGHT - bottomOffsetVal.value;
    const translateY = collapsedY * (1 - p);
    const height = interpolate(p, [0, 1], [MINIPLAYER_HEIGHT, screenHeight]);

    return {
      transform: [{ translateY }],
      height,
    };
  });

  // Solid background card style (animates height and corners)
  const animatedBgStyle = useAnimatedStyle(() => {
    const p = sheetProgress.value;
    const height = interpolate(p, [0, 1], [MINIPLAYER_HEIGHT, screenHeight]);

    return {
      height,
      borderTopLeftRadius: interpolate(p, [0, 0.15, 0.85, 1], [0, 16, 16, 0]),
      borderTopRightRadius: interpolate(p, [0, 0.15, 0.85, 1], [0, 16, 16, 0]),
    };
  });

  // Fade in full-player-only details
  const animatedFullPlayerStyle = useAnimatedStyle(() => {
    const p = sheetProgress.value;
    return {
      opacity: p,
      pointerEvents: p > 0.8 ? "auto" : "none",
    };
  });

  // Landscape collapsed mini bar: visible only while collapsed.
  const animatedLandscapeMiniStyle = useAnimatedStyle(() => {
    const p = sheetProgress.value;
    return {
      opacity: 1 - p,
      pointerEvents: p < 0.2 ? "auto" : "none",
    };
  });

  // Book-spine sheen width scales with the cover (subtle at mini size, a real
  // spine highlight once expanded).
  const animatedSpineStyle = useAnimatedStyle(() => {
    const p = sheetProgress.value;
    return { width: interpolate(p, [0, 1], [4, 22]) };
  });

  // Morph Cover Art layout
  const animatedCoverStyle = useAnimatedStyle(() => {
    const p = sheetProgress.value;
    const leftCollapsed = 12;
    const leftExpanded = PX + (PW - COVER_SIZE_EXP) / 2;
    const topCollapsed = 9;
    const topExpanded = COVER_Y_EXP;

    return {
      width: interpolate(p, [0, 1], [50, COVER_SIZE_EXP]),
      height: interpolate(p, [0, 1], [50, COVER_SIZE_EXP]),
      left: interpolate(p, [0, 1], [leftCollapsed, leftExpanded]),
      top: interpolate(p, [0, 1], [topCollapsed, topExpanded]),
      borderRadius: interpolate(p, [0, 1], [8, 20]),
    };
  });

  // Morph Title & Author text block
  const animatedTitleBlockStyle = useAnimatedStyle(() => {
    const p = sheetProgress.value;
    const leftCollapsed = 74;
    const leftExpanded = PX + 24;
    const topCollapsed = 12;
    const topExpanded = TITLE_Y_EXP;
    const widthCollapsed = screenWidth - 74 - 176;
    const widthExpanded = PW - 48;

    return {
      left: interpolate(p, [0, 1], [leftCollapsed, leftExpanded]),
      top: interpolate(p, [0, 1], [topCollapsed, topExpanded]),
      width: interpolate(p, [0, 1], [widthCollapsed, widthExpanded]),
    };
  });

  const animatedTitleStyle = useAnimatedStyle(() => {
    const p = sheetProgress.value;
    return {
      fontSize: interpolate(p, [0, 1], [15, 22]),
      lineHeight: interpolate(p, [0, 1], [20, 28]),
      textAlign: p > 0.5 ? "center" : "left" as any,
    };
  });

  const animatedAuthorStyle = useAnimatedStyle(() => {
    const p = sheetProgress.value;
    return {
      fontSize: interpolate(p, [0, 1], [13, 15]),
      textAlign: p > 0.5 ? "center" : "left" as any,
    };
  });

  // "Chapter X of Y" caption — only meaningful (and only has room) when expanded.
  const animatedChapterCaptionStyle = useAnimatedStyle(() => {
    const p = sheetProgress.value;
    return {
      opacity: Math.max(0, Math.min(1, (p - 0.7) / 0.3)),
      textAlign: "center" as any,
    };
  });

  // Morph Play/Pause Button
  const animatedPlayPauseStyle = useAnimatedStyle(() => {
    const p = sheetProgress.value;
    const leftCollapsed = screenWidth - 122;
    const leftExpanded = PX + (PW - 88) / 2;
    const topCollapsed = 6;
    const topExpanded = TRANSPORT_Y_EXP;

    const width = interpolate(p, [0, 1], [56, 88]);
    const height = interpolate(p, [0, 1], [56, 88]);

    // Border radius morphs between rounded square (playProgress=0) and circle (playProgress=1)
    const collapsedRadius = interpolate(playProgress.value, [0, 1], [16, 28]);
    const expandedRadius = interpolate(playProgress.value, [0, 1], [20, 44]);
    const borderRadius = interpolate(p, [0, 1], [collapsedRadius, expandedRadius]);

    return {
      width,
      height,
      left: interpolate(p, [0, 1], [leftCollapsed, leftExpanded]),
      top: interpolate(p, [0, 1], [topCollapsed, topExpanded]),
      borderRadius,
    };
  });

  // Scale Play/Pause icon
  const animatedPlayIconStyle = useAnimatedStyle(() => {
    const p = sheetProgress.value;
    return {
      transform: [{ scale: interpolate(p, [0, 1], [1, 44 / 30]) }],
    };
  });


  // Morph Replay-30 Button
  const animatedReplayStyle = useAnimatedStyle(() => {
    const p = sheetProgress.value;
    const leftCollapsed = screenWidth - 176;
    const leftExpanded = PX + (PW - 88) / 2 - 72;
    const topCollapsed = 12;
    const topExpanded = TRANSPORT_Y_EXP + 16;

    return {
      width: interpolate(p, [0, 1], [44, 56]),
      height: interpolate(p, [0, 1], [44, 56]),
      left: interpolate(p, [0, 1], [leftCollapsed, leftExpanded]),
      top: interpolate(p, [0, 1], [topCollapsed, topExpanded]),
      borderRadius: interpolate(p, [0, 1], [22, 28]),
    };
  });

  // Morph Forward-30 Button
  const animatedForwardStyle = useAnimatedStyle(() => {
    const p = sheetProgress.value;
    const leftCollapsed = screenWidth - 56;
    const leftExpanded = PX + (PW - 88) / 2 + 104;
    const topCollapsed = 12;
    const topExpanded = TRANSPORT_Y_EXP + 16;

    return {
      width: interpolate(p, [0, 1], [44, 56]),
      height: interpolate(p, [0, 1], [44, 56]),
      left: interpolate(p, [0, 1], [leftCollapsed, leftExpanded]),
      top: interpolate(p, [0, 1], [topCollapsed, topExpanded]),
      borderRadius: interpolate(p, [0, 1], [22, 28]),
    };
  });

  // Scale Replay/Forward icons
  const animatedSmallIconStyle = useAnimatedStyle(() => {
    const p = sheetProgress.value;
    return {
      transform: [{ scale: interpolate(p, [0, 1], [1, 26 / 24]) }],
    };
  });

  // Pinned progress bar at bottom of miniplayer
  const animatedMiniProgressStyle = useAnimatedStyle(() => {
    const p = sheetProgress.value;
    return {
      opacity: interpolate(p, [0, 0.2], [1, 0]),
    };
  });

  // Flat hairline top divider opacity animation
  const animatedHairlineStyle = useAnimatedStyle(() => {
    return {
      opacity: interpolate(sheetProgress.value, [0, 0.15], [1, 0]),
    };
  });

  if (!currentSession) return null;

  const progress = duration > 0 ? Math.min(Math.max(position / duration, 0), 1) : 0;
  const mediaTitle = currentSession.displayTitle || "Unknown Audiobook";
  const authorName = currentSession.displayAuthor || "Unknown Author";
  const coverUrl = currentSession.coverUrl || "";
  const completedDownloads = useDownloadStore.getState().completedDownloads;
  const bookId =
    currentSession?.libraryItemId ||
    currentSession?.libraryItem?.id ||
    currentSession?.id;
  const isDownloaded = !!(bookId && completedDownloads[bookId]);

  const isLocal = !!(
    isDownloaded ||
    currentSession.isLocal ||
    currentSession.localLibraryItem ||
    currentSession.localMediaProgress
  );
  const sourceLabel = isLocal ? "LOCAL" : "STREAMING";

  const hasChapters = chapters && chapters.length > 0;
  const currentChapter =
    hasChapters && currentChapterIndex >= 0 && currentChapterIndex < chapters.length
      ? chapters[currentChapterIndex]
      : null;
  const currentChapterTitle = currentChapter?.title || "";

  const title = currentChapterTitle || mediaTitle;

  const bookFrac = duration > 0 ? Math.min(position / duration, 1) : 0;
  const bookRemaining = Math.max(0, duration - position);

  const chapterStart = currentChapter ? currentChapter.start || 0 : 0;
  const chapterEnd = currentChapter ? currentChapter.end || duration : duration;
  const chapterSpan = Math.max(0, chapterEnd - chapterStart);
  chapterBoundsRef.current = { start: chapterStart, end: chapterEnd, span: chapterSpan };

  const liveChapterFrac =
    chapterSpan > 0 ? Math.min(Math.max((position - chapterStart) / chapterSpan, 0), 1) : bookFrac;
  const chapterFrac = dragFrac != null ? dragFrac : liveChapterFrac;

  const chapterElapsed = currentChapter ? chapterFrac * chapterSpan : position;
  const chapterRemaining = currentChapter ? Math.max(0, chapterSpan - chapterElapsed) : bookRemaining;
  const chapterDuration = currentChapter ? chapterSpan : duration;

  // Both orientation subtrees stay mounted (display-toggled), and BOTH
  // scrubbers call onLayout — only the visible one may own the width ref, or
  // the hidden subtree's stale width breaks seek accuracy after rotation.
  const onChapterBarLayoutFor = (forLandscape: boolean) => (e: LayoutChangeEvent) => {
    if (forLandscape !== isLandscape) return;
    const w = e.nativeEvent.layout.width;
    setChapterBarWidth(w);
    chapterBarWidthRef.current = w;
  };

  // Circular transport helper button style
  const CircleButton = ({
    icon,
    iconSize = 22,
    onPress,
    disabled,
  }: {
    icon: any;
    iconSize?: number;
    onPress: () => void;
    disabled?: boolean;
  }) => (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={{
        width: 56,
        height: 56,
        borderRadius: 28,
        backgroundColor: colors.secondaryContainer,
        alignItems: "center",
        justifyContent: "center",
        elevation: 1,
      }}
    >
      <Icon
        name={icon}
        size={iconSize}
        color={
          disabled
            ? withAlpha(colors.onSecondaryContainer, 0.4)
            : colors.onSecondaryContainer
        }
      />
    </Pressable>
  );

  return (
    <View
      style={[StyleSheet.absoluteFill, { zIndex: 100 }]}
      pointerEvents={isPlayerExpanded ? "auto" : "box-none"}
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        if (width && height) {
          setMeasured((m) => (m && m.w === width && m.h === height ? m : { w: width, h: height }));
        }
      }}
    >
      {/* Backdrop black scrim */}
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { backgroundColor: "#000" }, scrimStyle]}
      />

      <Animated.View
        {...panResponder.panHandlers}
        pointerEvents="auto"
        style={[
          {
            position: "absolute",
            left: 0,
            right: 0,
            top: 0,
            backgroundColor: "transparent",
            overflow: "hidden",
          },
          animatedContainerStyle,
        ]}
      >
        {/* Animated Solid Background Card */}
        <Animated.View
          style={[
            {
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              backgroundColor: colors.surface,
              elevation: 10,
              shadowColor: "#000",
              shadowOffset: { width: 0, height: -3 },
              shadowOpacity: 0.2,
              shadowRadius: 6,
            },
            animatedBgStyle,
          ]}
        />
        {/* Flat hairline top divider for collapsed miniplayer */}
        <Animated.View
          style={[
            {
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              height: 1,
              backgroundColor: withAlpha(colors.outlineVariant, 0.5),
            },
            animatedHairlineStyle,
          ]}
        />

        {/* Collapsed tap target to expand */}
        {!isPlayerExpanded && (
          <Pressable
            onPress={() => setPlayerExpanded(true)}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              height: MINIPLAYER_HEIGHT,
              zIndex: 5,
            }}
          />
        )}

        {/* Both orientation layouts stay mounted; we toggle visibility with
            display:none rather than unmounting, because conditionally unmounting
            Reanimated views leaves ghost native views on rotation (New Arch). */}
        <View
          style={[StyleSheet.absoluteFill, { display: isLandscape ? "none" : "flex" }]}
          pointerEvents={isLandscape ? "none" : "box-none"}
        >
        {/* --- FULL PLAYER LAYOUT (OPACITY FADED IN) --- */}
        <Animated.View
          style={[
            StyleSheet.absoluteFill,
            { paddingTop: insets.top, paddingBottom: insets.bottom },
            animatedFullPlayerStyle,
          ]}
        >
            <ScrollView
              contentContainerStyle={{ flexGrow: 1, paddingHorizontal: PX + 24, paddingBottom: 24 }}
              showsVerticalScrollIndicator={false}
              scrollEnabled={false} // Disable ScrollView scroll so drag gesture runs cleanly
            >
              {/* Top Row: Chevron, Cast, Chapters List, Book details.
                  Pulled out to (near) full width so the nav buttons sit near the
                  corners even when the content column is narrower on tablets. */}
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  paddingTop: 8,
                  marginHorizontal: -PX,
                  height: TOP_BAR_Y + 56 - insets.top, // Align correctly with TOP_BAR_Y relative to inside padding
                }}
              >
                <Pressable
                  onPress={() => setPlayerExpanded(false)}
                  style={{
                    width: 56,
                    height: 56,
                    borderRadius: 28,
                    backgroundColor: colors.secondaryContainer,
                    alignItems: "center",
                    justifyContent: "center",
                    elevation: 1,
                  }}
                >
                  <Icon name="chevron-down" size={28} color={colors.onSecondaryContainer} />
                </Pressable>
                <View style={{ flexDirection: "row", columnGap: 12 }}>
                  <Pressable
                    onPress={() => {
                      try {
                        CastContext.showCastDialog();
                      } catch (err) {
                        console.warn("Cast picker failed", err);
                      }
                    }}
                    style={{
                      width: 56,
                      height: 56,
                      borderRadius: 28,
                      backgroundColor: colors.secondaryContainer,
                      alignItems: "center",
                      justifyContent: "center",
                      elevation: 1,
                    }}
                  >
                    <View pointerEvents="none">
                      <CastButton style={{ width: 30, height: 30, tintColor: colors.onSecondaryContainer }} />
                    </View>
                  </Pressable>
                  <Pressable
                    onPress={() => setShowChapters(true)}
                    disabled={!hasChapters}
                    style={{
                      width: 56,
                      height: 56,
                      borderRadius: 28,
                      backgroundColor: colors.secondaryContainer,
                      alignItems: "center",
                      justifyContent: "center",
                      elevation: 1,
                    }}
                  >
                    <Icon
                      name="list"
                      size={22}
                      color={
                        hasChapters
                          ? colors.onSecondaryContainer
                          : withAlpha(colors.onSecondaryContainer, 0.4)
                      }
                    />
                  </Pressable>
                  <Pressable
                    onPress={() => {
                      setPlayerExpanded(false);
                      const targetId =
                        currentSession?.libraryItemId ||
                        currentSession?.libraryItem?.id ||
                        currentSession?.id;
                      if (targetId) {
                        setTimeout(() => {
                          if (navigationRef.isReady()) {
                            (navigationRef.navigate as any)("ItemDetail", { itemId: targetId });
                          }
                        }, 300);
                      }
                    }}
                    style={{
                      width: 56,
                      height: 56,
                      borderRadius: 28,
                      backgroundColor: colors.secondaryContainer,
                      alignItems: "center",
                      justifyContent: "center",
                      elevation: 1,
                    }}
                  >
                    <Icon name="book" size={22} color={colors.onSecondaryContainer} />
                  </Pressable>
                </View>
              </View>

              {/* Source label */}
              <View style={{ marginTop: 12 + extraTop, justifyContent: "center" }}>
                <Text
                  style={{
                    color: colors.onSurfaceVariant,
                    textAlign: "center",
                    fontSize: 12,
                    fontWeight: "500",
                    letterSpacing: 1.5,
                  }}
                >
                  {sourceLabel}
                </Text>
              </View>

              {/* Cover Art Placeholder (absolute layout overlay handles actual artwork rendering) */}
              <View style={{ height: COVER_SIZE_EXP, marginTop: COVER_Y_EXP - SOURCE_LABEL_Y - 20 }} />

              {/* Book progress bar */}
              <View style={{ marginTop: BOOK_PROGRESS_Y - COVER_Y_EXP - COVER_SIZE_EXP, height: 28, justifyContent: "center" }}>
                <View style={{ flexDirection: "row", marginBottom: 4 }}>
                  <Text style={{ fontFamily: "monospace", color: colors.onSurface, fontSize: 13 }}>
                    {secondsToTimestamp(position)}
                  </Text>
                  <View style={{ flexGrow: 1 }} />
                  <Text style={{ fontFamily: "monospace", color: colors.onSurface, fontSize: 13 }}>
                    -{secondsToTimestamp(bookRemaining)}
                  </Text>
                </View>
                {/* Book progress — subtle wave while playing, clean flat line
                    when paused; a clearly-visible full-width track. */}
                <WavyProgress
                  progress={bookFrac}
                  playing={isPlaying}
                  color={colors.primary}
                  trackColor={withAlpha(colors.primary, 0.35)}
                  height={12}
                  strokeWidth={3}
                  amplitude={2}
                  wavelength={48}
                  flattenWhenPaused
                />
              </View>

              {/* Chapter progress bar scrubber */}
              <View
                style={{
                  marginTop: CHAPTER_PROGRESS_Y - BOOK_PROGRESS_Y - 28,
                  height: 36,
                  justifyContent: "center",
                }}
              >
                <View style={{ flexDirection: "row", marginBottom: 4 }}>
                  <Text style={{ fontFamily: "monospace", color: colors.onSurface, fontSize: 13 }}>
                    {secondsToTimestamp(chapterElapsed)}
                  </Text>
                  <View style={{ flexGrow: 1 }} />
                  <Text style={{ fontFamily: "monospace", color: colors.onSurface, fontSize: 13 }}>
                    -{secondsToTimestamp(chapterRemaining)}
                  </Text>
                </View>
                <View
                  {...chapterScrubPanResponder.panHandlers}
                  onLayout={onChapterBarLayoutFor(false)}
                  style={{ height: 32, justifyContent: "center" }}
                  hitSlop={{ top: 8, bottom: 8 }}
                >
                  {/* Wavy M3 slider: played chapter is a bold scrolling wave,
                      remainder a flat track, with a handle pinned exactly to the
                      wave's end (handled inside WavyProgress). */}
                  <WavyProgress
                    progress={chapterFrac}
                    playing={isPlaying}
                    color={colors.primary}
                    trackColor={withAlpha(colors.primary, 0.22)}
                    height={22}
                    strokeWidth={4}
                    amplitude={3.5}
                    wavelength={44}
                    showStopDot={false}
                    showHandle
                    handleActive={dragFrac != null}
                  />
                </View>
              </View>

              {/* Title & Author Placeholder (absolute overlay handles actual rendering) */}
              <View style={{ height: 64, marginTop: TITLE_Y_EXP - CHAPTER_PROGRESS_Y - 36 }} />

              {/* Transport Row Placeholder */}
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginTop: TRANSPORT_Y_EXP - TITLE_Y_EXP - 64,
                  height: 88,
                }}
              >
                {/* Skip previous */}
                <CircleButton
                  icon="skip-previous"
                  iconSize={24}
                  onPress={() => { haptic(); previousChapter(); }}
                  disabled={!hasChapters}
                />
                {/* Replay placeholder */}
                <View style={{ width: 56, height: 56 }} />
                {/* Play/Pause placeholder */}
                <View style={{ width: 88, height: 88 }} />
                {/* Forward placeholder */}
                <View style={{ width: 56, height: 56 }} />
                {/* Skip next */}
                <CircleButton
                  icon="skip-next"
                  iconSize={24}
                  onPress={() => { haptic(); nextChapter(); }}
                  disabled={!hasChapters}
                />
              </View>

              {/* Secondary row: sleep-timer · speed pill · bookmark */}
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "center",
                  marginTop: 24,
                  columnGap: 28,
                }}
              >
                <Pressable
                  onPress={() => { haptic(); setShowSleepTimer(true); }}
                  style={{
                    minWidth: 56,
                    paddingHorizontal: sleepTimer ? 16 : 0,
                    height: 56,
                    borderRadius: 28,
                    backgroundColor: sleepTimer ? colors.primaryContainer : colors.secondaryContainer,
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "center",
                    elevation: 1,
                  }}
                >
                  <Icon
                    name="moon"
                    size={22}
                    color={sleepTimer ? colors.onPrimaryContainer : colors.onSecondaryContainer}
                  />
                  {sleepTimer ? (
                    <Text
                      style={{
                        color: colors.onPrimaryContainer,
                        fontSize: 14,
                        fontWeight: "600",
                        fontFamily: "monospace",
                        marginLeft: 8,
                      }}
                    >
                      {secondsToTimestamp(sleepTimer.remaining)}
                    </Text>
                  ) : null}
                </Pressable>
                <Pressable
                  onPress={() => { haptic(); setShowSpeed(true); }}
                  style={{
                    paddingHorizontal: 24,
                    height: 56,
                    borderRadius: 28,
                    backgroundColor: colors.secondaryContainer,
                    alignItems: "center",
                    justifyContent: "center",
                    elevation: 1,
                  }}
                >
                  <Text style={{ fontSize: 18, fontWeight: "500", color: colors.onSecondaryContainer }}>
                    {playbackSpeed}×
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => { haptic(); setShowBookmarks(true); }}
                  style={{
                    width: 56,
                    height: 56,
                    borderRadius: 28,
                    backgroundColor: colors.secondaryContainer,
                    alignItems: "center",
                    justifyContent: "center",
                    elevation: 1,
                  }}
                >
                  <Icon name="bookmark" size={22} color={colors.onSecondaryContainer} />
                </Pressable>
              </View>
            </ScrollView>
        </Animated.View>

        {/* --- MORPHING ELEMENTS (ABSOLUTE OVERLAYS) --- */}

        {/* 1. Cover Art */}
        <Animated.View
          pointerEvents="none"
          style={[
            {
              position: "absolute",
              overflow: "hidden",
              backgroundColor: colors.surfaceContainerHigh,
              alignItems: "center",
              justifyContent: "center",
              shadowColor: "#000",
              shadowOffset: { width: 0, height: 2 },
              shadowOpacity: 0.1,
              shadowRadius: 4,
            },
            animatedCoverStyle,
          ]}
        >
          {coverUrl ? (
            <Image source={{ uri: coverUrl }} style={{ width: "100%", height: "100%" }} resizeMode="cover" />
          ) : (
            <Icon name="book" size={32} color={withAlpha(colors.onSurface, 0.4)} />
          )}
          {/* Book-spine sheen: a dark edge + thin highlight on the left. */}
          {coverUrl ? (
            <Animated.View
              pointerEvents="none"
              style={[{ position: "absolute", left: 0, top: 0, bottom: 0 }, animatedSpineStyle]}
            >
              <LinearGradient
                colors={["rgba(0,0,0,0.35)", "rgba(0,0,0,0.12)", "rgba(255,255,255,0.10)", "rgba(0,0,0,0)"]}
                locations={[0, 0.35, 0.6, 1]}
                start={{ x: 0, y: 0.5 }}
                end={{ x: 1, y: 0.5 }}
                style={{ flex: 1 }}
              />
            </Animated.View>
          ) : null}
        </Animated.View>

        {/* 2. Title & Author */}
        <Animated.View
          pointerEvents="none"
          style={[
            {
              position: "absolute",
              justifyContent: "center",
            },
            animatedTitleBlockStyle,
          ]}
        >
          <Animated.Text
            numberOfLines={1}
            style={[
              {
                color: colors.onSurface,
                fontWeight: "700",
                fontFamily: "serif",
              },
              animatedTitleStyle,
            ]}
          >
            {title}
          </Animated.Text>
          <Animated.Text
            numberOfLines={1}
            style={[
              {
                color: colors.onSurfaceVariant,
                marginTop: 1,
              },
              animatedAuthorStyle,
            ]}
          >
            {authorName}
          </Animated.Text>
          {hasChapters && currentChapterIndex >= 0 ? (
            <Animated.Text
              numberOfLines={1}
              style={[
                { color: colors.onSurfaceVariant, fontSize: 12, marginTop: 4, letterSpacing: 0.4 },
                animatedChapterCaptionStyle,
              ]}
            >
              Chapter {currentChapterIndex + 1} of {chapters.length}
            </Animated.Text>
          ) : null}
        </Animated.View>

        {/* 3. Replay-30 Button */}
        <Animated.View
          style={[
            {
              position: "absolute",
              backgroundColor: colors.secondaryContainer,
              alignItems: "center",
              justifyContent: "center",
              zIndex: 10,
            },
            animatedReplayStyle,
          ]}
        >
          <Pressable
            onPress={() => { haptic(); seekBackward(30); }}
            hitSlop={6}
            style={{ width: "100%", height: "100%", alignItems: "center", justifyContent: "center" }}
          >
            <Animated.View style={animatedSmallIconStyle}>
              <Icon name="replay-30" size={24} color={colors.onSecondaryContainer} />
            </Animated.View>
          </Pressable>
        </Animated.View>

        {/* 4. Play/Pause Button */}
        <Animated.View
          style={[
            {
              position: "absolute",
              backgroundColor: colors.primary,
              alignItems: "center",
              justifyContent: "center",
              zIndex: 10,
            },
            animatedPlayPauseStyle,
          ]}
        >
          <Pressable
            onPress={() => { haptic(); playPause(); }}
            hitSlop={6}
            style={{ width: "100%", height: "100%", alignItems: "center", justifyContent: "center" }}
          >
            <Animated.View style={animatedPlayIconStyle}>
              <Icon name={isPlaying ? "pause" : "play"} size={30} color={colors.onPrimary} />
            </Animated.View>
          </Pressable>
        </Animated.View>

        {/* 5. Forward-30 Button */}
        <Animated.View
          style={[
            {
              position: "absolute",
              backgroundColor: colors.secondaryContainer,
              alignItems: "center",
              justifyContent: "center",
              zIndex: 10,
            },
            animatedForwardStyle,
          ]}
        >
          <Pressable
            onPress={() => { haptic(); seekForward(30); }}
            hitSlop={6}
            style={{ width: "100%", height: "100%", alignItems: "center", justifyContent: "center" }}
          >
            <Animated.View style={animatedSmallIconStyle}>
              <Icon name="forward-30" size={24} color={colors.onSecondaryContainer} />
            </Animated.View>
          </Pressable>
        </Animated.View>

        {/* 6. Pinned miniplayer progress wave at bottom of mini player slot */}
        <Animated.View
          pointerEvents="none"
          style={[
            {
              position: "absolute",
              left: 0,
              right: 0,
              top: MINIPLAYER_HEIGHT - 10,
            },
            animatedMiniProgressStyle,
          ]}
        >
          <WavyProgress
            progress={progress}
            playing={isPlaying}
            color={colors.primary}
            trackColor={withAlpha(colors.primary, 0.2)}
            height={10}
            strokeWidth={2.5}
          />
        </Animated.View>
        </View>

        <View
          style={[StyleSheet.absoluteFill, { display: isLandscape ? "flex" : "none" }]}
          pointerEvents={isLandscape ? "box-none" : "none"}
        >
          {/* ===== LANDSCAPE: collapsed mini bar + two-pane expanded ===== */}
          <Animated.View
            style={[
              {
                position: "absolute", left: 0, right: 0, top: 0, height: MINIPLAYER_HEIGHT,
                zIndex: 8, flexDirection: "row", alignItems: "center", paddingHorizontal: 12,
              },
              animatedLandscapeMiniStyle,
            ]}
          >
            <Pressable onPress={() => setPlayerExpanded(true)} style={{ flex: 1, flexDirection: "row", alignItems: "center", marginRight: 8 }}>
              <View style={{ width: 50, height: 50, borderRadius: 8, overflow: "hidden", backgroundColor: colors.surfaceContainerHigh, alignItems: "center", justifyContent: "center" }}>
                {coverUrl ? <Image source={{ uri: coverUrl }} style={{ width: "100%", height: "100%" }} resizeMode="cover" /> : <Icon name="book" size={22} color={withAlpha(colors.onSurface, 0.4)} />}
              </View>
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text numberOfLines={1} style={{ color: colors.onSurface, fontSize: 15, fontWeight: "700" }}>{title}</Text>
                <Text numberOfLines={1} style={{ color: colors.onSurfaceVariant, fontSize: 13 }}>{authorName}</Text>
              </View>
            </Pressable>
            <Pressable onPress={() => { haptic(); seekBackward(30); }} hitSlop={6} style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: colors.secondaryContainer, alignItems: "center", justifyContent: "center" }}>
              <Icon name="replay-30" size={24} color={colors.onSecondaryContainer} />
            </Pressable>
            <Pressable onPress={() => { haptic(); playPause(); }} hitSlop={6} style={{ width: 56, height: 56, borderRadius: 18, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center", marginHorizontal: 10 }}>
              <Icon name={isPlaying ? "pause" : "play"} size={30} color={colors.onPrimary} />
            </Pressable>
            <Pressable onPress={() => { haptic(); seekForward(30); }} hitSlop={6} style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: colors.secondaryContainer, alignItems: "center", justifyContent: "center" }}>
              <Icon name="forward-30" size={24} color={colors.onSecondaryContainer} />
            </Pressable>
          </Animated.View>

          <Animated.View
            style={[
              StyleSheet.absoluteFill,
              { paddingTop: insets.top, paddingBottom: insets.bottom, paddingHorizontal: 16 },
              animatedFullPlayerStyle,
            ]}
          >
            {/* Top bar */}
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", height: 56 }}>
              <Pressable onPress={() => setPlayerExpanded(false)} style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: colors.secondaryContainer, alignItems: "center", justifyContent: "center" }}>
                <Icon name="chevron-down" size={28} color={colors.onSecondaryContainer} />
              </Pressable>
              <View style={{ flexDirection: "row", columnGap: 12 }}>
                <Pressable onPress={() => { try { CastContext.showCastDialog(); } catch (e) {} }} style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: colors.secondaryContainer, alignItems: "center", justifyContent: "center" }}>
                  <View pointerEvents="none"><CastButton style={{ width: 28, height: 28, tintColor: colors.onSecondaryContainer }} /></View>
                </Pressable>
                <Pressable onPress={() => setShowChapters(true)} disabled={!hasChapters} style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: colors.secondaryContainer, alignItems: "center", justifyContent: "center" }}>
                  <Icon name="list" size={22} color={hasChapters ? colors.onSecondaryContainer : withAlpha(colors.onSecondaryContainer, 0.4)} />
                </Pressable>
                <Pressable
                  onPress={() => {
                    setPlayerExpanded(false);
                    const targetId = currentSession?.libraryItemId || currentSession?.libraryItem?.id || currentSession?.id;
                    if (targetId) setTimeout(() => { if (navigationRef.isReady()) (navigationRef.navigate as any)("ItemDetail", { itemId: targetId }); }, 300);
                  }}
                  style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: colors.secondaryContainer, alignItems: "center", justifyContent: "center" }}
                >
                  <Icon name="book" size={22} color={colors.onSecondaryContainer} />
                </Pressable>
              </View>
            </View>

            {/* Two-pane: cover (left) + controls (right) */}
            <View style={{ flex: 1, flexDirection: "row", alignItems: "center" }}>
              <View style={{ width: LS_COVER + 16, alignItems: "center", justifyContent: "center" }}>
                <View style={{ width: LS_COVER, height: LS_COVER, borderRadius: 16, overflow: "hidden", backgroundColor: colors.surfaceContainerHigh, alignItems: "center", justifyContent: "center", elevation: 4 }}>
                  {coverUrl ? <Image source={{ uri: coverUrl }} style={{ width: "100%", height: "100%" }} resizeMode="cover" /> : <Icon name="book" size={48} color={withAlpha(colors.onSurface, 0.4)} />}
                  {coverUrl ? (
                    <LinearGradient colors={["rgba(0,0,0,0.35)", "rgba(0,0,0,0.12)", "rgba(255,255,255,0.10)", "rgba(0,0,0,0)"]} locations={[0, 0.35, 0.6, 1]} start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }} style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 18 }} />
                  ) : null}
                </View>
              </View>

              <View style={{ flex: 1, justifyContent: "center", paddingHorizontal: 8 }}>
                <Text style={{ color: colors.onSurfaceVariant, textAlign: "center", fontSize: 12, fontWeight: "500", letterSpacing: 1.5, marginBottom: 6 }}>{sourceLabel}</Text>
                <Text numberOfLines={1} style={{ color: colors.onSurface, fontFamily: "serif", fontWeight: "700", fontSize: 22, textAlign: "center" }}>{title}</Text>
                <Text numberOfLines={1} style={{ color: colors.onSurfaceVariant, fontSize: 14, textAlign: "center", marginTop: 2 }}>{authorName}</Text>
                {hasChapters && currentChapterIndex >= 0 ? (
                  <Text style={{ color: colors.onSurfaceVariant, fontSize: 12, textAlign: "center", marginTop: 4 }}>Chapter {currentChapterIndex + 1} of {chapters.length}</Text>
                ) : null}

                <View style={{ marginTop: 14 }}>
                  <View style={{ flexDirection: "row", marginBottom: 2 }}>
                    <Text style={{ fontFamily: "monospace", color: colors.onSurface, fontSize: 12 }}>{secondsToTimestamp(position)}</Text>
                    <View style={{ flexGrow: 1 }} />
                    <Text style={{ fontFamily: "monospace", color: colors.onSurface, fontSize: 12 }}>-{secondsToTimestamp(bookRemaining)}</Text>
                  </View>
                  <WavyProgress progress={bookFrac} playing={isPlaying} color={colors.primary} trackColor={withAlpha(colors.primary, 0.35)} height={12} strokeWidth={3} amplitude={2} wavelength={48} flattenWhenPaused />
                </View>

                <View style={{ marginTop: 8 }}>
                  <View style={{ flexDirection: "row", marginBottom: 2 }}>
                    <Text style={{ fontFamily: "monospace", color: colors.onSurface, fontSize: 12 }}>{secondsToTimestamp(chapterElapsed)}</Text>
                    <View style={{ flexGrow: 1 }} />
                    <Text style={{ fontFamily: "monospace", color: colors.onSurface, fontSize: 12 }}>-{secondsToTimestamp(chapterRemaining)}</Text>
                  </View>
                  <View {...chapterScrubPanResponder.panHandlers} onLayout={onChapterBarLayoutFor(true)} style={{ height: 32, justifyContent: "center" }} hitSlop={{ top: 8, bottom: 8 }}>
                    <WavyProgress progress={chapterFrac} playing={isPlaying} color={colors.primary} trackColor={withAlpha(colors.primary, 0.22)} height={22} strokeWidth={4} amplitude={3.5} wavelength={44} showStopDot={false} showHandle handleActive={dragFrac != null} />
                  </View>
                </View>

                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", columnGap: 16, marginTop: 12 }}>
                  <CircleButton icon="skip-previous" iconSize={22} onPress={() => { haptic(); previousChapter(); }} disabled={!hasChapters} />
                  <CircleButton icon="replay-30" iconSize={24} onPress={() => { haptic(); seekBackward(30); }} />
                  <Pressable onPress={() => { haptic(); playPause(); }} style={{ width: 72, height: 72, borderRadius: isPlaying ? 22 : 36, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center", elevation: 3 }}>
                    <Icon name={isPlaying ? "pause" : "play"} size={36} color={colors.onPrimary} />
                  </Pressable>
                  <CircleButton icon="forward-30" iconSize={24} onPress={() => { haptic(); seekForward(30); }} />
                  <CircleButton icon="skip-next" iconSize={22} onPress={() => { haptic(); nextChapter(); }} disabled={!hasChapters} />
                </View>

                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", columnGap: 24, marginTop: 12 }}>
                  <Pressable onPress={() => { haptic(); setShowSleepTimer(true); }} style={{ minWidth: 48, paddingHorizontal: sleepTimer ? 12 : 0, height: 48, borderRadius: 24, backgroundColor: sleepTimer ? colors.primaryContainer : colors.secondaryContainer, flexDirection: "row", alignItems: "center", justifyContent: "center" }}>
                    <Icon name="moon" size={20} color={sleepTimer ? colors.onPrimaryContainer : colors.onSecondaryContainer} />
                    {sleepTimer ? <Text style={{ color: colors.onPrimaryContainer, fontSize: 13, fontWeight: "600", fontFamily: "monospace", marginLeft: 6 }}>{secondsToTimestamp(sleepTimer.remaining)}</Text> : null}
                  </Pressable>
                  <Pressable onPress={() => { haptic(); setShowSpeed(true); }} style={{ paddingHorizontal: 20, height: 48, borderRadius: 24, backgroundColor: colors.secondaryContainer, alignItems: "center", justifyContent: "center" }}>
                    <Text style={{ fontSize: 16, fontWeight: "500", color: colors.onSecondaryContainer }}>{playbackSpeed}×</Text>
                  </Pressable>
                  <Pressable onPress={() => { haptic(); setShowBookmarks(true); }} style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: colors.secondaryContainer, alignItems: "center", justifyContent: "center" }}>
                    <Icon name="bookmark" size={20} color={colors.onSecondaryContainer} />
                  </Pressable>
                </View>
              </View>
            </View>
          </Animated.View>
        </View>
      </Animated.View>

      {/* --- MODAL DIALOGS (MOUNTED ROOT LEVEL) --- */}

      <ChaptersModal
        visible={showChapters}
        onClose={() => setShowChapters(false)}
        chapters={chapters}
        currentChapterIndex={currentChapterIndex}
        onSeekToChapter={seekToChapter}
      />

      <PlaybackSpeedModal
        visible={showSpeed}
        onClose={() => setShowSpeed(false)}
        speed={playbackSpeed}
        onChange={setPlaybackSpeed}
      />

      <SleepTimerModal
        visible={showSleepTimer}
        onClose={() => setShowSleepTimer(false)}
        timer={sleepTimer}
        hasChapter={!!currentChapter}
        onSet={(seconds, endOfChapter) => {
          if (endOfChapter) {
            const remaining = currentChapter
              ? Math.max(0, Math.round((currentChapter.end || 0) - position))
              : 0;
            setSleepTimer(remaining, true);
          } else {
            setSleepTimer(seconds, false);
          }
        }}
        onCancel={cancelSleepTimer}
      />

      <BookmarksModal
        visible={showBookmarks}
        onClose={() => setShowBookmarks(false)}
        libraryItemId={currentSession.libraryItemId || currentSession.libraryItem?.id}
        currentTime={position}
        onSeek={seek}
      />

      <Confetti visible={showConfetti} onDone={() => setShowConfetti(false)} />
    </View>
  );
}
