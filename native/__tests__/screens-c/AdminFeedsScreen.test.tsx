/**
 * AdminFeedsScreen — manage-side list of all open RSS feeds (admin-only on the
 * server). Covers: list rendering from GET /api/feeds (titles, URLs, entity
 * chips) plus the mandatory public-link warning, the close flow's destructive
 * confirm (POST /api/feeds/:id/close fires only after confirm, row removed,
 * snackbar), copy-link feedback, and offline vs 403 error states. Only
 * utils/api is mocked, so the real utils/abs/feeds + errors modules run.
 */
jest.mock("../../utils/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock("../../store/useDialogStore", () => ({
  showAppDialog: jest.fn(),
}));
jest.mock("../../store/useSnackbarStore", () => ({
  showSnackbar: jest.fn(),
}));

import React from "react";
import { Clipboard } from "react-native";
import { render, screen, fireEvent, waitFor } from "@testing-library/react-native";
import AdminFeedsScreen from "../../screens/AdminFeedsScreen";
import { api } from "../../utils/api";
import { showAppDialog } from "../../store/useDialogStore";
import { showSnackbar } from "../../store/useSnackbarStore";

const ITEM_FEED = {
  id: "f1",
  slug: "my-great-podcast",
  userId: "u1",
  entityType: "libraryItem",
  entityId: "li1",
  feedUrl: "https://abs.example.com/feed/my-great-podcast",
  meta: { title: "My Great Podcast" },
};
const SERIES_FEED = {
  id: "f2",
  slug: "long-series",
  userId: "u1",
  entityType: "series",
  entityId: "s1",
  feedUrl: "https://abs.example.com/feed/long-series",
  meta: { title: "The Long Series" },
};

function mockFeeds(feeds: any[] = [ITEM_FEED, SERIES_FEED]) {
  (api.get as jest.Mock).mockImplementation((url: string) => {
    if (url === "/api/feeds") return Promise.resolve({ data: { feeds, minified: false } });
    return Promise.resolve({ data: {} });
  });
}

function makeNavigation() {
  return { navigate: jest.fn(), goBack: jest.fn(), addListener: jest.fn(() => jest.fn()) } as any;
}

async function renderScreen() {
  const navigation = makeNavigation();
  await render(<AdminFeedsScreen navigation={navigation} />);
  return navigation;
}

function httpError(status: number) {
  return Object.assign(new Error(`HTTP ${status}`), { response: { status } });
}

beforeEach(() => {
  (api.get as jest.Mock).mockReset();
  (api.post as jest.Mock).mockReset();
  (showAppDialog as jest.Mock).mockClear();
  (showSnackbar as jest.Mock).mockClear();
  mockFeeds();
});

describe("AdminFeedsScreen", () => {
  it("lists open feeds from GET /api/feeds with title, URL, and entity chip", async () => {
    await renderScreen();

    expect(await screen.findByText("My Great Podcast")).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith("/api/feeds");
    expect(screen.getByText("The Long Series")).toBeTruthy();
    expect(screen.getByText("https://abs.example.com/feed/my-great-podcast")).toBeTruthy();
    // Entity-type chips (StatusChip renders the label as text).
    expect(screen.getByText("Item")).toBeTruthy();
    expect(screen.getByText("Series")).toBeTruthy();
  });

  it("renders the public-link warning banner", async () => {
    await renderScreen();
    await screen.findByText("My Great Podcast");

    expect(
      screen.getByText(/Open feeds are public — anyone with the link can stream/)
    ).toBeTruthy();
  });

  it("close goes through a destructive confirm; POST fires only after confirming", async () => {
    (api.post as jest.Mock).mockResolvedValue({ data: {} });
    await renderScreen();
    await screen.findByText("My Great Podcast");

    fireEvent.press(screen.getByLabelText("Close feed My Great Podcast"));

    await waitFor(() =>
      expect(showAppDialog).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Close feed?" })
      )
    );
    const dialog = (showAppDialog as jest.Mock).mock.calls[0][0];
    // The copy warns listeners lose access (ship-caution from the UX plan).
    expect(dialog.message).toContain("My Great Podcast");
    expect(dialog.message).toContain("lose access");
    const closeBtn = dialog.buttons.find((b: any) => b.text === "Close feed");
    expect(closeBtn.style).toBe("destructive");
    // Not confirmed yet — nothing sent.
    expect(api.post).not.toHaveBeenCalled();

    closeBtn.onPress();

    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/feeds/f1/close"));
    // Row removed locally; the other feed stays.
    await waitFor(() => expect(screen.queryByText("My Great Podcast")).toBeNull());
    expect(screen.getByText("The Long Series")).toBeTruthy();
    expect(showSnackbar).toHaveBeenCalledWith({ message: "Feed closed" });
  });

  it("cancelling the close confirm sends nothing and keeps the row", async () => {
    await renderScreen();
    await screen.findByText("My Great Podcast");

    fireEvent.press(screen.getByLabelText("Close feed My Great Podcast"));
    await waitFor(() => expect(showAppDialog).toHaveBeenCalled());

    const dialog = (showAppDialog as jest.Mock).mock.calls[0][0];
    const cancelBtn = dialog.buttons.find((b: any) => b.style === "cancel");
    expect(cancelBtn).toBeTruthy();
    cancelBtn.onPress?.();

    expect(api.post).not.toHaveBeenCalled();
    expect(screen.getByText("My Great Podcast")).toBeTruthy();
  });

  it("close failure with a 403 response surfaces the admin-only dialog and keeps the row", async () => {
    (api.post as jest.Mock).mockRejectedValue(httpError(403));
    await renderScreen();
    await screen.findByText("My Great Podcast");

    fireEvent.press(screen.getByLabelText("Close feed My Great Podcast"));
    await waitFor(() => expect(showAppDialog).toHaveBeenCalled());
    (showAppDialog as jest.Mock).mock.calls[0][0].buttons
      .find((b: any) => b.text === "Close feed")
      .onPress();

    await waitFor(() =>
      expect(showAppDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Couldn't close feed",
          message: expect.stringContaining("admins"),
        })
      )
    );
    expect(screen.getByText("My Great Podcast")).toBeTruthy();
  });

  it("copy puts the feed URL on the clipboard and confirms with a snackbar", async () => {
    const setString = jest.spyOn(Clipboard, "setString").mockImplementation(() => {});
    await renderScreen();
    await screen.findByText("My Great Podcast");

    fireEvent.press(screen.getByLabelText("Copy feed link for My Great Podcast"));

    expect(setString).toHaveBeenCalledWith("https://abs.example.com/feed/my-great-podcast");
    expect(showSnackbar).toHaveBeenCalledWith({ message: "Link copied" });
  });

  it("shows the empty state when no feeds are open, pointing at the web dashboard (no in-app open flow)", async () => {
    mockFeeds([]);
    await renderScreen();

    expect(await screen.findByText("No open feeds")).toBeTruthy();
    // The copy must reflect reality: feeds are opened from the Audiobookshelf
    // web dashboard — the app has no open-feed flow (tracked separately).
    expect(screen.getByText(/web dashboard/)).toBeTruthy();
    expect(screen.queryByText(/podcast, series, or collection/)).toBeNull();
  });

  it("offline load failure shows the offline error state, and Retry refetches", async () => {
    (api.get as jest.Mock).mockRejectedValueOnce(new Error("Network Error")); // no .response
    await renderScreen();

    expect(await screen.findByText("You're offline")).toBeTruthy();

    mockFeeds();
    fireEvent.press(screen.getByLabelText("Retry"));
    expect(await screen.findByText("My Great Podcast")).toBeTruthy();
  });

  it("403 load failure shows the admin-access-required state (not the offline copy)", async () => {
    (api.get as jest.Mock).mockRejectedValue(httpError(403));
    await renderScreen();

    expect(await screen.findByText("Admin access required")).toBeTruthy();
    expect(screen.queryByText("You're offline")).toBeNull();
  });
});
