import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react-native";

jest.mock("../../utils/rmab", () => ({
  getBookdateRecommendations: jest.fn(),
  swipeBookdate: jest.fn(),
  undoBookdateSwipe: jest.fn(),
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
} from "../../utils/rmab";

const RECS = [
  { id: "rec1", title: "First Pick", author: "Author One", narrator: "Narrator One", description: "<p>Great</p>", coverUrl: "/api/cache/a.jpg" },
  { id: "rec2", title: "Second Pick", author: "Author Two" },
];

beforeEach(() => {
  jest.clearAllMocks();
  (getBookdateRecommendations as jest.Mock).mockResolvedValue(RECS);
  (swipeBookdate as jest.Mock).mockResolvedValue({});
});

describe("DiscoverScreen (BookDate)", () => {
  it("shows the top recommendation with cleaned description", async () => {
    await render(<DiscoverScreen />);
    await screen.findByText("First Pick");
    expect(screen.getByText("Author One • read by Narrator One")).toBeTruthy();
    expect(screen.getByText("Great")).toBeTruthy();
  });

  it("liking swipes right (server creates the request) and advances the deck", async () => {
    await render(<DiscoverScreen />);
    await screen.findByText("First Pick");

    await fireEvent.press(screen.getByLabelText("Like and request"));
    await waitFor(() => expect(swipeBookdate).toHaveBeenCalledWith("rec1", "right"));
    await screen.findByText("Second Pick");
    // Requested confirmation chip appears.
    expect(screen.getByText("Requested")).toBeTruthy();
  });

  it("passing swipes left without a request chip", async () => {
    await render(<DiscoverScreen />);
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
    await render(<DiscoverScreen />);
    await screen.findByText("First Pick");
    await fireEvent.press(screen.getByLabelText("Undo last swipe"));
    await screen.findByText("Undone Pick");
  });

  it("503 renders the BookDate-disabled explainer", async () => {
    (getBookdateRecommendations as jest.Mock).mockRejectedValue({ response: { status: 503 } });
    await render(<DiscoverScreen />);
    await screen.findByText("BookDate isn't enabled");
  });

  it("an empty deck offers to generate more picks", async () => {
    (getBookdateRecommendations as jest.Mock).mockResolvedValue([]);
    await render(<DiscoverScreen />);
    await screen.findByText("All caught up");
    (getBookdateRecommendations as jest.Mock).mockResolvedValue(RECS);
    await fireEvent.press(screen.getByLabelText("Get more picks"));
    await screen.findByText("First Pick");
  });
});
