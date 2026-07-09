/**
 * YearInReviewScreen — maps the /api/me/stats/year/{year} payload into the
 * "Your Year in Audio" summary (hours, totals, highlights, cover collage),
 * defends the year param, shares a text summary, and routes loading / empty /
 * offline states through the shared EmptyState / ErrorState.
 */
jest.mock("react-native-safe-area-context", () =>
  require("react-native-safe-area-context/jest/mock").default
);
jest.mock("react-native-reanimated", () => {
  const RN = require("react-native");
  const chainable = () => {
    const o: any = {};
    ["delay", "duration", "springify", "damping", "stiffness", "mass",
     "easing", "build", "withInitialValues", "randomDelay", "reduceMotion",
     "withCallback"].forEach((k) => (o[k] = () => o));
    return o;
  };
  const id = (v: any) => v;
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
    Extrapolation: { CLAMP: "clamp" },
    Extrapolate: { CLAMP: "clamp" },
    runOnJS: (fn: any) => fn, runOnUI: (fn: any) => fn,
    Easing: { linear: id, ease: id, inOut: (f: any) => f, out: (f: any) => f, in: (f: any) => f, bezier: () => ({ factory: () => id }) },
    FadeIn: chainable(), FadeOut: chainable(), FadeInDown: chainable(),
    LinearTransition: chainable(),
    ReduceMotion: { System: "system", Always: "always", Never: "never" },
  };
});
jest.mock("../../utils/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock("../../hooks/useNetworkStatus", () => {
  const useNetworkStatus = jest.fn(() => ({ isConnected: true, isInternetReachable: true }));
  return { useNetworkStatus, default: useNetworkStatus };
});

import React from "react";
import { Share } from "react-native";
import { render, screen, fireEvent } from "@testing-library/react-native";
import YearInReviewScreen from "../../screens/YearInReviewScreen";
import { api } from "../../utils/api";
import { useNetworkStatus } from "../../hooks/useNetworkStatus";
import { useUserStore } from "../../store/useUserStore";
import { usePlaybackStore } from "../../store/usePlaybackStore";

const mockedNet = useNetworkStatus as jest.Mock;
const initialUser = useUserStore.getState();
const initialPlayback = usePlaybackStore.getState();

function makeNavigation() {
  return { navigate: jest.fn(), goBack: jest.fn(), addListener: jest.fn(() => jest.fn()) } as any;
}

async function renderYear(params: any = { year: 2025 }) {
  const navigation = makeNavigation();
  await render(<YearInReviewScreen navigation={navigation} route={{ params }} />);
  return navigation;
}

const YEAR_FIXTURE = {
  numBooksFinished: 12,
  totalListeningTime: 3600 * 90 + 1800, // 90 hr 30 min
  totalListeningSessions: 240,
  numBooksListened: 20,
  mostListenedNarrator: { name: "Ray Porter" },
  topGenres: [{ genre: "Science Fiction" }, "Fantasy"],
  topAuthors: [{ name: "Andy Weir" }, { name: "Brandon Sanderson" }],
  mostListenedMonth: 6, // July (0-based)
  finishedBooksWithCovers: ["li_a", "li_b", "li_c"],
  booksWithCovers: ["li_a", "li_b", "li_c", "li_d"],
};

beforeEach(() => {
  mockedNet.mockReturnValue({ isConnected: true, isInternetReachable: true });
  useUserStore.setState(initialUser, true);
  usePlaybackStore.setState(initialPlayback, true);
  usePlaybackStore.setState({ currentSession: null } as any);
  useUserStore.setState({
    serverConnectionConfig: { address: "https://abs.test", token: "tok" },
  } as any);
  (api.get as jest.Mock).mockResolvedValue({ data: YEAR_FIXTURE });
});

describe("YearInReviewScreen", () => {
  it("fetches the requested year and maps the summary fields", async () => {
    await renderYear({ year: 2025 });

    expect(await screen.findByText("Highlights")).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith("/api/me/stats/year/2025");

    // Header + hero.
    expect(screen.getByText("2025 in Audio")).toBeTruthy();
    expect(screen.getByText("90")).toBeTruthy(); // total hours
    expect(screen.getByText("90 hr 30 min")).toBeTruthy();

    // Totals.
    expect(screen.getByLabelText("12 Books Finished")).toBeTruthy();
    expect(screen.getByLabelText("240 Sessions")).toBeTruthy();
    expect(screen.getByLabelText("20 Books Started")).toBeTruthy();

    // Highlights — objects and index-based month normalize to labels.
    expect(screen.getByText("July")).toBeTruthy();
    expect(screen.getByText("Ray Porter")).toBeTruthy();
    expect(screen.getByText("Andy Weir, Brandon Sanderson")).toBeTruthy();
    expect(screen.getByText("Science Fiction, Fantasy")).toBeTruthy();

    // Cover collage — the group header conveys meaning, and the identical
    // cover tiles are hidden from TalkBack rather than read as N generic
    // "Book cover" stops.
    expect(screen.getByText("Books You Finished")).toBeTruthy();
    expect(screen.queryAllByLabelText("Book cover").length).toBe(0);
  });

  it("shares a text summary of the year", async () => {
    const shareSpy = jest
      .spyOn(Share, "share")
      .mockResolvedValue({ action: "sharedAction" } as any);
    try {
      await renderYear({ year: 2025 });
      await screen.findByText("Highlights");

      await fireEvent.press(screen.getByLabelText("Share your year in audio"));
      expect(shareSpy).toHaveBeenCalledTimes(1);
      const msg = shareSpy.mock.calls[0][0].message as string;
      expect(msg).toContain("My 2025 in Audio");
      expect(msg).toContain("90 hours listened");
      expect(msg).toContain("12 books finished");
      expect(msg).toContain("Top author: Andy Weir");
    } finally {
      shareSpy.mockRestore();
    }
  });

  it("shows minutes (not '0 hours') when the year's total is under an hour", async () => {
    (api.get as jest.Mock).mockResolvedValue({
      data: {
        numBooksFinished: 0,
        totalListeningTime: 45 * 60, // 45 minutes -> would floor to 0 hours
        totalListeningSessions: 3,
        numBooksListened: 1,
        topAuthors: [],
        topGenres: [],
        finishedBooksWithCovers: [],
      },
    });
    await renderYear({ year: 2025 });
    await screen.findByText("Books Finished");

    // Hero surfaces the minutes rather than a demoralizing "0 hours".
    expect(screen.getByText("minutes listened")).toBeTruthy();
    expect(screen.getByText("45")).toBeTruthy();
    expect(screen.queryByText("hours listened")).toBeNull();

    // Share text mirrors the hero.
    const shareSpy = jest
      .spyOn(Share, "share")
      .mockResolvedValue({ action: "sharedAction" } as any);
    try {
      await fireEvent.press(screen.getByLabelText("Share your year in audio"));
      const msg = shareSpy.mock.calls[0][0].message as string;
      expect(msg).toContain("45 minutes listened");
      expect(msg).not.toContain("0 hours listened");
    } finally {
      shareSpy.mockRestore();
    }
  });

  it("uses the singular 'hour' when the total is exactly one hour", async () => {
    (api.get as jest.Mock).mockResolvedValue({
      data: {
        numBooksFinished: 1,
        totalListeningTime: 3600, // exactly 1 hour -> "1 hour", not "1 hours"
        totalListeningSessions: 2,
        numBooksListened: 1,
        topAuthors: [],
        topGenres: [],
        finishedBooksWithCovers: [],
      },
    });
    await renderYear({ year: 2025 });
    await screen.findByText("Books Finished");

    expect(screen.getByText("hour listened")).toBeTruthy();
    expect(screen.queryByText("hours listened")).toBeNull();

    const shareSpy = jest
      .spyOn(Share, "share")
      .mockResolvedValue({ action: "sharedAction" } as any);
    try {
      await fireEvent.press(screen.getByLabelText("Share your year in audio"));
      const msg = shareSpy.mock.calls[0][0].message as string;
      expect(msg).toContain("1 hour listened");
      expect(msg).not.toContain("1 hours listened");
    } finally {
      shareSpy.mockRestore();
    }
  });

  it("shows an empty state when there was no listening that year", async () => {
    (api.get as jest.Mock).mockResolvedValue({
      data: {
        numBooksFinished: 0,
        totalListeningTime: 0,
        totalListeningSessions: 0,
        numBooksListened: 0,
        topAuthors: [],
        topGenres: [],
        finishedBooksWithCovers: [],
      },
    });
    await renderYear({ year: 2025 });

    expect(await screen.findByText("No listening in 2025 yet")).toBeTruthy();
    // No share affordance when there's nothing to share.
    expect(screen.queryByLabelText("Share your year in audio")).toBeNull();
  });

  it("shows an offline error state when the fetch fails while disconnected", async () => {
    mockedNet.mockReturnValue({ isConnected: false, isInternetReachable: false });
    (api.get as jest.Mock).mockRejectedValueOnce(new Error("network down"));
    await renderYear({ year: 2025 });

    expect(await screen.findByText("You're offline")).toBeTruthy();
    expect(screen.getByText("Reconnect to see your Year in Audio.")).toBeTruthy();
  });

  it("retries after a failure", async () => {
    (api.get as jest.Mock).mockRejectedValueOnce(new Error("boom"));
    await renderYear({ year: 2025 });

    expect(await screen.findByText("boom")).toBeTruthy();
    await fireEvent.press(screen.getByText("Retry"));
    expect(await screen.findByText("Highlights")).toBeTruthy();
  });

  it("defends a garbage year param by falling back to a real year", async () => {
    await renderYear({ year: "not-a-year" });
    await screen.findByText("Highlights");

    // Falls back to a clamped numeric year, never NaN.
    const call = (api.get as jest.Mock).mock.calls[0][0] as string;
    const match = call.match(/\/api\/me\/stats\/year\/(\d+)$/);
    expect(match).not.toBeNull();
    const y = Number(match![1]);
    expect(y).toBeGreaterThanOrEqual(1970);
    expect(y).toBeLessThanOrEqual(3000);
  });

  it("goes back from the header", async () => {
    const navigation = await renderYear({ year: 2025 });
    await screen.findByText("Highlights");

    await fireEvent.press(screen.getByLabelText("Go back"));
    expect(navigation.goBack).toHaveBeenCalled();
  });
});
