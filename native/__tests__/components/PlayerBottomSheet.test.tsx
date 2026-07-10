/**
 * PlayerBottomSheet — miniplayer + expanded player wiring reachable without
 * PanResponder gestures: title/author, play/pause, jump buttons (settings-
 * driven amounts), chapter next/prev, speed label formatting, sleep timer,
 * expand/collapse (incl. hardware back), source label, and modal wiring.
 *
 * NOTE: both the portrait and landscape subtrees stay mounted (visibility is
 * display-toggled), so most labels appear 2×; tests use getAllBy* and press
 * the first match.
 */
import { BackHandler } from "react-native";
import { render, screen, fireEvent, act } from "@testing-library/react-native";

// Toggle for the OS reduce-motion setting (Confetti reads useReducedMotion).
let mockReduceMotion = false;
// Minimal reanimated mock — the setup-level one pulls real react-native-worklets.
// withTiming deliberately does NOT fire its completion callback so one-shot
// effects (Confetti) stay visible for assertions.
jest.mock("react-native-reanimated", () => {
  const React = require("react");
  const RN = require("react-native");
  const strip = (C: any) =>
    React.forwardRef(({ entering, exiting, layout, animatedProps, ...rest }: any, ref: any) =>
      React.createElement(C, { ...rest, ...(animatedProps || {}), ref })
    );
  const Animated = {
    View: strip(RN.View),
    Text: strip(RN.Text),
    ScrollView: strip(RN.ScrollView),
    Image: strip(RN.Image),
    createAnimatedComponent: strip,
  };
  const chainable = () => {
    const o: any = {};
    ["delay", "duration", "springify", "damping", "stiffness"].forEach((m) => (o[m] = () => o));
    return o;
  };
  const interpolate = (v: number, input: number[], output: any[]) => {
    if (!Array.isArray(input) || !Array.isArray(output)) return 0;
    if (v <= input[0]) return output[0];
    if (v >= input[input.length - 1]) return output[output.length - 1];
    for (let i = 0; i < input.length - 1; i++) {
      if (v >= input[i] && v <= input[i + 1]) {
        const t = (v - input[i]) / (input[i + 1] - input[i] || 1);
        const a = output[i];
        const b = output[i + 1];
        return typeof a === "number" && typeof b === "number" ? a + t * (b - a) : a;
      }
    }
    return output[0];
  };
  return {
    __esModule: true,
    default: Animated,
    ...Animated,
    // Stable across renders (like the real hook) so effect-driven .value
    // writes survive re-renders and later style/props evaluations see them.
    useSharedValue: (init: any) => React.useRef({ value: init }).current,
    // Animated styles derive `pointerEvents` from sheetProgress, but this mock
    // evaluates them once at render (shared-value writes never re-render), so
    // the expanded pane would stay pointer-blocked forever. RNTL honors
    // style.pointerEvents (see helpers/pointer-events), so strip it — press
    // routing is still exercised via the REAL pointerEvents props on the
    // portrait/landscape wrapper views.
    useAnimatedStyle: (fn: any) => {
      try {
        const style = fn() || {};
        delete style.pointerEvents;
        return style;
      } catch {
        return {};
      }
    },
    useAnimatedProps: (fn: any) => {
      try {
        return fn() || {};
      } catch {
        return {};
      }
    },
    withTiming: (v: any) => v,
    withSpring: (v: any) => v,
    withRepeat: (v: any) => v,
    withDelay: (_d: number, v: any) => v,
    cancelAnimation: () => {},
    runOnJS: (fn: any) => fn,
    runOnUI: (fn: any) => fn,
    interpolate,
    Extrapolation: { CLAMP: "clamp" },
    Easing: {
      linear: (t: number) => t,
      ease: (t: number) => t,
      quad: (t: number) => t,
      cubic: (t: number) => t,
      bezier: () => ({ factory: () => (t: number) => t }),
      in: (f: any) => f,
      out: (f: any) => f,
      inOut: (f: any) => f,
    },
    useReducedMotion: () => mockReduceMotion,
    LinearTransition: chainable(),
    FadeIn: chainable(),
    FadeOut: chainable(),
    FadeInDown: chainable(),
    FadeInRight: chainable(),
  };
});

// Named exports missing from the global safe-area mock.
jest.mock("react-native-safe-area-context", () => {
  const React = require("react");
  const { View } = require("react-native");
  return {
    SafeAreaView: ({ children, ...props }: any) => React.createElement(View, props, children),
    SafeAreaProvider: ({ children }: any) => children,
    useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }),
    useSafeAreaFrame: () => ({ x: 0, y: 0, width: 320, height: 640 }),
  };
});

// BookmarksModal (child) fetches /api/me when opened.
jest.mock("../../utils/api", () => ({
  api: { get: jest.fn().mockResolvedValue({ data: { bookmarks: [] } }), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

// Real navigationRef is detached in tests (isReady() false) — stub it so the
// "View book details" path can be asserted.
jest.mock("../../navigation/navigationRef", () => ({
  navigationRef: { isReady: jest.fn(() => true), navigate: jest.fn() },
}));

import { CastContext } from "react-native-google-cast";
import PlayerBottomSheet from "../../components/PlayerBottomSheet";
import { navigationRef } from "../../navigation/navigationRef";
import { usePlaybackStore } from "../../store/usePlaybackStore";
import { useUserStore } from "../../store/useUserStore";
import { useDownloadStore } from "../../store/useDownloadStore";
import { useFavoritesStore } from "../../store/useFavoritesStore";

const playbackInitial = usePlaybackStore.getState();
const userInitial = useUserStore.getState();
const downloadInitial = useDownloadStore.getState();

const chapters = [
  { id: 0, title: "Ch 1", start: 0, end: 600 },
  { id: 1, title: "Ch 2", start: 600, end: 1200 },
  { id: 2, title: "Ch 3", start: 1200, end: 3600 },
];

const session = {
  id: "sess1",
  libraryItemId: "item1",
  displayTitle: "The Hobbit",
  displayAuthor: "J.R.R. Tolkien",
  coverUrl: "",
};

function seedPlayer(overrides: any = {}) {
  usePlaybackStore.setState({
    currentSession: session,
    isPlaying: false,
    position: 700, // inside Ch 2
    duration: 3600,
    playbackSpeed: 1.2999999, // float noise → must display as 1.3×
    chapters,
    currentChapterIndex: 1,
    sleepTimer: null,
    isPlayerExpanded: false,
    // Transport actions replaced with spies (real implementations hit TrackPlayer).
    playPause: jest.fn(),
    seekForward: jest.fn(),
    seekBackward: jest.fn(),
    seek: jest.fn(),
    seekToChapter: jest.fn(),
    nextChapter: jest.fn(),
    previousChapter: jest.fn(),
    setPlaybackSpeed: jest.fn(),
    setSleepTimer: jest.fn(),
    cancelSleepTimer: jest.fn(),
    ...overrides,
  } as any);
}

const store = () => usePlaybackStore.getState() as any;

beforeEach(() => {
  usePlaybackStore.setState(playbackInitial, true);
  useUserStore.setState(userInitial, true);
  useDownloadStore.setState(downloadInitial, true);
  useFavoritesStore.setState({ favorites: [] });
  useUserStore.setState({
    settings: { ...userInitial.settings, jumpForwardTime: 30, jumpBackwardTime: 15 },
  } as any);
});

describe("PlayerBottomSheet — render basics", () => {
  it("renders nothing without a session", async () => {
    await render(<PlayerBottomSheet />);
    expect(screen.toJSON()).toBeNull();
  });

  it("collapsed miniplayer shows chapter title, book • author and expand affordance", async () => {
    seedPlayer();
    await render(<PlayerBottomSheet />);
    // Miniplayer title prefers the current CHAPTER title; the subtitle then
    // carries the BOOK too, matching the notification's format. The visual
    // mini-title (2a) is decorative for a11y (includeHiddenElements) — the
    // expand affordance's label carries book, author AND chapter for TalkBack.
    expect(screen.getAllByText("Ch 2", { includeHiddenElements: true }).length).toBeGreaterThan(0);
    expect(
      screen.getAllByText("The Hobbit • J.R.R. Tolkien", { includeHiddenElements: true }).length
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByLabelText("Expand player. The Hobbit by J.R.R. Tolkien. Ch 2").length
    ).toBeGreaterThan(0);
  });

  it("falls back to the book title without chapters", async () => {
    seedPlayer({ chapters: [], currentChapterIndex: -1 });
    await render(<PlayerBottomSheet />);
    expect(
      screen.getAllByText("The Hobbit", { includeHiddenElements: true }).length
    ).toBeGreaterThan(0);
  });

  it("shows STREAMING for a server session and LOCAL when downloaded", async () => {
    // Full-player content is a11y-hidden while collapsed (so TalkBack can't
    // reach it behind the mini bar) — expand to assert it.
    seedPlayer({ isPlayerExpanded: true });
    await render(<PlayerBottomSheet />);
    expect(screen.getAllByText("STREAMING").length).toBeGreaterThan(0);

    await act(async () => {
      useDownloadStore.setState({
        completedDownloads: { item1: { id: "item1", status: "completed" } },
      } as any);
      seedPlayer({ isPlayerExpanded: true });
    });
    await render(<PlayerBottomSheet />);
    expect(screen.getAllByText("LOCAL").length).toBeGreaterThan(0);
  });

  it("shows the chapter caption when chapters exist", async () => {
    seedPlayer();
    await render(<PlayerBottomSheet />);
    // Lives in the expanded-title overlay (a11y-hidden while collapsed);
    // portrait + landscape both render it.
    expect(
      screen.getAllByText("Chapter 2 of 3", { includeHiddenElements: true }).length
    ).toBeGreaterThan(0);
  });

  it("renders both book and chapter progress when enabled in settings", async () => {
    useUserStore.setState({
      settings: {
        ...useUserStore.getState().settings,
        showPlayerBookProgress: true,
        showPlayerChapterProgress: true,
      },
    });
    seedPlayer({ isPlayerExpanded: true });
    await render(<PlayerBottomSheet />);
    expect(screen.getAllByLabelText(/Chapter progress:/i, { includeHiddenElements: true }).length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText(/Book progress:/i, { includeHiddenElements: true }).length).toBeGreaterThan(0);
  });

  it("hides book progress when disabled in settings", async () => {
    useUserStore.setState({
      settings: {
        ...useUserStore.getState().settings,
        showPlayerBookProgress: false,
        showPlayerChapterProgress: true,
      },
    });
    seedPlayer({ isPlayerExpanded: true });
    await render(<PlayerBottomSheet />);
    expect(screen.getAllByLabelText(/Chapter progress:/i, { includeHiddenElements: true }).length).toBeGreaterThan(0);
    expect(screen.queryAllByLabelText(/Book progress:/i, { includeHiddenElements: true })).toHaveLength(0);
  });

  it("hides chapter progress when disabled in settings", async () => {
    useUserStore.setState({
      settings: {
        ...useUserStore.getState().settings,
        showPlayerBookProgress: true,
        showPlayerChapterProgress: false,
      },
    });
    seedPlayer({ isPlayerExpanded: true });
    await render(<PlayerBottomSheet />);
    expect(screen.queryAllByLabelText(/Chapter progress:/i, { includeHiddenElements: true })).toHaveLength(0);
    expect(screen.getAllByLabelText(/Book progress:/i, { includeHiddenElements: true }).length).toBeGreaterThan(0);
  });
});

describe("PlayerBottomSheet — transport controls", () => {
  it("play button reflects paused state and calls playPause", async () => {
    seedPlayer({ isPlaying: false });
    await render(<PlayerBottomSheet />);
    const playButtons = screen.getAllByLabelText("Play");
    expect(playButtons.length).toBeGreaterThan(0);
    await fireEvent.press(playButtons[0]);
    expect(store().playPause).toHaveBeenCalledTimes(1);
  });

  it("shows Pause while playing", async () => {
    seedPlayer({ isPlaying: true });
    await render(<PlayerBottomSheet />);
    expect(screen.getAllByLabelText("Pause").length).toBeGreaterThan(0);
    expect(screen.queryAllByLabelText("Play")).toHaveLength(0);
  });

  it("jump buttons use the configured settings amounts", async () => {
    seedPlayer();
    await render(<PlayerBottomSheet />);
    await fireEvent.press(screen.getAllByLabelText("Back 15 seconds")[0]);
    expect(store().seekBackward).toHaveBeenCalledWith(15);
    await fireEvent.press(screen.getAllByLabelText("Forward 30 seconds")[0]);
    expect(store().seekForward).toHaveBeenCalledWith(30);
  });

  it("jump button icons match the configured amounts", async () => {
    seedPlayer();
    await render(<PlayerBottomSheet />);
    // 15s back → rewind-15, 30s forward → fast-forward-30 (MCI glyphs).
    expect(screen.getAllByLabelText("MaterialCommunityIcons:rewind-15").length).toBeGreaterThan(0);
    expect(
      screen.getAllByLabelText("MaterialCommunityIcons:fast-forward-30").length
    ).toBeGreaterThan(0);
  });

  it("chapter next/prev buttons are wired", async () => {
    seedPlayer({ isPlayerExpanded: true });
    await render(<PlayerBottomSheet />);
    await fireEvent.press(screen.getAllByLabelText("Next chapter")[0]);
    expect(store().nextChapter).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getAllByLabelText("Previous chapter")[0]);
    expect(store().previousChapter).toHaveBeenCalledTimes(1);
  });

  it("chapter scrubber a11y actions seek by the configured jumps", async () => {
    seedPlayer({ isPlayerExpanded: true });
    await render(<PlayerBottomSheet />);
    const scrubber = screen.getAllByLabelText("Chapter position")[0];
    await fireEvent(scrubber, "accessibilityAction", {
      nativeEvent: { actionName: "increment" },
    });
    expect(store().seekForward).toHaveBeenCalledWith(30);
    await fireEvent(scrubber, "accessibilityAction", {
      nativeEvent: { actionName: "decrement" },
    });
    expect(store().seekBackward).toHaveBeenCalledWith(15);
  });
});

describe("PlayerBottomSheet — buffering indicator (M2)", () => {
  it("overlays a spinner on the play/pause control while buffering", async () => {
    // A stall folds into "playing" in the progress loop, so without the
    // spinner the pause glyph sits over a frozen scrubber (looks hung).
    seedPlayer({ isPlaying: true, isBuffering: true });
    await render(<PlayerBottomSheet />);
    expect(screen.getAllByTestId("buffering-indicator").length).toBeGreaterThan(0);
  });

  it("shows no spinner once the stream is no longer buffering", async () => {
    seedPlayer({ isPlaying: true, isBuffering: false });
    await render(<PlayerBottomSheet />);
    expect(screen.queryAllByTestId("buffering-indicator")).toHaveLength(0);
  });
});

describe("PlayerBottomSheet — speed label + modal", () => {
  it("formats float-noise speeds cleanly (1.2999999 → 1.3×)", async () => {
    seedPlayer({ isPlayerExpanded: true });
    await render(<PlayerBottomSheet />);
    expect(screen.getAllByText("1.3×").length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText("Playback speed, 1.3×").length).toBeGreaterThan(0);
  });

  it("formats a whole-number speed without trailing zeros (3 → 3×)", async () => {
    seedPlayer({ playbackSpeed: 3.0000001, isPlayerExpanded: true });
    await render(<PlayerBottomSheet />);
    expect(screen.getAllByText("3×").length).toBeGreaterThan(0);
  });

  it("opens the speed modal and forwards the chosen rate", async () => {
    seedPlayer({ isPlayerExpanded: true });
    await render(<PlayerBottomSheet />);
    await fireEvent.press(screen.getAllByLabelText("Playback speed, 1.3×")[0]);
    expect(screen.getByText("Playback Speed")).toBeTruthy(); // modal header
    await fireEvent.press(screen.getByText("1.5×"));
    expect(store().setPlaybackSpeed).toHaveBeenCalledWith(1.5);
  });
});

describe("PlayerBottomSheet — sleep timer", () => {
  it("shows remaining time on the pill while a timer runs", async () => {
    seedPlayer({ sleepTimer: { endOfChapter: false, remaining: 754 }, isPlayerExpanded: true });
    await render(<PlayerBottomSheet />);
    expect(screen.getAllByLabelText("Sleep timer, 12:34 remaining").length).toBeGreaterThan(0);
    expect(screen.getAllByText("12:34").length).toBeGreaterThan(0);
  });

  it("opens the sleep modal; End of chapter arms the remaining-chapter seconds", async () => {
    // position 700, Ch 2 ends at 1200 → 500s remaining
    seedPlayer({ isPlayerExpanded: true });
    await render(<PlayerBottomSheet />);
    await fireEvent.press(screen.getAllByLabelText("Sleep timer")[0]);
    expect(screen.getByText("Sleep Timer")).toBeTruthy(); // modal header
    await fireEvent.press(screen.getByText("End of chapter"));
    expect(store().setSleepTimer).toHaveBeenCalledWith(500, true);
  });

  it("preset selection arms a fixed timer", async () => {
    seedPlayer({ isPlayerExpanded: true });
    await render(<PlayerBottomSheet />);
    await fireEvent.press(screen.getAllByLabelText("Sleep timer")[0]);
    await fireEvent.press(screen.getByText("30 min"));
    expect(store().setSleepTimer).toHaveBeenCalledWith(1800, false);
  });

  it("a running timer can be extended in place without cancelling", async () => {
    seedPlayer({ sleepTimer: { endOfChapter: false, remaining: 120 }, isPlayerExpanded: true });
    await render(<PlayerBottomSheet />);
    await fireEvent.press(screen.getAllByLabelText("Sleep timer, 2:00 remaining")[0]);
    // +15 extends onto the current remaining (120s + 15m) as a fixed timer.
    await fireEvent.press(screen.getByLabelText("Add 15 minutes"));
    expect(store().setSleepTimer).toHaveBeenCalledWith(120 + 15 * 60, false);
  });
});

describe("PlayerBottomSheet — chapters modal", () => {
  it("opens the chapters list and seeks on selection", async () => {
    seedPlayer({ isPlayerExpanded: true });
    await render(<PlayerBottomSheet />);
    await fireEvent.press(screen.getAllByLabelText("Chapters")[0]);
    await fireEvent.press(screen.getByText("Ch 1"));
    expect(store().seekToChapter).toHaveBeenCalledWith(0);
  });

  it("chapters button is disabled without chapters", async () => {
    seedPlayer({ chapters: [], currentChapterIndex: -1, isPlayerExpanded: true });
    await render(<PlayerBottomSheet />);
    await fireEvent.press(screen.getByLabelText("More options"));
    expect(screen.getByLabelText("Chapters List").props.accessibilityState?.disabled).toBe(true);
  });
});

describe("PlayerBottomSheet — expand / collapse", () => {
  it("tapping the miniplayer expands the sheet", async () => {
    seedPlayer();
    await render(<PlayerBottomSheet />);
    await fireEvent.press(
      screen.getAllByLabelText("Expand player. The Hobbit by J.R.R. Tolkien. Ch 2")[0]
    );
    expect(usePlaybackStore.getState().isPlayerExpanded).toBe(true);
  });

  it("still expands to the full-player state under OS reduce-motion", async () => {
    // With reduce-motion ON the sheet skips the spring/timing morph but must
    // still reach the EXACT same expanded end state — the store flips and the
    // full-player content (a11y-hidden while collapsed) becomes reachable.
    mockReduceMotion = true;
    try {
      seedPlayer();
      await render(<PlayerBottomSheet />);
      expect(screen.queryByLabelText("Collapse player")).toBeNull();
      await fireEvent.press(
        screen.getAllByLabelText("Expand player. The Hobbit by J.R.R. Tolkien. Ch 2")[0]
      );
      expect(usePlaybackStore.getState().isPlayerExpanded).toBe(true);
      expect(screen.getAllByLabelText("Collapse player").length).toBeGreaterThan(0);
      expect(screen.getAllByText("STREAMING").length).toBeGreaterThan(0);
    } finally {
      mockReduceMotion = false;
    }
  });

  it("collapse button closes the expanded sheet", async () => {
    seedPlayer({ isPlayerExpanded: true });
    await render(<PlayerBottomSheet />);
    await fireEvent.press(screen.getAllByLabelText("Collapse player")[0]);
    expect(usePlaybackStore.getState().isPlayerExpanded).toBe(false);
  });

  it("hardware back collapses an expanded player (claimed)", async () => {
    const handlers: Array<() => boolean> = [];
    const addSpy = jest
      .spyOn(BackHandler, "addEventListener")
      .mockImplementation((_e: any, h: any) => {
        handlers.push(h);
        return { remove: jest.fn() } as any;
      });
    seedPlayer({ isPlayerExpanded: true });
    await render(<PlayerBottomSheet />);
    let claimed = false;
    await act(async () => {
      claimed = handlers[handlers.length - 1]();
    });
    expect(claimed).toBe(true);
    expect(usePlaybackStore.getState().isPlayerExpanded).toBe(false);
    addSpy.mockRestore();
  });

  it("hardware back is NOT claimed while collapsed", async () => {
    const handlers: Array<() => boolean> = [];
    const addSpy = jest
      .spyOn(BackHandler, "addEventListener")
      .mockImplementation((_e: any, h: any) => {
        handlers.push(h);
        return { remove: jest.fn() } as any;
      });
    seedPlayer({ isPlayerExpanded: false });
    await render(<PlayerBottomSheet />);
    let claimed = true;
    await act(async () => {
      claimed = handlers[handlers.length - 1]();
    });
    expect(claimed).toBe(false);
    addSpy.mockRestore();
  });
});

describe("PlayerBottomSheet — Read-from-here removed", () => {
  // Reading is now reached via the ItemDetail "Read" button, so the player no
  // longer carries its own Read-from-here affordance in either layout.
  it("has no Read from here button in the expanded player", async () => {
    seedPlayer({ isPlayerExpanded: true });
    await render(<PlayerBottomSheet />);
    expect(
      screen.queryAllByLabelText("Read from here", { includeHiddenElements: true })
    ).toHaveLength(0);
  });
});

describe("PlayerBottomSheet — Chapters in the bottom control row", () => {
  it("Chapters is reachable in the expanded player and opens the modal", async () => {
    seedPlayer({ isPlayerExpanded: true });
    await render(<PlayerBottomSheet />);
    await fireEvent.press(screen.getAllByLabelText("Chapters")[0]);
    await fireEvent.press(screen.getByText("Ch 1"));
    expect(store().seekToChapter).toHaveBeenCalledWith(0);
  });

  it("Chapters is disabled without chapters", async () => {
    seedPlayer({ chapters: [], currentChapterIndex: -1, isPlayerExpanded: true });
    await render(<PlayerBottomSheet />);
    await fireEvent.press(screen.getByLabelText("More options"));
    expect(screen.getByLabelText("Chapters List").props.accessibilityState?.disabled).toBe(true);
  });

  it("keeps the speed pill present alongside the relocated Chapters button", async () => {
    seedPlayer({ isPlayerExpanded: true });
    await render(<PlayerBottomSheet />);
    expect(screen.getAllByLabelText("Playback speed, 1.3×").length).toBeGreaterThan(0);
    expect(screen.getAllByText("1.3×").length).toBeGreaterThan(0);
  });
});

describe("PlayerBottomSheet — Want to Read heart", () => {
  it("toggles the favorite and reflects the selected state", async () => {
    jest.useFakeTimers();
    try {
      seedPlayer({ isPlayerExpanded: true });
      await render(<PlayerBottomSheet />);

      // Open overflow modal to show "Add to Want to Read"
      await fireEvent.press(screen.getByLabelText("More options"));

      // Not favorited yet: label offers to add, and selected is false.
      const add = screen.getAllByLabelText("Add to Want to Read");
      expect(add.length).toBeGreaterThan(0);
      expect(add[0].props.accessibilityState?.selected).toBe(false);

      await fireEvent.press(add[0]);
      await act(async () => {
        jest.advanceTimersByTime(200);
      });
      expect(useFavoritesStore.getState().favorites).toContain("item1");

      // Open overflow modal again to show "Remove from Want to Read"
      await fireEvent.press(screen.getByLabelText("More options"));

      // Re-render reflects the flipped state via the reactive subscription.
      const remove = screen.getAllByLabelText("Remove from Want to Read");
      expect(remove.length).toBeGreaterThan(0);
      expect(remove[0].props.accessibilityState?.selected).toBe(true);

      await fireEvent.press(remove[0]);
      await act(async () => {
        jest.advanceTimersByTime(200);
      });
      expect(useFavoritesStore.getState().favorites).not.toContain("item1");
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("PlayerBottomSheet — top bar actions", () => {
  it("Cast button opens the cast device dialog", async () => {
    seedPlayer({ isPlayerExpanded: true });
    await render(<PlayerBottomSheet />);
    await fireEvent.press(screen.getAllByLabelText("Cast to device")[0]);
    expect(CastContext.showCastDialog).toHaveBeenCalled();
  });

  it("View book details collapses then navigates to ItemDetail", async () => {
    jest.useFakeTimers();
    try {
      seedPlayer({ isPlayerExpanded: true });
      await render(<PlayerBottomSheet />);
      await fireEvent.press(screen.getByLabelText("More options"));
      await fireEvent.press(screen.getAllByLabelText("View book details")[0]);
      await act(async () => {
        jest.advanceTimersByTime(200);
      });
      expect(usePlaybackStore.getState().isPlayerExpanded).toBe(false);
      await act(async () => {
        jest.advanceTimersByTime(300); // waits for the collapse animation
      });
      expect(navigationRef.navigate).toHaveBeenCalledWith("ItemDetail", { itemId: "item1" });
    } finally {
      jest.useRealTimers();
    }
  });

  it("Bookmarks button opens the bookmarks modal", async () => {
    seedPlayer({ isPlayerExpanded: true });
    await render(<PlayerBottomSheet />);
    await fireEvent.press(screen.getAllByLabelText("Bookmarks")[0]);
    expect(await screen.findByText("Your Bookmarks")).toBeTruthy();
  });

  // Stop is the only in-player way to dismiss a session (final sync + save
  // cleanup); a dead button would strand a finished book on-screen.
  it("Stop button collapses the player and closes playback", async () => {
    jest.useFakeTimers();
    try {
      const closePlayback = jest.fn().mockResolvedValue(undefined);
      seedPlayer({ isPlayerExpanded: true, closePlayback });
      await render(<PlayerBottomSheet />);
      await fireEvent.press(screen.getByLabelText("More options"));
      await fireEvent.press(screen.getAllByLabelText("Stop and close player")[0]);
      await act(async () => {
        jest.advanceTimersByTime(200);
      });
      expect(usePlaybackStore.getState().isPlayerExpanded).toBe(false);
      expect(closePlayback).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("PlayerBottomSheet — landscape layout", () => {
  /** Re-measure the root as landscape so the landscape subtree takes over
   *  (pointerEvents flips: portrait wrapper → none, landscape → box-none). */
  async function goLandscape() {
    await fireEvent(screen.root!, "layout", {
      nativeEvent: { layout: { width: 800, height: 400 } },
    });
  }

  it("landscape mini bar transport controls are wired", async () => {
    seedPlayer({ isPlaying: false });
    await render(<PlayerBottomSheet />);
    await goLandscape();
    // Landscape instances come after portrait ones in tree order — with the
    // portrait wrapper now pointer-blocked, presses must hit the landscape bar.
    const play = screen.getAllByLabelText("Play");
    await fireEvent.press(play[play.length - 1]);
    expect(store().playPause).toHaveBeenCalledTimes(1);

    const back = screen.getAllByLabelText("Back 15 seconds");
    await fireEvent.press(back[back.length - 1]);
    expect(store().seekBackward).toHaveBeenCalledWith(15);

    const fwd = screen.getAllByLabelText("Forward 30 seconds");
    await fireEvent.press(fwd[fwd.length - 1]);
    expect(store().seekForward).toHaveBeenCalledWith(30);
  });

  it("landscape mini bar expands the player", async () => {
    seedPlayer();
    await render(<PlayerBottomSheet />);
    await goLandscape();
    const expand = screen.getAllByLabelText("Expand player. The Hobbit by J.R.R. Tolkien. Ch 2");
    await fireEvent.press(expand[expand.length - 1]);
    expect(usePlaybackStore.getState().isPlayerExpanded).toBe(true);
  });

  // Parity with portrait: the landscape header must carry Stop (the only
  // in-player dismissal), or a finished book can't be closed when the phone is
  // rotated. Read-from-here was removed (reading is reached via ItemDetail).
  it("landscape header has Stop (no Read-from-here), and Stop closes playback", async () => {
    const closePlayback = jest.fn().mockResolvedValue(undefined);
    seedPlayer({ isPlayerExpanded: true, closePlayback });
    await render(<PlayerBottomSheet />);
    await goLandscape();

    // Portrait + landscape subtrees both render, but portrait Stop button is inside
    // the collapsed overflow modal, so it is not rendered on mount.
    expect(
      screen.getAllByLabelText("Stop and close player", { includeHiddenElements: true }).length
    ).toBe(1);
    // Read-from-here is gone from both layouts.
    expect(
      screen.queryAllByLabelText("Read from here", { includeHiddenElements: true }).length
    ).toBe(0);

    // The visible (landscape) Stop closes playback.
    const stops = screen.getAllByLabelText("Stop and close player");
    await fireEvent.press(stops[stops.length - 1]);
    expect(closePlayback).toHaveBeenCalled();
  });

  it("hides the landscape full player from TalkBack while collapsed", async () => {
    seedPlayer(); // collapsed
    await render(<PlayerBottomSheet />);
    await goLandscape();
    // "Collapse player" lives only in the full-player subtree — it must not be
    // reachable by an accessibility query while collapsed (only behind the
    // includeHiddenElements escape hatch), so TalkBack can't wander into the
    // opacity-0 controls behind the mini bar.
    expect(screen.queryByLabelText("Collapse player")).toBeNull();
    expect(
      screen.getAllByLabelText("Collapse player", { includeHiddenElements: true }).length
    ).toBeGreaterThan(0);
  });

  it("hides the landscape mini bar from TalkBack while expanded", async () => {
    seedPlayer({ isPlayerExpanded: true });
    await render(<PlayerBottomSheet />);
    await goLandscape();
    // Expanded: the mini bar's duplicate "Expand player" affordance must be
    // out of the a11y tree so it isn't offered on an already-expanded player.
    expect(screen.queryByLabelText(/^Expand player\./)).toBeNull();
  });

  it("landscape expanded pane: collapse, chapters, speed and sleep controls", async () => {
    seedPlayer({ isPlayerExpanded: true });
    await render(<PlayerBottomSheet />);
    await goLandscape();

    const speedPills = screen.getAllByLabelText("Playback speed, 1.3×");
    await fireEvent.press(speedPills[speedPills.length - 1]);
    expect(screen.getByText("Playback Speed")).toBeTruthy();

    const nexts = screen.getAllByLabelText("Next chapter");
    await fireEvent.press(nexts[nexts.length - 1]);
    expect(store().nextChapter).toHaveBeenCalled();

    const prevs = screen.getAllByLabelText("Previous chapter");
    await fireEvent.press(prevs[prevs.length - 1]);
    expect(store().previousChapter).toHaveBeenCalled();

    const collapses = screen.getAllByLabelText("Collapse player");
    await fireEvent.press(collapses[collapses.length - 1]);
    expect(usePlaybackStore.getState().isPlayerExpanded).toBe(false);
  });
});

describe("PlayerBottomSheet — play queue", () => {
  it("opens the queue sheet and lists queued books", async () => {
    seedPlayer({ isPlayerExpanded: true, queue: [{ libraryItemId: "b2", title: "Next Book", author: "A" }] });
    await render(<PlayerBottomSheet />);
    await fireEvent.press(screen.getAllByLabelText("Chapters")[0]);
    await fireEvent.press(screen.getByText("Up Next (1)"));
    expect(screen.getByText("Up Next")).toBeTruthy();
    expect(screen.getByText("Next Book")).toBeTruthy();
  });

  it("play-now starts the head of the queue", async () => {
    const playNextInQueue = jest.fn().mockResolvedValue(true);
    seedPlayer({
      isPlayerExpanded: true,
      queue: [{ libraryItemId: "b2", title: "Next Book" }],
      playNextInQueue,
    });
    await render(<PlayerBottomSheet />);
    await fireEvent.press(screen.getAllByLabelText("Chapters")[0]);
    await fireEvent.press(screen.getByText("Up Next (1)"));
    await fireEvent.press(screen.getByLabelText("Play Next Book now"));
    expect(playNextInQueue).toHaveBeenCalled();
  });

  it("remove drops a book from the queue", async () => {
    const removeFromQueue = jest.fn();
    seedPlayer({
      isPlayerExpanded: true,
      queue: [{ libraryItemId: "b2", title: "Next Book" }],
      removeFromQueue,
    });
    await render(<PlayerBottomSheet />);
    await fireEvent.press(screen.getAllByLabelText("Chapters")[0]);
    await fireEvent.press(screen.getByText("Up Next (1)"));
    await fireEvent.press(screen.getByLabelText("Remove Next Book from queue"));
    expect(removeFromQueue).toHaveBeenCalledWith("b2", undefined);
  });

  it("shows the empty-queue message when nothing is queued", async () => {
    seedPlayer({ isPlayerExpanded: true, queue: [] });
    await render(<PlayerBottomSheet />);
    await fireEvent.press(screen.getAllByLabelText("Chapters")[0]);
    await fireEvent.press(screen.getByText("Up Next (0)"));
    expect(screen.getByText(/No books queued/)).toBeTruthy();
  });
});

describe("PlayerBottomSheet — finish-line confetti", () => {
  /** Confetti particles: absolutely-positioned views with borderRadius 2. */
  function countParticles(node: any): number {
    if (!node) return 0;
    const arr = Array.isArray(node) ? node : [node];
    let n = 0;
    for (const el of arr) {
      if (!el || typeof el === "string") continue;
      const styles = Array.isArray(el.props?.style) ? el.props.style : [el.props?.style];
      const flat = Object.assign({}, ...styles.filter(Boolean));
      if (flat.borderRadius === 2 && flat.position === "absolute") n++;
      n += countParticles(el.children);
    }
    return n;
  }

  it("fires once when playback NATURALLY crosses the finish line", async () => {
    // Resume just before the line, then a normal playback tick carries it over.
    seedPlayer({ position: 3597 });
    await render(<PlayerBottomSheet />);
    expect(countParticles(screen.toJSON())).toBe(0);
    await act(async () => {
      usePlaybackStore.setState({ position: 3599 } as any); // +2s natural advance
    });
    expect(countParticles(screen.toJSON())).toBe(28);
  });

  it("does NOT fire when SCRUBBING/seeking to the end (big position jump)", async () => {
    seedPlayer({ position: 700 });
    await render(<PlayerBottomSheet />);
    await act(async () => {
      // A drag/seek from the middle to the end lands as one large jump.
      usePlaybackStore.setState({ position: 3599 } as any);
    });
    expect(countParticles(screen.toJSON())).toBe(0);
  });

  it("suppresses the burst entirely under OS reduce-motion", async () => {
    mockReduceMotion = true;
    try {
      seedPlayer({ position: 3597 });
      await render(<PlayerBottomSheet />);
      await act(async () => {
        usePlaybackStore.setState({ position: 3599 } as any); // natural crossing
      });
      // The celebration is decorative — reduce-motion users get no particles.
      expect(countParticles(screen.toJSON())).toBe(0);
    } finally {
      mockReduceMotion = false;
    }
  });

  it("does NOT fire when restoring a session already at the end", async () => {
    seedPlayer({ position: 3599 });
    await render(<PlayerBottomSheet />);
    // First observation is the resume point — no crossing, no celebration.
    await act(async () => {
      usePlaybackStore.setState({ position: 3599.5 } as any);
    });
    expect(countParticles(screen.toJSON())).toBe(0);
  });
});
