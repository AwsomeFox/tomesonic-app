/**
 * AdminSessionsScreen — admin listening sessions: pins the GET /api/sessions
 * query params (sort/pagination/user pre-filter), infinite-scroll pagination,
 * the confirmed single delete, long-press selection mode + confirmed batch
 * delete, and the offline / 403 / 404-as-non-admin error states.
 */
jest.mock("../../utils/abs/sessions", () => ({
  getAllSessions: jest.fn(),
  deleteSession: jest.fn(),
  batchDeleteSessions: jest.fn(),
}));
jest.mock("../../store/useDialogStore", () => ({ showAppDialog: jest.fn() }));
jest.mock("../../store/useSnackbarStore", () => ({ showSnackbar: jest.fn() }));

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react-native";
import AdminSessionsScreen from "../../screens/AdminSessionsScreen";
import { getAllSessions, deleteSession, batchDeleteSessions } from "../../utils/abs/sessions";
import { showAppDialog } from "../../store/useDialogStore";
import { showSnackbar } from "../../store/useSnackbarStore";
import { AbsError } from "../../utils/abs/errors";

const BASE_PARAMS = { sort: "updatedAt", desc: true, itemsPerPage: 30, page: 0 };

function makeSession(id: string, title: string, username = "joe") {
  return {
    id,
    userId: "u2",
    libraryItemId: `li-${id}`,
    displayTitle: title,
    displayAuthor: "Author",
    duration: 3600,
    mediaPlayer: "TomeSonic",
    deviceInfo: { deviceName: "Pixel 8" },
    timeListening: 1800,
    startTime: 0,
    currentTime: 900,
    startedAt: 1750000000000,
    updatedAt: 1750000360000,
    user: { id: "u2", username },
  };
}

const S1 = makeSession("s1", "Book One");
const S2 = makeSession("s2", "Book Two", "marc");
const S3 = makeSession("s3", "Book Three");

function pageResponse(sessions: any[], { total = sessions.length, numPages = 1, page = 0 } = {}) {
  return { total, numPages, page, itemsPerPage: 30, sessions };
}

function makeNavigation() {
  return { navigate: jest.fn(), goBack: jest.fn(), addListener: jest.fn(() => jest.fn()) } as any;
}

async function renderScreen(params: any = {}) {
  const navigation = makeNavigation();
  await render(<AdminSessionsScreen navigation={navigation} route={{ params }} />);
  return navigation;
}

function lastDialog() {
  const calls = (showAppDialog as jest.Mock).mock.calls;
  return calls[calls.length - 1][0];
}

beforeEach(() => {
  (getAllSessions as jest.Mock).mockResolvedValue(pageResponse([S1, S2]));
  (deleteSession as jest.Mock).mockResolvedValue(undefined);
  (batchDeleteSessions as jest.Mock).mockResolvedValue(undefined);
});

describe("AdminSessionsScreen", () => {
  it("fetches page 0 with the pinned query params (no user filter) and renders rows", async () => {
    await renderScreen();

    expect(await screen.findByText("Book One")).toBeTruthy();
    expect(screen.getByText("Book Two")).toBeTruthy();
    expect(getAllSessions).toHaveBeenCalledWith(BASE_PARAMS);
    expect((getAllSessions as jest.Mock).mock.calls[0][0]).not.toHaveProperty("user");
    // Total caption + row anatomy (user · device · listened · when).
    expect(screen.getByText("2 sessions")).toBeTruthy();
    expect(screen.getByText(/joe · TomeSonic · 30m ·/)).toBeTruthy();
  });

  it("pre-filters by the userId route param and the chip clears the filter", async () => {
    await renderScreen({ userId: "u2" });
    await screen.findByText("Book One");

    expect(getAllSessions).toHaveBeenCalledWith({ ...BASE_PARAMS, user: "u2" });

    // Clearing the chip refetches WITHOUT the user param.
    fireEvent.press(screen.getByLabelText("Clear user filter"));
    await waitFor(() => expect(getAllSessions).toHaveBeenCalledTimes(2));
    const secondCall = (getAllSessions as jest.Mock).mock.calls[1][0];
    expect(secondCall).toEqual(BASE_PARAMS);
    expect(secondCall).not.toHaveProperty("user");
    // Chip is gone once unfiltered.
    await waitFor(() => expect(screen.queryByLabelText("Clear user filter")).toBeNull());
  });

  it("infinite scroll requests the next page and appends", async () => {
    (getAllSessions as jest.Mock)
      .mockResolvedValueOnce(pageResponse([S1, S2], { total: 3, numPages: 2, page: 0 }))
      .mockResolvedValueOnce(pageResponse([S3], { total: 3, numPages: 2, page: 1 }));
    await renderScreen();
    await screen.findByText("Book One");

    fireEvent(screen.getByTestId("sessions-list"), "onEndReached");

    expect(await screen.findByText("Book Three")).toBeTruthy();
    expect(getAllSessions).toHaveBeenLastCalledWith({ ...BASE_PARAMS, page: 1 });
    // Page 0 rows are still there (append, not replace).
    expect(screen.getByText("Book One")).toBeTruthy();

    // At the last page, further end-reached events fetch nothing more.
    fireEvent(screen.getByTestId("sessions-list"), "onEndReached");
    expect(getAllSessions).toHaveBeenCalledTimes(2);
  });

  it("single delete confirms via dialog, then DELETEs and removes the row", async () => {
    await renderScreen();
    await screen.findByText("Book One");

    fireEvent.press(screen.getByLabelText("Delete session: Book One"));

    await waitFor(() => expect(showAppDialog).toHaveBeenCalled());
    const dialog = lastDialog();
    expect(dialog.title).toBe("Delete session?");
    expect(dialog.message).toContain("Book One");
    // Nothing deleted until the destructive button runs.
    expect(deleteSession).not.toHaveBeenCalled();

    const del = dialog.buttons.find((b: any) => b.text === "Delete");
    expect(del.style).toBe("destructive");
    del.onPress();

    await waitFor(() => expect(deleteSession).toHaveBeenCalledWith("s1"));
    await waitFor(() => expect(screen.queryByText("Book One")).toBeNull());
    expect(showSnackbar).toHaveBeenCalledWith({ message: "Session deleted" });
    expect(screen.getByText("1 session")).toBeTruthy();
  });

  it("long-press enters selection mode and batch delete posts all selected ids", async () => {
    await renderScreen();
    await screen.findByText("Book One");

    // Long-press row 1 → selection mode with it selected.
    fireEvent(screen.getByLabelText(/^Session: Book One/), "longPress");
    expect(await screen.findByText("1 selected")).toBeTruthy();
    // Tap row 2 → also selected.
    fireEvent.press(screen.getByLabelText(/^Session: Book Two/));
    expect(await screen.findByText("2 selected")).toBeTruthy();

    fireEvent.press(screen.getByLabelText("Delete selected sessions"));
    await waitFor(() => expect(showAppDialog).toHaveBeenCalled());
    const dialog = lastDialog();
    expect(dialog.title).toBe("Delete 2 sessions?");
    expect(batchDeleteSessions).not.toHaveBeenCalled();

    dialog.buttons.find((b: any) => b.text === "Delete").onPress();

    await waitFor(() =>
      expect(batchDeleteSessions).toHaveBeenCalledWith(expect.arrayContaining(["s1", "s2"]))
    );
    expect((batchDeleteSessions as jest.Mock).mock.calls[0][0]).toHaveLength(2);
    // Rows removed, selection mode exited.
    await waitFor(() => expect(screen.queryByText("Book One")).toBeNull());
    expect(screen.queryByText("2 selected")).toBeNull();
    expect(showSnackbar).toHaveBeenCalledWith({ message: "2 sessions deleted" });
  });

  it("exiting selection mode restores the normal header", async () => {
    await renderScreen();
    await screen.findByText("Book One");

    fireEvent(screen.getByLabelText(/^Session: Book One/), "longPress");
    await screen.findByText("1 selected");

    fireEvent.press(screen.getByLabelText("Exit selection"));
    await waitFor(() => expect(screen.queryByText("1 selected")).toBeNull());
    expect(screen.getByText("Listening sessions")).toBeTruthy();
  });

  it("empty list renders the empty state", async () => {
    (getAllSessions as jest.Mock).mockResolvedValue(pageResponse([]));
    await renderScreen();

    expect(await screen.findByText("No sessions")).toBeTruthy();
  });

  it("403 renders admin-access-required", async () => {
    (getAllSessions as jest.Mock).mockRejectedValue(
      new AbsError("forbidden", "You don't have permission to do that.", 403)
    );
    await renderScreen();

    expect(await screen.findByText("Admin access required")).toBeTruthy();
  });

  it("404 ALSO renders admin-access-required (the sessions endpoint 404s for non-admins)", async () => {
    (getAllSessions as jest.Mock).mockRejectedValue(
      new AbsError("unsupported", "The server doesn't support this (it may need an update).", 404)
    );
    await renderScreen();

    expect(await screen.findByText("Admin access required")).toBeTruthy();
  });

  it("offline renders the offline state with a working retry", async () => {
    (getAllSessions as jest.Mock)
      .mockRejectedValueOnce(new AbsError("offline", "Can't reach the server."))
      .mockResolvedValueOnce(pageResponse([S1]));
    await renderScreen();

    expect(await screen.findByText("You're offline")).toBeTruthy();

    fireEvent.press(screen.getByLabelText("Retry"));
    expect(await screen.findByText("Book One")).toBeTruthy();
  });
});
