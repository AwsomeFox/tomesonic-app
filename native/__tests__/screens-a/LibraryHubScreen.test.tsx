/**
 * LibraryHubScreen — the consolidated "Library" destination. Verifies the
 * segmented pill control (Books · Series · Collections · Playlists · Authors),
 * that facets stay MOUNTED across segment switches and the search toggle (no
 * unmount / page-0 refetch, scroll preserved), that a Books deep-link seed is
 * cleared once consumed, and the scroll-to-top / create FAB + tab-press wiring.
 *
 * The facet screens are mocked to lightweight markers that render the hub's
 * pill row (passed down as `listHeader`) plus a body marker, so the test targets
 * hub behavior, not each facet's data fetching.
 */
import { render, screen, fireEvent, act } from "@testing-library/react-native";

jest.mock("react-native-safe-area-context", () => {
  const React = require("react");
  const { View } = require("react-native");
  return {
    SafeAreaProvider: ({ children }: any) => children,
    SafeAreaView: ({ children, edges, ...props }: any) => React.createElement(View, props, children),
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  };
});

// Minimal TopAppBar: expose filter/sort actions so we can assert the hub wires
// the shared bar into the active facet's imperative handle.
jest.mock("../../components/TopAppBar", () => {
  const React = require("react");
  const { Text, Pressable } = require("react-native");
  return {
    __esModule: true,
    default: ({ showFilter, showSort, onFilter, onSort, filterActive }: any) =>
      React.createElement(React.Fragment, null, [
        showFilter
          ? React.createElement(
              Pressable,
              { key: "f", accessibilityLabel: "Filter", onPress: onFilter },
              React.createElement(Text, null, "Filter")
            )
          : null,
        showSort
          ? React.createElement(
              Pressable,
              { key: "s", accessibilityLabel: "Sort", onPress: onSort },
              React.createElement(Text, null, "Sort")
            )
          : null,
        // Marker so the badge wiring (filterActive) is assertable.
        filterActive ? React.createElement(Text, { key: "fa" }, "FILTER_ACTIVE") : null,
      ]),
  };
});

jest.mock("../../components/SearchContent", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return { __esModule: true, default: () => React.createElement(Text, null, "SEARCH_OVERLAY") };
});

// Connectivity signal (same hook BookshelfScreen/OfflineBanner consume). Default
// online; individual tests flip it to exercise the offline fallback.
let mockIsConnected = true;
jest.mock("../../hooks/useNetworkStatus", () => ({
  __esModule: true,
  useNetworkStatus: () => ({ isConnected: mockIsConnected, isInternetReachable: mockIsConnected }),
  default: () => ({ isConnected: mockIsConnected, isInternetReachable: mockIsConnected }),
}));

const mockOpenFilter = jest.fn();
const mockOpenSort = jest.fn();
const mockScrollToTop: Record<string, jest.Mock> = {
  books: jest.fn(),
  series: jest.fn(),
  collections: jest.fn(),
  playlists: jest.fn(),
  authors: jest.fn(),
};
const mockOpenCreate: Record<string, jest.Mock> = {
  collections: jest.fn(),
  playlists: jest.fn(),
};
const mockMount: Record<string, jest.Mock> = {
  books: jest.fn(),
  series: jest.fn(),
  collections: jest.fn(),
  playlists: jest.fn(),
  authors: jest.fn(),
};

jest.mock("../../screens/LibraryScreen", () => {
  const React = require("react");
  const { Text, Pressable } = require("react-native");
  return {
    __esModule: true,
    default: React.forwardRef((props: any, ref: any) => {
      React.useImperativeHandle(ref, () => ({
        openFilter: mockOpenFilter,
        openSort: mockOpenSort,
        scrollToTop: mockScrollToTop.books,
      }));
      React.useEffect(() => {
        mockMount.books();
      }, []);
      const p = props.route?.params || {};
      return React.createElement(React.Fragment, null, [
        React.createElement(React.Fragment, { key: "h" }, props.listHeader),
        React.createElement(
          Text,
          { key: "b" },
          `BOOKS_BODY filter=${p.filter ?? "none"} order=${p.orderBy ?? "none"} desc=${String(
            p.descending ?? "none"
          )}`
        ),
        React.createElement(
          Pressable,
          { key: "seed", accessibilityLabel: "consume-seed", onPress: () => props.onSeedConsumed?.() },
          React.createElement(Text, null, "consume")
        ),
        React.createElement(
          Pressable,
          { key: "sc", accessibilityLabel: "books-emit-scroll", onPress: () => props.onScroll?.(700) },
          React.createElement(Text, null, "emit")
        ),
        React.createElement(
          Pressable,
          {
            key: "fa",
            accessibilityLabel: "books-emit-filter-active",
            onPress: () => props.onFilterActiveChange?.(true),
          },
          React.createElement(Text, null, "filter-active")
        ),
      ]);
    }),
  };
});

jest.mock("../../screens/SeriesListScreen", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return {
    __esModule: true,
    default: React.forwardRef((props: any, ref: any) => {
      React.useImperativeHandle(ref, () => ({
        openSort: mockOpenSort,
        scrollToTop: mockScrollToTop.series,
      }));
      React.useEffect(() => {
        mockMount.series();
      }, []);
      return React.createElement(React.Fragment, null, [
        React.createElement(React.Fragment, { key: "h" }, props.listHeader),
        React.createElement(Text, { key: "b" }, "SERIES_BODY"),
      ]);
    }),
  };
});

jest.mock("../../screens/CollectionsPlaylistsScreen", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return {
    __esModule: true,
    default: React.forwardRef((props: any, ref: any) => {
      const mode = props.mode;
      React.useImperativeHandle(ref, () => ({
        scrollToTop: mockScrollToTop[mode],
        openCreate: mockOpenCreate[mode],
      }));
      React.useEffect(() => {
        mockMount[mode]();
      }, [mode]);
      return React.createElement(React.Fragment, null, [
        React.createElement(React.Fragment, { key: "h" }, props.listHeader),
        React.createElement(Text, { key: "b" }, `COLLECTIONS_BODY mode=${mode}`),
      ]);
    }),
  };
});

jest.mock("../../screens/AuthorsScreen", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return {
    __esModule: true,
    default: React.forwardRef((props: any, ref: any) => {
      React.useImperativeHandle(ref, () => ({
        openSort: mockOpenSort,
        scrollToTop: mockScrollToTop.authors,
      }));
      React.useEffect(() => {
        mockMount.authors();
      }, []);
      return React.createElement(React.Fragment, null, [
        React.createElement(React.Fragment, { key: "h" }, props.listHeader),
        React.createElement(Text, { key: "b" }, "AUTHORS_BODY"),
      ]);
    }),
  };
});

import LibraryHubScreen from "../../screens/LibraryHubScreen";
import { useUiStore } from "../../store/useUiStore";
import { storage, storageHelper } from "../../utils/storage";

const initialUi = useUiStore.getState();

function makeNavigation() {
  const handlers: Record<string, any> = {};
  const navigation: any = {
    navigate: jest.fn(),
    goBack: jest.fn(),
    setParams: jest.fn(),
    isFocused: jest.fn(() => true),
    addListener: jest.fn((event: string, cb: any) => {
      handlers[event] = cb;
      return jest.fn();
    }),
    __handlers: handlers,
  };
  navigation.getParent = jest.fn(() => navigation);
  return navigation;
}

function layerDisplay(key: string): string | undefined {
  return (
    screen.getByTestId(`facet-layer-${key}`, { includeHiddenElements: true }).props.style || {}
  ).display;
}

beforeEach(() => {
  useUiStore.setState(initialUi, true);
  storage.getAllKeys().forEach((k: string) => storage.remove(k));
  mockIsConnected = true;
});

describe("LibraryHubScreen", () => {
  it("renders all five segments and defaults to the Books facet", async () => {
    await render(<LibraryHubScreen route={{ params: {} }} navigation={makeNavigation()} />);

    // Segment labels (the pill row is rendered by the active facet's header).
    expect(screen.getByText("Books")).toBeTruthy();
    expect(screen.getByText("Series")).toBeTruthy();
    expect(screen.getByText("Collections")).toBeTruthy();
    expect(screen.getByText("Playlists")).toBeTruthy();
    expect(screen.getByText("Authors")).toBeTruthy();

    // Default body is Books; other facets are lazy (not mounted yet).
    expect(screen.getByText(/BOOKS_BODY/)).toBeTruthy();
    expect(screen.queryByText("SERIES_BODY")).toBeNull();
  });

  it("keeps facets mounted across segment switches (no unmount / refetch)", async () => {
    await render(<LibraryHubScreen route={{ params: {} }} navigation={makeNavigation()} />);
    expect(mockMount.books).toHaveBeenCalledTimes(1);

    await fireEvent.press(screen.getByText("Series"));
    expect(screen.getByText("SERIES_BODY")).toBeTruthy();
    expect(mockMount.series).toHaveBeenCalledTimes(1);

    await fireEvent.press(screen.getByText("Books"));

    // Both facets are still mounted (Books never re-mounted → never refetched
    // page 0). Only the active layer is shown.
    expect(mockMount.books).toHaveBeenCalledTimes(1);
    expect(mockMount.series).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/BOOKS_BODY/)).toBeTruthy();
    // The Series body is still in the tree (kept mounted), just hidden behind
    // the now-inactive display:none layer.
    expect(screen.getByText("SERIES_BODY", { includeHiddenElements: true })).toBeTruthy();
    expect(layerDisplay("books")).toBe("flex");
    expect(layerDisplay("series")).toBe("none");
  });

  it("promotes Playlists to a top-level segment", async () => {
    await render(<LibraryHubScreen route={{ params: {} }} navigation={makeNavigation()} />);

    await fireEvent.press(screen.getByText("Playlists"));
    expect(screen.getByText("COLLECTIONS_BODY mode=playlists")).toBeTruthy();

    await fireEvent.press(screen.getByText("Collections"));
    expect(screen.getByText("COLLECTIONS_BODY mode=collections")).toBeTruthy();
  });

  it("persists the selected segment to storage", async () => {
    await render(<LibraryHubScreen route={{ params: {} }} navigation={makeNavigation()} />);
    await fireEvent.press(screen.getByText("Series"));
    expect(storageHelper.getLibraryHubSegment()).toBe("series");
  });

  it("restores the persisted segment on mount", async () => {
    storageHelper.setLibraryHubSegment("authors");
    await render(<LibraryHubScreen route={{ params: {} }} navigation={makeNavigation()} />);
    expect(screen.getByText("AUTHORS_BODY")).toBeTruthy();
  });

  it("an explicit segment route param selects the initial segment", async () => {
    await render(<LibraryHubScreen route={{ params: { segment: "series" } }} navigation={makeNavigation()} />);
    expect(screen.getByText("SERIES_BODY")).toBeTruthy();
  });

  it("falls back to the Books facet for an invalid segment route param", async () => {
    await render(
      <LibraryHubScreen route={{ params: { segment: "bogus" } }} navigation={makeNavigation()} />
    );
    // "bogus" isn't a valid segment → normalizeSegment returns null → Books.
    expect(screen.getByText(/BOOKS_BODY/)).toBeTruthy();
    expect(screen.queryByText("SERIES_BODY")).toBeNull();
  });

  it("falls back to the Books facet when the persisted segment is corrupt", async () => {
    storageHelper.setLibraryHubSegment("garbage");
    await render(<LibraryHubScreen route={{ params: {} }} navigation={makeNavigation()} />);
    // A corrupt MMKV value doesn't normalize to a real segment → Books.
    expect(screen.getByText(/BOOKS_BODY/)).toBeTruthy();
  });

  it("wires the Books filter-active badge to the TopAppBar, gated by the Books segment", async () => {
    await render(<LibraryHubScreen route={{ params: {} }} navigation={makeNavigation()} />);
    // No badge until the Books facet reports a non-default filter/sort.
    expect(screen.queryByText("FILTER_ACTIVE")).toBeNull();

    // Embedded Books facet's onFilterActiveChange → hub booksFilterActive →
    // TopAppBar filterActive.
    await fireEvent.press(screen.getByLabelText("books-emit-filter-active"));
    expect(screen.getByText("FILTER_ACTIVE")).toBeTruthy();

    // Leaving Books drops showFilter, so the (gated) badge disappears even though
    // the Books facet stays mounted and still reports active.
    await fireEvent.press(screen.getByText("Series"));
    expect(screen.queryByText("FILTER_ACTIVE")).toBeNull();
  });

  it("a Books filter/sort deep-link lands on Books with the seed applied", async () => {
    storageHelper.setLibraryHubSegment("authors");
    await render(
      <LibraryHubScreen
        route={{ params: { filter: "genres.QUJD", orderBy: "title", descending: false } }}
        navigation={makeNavigation()}
      />
    );
    expect(
      screen.getByText("BOOKS_BODY filter=genres.QUJD order=title desc=false")
    ).toBeTruthy();
  });

  it("clears the Books seed once the facet reports it consumed", async () => {
    await render(
      <LibraryHubScreen
        route={{ params: { filter: "genres.QUJD", orderBy: "title", descending: false } }}
        navigation={makeNavigation()}
      />
    );
    expect(
      screen.getByText("BOOKS_BODY filter=genres.QUJD order=title desc=false")
    ).toBeTruthy();

    // The embedded Books facet applies the seed and reports back — the hub drops
    // it so a later remount/search-toggle can't revert the user's chosen sort.
    await fireEvent.press(screen.getByLabelText("consume-seed"));
    expect(screen.getByText("BOOKS_BODY filter=none order=none desc=none")).toBeTruthy();
  });

  it("clears consumed route params so a sticky seed can't re-force Books later", async () => {
    const navigation = makeNavigation();
    await render(
      <LibraryHubScreen
        route={{ params: { filter: "genres.QUJD", orderBy: "title", descending: false } }}
        navigation={navigation}
      />
    );
    expect(navigation.setParams).toHaveBeenCalledWith({
      filter: undefined,
      orderBy: undefined,
      descending: undefined,
      segment: undefined,
    });
  });

  it("does not call setParams when there were no params to consume", async () => {
    const navigation = makeNavigation();
    await render(<LibraryHubScreen route={{ params: {} }} navigation={navigation} />);
    expect(navigation.setParams).not.toHaveBeenCalled();
  });

  it("contextual TopAppBar actions drive the active facet (Books filter, Series sort)", async () => {
    await render(<LibraryHubScreen route={{ params: {} }} navigation={makeNavigation()} />);
    await fireEvent.press(screen.getByLabelText("Filter"));
    expect(mockOpenFilter).toHaveBeenCalledTimes(1);

    await fireEvent.press(screen.getByText("Series"));
    expect(screen.queryByLabelText("Filter")).toBeNull();
    await fireEvent.press(screen.getByLabelText("Sort"));
    expect(mockOpenSort).toHaveBeenCalledTimes(1);
  });

  it("overlays search above the still-mounted active facet", async () => {
    useUiStore.setState({ isSearchActive: true } as any);
    await render(<LibraryHubScreen route={{ params: {} }} navigation={makeNavigation()} />);
    expect(screen.getByText("SEARCH_OVERLAY")).toBeTruthy();
    // The Books facet stays mounted underneath the overlay (survives the toggle).
    expect(screen.getByText(/BOOKS_BODY/)).toBeTruthy();
  });

  it("re-tapping the focused Library tab scrolls the active facet to top", async () => {
    const navigation = makeNavigation();
    await render(<LibraryHubScreen route={{ params: {} }} navigation={navigation} />);

    await act(async () => {
      navigation.__handlers.tabPress();
    });
    expect(mockScrollToTop.books).toHaveBeenCalledTimes(1);

    await fireEvent.press(screen.getByText("Series"));
    await act(async () => {
      navigation.__handlers.tabPress();
    });
    expect(mockScrollToTop.series).toHaveBeenCalledTimes(1);
  });

  it("does not scroll-to-top on tabPress while search is active", async () => {
    useUiStore.setState({ isSearchActive: true } as any);
    const navigation = makeNavigation();
    await render(<LibraryHubScreen route={{ params: {} }} navigation={navigation} />);
    await act(async () => {
      navigation.__handlers.tabPress();
    });
    expect(mockScrollToTop.books).not.toHaveBeenCalled();
  });

  it("shows a scroll-to-top FAB once the active list is scrolled down", async () => {
    await render(<LibraryHubScreen route={{ params: {} }} navigation={makeNavigation()} />);
    expect(screen.queryByLabelText("Scroll to top")).toBeNull();

    await fireEvent.press(screen.getByLabelText("books-emit-scroll"));
    const fab = screen.getByLabelText("Scroll to top");
    expect(fab).toBeTruthy();

    await fireEvent.press(fab);
    expect(mockScrollToTop.books).toHaveBeenCalled();
  });

  it("shows a create FAB only on the collections/playlists segments", async () => {
    await render(<LibraryHubScreen route={{ params: {} }} navigation={makeNavigation()} />);
    expect(screen.queryByLabelText("Create new collection")).toBeNull();

    await fireEvent.press(screen.getByText("Collections"));
    await fireEvent.press(screen.getByLabelText("Create new collection"));
    expect(mockOpenCreate.collections).toHaveBeenCalledTimes(1);

    await fireEvent.press(screen.getByText("Playlists"));
    await fireEvent.press(screen.getByLabelText("Create new playlist"));
    expect(mockOpenCreate.playlists).toHaveBeenCalledTimes(1);
  });

  it("shows an offline notice instead of the facets when offline", async () => {
    mockIsConnected = false;
    await render(<LibraryHubScreen route={{ params: {} }} navigation={makeNavigation()} />);

    // Offline CTA is shown; the server-backed facets are not rendered (no failing
    // fetches).
    expect(screen.getByText("You're offline")).toBeTruthy();
    expect(screen.getByLabelText("Open Downloads")).toBeTruthy();
    expect(screen.queryByText(/BOOKS_BODY/)).toBeNull();
  });

  it("the offline notice navigates to the Downloads screen", async () => {
    mockIsConnected = false;
    const navigation = makeNavigation();
    await render(<LibraryHubScreen route={{ params: {} }} navigation={navigation} />);

    await fireEvent.press(screen.getByLabelText("Open Downloads"));
    expect(navigation.navigate).toHaveBeenCalledWith("Downloads");
  });

  it("renders the facets normally when back online", async () => {
    mockIsConnected = true;
    await render(<LibraryHubScreen route={{ params: {} }} navigation={makeNavigation()} />);
    expect(screen.getByText(/BOOKS_BODY/)).toBeTruthy();
    expect(screen.queryByText("You're offline")).toBeNull();
  });
});
