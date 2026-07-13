/**
 * AdminBackupsScreen — server backup management (admin): lists backups from
 * GET /api/backups, creates one via POST (refreshing the list from the
 * response), deletes through a destructive confirm dialog, and renders the
 * "restore from the web UI" note (apply/restore is deliberately out of scope —
 * GitHub issue #60). Only utils/api is mocked, so the real utils/abs/server
 * module (paths + AbsError normalization) is exercised end-to-end.
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
import { render, screen, fireEvent, waitFor } from "@testing-library/react-native";
import AdminBackupsScreen from "../../screens/AdminBackupsScreen";
import { api } from "../../utils/api";
import { showAppDialog } from "../../store/useDialogStore";
import { showSnackbar } from "../../store/useSnackbarStore";

const BACKUP_1 = {
  id: "b1",
  datePretty: "Jun 1, 2026, 3:00 AM",
  filename: "2026-06-01T0300.audiobookshelf",
  fileSize: 50 * 1024 * 1024, // 50 MB
  createdAt: 1748746800000,
  serverVersion: "2.35.1",
  backupMetadataCovers: true,
  backupDirPath: "/backups",
  fullPath: "/backups/2026-06-01T0300.audiobookshelf",
  path: "backups/2026-06-01T0300.audiobookshelf",
};
const BACKUP_2 = {
  ...BACKUP_1,
  id: "b2",
  datePretty: "Jun 8, 2026, 3:00 AM",
  filename: "2026-06-08T0300.audiobookshelf",
};
const NEW_BACKUP = {
  ...BACKUP_1,
  id: "b3",
  datePretty: "Jul 13, 2026, 9:00 AM",
  filename: "2026-07-13T0900.audiobookshelf",
};

function mockGetBackups(backups: any[] = [BACKUP_1, BACKUP_2], backupLocation = "/backups") {
  (api.get as jest.Mock).mockImplementation((url: string) => {
    if (url === "/api/backups") return Promise.resolve({ data: { backups, backupLocation } });
    return Promise.resolve({ data: {} });
  });
}

function makeNavigation() {
  return { navigate: jest.fn(), goBack: jest.fn(), addListener: jest.fn(() => jest.fn()) } as any;
}

async function renderScreen() {
  const navigation = makeNavigation();
  await render(<AdminBackupsScreen navigation={navigation} />);
  return navigation;
}

// An axios-shaped rejection WITH a response (server answered) …
function httpError(status: number) {
  return Object.assign(new Error(`HTTP ${status}`), { response: { status } });
}
// … vs one WITHOUT (never reached the server → offline kind).
function networkError() {
  return new Error("Network Error");
}

beforeEach(() => {
  (api.get as jest.Mock).mockReset();
  (api.post as jest.Mock).mockReset();
  (api.delete as jest.Mock).mockReset();
  (showAppDialog as jest.Mock).mockClear();
  (showSnackbar as jest.Mock).mockClear();
  mockGetBackups();
});

describe("AdminBackupsScreen", () => {
  it("lists backups from GET /api/backups with size + server version, and the location", async () => {
    await renderScreen();

    expect(await screen.findByText("Jun 1, 2026, 3:00 AM")).toBeTruthy();
    expect(screen.getByText("Jun 8, 2026, 3:00 AM")).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith("/api/backups");
    // Subtitle carries the human size and the creating server's version.
    expect(screen.getAllByText("50 MB · v2.35.1").length).toBe(2);
    expect(screen.getByText("Backup location: /backups")).toBeTruthy();
  });

  it("renders the restore-from-web note (apply/restore is out of scope — issue #60)", async () => {
    await renderScreen();
    await screen.findByText("Jun 1, 2026, 3:00 AM");

    expect(screen.getByText(/Use the web dashboard to restore/)).toBeTruthy();
    // No apply/restore affordance anywhere.
    expect(screen.queryByText(/^Restore$/)).toBeNull();
  });

  it("Back up now POSTs /api/backups and refreshes the list from the response", async () => {
    (api.post as jest.Mock).mockResolvedValue({
      data: { backups: [BACKUP_1, BACKUP_2, NEW_BACKUP] },
    });
    await renderScreen();
    await screen.findByText("Jun 1, 2026, 3:00 AM");

    fireEvent.press(screen.getByLabelText("Back up now"));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/backups"));
    // The POST response IS the refreshed list — the new backup appears without
    // a follow-up GET.
    expect(await screen.findByText("Jul 13, 2026, 9:00 AM")).toBeTruthy();
    expect(showSnackbar).toHaveBeenCalledWith({ message: "Backup created" });
  });

  it("create failure without a response surfaces the offline dialog", async () => {
    (api.post as jest.Mock).mockRejectedValue(networkError());
    await renderScreen();
    await screen.findByText("Jun 1, 2026, 3:00 AM");

    fireEvent.press(screen.getByLabelText("Back up now"));

    await waitFor(() =>
      expect(showAppDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Couldn't create backup",
          message: expect.stringContaining("offline"),
        })
      )
    );
  });

  it("delete asks through a destructive confirm dialog, then DELETEs and updates the list", async () => {
    (api.delete as jest.Mock).mockResolvedValue({ data: { backups: [BACKUP_2] } });
    await renderScreen();
    await screen.findByText("Jun 1, 2026, 3:00 AM");

    fireEvent.press(screen.getByLabelText("Delete backup Jun 1, 2026, 3:00 AM"));

    await waitFor(() =>
      expect(showAppDialog).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Delete backup?" })
      )
    );
    const dialog = (showAppDialog as jest.Mock).mock.calls[0][0];
    expect(dialog.message).toContain("Jun 1, 2026, 3:00 AM");
    const deleteBtn = dialog.buttons.find((b: any) => b.text === "Delete");
    expect(deleteBtn.style).toBe("destructive");
    // Nothing fires until the dialog is confirmed.
    expect(api.delete).not.toHaveBeenCalled();

    deleteBtn.onPress();

    await waitFor(() => expect(api.delete).toHaveBeenCalledWith("/api/backups/b1"));
    // The DELETE response is the refreshed list.
    await waitFor(() => expect(screen.queryByText("Jun 1, 2026, 3:00 AM")).toBeNull());
    expect(screen.getByText("Jun 8, 2026, 3:00 AM")).toBeTruthy();
    expect(showSnackbar).toHaveBeenCalledWith({ message: "Backup deleted" });
  });

  it("delete failure with a 403 response surfaces the admin-only dialog and keeps the row", async () => {
    (api.delete as jest.Mock).mockRejectedValue(httpError(403));
    await renderScreen();
    await screen.findByText("Jun 1, 2026, 3:00 AM");

    fireEvent.press(screen.getByLabelText("Delete backup Jun 1, 2026, 3:00 AM"));
    await waitFor(() => expect(showAppDialog).toHaveBeenCalled());
    (showAppDialog as jest.Mock).mock.calls[0][0].buttons
      .find((b: any) => b.text === "Delete")
      .onPress();

    await waitFor(() =>
      expect(showAppDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Couldn't delete backup",
          message: expect.stringContaining("admins"),
        })
      )
    );
    expect(screen.getByText("Jun 1, 2026, 3:00 AM")).toBeTruthy();
  });

  it("shows the empty state when the server has no backups", async () => {
    mockGetBackups([]);
    await renderScreen();

    expect(await screen.findByText("No backups yet")).toBeTruthy();
    // The create action stays available above the empty state.
    expect(screen.getByLabelText("Back up now")).toBeTruthy();
  });

  it("offline load failure shows the offline error state, and Retry refetches", async () => {
    (api.get as jest.Mock).mockRejectedValueOnce(networkError());
    await renderScreen();

    expect(await screen.findByText("You're offline")).toBeTruthy();

    // Back online: retry refetches and renders the list.
    mockGetBackups();
    fireEvent.press(screen.getByLabelText("Retry"));
    expect(await screen.findByText("Jun 1, 2026, 3:00 AM")).toBeTruthy();
  });

  it("403 load failure shows the admin-access-required state (not the offline copy)", async () => {
    (api.get as jest.Mock).mockRejectedValue(httpError(403));
    await renderScreen();

    expect(await screen.findByText("Admin access required")).toBeTruthy();
    expect(screen.queryByText("You're offline")).toBeNull();
  });
});
