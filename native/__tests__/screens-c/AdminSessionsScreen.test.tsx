/**
 * AdminSessionsScreen — admin listening sessions: pins the GET /api/sessions
 * query params (sort/pagination/user pre-filter), infinite-scroll pagination
 * (including the in-flight double-fetch guard and the refresh-vs-stale-page
 * race), the confirmed single delete, long-press selection mode + confirmed
 * batch delete (and both delete FAILURE paths), the named filter chip, the
 * row accessibility semantics (custom longpress action, no fake button role),
 * and the offline / 403 / 404-as-non-admin error states.
 */
jest.mock("../../utils/abs/sessions", () => ({
  getAllSessions: jest.fn(),
  deleteSession: jest.fn(),
  batchDeleteSessions: jest.fn(),
}));
jest.mock("../../store/useDialogStore", () => ({ showAppDialog: jest.fn() }));
jest.mock("../../store/useSnackbarStore", () => ({ showSnackbar: jest.fn() }));

import React from "react";
import { AccessibilityInfo } from "react-native";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react-native";
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

  it("names the filter chip after the username route param (FROZEN param name: username)", async () => {
    await renderScreen({ userId: "u2", username: "joe" });
    await screen.findByText("Book One");

    expect(screen.getByText("Sessions: joe")).toBeTruthy();
    expect(screen.queryByText("One user")).toBeNull();
  });

  it("falls back to the generic chip label when no username param is given", async () => {
    await renderScreen({ userId: "u2" });
    await screen.findByText("Book One");

    expect(screen.getByText("One user")).toBeTruthy();
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

  it("an onEndReached storm fires ONE fetch, not one per event (in-flight ref guard)", async () => {
    let resolvePage1: (v: any) => void;
    (getAllSessions as jest.Mock)
      .mockResolvedValueOnce(pageResponse([S1, S2], { total: 3, numPages: 2, page: 0 }))
      .mockImplementationOnce(() => new Promise((res) => (resolvePage1 = res)));
    await renderScreen();
    await screen.findByText("Book One");

    // Two synchronous onEndReached events BEFORE any re-render can flush
    // state — only the ref guard can stop the second fetch.
    const list = screen.getByTestId("sessions-list");
    await act(async () => {
      list.props.onEndReached();
      list.props.onEndReached();
    });
    expect(getAllSessions).toHaveBeenCalledTimes(2); // mount + ONE loadMore

    await act(async () => {
      resolvePage1!(pageResponse([S3], { total: 3, numPages: 2, page: 1 }));
    });
    // Appended exactly once.
    expect(screen.getAllByText("Book Three")).toHaveLength(1);
  });

  it("a pull-to-refresh invalidates an in-flight loadMore — the stale page never appends", async () => {
    let resolveStalePage: (v: any) => void;
    (getAllSessions as jest.Mock)
      .mockResolvedValueOnce(pageResponse([S1, S2], { total: 3, numPages: 2, page: 0 }))
      // loadMore for page 1: left hanging until AFTER the refresh lands.
      .mockImplementationOnce(() => new Promise((res) => (resolveStalePage = res)))
      // The refresh: the server list has shrunk to just S2.
      .mockResolvedValueOnce(pageResponse([S2], { total: 1, numPages: 1, page: 0 }));
    await renderScreen();
    await screen.findByText("Book One");

    const list = screen.getByTestId("sessions-list");
    await act(async () => {
      list.props.onEndReached();
    });

    // Refresh completes while the loadMore is still in flight.
    await act(async () => {
      await list.props.refreshControl.props.onRefresh();
    });
    expect(screen.getByText("1 session")).toBeTruthy();
    expect(screen.queryByText("Book One")).toBeNull();

    // The stale page-1 response finally arrives — it must be DISCARDED.
    await act(async () => {
      resolveStalePage!(pageResponse([S3], { total: 3, numPages: 2, page: 1 }));
    });
    expect(screen.queryByText("Book Three")).toBeNull();
    expect(screen.getByText("1 session")).toBeTruthy();
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

  it("a single-delete failure surfaces the exact dialog and the row persists", async () => {
    (deleteSession as jest.Mock).mockRejectedValue(
      new AbsError("server", "The server hit an error handling this request.", 500)
    );
    await renderScreen();
    await screen.findByText("Book One");

    fireEvent.press(screen.getByLabelText("Delete session: Book One"));
    await waitFor(() => expect(showAppDialog).toHaveBeenCalled());
    await act(async () => {
      lastDialog().buttons.find((b: any) => b.text === "Delete").onPress();
    });

    expect(showAppDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Couldn't delete session",
        message: "The server hit an error handling this request.",
      })
    );
    // Row and count untouched; no success snackbar.
    expect(screen.getByText("Book One")).toBeTruthy();
    expect(screen.getByText("2 sessions")).toBeTruthy();
    expect(showSnackbar).not.toHaveBeenCalled();
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

  it("a batch-delete failure surfaces the exact dialog and every row persists", async () => {
    (batchDeleteSessions as jest.Mock).mockRejectedValue(
      new AbsError("server", "The server hit an error handling this request.", 500)
    );
    await renderScreen();
    await screen.findByText("Book One");

    fireEvent(screen.getByLabelText(/^Session: Book One/), "longPress");
    await screen.findByText("1 selected");
    fireEvent.press(screen.getByLabelText(/^Session: Book Two/));
    await screen.findByText("2 selected");

    fireEvent.press(screen.getByLabelText("Delete selected sessions"));
    await waitFor(() => expect(showAppDialog).toHaveBeenCalled());
    await act(async () => {
      lastDialog().buttons.find((b: any) => b.text === "Delete").onPress();
    });

    expect(showAppDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Couldn't delete sessions",
        message: "The server hit an error handling this request.",
      })
    );
    // Nothing removed; no success snackbar.
    expect(screen.getByText("Book One")).toBeTruthy();
    expect(screen.getByText("Book Two")).toBeTruthy();
    expect(showSnackbar).not.toHaveBeenCalled();
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

  it("normal-mode rows are NOT buttons and expose a longpress accessibility action instead", async () => {
    await renderScreen();
    await screen.findByText("Book One");

    const row = screen.getByLabelText(/^Session: Book One/);
    // No tap action in normal mode ⇒ no button role ("double tap to activate"
    // announcing a no-op is an a11y lie) — the long-press affordance is a
    // custom action.
    expect(row.props.accessibilityRole).toBeUndefined();
    expect(row.props.accessibilityActions).toEqual([
      { name: "longpress", label: "Select session" },
    ]);

    // Performing the custom action enters selection mode with the row selected.
    fireEvent(row, "accessibilityAction", { nativeEvent: { actionName: "longpress" } });
    expect(await screen.findByText("1 selected")).toBeTruthy();
    // In selection mode the row is a real checkbox.
    const selectedRow = screen.getByLabelText(/^Session: Book One/);
    expect(selectedRow.props.accessibilityRole).toBe("checkbox");
    expect(selectedRow.props.accessibilityState).toEqual({ checked: true });
  });

  it("announces entering and leaving selection mode to screen readers", async () => {
    const announce = jest.spyOn(AccessibilityInfo, "announceForAccessibility");
    await renderScreen();
    await screen.findByText("Book One");

    fireEvent(screen.getByLabelText(/^Session: Book One/), "longPress");
    await screen.findByText("1 selected");
    expect(announce).toHaveBeenCalledWith(
      "Selection mode. Tap sessions to select, then delete from the header."
    );

    fireEvent.press(screen.getByLabelText("Exit selection"));
    await waitFor(() => expect(announce).toHaveBeenCalledWith("Selection mode off."));
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
