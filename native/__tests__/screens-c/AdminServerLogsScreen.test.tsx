/**
 * AdminServerLogsScreen — read-only viewer for the SERVER's daily log snapshot
 * (GET /api/logger-data → currentDailyLogs; distinct from the app's own "Logs"
 * screen). Covers: rendering, the level filter chips (with DEBUG appearing
 * only when the snapshot contains debug lines), the manual snapshot refresh,
 * and the error split — 404 degrades to a "not available on this server"
 * empty state (older servers have no REST log surface), offline vs 403 render
 * their distinct states. Only utils/api is mocked, so the real
 * utils/abs/server + errors modules run.
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
import { StyleSheet } from "react-native";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react-native";
import AdminServerLogsScreen from "../../screens/AdminServerLogsScreen";
import { api } from "../../utils/api";

const INFO_LOG = {
  timestamp: "2026-07-13 10:00:00.000",
  source: "Server.js",
  message: "Server started",
  levelName: "INFO",
  level: 2,
};
const WARN_LOG = {
  timestamp: "2026-07-13 10:05:00.000",
  source: "Watcher.js",
  message: "Folder watcher fell behind",
  levelName: "WARN",
  level: 3,
};
// No levelName — exercises the numeric-level fallback (4 → ERROR).
const ERROR_LOG = {
  timestamp: "2026-07-13 10:10:00.000",
  source: "Scanner.js",
  message: "Scan failed for library",
  level: 4,
};
const DEBUG_LOG = {
  timestamp: "2026-07-13 10:15:00.000",
  source: "Db.js",
  message: "debug detail line",
  levelName: "DEBUG",
  level: 1,
};

function mockLogs(currentDailyLogs: any[]) {
  (api.get as jest.Mock).mockImplementation((url: string) => {
    if (url === "/api/logger-data") return Promise.resolve({ data: { currentDailyLogs } });
    return Promise.resolve({ data: {} });
  });
}

function makeNavigation() {
  return { navigate: jest.fn(), goBack: jest.fn(), addListener: jest.fn(() => jest.fn()) } as any;
}

async function renderScreen() {
  const navigation = makeNavigation();
  await render(<AdminServerLogsScreen navigation={navigation} />);
  return navigation;
}

function httpError(status: number) {
  return Object.assign(new Error(`HTTP ${status}`), { response: { status } });
}

beforeEach(() => {
  (api.get as jest.Mock).mockReset();
  mockLogs([INFO_LOG, WARN_LOG, ERROR_LOG]);
});

describe("AdminServerLogsScreen", () => {
  it("renders the snapshot's log lines with levels, sources, and the snapshot caption", async () => {
    await renderScreen();

    expect(await screen.findByText("Server started")).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith("/api/logger-data");
    expect(screen.getByText("Scan failed for library")).toBeTruthy();
    expect(screen.getByText("Folder watcher fell behind")).toBeTruthy();
    // Numeric level 4 (no levelName) still renders as ERROR.
    expect(screen.getByText("ERROR")).toBeTruthy();
    expect(screen.getByText("Scanner.js")).toBeTruthy();
    // Snapshot expectation-setting caption (this is NOT a live tail).
    expect(screen.getByText(/Snapshot of today's server log/)).toBeTruthy();
  });

  it("filters entries by level via the chips", async () => {
    await renderScreen();
    await screen.findByText("Server started");

    fireEvent.press(screen.getByLabelText("Show error logs"));

    await waitFor(() => expect(screen.queryByText("Server started")).toBeNull());
    expect(screen.getByText("Scan failed for library")).toBeTruthy();
    expect(
      screen.getByLabelText("Show error logs").props.accessibilityState.selected
    ).toBe(true);

    // Back to All restores everything.
    fireEvent.press(screen.getByLabelText("Show all logs"));
    expect(await screen.findByText("Server started")).toBeTruthy();
  });

  it("shows a per-filter empty message when a level has no entries", async () => {
    mockLogs([INFO_LOG]);
    await renderScreen();
    await screen.findByText("Server started");

    fireEvent.press(screen.getByLabelText("Show error logs"));

    expect(await screen.findByText("No error logs")).toBeTruthy();
  });

  it("offers a Debug chip only when the snapshot contains debug entries", async () => {
    await renderScreen();
    await screen.findByText("Server started");
    // No debug lines in the default fixture → no dead Debug chip.
    expect(screen.queryByLabelText("Show debug logs")).toBeNull();

    // Refresh into a snapshot WITH a debug line → the chip appears and filters.
    mockLogs([INFO_LOG, DEBUG_LOG]);
    fireEvent.press(screen.getByLabelText("Refresh logs"));

    const debugChip = await screen.findByLabelText("Show debug logs");
    fireEvent.press(debugChip);
    await waitFor(() => expect(screen.queryByText("Server started")).toBeNull());
    expect(screen.getByText("debug detail line")).toBeTruthy();
  });

  it("renders the snapshot through a virtualized FlatList with pull-to-refresh wired to the fetch", async () => {
    await renderScreen();
    await screen.findByText("Server started");

    // Virtualized list (not ScrollView+map): the entries ride in as data.
    const list = screen.getByTestId("server-logs-list");
    expect(list.props.data).toHaveLength(3);

    const NEW_LINE = { ...INFO_LOG, message: "Line from pull refresh" };
    mockLogs([INFO_LOG, WARN_LOG, ERROR_LOG, NEW_LINE]);
    await act(async () => {
      list.props.refreshControl.props.onRefresh();
    });

    expect(await screen.findByText("Line from pull refresh")).toBeTruthy();
    expect(
      (api.get as jest.Mock).mock.calls.filter((c) => c[0] === "/api/logger-data").length
    ).toBe(2);
  });

  it("level chips carry a 34dp fixed height plus vertical hitSlop (comfortable touch target)", async () => {
    await renderScreen();
    await screen.findByText("Server started");

    const chip = screen.getByLabelText("Show all logs");
    expect(StyleSheet.flatten(chip.props.style).height).toBe(34);
    expect(chip.props.hitSlop).toEqual({ top: 6, bottom: 6 });
  });

  it("the refresh button refetches the snapshot", async () => {
    await renderScreen();
    await screen.findByText("Server started");

    const NEW_LINE = { ...INFO_LOG, message: "Fresh line after refresh" };
    mockLogs([INFO_LOG, WARN_LOG, ERROR_LOG, NEW_LINE]);

    fireEvent.press(screen.getByLabelText("Refresh logs"));

    expect(await screen.findByText("Fresh line after refresh")).toBeTruthy();
    expect(
      (api.get as jest.Mock).mock.calls.filter((c) => c[0] === "/api/logger-data").length
    ).toBe(2);
  });

  it("404 degrades to the unsupported empty state pointing at the web dashboard (no retry)", async () => {
    (api.get as jest.Mock).mockRejectedValue(httpError(404));
    await renderScreen();

    expect(await screen.findByText("Not available on this server")).toBeTruthy();
    expect(screen.getByText(/web dashboard/)).toBeTruthy();
    // A missing feature won't appear on retry — no retry button, no refresh.
    expect(screen.queryByLabelText("Retry")).toBeNull();
    expect(screen.queryByLabelText("Refresh logs")).toBeNull();
  });

  it("offline load failure shows the offline error state, and Retry refetches", async () => {
    (api.get as jest.Mock).mockRejectedValueOnce(new Error("Network Error")); // no .response
    await renderScreen();

    expect(await screen.findByText("You're offline")).toBeTruthy();

    mockLogs([INFO_LOG]);
    fireEvent.press(screen.getByLabelText("Retry"));
    expect(await screen.findByText("Server started")).toBeTruthy();
  });

  it("403 load failure shows the admin-access-required state (not offline, not unsupported)", async () => {
    (api.get as jest.Mock).mockRejectedValue(httpError(403));
    await renderScreen();

    expect(await screen.findByText("Admin access required")).toBeTruthy();
    expect(screen.queryByText("You're offline")).toBeNull();
    expect(screen.queryByText("Not available on this server")).toBeNull();
  });

  it("renders the in-list empty message when today's snapshot has no lines", async () => {
    mockLogs([]);
    await renderScreen();

    expect(await screen.findByText("No log entries in today's snapshot")).toBeTruthy();
  });
});
