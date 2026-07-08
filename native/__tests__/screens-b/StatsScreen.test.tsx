/**
 * StatsScreen — /api/me/listening-stats totals, DST-safe last-7-days chart
 * math, days-in-a-row streak, itemsFinished derived from the store's progress
 * map (not the login payload), recent sessions list, error/retry, and the
 * offline / pending-sync freshness captions under the chart.
 */
jest.mock("react-native-safe-area-context", () =>
  require("react-native-safe-area-context/jest/mock").default
);
jest.mock("react-native-reanimated", () => {
  const RN = require("react-native");
  const chainable = () => {
    const o: any = {};
    [
      "delay", "duration", "springify", "damping", "stiffness", "mass",
      "easing", "build", "withInitialValues", "randomDelay", "reduceMotion",
      "withCallback",
    ].forEach((k) => (o[k] = () => o));
    return o;
  };
  const id = (v: any) => v;
  const easing = (t: number) => t;
  return {
    __esModule: true,
    default: {
      createAnimatedComponent: (C: any) => C,
      View: RN.View, Text: RN.Text, Image: RN.Image,
      ScrollView: RN.ScrollView, FlatList: RN.FlatList,
    },
    useSharedValue: (v: any) => ({ value: v }),
    useAnimatedStyle: () => ({}),
    useAnimatedProps: () => ({}),
    useDerivedValue: (fn: any) => ({ value: typeof fn === "function" ? fn() : fn }),
    useAnimatedRef: () => ({ current: null }),
    useAnimatedScrollHandler: () => () => {},
    useAnimatedReaction: () => {},
    useReducedMotion: () => false,
    withTiming: id, withSpring: id, withDelay: (_d: any, v: any) => v,
    withRepeat: id, withSequence: id,
    cancelAnimation: () => {},
    interpolate: () => 0,
    interpolateColor: () => "rgb(0, 0, 0)",
    Extrapolation: { CLAMP: "clamp", EXTEND: "extend", IDENTITY: "identity" },
    Extrapolate: { CLAMP: "clamp", EXTEND: "extend", IDENTITY: "identity" },
    runOnJS: (fn: any) => fn, runOnUI: (fn: any) => fn,
    Easing: {
      linear: easing, ease: easing, quad: easing, cubic: easing,
      bezier: () => ({ factory: () => easing }),
      in: (f: any) => f || easing, out: (f: any) => f || easing, inOut: (f: any) => f || easing,
    },
    FadeIn: chainable(), FadeOut: chainable(), FadeInDown: chainable(),
    FadeInUp: chainable(), FadeInRight: chainable(), FadeInLeft: chainable(),
    FadeOutDown: chainable(), FadeOutUp: chainable(),
    SlideInDown: chainable(), SlideOutDown: chainable(),
    LinearTransition: chainable(),
    ReduceMotion: { System: "system", Always: "always", Never: "never" },
  };
});
jest.mock("../../utils/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock("../../utils/progressSync", () => ({
  queueFinishedPatch: jest.fn(),
  queueProgressPatch: jest.fn(),
  queueEbookProgressPatch: jest.fn(),
  flushPendingSyncs: jest.fn().mockResolvedValue(undefined),
  clearAllPending: jest.fn(),
  syncProgress: jest.fn().mockResolvedValue(undefined),
  closeSession: jest.fn().mockResolvedValue(undefined),
  hasAnyPendingSyncs: jest.fn(() => false),
}));
// Controllable connectivity per test.
jest.mock("../../hooks/useNetworkStatus", () => {
  const useNetworkStatus = jest.fn(() => ({ isConnected: true, isInternetReachable: true }));
  return { useNetworkStatus, default: useNetworkStatus };
});

import React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react-native";
import StatsScreen from "../../screens/StatsScreen";
import { api } from "../../utils/api";
import { hasAnyPendingSyncs } from "../../utils/progressSync";
import { useNetworkStatus } from "../../hooks/useNetworkStatus";
import { useUserStore } from "../../store/useUserStore";
import { usePlaybackStore } from "../../store/usePlaybackStore";
import { storage } from "../../utils/storage";

const mockedNet = useNetworkStatus as jest.Mock;
const mockedPending = hasAnyPendingSyncs as jest.Mock;

const initialUser = useUserStore.getState();
const initialPlayback = usePlaybackStore.getState();

// Mirror the screen's local-calendar helpers so the fixture keys land on the
// exact same YYYY-MM-DD strings regardless of the machine's timezone.
function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function daysAgo(n: number): Date {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d;
}

// Focus fires on initial mount in the real navigator — replicate that.
function makeNavigation() {
  const navigation: any = {
    navigate: jest.fn(),
    goBack: jest.fn(),
    addListener: jest.fn((event: string, cb: () => void) => {
      if (event === "focus") cb();
      return jest.fn();
    }),
  };
  navigation.getParent = jest.fn(() => navigation);
  return navigation;
}

async function renderStats() {
  const navigation = makeNavigation();
  await render(<StatsScreen navigation={navigation} />);
  return navigation;
}

beforeEach(() => {
  jest.useFakeTimers();
  // Monday after the US DST fall-back (Nov 2, 2025): daysAgo() must count the
  // 25-hour day exactly once. In non-DST timezones this is a plain Monday and
  // the math is identical.
  jest.setSystemTime(new Date(2025, 10, 3, 15, 30, 0));

  // Goal keys live in a module-singleton MMKV; clear them so one test's saved
  // goal can't leak into the next.
  storage.remove("listeningGoalMinutes");
  storage.remove("listeningGoalPeriod");

  useUserStore.setState(initialUser, true);
  usePlaybackStore.setState(initialPlayback, true);
  usePlaybackStore.setState({ currentSession: null } as any);
  mockedNet.mockReturnValue({ isConnected: true, isInternetReachable: true });
  mockedPending.mockReturnValue(false);
  useUserStore.setState({
    loadMediaProgress: jest.fn().mockResolvedValue(undefined),
    mediaProgress: {
      done1: { libraryItemId: "done1", isFinished: true },
      done2: { libraryItemId: "done2", isFinished: true },
      inflight: { libraryItemId: "inflight", progress: 0.4 },
    },
  } as any);

  const days: Record<string, number> = {
    [ymd(daysAgo(0))]: 600, // today: 10 min
    [ymd(daysAgo(1))]: 1200, // yesterday (DST day): 20 min
    [ymd(daysAgo(2))]: 300, // 5 min
    // gap at daysAgo(3) ends the streak at 3
    [ymd(daysAgo(5))]: 60, // outside the streak, still a listened day
  };
  (api.get as jest.Mock).mockResolvedValue({
    data: {
      totalTime: 7260, // -> 121 minutes
      today: 600,
      days,
      recentSessions: [
        {
          id: "sess1",
          mediaMetadata: { title: "Latest Listen" },
          timeListening: 3660, // 61 min (< 70 stays minutes)
          updatedAt: Date.now() - 2 * 3600 * 1000, // "2h ago"
        },
        {
          id: "sess2",
          displayTitle: "Quick Peek",
          timeListening: 45, // "45 sec"
          updatedAt: Date.now() - 30 * 60 * 1000, // "30m ago"
        },
        {
          id: "sess3",
          mediaMetadata: { title: "Long Haul" },
          timeListening: 4200, // 70 min -> "1 hr 10 min"
          updatedAt: Date.now() - 26 * 3600 * 1000, // "1d ago"
        },
      ],
    },
  });
});

afterEach(() => {
  jest.useRealTimers();
});

describe("StatsScreen", () => {
  it("loads stats on focus and renders the three totals", async () => {
    await renderStats();

    expect(await screen.findByText("Minutes Listening")).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith("/api/me/listening-stats");
    // Items Finished comes from the store's progress map: 2 finished.
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("Items Finished")).toBeTruthy();
    // 4 day keys -> Days Listened ("4" also appears as a chart Y-axis label).
    expect(screen.getAllByText("4").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Days Listened")).toBeTruthy();
    // totalTime 7260s -> 121 minutes.
    expect(screen.getByText("121")).toBeTruthy();
    // loadMediaProgress refresh was kicked off too.
    expect(useUserStore.getState().loadMediaProgress).toHaveBeenCalled();
  });

  it("computes week minutes, daily average, best day and the DST-safe streak", async () => {
    await renderStats();
    await screen.findByText("Week Listening");

    // 10 + 20 + 5 = 35 minutes across the last 7 days (the day-5 entry counts).
    // wait: 60s -> 1 min, daysAgo(5) is inside the last 7 days -> 36 total.
    expect(screen.getByText("36")).toBeTruthy(); // Week Listening
    expect(screen.getByText("5")).toBeTruthy(); // Daily Average round(36/7)
    // Best Day 20 (also present as a chart Y-axis label).
    expect(screen.getAllByText("20").length).toBeGreaterThanOrEqual(2);
    // Streak: today + yesterday (the 25h DST day counts once) + 2 days ago.
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText("in a row")).toBeTruthy();
    // Chart Y axis derives from best day: factor ceil(20/5)=4 -> top label 24.
    expect(screen.getByText("24")).toBeTruthy();
    expect(screen.getByText("Minutes Listening (last 7 days)")).toBeTruthy();
  });

  it("renders recent sessions with pretty times and relative dates", async () => {
    await renderStats();
    await screen.findByText("Recent Sessions");

    expect(screen.getByText("Latest Listen")).toBeTruthy();
    expect(screen.getByText("61 min")).toBeTruthy();
    expect(screen.getByText("2h ago")).toBeTruthy();

    expect(screen.getByText("Quick Peek")).toBeTruthy();
    expect(screen.getByText("45 sec")).toBeTruthy();
    expect(screen.getByText("30m ago")).toBeTruthy();

    expect(screen.getByText("Long Haul")).toBeTruthy();
    expect(screen.getByText("1 hr 10 min")).toBeTruthy();
    expect(screen.getByText("1d ago")).toBeTruthy();
  });

  it("shows the no-sessions placeholder when the history is empty", async () => {
    (api.get as jest.Mock).mockResolvedValue({
      data: { totalTime: 0, today: 0, days: {}, recentSessions: [] },
    });
    await renderStats();

    expect(await screen.findByText("No listening sessions yet")).toBeTruthy();
    // Empty days map -> zeroed streak/averages render fine.
    expect(screen.getByText("Days Listened")).toBeTruthy();
  });

  it("shows an error with retry when the stats fetch fails", async () => {
    (api.get as jest.Mock).mockRejectedValueOnce(new Error("stats down"));
    await renderStats();

    expect(await screen.findByText("stats down")).toBeTruthy();

    await fireEvent.press(screen.getByText("Retry"));
    expect(await screen.findByText("Recent Sessions")).toBeTruthy();
  });

  it("shows the offline caption under the chart when disconnected", async () => {
    mockedNet.mockReturnValue({ isConnected: false, isInternetReachable: false });
    await renderStats();
    await screen.findByText("Minutes Listening (last 7 days)");

    expect(
      screen.getByText(
        "You're offline — recent listening will be added to these stats once you reconnect."
      )
    ).toBeTruthy();
    expect(
      screen.queryByText("Some recent listening is still syncing and may not be reflected yet.")
    ).toBeNull();
  });

  it("shows the pending-sync caption when online with unflushed listening", async () => {
    mockedPending.mockReturnValue(true);
    await renderStats();
    await screen.findByText("Minutes Listening (last 7 days)");

    expect(
      screen.getByText("Some recent listening is still syncing and may not be reflected yet.")
    ).toBeTruthy();
    expect(
      screen.queryByText(
        "You're offline — recent listening will be added to these stats once you reconnect."
      )
    ).toBeNull();
  });

  it("clears the pending-sync caption (and refreshes) when the flush lands while the screen stays open", async () => {
    jest.useFakeTimers();
    try {
      mockedPending.mockReturnValue(true);
      await renderStats();
      await screen.findByText("Some recent listening is still syncing and may not be reflected yet.");
      const statsCallsBefore = (api.get as jest.Mock).mock.calls.filter(
        (c) => c[0] === "/api/me/listening-stats"
      ).length;

      // The background flush completes; the periodic re-check must clear the
      // caption and silently reload the stats so the landed minutes render.
      mockedPending.mockReturnValue(false);
      await act(async () => {
        jest.advanceTimersByTime(5_000);
      });

      expect(
        screen.queryByText("Some recent listening is still syncing and may not be reflected yet.")
      ).toBeNull();
      expect(
        (api.get as jest.Mock).mock.calls.filter((c) => c[0] === "/api/me/listening-stats").length
      ).toBeGreaterThan(statsCallsBefore);
    } finally {
      jest.useRealTimers();
    }
  });

  it("shows no sync caption when online and fully synced", async () => {
    await renderStats();
    await screen.findByText("Minutes Listening (last 7 days)");

    expect(hasAnyPendingSyncs).toHaveBeenCalled(); // checked on focus
    expect(
      screen.queryByText(
        "You're offline — recent listening will be added to these stats once you reconnect."
      )
    ).toBeNull();
    expect(
      screen.queryByText("Some recent listening is still syncing and may not be reflected yet.")
    ).toBeNull();
  });

  it("groups stat tiles and exposes a chart summary for TalkBack", async () => {
    await renderStats();
    await screen.findByText("Recent Sessions");

    // Totals read as one item each instead of value + label as two nodes.
    expect(screen.getByLabelText("2 Items Finished")).toBeTruthy();
    expect(screen.getByLabelText("36 minutes", { exact: false })).toBeTruthy();

    // The View-drawn chart exposes its 7-day series as spoken text.
    const chart = screen.getByLabelText(/Minutes listening over the last 7 days/);
    expect(chart.props.accessibilityRole).toBe("image");

    // Recent-session rows collapse title + time + duration into one label.
    expect(screen.getByLabelText("Latest Listen, 2h ago, 61 min")).toBeTruthy();
  });

  it("back button goes back", async () => {
    const navigation = await renderStats();
    await screen.findByText("Recent Sessions");

    await fireEvent.press(screen.getByLabelText("Go back"));
    expect(navigation.goBack).toHaveBeenCalled();
  });

  it("surfaces the streak prominently as a banner", async () => {
    await renderStats();
    await screen.findByText("Recent Sessions");

    // Streak is 3 (today + DST day + 2 days ago) — shown as a headline banner.
    expect(screen.getByText("3-day streak")).toBeTruthy();
    expect(
      screen.getByLabelText("Current streak: 3 days in a row")
    ).toBeTruthy();
  });

  it("navigates to the Year in Review with the current year", async () => {
    const navigation = await renderStats();
    await screen.findByText("Your Year in Audio");

    // Faked clock is Nov 2025 -> year 2025.
    await fireEvent.press(screen.getByLabelText("Your 2025 in Audio"));
    expect(navigation.navigate).toHaveBeenCalledWith("YearInReview", { year: 2025 });
  });

  it("shows a set-a-goal affordance, then persists the goal and shows progress", async () => {
    await renderStats();
    await screen.findByText("Recent Sessions");

    // No goal yet -> affordance visible, no goal persisted.
    expect(screen.getByLabelText("Set a listening goal")).toBeTruthy();
    expect(storage.getNumber("listeningGoalMinutes")).toBeUndefined();

    await fireEvent.press(screen.getByLabelText("Set a listening goal"));
    // Default draft is 30 minutes / daily.
    await fireEvent.press(screen.getByLabelText("Save goal"));

    // Persisted to MMKV under the owned keys.
    expect(storage.getNumber("listeningGoalMinutes")).toBe(30);
    expect(storage.getString("listeningGoalPeriod")).toBe("daily");

    // Progress computed from today's minutes (600s -> 10 min) vs the 30 goal.
    expect(screen.getByText("Daily goal")).toBeTruthy();
    expect(screen.getByText("10 / 30 min")).toBeTruthy();
  });

  it("loads a persisted weekly goal and computes progress from the payload", async () => {
    storage.set("listeningGoalMinutes", 40);
    storage.set("listeningGoalPeriod", "weekly");

    await renderStats();
    await screen.findByText("Recent Sessions");

    // weekMinutes = 36 (10+20+5+1) vs a 40-minute weekly goal.
    expect(screen.getByText("Weekly goal")).toBeTruthy();
    expect(screen.getByText("36 / 40 min")).toBeTruthy();
  });

  it("marks the goal met and can remove it", async () => {
    storage.set("listeningGoalMinutes", 5);
    storage.set("listeningGoalPeriod", "daily");

    await renderStats();
    await screen.findByText("Recent Sessions");

    // today 10 min >= 5 -> met.
    expect(screen.getByText("10 / 5 min — goal met!")).toBeTruthy();

    await fireEvent.press(screen.getByLabelText("Edit listening goal"));
    await fireEvent.press(screen.getByLabelText("Remove goal"));

    expect(storage.getNumber("listeningGoalMinutes")).toBeUndefined();
    expect(screen.getByLabelText("Set a listening goal")).toBeTruthy();
  });
});
