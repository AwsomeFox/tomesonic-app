import React, { useRef, useState, useEffect } from "react";
import {
  View,
  Text,
  ScrollView,
  LayoutChangeEvent,
  PanResponder,
  useWindowDimensions,
  BackHandler,
  StyleSheet,
  AccessibilityInfo,
  findNodeHandle,
  ActivityIndicator,
} from "react-native";
import { Image } from "expo-image";
import { coverSource } from "../utils/coverSource";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  interpolate,
  Extrapolation,
  useReducedMotion,
} from "react-native-reanimated";
import { SPATIAL_SHEET, EMPHASIZED } from "../theme/motion";
import { usePlaybackStore } from "../store/usePlaybackStore";
import { useUserStore } from "../store/useUserStore";
import { useFavoritesStore } from "../store/useFavoritesStore";
import { useThemeColors } from "../theme/useThemeColors";
import { withAlpha } from "../theme/palette";
import { navigationRef } from "../navigation/navigationRef";
import Icon from "./Icon";
import PlaybackSpeedModal from "./PlaybackSpeedModal";
import SleepTimerModal from "./SleepTimerModal";
import BookmarksModal from "./BookmarksModal";
import { CastContext, CastButton } from "react-native-google-cast";
import PlayerOverflowModal from "./PlayerOverflowModal";
import PlayerChaptersQueueSheet, { PEEK_HANDLE_H } from "./PlayerChaptersQueueSheet";
import { useDownloadStore } from "../store/useDownloadStore";
import WavyProgress from "./WavyProgress";
import Confetti from "./Confetti";
import { showAppDialog } from "../store/useDialogStore";
import { showSnackbar } from "../store/useSnackbarStore";
import { resolveEbookTarget, readingFractionForAudioPosition, canJumpToFraction } from "../utils/formatSwitch";
import { haptic } from "../utils/haptics";
import { computePlayerLayout } from "../utils/playerLayout";
import Pressable from "./HintPressable";
import { MINIPLAYER_HEIGHT } from "../utils/layoutConstants";

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

// Spoken form for screen readers — "3:12" reads as "three twelve", which is
// indistinguishable from the chapter row's numbers.
function spokenTime(seconds: number) {
  let s = seconds;
  if (!s || s < 0) s = 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h} ${h === 1 ? "hour" : "hours"} ${m} ${m === 1 ? "minute" : "minutes"}`;
  if (m > 0) return `${m} ${m === 1 ? "minute" : "minutes"}`;
  return `${Math.floor(s % 60)} seconds`;
}

// Circular transport helper button. Hoisted out of the player component:
// defined inline it got a new component identity on every ~1s position
// re-render, so React unmounted/remounted the button subtree each tick
// (dropping in-flight press feedback).
function CircleButton({
  icon,
  iconSize = 22,
  onPress,
  disabled,
  label,
  colors,
}: {
  icon: any;
  iconSize?: number;
  onPress: () => void;
  disabled?: boolean;
  label: string;
  colors: ReturnType<typeof useThemeColors>;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      style={{
        width: 56,
        height: 56,
        borderRadius: 28,
        backgroundColor: colors.secondaryContainer,
        alignItems: "center",
        justifyContent: "center",
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
}

// Inline flanking time label for the progress-bar rows (elapsed left,
// -remaining right). Decorative by default — the book row groups its labels
// into one spoken sentence and the chapter row's values live on the scrubber's
// accessibilityValue — so the raw "3:59:53" text stays out of TalkBack.
function BarTimeLabel({
  children,
  colors,
}: {
  children: React.ReactNode;
  colors: ReturnType<typeof useThemeColors>;
}) {
  return (
    <Text
      // Explicitly hidden on both platforms — parent-group semantics alone
      // are implementation-dependent, and a reused instance must never let
      // the raw "3:59:53" text become focusable.
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      maxFontSizeMultiplier={1.3}
      numberOfLines={1}
      style={{
        fontFamily: "monospace",
        fontVariant: ["tabular-nums"],
        color: colors.onSurfaceVariant,
        fontSize: 12,
      }}
    >
      {children}
    </Text>
  );
}

// Consolidated bottom pill: [speed][Sleep][Bookmark]. Hoisted (like
// CircleButton) so it keeps a stable component identity across the ~1s
// position re-renders, and shared verbatim between the portrait cascade and
// the landscape control column so the two orientations can't drift. The
// `compact` variant trims vertical padding for the height-constrained
// landscape pane.
function BottomPillRow({
  colors,
  speedLabel,
  sleepTimer,
  onSpeed,
  onSleep,
  onBookmarks,
  marginTop,
  compact = false,
  testID,
}: {
  colors: ReturnType<typeof useThemeColors>;
  speedLabel: string;
  sleepTimer: { remaining: number } | null;
  onSpeed: () => void;
  onSleep: () => void;
  onBookmarks: () => void;
  marginTop: number;
  compact?: boolean;
  testID: string;
}) {
  const btnStyle = (bg: string) => ({
    flex: 1,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    paddingVertical: compact ? 8 : 10,
    borderRadius: 20,
    backgroundColor: bg,
  });
  return (
    <View
      testID={testID}
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        marginTop,
        backgroundColor: colors.surfaceContainerHigh,
        borderRadius: 32,
        paddingVertical: compact ? 6 : 10,
        paddingHorizontal: 16,
        columnGap: 8,
      }}
    >
      {/* Speed indicator & button */}
      <Pressable
        onPress={onSpeed}
        accessibilityRole="button"
        accessibilityLabel={`Playback speed, ${speedLabel}`}
        style={btnStyle(colors.secondaryContainer)}
      >
        <Icon name="speed" size={16} color={colors.onSecondaryContainer} style={{ marginRight: 4 }} />
        <Text maxFontSizeMultiplier={1.3} style={{ fontSize: 13, fontWeight: "600", color: colors.onSecondaryContainer }}>
          {speedLabel}
        </Text>
      </Pressable>

      {/* Sleep Timer */}
      <Pressable
        onPress={onSleep}
        accessibilityRole="button"
        accessibilityLabel={
          sleepTimer
            ? `Sleep timer, ${secondsToTimestamp(sleepTimer.remaining)} remaining`
            : "Sleep timer"
        }
        style={btnStyle(sleepTimer ? colors.primaryContainer : colors.secondaryContainer)}
      >
        <Icon
          name="moon"
          size={16}
          color={sleepTimer ? colors.onPrimaryContainer : colors.onSecondaryContainer}
          style={{ marginRight: 4 }}
        />
        <Text maxFontSizeMultiplier={1.3} numberOfLines={1} style={{ fontSize: 13, fontWeight: "600", color: sleepTimer ? colors.onPrimaryContainer : colors.onSecondaryContainer }}>
          {sleepTimer ? secondsToTimestamp(sleepTimer.remaining) : "Sleep"}
        </Text>
      </Pressable>

      {/* Bookmarks */}
      <Pressable
        onPress={onBookmarks}
        accessibilityRole="button"
        accessibilityLabel="Bookmarks"
        style={btnStyle(colors.secondaryContainer)}
      >
        <Icon name="bookmark" size={16} color={colors.onSecondaryContainer} style={{ marginRight: 4 }} />
        <Text maxFontSizeMultiplier={1.3} style={{ fontSize: 13, fontWeight: "600", color: colors.onSecondaryContainer }}>
          Bookmark
        </Text>
      </Pressable>
    </View>
  );
}

// Maps a configured jump interval to the closest available glyph in the
// rewind-N / fast-forward-N icon families (5/10/15/30/45/60).
const JUMP_ICON_STEPS = [5, 10, 15, 30, 45, 60];
function jumpIconName(direction: "back" | "fwd", seconds: number): any {
  const n = JUMP_ICON_STEPS.reduce((best, step) =>
    Math.abs(step - seconds) < Math.abs(best - seconds) ? step : best, 30);
  return direction === "back" ? `rewind-${n}` : `fast-forward-${n}`;
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


  // Select only the slices this component actually renders. The old
  // selector-less usePlaybackStore() re-rendered the whole player on EVERY store
  // write — including ones it doesn't use (isCasting, castClient, chapterQueue,
  // onTabScreen, isInitialized). With per-slice selectors it re-renders only when
  // one of these values changes. (position/duration still tick ~1s while playing,
  // which the scrubber needs — isolating those into a child is a further optimization.)
  const currentSession = usePlaybackStore((s) => s.currentSession);
  const isPlaying = usePlaybackStore((s) => s.isPlaying);
  // Native stall indicator — a spinner overlays the play/pause control so a
  // mid-stream buffer doesn't read as a frozen player under the pause glyph.
  const isBuffering = usePlaybackStore((s) => s.isBuffering);
  const playPause = usePlaybackStore((s) => s.playPause);
  const position = usePlaybackStore((s) => s.position);
  const duration = usePlaybackStore((s) => s.duration);
  const playbackSpeed = usePlaybackStore((s) => s.playbackSpeed);
  const setPlaybackSpeed = usePlaybackStore((s) => s.setPlaybackSpeed);
  const seekForward = usePlaybackStore((s) => s.seekForward);
  const closePlayback = usePlaybackStore((s) => s.closePlayback);
  const seekBackward = usePlaybackStore((s) => s.seekBackward);
  const seek = usePlaybackStore((s) => s.seek);
  const chapters = usePlaybackStore((s) => s.chapters);
  const currentChapterIndex = usePlaybackStore((s) => s.currentChapterIndex);
  const nextChapter = usePlaybackStore((s) => s.nextChapter);
  const previousChapter = usePlaybackStore((s) => s.previousChapter);
  const seekToChapter = usePlaybackStore((s) => s.seekToChapter);
  const sleepTimer = usePlaybackStore((s) => s.sleepTimer);
  const setSleepTimer = usePlaybackStore((s) => s.setSleepTimer);
  const cancelSleepTimer = usePlaybackStore((s) => s.cancelSleepTimer);
  // Per-book speed memory + sleep-timer extras (settings surfaced in modals).
  const rememberSpeedPerBook = usePlaybackStore((s) => s.rememberSpeedPerBook);
  const setRememberSpeedPerBook = usePlaybackStore((s) => s.setRememberSpeedPerBook);
  const sleepRewindOnWake = usePlaybackStore((s) => s.sleepRewindOnWake);
  const setSleepRewindOnWake = usePlaybackStore((s) => s.setSleepRewindOnWake);
  const sleepShakeToExtend = usePlaybackStore((s) => s.sleepShakeToExtend);
  const setSleepShakeToExtend = usePlaybackStore((s) => s.setSleepShakeToExtend);
  // Cross-book play queue.
  const queue = usePlaybackStore((s) => s.queue);
  const removeFromQueue = usePlaybackStore((s) => s.removeFromQueue);
  const clearQueue = usePlaybackStore((s) => s.clearQueue);
  const playNextInQueue = usePlaybackStore((s) => s.playNextInQueue);
  const isPlayerExpanded = usePlaybackStore((s) => s.isPlayerExpanded);
  const setPlayerExpanded = usePlaybackStore((s) => s.setPlayerExpanded);
  // In-app jump buttons honor the Settings jump intervals — amount AND icon
  // (they were hardcoded to 30s while the notification/Auto buttons already
  // followed the setting via applyJumpOptions).
  const jumpForwardTime = useUserStore((s) => s.settings?.jumpForwardTime);
  const jumpBackwardTime = useUserStore((s) => s.settings?.jumpBackwardTime);
  const showPlayerBookProgress = useUserStore((s) => s.settings?.showPlayerBookProgress);
  const showPlayerChapterProgress = useUserStore((s) => s.settings?.showPlayerChapterProgress);
  const jumpFwdSecs = jumpForwardTime ?? 10;
  const jumpBackSecs = jumpBackwardTime ?? 10;
  // Subscribed (not getState) so the LOCAL/STREAMING label reacts to a
  // download completing/being deleted while the sheet is open and PAUSED —
  // while playing, the 1s position tick masked the missing subscription.
  const completedDownloads = useDownloadStore((s) => s.completedDownloads);

  // Local "Want to Read" / favorites overlay (ABS has no server flag). Subscribe
  // reactively so the full-player heart reflects/persists the toggle in sync
  // with the ItemDetail heart. Book-only feature — falsy id hides the button.
  const favItemId = currentSession?.libraryItemId || currentSession?.libraryItem?.id;
  const isFav = useFavoritesStore((s) => !!favItemId && s.favorites.includes(favItemId));
  const toggleFavorite = useFavoritesStore((s) => s.toggleFavorite);

  // "Read from here": jump to the ebook edition at (approximately) the
  // current listening position — the Whispersync-style handoff the
  // formatSwitch module implements (this is its player-side entry point).
  const readFromHere = () => {
    const st = usePlaybackStore.getState();
    const cur = st.currentSession;
    if (!cur || cur.episodeId) return; // book-only feature
    const bookItemId = cur.libraryItemId || cur.libraryItem?.id;
    if (!bookItemId) return;
    (async () => {
      const target = await resolveEbookTarget(bookItemId);
      if (!target) {
        showAppDialog({ title: "No ebook available", message: "This book doesn't have an ebook edition in your library." });
        return;
      }
      const frac = readingFractionForAudioPosition(st.position, st.duration);
      const jump = canJumpToFraction(target.ebookFormat);
      showAppDialog({
        title: "Read from here?",
        message: jump
          ? `Open the ebook at about ${Math.round(frac * 100)}%? Position matching is approximate.`
          : "This ebook format can't jump to a position — it will open at your last reading spot.",
        buttons: [
          { text: "Cancel", style: "cancel" },
          {
            text: "Read",
            onPress: () => {
              setPlayerExpanded(false);
              setTimeout(() => {
                // The 300ms collapse delay can outlive the session — a Stop &
                // Close or item switch in that window must not still open the
                // reader for the no-longer-active book.
                const now = usePlaybackStore.getState().currentSession;
                const nowId = now?.libraryItemId || now?.libraryItem?.id;
                if (!now || nowId !== bookItemId) return;
                if (navigationRef.isReady()) {
                  (navigationRef.navigate as any)("Reader", {
                    itemId: target.itemId,
                    ebookFormat: target.ebookFormat,
                    title: target.title,
                    initialFraction: jump ? frac : undefined,
                  });
                }
              }, 300);
            },
          },
        ],
      });
    })().catch((err) => {
      console.warn("Read from here failed", err);
    });
  };

  const isPlayerExpandedRef = useRef(isPlayerExpanded);
  useEffect(() => {
    isPlayerExpandedRef.current = isPlayerExpanded;
  }, [isPlayerExpanded]);

  // Honor the OS "reduce motion" setting for the full-screen mini↔full player
  // morph — the single biggest travel animation in the app. When it's on, the
  // sheet still expands/collapses and reaches the EXACT same end state, but the
  // spring / 300ms timing drivers jump straight to their target (duration 0)
  // instead of animating. Read through a ref so the once-created PanResponder
  // callbacks (useRef) see the live value, not a stale first-render one.
  const reduceMotion = useReducedMotion();
  const reduceMotionRef = useRef(reduceMotion);
  reduceMotionRef.current = reduceMotion;
  // Sheet-progress driver: spring normally, snap when reduced.
  const sheetSpring = (to: number) =>
    reduceMotionRef.current ? withTiming(to, { duration: 0 }) : withSpring(to, SPATIAL_SHEET);
  // Emphasized 300ms morphs (play/pause icon, tab-bar offset): snap when reduced.
  const sheetTiming = (to: number) =>
    withTiming(to, reduceMotionRef.current ? { duration: 0 } : { duration: 300, easing: EMPHASIZED });

  // On expand, move screen-reader focus to the Collapse button once the
  // spring settles — otherwise TalkBack keeps focus on the (now covered and
  // a11y-hidden) screen behind the player and the user is stranded.
  const collapseBtnRef = useRef<any>(null);
  useEffect(() => {
    if (!isPlayerExpanded) return;
    const t = setTimeout(() => {
      const node = findNodeHandle(collapseBtnRef.current);
      if (node) AccessibilityInfo.setAccessibilityFocus(node);
    }, 450);
    return () => clearTimeout(t);
  }, [isPlayerExpanded]);

  const [showChaptersQueue, setShowChaptersQueue] = useState(false);
  const [chaptersQueueTab, setChaptersQueueTab] = useState<"chapters" | "queue">("chapters");
  const [showSpeed, setShowSpeed] = useState(false);
  const [showSleepTimer, setShowSleepTimer] = useState(false);
  const [showBookmarks, setShowBookmarks] = useState(false);
  const [showOverflow, setShowOverflow] = useState(false);

  const playProgress = useSharedValue(isPlaying ? 1 : 0);

  useEffect(() => {
    playProgress.value = sheetTiming(isPlaying ? 1 : 0);
  }, [isPlaying]);

  // Celebrate when a book reaches its end — fires once per session, and only
  // on CROSSING the finish line. Without the crossing check, restoring a
  // session that was saved at the end (reopening an already-finished book)
  // fired confetti on app launch.
  const [showConfetti, setShowConfetti] = useState(false);
  const celebratedRef = useRef<string | null>(null);
  const prevPosRef = useRef<{ id: string; pos: number } | null>(null);
  useEffect(() => {
    const sessionId = currentSession?.id;
    if (!sessionId || !duration || duration <= 0) return;
    const prev = prevPosRef.current;
    prevPosRef.current = { id: sessionId, pos: position };
    // First observation of this session (resume point) never celebrates,
    // nor does a position already past the line.
    if (!prev || prev.id !== sessionId || prev.pos >= duration - 2) return;
    // Only a NATURAL playback advance celebrates. Scrubbing/seeking/skipping to
    // the end lands as one big position jump — dragging the scrubber to the
    // finish shouldn't fire confetti you didn't earn. A foreground playback tick
    // advances at most a few seconds (speed x interval), so a small forward
    // delta is the "listened to the end" signal.
    const delta = position - prev.pos;
    const naturalCrossing = delta > 0 && delta <= 15;
    if (position >= duration - 2 && naturalCrossing && celebratedRef.current !== sessionId) {
      celebratedRef.current = sessionId;
      setShowConfetti(true);
    }
  }, [position, duration, currentSession?.id]);

  const onTabScreen = usePlaybackStore((s) => s.onTabScreen);

  const bottomOffset = onTabScreen ? 64 + insets.bottom : insets.bottom;

  // Animate bottom offset transitions (sliding tab bar offset)
  const bottomOffsetVal = useSharedValue(bottomOffset);
  useEffect(() => {
    bottomOffsetVal.value = sheetTiming(bottomOffset);
  }, [bottomOffset]);

  // Shared value tracking sheet progress (0 = collapsed, 1 = expanded)
  const sheetProgress = useSharedValue(0);


  useEffect(() => {
    if (isPlayerExpanded) {
      sheetProgress.value = sheetSpring(1);
    } else {
      setShowChaptersQueue(false);
      sheetProgress.value = sheetSpring(0);
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

  // Responsive layout for the expanded player: the whole device-dependent Y
  // cascade (source label → cover → bars → title → transport → pill), the
  // tablet vertical centering, and the short-viewport overflow flag live in
  // the pure computePlayerLayout (utils/playerLayout.ts) so unit tests can
  // lock the arithmetic — two past device-only bugs were pure math drift in
  // this cascade. See that file for the rationale behind each constant.
  // The in-flow views below style themselves from the SAME destructured
  // deltas (never re-hardcoded literals), so a tweak to a util constant moves
  // the absolute overlays AND the in-flow content together.
  const {
    LS_COVER,
    PW,
    PX,
    COVER_SIZE_EXP,
    TOP_BAR_Y,
    TOPBAR_TO_SOURCE,
    SOURCE_TO_COVER,
    COVER_TO_BARS,
    BOOK_ROW_H,
    BOOK_BAR_H,
    SCRUBBER_TOP_GAP,
    SCRUBBER_H,
    SCRUBBER_TO_TITLE,
    TITLE_H,
    TITLE_TO_TRANSPORT,
    TRANSPORT_H,
    TRANSPORT_TO_PILL,
    extraTop,
    COVER_Y_EXP,
    TITLE_Y_EXP,
    TRANSPORT_Y_EXP,
    contentOverflows: contentOverflowsEstimate,
  } = computePlayerLayout({
    screenWidth,
    screenHeight,
    insetTop: insets.top,
    insetBottom: insets.bottom,
    showBookProgress: showPlayerBookProgress !== false,
  });
  // The util's overflow flag is a geometry ESTIMATE from dp constants. It can
  // UNDER-detect when OS font/display scaling makes the pill or labels taller
  // than their design heights, so it's combined with a REAL measurement of the
  // ScrollView (onLayout/onContentSizeChange below) — if the rendered content
  // is taller than the viewport, scrolling turns on regardless of the estimate.
  const [svViewportH, setSvViewportH] = useState(0);
  const [svContentH, setSvContentH] = useState(0);
  const measuredOverflow = svViewportH > 0 && svContentH > svViewportH + 1;
  const contentOverflows = contentOverflowsEstimate || measuredOverflow;

  // Layout values the sheet PanResponder needs. The responder is created ONCE
  // (useRef), so reading `screenHeight`/`COVER_Y_EXP` directly in its callbacks
  // would freeze them at first-render values — after a rotation the drag range
  // and the expanded drag-zone check would still use the old orientation's
  // numbers (same stale-closure pitfall the chapter scrubber's refs avoid).
  const sheetLayoutRef = useRef({ screenHeight, dragTopLimit: 0 });
  sheetLayoutRef.current = {
    screenHeight,
    dragTopLimit: COVER_Y_EXP + COVER_SIZE_EXP + 16,
  };

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
        return gestureState.y0 < sheetLayoutRef.current.dragTopLimit;
      },
      onPanResponderMove: (evt, gestureState) => {
        const range = sheetLayoutRef.current.screenHeight - MINIPLAYER_HEIGHT - bottomOffsetVal.value;
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
          sheetProgress.value = sheetSpring(1);
        } else if (gestureState.vy > 0.3) {
          setPlayerExpanded(false);
          sheetProgress.value = sheetSpring(0);
        } else {
          // Slow drag snaps to closest state
          if (p > 0.5) {
            setPlayerExpanded(true);
            sheetProgress.value = sheetSpring(1);
          } else {
            setPlayerExpanded(false);
            sheetProgress.value = sheetSpring(0);
          }
        }
      },
      onPanResponderTerminate: () => {
        const p = sheetProgress.value;
        if (p > 0.5) {
          setPlayerExpanded(true);
          sheetProgress.value = sheetSpring(1);
        } else {
          setPlayerExpanded(false);
          sheetProgress.value = sheetSpring(0);
        }
      },
    })
  ).current;

  // Chapter scrubber drag state.
  const [chapterBarWidth, setChapterBarWidth] = useState(0);
  const [dragFrac, setDragFrac] = useState<number | null>(null);
  const chapterBarWidthRef = useRef(0);
  const chapterBoundsRef = useRef({ start: 0, end: 0, span: 0, duration: 0 });

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
          // Read duration from the ref, not the closure: PanResponder.create
          // runs once, so a closed-over `duration` captured the FIRST render's
          // value (0 — mounted before any session), making this fallback dead
          // and silently discarding drags on a zero-span (malformed) chapter.
          const { start, span, duration: dur } = chapterBoundsRef.current;
          if (span > 0) seek(start + frac * span);
          else if (dur > 0) seek(frac * dur);
        }
        setDragFrac(null);
      },
      onPanResponderTerminate: () => setDragFrac(null),
      // Never yield an in-flight scrub to the sheet pan — in landscape the
      // sheet's "top region" drag zone can overlap the controls pane, and the
      // default (yield) would drop the drag mid-scrub without seeking.
      onPanResponderTerminationRequest: () => false,
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

  // Morph Cover Art via TRANSFORMS ONLY. The old width/height/left/top
  // interpolation re-laid-out (and re-sampled) the cover Image on every frame
  // of the open/close spring — the main source of jank. The view is now laid
  // out ONCE at its expanded size/position and translated+scaled into the
  // mini slot; borderRadius is divided by the collapsed scale so the VISUAL
  // radius still reads ~8 at mini size.
  const COVER_MINI = 50;
  const coverScale0 = COVER_MINI / COVER_SIZE_EXP;
  const coverLeftExpanded = PX + (PW - COVER_SIZE_EXP) / 2;
  const animatedCoverStyle = useAnimatedStyle(() => {
    const p = sheetProgress.value;
    const dx0 = 12 + COVER_MINI / 2 - (coverLeftExpanded + COVER_SIZE_EXP / 2);
    const dy0 = 9 + COVER_MINI / 2 - (COVER_Y_EXP + COVER_SIZE_EXP / 2);
    return {
      transform: [
        { translateX: interpolate(p, [0, 1], [dx0, 0]) },
        { translateY: interpolate(p, [0, 1], [dy0, 0]) },
        { scale: interpolate(p, [0, 1], [coverScale0, 1]) },
      ],
      borderRadius: interpolate(p, [0, 1], [8 / coverScale0, 20]),
    };
  });

  // Title & Author: CROSSFADE between two statically-laid-out blocks (mini,
  // left-aligned / expanded, centered) instead of morphing one block. The old
  // single block interpolated fontSize/width/left and snapped textAlign from
  // left to center at the halfway point — the visible "text jumps to the
  // middle" — and re-laid-out the text on every frame (jank). Opacity +
  // transform only: zero per-frame layout.
  const animatedMiniTextStyle = useAnimatedStyle(() => ({
    opacity: interpolate(sheetProgress.value, [0, 0.25], [1, 0]),
  }));
  const animatedFullTextStyle = useAnimatedStyle(() => {
    const p = sheetProgress.value;
    return {
      opacity: interpolate(p, [0.6, 0.95], [0, 1]),
      // Slight upward settle as it fades in, matching the sheet's motion.
      transform: [{ translateY: interpolate(p, [0.6, 1], [14, 0]) }],
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

  // Morph Skip Previous Button (fade in/out, align to TRANSPORT_Y_EXP + 16, width/height 56)
  const animatedSkipPreviousStyle = useAnimatedStyle(() => {
    const p = sheetProgress.value;
    // Fully OFF-screen while collapsed (width is 56): the view keeps
    // pointerEvents="auto" the moment the player expands, so an on-screen
    // anchor at opacity 0 was an invisible hit area during the animation.
    const leftCollapsed = -72;
    const leftExpanded = PX + (PW - 88) / 2 - 144;
    const topCollapsed = 12;
    const topExpanded = TRANSPORT_Y_EXP + 16;

    return {
      width: 56,
      height: 56,
      left: interpolate(p, [0, 1], [leftCollapsed, leftExpanded]),
      top: interpolate(p, [0, 1], [topCollapsed, topExpanded]),
      borderRadius: 28,
      opacity: interpolate(p, [0.8, 1], [0, 1], Extrapolation.CLAMP),
    };
  });

  // Morph Skip Next Button (fade in/out, align to TRANSPORT_Y_EXP + 16, width/height 56)
  const animatedSkipNextStyle = useAnimatedStyle(() => {
    const p = sheetProgress.value;
    // Fully off-screen right (mirror of skip-previous above).
    const leftCollapsed = screenWidth + 16;
    const leftExpanded = PX + (PW - 88) / 2 + 176;
    const topCollapsed = 12;
    const topExpanded = TRANSPORT_Y_EXP + 16;

    return {
      width: 56,
      height: 56,
      left: interpolate(p, [0, 1], [leftCollapsed, leftExpanded]),
      top: interpolate(p, [0, 1], [topCollapsed, topExpanded]),
      borderRadius: 28,
      opacity: interpolate(p, [0.8, 1], [0, 1], Extrapolation.CLAMP),
    };
  });
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

  const mediaTitle = currentSession.displayTitle || "Unknown Audiobook";
  const authorName = currentSession.displayAuthor || "Unknown Author";
  const coverUrl = currentSession.coverUrl || "";
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
  // When the headline is a CHAPTER title, the line under it carries the book
  // too ("Book • Author") — matching the notification. With no chapters the
  // headline IS the book, so the subtitle stays just the author.
  const subtitleText = currentChapterTitle
    ? [mediaTitle, authorName].filter(Boolean).join(" • ")
    : authorName;

  const bookFrac = duration > 0 ? Math.min(position / duration, 1) : 0;
  const bookRemaining = Math.max(0, duration - position);

  const chapterStart = currentChapter ? currentChapter.start || 0 : 0;
  const chapterEnd = currentChapter ? currentChapter.end || duration : duration;
  const chapterSpan = Math.max(0, chapterEnd - chapterStart);
  chapterBoundsRef.current = { start: chapterStart, end: chapterEnd, span: chapterSpan, duration };

  const liveChapterFrac =
    chapterSpan > 0 ? Math.min(Math.max((position - chapterStart) / chapterSpan, 0), 1) : bookFrac;
  const chapterFrac = dragFrac != null ? dragFrac : liveChapterFrac;

  // Derive from chapterFrac so the numbers FOLLOW a drag on chapterless books
  // too (chapterSpan is already the whole-book duration there) — they used to
  // stay pinned to the live position while the wave previewed the drag.
  const chapterElapsed = chapterSpan > 0 ? chapterFrac * chapterSpan : position;
  const chapterRemaining = chapterSpan > 0 ? Math.max(0, chapterSpan - chapterElapsed) : bookRemaining;

  // Clean speed label — a server-restored playbackRate can carry float noise
  // (e.g. 1.2999999), which "+toFixed(2)" collapses to 1.3 / 3 / 1.75.
  const speedLabel = `${+playbackSpeed.toFixed(2)}×`;

  // Screen-reader support for the chapter scrubber: a pan-only surface is
  // invisible to TalkBack, so expose it as an adjustable with ±30s steps.
  // Shared by the portrait and landscape scrub containers.
  const scrubA11yProps = {
    accessible: true,
    accessibilityRole: "adjustable" as const,
    accessibilityLabel: currentChapter ? "Chapter position" : "Book position",
    accessibilityValue: {
      text: `${secondsToTimestamp(chapterElapsed)} elapsed, ${secondsToTimestamp(chapterRemaining)} remaining`,
    },
    accessibilityActions: [
      { name: "increment", label: `Forward ${jumpFwdSecs} seconds` },
      { name: "decrement", label: `Back ${jumpBackSecs} seconds` },
    ],
    onAccessibilityAction: (e: { nativeEvent: { actionName: string } }) => {
      if (e.nativeEvent.actionName === "increment") seekForward(jumpFwdSecs);
      else if (e.nativeEvent.actionName === "decrement") seekBackward(jumpBackSecs);
    },
  };

  // Both orientation subtrees stay mounted (display-toggled), and BOTH
  // scrubbers call onLayout — only the visible one may own the width ref, or
  // the hidden subtree's stale width breaks seek accuracy after rotation.
  const onChapterBarLayoutFor = (forLandscape: boolean) => (e: LayoutChangeEvent) => {
    if (forLandscape !== isLandscape) return;
    const w = e.nativeEvent.layout.width;
    setChapterBarWidth(w);
    chapterBarWidthRef.current = w;
  };

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
            accessibilityRole="button"
            // Carries everything the collapsed mini shows visually (book,
            // author, and the current chapter) — the decorative mini-title
            // (2a) is a11y-hidden to avoid a double announcement.
            accessibilityLabel={`Expand player. ${mediaTitle} by ${authorName}${
              currentChapterTitle ? `. ${currentChapterTitle}` : ""
            }`}
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
        {/* Opacity animation alone does NOT remove the subtree from TalkBack —
            while collapsed, all ~10 full-player controls stayed reachable (and
            actionable) on every screen. Hide the whole subtree from a11y until
            expanded. */}
        <Animated.View
          accessibilityElementsHidden={!isPlayerExpanded}
          importantForAccessibility={isPlayerExpanded ? "auto" : "no-hide-descendants"}
          style={[
            StyleSheet.absoluteFill,
            { paddingTop: insets.top, paddingBottom: insets.bottom },
            animatedFullPlayerStyle,
          ]}
        >
            <ScrollView
              contentContainerStyle={{ flexGrow: 1, paddingHorizontal: PX + 24, paddingBottom: 58 + insets.bottom }}
              showsVerticalScrollIndicator={false}
              scrollEnabled={contentOverflows} // Off so the drag gesture runs cleanly; on when the block overflows the viewport (estimated OR measured) so the bottom pill stays reachable
              onLayout={(e) => setSvViewportH(e.nativeEvent.layout.height)}
              onContentSizeChange={(_w, h) => setSvContentH(h)}
            >
              {/* Top Row: Simplified Header containing Collapse, Title (Center), and Cast + Overflow Menu (Right) */}
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
                  ref={collapseBtnRef}
                  onPress={() => setPlayerExpanded(false)}
                  accessibilityRole="button"
                  accessibilityLabel="Collapse player"
                  style={{
                    width: 56,
                    height: 56,
                    borderRadius: 28,
                    backgroundColor: colors.secondaryContainer,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Icon name="chevron-down" size={28} color={colors.onSecondaryContainer} />
                </Pressable>

                {/* Right options: Cast & Overflow */}
                <View style={{ flexDirection: "row", columnGap: 8, alignItems: "center" }}>
                  <Pressable
                    onPress={() => {
                      try {
                        CastContext.showCastDialog();
                      } catch (err) {
                        console.warn("Cast picker failed", err);
                      }
                    }}
                    accessibilityRole="button"
                    accessibilityLabel="Cast to device"
                    style={{
                      width: 48,
                      height: 48,
                      borderRadius: 24,
                      backgroundColor: colors.secondaryContainer,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <View pointerEvents="none">
                      <CastButton style={{ width: 28, height: 28, tintColor: colors.onSecondaryContainer }} />
                    </View>
                  </Pressable>
                  <Pressable
                    onPress={() => { setShowOverflow(true); }}
                    accessibilityRole="button"
                    accessibilityLabel="More options"
                    style={{
                      width: 48,
                      height: 48,
                      borderRadius: 24,
                      backgroundColor: colors.secondaryContainer,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Icon name="more-vert" size={24} color={colors.onSecondaryContainer} />
                  </Pressable>
                </View>
              </View>

              {/* Source label */}
              <View style={{ marginTop: TOPBAR_TO_SOURCE + extraTop, justifyContent: "center" }}>
                <Text maxFontSizeMultiplier={1.3}
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
              <View style={{ height: COVER_SIZE_EXP, marginTop: SOURCE_TO_COVER }} />

              {/* Book progress row: elapsed | wave | -remaining. The classic
                  flanking layout — each bar carries its own time labels
                  inline, replacing the old combined numeric info row. */}
              {showPlayerBookProgress !== false ? (
                <View
                  testID="player-book-bar"
                  style={{
                    marginTop: COVER_TO_BARS,
                    height: BOOK_ROW_H,
                    flexDirection: "row",
                    alignItems: "center",
                    columnGap: 8,
                  }}
                  // One spoken sentence for the whole row — the raw label text
                  // ("3:59:53") reads ambiguously digit-by-digit on TalkBack.
                  accessible
                  accessibilityLabel={`Book progress: ${spokenTime(position)} elapsed, ${spokenTime(bookRemaining)} remaining`}
                >
                  <BarTimeLabel colors={colors}>{secondsToTimestamp(position)}</BarTimeLabel>
                  <View style={{ flex: 1, justifyContent: "center" }}>
                    <WavyProgress
                      progress={bookFrac}
                      playing={isPlaying}
                      color={colors.primary}
                      trackColor={withAlpha(colors.primary, 0.35)}
                      height={BOOK_BAR_H}
                      strokeWidth={2.5}
                      amplitude={2}
                      wavelength={48}
                      flattenWhenPaused
                    />
                  </View>
                  <BarTimeLabel colors={colors}>-{secondsToTimestamp(bookRemaining)}</BarTimeLabel>
                </View>
              ) : null}

              {/* Interactive Chapter Scrubber row: elapsed | wave | -remaining.
                  SCRUBBER_TOP_GAP already encodes both book-bar modes (BARS_GAP
                  under the book row, COVER_TO_BARS directly under the cover),
                  so one delta serves as the marginTop either way. The left
                  label derives from chapterElapsed (→ chapterFrac → dragFrac),
                  so it live-updates while the scrubber is dragged. */}
              <View
                testID="player-chapter-scrubber"
                style={{
                  marginTop: SCRUBBER_TOP_GAP,
                  height: SCRUBBER_H,
                  flexDirection: "row",
                  alignItems: "center",
                  columnGap: 8,
                }}
              >
                {showPlayerChapterProgress !== false ? (
                  <>
                    {/* Hidden from a11y: redundant with the scrubber's
                        accessibilityValue (spoken, unambiguous form). */}
                    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                      <BarTimeLabel colors={colors}>{secondsToTimestamp(chapterElapsed)}</BarTimeLabel>
                    </View>
                    <View
                      {...chapterScrubPanResponder.panHandlers}
                      {...scrubA11yProps}
                      onLayout={onChapterBarLayoutFor(false)}
                      style={{ flex: 1, height: 32, justifyContent: "center" }}
                      hitSlop={{ top: 8, bottom: 8 }}
                    >
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
                        flattenWhenPaused
                      />
                    </View>
                    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                      <BarTimeLabel colors={colors}>-{secondsToTimestamp(chapterRemaining)}</BarTimeLabel>
                    </View>
                  </>
                ) : null}
              </View>

              {/* Title & Author Placeholder (absolute overlay handles actual rendering) */}
              <View style={{ height: TITLE_H, marginTop: SCRUBBER_TO_TITLE }} />

              {/* Transport Row Placeholder */}
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginTop: TITLE_TO_TRANSPORT,
                  height: TRANSPORT_H,
                }}
              >
                {/* Skip previous placeholder */}
                <View style={{ width: 56, height: 56 }} />
                {/* Replay placeholder */}
                <View style={{ width: 56, height: 56 }} />
                {/* Play/Pause placeholder */}
                <View style={{ width: 88, height: 88 }} />
                {/* Forward placeholder */}
                <View style={{ width: 56, height: 56 }} />
                {/* Skip next placeholder */}
                <View style={{ width: 56, height: 56 }} />
              </View>

              {/* Consolidated bottom pill: Speed, Sleep Timer, Bookmarks. The
                  play queue lives in the Chapters & Up Next peek sheet below
                  (and the overflow menu's Chapters List entry). */}
              <BottomPillRow
                testID="player-bottom-pill"
                colors={colors}
                speedLabel={speedLabel}
                sleepTimer={sleepTimer}
                onSpeed={() => { setShowSpeed(true); }}
                onSleep={() => { setShowSleepTimer(true); }}
                onBookmarks={() => { setShowBookmarks(true); }}
                marginTop={TRANSPORT_TO_PILL}
              />
            </ScrollView>
        </Animated.View>

        {/* --- MORPHING ELEMENTS (ABSOLUTE OVERLAYS) --- */}

        {/* 1. Cover Art — laid out ONCE at expanded size/position; the
            animated style translates+scales it into the mini slot. */}
        <Animated.View
          pointerEvents="none"
          style={[
            {
              position: "absolute",
              left: coverLeftExpanded,
              top: COVER_Y_EXP,
              width: COVER_SIZE_EXP,
              height: COVER_SIZE_EXP,
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
            <Image source={coverSource(coverUrl)} style={{ width: "100%", height: "100%" }} contentFit="cover" />
          ) : (
            // Sized relative to the (expanded) box so the scale transform
            // keeps it proportional in the mini thumb too.
            <Icon name="book" size={Math.round(COVER_SIZE_EXP * 0.5)} color={withAlpha(colors.onSurface, 0.4)} />
          )}
          {/* Book-spine sheen: a dark edge + thin highlight on the left. Fixed
              at the expanded width — the cover's scale transform shrinks it to
              a hairline at mini size, replacing the old width animation. */}
          {coverUrl ? (
            <View
              pointerEvents="none"
              style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 22 }}
            >
              <LinearGradient
                colors={["rgba(0,0,0,0.35)", "rgba(0,0,0,0.12)", "rgba(255,255,255,0.10)", "rgba(0,0,0,0)"]}
                locations={[0, 0.35, 0.6, 1]}
                start={{ x: 0, y: 0.5 }}
                end={{ x: 1, y: 0.5 }}
                style={{ flex: 1 }}
              />
            </View>
          ) : null}
        </Animated.View>

        {/* 2a. Title & Author — MINI (left-aligned beside the thumb). */}
        {/* Decorative for a11y: the collapsed expand-row (line ~709) already
            speaks "Expand player. {title} by {author}", and the expanded title
            lives in the now-hidden full-player subtree — so this visual mini
            title must stay OUT of the TalkBack tree in both states or the title
            gets announced twice. */}
        <Animated.View
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[
            {
              position: "absolute",
              left: 74,
              top: 12,
              width: screenWidth - 74 - 176,
              justifyContent: "center",
            },
            animatedMiniTextStyle,
          ]}
        >
          <Text maxFontSizeMultiplier={1.3}
            numberOfLines={1}
            style={{
              color: colors.onSurface,
              fontWeight: "700",
              fontFamily: "serif",
              fontSize: 15,
              lineHeight: 20,
            }}
          >
            {title}
          </Text>
          <Text maxFontSizeMultiplier={1.3}
            numberOfLines={1}
            style={{ color: colors.onSurfaceVariant, fontSize: 13, marginTop: 1 }}
          >
            {subtitleText}
          </Text>
        </Animated.View>

        {/* 2b. Title & Author — EXPANDED (centered under the cover). */}
        {/* This overlay is a SIBLING of the hidden full-player subtree, so it
            needs its own a11y guard — opacity-0 doesn't remove it from the
            TalkBack tree, and while collapsed it double-announced the title
            (the expand-row already speaks it) and leaked the chapter line. */}
        <Animated.View
          pointerEvents="none"
          accessibilityElementsHidden={!isPlayerExpanded}
          importantForAccessibility={isPlayerExpanded ? "auto" : "no-hide-descendants"}
          style={[
            {
              position: "absolute",
              left: PX + 24,
              top: TITLE_Y_EXP,
              width: PW - 48,
              justifyContent: "center",
            },
            animatedFullTextStyle,
          ]}
        >
          <Text maxFontSizeMultiplier={1.3}
            numberOfLines={1}
            style={{
              color: colors.onSurface,
              fontWeight: "700",
              fontFamily: "serif",
              fontSize: 22,
              lineHeight: 28,
              textAlign: "center",
            }}
          >
            {title}
          </Text>
          <Text maxFontSizeMultiplier={1.3}
            numberOfLines={1}
            style={{
              color: colors.onSurfaceVariant,
              fontSize: 15,
              marginTop: 1,
              textAlign: "center",
            }}
          >
            {subtitleText}
          </Text>
          {hasChapters && currentChapterIndex >= 0 ? (
            <Text maxFontSizeMultiplier={1.3}
              numberOfLines={1}
              style={{
                color: colors.onSurfaceVariant,
                fontSize: 12,
                marginTop: 4,
                letterSpacing: 0.4,
                textAlign: "center",
              }}
            >
              Chapter {Math.min(Math.max(currentChapterIndex + 1, 1), chapters.length)} of {chapters.length}
            </Text>
          ) : null}
        </Animated.View>

        {/* Skip Previous Button */}
        <Animated.View
          pointerEvents={isPlayerExpanded ? "auto" : "none"}
          style={[
            {
              position: "absolute",
              backgroundColor: colors.secondaryContainer,
              alignItems: "center",
              justifyContent: "center",
              zIndex: 10,
            },
            animatedSkipPreviousStyle,
          ]}
        >
          <Pressable
            onPress={() => { previousChapter().catch(() => {}); }}
            disabled={!hasChapters}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel="Previous chapter"
            style={{ width: "100%", height: "100%", alignItems: "center", justifyContent: "center", opacity: hasChapters ? 1 : 0.4 }}
          >
            <Animated.View style={animatedSmallIconStyle}>
              <Icon name="skip-previous" size={24} color={colors.onSecondaryContainer} />
            </Animated.View>
          </Pressable>
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
            onPress={() => { seekBackward(jumpBackSecs).catch(() => {}); }}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel={`Back ${jumpBackSecs} seconds`}
            style={{ width: "100%", height: "100%", alignItems: "center", justifyContent: "center" }}
          >
            <Animated.View style={animatedSmallIconStyle}>
              <Icon name={jumpIconName("back", jumpBackSecs)} size={24} color={colors.onSecondaryContainer} />
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
            onPress={() => { playPause().catch(() => {}); }}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel={isPlaying ? "Pause" : "Play"}
            accessibilityState={{ busy: isBuffering }}
            style={{ width: "100%", height: "100%", alignItems: "center", justifyContent: "center" }}
          >
            <Animated.View style={animatedPlayIconStyle}>
              <Icon name={isPlaying ? "pause" : "play"} size={30} color={colors.onPrimary} />
            </Animated.View>
            {isBuffering ? (
              <View
                pointerEvents="none"
                style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center" }]}
              >
                <ActivityIndicator testID="buffering-indicator" size="small" color={colors.onPrimary} />
              </View>
            ) : null}
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
            onPress={() => { seekForward(jumpFwdSecs).catch(() => {}); }}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel={`Forward ${jumpFwdSecs} seconds`}
            style={{ width: "100%", height: "100%", alignItems: "center", justifyContent: "center" }}
          >
            <Animated.View style={animatedSmallIconStyle}>
              <Icon name={jumpIconName("fwd", jumpFwdSecs)} size={24} color={colors.onSecondaryContainer} />
            </Animated.View>
          </Pressable>
        </Animated.View>

        {/* Skip Next Button */}
        <Animated.View
          pointerEvents={isPlayerExpanded ? "auto" : "none"}
          style={[
            {
              position: "absolute",
              backgroundColor: colors.secondaryContainer,
              alignItems: "center",
              justifyContent: "center",
              zIndex: 10,
            },
            animatedSkipNextStyle,
          ]}
        >
          <Pressable
            onPress={() => { nextChapter().catch(() => {}); }}
            disabled={!hasChapters}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel="Next chapter"
            style={{ width: "100%", height: "100%", alignItems: "center", justifyContent: "center", opacity: hasChapters ? 1 : 0.4 }}
          >
            <Animated.View style={animatedSmallIconStyle}>
              <Icon name="skip-next" size={24} color={colors.onSecondaryContainer} />
            </Animated.View>
          </Pressable>
        </Animated.View>

        {/* 6. Pinned miniplayer progress wave at bottom of mini player slot.
            Inset to the text zone: the cover (left, ends x=62) and the
            replay/play/forward cluster (right, starts x=screenWidth-122) both
            reach y≈59-62, so a full-bleed wave at y=58 visually collides with
            them. left 74 aligns with the title block. */}
        <Animated.View
          pointerEvents="none"
          style={[
            {
              position: "absolute",
              left: 74,
              right: 130,
              top: MINIPLAYER_HEIGHT - 10,
            },
            animatedMiniProgressStyle,
          ]}
        >
          <WavyProgress
            progress={liveChapterFrac}
            playing={isPlaying}
            color={colors.primary}
            trackColor={withAlpha(colors.primary, 0.2)}
            height={10}
            strokeWidth={2.5}
            flattenWhenPaused
          />
        </Animated.View>
        </View>

        <View
          style={[StyleSheet.absoluteFill, { display: isLandscape ? "flex" : "none" }]}
          pointerEvents={isLandscape ? "box-none" : "none"}
        >
          {/* ===== LANDSCAPE: collapsed mini bar + two-pane expanded ===== */}
          {/* Same a11y guards as portrait: opacity/pointerEvents don't remove
              a subtree from TalkBack, so the mini bar must be hidden while
              EXPANDED (else a duplicate expand button + transport is reachable). */}
          <Animated.View
            accessibilityElementsHidden={isPlayerExpanded}
            importantForAccessibility={isPlayerExpanded ? "no-hide-descendants" : "auto"}
            style={[
              {
                position: "absolute", left: 0, right: 0, top: 0, height: MINIPLAYER_HEIGHT,
                zIndex: 8, flexDirection: "row", alignItems: "center", paddingHorizontal: 12,
              },
              animatedLandscapeMiniStyle,
            ]}
          >
            <Pressable onPress={() => setPlayerExpanded(true)} accessibilityRole="button" accessibilityLabel={`Expand player. ${mediaTitle} by ${authorName}${currentChapterTitle ? `. ${currentChapterTitle}` : ""}`} style={{ flex: 1, flexDirection: "row", alignItems: "center", marginRight: 8 }}>
              <View style={{ width: 50, height: 50, borderRadius: 8, overflow: "hidden", backgroundColor: colors.surfaceContainerHigh, alignItems: "center", justifyContent: "center" }}>
                {coverUrl ? <Image source={coverSource(coverUrl)} style={{ width: "100%", height: "100%" }} contentFit="cover" /> : <Icon name="book" size={22} color={withAlpha(colors.onSurface, 0.4)} />}
              </View>
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text maxFontSizeMultiplier={1.3} numberOfLines={1} style={{ color: colors.onSurface, fontSize: 15, fontWeight: "700" }}>{title}</Text>
                <Text maxFontSizeMultiplier={1.3} numberOfLines={1} style={{ color: colors.onSurfaceVariant, fontSize: 13 }}>{subtitleText}</Text>
              </View>
            </Pressable>
            <Pressable onPress={() => { seekBackward(jumpBackSecs).catch(() => {}); }} hitSlop={6} accessibilityRole="button" accessibilityLabel={`Back ${jumpBackSecs} seconds`} style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: colors.secondaryContainer, alignItems: "center", justifyContent: "center" }}>
              <Icon name={jumpIconName("back", jumpBackSecs)} size={24} color={colors.onSecondaryContainer} />
            </Pressable>
            <Pressable onPress={() => { playPause().catch(() => {}); }} hitSlop={6} accessibilityRole="button" accessibilityLabel={isPlaying ? "Pause" : "Play"} accessibilityState={{ busy: isBuffering }} style={{ width: 56, height: 56, borderRadius: 18, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center", marginHorizontal: 10 }}>
              <Icon name={isPlaying ? "pause" : "play"} size={30} color={colors.onPrimary} />
            </Pressable>
            <Pressable onPress={() => { seekForward(jumpFwdSecs).catch(() => {}); }} hitSlop={6} accessibilityRole="button" accessibilityLabel={`Forward ${jumpFwdSecs} seconds`} style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: colors.secondaryContainer, alignItems: "center", justifyContent: "center" }}>
              <Icon name={jumpIconName("fwd", jumpFwdSecs)} size={24} color={colors.onSecondaryContainer} />
            </Pressable>
            {/* Pinned progress wave — parity with the portrait miniplayer. Inset
                to the text zone: cover ends x=62, the transport cluster starts
                ~176 from the right edge (44+10+56+10+44 + 12 padding). */}
            <View pointerEvents="none" style={{ position: "absolute", left: 74, right: 184, top: MINIPLAYER_HEIGHT - 10 }}>
              <WavyProgress
                progress={liveChapterFrac}
                playing={isPlaying}
                color={colors.primary}
                trackColor={withAlpha(colors.primary, 0.2)}
                height={10}
                strokeWidth={2.5}
                flattenWhenPaused
              />
            </View>
          </Animated.View>

          {/* Landscape full player — hidden from TalkBack while collapsed so
              its (opacity-0) controls can't be reached behind the mini bar,
              mirroring the portrait subtree guard. */}
          <Animated.View
            accessibilityElementsHidden={!isPlayerExpanded}
            importantForAccessibility={isPlayerExpanded ? "auto" : "no-hide-descendants"}
            style={[
              StyleSheet.absoluteFill,
              // Bottom budget: safe area + the "Chapters & Up Next" peek
              // handle (enabled in landscape too) so the pill/transport never
              // sit underneath the drawer.
              { paddingTop: insets.top, paddingBottom: insets.bottom + PEEK_HANDLE_H, paddingHorizontal: 16 },
              animatedFullPlayerStyle,
            ]}
          >
            {/* Top bar */}
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", height: 56 }}>
              <Pressable onPress={() => setPlayerExpanded(false)} accessibilityRole="button" accessibilityLabel="Collapse player" style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: colors.secondaryContainer, alignItems: "center", justifyContent: "center" }}>
                <Icon name="chevron-down" size={28} color={colors.onSecondaryContainer} />
              </Pressable>
              <View style={{ flexDirection: "row", columnGap: 12 }}>
                <Pressable onPress={() => { try { CastContext.showCastDialog(); } catch (err) { console.warn("Cast picker failed", err); } }} accessibilityRole="button" accessibilityLabel="Cast to device" style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: colors.secondaryContainer, alignItems: "center", justifyContent: "center" }}>
                  <View pointerEvents="none"><CastButton style={{ width: 28, height: 28, tintColor: colors.onSecondaryContainer }} /></View>
                </Pressable>
                <Pressable
                  onPress={() => {
                    setPlayerExpanded(false);
                    const targetId = currentSession?.libraryItemId || currentSession?.libraryItem?.id || currentSession?.id;
                    if (targetId) setTimeout(() => { if (navigationRef.isReady()) (navigationRef.navigate as any)("ItemDetail", { itemId: targetId }); }, 300);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="View book details"
                  style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: colors.secondaryContainer, alignItems: "center", justifyContent: "center" }}
                >
                  <Icon name="book" size={22} color={colors.onSecondaryContainer} />
                </Pressable>
                {/* Want-to-Read heart + Stop are surfaced in landscape too —
                    Stop is the only in-player dismissal, so a finished book
                    couldn't be closed at all without it when rotated. */}
                {favItemId ? (
                  <Pressable onPress={() => { toggleFavorite(favItemId); }} accessibilityRole="button" accessibilityLabel={isFav ? "Remove from Want to Read" : "Add to Want to Read"} accessibilityState={{ selected: isFav }} style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: isFav ? colors.primaryContainer : colors.secondaryContainer, alignItems: "center", justifyContent: "center" }}>
                    <Icon name="heart" size={22} color={isFav ? colors.onPrimaryContainer : colors.onSecondaryContainer} style={{ opacity: isFav ? 1 : 0.45 }} />
                  </Pressable>
                ) : null}
                <Pressable
                  onPress={() => { setPlayerExpanded(false); closePlayback().catch(() => {}); }}
                  accessibilityRole="button"
                  accessibilityLabel="Stop and close player"
                  style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: colors.secondaryContainer, alignItems: "center", justifyContent: "center" }}
                >
                  <Icon name="close" size={22} color={colors.onSecondaryContainer} />
                </Pressable>
              </View>
            </View>

            {/* Two-pane: cover (left) + controls (right) */}
            <View style={{ flex: 1, flexDirection: "row", alignItems: "center" }}>
              <View style={{ width: LS_COVER + 16, alignItems: "center", justifyContent: "center" }}>
                <View style={{ width: LS_COVER, height: LS_COVER, borderRadius: 16, overflow: "hidden", backgroundColor: colors.surfaceContainerHigh, alignItems: "center", justifyContent: "center", elevation: 4 }}>
                  {coverUrl ? <Image source={coverSource(coverUrl)} style={{ width: "100%", height: "100%" }} contentFit="cover" /> : <Icon name="book" size={48} color={withAlpha(colors.onSurface, 0.4)} />}
                  {coverUrl ? (
                    <LinearGradient colors={["rgba(0,0,0,0.35)", "rgba(0,0,0,0.12)", "rgba(255,255,255,0.10)", "rgba(0,0,0,0)"]} locations={[0, 0.35, 0.6, 1]} start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }} style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 18 }} />
                  ) : null}
                </View>
              </View>

              <View style={{ flex: 1, justifyContent: "center", paddingHorizontal: 8 }}>
                <Text maxFontSizeMultiplier={1.3} style={{ color: colors.onSurfaceVariant, textAlign: "center", fontSize: 12, fontWeight: "500", letterSpacing: 1.5, marginBottom: 6 }}>{sourceLabel}</Text>
                <Text maxFontSizeMultiplier={1.3} numberOfLines={1} style={{ color: colors.onSurface, fontFamily: "serif", fontWeight: "700", fontSize: 22, textAlign: "center" }}>{title}</Text>
                <Text maxFontSizeMultiplier={1.3} numberOfLines={1} style={{ color: colors.onSurfaceVariant, fontSize: 14, textAlign: "center", marginTop: 2 }}>{subtitleText}</Text>
                {hasChapters && currentChapterIndex >= 0 ? (
                  <Text maxFontSizeMultiplier={1.3} style={{ color: colors.onSurfaceVariant, fontSize: 12, textAlign: "center", marginTop: 4 }}>Chapter {Math.min(Math.max(currentChapterIndex + 1, 1), chapters.length)} of {chapters.length}</Text>
                ) : null}

                {/* Book progress row: elapsed | wave | -remaining (same
                    flanking layout as portrait). */}
                {showPlayerBookProgress !== false ? (
                  <View
                    style={{ marginTop: 12, flexDirection: "row", alignItems: "center", columnGap: 8 }}
                    // Grouped like the portrait book row — see the comment there.
                    accessible
                    accessibilityLabel={`Book progress: ${spokenTime(position)} elapsed, ${spokenTime(bookRemaining)} remaining`}
                  >
                    <BarTimeLabel colors={colors}>{secondsToTimestamp(position)}</BarTimeLabel>
                    <View style={{ flex: 1, justifyContent: "center" }}>
                      <WavyProgress progress={bookFrac} playing={isPlaying} color={colors.primary} trackColor={withAlpha(colors.primary, 0.35)} height={12} strokeWidth={3} amplitude={2} wavelength={48} flattenWhenPaused />
                    </View>
                    <BarTimeLabel colors={colors}>-{secondsToTimestamp(bookRemaining)}</BarTimeLabel>
                  </View>
                ) : null}

                {/* Chapter scrubber row: elapsed | wave | -remaining. Left
                    label derives from chapterElapsed (→ dragFrac) so it
                    live-updates during a drag, exactly like portrait. */}
                {showPlayerChapterProgress !== false ? (
                  <View style={{ marginTop: 6, flexDirection: "row", alignItems: "center", columnGap: 8 }}>
                    {/* Hidden: redundant with the scrubber's accessibilityValue. */}
                    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                      <BarTimeLabel colors={colors}>{secondsToTimestamp(chapterElapsed)}</BarTimeLabel>
                    </View>
                    <View {...chapterScrubPanResponder.panHandlers} {...scrubA11yProps} onLayout={onChapterBarLayoutFor(true)} style={{ flex: 1, height: 32, justifyContent: "center" }} hitSlop={{ top: 8, bottom: 8 }}>
                      <WavyProgress progress={chapterFrac} playing={isPlaying} color={colors.primary} trackColor={withAlpha(colors.primary, 0.22)} height={22} strokeWidth={4} amplitude={3.5} wavelength={44} showStopDot={false} showHandle handleActive={dragFrac != null} flattenWhenPaused />
                    </View>
                    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                      <BarTimeLabel colors={colors}>-{secondsToTimestamp(chapterRemaining)}</BarTimeLabel>
                    </View>
                  </View>
                ) : null}

                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", columnGap: 16, marginTop: 10 }}>
                  <CircleButton icon="skip-previous" iconSize={22} onPress={() => { previousChapter().catch(() => {}); }} disabled={!hasChapters} label="Previous chapter" colors={colors} />
                  <CircleButton icon={jumpIconName("back", jumpBackSecs)} iconSize={24} onPress={() => { seekBackward(jumpBackSecs).catch(() => {}); }} label={`Back ${jumpBackSecs} seconds`} colors={colors} />
                  <Pressable onPress={() => { playPause().catch(() => {}); }} accessibilityRole="button" accessibilityLabel={isPlaying ? "Pause" : "Play"} accessibilityState={{ busy: isBuffering }} style={{ width: 72, height: 72, borderRadius: isPlaying ? 22 : 36, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center", elevation: 3 }}>
                    <Icon name={isPlaying ? "pause" : "play"} size={36} color={colors.onPrimary} />
                  </Pressable>
                  <CircleButton icon={jumpIconName("fwd", jumpFwdSecs)} iconSize={24} onPress={() => { seekForward(jumpFwdSecs).catch(() => {}); }} label={`Forward ${jumpFwdSecs} seconds`} colors={colors} />
                  <CircleButton icon="skip-next" iconSize={22} onPress={() => { nextChapter().catch(() => {}); }} disabled={!hasChapters} label="Next chapter" colors={colors} />
                </View>

                {/* Same bottom pill as portrait ([speed][Sleep][Bookmark]) —
                    the old landscape-only chapters/sleep/speed/bookmark/queue
                    button row is gone; chapters + queue now live in the
                    "Chapters & Up Next" peek drawer (enabled in landscape),
                    matching portrait. Compact: landscape is height-starved. */}
                <BottomPillRow
                  testID="player-bottom-pill-landscape"
                  colors={colors}
                  speedLabel={speedLabel}
                  sleepTimer={sleepTimer}
                  onSpeed={() => { setShowSpeed(true); }}
                  onSleep={() => { setShowSleepTimer(true); }}
                  onBookmarks={() => { setShowBookmarks(true); }}
                  marginTop={10}
                  compact
                />
              </View>
            </View>
          </Animated.View>
        </View>
      </Animated.View>

      {/* --- MODAL DIALOGS (MOUNTED ROOT LEVEL) --- */}

      <PlayerChaptersQueueSheet
        mainPlayerProgress={sheetProgress}
        chapters={chapters}
        currentChapterIndex={currentChapterIndex}
        onSeekToChapter={seekToChapter}
        queue={queue}
        removeFromQueue={removeFromQueue}
        clearQueue={clearQueue}
        playNextInQueue={playNextInQueue}
        expanded={showChaptersQueue}
        onToggleExpand={setShowChaptersQueue}
        activeTab={chaptersQueueTab}
        onTabChange={setChaptersQueueTab}
        isLandscape={isLandscape}
      />

      <PlaybackSpeedModal
        visible={showSpeed}
        onClose={() => setShowSpeed(false)}
        speed={playbackSpeed}
        onChange={setPlaybackSpeed}
        rememberPerBook={rememberSpeedPerBook}
        onToggleRememberPerBook={setRememberSpeedPerBook}
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
        rewindOnWake={sleepRewindOnWake}
        onToggleRewindOnWake={setSleepRewindOnWake}
        shakeToExtend={sleepShakeToExtend}
        onToggleShakeToExtend={setSleepShakeToExtend}
      />

      <BookmarksModal
        visible={showBookmarks}
        onClose={() => setShowBookmarks(false)}
        libraryItemId={currentSession.libraryItemId || currentSession.libraryItem?.id}
        currentTime={position}
        onSeek={seek}
      />

      <PlayerOverflowModal
        visible={showOverflow}
        onClose={() => setShowOverflow(false)}
        hasChapters={hasChapters}
        isBookSession={!currentSession?.episodeId}
        favItemId={favItemId}
        isFav={isFav}
        onToggleFav={() => { toggleFavorite(favItemId!); }}
        onShowChapters={() => { setShowChaptersQueue(true); setChaptersQueueTab("chapters"); }}
        onGoToDetails={() => {
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
        onReadFromHere={readFromHere}
        onSyncFromServer={() => {
          usePlaybackStore
            .getState()
            .syncPositionFromServer()
            .then((r) =>
              showSnackbar({
                message:
                  r.status === "adopted"
                    ? "Jumped to your latest position"
                    : r.status === "up-to-date"
                    ? "Already at the latest position"
                    : "Couldn't reach the server",
              })
            )
            .catch(() => showSnackbar({ message: "Couldn't reach the server" }));
        }}
        onStopClose={() => {
          setPlayerExpanded(false);
          closePlayback().catch(() => {});
        }}
      />

      <Confetti visible={showConfetti} onDone={() => setShowConfetti(false)} />
    </View>
  );
}
