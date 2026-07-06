/**
 * SearchScreen — debounced query → library search fetch, sectioned results
 * (books/series/authors/narrators/tags), navigation with base64-encoded
 * filter values for tags/narrators, clear/no-result/idle states, the
 * failed-request error state with retry, and the hide-non-audiobooks filter
 * on book results.
 */
import { render, screen, fireEvent, act } from "@testing-library/react-native";

jest.mock("react-native-safe-area-context", () => {
  const React = require("react");
  const { View } = require("react-native");
  const insets = { top: 0, right: 0, bottom: 0, left: 0 };
  const frame = { x: 0, y: 0, width: 320, height: 640 };
  return {
    SafeAreaProvider: ({ children }: any) => children,
    SafeAreaView: ({ children, edges, ...props }: any) => React.createElement(View, props, children),
    useSafeAreaInsets: () => insets,
    useSafeAreaFrame: () => frame,
    initialWindowMetrics: { frame, insets },
  };
});

// Self-contained reanimated mock — the setup-level one delegates to the
// library mock, which needs worklets' native bindings and throws under jest.
jest.mock("react-native-reanimated", () => {
  const React = require("react");
  const RN = require("react-native");
  const chain: any = {};
  ["duration", "delay", "springify", "damping", "stiffness", "easing", "reduceMotion"].forEach((k) => {
    chain[k] = () => chain;
  });
  const passthrough = (Component: any) =>
    React.forwardRef(({ entering, exiting, layout, ...props }: any, ref: any) =>
      React.createElement(Component, { ...props, ref })
    );
  const Animated = {
    View: passthrough(RN.View),
    Text: passthrough(RN.Text),
    Image: passthrough(RN.Image),
    ScrollView: passthrough(RN.ScrollView),
    FlatList: passthrough(RN.FlatList),
    createAnimatedComponent: (C: any) => passthrough(C),
  };
  return {
    __esModule: true,
    default: Animated,
    ...Animated,
    FadeIn: chain,
    FadeOut: chain,
    FadeInDown: chain,
    FadeInUp: chain,
    FadeInRight: chain,
    LinearTransition: chain,
    Easing: {
      bezier: () => ({ factory: () => (t: number) => t }),
      out: (f: any) => f,
      in: (f: any) => f,
      inOut: (f: any) => f,
      cubic: (t: number) => t,
      linear: (t: number) => t,
      ease: (t: number) => t,
    },
    useSharedValue: (v: any) => ({ value: v }),
    useAnimatedStyle: () => ({}),
    useReducedMotion: () => false,
    withTiming: (v: any) => v,
    withSpring: (v: any) => v,
    withRepeat: (v: any) => v,
    withSequence: (...vals: any[]) => vals[vals.length - 1],
    withDelay: (_d: any, v: any) => v,
    cancelAnimation: () => {},
    runOnJS: (fn: any) => fn,
    interpolate: () => 0,
    interpolateColor: () => "#000000",
    Extrapolation: { CLAMP: "clamp", EXTEND: "extend" },
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
}));

import SearchScreen from "../../screens/SearchScreen";
import { api } from "../../utils/api";
import { useUserStore } from "../../store/useUserStore";
import { useLibraryStore } from "../../store/useLibraryStore";
import { usePlaybackStore } from "../../store/usePlaybackStore";
import { encodeFilterValue } from "../../components/FilterModal";

const mockedGet = api.get as jest.Mock;

const initialUser = useUserStore.getState();
const initialLibrary = useLibraryStore.getState();
const initialPlayback = usePlaybackStore.getState();

const makeNavigation = () => {
  const navigation: any = {
    navigate: jest.fn(),
    goBack: jest.fn(),
    addListener: jest.fn(() => jest.fn()),
  };
  navigation.getParent = jest.fn(() => navigation);
  return navigation;
};

const fullResults = {
  book: [
    {
      libraryItem: {
        id: "b1",
        mediaType: "book",
        media: { duration: 100, numTracks: 1, metadata: { title: "Dune", authorName: "Frank Herbert" } },
      },
    },
  ],
  podcast: [],
  series: [
    {
      series: { id: "ser1", name: "Dune Saga" },
      books: [{ id: "b1" }, { id: "b2" }],
    },
  ],
  authors: [{ author: { id: "auth1", name: "Frank Herbert", numBooks: 6 } }],
  narrators: [{ name: "Scott Brick", numBooks: 4 }],
  tags: ["scifi"],
};

/** Type a query and advance past the 500ms debounce. */
async function search(text: string) {
  await fireEvent.changeText(screen.getByPlaceholderText("Search"), text);
  await act(async () => {
    jest.advanceTimersByTime(500);
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  useUserStore.setState(initialUser, true);
  useLibraryStore.setState(initialLibrary, true);
  usePlaybackStore.setState(initialPlayback, true);
  useLibraryStore.setState({ currentLibraryId: "lib1" } as any);
  useUserStore.setState({
    serverConnectionConfig: { address: "https://abs.test", token: "tok" },
  } as any);
  mockedGet.mockResolvedValue({ data: fullResults });
});

afterEach(() => {
  jest.useRealTimers();
});

describe("SearchScreen", () => {
  it("debounces input: only the latest query fires a single fetch after 500ms", async () => {
    const navigation = makeNavigation();
    await render(<SearchScreen navigation={navigation} />);
    expect(screen.getByText("Search your library")).toBeTruthy();

    const input = screen.getByPlaceholderText("Search");
    await fireEvent.changeText(input, "du");
    await fireEvent.changeText(input, "dune");
    await act(async () => {
      jest.advanceTimersByTime(400); // still inside the debounce window
    });
    expect(mockedGet).not.toHaveBeenCalled();

    await act(async () => {
      jest.advanceTimersByTime(200); // 600ms after the LAST keystroke's reset
    });
    expect(mockedGet).toHaveBeenCalledTimes(1);
    expect(mockedGet.mock.calls[0][0]).toBe("/api/libraries/lib1/search?q=dune&limit=5");
  });

  it("renders all result sections", async () => {
    const navigation = makeNavigation();
    await render(<SearchScreen navigation={navigation} />);
    await search("dune");

    expect(screen.getByText("Books")).toBeTruthy();
    expect(screen.getByText("Dune")).toBeTruthy();
    expect(screen.getByText("by Frank Herbert")).toBeTruthy();
    expect(screen.getByText("Series")).toBeTruthy();
    expect(screen.getByText("Dune Saga")).toBeTruthy();
    expect(screen.getByText("2 Books")).toBeTruthy();
    expect(screen.getByText("Authors")).toBeTruthy();
    expect(screen.getByText("6 Books")).toBeTruthy();
    expect(screen.getByText("Narrators")).toBeTruthy();
    expect(screen.getByText("Scott Brick")).toBeTruthy();
    expect(screen.getByText("Tags")).toBeTruthy();
    expect(screen.getByText("scifi")).toBeTruthy();
  });

  it("navigates from each section — base64-encoded filters for tags and narrators", async () => {
    const navigation = makeNavigation();
    await render(<SearchScreen navigation={navigation} />);
    await search("dune");

    await fireEvent.press(screen.getByText("Dune"));
    expect(navigation.navigate).toHaveBeenCalledWith("ItemDetail", { itemId: "b1" });

    await fireEvent.press(screen.getByText("Dune Saga"));
    expect(navigation.navigate).toHaveBeenCalledWith("SeriesDetail", { seriesId: "ser1" });

    await fireEvent.press(screen.getByText("Frank Herbert"));
    expect(navigation.navigate).toHaveBeenCalledWith("AuthorDetail", {
      authorId: "auth1",
      authorName: "Frank Herbert",
    });

    await fireEvent.press(screen.getByText("Scott Brick"));
    expect(navigation.navigate).toHaveBeenCalledWith("Library", {
      filter: `narrators.${encodeFilterValue("Scott Brick")}`,
      title: "Scott Brick",
      showBack: true,
    });

    await fireEvent.press(screen.getByText("scifi"));
    expect(navigation.navigate).toHaveBeenCalledWith("Library", {
      filter: `tags.${encodeFilterValue("scifi")}`,
      title: "scifi",
      showBack: true,
    });
  });

  it("shows the no-results state and resets via the clear button", async () => {
    mockedGet.mockResolvedValue({
      data: { book: [], podcast: [], series: [], authors: [], narrators: [], tags: [] },
    });
    const navigation = makeNavigation();
    await render(<SearchScreen navigation={navigation} />);
    await search("zzz");

    expect(screen.getByText("No results for “zzz”")).toBeTruthy();

    await fireEvent.press(screen.getByLabelText("Clear search"));
    expect(screen.getByText("Search your library")).toBeTruthy();
  });

  it("hideNonAudiobooksGlobal drops ebook-only books from the results", async () => {
    useUserStore.setState({
      settings: { ...useUserStore.getState().settings, hideNonAudiobooksGlobal: true },
    } as any);
    mockedGet.mockResolvedValue({
      data: {
        book: [
          {
            libraryItem: {
              id: "e1",
              mediaType: "book",
              media: { ebookFile: { ebookFormat: "epub" }, metadata: { title: "Ebook Only", authorName: "E" } },
            },
          },
        ],
        podcast: [],
        series: [],
        authors: [],
        narrators: [],
        tags: [],
      },
    });
    const navigation = makeNavigation();
    await render(<SearchScreen navigation={navigation} />);
    await search("ebook");

    expect(screen.queryByText("Ebook Only")).toBeNull();
    expect(screen.getByText("No results for “ebook”")).toBeTruthy();
  });

  it("shows the failure state (not no-results) when the search request rejects", async () => {
    mockedGet.mockRejectedValueOnce(new Error("network down"));
    const navigation = makeNavigation();
    await render(<SearchScreen navigation={navigation} />);
    await search("dune");

    expect(screen.getByText("Search failed")).toBeTruthy();
    expect(screen.getByText("Check your connection and try again.")).toBeTruthy();
    // A failed request must not read as "your library doesn't have this".
    expect(screen.queryByText("No results for “dune”")).toBeNull();
  });

  it("Retry re-runs the search and clears the error once it succeeds", async () => {
    mockedGet.mockRejectedValueOnce(new Error("network down"));
    const navigation = makeNavigation();
    await render(<SearchScreen navigation={navigation} />);
    await search("dune");
    expect(screen.getByText("Search failed")).toBeTruthy();

    // beforeEach's default mock resolves with fullResults on the next call.
    await fireEvent.press(screen.getByLabelText("Retry search"));
    await act(async () => {});

    expect(mockedGet).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Search failed")).toBeNull();
    expect(screen.getByText("Dune")).toBeTruthy();
    expect(screen.getByText("Books")).toBeTruthy();
  });

  it("back button pops the screen", async () => {
    const navigation = makeNavigation();
    await render(<SearchScreen navigation={navigation} />);
    await fireEvent.press(screen.getByLabelText("Back"));
    expect(navigation.goBack).toHaveBeenCalled();
  });
});
