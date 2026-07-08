/**
 * LibraryHubScreen — the consolidated "Library" destination. Verifies the
 * segmented control (Books · Series · Collections · Authors), that switching
 * segments swaps the embedded facet body, that a route param selects the
 * initial segment, that a Books filter/sort deep-link lands on the Books
 * segment with the seed applied, and that the last segment is persisted to MMKV.
 *
 * The four facet screens are mocked to lightweight markers so the test targets
 * hub behavior, not each facet's data fetching.
 */
import { render, screen, fireEvent } from "@testing-library/react-native";

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
    default: ({ showFilter, showSort, onFilter, onSort }: any) =>
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
      ]),
  };
});

jest.mock("../../components/SearchContent", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return { __esModule: true, default: () => React.createElement(Text, null, "SEARCH_OVERLAY") };
});

const mockOpenFilter = jest.fn();
const mockOpenSort = jest.fn();

jest.mock("../../screens/LibraryScreen", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return {
    __esModule: true,
    default: React.forwardRef((props: any, ref: any) => {
      React.useImperativeHandle(ref, () => ({
        openFilter: mockOpenFilter,
        openSort: mockOpenSort,
      }));
      const p = props.route?.params || {};
      return React.createElement(
        Text,
        null,
        `BOOKS_BODY filter=${p.filter ?? "none"} order=${p.orderBy ?? "none"} desc=${String(p.descending ?? "none")}`
      );
    }),
  };
});

jest.mock("../../screens/SeriesListScreen", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return {
    __esModule: true,
    default: React.forwardRef((_props: any, ref: any) => {
      React.useImperativeHandle(ref, () => ({ openSort: mockOpenSort }));
      return React.createElement(Text, null, "SERIES_BODY");
    }),
  };
});

jest.mock("../../screens/CollectionsPlaylistsScreen", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return {
    __esModule: true,
    default: React.forwardRef((_props: any, _ref: any) =>
      React.createElement(Text, null, "COLLECTIONS_BODY")
    ),
  };
});

jest.mock("../../screens/AuthorsScreen", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return {
    __esModule: true,
    default: React.forwardRef((_props: any, ref: any) => {
      React.useImperativeHandle(ref, () => ({ openSort: mockOpenSort }));
      return React.createElement(Text, null, "AUTHORS_BODY");
    }),
  };
});

import LibraryHubScreen from "../../screens/LibraryHubScreen";
import { useUiStore } from "../../store/useUiStore";
import { storage, storageHelper } from "../../utils/storage";

const initialUi = useUiStore.getState();

function makeNavigation() {
  const navigation: any = { navigate: jest.fn(), goBack: jest.fn(), addListener: jest.fn(() => jest.fn()) };
  navigation.getParent = jest.fn(() => navigation);
  return navigation;
}

beforeEach(() => {
  useUiStore.setState(initialUi, true);
  storage.getAllKeys().forEach((k: string) => storage.remove(k));
});

describe("LibraryHubScreen", () => {
  it("renders all four segments and defaults to the Books facet", async () => {
    await render(<LibraryHubScreen route={{ params: {} }} navigation={makeNavigation()} />);

    // Segment labels
    expect(screen.getByText("Books")).toBeTruthy();
    expect(screen.getByText("Series")).toBeTruthy();
    expect(screen.getByText("Collections")).toBeTruthy();
    expect(screen.getByText("Authors")).toBeTruthy();

    // Default body is Books
    expect(screen.getByText(/BOOKS_BODY/)).toBeTruthy();
    expect(screen.queryByText("SERIES_BODY")).toBeNull();
  });

  it("switching segments swaps the embedded facet body", async () => {
    await render(<LibraryHubScreen route={{ params: {} }} navigation={makeNavigation()} />);
    expect(screen.getByText(/BOOKS_BODY/)).toBeTruthy();

    await fireEvent.press(screen.getByText("Series"));
    expect(screen.getByText("SERIES_BODY")).toBeTruthy();
    expect(screen.queryByText(/BOOKS_BODY/)).toBeNull();

    await fireEvent.press(screen.getByText("Authors"));
    expect(screen.getByText("AUTHORS_BODY")).toBeTruthy();

    await fireEvent.press(screen.getByText("Collections"));
    expect(screen.getByText("COLLECTIONS_BODY")).toBeTruthy();
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

  it("a Books filter/sort deep-link lands on Books with the seed applied", async () => {
    // Even with a persisted 'authors' segment, a filter/sort deep-link forces Books.
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

  it("contextual TopAppBar actions drive the active facet (Books filter, Series sort)", async () => {
    await render(<LibraryHubScreen route={{ params: {} }} navigation={makeNavigation()} />);
    // Books: both filter + sort available
    await fireEvent.press(screen.getByLabelText("Filter"));
    expect(mockOpenFilter).toHaveBeenCalledTimes(1);

    // Series: only sort; the sort button routes into the series facet's handle
    await fireEvent.press(screen.getByText("Series"));
    expect(screen.queryByLabelText("Filter")).toBeNull();
    await fireEvent.press(screen.getByLabelText("Sort"));
    expect(mockOpenSort).toHaveBeenCalledTimes(1);
  });

  it("shows the shared search overlay when search is active", async () => {
    useUiStore.setState({ isSearchActive: true } as any);
    await render(<LibraryHubScreen route={{ params: {} }} navigation={makeNavigation()} />);
    expect(screen.getByText("SEARCH_OVERLAY")).toBeTruthy();
    // Segment control + facet body are hidden behind the overlay
    expect(screen.queryByText(/BOOKS_BODY/)).toBeNull();
  });
});
