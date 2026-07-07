/**
 * ListeningHistoryScreen — sessions list from /api/me/listening-sessions with
 * time-listened formatting, per-session date resolution, navigation, empty
 * and error states.
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

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react-native";
import ListeningHistoryScreen from "../../screens/ListeningHistoryScreen";
import { api } from "../../utils/api";
import { storageHelper, secureStorage } from "../../utils/storage";

const SESSIONS = [
  {
    id: "s1",
    libraryItemId: "li1",
    displayTitle: "Big Audiobook",
    displayAuthor: "Author One",
    timeListening: 4000, // 1h 6m
    updatedAt: Date.UTC(2026, 0, 15, 12, 0, 0),
  },
  {
    id: "s2",
    displayTitle: "Tiny Session",
    timeListening: 40, // sub-minute must read "40s", never "0m"
    date: "2026-01-05",
  },
  {
    id: "s3",
    libraryItemId: "li3",
    displayTitle: "Minutes Session",
    timeListening: 150, // 2m
    startedAt: Date.UTC(2026, 0, 10, 8, 0, 0),
  },
];

function makeNavigation() {
  const navigation: any = {
    navigate: jest.fn(),
    goBack: jest.fn(),
    addListener: jest.fn(() => jest.fn()),
  };
  navigation.getParent = jest.fn(() => navigation);
  return navigation;
}

async function renderHistory() {
  const navigation = makeNavigation();
  await render(<ListeningHistoryScreen navigation={navigation} />);
  return navigation;
}

beforeEach(() => {
  storageHelper.setServerConfig({ address: "https://abs.example.com", token: "tok" });
  (api.get as jest.Mock).mockResolvedValue({ data: { sessions: SESSIONS } });
});

afterEach(() => {
  secureStorage.remove("serverConfig");
});

describe("ListeningHistoryScreen", () => {
  it("fetches the first sessions page and renders rows with formatted listen times", async () => {
    await renderHistory();

    expect(await screen.findByText("Big Audiobook")).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith("/api/me/listening-sessions", {
      params: { itemsPerPage: 50, page: 0 },
    });
    expect(screen.getByText("Author One")).toBeTruthy();
    // 4000s -> "1h 6m"; 40s stays seconds; 150s -> minutes.
    expect(screen.getByText(/1h 6m listened/)).toBeTruthy();
    expect(screen.getByText(/40s listened/)).toBeTruthy();
    expect(screen.getByText(/2m listened/)).toBeTruthy();
    // Dates resolve from updatedAt / date / startedAt alike (month + day).
    expect(screen.getByText(/Jan 1[45]/)).toBeTruthy();
  });

  it("pages on end-reached, dedupes rows straddling a shifted page boundary, and stops at numPages", async () => {
    const makeSession = (i: number) => ({
      id: `s${i}`,
      libraryItemId: `li${i}`,
      displayTitle: `Session ${i}`,
      timeListening: 120,
      updatedAt: Date.UTC(2026, 0, 15, 12, 0, 0),
    });
    // Short pages with a server-provided numPages: hasMore is driven by the
    // page count, and everything stays inside the virtualized render window.
    const page0 = [makeSession(0), makeSession(1), makeSession(2)];
    // New sessions accrue while the user scrolls, shifting page boundaries —
    // page 1 re-serves s2 and must not double it in the list.
    const page1 = [makeSession(2), makeSession(3), makeSession(4)];
    (api.get as jest.Mock).mockImplementation((_url: string, cfg: any) =>
      Promise.resolve({
        data: { sessions: cfg?.params?.page === 0 ? page0 : page1, numPages: 2 },
      })
    );
    await renderHistory();
    const row = await screen.findByText("Session 0");

    await fireEvent(row, "onEndReached", { distanceFromEnd: 0 });
    expect(api.get).toHaveBeenLastCalledWith("/api/me/listening-sessions", {
      params: { itemsPerPage: 50, page: 1 },
    });
    expect(await screen.findByText("Session 4")).toBeTruthy();
    // s2 re-served by page 1 was deduped, not doubled.
    expect(screen.getAllByText("Session 2")).toHaveLength(1);

    // numPages exhausted — a further end-reached must not fetch page 2.
    (api.get as jest.Mock).mockClear();
    await fireEvent(row, "onEndReached", { distanceFromEnd: 0 });
    expect(api.get).not.toHaveBeenCalled();
  });

  it("row tap opens the item detail when the session has a library item", async () => {
    const navigation = await renderHistory();
    await screen.findByText("Big Audiobook");

    await fireEvent.press(screen.getByText("Big Audiobook"));
    expect(navigation.navigate).toHaveBeenCalledWith("ItemDetail", { itemId: "li1" });

    // Sessions without a libraryItemId are inert.
    navigation.navigate.mockClear();
    await fireEvent.press(screen.getByText("Tiny Session"));
    expect(navigation.navigate).not.toHaveBeenCalled();
  });

  it("shows the empty state when there is no history", async () => {
    (api.get as jest.Mock).mockResolvedValue({ data: { sessions: [] } });
    await renderHistory();

    expect(await screen.findByText("No listening history yet")).toBeTruthy();
  });

  it("tolerates a malformed payload (sessions not an array)", async () => {
    (api.get as jest.Mock).mockResolvedValue({ data: { sessions: null } });
    await renderHistory();

    expect(await screen.findByText("No listening history yet")).toBeTruthy();
  });

  it("shows the error state when the fetch fails", async () => {
    (api.get as jest.Mock).mockRejectedValue(new Error("down"));
    await renderHistory();

    expect(await screen.findByText("Failed to load listening history.")).toBeTruthy();
  });

  it("back button goes back", async () => {
    const navigation = await renderHistory();
    await screen.findByText("Big Audiobook");

    await fireEvent.press(screen.getByLabelText("Go back"));
    expect(navigation.goBack).toHaveBeenCalled();
  });
});
