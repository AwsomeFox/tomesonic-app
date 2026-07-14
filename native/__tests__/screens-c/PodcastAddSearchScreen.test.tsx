/**
 * PodcastAddSearchScreen — find & add podcasts (issue #56 P2).
 *
 * Pins the load-bearing behaviors:
 *  - provider search is DEBOUNCED (~400ms) and lands on GET /api/search/podcast
 *    with { term } — rapid typing fires exactly one request for the final term;
 *  - a pasted URL never searches the provider: a "Preview RSS feed" row
 *    navigates to PodcastFeedPreview with the raw feedUrl instead;
 *  - result rows navigate with the provider hit as `seed`; results without a
 *    feedUrl are disabled (nothing to preview or add);
 *  - the library context comes from GET /api/libraries filtered to
 *    podcast-type; none → explanatory EmptyState;
 *  - non-admins get the lock ErrorState (POST /api/podcasts is admin-only).
 */
jest.mock("../../utils/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock("../../store/useDialogStore", () => ({ showAppDialog: jest.fn() }));
jest.mock("../../store/useSnackbarStore", () => ({ showSnackbar: jest.fn() }));
// Real capabilities math (useServerCapabilities reads the store), but a
// controllable refreshCapabilities so tests drive the gate deterministically.
jest.mock("../../utils/abs/capabilities", () => {
  const actual = jest.requireActual("../../utils/abs/capabilities");
  return { ...actual, refreshCapabilities: jest.fn() };
});

import React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react-native";
import PodcastAddSearchScreen from "../../screens/PodcastAddSearchScreen";
import { api } from "../../utils/api";
import { refreshCapabilities } from "../../utils/abs/capabilities";
import { useUserStore } from "../../store/useUserStore";

const initialUser = useUserStore.getState();

const LIBS = [
  {
    id: "lib-books",
    name: "Audiobooks",
    mediaType: "book",
    folders: [{ id: "fb", fullPath: "/books" }],
  },
  {
    id: "lib-pods",
    name: "Podcasts",
    mediaType: "podcast",
    folders: [{ id: "f1", fullPath: "/podcasts" }],
  },
];

const RESULTS = [
  {
    id: 1,
    title: "Hard Fork",
    artistName: "The New York Times",
    cover: "https://covers.example/hardfork.jpg",
    feedUrl: "https://feeds.example/hardfork",
    trackCount: 120,
    genres: ["Technology"],
  },
  {
    id: 2,
    title: "No Feed Show",
    artistName: "Mystery Host",
    // No feedUrl — the row must be disabled.
  },
];

function setAdmin() {
  useUserStore.setState({
    user: { id: "u1", username: "boss", type: "admin", permissions: {} },
    serverConnectionConfig: { address: "https://abs.test", token: "tok", version: "2.35.1" },
  } as any);
}

function mockApi({ libs = LIBS, results = RESULTS }: { libs?: any[]; results?: any[] } = {}) {
  (api.get as jest.Mock).mockImplementation((url: string) => {
    if (url === "/api/libraries") return Promise.resolve({ data: { libraries: libs } });
    if (url === "/api/search/podcast") return Promise.resolve({ data: results });
    return Promise.reject(new Error(`unmocked GET ${url}`));
  });
}

function makeNavigation() {
  return {
    navigate: jest.fn(),
    goBack: jest.fn(),
    addListener: jest.fn(() => jest.fn()),
  } as any;
}

async function renderScreen(params: any = {}) {
  const navigation = makeNavigation();
  await render(<PodcastAddSearchScreen navigation={navigation} route={{ params }} />);
  // Flush the mount refreshCapabilities().finally chain + the libraries fetch.
  await act(async () => {});
  return navigation;
}

beforeEach(() => {
  useUserStore.setState(initialUser, true);
  setAdmin();
  (refreshCapabilities as jest.Mock).mockResolvedValue(undefined);
  (api.get as jest.Mock).mockReset();
  mockApi();
});

afterEach(() => {
  jest.useRealTimers();
});

const searchCalls = () =>
  (api.get as jest.Mock).mock.calls.filter(([url]) => url === "/api/search/podcast");

describe("PodcastAddSearchScreen — search", () => {
  it("debounces ~400ms and fires ONE GET /api/search/podcast {term} for the final term", async () => {
    jest.useFakeTimers();
    await renderScreen();

    const input = screen.getByLabelText("Search podcasts");
    await fireEvent.changeText(input, "hard");
    // Inside the debounce window: retype before 400ms — the first term must
    // never reach the server.
    await act(async () => {
      jest.advanceTimersByTime(200);
    });
    expect(searchCalls()).toHaveLength(0);

    await fireEvent.changeText(input, "hard fork");
    await act(async () => {
      jest.advanceTimersByTime(399);
    });
    expect(searchCalls()).toHaveLength(0);

    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    expect(searchCalls()).toHaveLength(1);
    expect(api.get).toHaveBeenCalledWith("/api/search/podcast", {
      params: { term: "hard fork" },
    });

    // Results render with the LatestEpisodes-style row anatomy.
    expect(screen.getByText("Hard Fork")).toBeTruthy();
    expect(screen.getByText("The New York Times · Technology · 120 episodes")).toBeTruthy();
  });

  it("tapping a result navigates to PodcastFeedPreview with feedUrl + seed + the selected library", async () => {
    jest.useFakeTimers();
    const navigation = await renderScreen();

    await fireEvent.changeText(screen.getByLabelText("Search podcasts"), "hard fork");
    await act(async () => {
      jest.advanceTimersByTime(400);
    });

    await fireEvent.press(screen.getByLabelText("Podcast result: Hard Fork"));
    expect(navigation.navigate).toHaveBeenCalledWith("PodcastFeedPreview", {
      feedUrl: "https://feeds.example/hardfork",
      seed: RESULTS[0],
      libraryId: "lib-pods",
    });
  });

  it("a result WITHOUT a feedUrl is disabled with a hint — tapping never navigates", async () => {
    jest.useFakeTimers();
    const navigation = await renderScreen();

    await fireEvent.changeText(screen.getByLabelText("Search podcasts"), "hard fork");
    await act(async () => {
      jest.advanceTimersByTime(400);
    });

    const row = screen.getByLabelText("Podcast result: No Feed Show");
    expect(row.props.accessibilityState?.disabled).toBe(true);
    expect(screen.getByText(/No RSS feed link from this provider/)).toBeTruthy();
    await fireEvent.press(row);
    expect(navigation.navigate).not.toHaveBeenCalled();
  });

  it("empty search results show the 'No podcasts found' EmptyState", async () => {
    jest.useFakeTimers();
    mockApi({ results: [] });
    await renderScreen();

    await fireEvent.changeText(screen.getByLabelText("Search podcasts"), "zzzz");
    await act(async () => {
      jest.advanceTimersByTime(400);
    });

    expect(screen.getByText("No podcasts found")).toBeTruthy();
  });
});

describe("PodcastAddSearchScreen — URL input", () => {
  it("a pasted URL skips the provider search and shows a Preview RSS feed row that navigates", async () => {
    jest.useFakeTimers();
    const navigation = await renderScreen();

    await fireEvent.changeText(
      screen.getByLabelText("Search podcasts"),
      "https://example.com/feed.xml"
    );
    // Even past the debounce window a URL never becomes a provider search.
    await act(async () => {
      jest.advanceTimersByTime(600);
    });
    expect(searchCalls()).toHaveLength(0);

    await fireEvent.press(screen.getByText("Preview RSS feed"));
    expect(navigation.navigate).toHaveBeenCalledWith("PodcastFeedPreview", {
      feedUrl: "https://example.com/feed.xml",
      libraryId: "lib-pods",
    });
  });
});

describe("PodcastAddSearchScreen — library context", () => {
  it("preselects params.libraryId when it is a podcast library", async () => {
    mockApi({
      libs: [
        ...LIBS,
        {
          id: "lib-pods2",
          name: "More Podcasts",
          mediaType: "podcast",
          folders: [{ id: "f2", fullPath: "/more-podcasts" }],
        },
      ],
    });
    await renderScreen({ libraryId: "lib-pods2" });
    // The library SelectRow reflects the preselected library.
    expect(screen.getByLabelText("Library, More Podcasts")).toBeTruthy();
  });

  it("with NO podcast libraries shows the explanatory EmptyState (no search UI)", async () => {
    mockApi({ libs: [LIBS[0]] });
    await renderScreen();
    expect(screen.getByText("No podcast libraries")).toBeTruthy();
    expect(screen.queryByLabelText("Search podcasts")).toBeNull();
  });
});

describe("PodcastAddSearchScreen — admin gate", () => {
  it("non-admin gets the lock ErrorState, never the form", async () => {
    useUserStore.setState({
      user: { id: "u2", username: "joe", type: "user", permissions: {} },
    } as any);
    await renderScreen();
    expect(refreshCapabilities).toHaveBeenCalled();
    expect(screen.getByText("Admin access required")).toBeTruthy();
    expect(screen.queryByLabelText("Search podcasts")).toBeNull();
    // Not even the libraries fetch fires for a non-admin.
    expect(
      (api.get as jest.Mock).mock.calls.filter(([url]) => url === "/api/libraries")
    ).toHaveLength(0);
  });
});
