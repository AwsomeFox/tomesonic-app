/**
 * LatestEpisodesScreen — recent podcast episodes for the current library,
 * episode play routing with episodeId, row navigation, no-library / empty /
 * error states.
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
import { render, screen, fireEvent } from "@testing-library/react-native";
import LatestEpisodesScreen from "../../screens/LatestEpisodesScreen";
import { api } from "../../utils/api";
import { useUserStore } from "../../store/useUserStore";
import { useLibraryStore } from "../../store/useLibraryStore";
import { usePlaybackStore } from "../../store/usePlaybackStore";

const initialUser = useUserStore.getState();
const initialLibrary = useLibraryStore.getState();
const initialPlayback = usePlaybackStore.getState();

const EPISODES = [
  {
    id: "ep1",
    libraryItemId: "li1",
    title: "Fresh Episode",
    pubDate: "2026-06-01T08:00:00.000Z",
    duration: 5400, // 1h 30m
    podcast: { metadata: { title: "Great Show" } },
  },
  {
    id: "ep2",
    libraryItemId: "li2",
    title: "Short Episode",
    duration: 900, // 15m
  },
];

let startPlayback: jest.Mock;

function makeNavigation() {
  const navigation: any = {
    navigate: jest.fn(),
    goBack: jest.fn(),
    addListener: jest.fn(() => jest.fn()),
  };
  navigation.getParent = jest.fn(() => navigation);
  return navigation;
}

async function renderEpisodes() {
  const navigation = makeNavigation();
  await render(<LatestEpisodesScreen navigation={navigation} />);
  return navigation;
}

beforeEach(() => {
  useUserStore.setState(initialUser, true);
  useLibraryStore.setState(initialLibrary, true);
  usePlaybackStore.setState(initialPlayback, true);
  useUserStore.setState({
    serverConnectionConfig: { address: "https://abs.example.com", token: "tok" },
  } as any);
  useLibraryStore.setState({ currentLibraryId: "lib1" } as any);
  startPlayback = jest.fn().mockResolvedValue(true);
  usePlaybackStore.setState({ startPlayback, currentSession: null } as any);
  (api.get as jest.Mock).mockResolvedValue({ data: { episodes: EPISODES } });
});

describe("LatestEpisodesScreen", () => {
  it("fetches recent episodes and renders podcast name, title, date and duration", async () => {
    await renderEpisodes();

    expect(await screen.findByText("Fresh Episode")).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith("/api/libraries/lib1/recent-episodes?limit=25");
    expect(screen.getByText("2 Recent Episodes")).toBeTruthy();
    expect(screen.getByText("Great Show")).toBeTruthy();
    expect(screen.getByText("Jun 1, 2026")).toBeTruthy();
    expect(screen.getByText("1h 30m")).toBeTruthy();
    expect(screen.getByText("15m")).toBeTruthy();
  });

  it("episode play button starts playback with the episode id", async () => {
    await renderEpisodes();
    await screen.findByText("Fresh Episode");

    await fireEvent.press(screen.getByLabelText("Play Fresh Episode"));
    expect(startPlayback).toHaveBeenCalledWith("li1", "ep1");
  });

  it("row tap opens the podcast's item detail", async () => {
    const navigation = await renderEpisodes();
    await screen.findByText("Fresh Episode");

    await fireEvent.press(screen.getByText("Fresh Episode"));
    expect(navigation.navigate).toHaveBeenCalledWith("ItemDetail", { itemId: "li1" });
  });

  it("errors when no library is selected (no fetch)", async () => {
    useLibraryStore.setState({ currentLibraryId: null } as any);
    await renderEpisodes();

    expect(await screen.findByText("No library selected.")).toBeTruthy();
    expect(api.get).not.toHaveBeenCalled();
  });

  it("shows the empty state when there are no recent episodes", async () => {
    (api.get as jest.Mock).mockResolvedValue({ data: { episodes: [] } });
    await renderEpisodes();

    expect(await screen.findByText("No recent episodes")).toBeTruthy();
  });

  it("shows the error state when the fetch fails", async () => {
    (api.get as jest.Mock).mockRejectedValue(new Error("down"));
    await renderEpisodes();

    expect(await screen.findByText("Failed to load episodes.")).toBeTruthy();
  });

  it("back button goes back", async () => {
    const navigation = await renderEpisodes();
    await screen.findByText("Fresh Episode");

    await fireEvent.press(screen.getByLabelText("Go back"));
    expect(navigation.goBack).toHaveBeenCalled();
  });
});
