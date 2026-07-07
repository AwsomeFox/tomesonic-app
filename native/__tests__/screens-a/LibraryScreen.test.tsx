/**
 * LibraryScreen — paged item list from the mocked items endpoint, client-side
 * hide-non-audiobooks filter, per-row Play vs Read routing, route filter param
 * in the query string, pagination fetch guard, and error/empty states.
 */
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react-native";

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
    useDerivedValue: (fn: any) => ({ value: typeof fn === "function" ? fn() : fn }),
    useAnimatedProps: () => ({}),
    useAnimatedReaction: () => {},
    useAnimatedScrollHandler: () => () => {},
    useReducedMotion: () => false,
    withTiming: (v: any) => v,
    withSpring: (v: any) => v,
    withDelay: (_d: any, v: any) => v,
    withRepeat: (v: any) => v,
    withSequence: (...vals: any[]) => vals[vals.length - 1],
    cancelAnimation: () => {},
    runOnJS: (fn: any) => fn,
    runOnUI: (fn: any) => fn,
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

import LibraryScreen from "../../screens/LibraryScreen";
import { api } from "../../utils/api";
import { useUserStore } from "../../store/useUserStore";
import { useLibraryStore } from "../../store/useLibraryStore";
import { useDownloadStore } from "../../store/useDownloadStore";
import { usePlaybackStore } from "../../store/usePlaybackStore";
import { useUiStore } from "../../store/useUiStore";
import { storage } from "../../utils/storage";

const mockedGet = api.get as jest.Mock;

const initialUser = useUserStore.getState();
const initialLibrary = useLibraryStore.getState();
const initialDownloads = useDownloadStore.getState();
const initialPlayback = usePlaybackStore.getState();
const initialUi = useUiStore.getState();

const makeNavigation = () => {
  const navigation: any = {
    navigate: jest.fn(),
    goBack: jest.fn(),
    addListener: jest.fn(() => jest.fn()),
  };
  navigation.getParent = jest.fn(() => navigation);
  return navigation;
};

const audioItem = {
  id: "b1",
  mediaType: "book",
  addedAt: new Date(2024, 0, 15, 10, 30).getTime(),
  media: {
    duration: 3600,
    numTracks: 2,
    metadata: { title: "Audio Book One", authorName: "Alice Author" },
  },
};
const ebookOnlyItem = {
  id: "e1",
  mediaType: "book",
  media: {
    ebookFile: { ebookFormat: "epub" },
    metadata: { title: "Ebook Only Book", authorName: "Eve Writer" },
  },
};
const podcastRow = {
  id: "p1",
  mediaType: "podcast",
  media: { metadata: { title: "My Podcast", authorName: "Pod Host" } },
};

function mockItemsPage(results: any[], total = results.length) {
  mockedGet.mockResolvedValue({ data: { results, total } });
}

beforeEach(() => {
  useUserStore.setState(initialUser, true);
  useLibraryStore.setState(initialLibrary, true);
  useDownloadStore.setState(initialDownloads, true);
  usePlaybackStore.setState(initialPlayback, true);
  useUiStore.setState(initialUi, true);
  storage.getAllKeys().forEach((k: string) => storage.remove(k));
  useLibraryStore.setState({ currentLibraryId: "lib1" } as any);
  useUserStore.setState({
    serverConnectionConfig: { address: "https://abs.test", token: "tok" },
  } as any);
});

describe("LibraryScreen", () => {
  it("fetches page 0 with default sort and renders rows (title/author/added line)", async () => {
    mockItemsPage([audioItem, ebookOnlyItem]);
    const navigation = makeNavigation();
    await render(<LibraryScreen route={{ params: {} }} navigation={navigation} />);

    await screen.findByText("Audio Book One");
    expect(screen.getByText("Alice Author")).toBeTruthy();
    expect(screen.getByText("Added 01/15/2024 10:30")).toBeTruthy();
    expect(screen.getByText("Ebook Only Book")).toBeTruthy();

    const url = mockedGet.mock.calls[0][0] as string;
    expect(url).toContain("/api/libraries/lib1/items?");
    expect(url).toContain("limit=25");
    expect(url).toContain("page=0");
    expect(url).toContain("sort=addedAt");
    expect(url).toContain("desc=1");
    expect(url).not.toContain("filter=");
  });

  it("honors the route filter param in the query string", async () => {
    mockItemsPage([audioItem]);
    const navigation = makeNavigation();
    await render(
      <LibraryScreen
        route={{ params: { filter: "authors.QUJD", showBack: true, title: "ABC" } }}
        navigation={navigation}
      />
    );
    await screen.findByText("Audio Book One");
    expect(mockedGet.mock.calls[0][0]).toContain("filter=authors.QUJD");
  });

  it("hideNonAudiobooksGlobal filters ebook-only rows client-side", async () => {
    useUserStore.setState({
      settings: { ...useUserStore.getState().settings, hideNonAudiobooksGlobal: true },
    } as any);
    mockItemsPage([audioItem, ebookOnlyItem]);
    const navigation = makeNavigation();
    await render(<LibraryScreen route={{ params: {} }} navigation={navigation} />);

    await screen.findByText("Audio Book One");
    expect(screen.queryByText("Ebook Only Book")).toBeNull();
  });

  it("auto-advances to the next page when a raw page filters down to nothing", async () => {
    // With hide-non-audiobooks on, a full raw page of ebook-only rows filters to
    // zero visible items — the list doesn't grow, so onEndReached never re-fires
    // and load-more would stall. The screen must chain straight to the next page.
    useUserStore.setState({
      settings: { ...useUserStore.getState().settings, hideNonAudiobooksGlobal: true },
    } as any);
    const audioTwo = {
      ...audioItem,
      id: "b2",
      media: { ...audioItem.media, metadata: { title: "Audio Book Two", authorName: "Bob" } },
    };
    mockedGet.mockImplementation((url: string) => {
      if (url.includes("page=0")) return Promise.resolve({ data: { results: [audioItem], total: 30 } });
      // Page 1 is entirely ebook-only -> filtered empty -> must auto-chain.
      if (url.includes("page=1")) return Promise.resolve({ data: { results: [ebookOnlyItem], total: 30 } });
      if (url.includes("page=2")) return Promise.resolve({ data: { results: [audioTwo], total: 30 } });
      return Promise.resolve({ data: { results: [], total: 30 } });
    });
    const navigation = makeNavigation();
    await render(<LibraryScreen route={{ params: {} }} navigation={navigation} />);
    await screen.findByText("Audio Book One");

    // One end-reached fetches page 1 (all ebook); the screen chains to page 2 on
    // its own, whose audio row appears without a second scroll gesture.
    await fireEvent(screen.getByText("Audio Book One"), "onEndReached", { distanceFromEnd: 0 });

    await waitFor(() => expect(screen.getByText("Audio Book Two")).toBeTruthy());
    expect(mockedGet.mock.calls.some((c) => String(c[0]).includes("page=2"))).toBe(true);
  });

  it("row actions: ebook-only opens the Reader, audio starts playback, podcasts get no button", async () => {
    mockItemsPage([audioItem, ebookOnlyItem, podcastRow]);
    const startPlayback = jest.fn().mockResolvedValue(true);
    usePlaybackStore.setState({ startPlayback } as any);
    const navigation = makeNavigation();
    await render(<LibraryScreen route={{ params: {} }} navigation={navigation} />);
    await screen.findByText("Audio Book One");

    await fireEvent.press(screen.getByLabelText("Read Ebook Only Book"));
    expect(navigation.navigate).toHaveBeenCalledWith("Reader", {
      itemId: "e1",
      ebookFormat: "epub",
      title: "Ebook Only Book",
    });

    await fireEvent.press(screen.getByLabelText("Play Audio Book One"));
    await waitFor(() => expect(startPlayback).toHaveBeenCalledWith("b1"));

    expect(screen.queryByLabelText("Play My Podcast")).toBeNull();
    expect(screen.queryByLabelText("Read My Podcast")).toBeNull();
  });

  it("tapping a row opens ItemDetail", async () => {
    mockItemsPage([audioItem]);
    const navigation = makeNavigation();
    await render(<LibraryScreen route={{ params: {} }} navigation={navigation} />);
    await fireEvent.press(await screen.findByText("Audio Book One"));
    expect(navigation.navigate).toHaveBeenCalledWith("ItemDetail", { itemId: "b1" });
  });

  it("paginates on end-reached but never issues a duplicate fetch while one is in flight", async () => {
    // A short first page (below initialNumToRender) so the FlatList reports
    // the end of content as reached when scrolled.
    const page0 = Array.from({ length: 10 }, (_, i) => ({
      id: `bk${i}`,
      mediaType: "book",
      media: { duration: 100, numTracks: 1, metadata: { title: `Book ${i}`, authorName: "A" } },
    }));
    let resolvePage1!: (v: any) => void;
    const page1Promise = new Promise((res) => (resolvePage1 = res));
    mockedGet.mockImplementation((url: string) => {
      if (url.includes("page=0")) return Promise.resolve({ data: { results: page0, total: 30 } });
      return page1Promise; // page 1 stays in flight until we resolve it
    });
    const navigation = makeNavigation();
    await render(<LibraryScreen route={{ params: {} }} navigation={navigation} />);
    await screen.findByText("Book 0");
    expect(mockedGet).toHaveBeenCalledTimes(1);

    const row = screen.getByText("Book 0");
    // First end-reached → page 1 fetch (kept pending).
    await fireEvent(row, "onEndReached", { distanceFromEnd: 0 });
    // Second end-reached while that fetch is in flight must be swallowed by
    // the screen's isFetching/loading guard.
    await fireEvent(row, "onEndReached", { distanceFromEnd: 0 });

    const pageOneCalls = mockedGet.mock.calls.filter((c) => String(c[0]).includes("page=1"));
    expect(pageOneCalls).toHaveLength(1);
    expect(mockedGet).toHaveBeenCalledTimes(2);

    // Let the pending page land and render its rows.
    await act(async () => {
      resolvePage1({
        data: {
          results: [
            { id: "bk10", mediaType: "book", media: { duration: 100, numTracks: 1, metadata: { title: "Book 10", authorName: "A" } } },
          ],
          total: 30,
        },
      });
    });
    await screen.findByText("Book 10");
  });

  it("shows the load-error state and recovers via Retry", async () => {
    mockedGet.mockRejectedValueOnce(new Error("network down"));
    const navigation = makeNavigation();
    await render(<LibraryScreen route={{ params: {} }} navigation={navigation} />);
    await screen.findByText("Couldn't load your library");

    mockItemsPage([audioItem]);
    await fireEvent.press(screen.getByLabelText("Retry loading library"));
    await screen.findByText("Audio Book One");
  });

  it("shows the empty state when the library has no items", async () => {
    mockItemsPage([]);
    const navigation = makeNavigation();
    await render(<LibraryScreen route={{ params: {} }} navigation={navigation} />);
    await screen.findByText("No items found");
    expect(screen.getByText("Your library is empty. Add some audiobooks to get started.")).toBeTruthy();
  });
});
