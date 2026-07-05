/**
 * SearchContent — debounced library search overlay body: empty/skeleton/no-results
 * states, per-section result rendering, the stale-response (searchId) guard, the
 * hideNonAudiobooksGlobal filter, and root-stack tap routing for every result type.
 */
import { render, screen, fireEvent, act } from "@testing-library/react-native";

// The setup-level reanimated mock factory pulls the real react-native-worklets
// (native) module and explodes under jest — override with a minimal JS mock
// covering exactly the APIs components use (see TESTING.md per-test overrides).
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
    useAnimatedStyle: (fn: any) => {
      try {
        return fn() || {};
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
    withTiming: (v: any, _c?: any, cb?: (finished: boolean) => void) => {
      cb?.(true);
      return v;
    },
    withSpring: (v: any, _c?: any, cb?: (finished: boolean) => void) => {
      cb?.(true);
      return v;
    },
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
    useReducedMotion: () => false,
    LinearTransition: chainable(),
    FadeIn: chainable(),
    FadeOut: chainable(),
    FadeInDown: chainable(),
    FadeInRight: chainable(),
  };
});

jest.mock("../../utils/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

import SearchContent from "../../components/SearchContent";
import { encodeFilterValue } from "../../components/FilterModal";
import { api } from "../../utils/api";
import { useUiStore } from "../../store/useUiStore";
import { useLibraryStore } from "../../store/useLibraryStore";
import { useUserStore } from "../../store/useUserStore";
import { usePlaybackStore } from "../../store/usePlaybackStore";

const apiGet = api.get as jest.Mock;

const uiInitial = useUiStore.getState();
const libraryInitial = useLibraryStore.getState();
const userInitial = useUserStore.getState();
const playbackInitial = usePlaybackStore.getState();

// Tab-level navigation stub whose getParent() returns the ROOT stack — every
// result tap must route through the parent (see SearchContent's rootNav note).
function makeNav() {
  const parent = { navigate: jest.fn() };
  const navigation = {
    navigate: jest.fn(),
    goBack: jest.fn(),
    addListener: jest.fn(() => jest.fn()),
    getParent: jest.fn(() => parent),
  };
  return { navigation, parent };
}

const RESULTS = {
  book: [
    {
      libraryItem: {
        id: "item1",
        mediaType: "book",
        media: { numTracks: 2, metadata: { title: "The Hobbit", authorName: "J.R.R. Tolkien" } },
      },
    },
  ],
  podcast: [],
  series: [
    { series: { id: "ser1", name: "The Saga" }, books: [{ id: "b1" }, { id: "b2" }] },
  ],
  authors: [{ author: { id: "au1", name: "Brandon Sanderson", numBooks: 12 } }],
  narrators: [{ name: "Ray Porter", numBooks: 3 }],
  tags: ["favorites"],
};

beforeEach(() => {
  useUiStore.setState(uiInitial, true);
  useLibraryStore.setState(libraryInitial, true);
  useUserStore.setState(userInitial, true);
  usePlaybackStore.setState(playbackInitial, true);
  useLibraryStore.setState({ currentLibraryId: "lib1" } as any);
  useUserStore.setState({
    serverConnectionConfig: { address: "https://abs.example.com", token: "tok" },
  } as any);
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

/** Render with a query already seeded, run the debounce, and flush the fetch. */
async function renderSearch(query: string, response: any = RESULTS) {
  apiGet.mockResolvedValue({ data: response });
  useUiStore.setState({ searchQuery: query } as any);
  const { navigation, parent } = makeNav();
  await render(<SearchContent navigation={navigation} />);
  await act(async () => {
    jest.advanceTimersByTime(500);
  });
  return { navigation, parent };
}

describe("SearchContent — states", () => {
  it("shows the idle 'Search your library' state with no query", async () => {
    const { navigation } = makeNav();
    await render(<SearchContent navigation={navigation} />);
    expect(screen.getByText("Search your library")).toBeTruthy();
    expect(apiGet).not.toHaveBeenCalled();
  });

  it("shows skeleton rows immediately while the debounce is pending", async () => {
    useUiStore.setState({ searchQuery: "hob" } as any);
    const { navigation } = makeNav();
    await render(<SearchContent navigation={navigation} />);
    // Before the 500ms debounce elapses: loading=true, no results yet → skeleton
    // (no section headers, no idle copy).
    expect(screen.queryByText("Search your library")).toBeNull();
    expect(screen.queryByText("Books")).toBeNull();
    expect(apiGet).not.toHaveBeenCalled();
  });

  it("debounces: only one API call after typing settles, with encoded query", async () => {
    await renderSearch("the hobbit");
    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(apiGet).toHaveBeenCalledWith(
      "/api/libraries/lib1/search?q=the%20hobbit&limit=5"
    );
  });

  it("shows the no-results state when the search returns nothing", async () => {
    await renderSearch("zzz", { book: [], series: [], authors: [], narrators: [], tags: [] });
    expect(screen.getByText(/No results for/)).toBeTruthy();
    expect(screen.getByText("Try a different title, author, series, or narrator.")).toBeTruthy();
  });

  it("shows the ERROR state (not no-results) when the request fails", async () => {
    // A network failure must NOT masquerade as "No results" — that told users
    // on flaky connections the book wasn't in their library.
    useUiStore.setState({ searchQuery: "boom" } as any);
    apiGet.mockRejectedValue(Object.assign(new Error("500"), { response: { status: 500 } }));
    const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const { navigation } = makeNav();
    await render(<SearchContent navigation={navigation} />);
    await act(async () => {
      jest.advanceTimersByTime(500);
    });
    expect(screen.getByText("Search failed")).toBeTruthy();
    expect(screen.queryByText(/No results for/)).toBeNull();

    // Retry re-runs the search; success replaces the error with results.
    apiGet.mockResolvedValue({
      data: {
        book: [
          {
            libraryItem: {
              id: "b1",
              mediaType: "book",
              media: { numTracks: 1, metadata: { title: "Boom Book", authorName: "Author A" } },
            },
          },
        ],
      },
    });
    await fireEvent.press(screen.getByLabelText("Retry search"));
    await act(async () => {});
    expect(screen.getByText("Boom Book")).toBeTruthy();
    consoleSpy.mockRestore();
  });

  it("clearing the query returns to the idle state without searching", async () => {
    await renderSearch("hobbit");
    expect(screen.getByText("Books")).toBeTruthy();
    await act(async () => {
      useUiStore.setState({ searchQuery: "" } as any);
    });
    expect(screen.getByText("Search your library")).toBeTruthy();
  });
});

describe("SearchContent — result sections", () => {
  it("renders every section with its rows", async () => {
    await renderSearch("saga");
    // Books
    expect(screen.getByText("Books")).toBeTruthy();
    expect(screen.getByText("The Hobbit")).toBeTruthy();
    expect(screen.getByText("by J.R.R. Tolkien")).toBeTruthy();
    // Series
    expect(screen.getByText("Series")).toBeTruthy();
    expect(screen.getByText("The Saga")).toBeTruthy();
    expect(screen.getByText("2 Books")).toBeTruthy();
    // Authors
    expect(screen.getByText("Authors")).toBeTruthy();
    expect(screen.getByText("Brandon Sanderson")).toBeTruthy();
    expect(screen.getByText("12 Books")).toBeTruthy();
    // Narrators
    expect(screen.getByText("Narrators")).toBeTruthy();
    expect(screen.getByText("Ray Porter")).toBeTruthy();
    expect(screen.getByText("3 Books")).toBeTruthy();
    // Tags
    expect(screen.getByText("Tags")).toBeTruthy();
    expect(screen.getByText("favorites")).toBeTruthy();
  });

  it("hideNonAudiobooksGlobal filters ebook-only books out of results", async () => {
    useUserStore.setState({
      settings: { ...userInitial.settings, hideNonAudiobooksGlobal: true },
    } as any);
    await renderSearch("mix", {
      book: [
        ...RESULTS.book,
        {
          libraryItem: {
            id: "ebook1",
            mediaType: "book",
            media: { ebookFormat: "epub", metadata: { title: "Ebook Only Title" } },
          },
        },
      ],
      series: [],
      authors: [],
      narrators: [],
      tags: [],
    });
    expect(screen.getByText("The Hobbit")).toBeTruthy();
    expect(screen.queryByText("Ebook Only Title")).toBeNull();
  });

  it("discards a stale (slower, earlier) response — searchId guard", async () => {
    let resolveFirst: (v: any) => void = () => {};
    let resolveSecond: (v: any) => void = () => {};
    apiGet
      .mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)))
      .mockImplementationOnce(() => new Promise((r) => (resolveSecond = r)));

    useUiStore.setState({ searchQuery: "cat" } as any);
    const { navigation } = makeNav();
    await render(<SearchContent navigation={navigation} />);
    await act(async () => {
      jest.advanceTimersByTime(500); // fires search #1 ("cat"), left pending
    });

    await act(async () => {
      useUiStore.setState({ searchQuery: "catalog" } as any);
    });
    await act(async () => {
      jest.advanceTimersByTime(500); // fires search #2 ("catalog")
    });

    // Newer response lands first.
    await act(async () => {
      resolveSecond({
        data: {
          book: [
            {
              libraryItem: {
                id: "new1",
                mediaType: "book",
                media: { numTracks: 1, metadata: { title: "Catalog Result" } },
              },
            },
          ],
        },
      });
    });
    expect(screen.getByText("Catalog Result")).toBeTruthy();

    // The stale "cat" response must NOT overwrite the newer results.
    await act(async () => {
      resolveFirst({
        data: {
          book: [
            {
              libraryItem: {
                id: "old1",
                mediaType: "book",
                media: { numTracks: 1, metadata: { title: "Stale Cat Result" } },
              },
            },
          ],
        },
      });
    });
    expect(screen.getByText("Catalog Result")).toBeTruthy();
    expect(screen.queryByText("Stale Cat Result")).toBeNull();
  });
});

describe("SearchContent — tap routing (always via the ROOT stack)", () => {
  it("book row → parent ItemDetail", async () => {
    const { navigation, parent } = await renderSearch("hobbit");
    await fireEvent.press(screen.getByText("The Hobbit"));
    expect(parent.navigate).toHaveBeenCalledWith("ItemDetail", { itemId: "item1" });
    expect(navigation.navigate).not.toHaveBeenCalled();
  });

  it("series row → parent SeriesDetail", async () => {
    const { parent } = await renderSearch("saga");
    await fireEvent.press(screen.getByText("The Saga"));
    expect(parent.navigate).toHaveBeenCalledWith("SeriesDetail", { seriesId: "ser1" });
  });

  it("author row → parent AuthorDetail", async () => {
    const { parent } = await renderSearch("sanderson");
    await fireEvent.press(screen.getByText("Brandon Sanderson"));
    expect(parent.navigate).toHaveBeenCalledWith("AuthorDetail", {
      authorId: "au1",
      authorName: "Brandon Sanderson",
    });
  });

  it("narrator row → parent Library with base64-encoded narrators filter", async () => {
    const { parent } = await renderSearch("porter");
    await fireEvent.press(screen.getByText("Ray Porter"));
    expect(parent.navigate).toHaveBeenCalledWith("Library", {
      filter: `narrators.${encodeFilterValue("Ray Porter")}`,
      title: "Ray Porter",
      showBack: true,
    });
  });

  it("tag row → parent Library with base64-encoded tags filter", async () => {
    const { parent } = await renderSearch("fav");
    await fireEvent.press(screen.getByText("favorites"));
    expect(parent.navigate).toHaveBeenCalledWith("Library", {
      filter: `tags.${encodeFilterValue("favorites")}`,
      title: "favorites",
      showBack: true,
    });
  });

  it("falls back to the tab navigator when getParent() is unavailable", async () => {
    apiGet.mockResolvedValue({ data: RESULTS });
    useUiStore.setState({ searchQuery: "hobbit" } as any);
    const navigation = { navigate: jest.fn(), getParent: undefined };
    await render(<SearchContent navigation={navigation} />);
    await act(async () => {
      jest.advanceTimersByTime(500);
    });
    await fireEvent.press(screen.getByText("The Hobbit"));
    expect(navigation.navigate).toHaveBeenCalledWith("ItemDetail", { itemId: "item1" });
  });
});
