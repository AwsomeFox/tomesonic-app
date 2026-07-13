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

import React from "react";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react-native";
import ServerAdminHubScreen from "../../screens/ServerAdminHubScreen";
import { refreshCapabilities } from "../../utils/abs/capabilities";
import { subscribeTasks, getTasksSnapshot } from "../../utils/abs/tasks";
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
        [/^Server logs,/, "AdminServerLogs"],
      ];
      for (const [label, route] of expected) {
        await fireEvent.press(screen.getByLabelText(label));
        expect(navigation.navigate).toHaveBeenCalledWith(route);
      }
      expect(navigation.navigate).toHaveBeenCalledTimes(expected.length);
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

    it("collapses to two rows behind a 'View all' toggle when more tasks run", async () => {
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

      await fireEvent.press(screen.getByLabelText("View all 3 tasks"));
      expect(screen.getByText("Task C")).toBeTruthy();

      await fireEvent.press(screen.getByLabelText("Show fewer tasks"));
      expect(screen.queryByText("Task C")).toBeNull();
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

      const listeners: Record<string, () => void> = {};
      for (const call of (navigation.addListener as jest.Mock).mock.calls) {
        listeners[call[0]] = call[1];
      }
      expect(listeners.focus).toBeTruthy();
      expect(listeners.blur).toBeTruthy();

      await act(async () => listeners.blur());
      expect(taskUnsubscribe).toHaveBeenCalledTimes(1);

      await act(async () => listeners.focus());
      expect(subscribeTasks).toHaveBeenCalledTimes(2);
    });
  });
});
