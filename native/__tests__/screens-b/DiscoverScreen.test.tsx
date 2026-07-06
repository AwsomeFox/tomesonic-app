jest.mock("../../utils/audible", () => ({
  audibleBookDetails: jest.fn().mockResolvedValue(null),
}));
import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react-native";

jest.mock("../../utils/rmab", () => ({
  getBookdateRecommendations: jest.fn(),
  swipeBookdate: jest.fn(),
  undoBookdateSwipe: jest.fn(),
  getHomeSections: jest.fn().mockResolvedValue([]),
  getBookdatePreferences: jest.fn().mockResolvedValue({ libraryScope: "full", favoriteBookIds: [], customPrompt: "" }),
  updateBookdatePreferences: jest.fn().mockResolvedValue({}),
  getBookdateLibrary: jest.fn().mockResolvedValue([]),
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
} from "../../utils/rmab";

const RECS = [
  { id: "rec1", title: "First Pick", author: "Author One", narrator: "Narrator One", description: "<p>Great</p>", coverUrl: "/api/cache/a.jpg", aiReason: "Because you love Neal Stephenson." },
  { id: "rec2", title: "Second Pick", author: "Author Two" },
];

beforeEach(() => {
  jest.clearAllMocks();
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

  it("an empty deck offers to generate more picks", async () => {
    (getBookdateRecommendations as jest.Mock).mockResolvedValue([]);
    await render(<DiscoverScreen navigation={{ navigate: jest.fn() }} />);
    await screen.findByText("All caught up");
    (getBookdateRecommendations as jest.Mock).mockResolvedValue(RECS);
    await fireEvent.press(screen.getByLabelText("Get more picks"));
    await screen.findByText("First Pick");
  });
});
