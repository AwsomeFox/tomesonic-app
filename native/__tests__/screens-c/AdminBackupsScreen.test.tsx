/**
 * AdminBackupsScreen — server backup management (admin): lists backups from
 * GET /api/backups, creates one via POST (refreshing the list from the
 * response), deletes through a destructive confirm dialog, and — for ROOT
 * only — restores (applies) a backup through a typed double-confirm and the
 * reconnect state machine (GitHub issue #60). Only utils/api is mocked, so
 * the real utils/abs/server module (paths + AbsError normalization) and the
 * real utils/serverLiveness polling loop are exercised end-to-end; raw axios
 * is mocked separately because the /ping probes deliberately bypass the api
 * singleton.
 */
jest.mock("../../utils/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
// The restore flow's /ping probes go through RAW axios (never the api
// singleton — its 401 interceptor would forceLogout mid-restore).
jest.mock("axios", () => ({ get: jest.fn() }));
jest.mock("../../store/useDialogStore", () => ({
  showAppDialog: jest.fn(),
}));
jest.mock("../../store/useSnackbarStore", () => ({
  showSnackbar: jest.fn(),
}));

import React from "react";
import { AccessibilityInfo, Linking } from "react-native";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react-native";
import axios from "axios";
import AdminBackupsScreen from "../../screens/AdminBackupsScreen";
import { api } from "../../utils/api";
import { storageHelper } from "../../utils/storage";
import { useUserStore } from "../../store/useUserStore";
import { showAppDialog } from "../../store/useDialogStore";
import { showSnackbar } from "../../store/useSnackbarStore";

const axiosGet = axios.get as jest.Mock;
const initialUserState = useUserStore.getState();

// Roles for the restore gating: the SERVER allows /apply for admin-and-up,
// but the app deliberately narrows the button to root.
const ROOT_USER = { id: "u0", username: "root", type: "root" };
const ADMIN_USER = { id: "u1", username: "meg", type: "admin" };

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

function mockGetBackups(
  backups: any[] = [BACKUP_1, BACKUP_2],
  backupLocation = "/backups",
  // Automatic-backup config rides along on the same GET /api/backups payload:
  // a cron string (or false when disabled) and the rotation count.
  extra: Record<string, any> = { backupSchedule: "30 1 * * *", backupsToKeep: 2 }
) {
  (api.get as jest.Mock).mockImplementation((url: string) => {
    if (url === "/api/backups")
      return Promise.resolve({ data: { backups, backupLocation, ...extra } });
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
  axiosGet.mockReset();
  (showAppDialog as jest.Mock).mockClear();
  (showSnackbar as jest.Mock).mockClear();
  // No user seeded by default → caps.isRoot false → no restore buttons, and
  // no session token → the mount-time refreshCapabilities() no-ops.
  useUserStore.setState(initialUserState, true);
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

  it("hides the restore button from a non-root admin (app narrows /apply to root) and drops the old web-dashboard note", async () => {
    useUserStore.setState({ user: ADMIN_USER } as any);
    await renderScreen();
    await screen.findByText("Jun 1, 2026, 3:00 AM");

    // The server would accept /apply from this admin, but the app's restore
    // affordance is root-only.
    expect(screen.queryByLabelText("Restore backup Jun 1, 2026, 3:00 AM")).toBeNull();
    expect(screen.queryByLabelText("Restore backup Jun 8, 2026, 3:00 AM")).toBeNull();
    // The pre-#60 "use the web dashboard" note is retired.
    expect(screen.queryByText(/web dashboard/)).toBeNull();
  });

  it("renders the read-only automatic-backup summary card from the schedule fields", async () => {
    await renderScreen();
    await screen.findByText("Jun 1, 2026, 3:00 AM");

    expect(screen.getByText("Automatic backups")).toBeTruthy();
    // "30 1 * * *" prettifies to a daily run time.
    expect(screen.getByText(/Runs daily at/)).toBeTruthy();
    expect(screen.getByText("Keeps the 2 most recent backups")).toBeTruthy();
    expect(screen.getByText("Backup location: /backups")).toBeTruthy();
  });

  it("prettifies a daily cron to the exact local time", async () => {
    mockGetBackups([BACKUP_1], "/backups", { backupSchedule: "30 1 * * *", backupsToKeep: 2 });
    await renderScreen();
    await screen.findByText("Jun 1, 2026, 3:00 AM");

    expect(screen.getByText(/Runs daily at 1:30\s?AM/)).toBeTruthy();
  });

  it("prettifies a weekly cron to a named weekday and time", async () => {
    mockGetBackups([BACKUP_1], "/backups", { backupSchedule: "0 2 * * 1", backupsToKeep: 2 });
    await renderScreen();
    await screen.findByText("Jun 1, 2026, 3:00 AM");

    expect(screen.getByText(/Runs weekly on Monday at 2:00\s?AM/)).toBeTruthy();
  });

  it("falls back to the raw cron for shapes it can't prettify", async () => {
    mockGetBackups([BACKUP_1], "/backups", { backupSchedule: "*/15 * * * *", backupsToKeep: 2 });
    await renderScreen();
    await screen.findByText("Jun 1, 2026, 3:00 AM");

    // Not a daily/weekly shape → the admin still sees the accurate raw cron.
    expect(screen.getByText(/Runs on schedule \*\/15 \* \* \* \*/)).toBeTruthy();
    expect(screen.queryByText(/Runs daily/)).toBeNull();
  });

  it("shows automatic backups as off when the server schedule is disabled", async () => {
    mockGetBackups([BACKUP_1], "/backups", { backupSchedule: false, backupsToKeep: 2 });
    await renderScreen();
    await screen.findByText("Jun 1, 2026, 3:00 AM");

    expect(screen.getByText("Off — backups only run when you create one")).toBeTruthy();
    expect(screen.queryByText(/Runs daily at/)).toBeNull();
  });

  it("Back up now POSTs /api/backups and refreshes the list from the response", async () => {
    (api.post as jest.Mock).mockResolvedValue({
      data: { backups: [BACKUP_1, BACKUP_2, NEW_BACKUP] },
    });
    await renderScreen();
    await screen.findByText("Jun 1, 2026, 3:00 AM");

    fireEvent.press(screen.getByLabelText("Back up now"));

    // timeout:0 — a big-library zip can exceed the 20s default, and the
    // ECONNABORTED would be misreported as "offline" (see utils/abs/server).
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/api/backups", undefined, { timeout: 0 })
    );
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

  describe("download to device", () => {
    // buildBackupDownloadUrl reads the REAL (in-memory-MMKV) stored session —
    // seed it like the server.test contract does; the missing-session test
    // clears it explicitly.
    beforeEach(() => {
      storageHelper.setServerConfig({ address: "https://abs.example.com", token: "tok" });
    });

    it("press download → informational confirm → hands the tokened URL to the OS + snackbar", async () => {
      const openSpy = jest.spyOn(Linking, "openURL").mockResolvedValue(true as any);
      await renderScreen();
      await screen.findByText("Jun 1, 2026, 3:00 AM");

      fireEvent.press(screen.getByLabelText("Download backup Jun 1, 2026, 3:00 AM"));

      await waitFor(() =>
        expect(showAppDialog).toHaveBeenCalledWith(
          expect.objectContaining({ title: "Download backup" })
        )
      );
      const dialog = (showAppDialog as jest.Mock).mock.calls.at(-1)![0];
      // Size + what-it-is + download-manager handoff + token warning, all in
      // the confirm copy.
      expect(dialog.message).toContain("50 MB");
      expect(dialog.message).toMatch(/full server database/);
      expect(dialog.message).toMatch(/download manager/);
      // The tokened URL leaks the admin session into browser history — the
      // confirm must say so (see buildBackupDownloadUrl's SECURITY note / #68).
      expect(dialog.message).toMatch(/admin session token/);
      // Nothing handed to the OS until the dialog is confirmed.
      expect(openSpy).not.toHaveBeenCalled();

      await act(async () => {
        dialog.buttons.find((b: any) => b.text === "Download").onPress();
      });

      expect(openSpy).toHaveBeenCalledWith(
        "https://abs.example.com/api/backups/b1/download?token=tok"
      );
      await waitFor(() =>
        expect(showSnackbar).toHaveBeenCalledWith({
          message: "Backup download handed to your browser",
        })
      );
    });

    it("download confirm falls back to the filename and omits the size when the backup has neither", async () => {
      // A sparse backup row (older server / interrupted backup): no datePretty,
      // no fileSize. The dialog must not read "undefined" or claim "0 MB".
      const BARE = { id: "b9", filename: "2026-07-01T0300.audiobookshelf" };
      mockGetBackups([BARE as any]);
      jest.spyOn(Linking, "openURL").mockResolvedValue(true as any);
      await renderScreen();
      await screen.findByText("2026-07-01T0300.audiobookshelf");

      // The button a11y label falls back past the missing datePretty to the
      // FILENAME (matching the row title/dialog chain), not straight to the id.
      fireEvent.press(screen.getByLabelText("Download backup 2026-07-01T0300.audiobookshelf"));

      await waitFor(() =>
        expect(showAppDialog).toHaveBeenCalledWith(
          expect.objectContaining({ title: "Download backup" })
        )
      );
      const dialog = (showAppDialog as jest.Mock).mock.calls.at(-1)![0];
      expect(dialog.message).toContain("2026-07-01T0300.audiobookshelf");
      expect(dialog.message).not.toContain("undefined");
      expect(dialog.message).not.toContain("0 MB");
    });

    it("openURL rejection shows the failure dialog and never the success snackbar", async () => {
      // No browser on the device — openURL rejects.
      const openSpy = jest.spyOn(Linking, "openURL").mockRejectedValue(new Error("no handler"));
      await renderScreen();
      await screen.findByText("Jun 1, 2026, 3:00 AM");

      fireEvent.press(screen.getByLabelText("Download backup Jun 1, 2026, 3:00 AM"));
      await waitFor(() => expect(showAppDialog).toHaveBeenCalled());
      const dialog = (showAppDialog as jest.Mock).mock.calls.at(-1)![0];
      await act(async () => {
        dialog.buttons.find((b: any) => b.text === "Download").onPress();
      });

      expect(openSpy).toHaveBeenCalled();
      await waitFor(() =>
        expect(showAppDialog).toHaveBeenCalledWith(
          expect.objectContaining({ title: "Couldn't download" })
        )
      );
      expect(showSnackbar).not.toHaveBeenCalled();
    });

    it("missing session config short-circuits to the reconnect dialog (no confirm, no openURL)", async () => {
      storageHelper.clearServerConfig();
      const openSpy = jest.spyOn(Linking, "openURL").mockResolvedValue(true as any);
      await renderScreen();
      await screen.findByText("Jun 1, 2026, 3:00 AM");

      fireEvent.press(screen.getByLabelText("Download backup Jun 1, 2026, 3:00 AM"));

      await waitFor(() =>
        expect(showAppDialog).toHaveBeenCalledWith(
          expect.objectContaining({
            title: "Can't download",
            message: "No server session available. Reconnect and try again.",
          })
        )
      );
      expect(openSpy).not.toHaveBeenCalled();
      // No confirm dialog was offered at all.
      expect(
        (showAppDialog as jest.Mock).mock.calls.find((c) => c[0].title === "Download backup")
      ).toBeUndefined();
    });
  });

  describe("restore (apply) — issue #60", () => {
    beforeEach(() => {
      // Root session with a stored address (waitForServerUp probes it) and a
      // token (the mount refreshCapabilities() POSTs /api/authorize with one).
      useUserStore.setState({
        user: ROOT_USER,
        serverConnectionConfig: { address: "https://abs.example.com", token: "tok" },
      } as any);
      storageHelper.setServerConfig({ address: "https://abs.example.com", token: "tok" });
      // Tolerate the mount-time POST /api/authorize: an empty body hydrates
      // nothing, so the seeded root user stays authoritative.
      (api.post as jest.Mock).mockResolvedValue({ data: {} });
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    // GET mock where /api/backups answers normally and the apply route's
    // outcome is injectable. Default: the apply resolves.
    function mockGetWithApply(apply: () => Promise<any> = () => Promise.resolve({ data: {} })) {
      (api.get as jest.Mock).mockImplementation((url: string) => {
        if (url === "/api/backups")
          return Promise.resolve({
            data: { backups: [BACKUP_1, BACKUP_2], backupLocation: "/backups" },
          });
        if (url === "/api/backups/b1/apply") return apply();
        return Promise.resolve({ data: {} });
      });
    }

    const applyCalls = () =>
      (api.get as jest.Mock).mock.calls.filter(([url]) => url === "/api/backups/b1/apply").length;

    const lastDialog = () => (showAppDialog as jest.Mock).mock.calls.at(-1)![0];

    // Walk the two-dialog gate: typed confirm → last-chance confirm. Returns
    // the second dialog so tests can re-press its (stale) confirm closure.
    async function confirmBothDialogs() {
      fireEvent.press(screen.getByLabelText("Restore backup Jun 1, 2026, 3:00 AM"));
      await waitFor(() =>
        expect(showAppDialog).toHaveBeenCalledWith(
          expect.objectContaining({ title: "Restore this backup?" })
        )
      );
      const d1 = lastDialog();
      await act(async () => {
        d1.buttons.find((b: any) => b.text === "Restore").onPress();
      });
      const d2 = lastDialog();
      expect(d2.title).toBe("Replace all server data?");
      await act(async () => {
        d2.buttons.find((b: any) => b.text === "Replace server data").onPress();
      });
      return { d1, d2 };
    }

    it("root sees a restore button on every row", async () => {
      await renderScreen();
      await screen.findByText("Jun 1, 2026, 3:00 AM");

      expect(screen.getByLabelText("Restore backup Jun 1, 2026, 3:00 AM")).toBeTruthy();
      expect(screen.getByLabelText("Restore backup Jun 8, 2026, 3:00 AM")).toBeTruthy();
    });

    it("gates the apply behind a typed RESTORE confirm AND a last-chance dialog", async () => {
      mockGetWithApply();
      await renderScreen();
      await screen.findByText("Jun 1, 2026, 3:00 AM");

      fireEvent.press(screen.getByLabelText("Restore backup Jun 1, 2026, 3:00 AM"));

      await waitFor(() =>
        expect(showAppDialog).toHaveBeenCalledWith(
          expect.objectContaining({ title: "Restore this backup?" })
        )
      );
      const d1 = lastDialog();
      // Typed-confirm gate (AppDialog disables the last button until it
      // matches) + consequence copy naming the backup.
      expect(d1.confirmInput).toEqual({ placeholder: "RESTORE", requiredText: "RESTORE" });
      expect(d1.message).toContain("Jun 1, 2026, 3:00 AM");
      expect(d1.message).toMatch(/ALL server data/);
      expect(d1.message).toMatch(/signed out/i);
      const restoreBtn = d1.buttons.at(-1)!;
      expect(restoreBtn.text).toBe("Restore");
      expect(restoreBtn.style).toBe("destructive");
      // Nothing fired yet.
      expect(applyCalls()).toBe(0);

      await act(async () => {
        restoreBtn.onPress();
      });
      const d2 = lastDialog();
      expect(d2.title).toBe("Replace all server data?");
      expect(d2.message).toMatch(/cannot be undone/);
      const replaceBtn = d2.buttons.at(-1)!;
      expect(replaceBtn.text).toBe("Replace server data");
      expect(replaceBtn.style).toBe("destructive");
      // Still nothing — BOTH dialogs must confirm.
      expect(applyCalls()).toBe(0);

      await act(async () => {
        replaceBtn.onPress();
      });
      await waitFor(() => expect(api.get).toHaveBeenCalledWith("/api/backups/b1/apply"));
    });

    it("apply resolving verifies through getBackups and lands on the success snackbar", async () => {
      mockGetWithApply();
      await renderScreen();
      await screen.findByText("Jun 1, 2026, 3:00 AM");

      await confirmBothDialogs();

      await waitFor(() =>
        expect(showSnackbar).toHaveBeenCalledWith({
          message: "Server is back — backup restored",
        })
      );
      // No failure dialog anywhere, and the list is back.
      expect(showAppDialog).not.toHaveBeenCalledWith(
        expect.objectContaining({ title: "Couldn't restore backup" })
      );
      expect(screen.getByText("Jun 1, 2026, 3:00 AM")).toBeTruthy();
    });

    it("HEADLINE: a network drop during apply is EXPECTED — reconnect-polls /ping, then verifies and succeeds", async () => {
      jest.useFakeTimers();
      // The apply request never gets a response (the server dropped every
      // connection mid-swap) — the classic restore signature.
      mockGetWithApply(() => Promise.reject(networkError()));
      // The server takes two failed pings to come back.
      axiosGet
        .mockRejectedValueOnce(networkError())
        .mockRejectedValueOnce(networkError())
        .mockResolvedValue({ data: { success: true } });

      await renderScreen();
      await screen.findByText("Jun 1, 2026, 3:00 AM");
      await confirmBothDialogs();

      // NOT a failure: no dialog, the full-screen reconnect view instead.
      expect(showAppDialog).not.toHaveBeenCalledWith(
        expect.objectContaining({ title: "Couldn't restore backup" })
      );
      expect(screen.getByText(/Waiting for the server/)).toBeTruthy();
      expect(screen.getByText(/the restore continues on the server/)).toBeTruthy();
      // The probe is RAW axios against the unauthenticated /ping.
      expect(axiosGet).toHaveBeenCalledWith("https://abs.example.com/ping", { timeout: 5000 });

      // Advance through the backoff ticks: first retry ≤4s, second ≤5.5s.
      await act(async () => {
        await jest.advanceTimersByTimeAsync(6_000);
      });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(8_000);
      });

      await waitFor(() =>
        expect(showSnackbar).toHaveBeenCalledWith({
          message: "Server is back — backup restored",
        })
      );
      expect(showAppDialog).not.toHaveBeenCalledWith(
        expect.objectContaining({ title: "Couldn't restore backup" })
      );
      // Back to the (re-verified) list.
      expect(screen.getByText("Jun 1, 2026, 3:00 AM")).toBeTruthy();
    });

    it("an HTTP 500 from apply is a REAL failure: dialog, back to the intact list, no ping polling", async () => {
      mockGetWithApply(() => Promise.reject(httpError(500)));
      await renderScreen();
      await screen.findByText("Jun 1, 2026, 3:00 AM");

      await confirmBothDialogs();

      await waitFor(() =>
        expect(showAppDialog).toHaveBeenCalledWith(
          expect.objectContaining({ title: "Couldn't restore backup" })
        )
      );
      // Idle again: the list survived, no reconnect machinery started.
      expect(screen.getByText("Jun 1, 2026, 3:00 AM")).toBeTruthy();
      expect(screen.queryByText(/Waiting for the server/)).toBeNull();
      expect(axiosGet).not.toHaveBeenCalled();
      expect(showSnackbar).not.toHaveBeenCalledWith({
        message: "Server is back — backup restored",
      });
    });

    it("a dead server hits the 5-minute deadline → guidance view; Keep waiting re-arms; Done reloads the list", async () => {
      jest.useFakeTimers();
      mockGetWithApply(() => Promise.reject(networkError()));
      axiosGet.mockRejectedValue(networkError());

      await renderScreen();
      await screen.findByText("Jun 1, 2026, 3:00 AM");
      await confirmBothDialogs();

      expect(screen.getByText(/Waiting for the server/)).toBeTruthy();

      // Blow past the 5-minute deadline.
      await act(async () => {
        await jest.advanceTimersByTimeAsync(5 * 60_000 + 15_000);
      });

      expect(screen.getByText(/may still be running/)).toBeTruthy();
      expect(screen.getByText(/Check the server console/)).toBeTruthy();
      expect(screen.getByText(/Don't restore the same backup again/)).toBeTruthy();
      const pingsAtTimeout = axiosGet.mock.calls.length;

      // "Keep waiting" re-arms a FRESH window → polling resumes.
      await act(async () => {
        fireEvent.press(screen.getByLabelText("Keep waiting"));
      });
      expect(screen.getByText(/Waiting for the server/)).toBeTruthy();
      await act(async () => {
        await jest.advanceTimersByTimeAsync(30_000);
      });
      expect(axiosGet.mock.calls.length).toBeGreaterThan(pingsAtTimeout);

      // Time out again, then leave via "Done" → idle + one list reload.
      await act(async () => {
        await jest.advanceTimersByTimeAsync(5 * 60_000);
      });
      expect(screen.getByText(/may still be running/)).toBeTruthy();
      await act(async () => {
        fireEvent.press(screen.getByLabelText("Done"));
      });
      expect(await screen.findByText("Jun 1, 2026, 3:00 AM")).toBeTruthy();
      expect(screen.queryByText(/may still be running/)).toBeNull();
      // The whole episode never fired the apply GET a second time.
      expect(applyCalls()).toBe(1);
    });

    // api.get mock where the list loads normally until the apply fires, after
    // which every /api/backups (the VERIFY round-trip) fails as `verifyError`.
    // Models "the HTTP layer answered but the restored database hates us".
    function mockVerifyFailingWith(verifyError: () => any) {
      let applied = false;
      (api.get as jest.Mock).mockImplementation((url: string) => {
        if (url === "/api/backups") {
          return applied
            ? Promise.reject(verifyError())
            : Promise.resolve({
                data: { backups: [BACKUP_1, BACKUP_2], backupLocation: "/backups" },
              });
        }
        if (url === "/api/backups/b1/apply") {
          applied = true;
          return Promise.reject(networkError());
        }
        return Promise.resolve({ data: {} });
      });
    }

    it("the applying view also says leaving only stops watching (the restore continues server-side)", async () => {
      // An apply that never settles pins the machine in "applying".
      mockGetWithApply(() => new Promise(() => {}));
      await renderScreen();
      await screen.findByText("Jun 1, 2026, 3:00 AM");
      await confirmBothDialogs();

      expect(screen.getByText("Restoring backup…")).toBeTruthy();
      expect(
        screen.getByText(/Leaving this screen only stops watching — the restore continues on the server/)
      ).toBeTruthy();
    });

    it("verify 403 after the ping is up is TERMINAL: dedicated dialog, idle, and NO further pings", async () => {
      jest.useFakeTimers();
      mockVerifyFailingWith(() => httpError(403));
      // The server's HTTP layer answers the very first probe.
      axiosGet.mockResolvedValue({ data: { success: true } });

      await renderScreen();
      await screen.findByText("Jun 1, 2026, 3:00 AM");
      await confirmBothDialogs();

      await waitFor(() =>
        expect(showAppDialog).toHaveBeenCalledWith(
          expect.objectContaining({
            title: "Couldn't verify the restore",
            message: expect.stringMatching(/sign in again/),
          })
        )
      );
      // Idle — the list view, NOT the timeout guidance and NOT the spinner
      // (a re-bounce here would ping+verify in a hot loop forever).
      expect(screen.getByText("Jun 1, 2026, 3:00 AM")).toBeTruthy();
      expect(screen.queryByText(/Waiting for the server/)).toBeNull();
      expect(screen.queryByText(/may still be running/)).toBeNull();

      // Terminal means terminal: the ping count freezes.
      const pings = axiosGet.mock.calls.length;
      await act(async () => {
        await jest.advanceTimersByTimeAsync(60_000);
      });
      expect(axiosGet.mock.calls.length).toBe(pings);
      expect(applyCalls()).toBe(1);
    });

    it("verify 500 re-bounces with a leading ~3s delay — the ping+verify cycle never runs hot", async () => {
      jest.useFakeTimers();
      // HTTP layer back, database still swapping: every verify 500s.
      mockVerifyFailingWith(() => httpError(500));
      axiosGet.mockResolvedValue({ data: { success: true } });

      await renderScreen();
      await screen.findByText("Jun 1, 2026, 3:00 AM");
      await confirmBothDialogs();

      // Cycle 1 (ping up + verify 500) settles on microtasks — without the
      // leading re-entry delay this would already be spinning.
      expect(axiosGet).toHaveBeenCalledTimes(1);

      // The next probe waits out the throttle delay, not a tick sooner.
      await act(async () => {
        await jest.advanceTimersByTimeAsync(2999);
      });
      expect(axiosGet).toHaveBeenCalledTimes(1);
      await act(async () => {
        await jest.advanceTimersByTimeAsync(1);
      });
      expect(axiosGet).toHaveBeenCalledTimes(2);

      // Never a failure dialog — this is the legitimate keep-waiting path.
      expect(showAppDialog).not.toHaveBeenCalledWith(
        expect.objectContaining({ title: "Couldn't restore backup" })
      );
      expect(screen.getByText(/Waiting for the server/)).toBeTruthy();
    });

    it("verify auth pass-through can't hang: a ~10s fallback drops the spinner to the timeout view", async () => {
      jest.useFakeTimers();
      // The restored database rejects our token — normally the api
      // interceptor's forceLogout swaps the navigator, but this screen must
      // not sit on the spinner forever if that never happens.
      mockVerifyFailingWith(() => httpError(401));
      axiosGet.mockResolvedValue({ data: { success: true } });

      await renderScreen();
      await screen.findByText("Jun 1, 2026, 3:00 AM");
      await confirmBothDialogs();

      // Stuck in verifying (the auth branch defers to forceLogout).
      expect(screen.getByText(/Waiting for the server/)).toBeTruthy();

      await act(async () => {
        await jest.advanceTimersByTimeAsync(9_999);
      });
      expect(screen.queryByText(/may still be running/)).toBeNull();

      await act(async () => {
        await jest.advanceTimersByTimeAsync(1);
      });
      // The timeout view's copy guides what to do next.
      expect(screen.getByText(/may still be running/)).toBeTruthy();
      expect(screen.queryByText(/Waiting for the server/)).toBeNull();
    });

    it("apply 404 (backup vanished) shows the backup-gone copy, NOT the needs-an-update copy", async () => {
      mockGetWithApply(() => Promise.reject(httpError(404)));
      await renderScreen();
      await screen.findByText("Jun 1, 2026, 3:00 AM");

      await confirmBothDialogs();

      await waitFor(() =>
        expect(showAppDialog).toHaveBeenCalledWith(
          expect.objectContaining({
            title: "Couldn't restore backup",
            message: "That backup no longer exists on the server.",
          })
        )
      );
      expect(showAppDialog).not.toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringMatching(/needs an update/i) })
      );
      // Terminal refusal: back to the idle list, no reconnect machinery.
      expect(screen.getByText("Jun 1, 2026, 3:00 AM")).toBeTruthy();
      expect(axiosGet).not.toHaveBeenCalled();
    });

    it("double-tapping Keep waiting starts only ONE polling loop", async () => {
      jest.useFakeTimers();
      mockGetWithApply(() => Promise.reject(networkError()));
      axiosGet.mockRejectedValue(networkError());

      await renderScreen();
      await screen.findByText("Jun 1, 2026, 3:00 AM");
      await confirmBothDialogs();

      await act(async () => {
        await jest.advanceTimersByTimeAsync(5 * 60_000 + 15_000);
      });
      expect(screen.getByText(/may still be running/)).toBeTruthy();
      const pingsAtTimeout = axiosGet.mock.calls.length;

      // The second press races the synchronous phase flip out of "timeout" —
      // it must NOT arm a second waitForServerUp loop.
      const keepWaiting = screen.getByLabelText("Keep waiting");
      await act(async () => {
        fireEvent.press(keepWaiting);
        fireEvent.press(keepWaiting);
      });

      // One loop probes at t≈0 and t≈3000-4000 inside this window; a doubled
      // loop would have fired four probes by now.
      await act(async () => {
        await jest.advanceTimersByTimeAsync(7_000);
      });
      expect(axiosGet.mock.calls.length - pingsAtTimeout).toBe(2);
    });

    it("announces each restore phase for screen readers (applying/reconnecting/verifying)", async () => {
      jest.useFakeTimers();
      const announceSpy = jest.spyOn(AccessibilityInfo, "announceForAccessibility");
      mockGetWithApply(() => Promise.reject(networkError()));
      // First ping fails; the retry finds the server back → verify succeeds.
      axiosGet
        .mockRejectedValueOnce(networkError())
        .mockResolvedValue({ data: { success: true } });

      await renderScreen();
      await screen.findByText("Jun 1, 2026, 3:00 AM");
      await confirmBothDialogs();

      expect(announceSpy).toHaveBeenCalledWith("Restoring backup");
      expect(announceSpy).toHaveBeenCalledWith("Waiting for the server");
      expect(announceSpy).not.toHaveBeenCalledWith("Checking the server");

      await act(async () => {
        await jest.advanceTimersByTimeAsync(6_000);
      });
      expect(announceSpy).toHaveBeenCalledWith("Checking the server");
      await waitFor(() =>
        expect(showSnackbar).toHaveBeenCalledWith({ message: "Server is back — backup restored" })
      );
    });

    it("announces the timeout phase for screen readers", async () => {
      jest.useFakeTimers();
      const announceSpy = jest.spyOn(AccessibilityInfo, "announceForAccessibility");
      mockGetWithApply(() => Promise.reject(networkError()));
      axiosGet.mockRejectedValue(networkError());

      await renderScreen();
      await screen.findByText("Jun 1, 2026, 3:00 AM");
      await confirmBothDialogs();

      await act(async () => {
        await jest.advanceTimersByTimeAsync(5 * 60_000 + 15_000);
      });
      expect(announceSpy).toHaveBeenCalledWith(
        "Still waiting — the restore may still be running"
      );
    });

    it("cross-action interlock: restore taps are ignored while a backup is being created", async () => {
      // A create that never settles keeps `creating` pinned.
      (api.post as jest.Mock).mockImplementation((url: string) =>
        url === "/api/backups" ? new Promise(() => {}) : Promise.resolve({ data: {} })
      );
      await renderScreen();
      await screen.findByText("Jun 1, 2026, 3:00 AM");

      await fireEvent.press(screen.getByLabelText("Back up now"));
      await fireEvent.press(screen.getByLabelText("Restore backup Jun 1, 2026, 3:00 AM"));

      expect(
        (showAppDialog as jest.Mock).mock.calls.find(
          (c) => c[0].title === "Restore this backup?"
        )
      ).toBeUndefined();
      expect(applyCalls()).toBe(0);
    });

    it("cross-action interlock: restore taps on OTHER rows are ignored while any row deletes", async () => {
      (api.delete as jest.Mock).mockReturnValue(new Promise(() => {}));
      await renderScreen();
      await screen.findByText("Jun 1, 2026, 3:00 AM");

      await fireEvent.press(screen.getByLabelText("Delete backup Jun 1, 2026, 3:00 AM"));
      await waitFor(() =>
        expect(showAppDialog).toHaveBeenCalledWith(
          expect.objectContaining({ title: "Delete backup?" })
        )
      );
      await act(async () => {
        lastDialog()
          .buttons.find((b: any) => b.text === "Delete")
          .onPress();
      });

      // b1 is mid-delete; restoring b2 (a DIFFERENT row) must also be blocked
      // — a restore would race the in-flight delete on the same list.
      await fireEvent.press(screen.getByLabelText("Restore backup Jun 8, 2026, 3:00 AM"));

      expect(
        (showAppDialog as jest.Mock).mock.calls.find(
          (c) => c[0].title === "Restore this backup?"
        )
      ).toBeUndefined();
    });

    it("re-entrancy: a stale second confirm press never fires a second apply", async () => {
      jest.useFakeTimers();
      mockGetWithApply(() => Promise.reject(networkError()));
      axiosGet.mockRejectedValue(networkError());

      await renderScreen();
      await screen.findByText("Jun 1, 2026, 3:00 AM");
      const { d2 } = await confirmBothDialogs();

      expect(applyCalls()).toBe(1);

      // The dialog host still holds the confirm closure — pressing it again
      // while the machine is mid-episode must be a no-op (/apply is a
      // side-effecting GET; a double-fire could restore twice).
      await act(async () => {
        d2.buttons.find((b: any) => b.text === "Replace server data").onPress();
      });
      expect(applyCalls()).toBe(1);
      // Still exactly one reconnect view, no failure dialog.
      expect(screen.getByText(/Waiting for the server/)).toBeTruthy();
    });

    it("re-entrancy: the restore button on a row that is mid-delete does nothing", async () => {
      // A delete that never settles keeps deletingId pinned to b1.
      (api.delete as jest.Mock).mockReturnValue(new Promise(() => {}));
      await renderScreen();
      await screen.findByText("Jun 1, 2026, 3:00 AM");

      fireEvent.press(screen.getByLabelText("Delete backup Jun 1, 2026, 3:00 AM"));
      await waitFor(() =>
        expect(showAppDialog).toHaveBeenCalledWith(
          expect.objectContaining({ title: "Delete backup?" })
        )
      );
      await act(async () => {
        lastDialog()
          .buttons.find((b: any) => b.text === "Delete")
          .onPress();
      });

      await fireEvent.press(screen.getByLabelText("Restore backup Jun 1, 2026, 3:00 AM"));

      expect(
        (showAppDialog as jest.Mock).mock.calls.find(
          (c) => c[0].title === "Restore this backup?"
        )
      ).toBeUndefined();
      expect(applyCalls()).toBe(0);
    });
  });
});
