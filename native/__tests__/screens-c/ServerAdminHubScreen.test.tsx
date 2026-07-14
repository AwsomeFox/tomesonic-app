/**
 * ServerAdminHubScreen — capability gating (admin rows / non-admin ErrorState /
 * cold-restore spinner), the version gate on the API-keys row, the live task
 * strip fed by an injected subscribeTasks snapshot, and navigation wiring to
 * the frozen §3 admin route names.
 */
// The setup-file safe-area mock returns the module record instead of its
// default export, leaving SafeAreaView undefined — unwrap it here.
jest.mock("react-native-safe-area-context", () =>
  require("react-native-safe-area-context/jest/mock").default
);

// The task poller is module-level singleton state — inject snapshots by
// capturing the screen's listener instead of running the real timer loop.
jest.mock("../../utils/abs/tasks", () => ({
  subscribeTasks: jest.fn(),
  getTasksSnapshot: jest.fn(() => []),
}));

// Real capabilities math (useServerCapabilities reads the store), but a
// controllable refreshCapabilities so tests drive the cold-restore flow.
jest.mock("../../utils/abs/capabilities", () => {
  const actual = jest.requireActual("../../utils/abs/capabilities");
  return { ...actual, refreshCapabilities: jest.fn() };
});

// Row-summary fetches (issue #64) are injected: mock the whole helper module so
// tests drive the fulfilled/rejected shapes the hub reduces into subtitles.
jest.mock("../../utils/abs/adminSummaries", () => ({
  getUsersSummary: jest.fn(),
  getBackupsSummary: jest.fn(),
  getLibrariesSummary: jest.fn(),
}));

import React from "react";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react-native";
import ServerAdminHubScreen from "../../screens/ServerAdminHubScreen";
import { refreshCapabilities } from "../../utils/abs/capabilities";
import { subscribeTasks, getTasksSnapshot } from "../../utils/abs/tasks";
import {
  getUsersSummary,
  getBackupsSummary,
  getLibrariesSummary,
} from "../../utils/abs/adminSummaries";
import { AbsError } from "../../utils/abs/errors";
import { useUserStore } from "../../store/useUserStore";

const initialUser = useUserStore.getState();

const ADMIN_USER = {
  id: "u1",
  username: "tony",
  type: "admin",
  permissions: { update: true, delete: true, download: true, upload: true },
};
const PLAIN_USER = {
  id: "u2",
  username: "pat",
  type: "user",
  permissions: { update: false, delete: false, download: true, upload: false },
};

const makeTask = (overrides: Record<string, any> = {}) => ({
  id: "t1",
  action: "library-scan",
  data: {},
  title: "Scanning 'Audiobooks'",
  description: undefined,
  error: null,
  isFailed: false,
  isFinished: false,
  startedAt: Date.now() - 5_000,
  finishedAt: null,
  ...overrides,
});

function makeNavigation() {
  const navigation: any = {
    navigate: jest.fn(),
    goBack: jest.fn(),
    addListener: jest.fn(() => jest.fn()),
  };
  navigation.getParent = jest.fn(() => navigation);
  return navigation;
}

let taskListener: ((tasks: any[]) => void) | null;
let taskUnsubscribe: jest.Mock;

beforeEach(() => {
  useUserStore.setState(initialUser, true);
  taskListener = null;
  taskUnsubscribe = jest.fn();
  (subscribeTasks as jest.Mock).mockImplementation((l: any) => {
    taskListener = l;
    return taskUnsubscribe;
  });
  (getTasksSnapshot as jest.Mock).mockReturnValue([]);
  (refreshCapabilities as jest.Mock).mockResolvedValue(undefined);
  // Default: every summary fetch fails with a non-offline error, so rows keep
  // their static subtitles and no offline hint shows — the pre-#64 baseline
  // that the untouched suites assert against. Individual #64 tests override.
  (getUsersSummary as jest.Mock).mockRejectedValue(new AbsError("server", "x"));
  (getBackupsSummary as jest.Mock).mockRejectedValue(new AbsError("server", "x"));
  (getLibrariesSummary as jest.Mock).mockRejectedValue(new AbsError("server", "x"));
});

async function renderHub() {
  const navigation = makeNavigation();
  await render(<ServerAdminHubScreen navigation={navigation} />);
  // Flush the mount refreshCapabilities().finally(setRefreshDone) chain so no
  // state update lands outside act after the test body.
  await act(async () => {});
  return navigation;
}

describe("ServerAdminHubScreen", () => {
  describe("capability gating", () => {
    it("renders grouped admin rows for an admin and refreshes capabilities on mount", async () => {
      useUserStore.setState({ user: ADMIN_USER } as any);
      await renderHub();

      expect(refreshCapabilities).toHaveBeenCalledTimes(1);

      expect(screen.getByText("Server administration")).toBeTruthy();
      // Group headers.
      expect(screen.getByText("Library")).toBeTruthy();
      expect(screen.getByText("Users & access")).toBeTruthy();
      expect(screen.getByText("Server")).toBeTruthy();
      // Rows.
      for (const title of [
        "Libraries",
        "Maintenance",
        "Users",
        "Listening sessions",
        "RSS feeds",
        "Server settings",
        "Backups",
        "Email",
        "Notifications",
        "Server logs",
      ]) {
        expect(screen.getByText(title)).toBeTruthy();
      }
      // No error/loading states for an admin.
      expect(screen.queryByText("Admin access required")).toBeNull();
      expect(screen.queryByTestId("admin-hub-loading")).toBeNull();
    });

    it("shows an explicit 'Admin access required' error state for a confirmed non-admin", async () => {
      useUserStore.setState({ user: PLAIN_USER } as any);
      await renderHub();

      expect(await screen.findByText("Admin access required")).toBeTruthy();
      expect(screen.queryByText("Libraries")).toBeNull();
      expect(screen.queryByText("Users")).toBeNull();
      // Non-admins never start the task poller.
      expect(subscribeTasks).not.toHaveBeenCalled();
    });

    it("cold-restore thin user: spinner while refreshing, rows once /authorize hydrates an admin", async () => {
      // Restored session: no `type` on the user yet.
      useUserStore.setState({ user: { id: "u1", username: "tony" } } as any);
      let resolveRefresh!: () => void;
      (refreshCapabilities as jest.Mock).mockImplementation(
        () => new Promise<void>((resolve) => (resolveRefresh = resolve))
      );

      const navigation = makeNavigation();
      await render(<ServerAdminHubScreen navigation={navigation} />);

      // While the refresh is pending: neither rows nor the access error.
      expect(screen.getByTestId("admin-hub-loading")).toBeTruthy();
      expect(screen.queryByText("Admin access required")).toBeNull();
      expect(screen.queryByText("Libraries")).toBeNull();

      // /api/authorize answers with the full admin user.
      await act(async () => {
        useUserStore.setState({ user: ADMIN_USER, serverSettings: { version: "2.30.0" } } as any);
        resolveRefresh();
      });

      expect(screen.getByText("Libraries")).toBeTruthy();
      expect(screen.queryByTestId("admin-hub-loading")).toBeNull();
    });

    it("cold-restore thin user resolving to non-admin lands on the error state", async () => {
      useUserStore.setState({ user: { id: "u2", username: "pat" } } as any);
      await renderHub();
      expect(await screen.findByText("Admin access required")).toBeTruthy();
    });
  });

  describe("version-gated rows", () => {
    it("hides the API keys row when the server version doesn't support it", async () => {
      useUserStore.setState({
        user: ADMIN_USER,
        serverConnectionConfig: { address: "https://abs.test", token: "t", version: "2.20.0" },
      } as any);
      await renderHub();
      expect(screen.queryByText("API keys")).toBeNull();
    });

    it("hides the API keys row when the server version is unknown", async () => {
      useUserStore.setState({ user: ADMIN_USER } as any);
      await renderHub();
      expect(screen.queryByText("API keys")).toBeNull();
    });

    it("shows the API keys row on a supporting server and navigates to AdminApiKeys", async () => {
      useUserStore.setState({
        user: ADMIN_USER,
        serverConnectionConfig: { address: "https://abs.test", token: "t", version: "2.26.0" },
      } as any);
      const navigation = await renderHub();

      await fireEvent.press(screen.getByLabelText(/^API keys/));
      expect(navigation.navigate).toHaveBeenCalledWith("AdminApiKeys");
    });
  });

  describe("navigation", () => {
    it("each hub row navigates to its frozen route name", async () => {
      useUserStore.setState({ user: ADMIN_USER } as any);
      const navigation = await renderHub();

      const expected: Array<[RegExp, string]> = [
        [/^Libraries,/, "AdminLibraries"],
        [/^Maintenance,/, "AdminMaintenance"],
        [/^Users,/, "AdminUsers"],
        [/^Listening sessions,/, "AdminSessions"],
        [/^RSS feeds,/, "AdminFeeds"],
        [/^Server settings,/, "AdminServerSettings"],
        [/^Backups,/, "AdminBackups"],
        [/^Email,/, "AdminEmail"],
        [/^Notifications,/, "AdminNotifications"],
        [/^Server logs,/, "AdminServerLogs"],
      ];
      for (const [label, route] of expected) {
        await fireEvent.press(screen.getByLabelText(label));
        expect(navigation.navigate).toHaveBeenCalledWith(route);
      }
      expect(navigation.navigate).toHaveBeenCalledTimes(expected.length);
    });

    it("renders the admin-family header (header-role title) and an accurate feeds subtitle", async () => {
      useUserStore.setState({ user: ADMIN_USER } as any);
      await renderHub();

      expect(screen.getByRole("header", { name: "Server administration" })).toBeTruthy();
      // Feeds are opened from the web dashboard — the row manages them.
      expect(screen.getByText("Manage open RSS feeds")).toBeTruthy();
      expect(screen.queryByText("Open podcast feeds")).toBeNull();
    });

    it("back button goes back", async () => {
      useUserStore.setState({ user: ADMIN_USER } as any);
      const navigation = await renderHub();
      await fireEvent.press(screen.getByLabelText("Go back"));
      expect(navigation.goBack).toHaveBeenCalled();
    });
  });

  describe("task strip", () => {
    it("subscribes for admins and renders running/failed tasks from the injected snapshot", async () => {
      useUserStore.setState({ user: ADMIN_USER } as any);
      await renderHub();

      expect(subscribeTasks).toHaveBeenCalledTimes(1);
      // Idle: no snapshot yet → the strip collapses to nothing.
      expect(screen.queryByTestId("task-activity-card")).toBeNull();

      await act(async () => {
        taskListener!([
          makeTask(),
          makeTask({
            id: "t2",
            action: "encode-m4b",
            title: "Encoding M4B",
            isFinished: true,
            isFailed: true,
            error: "ffmpeg exited",
          }),
        ]);
      });

      expect(screen.getByTestId("task-activity-card")).toBeTruthy();
      expect(screen.getByText("Scanning 'Audiobooks'")).toBeTruthy();
      expect(screen.getByText("Encoding M4B")).toBeTruthy();
      expect(screen.getByText("ffmpeg exited")).toBeTruthy();
      expect(screen.getByText("1 running · 1 failed")).toBeTruthy();
    });

    it("drops successfully finished tasks and collapses the card when nothing is active", async () => {
      useUserStore.setState({ user: ADMIN_USER } as any);
      await renderHub();

      await act(async () => {
        taskListener!([makeTask()]);
      });
      expect(screen.getByTestId("task-activity-card")).toBeTruthy();

      await act(async () => {
        taskListener!([
          makeTask({ isFinished: true, isFailed: false, finishedAt: Date.now() }),
        ]);
      });
      expect(screen.queryByTestId("task-activity-card")).toBeNull();
    });

    it("collapses to two rows; 'View all' opens the TasksSheet (NOT in-place expansion)", async () => {
      useUserStore.setState({ user: ADMIN_USER } as any);
      await renderHub();

      await act(async () => {
        taskListener!([
          makeTask({ id: "a", title: "Task A" }),
          makeTask({ id: "b", title: "Task B" }),
          makeTask({ id: "c", title: "Task C" }),
        ]);
      });

      expect(screen.getByText("Task A")).toBeTruthy();
      expect(screen.getByText("Task B")).toBeTruthy();
      expect(screen.queryByText("Task C")).toBeNull();
      // Sheet closed: only the card's own "Server activity" header exists.
      expect(screen.getAllByText("Server activity")).toHaveLength(1);

      await fireEvent.press(screen.getByLabelText("View all 3 tasks"));

      // The TasksSheet opened (its own header joins the card's) and lists the
      // full snapshot — the card itself did NOT expand in place.
      expect(screen.getAllByText("Server activity")).toHaveLength(2);
      expect(screen.getByText("Task C")).toBeTruthy();
      expect(screen.queryByText("Show fewer")).toBeNull();
      expect(screen.getByText("View all (3)")).toBeTruthy();
      // Read-only rows: no cancel affordance exists anywhere in the sheet.
      expect(screen.queryByText(/cancel/i)).toBeNull();
    });

    it("the open TasksSheet tracks live snapshot updates from the captured listener", async () => {
      useUserStore.setState({ user: ADMIN_USER } as any);
      await renderHub();

      await act(async () => {
        taskListener!([
          makeTask({ id: "a", title: "Task A" }),
          makeTask({ id: "b", title: "Task B" }),
          makeTask({ id: "c", title: "Task C" }),
        ]);
      });
      await fireEvent.press(screen.getByLabelText("View all 3 tasks"));
      expect(screen.getByText("Task C")).toBeTruthy();

      // A new poll tick lands while the sheet is open — the sheet re-renders
      // with the fresh snapshot (new task appears, dropped task vanishes).
      // getAllByText: the two-task snapshot renders in the card AND the sheet.
      await act(async () => {
        taskListener!([
          makeTask({ id: "a", title: "Task A" }),
          makeTask({ id: "d", title: "Task D" }),
        ]);
      });
      expect(screen.getAllByText("Task D").length).toBeGreaterThanOrEqual(1);
      expect(screen.queryByText("Task C")).toBeNull();

      // Backdrop tap closes the sheet again (card header remains).
      await fireEvent.press(
        screen.getByTestId("sheet-backdrop", { includeHiddenElements: true })
      );
      await waitFor(() => expect(screen.getAllByText("Server activity")).toHaveLength(1));
    });

    it("seeds the strip from getTasksSnapshot and unsubscribes on unmount", async () => {
      useUserStore.setState({ user: ADMIN_USER } as any);
      (getTasksSnapshot as jest.Mock).mockReturnValue([makeTask({ title: "Seeded scan" })]);

      const navigation = makeNavigation();
      const view = await render(<ServerAdminHubScreen navigation={navigation} />);
      await act(async () => {});

      expect(screen.getByText("Seeded scan")).toBeTruthy();

      await act(async () => view.unmount());
      await waitFor(() => expect(taskUnsubscribe).toHaveBeenCalledTimes(1));
    });

    it("drops the subscription on blur and retakes it on focus", async () => {
      useUserStore.setState({ user: ADMIN_USER } as any);
      const navigation = await renderHub();

      // The hub now registers more than one focus listener (task strip + the
      // #64 summary refresh). Real react-navigation fires them all, so collect
      // and invoke every listener per event rather than keeping only the last.
      const focusListeners: Array<() => void> = [];
      const blurListeners: Array<() => void> = [];
      for (const call of (navigation.addListener as jest.Mock).mock.calls) {
        if (call[0] === "focus") focusListeners.push(call[1]);
        if (call[0] === "blur") blurListeners.push(call[1]);
      }
      expect(focusListeners.length).toBeGreaterThan(0);
      expect(blurListeners.length).toBeGreaterThan(0);

      await act(async () => blurListeners.forEach((f) => f()));
      expect(taskUnsubscribe).toHaveBeenCalledTimes(1);

      await act(async () => focusListeners.forEach((f) => f()));
      expect(subscribeTasks).toHaveBeenCalledTimes(2);
    });
  });

  describe("row summary subtitles (issue #64)", () => {
    it("annotates the Users, Backups and Libraries rows from the injected fetch results", async () => {
      useUserStore.setState({ user: ADMIN_USER } as any);
      (getUsersSummary as jest.Mock).mockResolvedValue({ total: 5, online: 2 });
      (getBackupsSummary as jest.Mock).mockResolvedValue({
        lastCreatedAt: Date.now() - 60 * 60 * 1000, // ~1h ago
      });
      (getLibrariesSummary as jest.Mock).mockResolvedValue({ count: 4 });

      await renderHub();

      expect(screen.getByText("5 users · 2 online")).toBeTruthy();
      expect(screen.getByText("Last backup 1h ago")).toBeTruthy();
      expect(screen.getByText("4 libraries")).toBeTruthy();
      // No offline hint when everything loaded.
      expect(screen.queryByTestId("admin-hub-offline")).toBeNull();
    });

    it("treats a lastCreatedAt of 0 as a real backup time, not 'No backups yet' or a blank date", async () => {
      // Epoch 0 is falsy but a valid timestamp — the row must format it to a
      // real date (1970), never fall through to the empty-state copy nor render
      // "Last backup on " with a blank tail.
      useUserStore.setState({ user: ADMIN_USER } as any);
      (getBackupsSummary as jest.Mock).mockResolvedValue({ lastCreatedAt: 0 });

      await renderHub();

      expect(screen.queryByText("No backups yet")).toBeNull();
      // A concrete date renders (epoch 0 → 1970), not a trailing-blank "on ".
      expect(screen.getByText(/^Last backup on .*1970/)).toBeTruthy();
    });

    it("omits the online count when only the online fetch is unavailable", async () => {
      useUserStore.setState({ user: ADMIN_USER } as any);
      (getUsersSummary as jest.Mock).mockResolvedValue({ total: 1, online: null });

      await renderHub();

      // Singular, and no "· online" tail.
      expect(screen.getByText("1 user")).toBeTruthy();
    });

    it("leaves a row's static subtitle intact when its summary fetch fails (no crash)", async () => {
      useUserStore.setState({ user: ADMIN_USER } as any);
      (getUsersSummary as jest.Mock).mockResolvedValue({ total: 3, online: 0 });
      // Backups fetch fails → the row keeps its static subtitle.
      (getBackupsSummary as jest.Mock).mockRejectedValue(new AbsError("server", "boom"));
      (getLibrariesSummary as jest.Mock).mockResolvedValue({ count: 2 });

      await renderHub();

      expect(screen.getByText("3 users · 0 online")).toBeTruthy();
      // Static backups subtitle survives the failure.
      expect(screen.getByText("Create and manage server backups")).toBeTruthy();
      expect(screen.queryByTestId("admin-hub-offline")).toBeNull();
    });

    it("pull-to-refresh re-runs refreshCapabilities and the summary fetches", async () => {
      useUserStore.setState({ user: ADMIN_USER } as any);
      (getUsersSummary as jest.Mock).mockResolvedValue({ total: 5, online: 2 });
      (getBackupsSummary as jest.Mock).mockResolvedValue({ lastCreatedAt: null });
      (getLibrariesSummary as jest.Mock).mockResolvedValue({ count: 4 });

      await renderHub();

      // Once on mount.
      expect(refreshCapabilities).toHaveBeenCalledTimes(1);
      expect(getUsersSummary).toHaveBeenCalledTimes(1);

      const scroll = screen.getByTestId("admin-hub-scroll");
      await act(async () => {
        await scroll.props.refreshControl.props.onRefresh();
      });

      expect(refreshCapabilities).toHaveBeenCalledTimes(2);
      expect(getUsersSummary).toHaveBeenCalledTimes(2);
      expect(getBackupsSummary).toHaveBeenCalledTimes(2);
      expect(getLibrariesSummary).toHaveBeenCalledTimes(2);
    });

    it("shows a subtle offline hint when the summaries fail offline, keeping rows tappable", async () => {
      useUserStore.setState({ user: ADMIN_USER } as any);
      (getUsersSummary as jest.Mock).mockRejectedValue(new AbsError("offline", "off"));
      (getBackupsSummary as jest.Mock).mockRejectedValue(new AbsError("offline", "off"));
      (getLibrariesSummary as jest.Mock).mockRejectedValue(new AbsError("offline", "off"));

      const navigation = await renderHub();

      expect(screen.getByTestId("admin-hub-offline")).toBeTruthy();
      // Rows keep their static subtitles and remain navigable — the offline
      // hint is a visual cue, not a navigation block.
      await fireEvent.press(screen.getByLabelText(/^Users,/));
      expect(navigation.navigate).toHaveBeenCalledWith("AdminUsers");
    });

    it("does NOT show the offline hint when all summaries fail for a non-offline reason", async () => {
      useUserStore.setState({ user: ADMIN_USER } as any);
      // All three fail, but with server (not offline) errors — the hub is
      // reachable, just couldn't compute counts. No "offline" cue.
      (getUsersSummary as jest.Mock).mockRejectedValue(new AbsError("server", "x"));
      (getBackupsSummary as jest.Mock).mockRejectedValue(new AbsError("server", "x"));
      (getLibrariesSummary as jest.Mock).mockRejectedValue(new AbsError("server", "x"));

      await renderHub();

      expect(screen.queryByTestId("admin-hub-offline")).toBeNull();
    });
  });
});
