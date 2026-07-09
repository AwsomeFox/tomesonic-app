/**
 * BookshelfScreen — offline downloaded list (ebook rows → Reader), online
 * personalized shelves (dedupe, hide-non-audiobooks, empty state), synthetic
 * Continue Reading shelf from the batch item fetch, series/author card taps,
 * and the offline→online flush-and-refresh transition.
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

// The setup-level reanimated mock delegates to react-native-reanimated/mock,
// which now requires react-native-worklets' native bindings and throws under
// jest. Replace it file-locally with an inert, self-contained implementation.
jest.mock("react-native-reanimated", () => {
  const React = require("react");
  const RN = require("react-native");
  const chain: any = {};
  ["duration", "delay", "springify", "damping", "stiffness", "easing", "reduceMotion", "withInitialValues", "build"].forEach(
    (k) => {
      chain[k] = () => chain;
    }
  );
  const passthrough = (Component: any) => {
    const C = React.forwardRef(({ entering, exiting, layout, ...props }: any, ref: any) =>
      React.createElement(Component, { ...props, ref })
    );
    C.displayName = `Animated(${Component.displayName || Component.name || "Component"})`;
    return C;
  };
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
// Controllable connectivity per test.
jest.mock("../../hooks/useNetworkStatus", () => {
  const useNetworkStatus = jest.fn(() => ({ isConnected: true, isInternetReachable: true, isOffline: false }));
  return { useNetworkStatus, default: useNetworkStatus };
});

import BookshelfScreen from "../../screens/BookshelfScreen";
import { api } from "../../utils/api";
import { flushPendingSyncs } from "../../utils/progressSync";
import { useNetworkStatus } from "../../hooks/useNetworkStatus";
import { useUserStore } from "../../store/useUserStore";
import { useLibraryStore } from "../../store/useLibraryStore";
import { useDownloadStore } from "../../store/useDownloadStore";
import { useFavoritesStore } from "../../store/useFavoritesStore";
import { usePlaybackStore } from "../../store/usePlaybackStore";
import { useUiStore } from "../../store/useUiStore";
import { storage } from "../../utils/storage";
import { encodeFilterValue } from "../../components/FilterModal";

const mockedGet = api.get as jest.Mock;
const mockedPost = api.post as jest.Mock;
const mockedNet = useNetworkStatus as jest.Mock;

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

// --- Fixtures ---------------------------------------------------------------

const audioBook = {
  id: "b1",
  mediaType: "book",
  media: {
    coverPath: "/covers/b1.jpg",
    duration: 3600,
    numTracks: 2,
    metadata: { title: "Audio Book One", authorName: "Alice Author" },
  },
};
const ebookOnlyBook = {
  id: "e1",
  mediaType: "book",
  // Continue Reading is scoped to the SELECTED library.
  libraryId: "lib1",
  media: {
    ebookFile: { ebookFormat: "epub" },
    metadata: { title: "Ebook Only Book", authorName: "Eve Writer" },
  },
};
const authorEntity = { id: "auth1", name: "Alice Author", numBooks: 3, imagePath: "/a.jpg" };
const seriesEntity = { id: "ser1", name: "Cool Series", books: [audioBook], booksCount: 2 };

const baseShelves = [
  { id: "continue-listening", label: "Continue Listening", type: "book", entities: [audioBook] },
  { id: "recently-added", label: "Recently Added", type: "book", entities: [audioBook, ebookOnlyBook] },
  { id: "newest-authors", label: "Newest Authors", type: "authors", entities: [authorEntity] },
  { id: "recent-series", label: "Recent Series", type: "series", entities: [seriesEntity] },
];

/** Seed the library/user stores with stubbed loaders so initData resolves fast. */
function seedOnline(shelves: any[], mediaProgress: Record<string, any> = {}) {
  useLibraryStore.setState({
    currentLibraryId: "lib1",
    personalizedShelves: shelves,
    loadPersonalizedShelves: jest.fn().mockResolvedValue(undefined),
    loadLibraries: jest.fn().mockResolvedValue(true),
  } as any);
  useUserStore.setState({
    serverConnectionConfig: { address: "https://abs.test", token: "tok" },
    mediaProgress,
    loadMediaProgress: jest.fn().mockResolvedValue(undefined),
  } as any);
}

/**
 * Drive a shelf's horizontal row into an overflowing state. jsdom fires no real
 * onLayout / onContentSizeChange, so the "see all" arrow (gated on overflow)
 * never appears without simulating a viewport narrower than the content.
 */
async function simulateShelfOverflow(
  shelfId: string,
  { viewport = 400, content = 1600 }: { viewport?: number; content?: number } = {}
) {
  const row = await screen.findByTestId(`shelf-row-${shelfId}`);
  await act(async () => {
    fireEvent(row, "layout", { nativeEvent: { layout: { width: viewport, height: 200, x: 0, y: 0 } } });
    fireEvent(row, "contentSizeChange", content, 200);
  });
  return row;
}

beforeEach(() => {
  useUserStore.setState(initialUser, true);
  useLibraryStore.setState(initialLibrary, true);
  useDownloadStore.setState(initialDownloads, true);
  usePlaybackStore.setState(initialPlayback, true);
  useUiStore.setState(initialUi, true);
  useFavoritesStore.setState({ favorites: [] } as any);
  storage.getAllKeys().forEach((k: string) => storage.remove(k));
  mockedNet.mockReturnValue({ isConnected: true, isInternetReachable: true, isOffline: false });
  // Series-list revalidation fetch (parallel effect) — empty by default.
  mockedGet.mockResolvedValue({ data: { results: [] } });
  mockedPost.mockResolvedValue({ data: { libraryItems: [] } });
});

describe("BookshelfScreen offline", () => {
  const seedDownloads = () =>
    useDownloadStore.setState({
      // The empty/list rendering is gated on DB hydration having finished.
      downloadsLoaded: true,
      completedDownloads: {
        b1: {
          id: "b1",
          libraryItemId: "b1",
          title: "Audio Book One",
          author: "Alice Author",
          status: "completed",
          progress: 1,
          parts: [{ id: "cover", filename: "cover.jpg", localFilePath: "file:///dl/b1/cover.jpg" }],
          meta: { duration: 3600, chapters: [], tracks: [{ index: 1, filename: "t.mp3", duration: 3600, startOffset: 0 }] },
        },
        e1: {
          id: "e1",
          libraryItemId: "e1",
          title: "Ebook Only Book",
          author: "Eve Writer",
          status: "completed",
          progress: 1,
          parts: [{ id: "ebook", filename: "great.epub", localFilePath: "file:///dl/e1/great.epub" }],
          meta: { duration: 0, chapters: [], tracks: [] },
        },
      },
    } as any);

  it("renders the downloaded list and opens ebook-only rows in the Reader", async () => {
    mockedNet.mockReturnValue({ isConnected: false, isInternetReachable: false, isOffline: true });
    seedOnline(baseShelves);
    seedDownloads();
    const navigation = makeNavigation();
    await render(<BookshelfScreen navigation={navigation} />);

    await screen.findByText("Available Offline");
    expect(screen.getByText("Audio Book One")).toBeTruthy();
    expect(screen.getByText("Ebook Only Book")).toBeTruthy();

    await fireEvent.press(screen.getByText("Ebook Only Book"));
    expect(navigation.navigate).toHaveBeenCalledWith("Reader", {
      itemId: "e1",
      ebookFormat: "epub",
      title: "Ebook Only Book",
    });
  });

  it("starts playback for downloaded audio rows", async () => {
    mockedNet.mockReturnValue({ isConnected: false, isInternetReachable: false, isOffline: true });
    seedOnline(baseShelves);
    seedDownloads();
    const startPlayback = jest.fn().mockResolvedValue(true);
    usePlaybackStore.setState({ startPlayback } as any);
    const navigation = makeNavigation();
    await render(<BookshelfScreen navigation={navigation} />);

    await screen.findByText("Available Offline");
    await fireEvent.press(screen.getByText("Audio Book One"));
    expect(startPlayback).toHaveBeenCalledWith("b1");
  });

  it("shows the offline empty state when nothing is downloaded", async () => {
    mockedNet.mockReturnValue({ isConnected: false, isInternetReachable: false, isOffline: true });
    seedOnline(baseShelves);
    useDownloadStore.setState({ downloadsLoaded: true } as any);
    const navigation = makeNavigation();
    await render(<BookshelfScreen navigation={navigation} />);
    await screen.findByText("No downloaded books");
  });

  it("holds a blank placeholder until downloads hydrate — no premature empty state", async () => {
    mockedNet.mockReturnValue({ isConnected: false, isInternetReachable: false, isOffline: true });
    seedOnline(baseShelves);
    // downloadsLoaded stays false: the DB hydration hasn't landed yet.
    const navigation = makeNavigation();
    await render(<BookshelfScreen navigation={navigation} />);

    await screen.findByText("Available Offline");
    expect(screen.queryByText("No downloaded books")).toBeNull();

    // Hydration lands with nothing on disk — NOW the empty state may show.
    await act(async () => {
      useDownloadStore.setState({ downloadsLoaded: true } as any);
    });
    await screen.findByText("No downloaded books");
  });

  it("coming back online flushes queued syncs and refreshes the shelves", async () => {
    mockedNet.mockReturnValue({ isConnected: false, isInternetReachable: false, isOffline: true });
    seedOnline(baseShelves);
    const loadShelves = useLibraryStore.getState().loadPersonalizedShelves as jest.Mock;
    const navigation = makeNavigation();
    await render(<BookshelfScreen navigation={navigation} />);
    await screen.findByText("Available Offline");

    mockedNet.mockReturnValue({ isConnected: true, isInternetReachable: true, isOffline: false });
    await screen.rerender(<BookshelfScreen navigation={navigation} />);

    await waitFor(() => {
      expect(flushPendingSyncs).toHaveBeenCalled();
      expect(loadShelves).toHaveBeenCalledWith(true); // onRefresh force-reload
    });
  });
});

describe("BookshelfScreen online", () => {
  it("renders shelves from personalizedShelves (books, authors, series)", async () => {
    seedOnline(baseShelves);
    const navigation = makeNavigation();
    await render(<BookshelfScreen navigation={navigation} />);

    await screen.findByText("Continue Listening");
    expect(screen.getByText("Recently Added")).toBeTruthy();
    // Coverless cards render the title twice (placeholder + meta panel).
    expect(screen.getAllByText("Ebook Only Book").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByLabelText("Author: Alice Author")).toBeTruthy();
    expect(screen.getByLabelText("Series: Cool Series")).toBeTruthy();
  });

  it("shows a Latest Episodes entry point for a podcast library and navigates to it", async () => {
    seedOnline(baseShelves);
    // The current library is a podcast library — the recent-episodes screen is
    // otherwise unreachable, so an entry point must appear.
    useLibraryStore.setState({
      libraries: [{ id: "lib1", name: "Pods", mediaType: "podcast" }],
    } as any);
    const navigation = makeNavigation();
    await render(<BookshelfScreen navigation={navigation} />);

    const entry = await screen.findByLabelText("Latest Episodes");
    await fireEvent.press(entry);
    expect(navigation.navigate).toHaveBeenCalledWith("LatestEpisodes");
  });

  it("hides the Latest Episodes entry point for a non-podcast (book) library", async () => {
    seedOnline(baseShelves);
    useLibraryStore.setState({
      libraries: [{ id: "lib1", name: "Books", mediaType: "book" }],
    } as any);
    const navigation = makeNavigation();
    await render(<BookshelfScreen navigation={navigation} />);

    await screen.findByText("Continue Listening");
    expect(screen.queryByLabelText("Latest Episodes")).toBeNull();
  });

  it("book card tap navigates to ItemDetail", async () => {
    seedOnline([baseShelves[0]]);
    const navigation = makeNavigation();
    await render(<BookshelfScreen navigation={navigation} />);
    const card = await screen.findByLabelText("Audio Book One by Alice Author");
    await fireEvent.press(card);
    expect(navigation.navigate).toHaveBeenCalledWith("ItemDetail", { itemId: "b1" });
  });

  it("series and author card taps navigate to their detail screens", async () => {
    seedOnline(baseShelves);
    const navigation = makeNavigation();
    await render(<BookshelfScreen navigation={navigation} />);

    await fireEvent.press(await screen.findByLabelText("Series: Cool Series"));
    expect(navigation.navigate).toHaveBeenCalledWith("SeriesDetail", {
      seriesId: "ser1",
      seriesName: "Cool Series",
    });

    await fireEvent.press(screen.getByLabelText("Author: Alice Author"));
    expect(navigation.navigate).toHaveBeenCalledWith("AuthorDetail", {
      authorId: "auth1",
      authorName: "Alice Author",
    });
  });

  it("dedupes shelves by id — Continue Reading can never render twice", async () => {
    seedOnline([
      ...baseShelves,
      { id: "continue-reading", label: "Continue Reading", type: "book", entities: [ebookOnlyBook] },
      { id: "continue-reading", label: "Continue Reading", type: "book", entities: [ebookOnlyBook] },
    ]);
    const navigation = makeNavigation();
    await render(<BookshelfScreen navigation={navigation} />);

    await screen.findByText("Continue Listening");
    expect(screen.getAllByText("Continue Reading")).toHaveLength(1);
  });

  it("hideNonAudiobooksGlobal drops ebook-only entities and the reading shelf", async () => {
    seedOnline([
      ...baseShelves,
      { id: "continue-reading", label: "Continue Reading", type: "book", entities: [ebookOnlyBook] },
    ]);
    useUserStore.setState({
      settings: { ...useUserStore.getState().settings, hideNonAudiobooksGlobal: true },
    } as any);
    const navigation = makeNavigation();
    await render(<BookshelfScreen navigation={navigation} />);

    await screen.findByText("Continue Listening");
    expect(screen.queryByText("Continue Reading")).toBeNull();
    expect(screen.queryByText("Ebook Only Book")).toBeNull(); // filtered out of Recently Added
    expect(screen.getByText("Recently Added")).toBeTruthy(); // shelf itself survives
  });

  it("builds a synthetic Continue Reading shelf from in-progress ebooks (batch fetch)", async () => {
    seedOnline(baseShelves, {
      e1: { libraryItemId: "e1", ebookProgress: 0.4 },
      // Finished + episode progress rows must be excluded from the batch ids.
      done1: { libraryItemId: "done1", ebookProgress: 0.5, isFinished: true },
      "pod1-ep1": { libraryItemId: "pod1", episodeId: "ep1", progress: 0.3 },
    });
    mockedPost.mockResolvedValue({ data: { libraryItems: [ebookOnlyBook] } });
    const navigation = makeNavigation();
    await render(<BookshelfScreen navigation={navigation} />);

    await screen.findByText("Continue Reading");
    expect(screen.getAllByText("Ebook Only Book").length).toBeGreaterThanOrEqual(1);
    expect(mockedPost).toHaveBeenCalledWith("/api/items/batch/get", { libraryItemIds: ["e1"] });
  });

  it("shows the empty state when every shelf is empty", async () => {
    seedOnline([]);
    const navigation = makeNavigation();
    await render(<BookshelfScreen navigation={navigation} />);
    await screen.findByText("Nothing on the shelf yet");
  });

  it("renders the shared ErrorState (with Retry) when shelves fail with no cache", async () => {
    seedOnline([]);
    useLibraryStore.setState({ shelvesLoadError: true } as any);
    const loadShelves = useLibraryStore.getState().loadPersonalizedShelves as jest.Mock;
    const navigation = makeNavigation();
    await render(<BookshelfScreen navigation={navigation} />);

    await screen.findByText("Couldn't load your library");
    await fireEvent.press(screen.getByLabelText("Retry"));
    expect(loadShelves).toHaveBeenCalledWith(true);
  });

  it("shelf header routes to the Library tab with the shelf's sort (Recently Added → addedAt desc)", async () => {
    seedOnline([baseShelves[1]]); // recently-added
    const navigation = makeNavigation();
    await render(<BookshelfScreen navigation={navigation} />);

    await simulateShelfOverflow("recently-added");
    const header = await screen.findByLabelText("Recently Added, see all");
    await fireEvent.press(header);
    expect(navigation.navigate).toHaveBeenCalledWith("Library", {
      orderBy: "addedAt",
      descending: true,
    });
  });

  it("shows the 'see all' arrow ONLY when a shelf row overflows the viewport", async () => {
    seedOnline([baseShelves[1]]); // recently-added
    const navigation = makeNavigation();
    await render(<BookshelfScreen navigation={navigation} />);

    // Content fits the viewport → no arrow.
    await simulateShelfOverflow("recently-added", { viewport: 800, content: 400 });
    expect(screen.queryByLabelText("Recently Added, see all")).toBeNull();

    // Content now wider than the viewport → arrow appears.
    await simulateShelfOverflow("recently-added", { viewport: 400, content: 1600 });
    expect(screen.getByLabelText("Recently Added, see all")).toBeTruthy();
  });

  it("Continue Reading 'see all' opens the Library in-progress filter", async () => {
    seedOnline([
      { id: "continue-reading", label: "Continue Reading", type: "book", entities: [audioBook, ebookOnlyBook] },
    ]);
    const navigation = makeNavigation();
    await render(<BookshelfScreen navigation={navigation} />);

    await screen.findByText("Continue Reading");
    await simulateShelfOverflow("continue-reading");
    await fireEvent.press(screen.getByLabelText("Continue Reading, see all"));
    expect(navigation.navigate).toHaveBeenCalledWith(
      "Library",
      expect.objectContaining({ filter: expect.stringContaining("progress.") })
    );
  });

  it("Continue Series 'see all' switches the Library hub to the Series segment", async () => {
    seedOnline([
      { id: "recent-series", label: "Recent Series", type: "series", entities: [seriesEntity] },
    ]);
    const navigation = makeNavigation();
    await render(<BookshelfScreen navigation={navigation} />);

    await screen.findByText("Recent Series");
    await simulateShelfOverflow("recent-series");
    await fireEvent.press(screen.getByLabelText("Recent Series, see all"));
    expect(navigation.navigate).toHaveBeenCalledWith("Library", { segment: "series" });
  });

  it("transforms Continue Series into series folders resolved from the library series list", async () => {
    const inProgressWithSeries = {
      ...audioBook,
      media: {
        ...audioBook.media,
        metadata: { ...audioBook.media.metadata, seriesName: "Cool Series #1" },
      },
    };
    const nextInSeries = {
      id: "b9",
      mediaType: "book",
      media: {
        duration: 100,
        numTracks: 1,
        metadata: {
          title: "Other Book",
          authorName: "Bob",
          series: { id: "ser2", name: "Other Series" },
        },
      },
    };
    seedOnline([
      { id: "continue-listening", label: "Continue Listening", type: "book", entities: [inProgressWithSeries] },
      { id: "continue-series", label: "Continue Series", type: "book", entities: [nextInSeries] },
    ]);
    mockedGet.mockImplementation((url: string) => {
      if (url.includes("/series?")) {
        return Promise.resolve({
          data: {
            results: [
              { id: "ser1", name: "Cool Series", books: [{ id: "b1" }], booksCount: 2 },
              { id: "ser2", name: "Other Series", books: [{ id: "b9" }], booksCount: 3 },
            ],
          },
        });
      }
      return Promise.resolve({ data: { results: [] } });
    });
    const navigation = makeNavigation();
    await render(<BookshelfScreen navigation={navigation} />);

    await screen.findByText("Continue Series");
    // In-progress series first (from continue-listening), then between-books.
    const coolSeries = await screen.findByLabelText("Series: Cool Series");
    expect(screen.getByLabelText("Series: Other Series")).toBeTruthy();

    await fireEvent.press(coolSeries);
    expect(navigation.navigate).toHaveBeenCalledWith("SeriesDetail", {
      seriesId: "ser1",
      seriesName: "Cool Series",
    });
  });

  it("falls back to per-item fetches when the batch endpoint is unavailable (older servers)", async () => {
    seedOnline(baseShelves, { e1: { libraryItemId: "e1", ebookProgress: 0.4 } });
    mockedPost.mockRejectedValue({ response: { status: 404 } });
    mockedGet.mockImplementation((url: string) => {
      if (url === "/api/items/e1") return Promise.resolve({ data: ebookOnlyBook });
      return Promise.resolve({ data: { results: [] } });
    });
    const navigation = makeNavigation();
    await render(<BookshelfScreen navigation={navigation} />);

    await screen.findByText("Continue Reading");
    expect(mockedGet).toHaveBeenCalledWith("/api/items/e1");
    expect(screen.getAllByText("Ebook Only Book").length).toBeGreaterThanOrEqual(1);
  });

  it("re-fetches progress when the tab regains focus (skipping the initial mount focus)", async () => {
    seedOnline(baseShelves);
    const loadMediaProgress = useUserStore.getState().loadMediaProgress as jest.Mock;
    const navigation = makeNavigation();
    await render(<BookshelfScreen navigation={navigation} />);
    await screen.findByText("Continue Listening");

    const focusHandler = (navigation.addListener as jest.Mock).mock.calls.find(
      (c) => c[0] === "focus"
    )?.[1];
    expect(focusHandler).toBeTruthy();
    loadMediaProgress.mockClear();

    await act(async () => {
      focusHandler(); // first focus after mount is intentionally skipped
    });
    expect(loadMediaProgress).not.toHaveBeenCalled();

    await act(async () => {
      focusHandler();
    });
    expect(loadMediaProgress).toHaveBeenCalledTimes(1);
  });

  it("has a Browse genres entry point that navigates to the GenreBrowse screen", async () => {
    seedOnline(baseShelves);
    const navigation = makeNavigation();
    await render(<BookshelfScreen navigation={navigation} />);

    const entry = await screen.findByLabelText("Browse genres");
    await fireEvent.press(entry);
    expect(navigation.navigate).toHaveBeenCalledWith("GenreBrowse");
  });

  it("builds a 'Because you listened' affinity shelf, excluding books already read", async () => {
    const sciFiRead = {
      id: "read1",
      mediaType: "book",
      media: { metadata: { title: "Read SciFi", authorName: "A", genres: ["Sci-Fi"] } },
    };
    const recNew = {
      id: "rec1",
      mediaType: "book",
      media: { metadata: { title: "New SciFi", authorName: "B" } },
    };
    const recFinished = {
      id: "rec2",
      mediaType: "book",
      media: { metadata: { title: "Done SciFi", authorName: "C" } },
    };
    seedOnline([{ id: "recently-added", label: "Recently Added", type: "book", entities: [sciFiRead] }], {
      // A started book (drives the "Sci-Fi" affinity) and an already-finished
      // recommendation candidate (must be filtered back out of the shelf).
      read1: { libraryItemId: "read1", progress: 0.5 },
      rec2: { libraryItemId: "rec2", isFinished: true },
    });
    mockedGet.mockImplementation((url: string) => {
      if (url.includes("filter=genres.")) {
        return Promise.resolve({ data: { results: [recNew, recFinished] } });
      }
      return Promise.resolve({ data: { results: [] } });
    });

    const navigation = makeNavigation();
    await render(<BookshelfScreen navigation={navigation} />);

    await screen.findByText("Because you listened");
    // Coverless cards render the title twice (placeholder + meta panel).
    expect(screen.getAllByText("New SciFi").length).toBeGreaterThanOrEqual(1);
    // The finished candidate is excluded from the recommendation.
    expect(screen.queryByText("Done SciFi")).toBeNull();
    // The query uses the base64-encoded top genre.
    expect(mockedGet).toHaveBeenCalledWith(
      expect.stringContaining(`filter=genres.${encodeFilterValue("Sci-Fi")}`)
    );
  });

  it("skips the affinity shelf when there is no genre affinity (no started books with genres)", async () => {
    // baseShelves items carry no genres and there's no progress → no affinity.
    seedOnline(baseShelves);
    const navigation = makeNavigation();
    await render(<BookshelfScreen navigation={navigation} />);

    await screen.findByText("Continue Listening");
    expect(screen.queryByText("Because you listened")).toBeNull();
    // Never issues a genre-affinity query when there's nothing to base it on.
    expect(mockedGet).not.toHaveBeenCalledWith(expect.stringContaining("filter=genres."));
  });

  it("surfaces a Want to Read shelf from the favorites store (batch fetch, library-scoped)", async () => {
    const favBook = {
      id: "fav1",
      mediaType: "book",
      libraryId: "lib1",
      media: { metadata: { title: "Wishlist Book", authorName: "F Author" } },
    };
    // A favorite from ANOTHER library must be scoped out of this shelf.
    const otherLibFav = {
      id: "fav2",
      mediaType: "book",
      libraryId: "lib2",
      media: { metadata: { title: "Other Library Fav", authorName: "G Author" } },
    };
    seedOnline(baseShelves);
    useFavoritesStore.setState({ favorites: ["fav1", "fav2"] } as any);
    mockedPost.mockImplementation((url: string, body: any) => {
      if (url === "/api/items/batch/get" && body?.libraryItemIds?.includes("fav1")) {
        return Promise.resolve({ data: { libraryItems: [favBook, otherLibFav] } });
      }
      return Promise.resolve({ data: { libraryItems: [] } });
    });
    const navigation = makeNavigation();
    await render(<BookshelfScreen navigation={navigation} />);

    await screen.findByText("Want to Read");
    expect(screen.getAllByText("Wishlist Book").length).toBeGreaterThanOrEqual(1);
    // The other-library favorite is filtered out of this library's shelf.
    expect(screen.queryByText("Other Library Fav")).toBeNull();
    expect(mockedPost).toHaveBeenCalledWith("/api/items/batch/get", {
      libraryItemIds: ["fav1", "fav2"],
    });

    // Tapping the favorite opens ItemDetail, like any other book card.
    await fireEvent.press(screen.getByLabelText("Wishlist Book by F Author"));
    expect(navigation.navigate).toHaveBeenCalledWith("ItemDetail", { itemId: "fav1" });
  });

  it("hides the Want to Read shelf when there are no favorites", async () => {
    seedOnline(baseShelves);
    // favorites is reset to [] in beforeEach.
    const navigation = makeNavigation();
    await render(<BookshelfScreen navigation={navigation} />);

    await screen.findByText("Continue Listening");
    expect(screen.queryByText("Want to Read")).toBeNull();
  });

  it("renders Browse genres AFTER the personalized shelves (Continue Listening stays first)", async () => {
    seedOnline(baseShelves);
    const navigation = makeNavigation();
    await render(<BookshelfScreen navigation={navigation} />);

    const browse = await screen.findByLabelText("Browse genres");
    // Still navigates correctly...
    await fireEvent.press(browse);
    expect(navigation.navigate).toHaveBeenCalledWith("GenreBrowse");
    // ...and the primary resume shelf comes before the genre browse row in the
    // rendered tree order (guards the placement fix — Browse genres used to
    // precede Continue Listening). Walk the instance tree in DFS order and
    // record which marker we reach first.
    const seq: string[] = [];
    const walk = (node: any) => {
      if (!node || typeof node !== "object") return;
      if (node.props?.accessibilityLabel === "Browse genres") seq.push("browse");
      if (node.children?.length === 1 && node.children[0] === "Continue Listening") seq.push("continue");
      (node.children || []).forEach(walk);
    };
    walk(screen.root);
    expect(seq.indexOf("continue")).toBeGreaterThanOrEqual(0);
    expect(seq.indexOf("continue")).toBeLessThan(seq.indexOf("browse"));
  });
});
