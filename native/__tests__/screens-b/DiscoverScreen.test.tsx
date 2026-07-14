jest.mock("../../utils/audible", () => ({
  audibleBookDetails: jest.fn().mockResolvedValue(null),
}));
import React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react-native";

jest.mock("../../utils/rmab", () => ({
  getBookdateRecommendations: jest.fn(),
  swipeBookdate: jest.fn(),
  undoBookdateSwipe: jest.fn(),
  getHomeSections: jest.fn().mockResolvedValue([]),
  getBookdatePreferences: jest.fn().mockResolvedValue({ libraryScope: "full", favoriteBookIds: [], customPrompt: "" }),
  updateBookdatePreferences: jest.fn().mockResolvedValue({}),
  getBookdateLibrary: jest.fn().mockResolvedValue([]),
  generateBookdateRecommendations: jest.fn().mockResolvedValue([]),
  clearRmabCaches: jest.fn(),
  getPopularBooks: jest.fn().mockResolvedValue([]),
  getNewReleases: jest.fn().mockResolvedValue([]),
  getAudibleCategories: jest.fn().mockResolvedValue([]),
  getCategoryBooks: jest.fn().mockResolvedValue([]),
  resolveRmabUrl: (p: any) => p || undefined,
  readRmabConfig: jest.fn(() => null),
  writeRmabConfig: jest.fn(),
  rmabAuthMode: () => null,
  exchangeLoginToken: jest.fn(),
  getMe: jest.fn(),
  createRequest: jest.fn(),
  getPendingApprovalCount: jest.fn().mockResolvedValue(0),
}));

import DiscoverScreen from "../../screens/DiscoverScreen";
import {
  getBookdateRecommendations,
  swipeBookdate,
  undoBookdateSwipe,
  getPopularBooks,
  getHomeSections,
  getCategoryBooks,
  createRequest,
} from "../../utils/rmab";
import { useRmabStore } from "../../store/useRmabStore";
import { useUserStore } from "../../store/useUserStore";
import { useReducedMotion } from "react-native-reanimated";

const rmabInitial = useRmabStore.getState();
const userInitial = useUserStore.getState();

const RECS = [
  { id: "rec1", title: "First Pick", author: "Author One", narrator: "Narrator One", description: "<p>Great</p>", coverUrl: "/api/cache/a.jpg", aiReason: "Because you love Neal Stephenson." },
  { id: "rec2", title: "Second Pick", author: "Author Two" },
];

beforeEach(() => {
  jest.clearAllMocks();
  // The deck/shelves only render for a full (jwt) RMAB session — default the
  // store to connected so the existing suite exercises that experience. The
  // not-connected promo has its own describe block below.
  useRmabStore.setState({ ...rmabInitial, configured: true, authMode: "jwt" }, true);
  (getBookdateRecommendations as jest.Mock).mockResolvedValue(RECS);
  (swipeBookdate as jest.Mock).mockResolvedValue({});
});

describe("DiscoverScreen (BookDate)", () => {
  it("shows the top recommendation with cleaned description", async () => {
    await render(<DiscoverScreen navigation={{ navigate: jest.fn() }} />);
    await screen.findByText("First Pick");
    expect(screen.getByText("Author One • read by Narrator One")).toBeTruthy();
    expect(screen.getByText("Great")).toBeTruthy();
    // The AI's rationale renders as a callout on the card.
    expect(screen.getByText("Because you love Neal Stephenson.")).toBeTruthy();
  });

  it("liking swipes right (server creates the request) and advances the deck", async () => {
    await render(<DiscoverScreen navigation={{ navigate: jest.fn() }} />);
    await screen.findByText("First Pick");

    await fireEvent.press(screen.getByLabelText("Like and request"));
    await waitFor(() => expect(swipeBookdate).toHaveBeenCalledWith("rec1", "right"));
    await screen.findByText("Second Pick");
    // Requested confirmation chip appears.
    expect(screen.getByText("Requested")).toBeTruthy();
  });

  it("passing swipes left without a request chip", async () => {
    await render(<DiscoverScreen navigation={{ navigate: jest.fn() }} />);
    await screen.findByText("First Pick");
    await fireEvent.press(screen.getByLabelText("Pass"));
    await waitFor(() => expect(swipeBookdate).toHaveBeenCalledWith("rec1", "left"));
    await screen.findByText("Second Pick");
    expect(screen.queryByText("Requested")).toBeNull();
  });

  it("undo reinserts the returned recommendation at the front", async () => {
    (undoBookdateSwipe as jest.Mock).mockResolvedValue({
      recommendation: { id: "rec0", title: "Undone Pick" },
    });
    await render(<DiscoverScreen navigation={{ navigate: jest.fn() }} />);
    await screen.findByText("First Pick");
    await fireEvent.press(screen.getByLabelText("Undo last swipe"));
    await screen.findByText("Undone Pick");
  });

  it("shows a failure chip when a like-swipe request doesn't reach the server", async () => {
    (swipeBookdate as jest.Mock).mockRejectedValue(new Error("offline"));
    await render(<DiscoverScreen navigation={{ navigate: jest.fn() }} />);
    await screen.findByText("First Pick");

    await fireEvent.press(screen.getByLabelText("Like and request"));

    // No false "Requested" confirmation; an honest failure chip instead.
    await screen.findByText("Request didn't send — check your connection");
    expect(screen.queryByText("Requested")).toBeNull();
  });

  it("shows a failure chip when undo fails", async () => {
    (undoBookdateSwipe as jest.Mock).mockRejectedValue(new Error("offline"));
    await render(<DiscoverScreen navigation={{ navigate: jest.fn() }} />);
    await screen.findByText("First Pick");

    await fireEvent.press(screen.getByLabelText("Undo last swipe"));

    await screen.findByText("Couldn't undo — check your connection");
  });

  it("BookDate disabled (400) hides the deck but keeps the RMAB shelves", async () => {
    (getBookdateRecommendations as jest.Mock).mockRejectedValue({ response: { status: 400 } });
    (getPopularBooks as jest.Mock).mockResolvedValue([
      { asin: "P1", title: "Popular Pick", author: "Someone", isAvailable: false },
    ]);
    await render(<DiscoverScreen navigation={{ navigate: jest.fn() }} />);
    await screen.findByText("Popular Pick");
    expect(screen.getByText("Popular")).toBeTruthy();
    expect(screen.queryByText("BookDate picks")).toBeNull();
  });

  it("shelf books open the detail sheet with a Request action", async () => {
    (getPopularBooks as jest.Mock).mockResolvedValue([
      { asin: "P1", title: "Popular Pick", author: "Someone", isAvailable: false },
    ]);
    await render(<DiscoverScreen navigation={{ navigate: jest.fn() }} />);
    await screen.findByText("Popular Pick");
    await fireEvent.press(screen.getByLabelText("Details for Popular Pick"));
    await screen.findByLabelText("Request Popular Pick");
  });

  it("a truncated rec blurb is upgraded to the full Audnexus summary", async () => {
    const { audibleBookDetails } = require("../../utils/audible");
    const full = "The full summary. ".repeat(40);
    (audibleBookDetails as jest.Mock).mockResolvedValue({ description: full });
    (getBookdateRecommendations as jest.Mock).mockResolvedValue([
      { id: "rec8", title: "Truncated Pick", audnexusAsin: "B0TRUNC01", description: "Short blurb…" },
    ]);
    await render(<DiscoverScreen navigation={{ navigate: jest.fn() }} />);
    await screen.findByText("Truncated Pick");
    await fireEvent.press(screen.getByLabelText("Details for Truncated Pick"));
    await waitFor(() => expect(audibleBookDetails).toHaveBeenCalledWith("B0TRUNC01"));
    // Longer fetched summary wins, and it's expandable.
    await screen.findByLabelText("Show more");
  });

  it("deck detail sheet lazily fetches the description via audnexusAsin", async () => {
    const { audibleBookDetails } = require("../../utils/audible");
    (audibleBookDetails as jest.Mock).mockResolvedValue({ description: "Full lazy summary" });
    (getBookdateRecommendations as jest.Mock).mockResolvedValue([
      { id: "rec9", title: "No Desc Pick", audnexusAsin: "B0LAZY01" },
    ]);
    await render(<DiscoverScreen navigation={{ navigate: jest.fn() }} />);
    await screen.findByText("No Desc Pick");
    await fireEvent.press(screen.getByLabelText("Details for No Desc Pick"));
    await waitFor(() => expect(audibleBookDetails).toHaveBeenCalledWith("B0LAZY01"));
    await screen.findByText("Full lazy summary");
  });

  it("tapping the card opens the shared detail sheet (info only)", async () => {
    await render(<DiscoverScreen navigation={{ navigate: jest.fn() }} />);
    await screen.findByText("First Pick");
    await fireEvent.press(screen.getByLabelText("Details for First Pick"));
    // Sheet shows the title a second time; no Request button (Like requests).
    await waitFor(() => expect(screen.getAllByText("First Pick").length).toBeGreaterThanOrEqual(2));
    expect(screen.queryByLabelText("Request First Pick")).toBeNull();
  });

  it("renders the USER'S home sections in their configured order", async () => {
    (getHomeSections as jest.Mock).mockResolvedValue([
      { sectionType: "category", categoryId: "scifi", categoryName: "Science Fiction & Fantasy", sortOrder: 0 },
      { sectionType: "popular", sortOrder: 1 },
    ]);
    (getCategoryBooks as jest.Mock).mockResolvedValue([
      { asin: "C1", title: "Cat Pick", isAvailable: false },
    ]);
    (getPopularBooks as jest.Mock).mockResolvedValue([
      { asin: "P1", title: "Popular Pick", isAvailable: true },
    ]);
    await render(<DiscoverScreen navigation={{ navigate: jest.fn() }} />);
    await screen.findByText("Science Fiction & Fantasy");
    await screen.findByText("Cat Pick");
    expect(getCategoryBooks).toHaveBeenCalledWith("scifi");
    expect(screen.getByText("Popular")).toBeTruthy();
    // No default category shelves beyond the configured plan.
    expect(screen.queryByText("New Releases")).toBeNull();
  });

  it("a shelf load started before a refresh can't overwrite the fresh books", async () => {
    // Shelf ids repeat across loadShelves() runs, so a slow pre-refresh load
    // resolving late must be dropped, not applied over the refreshed shelf.
    let resolveStale: (books: any[]) => void = () => {};
    (getPopularBooks as jest.Mock)
      .mockImplementationOnce(() => new Promise((res) => (resolveStale = res)))
      .mockResolvedValueOnce([{ asin: "F1", title: "Fresh Pick" }]);
    await render(<DiscoverScreen navigation={{ navigate: jest.fn() }} />);
    await screen.findByText("First Pick");

    // Pull-to-refresh starts a second shelf load while the first Popular
    // request is still in flight. RN's jest RefreshControl mock renders a
    // bare host element (no props), so drive onRefresh via the mock's
    // latestRef instance instead of a testID query.
    const RefreshControlMock =
      require("react-native/Libraries/Components/RefreshControl/RefreshControl").default;
    await act(async () => {
      RefreshControlMock.latestRef.props.onRefresh();
    });
    await screen.findByText("Fresh Pick");

    // The superseded run's response lands late — it must be ignored.
    await act(async () => {
      resolveStale([{ asin: "S1", title: "Stale Pick" }]);
    });
    expect(screen.queryByText("Stale Pick")).toBeNull();
    expect(screen.getByText("Fresh Pick")).toBeTruthy();
  });

  it("the gear opens BookDate preferences with current values loaded", async () => {
    const { getBookdatePreferences, updateBookdatePreferences } = require("../../utils/rmab");
    (getBookdatePreferences as jest.Mock).mockResolvedValue({
      libraryScope: "full",
      favoriteBookIds: [],
      customPrompt: "fun narrators",
      backendCapabilities: { supportsRatings: false },
    });
    await render(<DiscoverScreen navigation={{ navigate: jest.fn() }} />);
    await screen.findByText("First Pick");
    await fireEvent.press(screen.getByLabelText("BookDate preferences"));
    await screen.findByText("BookDate Preferences");
    await screen.findByDisplayValue("fun narrators");
    // No ratings support -> no Rated card.
    expect(screen.queryByText("Rated books")).toBeNull();

    await fireEvent.press(screen.getByLabelText("Save preferences"));
    await waitFor(() =>
      expect(updateBookdatePreferences).toHaveBeenCalledWith({
        libraryScope: "full",
        favoriteBookIds: [],
        customPrompt: "fun narrators",
      })
    );
  });

  it("Regenerate picks runs a fresh generation and refreshes the deck", async () => {
    const { generateBookdateRecommendations } = require("../../utils/rmab");
    await render(<DiscoverScreen navigation={{ navigate: jest.fn() }} />);
    await screen.findByText("First Pick");
    (getBookdateRecommendations as jest.Mock).mockClear();
    await fireEvent.press(screen.getByLabelText("BookDate preferences"));
    await screen.findByText("BookDate Preferences");
    await fireEvent.press(screen.getByLabelText("Regenerate picks now"));
    await waitFor(() => expect(generateBookdateRecommendations).toHaveBeenCalled());
    // onSaved -> deck reload.
    await waitFor(() => expect(getBookdateRecommendations).toHaveBeenCalled());
  });

  it("a failed right-swipe shows the error chip, never a false 'Requested'", async () => {
    // The old optimistic chip said "Requested" even when the POST never
    // reached the server — the request was silently lost.
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    (swipeBookdate as jest.Mock).mockRejectedValue(new Error("offline"));
    await render(<DiscoverScreen navigation={{ navigate: jest.fn() }} />);
    await screen.findByText("First Pick");

    await fireEvent.press(screen.getByLabelText("Like and request"));
    await waitFor(() => expect(swipeBookdate).toHaveBeenCalledWith("rec1", "right"));

    await screen.findByText("Request didn't send — check your connection");
    // Deck still advances (the card already flew out), but no success chip.
    await screen.findByText("Second Pick");
    expect(screen.queryByText("Requested")).toBeNull();
    warnSpy.mockRestore();
  });

  it("a failed shelf request surfaces its message inside the sheet; closing clears it", async () => {
    // 409 AlreadyAvailable → the store classifies it as "Already in the
    // library" and the sheet (not the invisible under-sheet notice line)
    // must show it.
    (createRequest as jest.Mock).mockRejectedValue({
      response: { status: 409, data: { error: "AlreadyAvailable" } },
    });
    (getPopularBooks as jest.Mock).mockResolvedValue([
      { asin: "P1", title: "Popular Pick", author: "Someone", isAvailable: false },
    ]);
    await render(<DiscoverScreen navigation={{ navigate: jest.fn() }} />);
    await screen.findByText("Popular Pick");

    await fireEvent.press(screen.getByLabelText("Details for Popular Pick"));
    await fireEvent.press(await screen.findByLabelText("Request Popular Pick"));
    await waitFor(() => expect(createRequest).toHaveBeenCalled());
    await screen.findByText("Already in the library");

    // Close the sheet (backdrop press) — the notice must not linger…
    await fireEvent.press(screen.getByTestId("sheet-backdrop", { includeHiddenElements: true }));
    await waitFor(() => expect(screen.queryByText("Already in the library")).toBeNull());

    // …and reopening shows a clean sheet, not the stale outcome.
    await fireEvent.press(screen.getByLabelText("Details for Popular Pick"));
    await screen.findByLabelText("Request Popular Pick");
    expect(screen.queryByText("Already in the library")).toBeNull();
  });

  it("an empty deck offers to generate more picks", async () => {
    (getBookdateRecommendations as jest.Mock).mockResolvedValue([]);
    await render(<DiscoverScreen navigation={{ navigate: jest.fn() }} />);
    await screen.findByText("All caught up");
    (getBookdateRecommendations as jest.Mock).mockResolvedValue(RECS);
    await fireEvent.press(screen.getByLabelText("Get more picks"));
    await screen.findByText("First Pick");
  });

  it("a deck load failure (5xx) shows 'Couldn't load picks' with a working retry", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    (getBookdateRecommendations as jest.Mock).mockRejectedValueOnce({ response: { status: 500 } });
    await render(<DiscoverScreen navigation={{ navigate: jest.fn() }} />);
    await screen.findByText("Couldn't load picks");
    expect(screen.getByText("Server error (HTTP 500)")).toBeTruthy();
    // Retry re-fetches; the deck recovers and the error card is gone.
    (getBookdateRecommendations as jest.Mock).mockResolvedValue(RECS);
    await fireEvent.press(screen.getByLabelText("Retry"));
    await screen.findByText("First Pick");
    expect(screen.queryByText("Couldn't load picks")).toBeNull();
    warnSpy.mockRestore();
  });

  it("a deck load failure while offline shows a network message", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    // No response envelope = offline / network error (undefined status).
    (getBookdateRecommendations as jest.Mock).mockRejectedValueOnce(new Error("Network Error"));
    await render(<DiscoverScreen navigation={{ navigate: jest.fn() }} />);
    await screen.findByText("Couldn't load picks");
    expect(screen.getByText("Network error")).toBeTruthy();
    warnSpy.mockRestore();
  });

  it("a per-shelf load failure shows 'Couldn't load this shelf' with a working retry", async () => {
    // First Popular fetch fails (the shelf shows an inline error, not a vanish);
    // retrying the single shelf recovers it without reloading the whole screen.
    (getPopularBooks as jest.Mock)
      .mockRejectedValueOnce(new Error("500"))
      .mockResolvedValueOnce([{ asin: "P1", title: "Popular Pick", isAvailable: false }]);
    await render(<DiscoverScreen navigation={{ navigate: jest.fn() }} />);
    await screen.findByText("Couldn't load this shelf");
    await fireEvent.press(screen.getByLabelText("Retry Popular"));
    await screen.findByText("Popular Pick");
    expect(screen.queryByText("Couldn't load this shelf")).toBeNull();
  });

  it("shelf books with no asin still render distinctly (stable fallback key)", async () => {
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    // Thin-metadata books carrying no asin: keying off asin alone gave both an
    // undefined key (React duplicate-key / row-recycling glitch). The fallback
    // key keeps each row's identity.
    (getPopularBooks as jest.Mock).mockResolvedValue([
      { title: "No Asin One", author: "A", isAvailable: false },
      { title: "No Asin Two", author: "B", isAvailable: false },
    ]);
    await render(<DiscoverScreen navigation={{ navigate: jest.fn() }} />);
    await screen.findByText("No Asin One");
    // Both rows survive independently (no collapse into one recycled row)…
    expect(screen.getByText("No Asin Two")).toBeTruthy();
    // …and React never warned about a duplicate key.
    const dupWarn = errSpy.mock.calls.some((c) => String(c[0]).includes("same key"));
    expect(dupWarn).toBe(false);
    errSpy.mockRestore();
  });

  it("a double-tap on Like can't POST the same rec twice (busy guard)", async () => {
    // Hold the ~240ms fly-out open: capture its completion callback instead of
    // letting jest's Animated mock fire it synchronously. Otherwise the card
    // advances instantly between the two taps and the second tap legitimately
    // lands on the NEXT rec — masking the same-frame double-tap guard we want
    // to verify. With the card held mid-flight, the second tap must be dropped.
    const RN = require("react-native");
    const heldFlyouts: Array<() => void> = [];
    const timingSpy = jest
      .spyOn(RN.Animated, "timing")
      .mockImplementation(
        () =>
          ({
            start: (cb?: () => void) => {
              if (cb) heldFlyouts.push(cb);
            },
          } as any)
      );

    try {
      await render(<DiscoverScreen navigation={{ navigate: jest.fn() }} />);
      await screen.findByText("First Pick");
      const like = screen.getByLabelText("Like and request");

      // Two taps in the same batch, before the card advances.
      await act(async () => {
        fireEvent.press(like);
        fireEvent.press(like);
      });

      await waitFor(() => expect(swipeBookdate).toHaveBeenCalledWith("rec1", "right"));
      // Synchronous in-flight ref dropped the second tap — the same rec must
      // never be requested twice.
      expect(swipeBookdate).toHaveBeenCalledTimes(1);
    } finally {
      // Advance the card so nothing leaks, then restore the real animation.
      await act(async () => {
        heldFlyouts.forEach((cb) => cb());
      });
      timingSpy.mockRestore();
    }
  });

  it("with OS reduce-motion on, a like-swipe still requests and advances (no animation dependency)", async () => {
    // Reduce-motion jumps the card to its target instead of animating, so the
    // deck must advance without ever relying on an animation-completion
    // callback. Guard against the fly-out timing being used at all.
    (useReducedMotion as jest.Mock).mockReturnValue(true);
    const RN = require("react-native");
    const timingSpy = jest.spyOn(RN.Animated, "timing");
    try {
      await render(<DiscoverScreen navigation={{ navigate: jest.fn() }} />);
      await screen.findByText("First Pick");

      await fireEvent.press(screen.getByLabelText("Like and request"));
      await waitFor(() => expect(swipeBookdate).toHaveBeenCalledWith("rec1", "right"));

      // Card advanced with no fly-out animation, and the confirmation chip shows.
      await screen.findByText("Second Pick");
      expect(screen.getByText("Requested")).toBeTruthy();
      // The 240ms fly-out timing must be skipped entirely under reduce-motion.
      expect(timingSpy).not.toHaveBeenCalled();
    } finally {
      timingSpy.mockRestore();
      (useReducedMotion as jest.Mock).mockReturnValue(false);
    }
  });

  it("with OS reduce-motion on, a pass-swipe still advances the deck", async () => {
    (useReducedMotion as jest.Mock).mockReturnValue(true);
    try {
      await render(<DiscoverScreen navigation={{ navigate: jest.fn() }} />);
      await screen.findByText("First Pick");
      await fireEvent.press(screen.getByLabelText("Pass"));
      await waitFor(() => expect(swipeBookdate).toHaveBeenCalledWith("rec1", "left"));
      await screen.findByText("Second Pick");
      expect(screen.queryByText("Requested")).toBeNull();
    } finally {
      (useReducedMotion as jest.Mock).mockReturnValue(false);
    }
  });
});

describe("DiscoverScreen (not connected promo)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useUserStore.setState(userInitial, true);
  });

  it("renders the connect promo (not the deck/shelves) and never hits discovery when RMAB isn't connected", async () => {
    useRmabStore.setState({ ...rmabInitial, configured: false, authMode: null }, true);
    (getBookdateRecommendations as jest.Mock).mockResolvedValue(RECS);
    await render(<DiscoverScreen navigation={{ navigate: jest.fn() }} />);

    await screen.findByText("Discover audiobooks with ReadMeABook");
    expect(screen.getByLabelText("Connect ReadMeABook")).toBeTruthy();
    // The connected experience must NOT render, and no discovery call fires.
    expect(screen.queryByText("BookDate picks")).toBeNull();
    expect(getBookdateRecommendations).not.toHaveBeenCalled();
  });

  it("treats a configured API-token (non-jwt) session as not connected", async () => {
    useRmabStore.setState({ ...rmabInitial, configured: true, authMode: "apiToken" }, true);
    await render(<DiscoverScreen navigation={{ navigate: jest.fn() }} />);
    await screen.findByText("Discover audiobooks with ReadMeABook");
    expect(getBookdateRecommendations).not.toHaveBeenCalled();
  });

  it("a server-address change while disconnected still never hits discovery", async () => {
    // Regression: the server-address-change effect fired loadDeck()/loadShelves()
    // unconditionally — so editing the server address (Account) while RMAB was
    // disconnected hit the discovery endpoints (401/400), unlike the guarded
    // mount effect. The address effect must respect rmabConnected too.
    useRmabStore.setState({ ...rmabInitial, configured: false, authMode: null }, true);
    useUserStore.setState({
      serverConnectionConfig: { address: "https://a.example.com", token: "t" },
    } as any);
    (getBookdateRecommendations as jest.Mock).mockResolvedValue(RECS);
    await render(<DiscoverScreen navigation={{ navigate: jest.fn() }} />);
    await screen.findByText("Discover audiobooks with ReadMeABook");
    expect(getBookdateRecommendations).not.toHaveBeenCalled();

    // Change the active server address in place (no remount).
    await act(async () => {
      useUserStore.setState({
        serverConnectionConfig: { address: "https://b.example.com", token: "t" },
      } as any);
    });
    expect(getBookdateRecommendations).not.toHaveBeenCalled();
  });

  it("the primary button opens Settings' RMAB connect flow", async () => {
    useRmabStore.setState({ ...rmabInitial, configured: false, authMode: null }, true);
    const navigate = jest.fn();
    await render(<DiscoverScreen navigation={{ navigate }} />);
    await fireEvent.press(await screen.findByLabelText("Connect ReadMeABook"));
    expect(navigate).toHaveBeenCalledWith("Settings", { openRmabConnect: true });
  });

  it("the in-screen 'Hide Discover' control turns the setting off (and steps to Home)", async () => {
    useRmabStore.setState({ ...rmabInitial, configured: false, authMode: null }, true);
    const navigate = jest.fn();
    await render(<DiscoverScreen navigation={{ navigate }} />);
    await fireEvent.press(await screen.findByLabelText("Hide Discover until I connect"));

    expect(useUserStore.getState().settings.showDiscoverWhenDisconnected).toBe(false);
    expect(navigate).toHaveBeenCalledWith("Home");
  });

  it("renders the deck once a full (jwt) connection exists", async () => {
    useRmabStore.setState({ ...rmabInitial, configured: true, authMode: "jwt" }, true);
    (getBookdateRecommendations as jest.Mock).mockResolvedValue(RECS);
    await render(<DiscoverScreen navigation={{ navigate: jest.fn() }} />);
    await screen.findByText("First Pick");
    expect(screen.queryByText("Discover audiobooks with ReadMeABook")).toBeNull();
  });
});
