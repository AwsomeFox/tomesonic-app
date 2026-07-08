/**
 * SeriesListScreen — paged series grid with collages, lazy cover-book
 * fetching for payloads without embedded books, OrderModal sorting that
 * re-queries the server, navigation, search overlay, empty/error states.
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
import { Text } from "react-native";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react-native";
import SeriesListScreen from "../../screens/SeriesListScreen";
import { api } from "../../utils/api";
import { useUserStore } from "../../store/useUserStore";
import { useLibraryStore } from "../../store/useLibraryStore";
import { usePlaybackStore } from "../../store/usePlaybackStore";
import { useUiStore } from "../../store/useUiStore";

const initialUser = useUserStore.getState();
const initialLibrary = useLibraryStore.getState();
const initialPlayback = usePlaybackStore.getState();
const initialUi = useUiStore.getState();

const SERIES_PAGE = {
  results: [
    { id: "s1", name: "First Series", numBooks: 2, books: [{ id: "b1" }, { id: "b2" }] },
    // No embedded books -> triggers the lazy cover-book fetch.
    { id: "s2", name: "Second Series", numBooks: 5, books: [] },
  ],
  total: 2,
};

function mockSeriesGets({ page = SERIES_PAGE, fail = false }: any = {}) {
  (api.get as jest.Mock).mockImplementation((url: string) => {
    if (url.includes("/series?")) {
      return fail ? Promise.reject(new Error("down")) : Promise.resolve({ data: page });
    }
    if (url.includes("/items?filter=series.")) {
      return Promise.resolve({ data: { results: [{ id: "cover1" }] } });
    }
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

function makeNavigation() {
  const navigation: any = {
    navigate: jest.fn(),
    goBack: jest.fn(),
    addListener: jest.fn(() => jest.fn()),
  };
  navigation.getParent = jest.fn(() => navigation);
  return navigation;
}

async function renderSeriesList() {
  const navigation = makeNavigation();
  await render(<SeriesListScreen navigation={navigation} />);
  return navigation;
}

beforeEach(() => {
  useUserStore.setState(initialUser, true);
  useLibraryStore.setState(initialLibrary, true);
  usePlaybackStore.setState(initialPlayback, true);
  useUiStore.setState(initialUi, true);
  useUserStore.setState({
    serverConnectionConfig: { address: "https://abs.example.com", token: "tok" },
  } as any);
  useLibraryStore.setState({ currentLibraryId: "lib1" } as any);
  usePlaybackStore.setState({ currentSession: null } as any);
  mockSeriesGets();
});

describe("SeriesListScreen", () => {
  it("fetches page 0 sorted by name and renders series cards with counts", async () => {
    await renderSeriesList();

    expect(await screen.findByText("First Series")).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith(
      "/api/libraries/lib1/series?limit=20&page=0&minified=1&sort=name&desc=0"
    );
    expect(screen.getByLabelText("Series: First Series, 2 books")).toBeTruthy();
    expect(screen.getByLabelText("Series: Second Series, 5 books")).toBeTruthy();
    expect(screen.getByText("2 Books")).toBeTruthy();
    expect(screen.getByText("5 Books")).toBeTruthy();
  });

  it("lazily fetches cover books for series without embedded books", async () => {
    await renderSeriesList();
    await screen.findByText("Second Series");

    // "s2" -> base64 "czI=" -> URI-encoded filter.
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith(
        "/api/libraries/lib1/items?filter=series.czI%3D&limit=4&page=0&minified=1"
      )
    );
  });

  it("card tap opens the series detail", async () => {
    const navigation = await renderSeriesList();
    await screen.findByText("First Series");

    await fireEvent.press(screen.getByLabelText("Series: First Series, 2 books"));
    expect(navigation.navigate).toHaveBeenCalledWith("SeriesDetail", {
      seriesId: "s1",
      seriesName: "First Series",
    });
  });

  it("sorting through the OrderModal re-queries the server", async () => {
    await renderSeriesList();
    await screen.findByText("First Series");

    await fireEvent.press(screen.getByLabelText("Sort"));
    await fireEvent.press(screen.getByText("Added At"));

    // addedAt defaults to descending.
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith(
        "/api/libraries/lib1/series?limit=20&page=0&minified=1&sort=addedAt&desc=1"
      )
    );
  });

  it("persists the chosen sort to user settings", async () => {
    const updateSpy = jest.fn().mockResolvedValue(undefined);
    useUserStore.setState({ updateUserSettings: updateSpy } as any);

    await renderSeriesList();
    await screen.findByText("First Series");

    await fireEvent.press(screen.getByLabelText("Sort"));
    await fireEvent.press(screen.getByText("Added At"));

    await waitFor(() =>
      expect(updateSpy).toHaveBeenCalledWith({
        mobileSeriesOrderBy: "addedAt",
        mobileSeriesOrderDesc: true,
      })
    );
  });

  it("restores the persisted sort on mount and queries the server with it", async () => {
    // A previous session saved a duration-descending sort.
    useUserStore.setState({
      settings: {
        ...useUserStore.getState().settings,
        mobileSeriesOrderBy: "totalDuration",
        mobileSeriesOrderDesc: true,
      },
    } as any);

    await renderSeriesList();
    await screen.findByText("First Series");

    // The very first fetch already uses the restored sort — no OrderModal touch.
    expect(api.get).toHaveBeenCalledWith(
      "/api/libraries/lib1/series?limit=20&page=0&minified=1&sort=totalDuration&desc=1"
    );
  });

  it("swaps to the search overlay when search is active", async () => {
    await renderSeriesList();
    await screen.findByText("First Series");

    await act(async () => {
      useUiStore.setState({ isSearchActive: true });
    });

    expect(screen.queryByText("First Series")).toBeNull();
    expect(screen.getByPlaceholderText("Search library...")).toBeTruthy();
  });

  it("shows the empty state when the library has no series", async () => {
    mockSeriesGets({ page: { results: [], total: 0 } });
    await renderSeriesList();

    expect(await screen.findByText("No series found")).toBeTruthy();
  });

  it("shows the error state and retries", async () => {
    mockSeriesGets({ fail: true });
    await renderSeriesList();

    expect(await screen.findByText("Couldn't load series")).toBeTruthy();

    mockSeriesGets();
    await fireEvent.press(screen.getByLabelText("Retry"));

    expect(await screen.findByText("First Series")).toBeTruthy();
  });

  it("renders the hub list header and exposes scrollToTop when embedded", async () => {
    const ref = React.createRef<any>();
    const navigation = makeNavigation();
    await render(
      <SeriesListScreen
        ref={ref}
        navigation={navigation}
        embedded
        listHeader={<Text>HUB_PILLS</Text>}
      />
    );
    expect(await screen.findByText("First Series")).toBeTruthy();
    expect(screen.getByText("HUB_PILLS")).toBeTruthy();
    expect(typeof ref.current.scrollToTop).toBe("function");
    expect(typeof ref.current.openSort).toBe("function");
  });
});
