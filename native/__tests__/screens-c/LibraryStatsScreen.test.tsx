/**
 * LibraryStatsScreen — renders totals / top genres / top authors / longest &
 * largest items from GET /api/libraries/:id/stats (via utils/abs/libraries'
 * getLibraryStats), item rows open ItemDetail, and AbsError kinds surface as
 * user-facing error states (unsupported/offline) with a working retry.
 */
jest.mock("react-native-safe-area-context", () =>
  require("react-native-safe-area-context/jest/mock").default
);
jest.mock("../../utils/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react-native";
import LibraryStatsScreen from "../../screens/LibraryStatsScreen";
import { api } from "../../utils/api";

const mockedGet = api.get as jest.Mock;

const GB = 1024 * 1024 * 1024;

const STATS = {
  totalItems: 42,
  totalAuthors: 7,
  totalGenres: 5,
  totalDuration: 90000, // 25 hr
  totalSize: 5.5 * GB,
  numAudioTracks: 321,
  largestItems: [
    { id: "big1", title: "Giant Book", size: 2 * GB },
    { id: "big2", title: "Chunky Book", size: 512 * 1024 * 1024 },
  ],
  longestItems: [{ id: "long1", title: "Epic Saga", duration: 3600 * 30 }],
  authorsWithCount: [
    { id: "a1", name: "Alice Author", count: 12 },
    { id: "a2", name: "Bob Writer", count: 1 },
  ],
  genresWithCount: [
    { genre: "Sci-Fi", count: 20 },
    { genre: "Fantasy", count: 10 },
  ],
};

function makeNavigation() {
  const navigation: any = {
    navigate: jest.fn(),
    goBack: jest.fn(),
    addListener: jest.fn(() => jest.fn()),
  };
  navigation.getParent = jest.fn(() => navigation);
  return navigation;
}

async function renderStats(params: any = { libraryId: "lib1" }) {
  const navigation = makeNavigation();
  await render(<LibraryStatsScreen navigation={navigation} route={{ params }} />);
  return navigation;
}

beforeEach(() => {
  mockedGet.mockResolvedValue({ data: STATS });
});

describe("LibraryStatsScreen", () => {
  it("fetches the library's stats endpoint and renders the totals card", async () => {
    await renderStats();

    expect(await screen.findByText("Totals")).toBeTruthy();
    expect(mockedGet).toHaveBeenCalledWith("/api/libraries/lib1/stats");

    // Label: value pairs are grouped into single accessible rows.
    expect(screen.getByLabelText("Items: 42")).toBeTruthy();
    expect(screen.getByLabelText("Authors: 7")).toBeTruthy();
    expect(screen.getByLabelText("Genres: 5")).toBeTruthy();
    expect(screen.getByLabelText("Total time: 25 hr")).toBeTruthy();
    expect(screen.getByLabelText("Size on disk: 5.5 GB")).toBeTruthy();
    expect(screen.getByLabelText("Audio tracks: 321")).toBeTruthy();
  });

  it("renders the genre bars and author breakdowns with counts", async () => {
    await renderStats();
    await screen.findByText("Top genres");

    expect(screen.getByLabelText("Sci-Fi, 20 items")).toBeTruthy();
    expect(screen.getByLabelText("Fantasy, 10 items")).toBeTruthy();

    expect(screen.getByText("Top authors")).toBeTruthy();
    expect(screen.getByLabelText("Alice Author, 12 books")).toBeTruthy();
    // Singular pluralization.
    expect(screen.getByLabelText("Bob Writer, 1 book")).toBeTruthy();
  });

  it("renders longest/largest items and opens ItemDetail on tap", async () => {
    const navigation = await renderStats();
    await screen.findByText("Longest items");

    expect(screen.getByLabelText("Epic Saga, 30 hr")).toBeTruthy();
    expect(screen.getByText("Largest items")).toBeTruthy();
    expect(screen.getByLabelText("Chunky Book, 512 MB")).toBeTruthy();

    await fireEvent.press(screen.getByLabelText("Giant Book, 2 GB"));
    expect(navigation.navigate).toHaveBeenCalledWith("ItemDetail", { itemId: "big1" });
  });

  it("hides the breakdown sections when an older server omits the arrays", async () => {
    mockedGet.mockResolvedValue({
      data: { totalItems: 3, totalDuration: 60, totalSize: 0 },
    });
    await renderStats();
    await screen.findByText("Totals");

    expect(screen.getByLabelText("Items: 3")).toBeTruthy();
    expect(screen.queryByText("Top genres")).toBeNull();
    expect(screen.queryByText("Top authors")).toBeNull();
    expect(screen.queryByText("Longest items")).toBeNull();
    expect(screen.queryByText("Largest items")).toBeNull();
  });

  it("surfaces the normalized 'unsupported' message on a 404 and retries", async () => {
    mockedGet.mockRejectedValueOnce({ response: { status: 404 } });
    await renderStats();

    expect(await screen.findByText("Couldn't load library stats")).toBeTruthy();
    // AbsError's 404 → unsupported copy (old server), not a generic failure.
    expect(screen.getByText("The server doesn't support this (it may need an update).")).toBeTruthy();

    await fireEvent.press(screen.getByLabelText("Retry"));
    expect(await screen.findByText("Totals")).toBeTruthy();
  });

  it("surfaces the offline message when the request never reaches the server", async () => {
    mockedGet.mockRejectedValueOnce(new Error("Network Error"));
    await renderStats();

    expect(await screen.findByText("Couldn't load library stats")).toBeTruthy();
    expect(screen.getByText("Can't reach the server. Check your connection.")).toBeTruthy();
  });

  it("errors without a libraryId and never fetches", async () => {
    await renderStats({});

    expect(await screen.findByText("No library selected.")).toBeTruthy();
    expect(mockedGet).not.toHaveBeenCalled();
    // No retry affordance — there is nothing to retry against.
    expect(screen.queryByLabelText("Retry")).toBeNull();
  });

  it("back button goes back", async () => {
    const navigation = await renderStats();
    await screen.findByText("Totals");

    await fireEvent.press(screen.getByLabelText("Go back"));
    expect(navigation.goBack).toHaveBeenCalled();
  });
});
