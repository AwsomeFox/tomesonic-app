jest.mock("../../utils/rmab", () => ({
  readRmabConfig: jest.fn(() => null),
  writeRmabConfig: jest.fn(),
  rmabAuthMode: () => null,
  exchangeLoginToken: jest.fn(),
  getMe: jest.fn(),
  createRequest: jest.fn(),
  getPendingApprovalCount: jest.fn().mockResolvedValue(0),
}));
/**
 * TopAppBar — library pill, search activate/deactivate (incl. Android hardware
 * back), context action icons, and the account/settings dropdown navigation.
 */
import { BackHandler } from "react-native";
import { render, screen, fireEvent, act } from "@testing-library/react-native";
import TopAppBar from "../../components/TopAppBar";
import { useUiStore } from "../../store/useUiStore";
import { useLibraryStore } from "../../store/useLibraryStore";
import { useDownloadStore } from "../../store/useDownloadStore";

const uiInitial = useUiStore.getState();
const libraryInitial = useLibraryStore.getState();

// A minimal in-flight DownloadItem for the account-menu badge tests.
const activeItem = (id: string) =>
  ({
    id,
    libraryItemId: id,
    title: id,
    author: "",
    coverUrl: "",
    progress: 0.5,
    status: "downloading",
    parts: [],
  }) as any;

function makeNav() {
  const navigation: any = {
    navigate: jest.fn(),
    goBack: jest.fn(),
    addListener: jest.fn(() => jest.fn()),
  };
  navigation.getParent = jest.fn(() => navigation);
  return navigation;
}

beforeEach(() => {
  useUiStore.setState(uiInitial, true);
  useLibraryStore.setState(libraryInitial, true);
  useLibraryStore.setState({
    libraries: [
      { id: "lib1", name: "Audiobooks", mediaType: "book", settings: {} },
      { id: "lib2", name: "Podcasts", mediaType: "podcast", settings: {} },
    ],
    currentLibraryId: "lib1",
  } as any);
  // No in-flight downloads by default — badge tests opt in explicitly.
  useDownloadStore.setState({ activeDownloads: {} } as any);
});

describe("TopAppBar — default (tab) mode", () => {
  it("shows the current library name in the selector pill", async () => {
    await render(<TopAppBar navigation={makeNav()} />);
    expect(screen.getByText("Audiobooks")).toBeTruthy();
  });

  it("falls back to 'Library' when no library matches", async () => {
    useLibraryStore.setState({ currentLibraryId: "nope" } as any);
    await render(<TopAppBar navigation={makeNav()} />);
    expect(screen.getByText("Library")).toBeTruthy();
  });

  it("pressing the pill opens the library selector", async () => {
    await render(<TopAppBar navigation={makeNav()} />);
    await fireEvent.press(screen.getByLabelText(/Switch library/));
    expect(useUiStore.getState().librarySelectorOpen).toBe(true);
  });

  it("activates search mode and renders the search input", async () => {
    await render(<TopAppBar navigation={makeNav()} />);
    await fireEvent.press(screen.getByLabelText("Search"));
    expect(useUiStore.getState().isSearchActive).toBe(true);
    expect(screen.getByPlaceholderText("Search library...")).toBeTruthy();
    // The pill and action icons are replaced by the search bar.
    expect(screen.queryByText("Audiobooks")).toBeNull();
  });

  it("typing updates the shared search query", async () => {
    useUiStore.setState({ isSearchActive: true } as any);
    await render(<TopAppBar navigation={makeNav()} />);
    await fireEvent.changeText(screen.getByPlaceholderText("Search library..."), "hobbit");
    expect(useUiStore.getState().searchQuery).toBe("hobbit");
  });

  it("clear button empties the query but keeps search active", async () => {
    useUiStore.setState({ isSearchActive: true, searchQuery: "hobbit" } as any);
    await render(<TopAppBar navigation={makeNav()} />);
    await fireEvent.press(screen.getByLabelText("Clear search"));
    expect(useUiStore.getState().searchQuery).toBe("");
    expect(useUiStore.getState().isSearchActive).toBe(true);
  });

  it("close (back arrow) deactivates search and clears the query", async () => {
    useUiStore.setState({ isSearchActive: true, searchQuery: "hobbit" } as any);
    await render(<TopAppBar navigation={makeNav()} />);
    await fireEvent.press(screen.getByLabelText("Close search"));
    expect(useUiStore.getState().isSearchActive).toBe(false);
    expect(useUiStore.getState().searchQuery).toBe("");
  });

  it("hardware back closes the search overlay (and is claimed: returns true)", async () => {
    const handlers: Array<() => boolean> = [];
    const addSpy = jest
      .spyOn(BackHandler, "addEventListener")
      .mockImplementation((_event: any, handler: any) => {
        handlers.push(handler);
        return { remove: jest.fn() } as any;
      });

    useUiStore.setState({ isSearchActive: true, searchQuery: "hob" } as any);
    await render(<TopAppBar navigation={makeNav()} />);
    expect(handlers.length).toBeGreaterThan(0);

    let claimed = false;
    await act(async () => {
      claimed = handlers[handlers.length - 1]();
    });
    expect(claimed).toBe(true);
    expect(useUiStore.getState().isSearchActive).toBe(false);
    expect(useUiStore.getState().searchQuery).toBe("");
    addSpy.mockRestore();
  });

  it("does not register a hardware-back handler while search is inactive", async () => {
    const addSpy = jest.spyOn(BackHandler, "addEventListener");
    await render(<TopAppBar navigation={makeNav()} />);
    expect(addSpy).not.toHaveBeenCalled();
    addSpy.mockRestore();
  });

  // REGRESSION: BackHandler is process-global and tab screens stay mounted
  // under pushed screens. The Home bar's handler used to fire underneath
  // AuthorDetail etc. — eating the first back press (closing the invisible
  // search, blocking the pop) so back "did nothing" once, then skipped past
  // the search results. An UNFOCUSED bar must decline the event.
  it("hardware back is DECLINED (and search kept) while the bar's screen is not focused", async () => {
    const handlers: Array<() => boolean> = [];
    const addSpy = jest
      .spyOn(BackHandler, "addEventListener")
      .mockImplementation((_event: any, handler: any) => {
        handlers.push(handler);
        return { remove: jest.fn() } as any;
      });

    const navigation = makeNav();
    navigation.isFocused = jest.fn(() => false); // a pushed screen is on top
    useUiStore.setState({ isSearchActive: true, searchQuery: "hob" } as any);
    await render(<TopAppBar navigation={navigation} />);
    expect(handlers.length).toBeGreaterThan(0);

    let claimed = true;
    await act(async () => {
      claimed = handlers[handlers.length - 1]();
    });
    expect(claimed).toBe(false); // let React Navigation pop the pushed screen
    expect(useUiStore.getState().isSearchActive).toBe(true); // results survive
    expect(useUiStore.getState().searchQuery).toBe("hob");
    addSpy.mockRestore();
  });

  it("hardware back closes the search when the bar's screen IS focused", async () => {
    const handlers: Array<() => boolean> = [];
    const addSpy = jest
      .spyOn(BackHandler, "addEventListener")
      .mockImplementation((_event: any, handler: any) => {
        handlers.push(handler);
        return { remove: jest.fn() } as any;
      });

    const navigation = makeNav();
    navigation.isFocused = jest.fn(() => true);
    useUiStore.setState({ isSearchActive: true, searchQuery: "hob" } as any);
    await render(<TopAppBar navigation={navigation} />);

    let claimed = false;
    await act(async () => {
      claimed = handlers[handlers.length - 1]();
    });
    expect(claimed).toBe(true);
    expect(useUiStore.getState().isSearchActive).toBe(false);
    addSpy.mockRestore();
  });

  it("account menu navigates to Account", async () => {
    const navigation = makeNav();
    await render(<TopAppBar navigation={navigation} />);
    await fireEvent.press(screen.getByLabelText("Account menu"));
    await fireEvent.press(screen.getByText("Account"));
    expect(navigation.navigate).toHaveBeenCalledWith("Account");
  });

  it("account menu navigates to Settings", async () => {
    const navigation = makeNav();
    await render(<TopAppBar navigation={navigation} />);
    await fireEvent.press(screen.getByLabelText("Account menu"));
    await fireEvent.press(screen.getByText("Settings"));
    expect(navigation.navigate).toHaveBeenCalledWith("Settings");
  });

  it("account menu navigates to Downloads (its only home after the nav split)", async () => {
    const navigation = makeNav();
    await render(<TopAppBar navigation={navigation} />);
    await fireEvent.press(screen.getByLabelText("Account menu"));
    await fireEvent.press(screen.getByText("Downloads"));
    expect(navigation.navigate).toHaveBeenCalledWith("Downloads");
  });

  it("shows no active-download badge/indicator when nothing is downloading", async () => {
    await render(<TopAppBar navigation={makeNav()} />);
    // No dot on the account icon.
    expect(
      screen.queryByTestId("account-download-indicator", { includeHiddenElements: true })
    ).toBeNull();
    // And no count badge on the (opened) Downloads menu row.
    await fireEvent.press(screen.getByLabelText("Account menu"));
    expect(screen.getByText("Downloads")).toBeTruthy();
    expect(screen.queryByTestId("downloads-active-badge")).toBeNull();
    // Plain "Downloads" label, no count.
    expect(screen.getByLabelText("Downloads")).toBeTruthy();
  });

  it("badges the account icon and the Downloads menu row when a download is in flight", async () => {
    useDownloadStore.setState({ activeDownloads: { a1: activeItem("a1"), a2: activeItem("a2") } } as any);
    await render(<TopAppBar navigation={makeNav()} />);

    // Indicator dot on the account icon (decorative, hidden from a11y tree)...
    expect(
      screen.getByTestId("account-download-indicator", { includeHiddenElements: true })
    ).toBeTruthy();
    // ...and the count is surfaced in the button's accessible label.
    expect(screen.getByLabelText(/2 downloads in progress/)).toBeTruthy();

    // The menu row carries the count badge and a labelled affordance.
    await fireEvent.press(screen.getByLabelText(/Account menu/));
    expect(screen.getByTestId("downloads-active-badge")).toBeTruthy();
    expect(screen.getByLabelText("Downloads, 2 in progress")).toBeTruthy();
  });
});

describe("TopAppBar — back/title mode and action icons", () => {
  it("showBack renders back button + title and hides pill/search", async () => {
    const navigation = makeNav();
    await render(<TopAppBar navigation={navigation} showBack title="Series Detail" />);
    expect(screen.getByText("Series Detail")).toBeTruthy();
    expect(screen.queryByText("Audiobooks")).toBeNull();
    expect(screen.queryByLabelText("Search")).toBeNull();
    await fireEvent.press(screen.getByLabelText("Back"));
    expect(navigation.goBack).toHaveBeenCalled();
  });

  it("filter / sort / download icons fire their callbacks", async () => {
    const onFilter = jest.fn();
    const onSort = jest.fn();
    const onDownload = jest.fn();
    await render(
      <TopAppBar
        navigation={makeNav()}
        showFilter
        showSort
        showDownload
        onFilter={onFilter}
        onSort={onSort}
        onDownload={onDownload}
      />
    );
    await fireEvent.press(screen.getByLabelText("Filter"));
    await fireEvent.press(screen.getByLabelText("Sort"));
    await fireEvent.press(screen.getByLabelText("Download"));
    expect(onFilter).toHaveBeenCalledTimes(1);
    expect(onSort).toHaveBeenCalledTimes(1);
    expect(onDownload).toHaveBeenCalledTimes(1);
  });

  it("action icons are hidden by default", async () => {
    await render(<TopAppBar navigation={makeNav()} />);
    expect(screen.queryByLabelText("Filter")).toBeNull();
    expect(screen.queryByLabelText("Sort")).toBeNull();
    expect(screen.queryByLabelText("Download")).toBeNull();
  });

  it("does not badge the filter icon when filterActive is unset", async () => {
    await render(<TopAppBar navigation={makeNav()} showFilter />);
    expect(screen.getByLabelText("Filter")).toBeTruthy();
    expect(screen.queryByTestId("filter-active-badge")).toBeNull();
  });

  it("badges the filter icon (and relabels it) when filterActive is set", async () => {
    await render(<TopAppBar navigation={makeNav()} showFilter filterActive />);
    // Badge shows and the label reflects the active state for TalkBack. The dot
    // is intentionally hidden from the a11y tree, so opt into hidden elements.
    expect(
      screen.getByTestId("filter-active-badge", { includeHiddenElements: true })
    ).toBeTruthy();
    expect(screen.getByLabelText("Filter, active")).toBeTruthy();
    expect(screen.queryByLabelText("Filter")).toBeNull();
  });
});
