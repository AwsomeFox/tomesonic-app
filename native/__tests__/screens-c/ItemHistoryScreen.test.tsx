/**
 * ItemHistoryScreen — my listening sessions for one item (optionally one
 * podcast episode). Data flows through utils/abs/me.getMyItemListeningSessions
 * (which throws AbsError), so the screen's error copy comes from the
 * normalized error message.
 */
jest.mock("../../utils/abs/me", () => ({
  getMyItemListeningSessions: jest.fn(),
}));

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react-native";
import ItemHistoryScreen, { formatListened } from "../../screens/ItemHistoryScreen";
import { getMyItemListeningSessions } from "../../utils/abs/me";

const mockedSessions = getMyItemListeningSessions as jest.Mock;

const SESSIONS = [
  {
    id: "s1",
    libraryItemId: "item1",
    displayTitle: "The Hobbit",
    timeListening: 3660, // 1h 1m
    updatedAt: new Date("2026-07-01T10:00:00Z").getTime(),
    deviceInfo: { deviceName: "Pixel 9" },
  },
  {
    id: "s2",
    libraryItemId: "item1",
    displayTitle: "The Hobbit",
    timeListening: 40, // sub-minute must not read "0m"
    updatedAt: new Date("2026-07-03T10:00:00Z").getTime(),
    deviceInfo: { manufacturer: "Google", model: "Pixel 9" },
  },
];

function makeNavigation() {
  return { navigate: jest.fn(), goBack: jest.fn(), addListener: jest.fn(() => jest.fn()) } as any;
}

async function renderScreen(params: any = { libraryItemId: "item1" }) {
  const navigation = makeNavigation();
  await render(<ItemHistoryScreen navigation={navigation} route={{ params }} />);
  return navigation;
}

beforeEach(() => {
  mockedSessions.mockResolvedValue({ sessions: SESSIONS });
});

describe("ItemHistoryScreen", () => {
  it("fetches this item's sessions and renders a summary + newest-first rows", async () => {
    await renderScreen();

    await screen.findByText("2 sessions · 1h 1m total");
    expect(mockedSessions).toHaveBeenCalledWith("item1", undefined);
    // Item title surfaces as the header subtitle.
    expect(screen.getByText("The Hobbit")).toBeTruthy();
    // Newest (Jul 3, 40s) sorts above the older 1h 1m session.
    const labels = screen
      .getAllByLabelText(/listened/)
      .map((n) => n.props.accessibilityLabel as string);
    expect(labels[0]).toContain("40s listened");
    expect(labels[1]).toContain("1h 1m listened");
    // Device info folds into the row.
    expect(labels[0]).toContain("Google Pixel 9");
    expect(labels[1]).toContain("Pixel 9");
  });

  it("passes the episodeId through for podcast-episode history", async () => {
    await renderScreen({ libraryItemId: "pod1", episodeId: "ep2" });
    await waitFor(() => expect(mockedSessions).toHaveBeenCalledWith("pod1", "ep2"));
  });

  it("shows the empty state when the item has no sessions", async () => {
    mockedSessions.mockResolvedValue({ sessions: [] });
    await renderScreen();
    await screen.findByText("No listening history");
    expect(screen.queryByText(/total$/)).toBeNull();
  });

  it("surfaces the normalized AbsError message with a working Retry", async () => {
    mockedSessions.mockRejectedValueOnce(
      Object.assign(new Error("Can't reach the server. Check your connection."), {
        kind: "offline",
      })
    );
    await renderScreen();
    await screen.findByText("Can't reach the server. Check your connection.");

    mockedSessions.mockResolvedValue({ sessions: SESSIONS });
    await fireEvent.press(screen.getByText("Retry"));
    await screen.findByText("2 sessions · 1h 1m total");
  });

  it("errors without fetching when no libraryItemId is provided", async () => {
    await renderScreen({});
    await screen.findByText("No item provided.");
    expect(mockedSessions).not.toHaveBeenCalled();
    expect(screen.queryByText("Retry")).toBeNull();
  });

  it("formatListened never renders a sub-minute session as 0m", () => {
    expect(formatListened(40)).toBe("40s");
    expect(formatListened(90)).toBe("1m");
    expect(formatListened(3660)).toBe("1h 1m");
    expect(formatListened(0)).toBe("0m");
    expect(formatListened(undefined)).toBe("0m");
  });
});
